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
 *   5. 扩散激活(共享实体/被一起提起)                 —— 联想,不是"共激活计数"
 *   6. 锚点(pinned)                                  —— 被钉住的那一刻永不衰减(Character.AI Story Memory)
 *
 * ── 与现有引擎的关系(2026-10-29 逐行核对结论,证据表见 docs/emotional-memory.md)──
 * search.ts 的 computeScore 已是「一致性 1.00 + 情感 0.12 + 时间 0.15 + 偏离 0.10」,
 * 且用 last_accessed_at 刷新时间时钟;所以本模块**不替代 computeScore**,只补它缺的三样:
 * 情绪一致性、扩散激活、锚点/沉默策略。
 *
 * 两个实现决定来自核对,不是照抄论文:
 * - **激活用绝对标度**(sigmoid(lnΣ)),不用候选集 min-max:min-max 会让"全是陈年记忆"的
 *   集合里最高者也拿 1.0,而情感记忆要能表达"这段时间没什么值得提的"。
 * - **系统注入不算强化**:nooa-memory 明确 "injected entry is observability data, not
 *   reinforcement"。Anima 2026-10-28 已踩过这个坑(search.ts 里的正反馈注释),
 *   所以共振只认用户主动提起/显式回忆。
 */
/** 默认权重:情感强度与激活占大头,importance 次之;锚点直接短路为 1。 */
export const SALIENCE_WEIGHTS = {
    intensity: 0.30,
    importance: 0.20,
    activation: 0.20,
    congruence: 0.15,
    resonance: 0.15,
};
/** ACT-R 基础激活衰减率(ACT-R 文献常用 0.5) */
export const ACTR_D = 0.5;
/** 同一轮内的重复引用不重复计数 */
export const ACTR_MIN_CONTEXT_GAP_MS = 1000;
/**
 * 激活 → 0..1 的标定常数(**工程标定,不是论文常数**)。
 * 以**小时**为单位:d=0.5 时"1 小时前单次"ln=0、"30 天前单次"ln≈−3.29。
 * sigmoid(1.2x+1.3) 把两者映到 ≈0.80 / ≈0.02,并由测试锁定。
 */
export const ACT_SLOPE = 1.2;
export const ACT_OFFSET = 1.3;
/**
 * ACT-R base-level activation: A = ln( Σ_k (now − t_k)^−d ),单位小时。
 *
 * 与"最后访问时间 + 次数"相比,它天然表达**间隔效应**:同一件事被反复想起(且分散在
 * 不同时间)比一次性想起更"记得住";越久没想起衰减越快。
 * 从未被提起 → -Infinity;要 0..1 请用 activationScore()。
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
        const ageHours = Math.max(1 / 3600, (now - t) / 3600000);
        sum += Math.pow(ageHours, -d);
    }
    return sum > 0 ? Math.log(sum) : Number.NEGATIVE_INFINITY;
}
/**
 * 激活 → 0..1 的**绝对**映射(不随候选集变化)。
 *
 * 为什么不用 min-max:一个全是陈年记忆的候选集里,min-max 也会把最高的那条算成 1.0,
 * 于是"最近没什么值得提的"这种状态根本无法表达。绝对标度能表达它。
 */
export function activationScore(accessTimes, now, d = ACTR_D) {
    const a = baseLevelActivation(accessTimes, now, d);
    if (!Number.isFinite(a))
        return 0;
    return clamp(1 / (1 + Math.exp(-(ACT_SLOPE * a + ACT_OFFSET))), 0, 1);
}
/** agentState 的 currentMood 是 −10..+10 标量;转成 VAD 以便与记忆情绪比较(arousal 用强度代理)。 */
export function moodFromScalar(currentMood) {
    const v = clamp(currentMood / 10, -1, 1);
    return { valence: v, arousal: Math.min(1, Math.abs(v)) };
}
/**
 * 哪些渠道算"强化":只有用户侧/显式回忆。系统注入是观测数据,不计入 —— 否则就是
 * search.ts 里 2026-10-28 修掉的那个正反馈(注入→计数→更容易被注入)。
 */
export const REINFORCEMENT_CHANNELS = new Set(['user_reference', 'explicit_recall', 'user_repeat']);
export function shouldReinforce(channel) {
    return REINFORCEMENT_CHANNELS.has(String(channel || '').toLowerCase());
}
/**
 * 明确只读的渠道（2026-10-31）。
 *
 * `shouldReinforce` 定义的是"哪些读取算外部证据级的强化支持"（研究口径，白名单），
 * 它从来没被执行过 —— 于是 accessChannel:'diagnostic' 的诊断读取照样 +1 访问计数、
 * 刷新 last_accessed_at，把后续检索分数从 .656 抬到 .845（审计 §4.1）。
 *
 * 这个黑名单是**执行口径**：命中即不写访问、不写日志。默认（未标渠道的老调用）
 * 保持原行为，避免把普通检索的强化一并关掉。
 *
 * 现状（评审 P2-2）：执行点已就位，但 `src/` 里目前**没有**把渠道标成 diagnostic 的
 * 调用方 —— MCP 的 memory_search 走默认 'search'。要真正生效，得在诊断/基准/自检
 * 的调用点显式传 `accessChannel: 'diagnostic'`（scripts/eval 已这么做）。别把它当成
 * 「线上已经不会再被诊断读取抬分」来引用。
 */
export const NON_REINFORCING_CHANNELS = new Set([
    'diagnostic', 'injection', 'internal', 'reflection', 'reflect',
    'self_cycle', 'maintenance', 'audit', 'test', 'dry_run', 'system',
]);
export function isNonReinforcingChannel(channel) {
    return NON_REINFORCING_CHANNELS.has(String(channel || '').toLowerCase());
}
/** 该渠道的读取是否允许落库（计数 + 日志）。 */
export function shouldCountAccess(channel) {
    return !isNonReinforcingChannel(channel);
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
    const out = candidates.map(c => {
        const parts = {
            intensity: clamp(c.intensity, 0, 1),
            importance: clamp(c.importance, 0, 1),
            activation: activationScore(c.accessTimes, now),
            congruence: moodCongruence(mood, c.vad),
            resonance: resonanceBoost(c.id, seeds, c.resonance),
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
/**
 * 这个策略能不能真的进注入块。
 *
 * 2026-10-31：`context-only`（降为背景）和 `skip`（显著度太低）都不能进；
 * 调用方此前只排除了前者，`skip` 被漏掉，低显著度记忆照旧出现在提示词里。
 */
export function policyAllowsInjection(policy) {
    return policy === 'always' || policy === 'inject';
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