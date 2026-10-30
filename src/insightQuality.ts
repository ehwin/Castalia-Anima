/**
 * 洞察质量闸(确定性,零 LLM) —— Anima 反思保真契约的第二层。
 *
 * 为什么需要:第一轮 1,532 条洞察的实测分布是 —— 锚定率高(median 0.99)、
 * 零锚定只占 0.5%,但 **80% 的洞察新颖度 < 0.3**(基本是复述来源),
 * 88% 只引用 1 条来源(所谓"跨库整合"其实没发生),另有 6.4% 近重复
 * 溜过了"完全相等"的入库查重。也就是说:失败模式不是编造,是**空转**。
 *
 * 文献侧对应:
 *  - ExpeL 的消融:把 Reflexion 式反思喂进洞察提取器,HotpotQA 从 39.0 掉到 29.0
 *    (基线 28.0),归因是"编造的反思" —— 所以第一条闸是证据必须能在来源里找到。
 *  - Hindsight 的 observations:证据引用 + proof count + 去重后 refine(不是覆写)。
 *  - MemGuard:置信度/标签要来自**验证器**而不是模型自陈;
 *    错误但内部自洽的经验污染 10% 记忆库,Pass@1 掉 5.3 点。
 *
 * 四条闸(全部确定性,可离线跑,不引入 LLM 裁判):
 *  1 evidence-in-source:证据原句必须能在它引用的来源正文里找到(规范化后包含)
 *  2 restatement       :新颖度太低且没有"新增成分"(规则/决定/因果/对比) → 不写
 *  3 near-duplicate    :与已有洞察 3-gram Jaccard 过高 → 不新增,只累加 reference_count
 *  4 verifier importance:重要度由来源强度 × 跨源数 × 新颖度算出,模型自评只留在 metadata
 */

/** 规范化:去空白/标点/符号,转小写(中文按字,英文按词内字符) */
export function normText(s: string): string {
  return String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

export function charNgrams(s: string, n: number): Set<string> {
  const t = [...normText(s)];
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(''));
  return out;
}

export function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / Math.min(a.size, b.size);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  const uni = a.size + b.size - hit;
  return uni === 0 ? 0 : hit / uni;
}

/** 4-gram 中对来源不可见的部分占比 = 新颖度(0 复述 / 1 全新) */
export function noveltyOf(text: string, sourceText: string): number {
  const g = charNgrams(text, 4);
  if (g.size === 0) return 0;
  const s = charNgrams(sourceText, 4);
  let hit = 0;
  for (const x of g) if (s.has(x)) hit++;
  return 1 - hit / g.size;
}

/** "新增成分":规则化/决定/因果/对比/条件 —— 允许在低新颖度下依然有价值的句子 */
const ADDITIVE = [
  /因为|由于|导致|所以|因此|于是|结果|起因/,
  /决定|结论|定案|确定|改为|不再|以后|今后|约定|规则|原则|必须|禁止|一律/,
  /相比|对比|不同于|区别|反而|但|然而|而是|并不/,
  /当.{0,12}时|如果.{0,12}就|一旦|除非|只要/,
  /第一次|首次|唯一|最[好差难易]|更[好差]/,
];

export function hasAdditiveContent(text: string): boolean {
  return ADDITIVE.some(re => re.test(String(text || '')));
}

export interface QualitySource { id: string; text: string }
export interface QualityPolicy {
  /** 新颖度低于此值且无新增成分 → 判为复述(默认 0.3 = 与基线 80% 分位对齐) */
  minNovelty?: number;
  /** 近重复阈值(3-gram Jaccard,默认 0.7) —— 两侧整体相似 */
  dupJaccard?: number;
  /** 近重复阈值(3-gram 包含度,默认 0.8) —— 一条是另一条的改写/截取 */
  dupContainment?: number;
  /** 证据原句最短长度(默认 4 字,太短的引文无判别力) */
  minEvidenceChars?: number;
}

export interface QualityVerdict {
  ok: boolean;
  reasons: string[];
  novelty: number;
  anchor: number;
  evidenceOk: boolean | null;
  duplicateOf?: string;
  /** 由验证器算出的重要度(替代模型自评) */
  importance: number;
}

/**
 * 评估一条洞察。
 * @param existing 已有洞察(用于近重复判定);不传则跳过第 3 闸
 * @param srcImportance 来源记忆的平均 importance(验证器输入之一)
 */
export function evaluateInsight(input: {
  text: string;
  evidence?: string;
  /** 模型自报的新增成分类型(rule/decision/causal/contrast/integration/summary) */
  adds?: string;
  sources: QualitySource[];
  existing?: Array<{ id: string; text: string }>;
  srcImportance?: number;
  policy?: QualityPolicy;
}): QualityVerdict {
  const p = { minNovelty: 0.3, dupJaccard: 0.7, dupContainment: 0.8, minEvidenceChars: 4, ...(input.policy || {}) };
  const reasons: string[] = [];
  const text = String(input.text || '').trim();
  const srcConcat = (input.sources || []).map(s => s.text).join('\n');

  const anchor = overlapRatio(charNgrams(text, 2), charNgrams(srcConcat, 2));
  const novelty = noveltyOf(text, srcConcat);

  // 闸 1:证据必须在来源里找得到
  let evidenceOk: boolean | null = null;
  const ev = normText(input.evidence || '');
  if (ev.length >= p.minEvidenceChars) {
    evidenceOk = normText(srcConcat).includes(ev);
    if (!evidenceOk) reasons.push('evidence-not-in-source');
  }

  // 闸 2:复述(低新颖度且无新增成分)
  if (novelty < p.minNovelty && !hasAdditiveContent(text)) reasons.push('restatement');

  // 闸 2b:自报 summary 且正文里确实没有决定/规则/因果 → 这是摘要,不是洞察,不写
  // (只信正文,不信自报:模型把"摘要"标成 integration 时,上面那条复述闸会兜住低新颖度)
  if (String(input.adds || '').toLowerCase() === 'summary' && !hasAdditiveContent(text)) reasons.push('summary-only');

  // 闸 3:与已有洞察近重复 → 只累加引用,不新增
  let duplicateOf: string | undefined;
  const g3 = charNgrams(text, 3);
  for (const e of input.existing || []) {
    const g3e = charNgrams(e.text, 3);
    // 两条判据:整体相似(Jaccard) 或 一条被另一条基本覆盖(包含度)。
    // 只用 Jaccard 会漏掉"同一句话换了语序"这种最常见的重复形态(实测 0.69 < 0.7)。
    if (jaccard(g3, g3e) >= p.dupJaccard || overlapRatio(g3, g3e) >= p.dupContainment) {
      duplicateOf = e.id; reasons.push('near-duplicate'); break;
    }
  }

  // 闸 4:验证器重要度(0.5 来源强度 + 0.2 跨源 + 0.3 新颖度)
  const cross = (input.sources || []).length;
  const src = Number.isFinite(input.srcImportance as number) ? (input.srcImportance as number) : 0.5;
  const importance = Math.min(1, Math.max(0,
    0.5 * Math.min(1, Math.max(0, src))
    + 0.2 * Math.min(1, cross / 2)
    + 0.3 * Math.min(1, novelty / 0.6)));

  const blocking = reasons.filter(r => r === 'evidence-not-in-source' || r === 'restatement'
    || r === 'summary-only' || r === 'near-duplicate');
  return {
    ok: blocking.length === 0,
    reasons: [...new Set(reasons)],
    novelty: Number(novelty.toFixed(3)),
    anchor: Number(anchor.toFixed(3)),
    evidenceOk,
    duplicateOf,
    importance: Number(importance.toFixed(3)),
  };
}
