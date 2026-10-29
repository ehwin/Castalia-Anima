/**
 * 本地情感词表(affect lexicon)—— 离线 VAD 回退
 *
 * 为什么需要:实测 airi bank **262 条活跃记忆里 0 条有 vad_valence**,原因是引擎唯一的
 * VAD 来源是 `ollamaDetectVAD`(emotion.ts),而本机 Ollama 根本没跑(11434 无监听)。
 * 于是 search.ts 的 computeEmotionalIntensity 永远走 emotional_impact 回退(多数为 0),
 * 情感权重 0.12 × 0 = 0 —— 整套情感机制在线上是空转的。
 *
 * 这个模块只做一件事:在没有 Ollama/LLM 的情况下,用词表给出**粗略但可用**的 VAD。
 * 定位是**兜底**,不是替代:有模型时不走这里;走这里时只在 confidence 上标低值。
 * 精度要求按"情感记忆体"定 —— 不需要准到能评测,只需要让"那场争吵"和"今天吃了面"
 * 在情感维度上分开。
 */

export interface AffectScore {
  valence: number;   // -1..1
  arousal: number;   // 0..1
  dominance: number; // -1..1
  confidence: number; // 0..1(命中词越多越高)
  matched: string[];  // 命中的词,便于排查
}

/** 词 → [valence, arousal, dominance];按强度分三档,避免"有点烦"和"恨"同分 */
const LEXICON: Record<string, [number, number, number]> = {
  // ── 正 ──
  喜欢: [0.6, 0.5, 0.3], 爱: [0.85, 0.7, 0.3], 心动: [0.7, 0.7, 0.1],
  开心: [0.7, 0.6, 0.4], 高兴: [0.65, 0.55, 0.4], 快乐: [0.7, 0.5, 0.4],
  安心: [0.5, 0.2, 0.5], 温柔: [0.5, 0.3, 0.4], 骄傲: [0.6, 0.55, 0.6],
  感动: [0.7, 0.6, 0.2], 期待: [0.55, 0.55, 0.3], 谢谢: [0.45, 0.25, 0.4],
  告白: [0.75, 0.8, 0.2], 约定: [0.6, 0.45, 0.5], 拥抱: [0.6, 0.5, 0.3],
  撒娇: [0.5, 0.45, 0.1], 甜: [0.55, 0.4, 0.3], 好可爱: [0.6, 0.5, 0.2],
  // ── 负 ──
  难过: [-0.7, 0.35, -0.4], 伤心: [-0.75, 0.4, -0.5], 哭: [-0.7, 0.6, -0.5],
  生气: [-0.6, 0.8, 0.3], 愤怒: [-0.8, 0.85, 0.3], 烦: [-0.5, 0.6, 0.0],
  讨厌: [-0.65, 0.55, 0.1], 委屈: [-0.6, 0.45, -0.6], 孤独: [-0.6, 0.2, -0.5],
  害怕: [-0.6, 0.75, -0.6], 怕: [-0.55, 0.7, -0.6], 焦虑: [-0.55, 0.7, -0.4],
  吵架: [-0.7, 0.85, 0.0], 分手: [-0.85, 0.8, -0.4], 失望: [-0.65, 0.35, -0.4],
  累: [-0.4, 0.3, -0.3], 疼: [-0.5, 0.6, -0.4], 死: [-0.8, 0.7, -0.5],
  对不起: [-0.35, 0.35, -0.2], 抱歉: [-0.35, 0.3, -0.2], 不安: [-0.55, 0.6, -0.5],
  // ── 中性但高唤醒 ──
  惊: [0.0, 0.85, 0.0], 突然: [0.0, 0.6, 0.0], 终于: [0.3, 0.6, 0.3],
};

/** 程度副词/强度标记 → 放大系数 */
const INTENSIFIERS: Record<string, number> = {
  太: 1.5, 很: 1.35, 超级: 1.6, 特别: 1.4, 真的: 1.3, 非常: 1.5, 最: 1.6, 好: 1.2,
};

/** 否定词:紧跟其后的情感词取反(只处理一个字符距离内的简单情形) */
const NEGATIONS = new Set(['不', '没', '别', '无', '非']);

/**
 * 打分。空文本/无命中 → 全 0 + confidence 0(调用方据此跳过,不要凭空造情绪)。
 * 标点:多个感叹号提升 arousal;省略号略微下调 arousal(语气放缓)。
 */
export function scoreAffect(text: string): AffectScore {
  const s = String(text || '');
  if (!s.trim()) return { valence: 0, arousal: 0, dominance: 0, confidence: 0, matched: [] };

  let v = 0, a = 0, d = 0, hits = 0;
  const matched: string[] = [];
  for (const [word, [lv, la, ld]] of Object.entries(LEXICON)) {
    let from = 0;
    for (;;) {
      const i = s.indexOf(word, from);
      if (i < 0) break;
      from = i + word.length;
      // 强度:看前面 2 个字符内有无程度副词
      let mult = 1;
      const window = s.slice(Math.max(0, i - 2), i);
      for (const [adv, m] of Object.entries(INTENSIFIERS)) {
        if (window.includes(adv)) { mult = Math.max(mult, m); break; }
      }
      // 否定:紧邻前一个字符是否定词
      const prev = i > 0 ? s[i - 1] : '';
      const negated = NEGATIONS.has(prev);
      const sign = negated ? -1 : 1;

      v += sign * lv * mult;
      a += la * mult;
      d += sign * ld * mult;
      hits++;
      matched.push(word + (negated ? '(否定)' : '') + (mult > 1 ? `(×${mult})` : ''));
    }
  }
  if (hits === 0) {
    // 没有任何情感词:只保留"高唤醒标点"这一条线索(如"！！！"),否则全 0
    const bangs = (s.match(/[!！]/g) || []).length;
    const arousal = Math.min(0.6, bangs * 0.2);
    return { valence: 0, arousal, dominance: 0, confidence: arousal > 0 ? 0.2 : 0, matched: [] };
  }

  // 标点修正
  const bangs = Math.min(3, (s.match(/[!！]/g) || []).length);
  a += bangs * 0.08;
  if (/……|\.\.\./.test(s)) a -= 0.1;

  const norm = (x: number, lim: number) => Math.max(-lim, Math.min(lim, x / Math.max(1, hits)));
  return {
    valence: round2(norm(v, 1)),
    arousal: round2(Math.max(0, Math.min(1, a / Math.max(1, hits)))),
    dominance: round2(norm(d, 1)),
    confidence: round2(Math.min(0.75, 0.25 + 0.15 * hits)),
    matched,
  };
}

/** 综合强度(与 computeBaseIntensity 同口径:|v|+|a|+|d| 的均值) */
export function affectIntensity(s: AffectScore): number {
  return Math.min(1, (Math.abs(s.valence) + Math.abs(s.arousal) + Math.abs(s.dominance)) / 3);
}

/** emotional_impact 的 0..10 标度(引擎老字段) */
export function affectImpact(s: AffectScore): number {
  return Math.round(Math.min(10, affectIntensity(s) * 10) * 10) / 10;
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}
