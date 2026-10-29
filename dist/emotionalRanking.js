/**
 * 情感显著性排序(Anima 专用,2026-10-29)
 *
 * 前提:**Anima 是情感记忆体,不是工程记忆体**。评价它不该用 precision/recall/MRR ——
 * 那些衡量的是"能不能找到答案";情感记忆要的是"该想起的时候想起、不该提的时候不提、
 * 重要的不会淡、次要的会淡"。所以这里的输入不是查询相似度,而是:
 *
 *   1. 情感强度(arousal/valence 衰减后的 intensity)  —— 越有情绪越难忘(MemoryBank/Ebbinghaus)
 *   2. 标记重要性(importance)                        —— 用户/程序判定"这件事重要"
 *   3. ACT-R 基础激活 ln(Σ (now−t_k)^−d)              —— 频次+近因,比单纯 exp 衰减更贴人脑
 *   4. 情绪一致性(mood congruence)                   —— 当前心情筛出同调记忆(Affective Field Theory)
 *   5. 共振(Hebbian 共激活)                          —— 一起被想起过的记忆互相加强
 *   6. 锚点(pinned)                                  —— 被钉住的那一刻永不衰减(Character.AI Story Memory)
 *
 * 这些量都**不需要向量检索准确**:即便词法只命中一条,锚点与共振也能把该在场的记忆带上来。
 */
/** 默认权重:情感强度与激活占大头,importance 次之;锚点直接短路为 1。 */
export const SALIENCE_WEIGHTS = {
    intensity: 0.30,
    importance: 0.20,
    activation: 0.20,
    congruence: 0.15,
    resonance: 0.15,
};
/** ACT-R 基础激活衰减率(默认 0.5,与 ACT-R 文献一致) */
export const ACTR_D = 0.5;
/** 每次被召回视为一次"呈现";同一秒内的重复不重复计数 */
export const ACTR_MIN_CONTEXT_GAP_MS = 1000;
/**
 * ACT-R base-level activation: A = ln( Σ_k (now − t_k)^−d )
 *
 * 与"最后访问时间 + 次数"相比,它天然表达**间隔效应**:同一件事被反复想起(且分散在
 * 不同时间)比一次性想起更"记得住";越久没想起衰减越快。
 * 返回负值或 -Infinity(从未召回)—— 排序时会做集合内归一化,所以量纲不重要。
 */
export function baseLevelActivation(accessTimes, now, d = ACTR_D) {
    if (!accessTimes.length)
        return Number.NEGATIVE_INFINITY;
    const ts = [...accessTimes].sort((a, b) => a - b);
    let sum = 0;
    let prev = Number.NEGATIVE_INFINITY;
    for (const t of ts) {
        if (t < 0 || !Number.isFinite(t))
            continue;
        if (t - prev < ACTR_MIN_CONTEXT_GAP_MS)
            continue; // 同一轮内多次引用算一次
        prev = t;
        const ageSec = Math.max(1, (now - t) / 1000);
        sum += Math.pow(ageSec, -d);
    }
    return sum > 0 ? Math.log(sum) : Number.NEGATIVE_INFINITY;
}
/**
 * 情绪一致性:mood-congruent recall。
 *
 * - 同向(valence 符号一致)加分,反向减分;arousal 越接近越"同调"。
 * - 结果 0..1(0.5 = 中性/无信息),这样即使没有 VAD 数据也不会把候选压死。
 *
 * 注意这是**偏向**而不是过滤:心情低落时不排除快乐记忆,只是让同调的先浮上来
 * (人也是这样 —— 但不会 100% 只想起同调的事,所以权重只给 0.15)。
 */
export function moodCongruence(mood, memory) {
    if (!mood || !memory)
        return 0.5;
    const mv = clamp(mood.valence, -1, 1);
    const ev = clamp(memory.valence, -1, 1);
    const ma = clamp(mood.arousal, 0, 1);
    const ea = clamp(memory.arousal, 0, 1);
    // valence: 同号→1,异号→-1,任一侧接近 0 → 趋于中性
    const vSim = mv * ev >= 0
        ? Math.min(1, Math.abs(mv) * Math.abs(ev) * 2 + 0.5 * Math.min(Math.abs(mv), Math.abs(ev)))
        : -Math.min(1, Math.abs(mv) * Math.abs(ev) * 2);
    const aSim = 1 - Math.abs(ma - ea); // 0..1
    return clamp(0.5 + 0.5 * (0.7 * vSim + 0.3 * (aSim * 2 - 1)), 0, 1);
}
/**
 * 共振(Hebbian / 扩散激活):当前"在场"的记忆集合会把与之共激活过的记忆提上来。
 * seeds = 已经决定要注入的记忆 id。返回 0..1(按最大共激活次数归一,再开方压一下长尾)。
 */
export function resonanceBoost(memoryId, seeds, resonance, maxCoactivation = 10) {
    if (!resonance || seeds.length === 0)
        return 0;
    let sum = 0;
    for (const s of seeds) {
        if (s === memoryId)
            continue;
        sum += Number(resonance[s] || 0);
    }
    if (sum <= 0)
        return 0;
    return clamp(Math.sqrt(sum / Math.max(1, maxCoactivation)), 0, 1);
}
/**
 * 对一批候选打分并归一化激活项。
 *
 * @param candidates 候选(通常 = 词法/向量/标签召回并集)
 * @param now 当前时间 ms
 * @param mood 当前心情(AIRI 的 VAD)
 * @param seeds 已确定在场的记忆 id(用于共振)
 */
export function rankBySalience(candidates, now, mood, seeds = [], weights = SALIENCE_WEIGHTS) {
    const raw = candidates.map(c => ({
        c,
        act: baseLevelActivation(c.accessTimes, now),
        res: resonanceBoost(c.id, seeds, c.resonance),
        con: moodCongruence(mood, c.vad),
    }));
    // 激活做集合内 min-max(有从未召回的候选时,它们落到 0)
    const acts = raw.map(r => r.act).filter(a => Number.isFinite(a));
    const maxA = acts.length ? Math.max(...acts) : 0;
    const minA = acts.length ? Math.min(...acts) : 0;
    const norm = (a) => {
        if (!Number.isFinite(a))
            return 0;
        if (maxA - minA < 1e-9)
            return 0.5;
        return clamp((a - minA) / (maxA - minA), 0, 1);
    };
    const out = raw.map(({ c, act, res, con }) => {
        const parts = {
            intensity: clamp(c.intensity, 0, 1),
            importance: clamp(c.importance, 0, 1),
            activation: norm(act),
            congruence: con,
            resonance: res,
        };
        if (c.pinned) {
            // 锚点不被权重稀释:钉住的那一刻就是必须在场
            return { id: c.id, score: 1, parts };
        }
        const score = weights.intensity * parts.intensity
            + weights.importance * parts.importance
            + weights.activation * parts.activation
            + weights.congruence * parts.congruence
            + weights.resonance * parts.resonance;
        return { id: c.id, score: clamp(score, 0, 1), parts };
    });
    return out.sort((a, b) => b.score - a.score);
}
export function injectionPolicy(score, opts = {}) {
    if (opts.pinned)
        return 'always';
    const hi = opts.injectThreshold ?? 0.55;
    const mid = opts.contextOnlyThreshold ?? 0.35;
    if (score >= hi)
        return 'inject';
    if (score >= mid) {
        const negative = (opts.mood?.valence ?? 0) <= -0.3;
        return negative ? 'context-only' : 'inject';
    }
    return 'skip';
}
function clamp(x, lo, hi) {
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
}
/** 提取强度随闲置时间衰减;存储强度越高衰减越慢 */
export function bjorkDecay(state, hoursSinceAccess, tauHours = 72) {
    const s = clamp(state.storage, 0, 1);
    const tau = tauHours * (1 + 3 * s); // S=1 → 4 倍时间常数
    const r = clamp(state.retrieval, 0, 1) * Math.exp(-Math.max(0, hoursSinceAccess) / tau);
    return { storage: s, retrieval: r };
}
/**
 * 一次事件后更新强度。
 * - 'retrieve':成功回忆(R 提升;R 原本越低,S 涨得越多 —— 间隔效应)
 * - 're-encounter':重新遇到原文(重读/用户复述;R 大幅提升,S 小幅提升)
 */
export function bjorkUpdate(state, event) {
    const s = clamp(state.storage, 0, 1);
    const r = clamp(state.retrieval, 0, 1);
    if (event === 'retrieve') {
        const gainS = 0.35 * (1 - s) * (1 - r); // 越难想起、想起来后记得越牢
        const gainR = 0.55 * (1 - r);
        return { storage: clamp(s + gainS, 0, 1), retrieval: clamp(r + gainR, 0, 1) };
    }
    const gainS = 0.12 * (1 - s);
    const gainR = 0.85 * (1 - r);
    return { storage: clamp(s + gainS, 0, 1), retrieval: clamp(r + gainR, 0, 1) };
}
/**
 * 把 Bjork 两轴并成 0..1 的"记得的强度":提取强度为主,存储强度兜底。
 * floor = 存储强度给出的下限,保证被情绪刻深的事不会沉到 0。
 */
export function bjorkStrength(state, floorRatio = 0.45) {
    const s = clamp(state.storage, 0, 1);
    const r = clamp(state.retrieval, 0, 1);
    const floor = floorRatio * s;
    return clamp(Math.max(r, floor) * 0.7 + s * 0.3, 0, 1);
}
//# sourceMappingURL=emotionalRanking.js.map