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
  /**
   * 严格支持检查(默认 true)。关掉后 1b/1c 仍会记 reason，但 1d(缺引文)不拦。
   * 只用于兼容旧行为或做消融，不应当成日常默认。
   */
  strictSupport?: boolean;
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

/** 闸 1b/1c 用的词面工具（2026-10-31） */
const NEGATORS = /[不没勿未非禁拒否莫]/;
/** 态度/否定动词：出现在术语前 = 对它的否定（"排斥加糖" ≡ "不接受加糖"） */
const NEG_PHRASE_TAIL = /(不接受|不愿意|不喜欢|不再|不想|禁止|避免|拒绝|排斥|反感|讨厌|谢绝|戒|忌|不能|不要)$/;
/**
 * 结论里更常见的否定形态：「不要熬夜」「别再熬夜了」「她不该熬夜」。
 * 只看最后一个字会漏掉「不该」「别再」这类隔着一个情态词的否定（评审 P2-3）。
 * `别` 要排除「特别/分别/区别」这种构词。
 */
const NEGATOR_TAIL = /(?:(?<![特分级区差])别|[不没勿未非禁拒否莫](?:该|会|能|要|想|应|得|可|愿|必|敢|再|曾)?)$/;
/** 来源把某术语评价为负面 —— 此时结论否定它是同向改写，不是翻转。 */
const NEG_EVAL = /(不好|不对|有害|伤身|伤害|伤身|危险|风险|后悔|受不了|难受|生病|糟糕|错误|坏处|副作用|上瘾|过敏|失败|痛苦)/;
/** 名词化后缀：术语后面跟着它就不是在断言这个动作（"接受度" ≠ "接受"） */
const NOMINAL_SUFFIX = /[度性率感者]/;
const CAUSAL_MARK = /(因为|由于|因此|所以|导致|说明|证明)/;
const OBLIGATION_MARK = /(必须|务必|一定|只能|绝不能|禁止|不要再)/;
const PREFERENCE_MARK = /(喜欢|偏好|讨厌|反感|不吃|不喝|只喝|只吃|每天|从不|总是|习惯)/;

/**
 * 术语在文本里的极性：+1 断言、−1 被否定、0 未出现。
 *
 * 只看术语**之前**最多 4 个字符的窗口 —— 术语内部自带的否定成分（"无糖"的"无"）
 * 属于术语本身，不是对它的否定。术语后面紧跟名词化后缀（度/性/率/感/者）时
 * 它不再是动词断言（"观察接受度"），该次出现不计。
 */
export function termPolarity(text: string, term: string): number {
  const t = String(text || '');
  let idx = t.indexOf(term);
  if (idx < 0) return 0;
  let pos = 0;
  while (idx >= 0) {
    const next = t.slice(idx + term.length, idx + term.length + 1);
    const nominalized = NOMINAL_SUFFIX.test(next);
    if (!nominalized) {
      const before = t.slice(Math.max(0, idx - 4), idx);
      const negated = NEGATORS.test(before.slice(-1)) || NEG_PHRASE_TAIL.test(before) || NEGATOR_TAIL.test(before);
      pos += negated ? -1 : 1;
    }
    idx = t.indexOf(term, idx + term.length);
  }
  return pos > 0 ? 1 : pos < 0 ? -1 : 0;
}

/**
 * 结论与来源在**共享术语**上是否极性冲突。
 *
 * 审计 §4.2 的核心反例：来源"只喝无糖咖啡，不接受加糖"，结论"必须加糖" ——
 * 引文是真实子串，闸 1 通过。这里的检查是：结论断言某词为正，而来源对同一个词是
 * 否定（或反之），即为未被支持的翻转。返回冲突词，没有冲突返回 null。
 *
 * 例外（评审 P2-3）：来源把该术语**评价为负面**时，结论去否定它不算冲突 ——
 * 「来源：熬夜对身体不好」+「结论：不要熬夜」是同向改写，原来会拒。
 */
export function claimSourceConflict(claim: string, source: string): string | null {
  const c = String(claim || ''), s = String(source || '');
  if (!c || !s) return null;
  const seen = new Set<string>();
  const sNorm = normText(s);
  for (const term of charNgrams(c, 2)) {
    if (seen.has(term)) continue;
    seen.add(term);
    if (!sNorm.includes(term)) continue;
    const pc = termPolarity(c, term);
    const ps = termPolarity(s, term);
    if (pc === 0 || ps === 0 || pc === ps) continue;
    // 结论否定、来源肯定，但来源在术语附近把它说成坏事 → 这是「规则化改写」，不是翻转。
    if (pc < 0 && NEG_EVAL.test(sourceWindow(s, term))) continue;
    return term;
  }
  return null;
}

/** 术语在来源里前后各取一小段，用来判断来源是不是在评价它。 */
function sourceWindow(text: string, term: string): string {
  const idx = text.indexOf(term);
  if (idx < 0) return '';
  return text.slice(Math.max(0, idx - 6), idx + term.length + 10);
}

/**
 * 强断言（因果/义务）却在来源里几乎没有词面依据。
 *
 * 审计 §4.2 的第二类反例："因为患严重糖尿病，所以必须胰岛素治疗" —— 糖尿病/胰岛素
 * 在来源里根本不存在，却因为引文是真实子串而被接收。这里用"结论的 2-gram 与来源
 * 的重合比例"做保守判定；弱动词（"可能/建议/可以"）不在义务标记里，不会被误伤。
 */
export function unsupportedCausalClaim(claim: string, source: string): boolean {
  const t = String(claim || '');
  if (!CAUSAL_MARK.test(t) && !OBLIGATION_MARK.test(t)) return false;
  const sG = charNgrams(source, 2);
  // 取不到来源文本 ≠ 没有依据（评审 P2-4）：跨实例/联邦来源、recMeta 里查不到的行
  // 会传空串。此时不判「编造」，只让闸 1（引文必须是子串）去管伪造引文。
  if (sG.size === 0) return false;
  // 分句（只按标点切，保留"因为/所以/必须"在分句里做标记）：
  // 真实的失败形态是"真前提 + 假推论"——整句往往与来源有重合，必须逐分句判。
  const clauses = t.split(/[，,。；;！!？?\n]/).map(x => x.trim()).filter(x => x.length >= 4);
  for (const cl of clauses) {
    if (!CAUSAL_MARK.test(cl) && !OBLIGATION_MARK.test(cl)) continue;
    const g = charNgrams(cl, 2);
    if (g.size === 0) continue;
    // 阈值 0.08 ≈ "最多一个偶然重合的 2-gram"：合法的改写型分句（"提供咖啡时应默认无糖"）
    // 与来源有 咖啡/无糖 这类实质重合，不会被误伤。
    if (overlapRatio(g, sG) < 0.08) return true;
  }
  return false;
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

  // ═══ 闸 1b/1c/1d（2026-10-31）：引文存在 ≠ 结论被支持 ═══
  //
  // 审计 §4.2 的反例：来源「只喝无糖咖啡，不接受加糖」，结论「必须加糖」被接收，
  // 因为闸 1 只验证引文是来源子串，从不验证结论的方向。这里补三条确定性检查：
  //   1b 极性冲突：结论与来源在共享术语上方向相反 → evidence-contradicts-claim
  //   1c 无依据因果：强因果/义务断言在来源里几乎没有词面支持 → unsupported-cause
  //   1d 缺引文的事实断言：声称用户偏好却不给任何引文 → evidence-missing
  const strict = p.strictSupport !== false;
  const conflictTerm = claimSourceConflict(text, srcConcat);
  if (conflictTerm) reasons.push(`evidence-contradicts-claim:${conflictTerm}`);
  if (unsupportedCausalClaim(text, srcConcat)) reasons.push('unsupported-cause');
  if (evidenceOk === null && PREFERENCE_MARK.test(text) && strict) reasons.push('evidence-missing');

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
    || r === 'summary-only' || r === 'near-duplicate'
    || r.startsWith('evidence-contradicts-claim') || r === 'unsupported-cause' || r === 'evidence-missing');
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
