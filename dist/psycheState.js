import { normalizeCharacterId, normalizeProject } from './env.js';
import { DatabaseManager } from './db.js';
export const DEFAULT_PSYCHE_BASELINE = {
    valence: 0.4,
    arousal: 0.3,
    dominance: 0.6,
};
/** 3× the valence half-life: leftover deviation is ~12%, i.e. no longer an observation. */
export const DEFAULT_EVIDENCE_TTL_HOURS = 72;
function envNumber(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) ? raw : fallback;
}
/**
 * Runtime tuning. The constants below started as placeholders: the audit says
 * half-life and thresholds must come from a replay/calibration set, so every
 * one of them is overridable from the environment instead of needing a rebuild.
 */
export function readPsycheTuning() {
    return {
        baseline: {
            valence: envNumber('PSYCHE_BASELINE_VALENCE', DEFAULT_PSYCHE_BASELINE.valence),
            arousal: envNumber('PSYCHE_BASELINE_AROUSAL', DEFAULT_PSYCHE_BASELINE.arousal),
            dominance: envNumber('PSYCHE_BASELINE_DOMINANCE', DEFAULT_PSYCHE_BASELINE.dominance),
        },
        halfLife: {
            valence: envNumber('PSYCHE_HALF_LIFE_VALENCE_HOURS', DEFAULT_HALF_LIFE.valence),
            arousal: envNumber('PSYCHE_HALF_LIFE_AROUSAL_HOURS', DEFAULT_HALF_LIFE.arousal),
            dominance: envNumber('PSYCHE_HALF_LIFE_DOMINANCE_HOURS', DEFAULT_HALF_LIFE.dominance),
        },
        // 慢层：0 表示关闭（退回单层 decay+gain，用于 A/B 与回归测试）。
        moodHalfLife: {
            valence: envNumber('PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS', DEFAULT_MOOD_HALF_LIFE.valence),
            arousal: envNumber('PSYCHE_MOOD_HALF_LIFE_AROUSAL_HOURS', DEFAULT_MOOD_HALF_LIFE.arousal),
            dominance: envNumber('PSYCHE_MOOD_HALF_LIFE_DOMINANCE_HOURS', DEFAULT_MOOD_HALF_LIFE.dominance),
        },
        // 慢层回落到基线的倍率。默认 1 = 心境按 τs 回落（与 E2 估出的慢层同常数）；
        // 调大会让「坏心情」持续更久（惰性更强）。
        moodRelaxRatio: envNumber('PSYCHE_MOOD_RELAX_RATIO', 1),
        targetGain: envNumber('PSYCHE_TARGET_GAIN', 0.55),
        eventGain: envNumber('PSYCHE_EVENT_GAIN', 0.35),
        bandEnter: envNumber('PSYCHE_BAND_ENTER', 0.25),
        bandHold: envNumber('PSYCHE_BAND_HOLD', 0.1),
        bandCenterOffset: envNumber('PSYCHE_BAND_CENTER_OFFSET', 0),
        evidenceTtlHours: envNumber('PSYCHE_EVIDENCE_TTL_HOURS', DEFAULT_EVIDENCE_TTL_HOURS),
        // 下面六项是「像人」的项，不是标定值：它们各自对应一条可证伪的人类情感
        // 性质，判断标准是性质是否成立（负性不对称、惯性、饱和、限幅、重要性），
        // 而不是某个具体数字。全部可被环境变量覆盖，便于 A/B。
        negativeImpact: envNumber('PSYCHE_NEGATIVE_IMPACT', 1.35),
        negativePersistence: envNumber('PSYCHE_NEGATIVE_PERSISTENCE', 1.6),
        inertia: envNumber('PSYCHE_INERTIA', 0.55),
        saturation: envNumber('PSYCHE_SATURATION', 0.5),
        maxStep: envNumber('PSYCHE_MAX_STEP', 0.35),
        saliencePersistence: envNumber('PSYCHE_SALIENCE_PERSISTENCE', 1),
    };
}
const psycheStates = new Map();
const loadedKeys = new Set();
const loadWarnings = new Set();
const persistWarnings = new Set();
const DEFAULT_HALF_LIFE = {
    // ⚠️ 单位是**半衰期 H**：`decay()` 用的是 2^(−dt/H)。
    // E2（R10）在 CoVidAffect 上拟合出的是**时间常数 τ**，快层 τf≈2.85h
    // （单层 OU 中位 τ≈2.34h）→ H = τ·ln2 = **1.97h**。原值 2.85 把 τ 当 H 用，
    // 等于把衰减调慢 44%（2026-10-31 审稿复核）。arousal/dominance 没有人类时序
    // 数据支持，沿用旧值。
    valence: 1.97,
    arousal: 4,
    dominance: 36,
};
/**
 * 慢层心境半衰期（同样是 H，不是 τ）。valence 来自 E2 两层拟合的 τs≈66h
 * → H = 66 × ln2 = **45.75h**；其余两维没有数据，按快层的 ~4 倍取整，等有数据再标定。
 */
const DEFAULT_MOOD_HALF_LIFE = {
    valence: 45.75,
    arousal: 16,
    dominance: 144,
};
function clamp(value, min = -1, max = 1) {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}
function finite(value) {
    // 2026-10-31: null / '' / true 都不再被 Number() 悄悄变成 0。
    // 未知维度必须是 undefined（不参与更新），否则「模型没给这一维」会被当成「观测到 0」，
    // 而 0 在 valence 上是强负、在 arousal 上是中性 —— 两种都不该由缺失值产生。
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s)
            return undefined;
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
/**
 * 绝对心境标量(−10..+10)，不经过 band 门控。
 *
 * 2026-10-31 修复：原来 index.ts 在 `band === 'neutral'` 时直接返回 0，而 band 是
 * 「相对基线」的判定（baseline +0.40）。于是 `v=+0.10` 会被判 negative（rel=−0.30），
 * 再被当成 0 传给检索 —— 相对标签、绝对数值和中性门控被拼成了一个值，消费者无法分辨。
 * 现在：需要一个绝对值的地方就用这个函数；需要「相对平时」的地方自己算 `valence − baseline.valence`。
 */
export function absoluteMoodScalar(vad) {
    const v = Number(vad?.valence);
    if (!Number.isFinite(v))
        return undefined;
    return Math.round(Math.max(-10, Math.min(10, v * 10)) * 10) / 10;
}
/**
 * 相对平时的心境偏置（−10..+10）：`(valence − baseline.valence) × 10`。
 *
 * 检索层要的是「她现在比平时更冷还是更暖」，不是「她的绝对愉悦度」（后者恒为 +4，
 * 会把一致性回忆永久推向正向记忆）。两个通道分开：显示/提示词用 absoluteMoodScalar，
 * 检索/情绪合宜性用这个。
 */
export function deviationMoodScalar(vad, baseline) {
    const v = Number(vad?.valence), b = Number(baseline?.valence);
    if (!Number.isFinite(v) || !Number.isFinite(b))
        return undefined;
    return Math.round(Math.max(-10, Math.min(10, (v - b) * 10)) * 10) / 10;
}
function bandFor(valence, center, previous, enter, hold) {
    // Hysteresis prevents a model hovering around a boundary from changing the
    // externally visible label on every turn.
    //
    // The center defaults to the personality baseline (offset 0), but it is a
    // *deployment-level calibration*, not a constant: R16 measured with the real
    // engine on 3,749 CPED dialogues that the state median sits at 0.06 while the
    // baseline is 0.40, so "baseline ± 0.25" labelled 23,775 of 38,575 utterances
    // negative and exactly 9 positive. That corpus needs a shifted/narrower band
    // (`PSYCHE_BAND_CENTER_OFFSET=-0.35 PSYCHE_BAND_ENTER=0.12`), while a library
    // whose state hugs the baseline needs the default. See PsycheTuning.
    const rel = valence - center;
    if (previous === 'positive' && rel > hold)
        return 'positive';
    if (previous === 'negative' && rel < -hold)
        return 'negative';
    if (rel >= enter)
        return 'positive';
    if (rel <= -enter)
        return 'negative';
    return 'neutral';
}
function decay(current, baseline, elapsedHours, halfLife) {
    if (elapsedHours <= 0 || halfLife <= 0)
        return current;
    const factor = Math.pow(0.5, elapsedHours / halfLife);
    return baseline + (current - baseline) * factor;
}
/** 朝任意目标做指数趋近（decay 的推广：目标可以不是基线）。 */
function relaxToward(current, target, elapsedHours, halfLife) {
    if (elapsedHours <= 0 || halfLife <= 0)
        return current;
    return target + (current - target) * Math.pow(0.5, elapsedHours / halfLife);
}
/**
 * 两层松弛 —— E2/R10 在真实人类序列上估出的结构（快层 ~2.85h、慢层 ~66h）：
 *
 *   1) 慢层积分：心境按「当前情绪 − 心境」的比例移动（情绪沉淀成心情）；
 *   2) 慢层回落：心境朝人格基线回落，时间常数 τs × relaxRatio；
 *   3) 快层回归：情绪朝（已经移动过的）心境回归，时间常数 τf。
 *
 * 形状上这是单层做不到的：一次冲击 3 小时后就从可见情绪里淡出，但整天心情偏低。
 * τs ≤ 0 时退化为单层（心境=情绪，一起按 τf 回基线），与旧实现逐位一致，
 * 用于 A/B 与回归测试。
 */
function stepTwoLayer(current, mood, baseline, elapsedHours, halfLifeFast, halfLifeMood, relaxRatio) {
    if (elapsedHours <= 0)
        return { vad: current, mood };
    const tau = Math.max(0, Number.isFinite(halfLifeMood) ? halfLifeMood : 0);
    if (tau <= 0) {
        const next = decay(current, baseline, elapsedHours, halfLifeFast);
        return { vad: next, mood: next };
    }
    const integrate = 1 - Math.pow(0.5, elapsedHours / tau);
    const integrated = mood + (current - mood) * integrate;
    const moodNext = relaxToward(integrated, baseline, elapsedHours, tau * Math.max(1, relaxRatio));
    const vadNext = relaxToward(current, moodNext, elapsedHours, halfLifeFast);
    return { vad: vadNext, mood: moodNext };
}
/**
 * 一步有界更新 —— 四条「像人」的性质集中在这里，而不是散落在调用点：
 *
 * 1) 惯性：朝当前偏离的反方向推，先打折。人类情绪状态有自相关（Kuppens et al. 2010,
 *    "emotional inertia"）：一句好话抵不掉一小时的难过。
 * 2) 负性偏向：向负方向的位移更有效。坏比好更强（Baumeister et al. 2001）。
 * 3) 饱和：越靠近上下轨，边际位移越小。这是阻尼，不是限幅的替代。
 * 4) 限幅：单步位移不超过 maxStep —— 一件事只能把状态推这么远。
 *
 * 四条都是**性质**，不是标定常数：单测断言的是「负向衰减慢于正向」「反向推力被折价」
 * 「一百次同向事件收敛不越界」，而不是某个具体数字。
 */
function boundedIncrement(current, baseline, increment, tuning) {
    let inc = Number.isFinite(increment) ? increment : 0;
    const deviation = current - baseline;
    // 1) 惯性：反方向打折
    if (Math.abs(deviation) > 1e-9 && Math.abs(inc) > 1e-9 && Math.sign(inc) !== Math.sign(deviation))
        inc *= clamp(tuning.inertia, 0, 1);
    // 2) 负性偏向：向下更有效
    if (inc < 0)
        inc *= Math.max(1, tuning.negativeImpact);
    // 3) 饱和：接近轨道时边际递减
    inc *= Math.max(0, 1 - clamp(tuning.saturation, 0, 1) * Math.abs(current));
    // 4) 限幅：单步上限
    const cap = Math.max(0, tuning.maxStep);
    return clamp(current + clamp(inc, -cap, cap));
}
export function createPsycheState(baseline = {}, now = Date.now()) {
    const tuning = readPsycheTuning();
    const b = {
        valence: clamp(finite(baseline.valence) ?? tuning.baseline.valence),
        arousal: clamp(finite(baseline.arousal) ?? tuning.baseline.arousal),
        dominance: clamp(finite(baseline.dominance) ?? tuning.baseline.dominance),
    };
    return {
        version: 1,
        hasEvidence: false,
        lastEvidenceAt: -1,
        salience: 0,
        baseline: b,
        vad: { ...b },
        // 心境初值 = 人格基线：没有证据时「长期心情」就是她的性格底色。
        mood: { ...b },
        // Personality baseline is not an observed affect event. Keep the visible
        // band neutral until a real appraisal arrives.
        band: 'neutral',
        updatedAt: now,
        processedEventIds: [],
    };
}
/** Apply time decay and, for valid new events, an inertial signed impact. */
export function transitionPsycheState(previous, appraisal, now = Date.now(), options = {}) {
    // Event delivery can be delayed or replayed after a restart. Never let an
    // older event move the state clock backwards, otherwise a later read would
    // apply the same decay twice.
    const effectiveNow = Math.max(Number.isFinite(now) ? now : Date.now(), previous.updatedAt);
    const elapsedHours = Math.max(0, effectiveNow - previous.updatedAt) / 3600000;
    const tuning = readPsycheTuning();
    const halfLife = { ...tuning.halfLife, ...(options.halfLifeHours || {}) };
    // 重要性延长持续时间（rumination）：Verduyn & Lavrijsen 2014 的实测结论是
    // 「持续时间由事件重要性与反刍决定」，不是由情绪维度决定。这里把 importance
    // 直接接到半衰期上，而不是给 V/A/D 各配一个固定常数。
    const salience = clamp(finite(options.salience) ?? previous.salience, 0, 1);
    const persistence = clamp(1 + Math.max(0, tuning.saliencePersistence) * salience, 1, 4);
    // 负向偏离退得更慢（负性偏向）。只作用在 valence：它才有明确的好坏方向。
    const valencePersistence = previous.vad.valence < previous.baseline.valence
        ? Math.max(1, tuning.negativePersistence)
        : 1;
    const decayed = {
        valence: 0,
        arousal: 0,
        dominance: 0,
    };
    // 两层：情绪朝心境回归，心境积分情绪再慢慢回基线。见 stepTwoLayer 的注释。
    // `previous.mood` 是导出 API 的入参：旧形状（两层之前的调用方、序列化过的 state）
    // 没有这个字段，缺省退化成「心境=当前情绪」，等价于单层，绝不能让整条情感链抛 TypeError。
    const prevMood = previous.mood ?? previous.vad ?? previous.baseline;
    const layerV = stepTwoLayer(previous.vad.valence, prevMood.valence, previous.baseline.valence, elapsedHours, halfLife.valence * valencePersistence * persistence, tuning.moodHalfLife.valence, tuning.moodRelaxRatio);
    const layerA = stepTwoLayer(previous.vad.arousal, prevMood.arousal, previous.baseline.arousal, elapsedHours, halfLife.arousal * persistence, tuning.moodHalfLife.arousal, tuning.moodRelaxRatio);
    const layerD = stepTwoLayer(previous.vad.dominance, prevMood.dominance, previous.baseline.dominance, elapsedHours, halfLife.dominance * persistence, tuning.moodHalfLife.dominance, tuning.moodRelaxRatio);
    decayed.valence = layerV.vad;
    decayed.arousal = layerA.vad;
    decayed.dominance = layerD.vad;
    const moodNext = { valence: layerV.mood, arousal: layerA.mood, dominance: layerD.mood };
    const seen = new Set(previous.processedEventIds);
    // TypeScript callers are constrained to AppraisalKind, but model adapters
    // and JavaScript callers can still pass arbitrary status strings. An
    // untrusted status must never become affect evidence. `neutral` is an
    // explicit valid observation; `valid` leaves the kind semantics intact.
    const runtimeStatus = typeof appraisal.status === 'string' ? appraisal.status.trim().toLowerCase() : undefined;
    const statusAccepted = runtimeStatus === undefined || runtimeStatus === ''
        || runtimeStatus === 'valid' || runtimeStatus === 'neutral';
    const effectiveKind = runtimeStatus === 'neutral' ? 'neutral' : appraisal.kind;
    const eventId = typeof appraisal.eventId === 'string' ? appraisal.eventId.trim() : '';
    const duplicate = Boolean(eventId && seen.has(eventId));
    const validEvidence = statusAccepted
        && (effectiveKind === 'event' || effectiveKind === 'target' || effectiveKind === 'neutral' || effectiveKind === 'state_neutral');
    const shouldApply = validEvidence && !duplicate;
    // Absolute sensor targets need to cross a band boundary on the first clear
    // reading. Signed event impacts are intentionally slower: they are already
    // deltas around the current state, so applying the target gain to them would
    // make one noisy turn dominate the short-term psyche. Callers can still
    // provide eventGain when a source has its own calibration.
    const gain = clamp(finite(options.eventGain) ?? (effectiveKind === 'target' ? tuning.targetGain : tuning.eventGain), 0, 1);
    const next = { ...decayed };
    if (shouldApply) {
        if (effectiveKind === 'neutral') {
            // `neutral` = 这一轮没有情绪事件（事件层面的零影响），不是「她现在平静」。
            // 它只刷新证据时间、让状态按真实时间继续衰减，绝不改 VAD，也不改 band。
            // 「她现在确实回到基线」要用 state_neutral（状态观测）。
        }
        else if (effectiveKind === 'state_neutral') {
            // 状态观测：她此刻处在人格基线。有界误差更新朝 baseline 走，不是朝 0 走
            // （baseline +0.40 才是她的「正常」，0 是「比平时低不少」）。
            const b = previous.baseline;
            const tv = finite(b.valence), ta = finite(b.arousal), td = finite(b.dominance);
            if (tv !== undefined)
                next.valence = boundedIncrement(next.valence, b.valence, gain * (clamp(tv) - next.valence), tuning);
            if (ta !== undefined)
                next.arousal = boundedIncrement(next.arousal, b.arousal, gain * (clamp(ta) - next.arousal), tuning);
            if (td !== undefined)
                next.dominance = boundedIncrement(next.dominance, b.dominance, gain * (clamp(td) - next.dominance), tuning);
        }
        else if (effectiveKind === 'target') {
            // Model VAD prompts commonly describe the current observed state, not an
            // incremental impact. A bounded error step prevents repeated batches from
            // accumulating the same absolute reading toward a rail.
            const target = appraisal.target || {};
            const b = previous.baseline;
            const targetValence = finite(target.valence);
            const targetArousal = finite(target.arousal);
            const targetDominance = finite(target.dominance);
            if (targetValence !== undefined)
                next.valence = boundedIncrement(next.valence, b.valence, gain * (clamp(targetValence) - next.valence), tuning);
            if (targetArousal !== undefined)
                next.arousal = boundedIncrement(next.arousal, b.arousal, gain * (clamp(targetArousal) - next.arousal), tuning);
            if (targetDominance !== undefined)
                next.dominance = boundedIncrement(next.dominance, b.dominance, gain * (clamp(targetDominance) - next.dominance), tuning);
        }
        else {
            const b = previous.baseline;
            next.valence = boundedIncrement(next.valence, b.valence, gain * (finite(appraisal.delta?.valence) ?? 0), tuning);
            next.arousal = boundedIncrement(next.arousal, b.arousal, gain * (finite(appraisal.delta?.arousal) ?? 0), tuning);
            next.dominance = boundedIncrement(next.dominance, b.dominance, gain * (finite(appraisal.delta?.dominance) ?? 0), tuning);
        }
        if (eventId) {
            seen.add(eventId);
            const max = Math.max(1, Math.floor(options.maxProcessedEvents ?? 128));
            while (seen.size > max) {
                const oldest = previous.processedEventIds.find(id => seen.has(id));
                if (!oldest)
                    break;
                seen.delete(oldest);
            }
        }
    }
    const processedEventIds = [...seen];
    // An absolute target is still observed evidence. Without this branch the
    // Ollama path could move `vad` while callers kept treating the state as
    // sensor-empty and fell back to the unrelated AgentState mood scalar.
    //
    // Evidence also has a shelf life: `updatedAt` follows reads (decay), so it
    // cannot answer "when was the last real observation". Without an expiry the
    // first appraisal owns the visible band forever and AgentState mood never
    // gets the state back, even after days of pure `abstain`.
    const evidenceTtlHours = finite(options.evidenceTtlHours) !== undefined
        ? Math.max(1, Number(options.evidenceTtlHours))
        : Math.max(1, tuning.evidenceTtlHours);
    // -1 means "never observed"; 0 is a legitimate timestamp in tests and replays.
    const evidenceAgeHours = previous.lastEvidenceAt >= 0
        ? (effectiveNow - previous.lastEvidenceAt) / 3600000
        : Number.POSITIVE_INFINITY;
    const evidenceFresh = previous.hasEvidence && evidenceAgeHours <= evidenceTtlHours;
    const observedNow = statusAccepted
        && (effectiveKind === 'event' || effectiveKind === 'target' || effectiveKind === 'neutral');
    const hasEvidence = observedNow || evidenceFresh;
    const lastEvidenceAt = shouldApply ? effectiveNow : previous.lastEvidenceAt;
    const holdNeutralBand = previous.hasEvidence
        && previous.band === 'neutral'
        && effectiveKind === 'no_event';
    // 2026-10-31：只有「状态观测」才允许把 band 直接写成 neutral。
    // 事件级的 `neutral`（这一轮没有情绪事件）不再清零标签 —— 它只是零影响。
    const observedNeutralNow = effectiveKind === 'state_neutral' && shouldApply;
    const duplicateNeutral = (effectiveKind === 'neutral' || effectiveKind === 'state_neutral') && duplicate;
    return {
        version: previous.version + (shouldApply ? 1 : 0),
        hasEvidence,
        lastEvidenceAt,
        // 重要性跟着证据走：只有被采纳的证据才更新它，读/衰减不会改。
        salience: shouldApply && finite(options.salience) !== undefined ? salience : previous.salience,
        baseline: { ...previous.baseline },
        vad: next,
        // 事件只推情绪（快层），心境靠时间沉淀：一次冲击不该让「这一周的心情」瞬间改变。
        mood: moodNext,
        band: hasEvidence
            ? (observedNeutralNow
                ? 'neutral'
                : duplicateNeutral
                    ? previous.band
                    : holdNeutralBand
                        ? 'neutral'
                        : bandFor(next.valence, previous.baseline.valence + tuning.bandCenterOffset, previous.band, tuning.bandEnter, tuning.bandHold))
            : 'neutral',
        updatedAt: effectiveNow,
        processedEventIds,
    };
}
function stateKey(characterId, project) {
    return `${normalizeProject(project)}|${normalizeCharacterId(characterId)}`;
}
function cloneState(state) {
    return {
        ...state,
        baseline: { ...state.baseline },
        vad: { ...state.vad },
        mood: { ...(state.mood ?? state.vad) },
        processedEventIds: [...state.processedEventIds],
    };
}
function parsePersistedStateRow(row) {
    if (!row)
        return null;
    const baseline = {
        valence: clamp(Number(row.baseline_valence)),
        arousal: clamp(Number(row.baseline_arousal)),
        dominance: clamp(Number(row.baseline_dominance)),
    };
    const vad = {
        valence: clamp(Number(row.vad_valence)),
        arousal: clamp(Number(row.vad_arousal)),
        dominance: clamp(Number(row.vad_dominance)),
    };
    // 旧库没有 mood_*（或为 NULL）：心境取人格基线，等价于「从未积累过心情偏离」。
    const moodNum = (value, fallback) => {
        // ⚠️ 必须先挡 NULL/空串再 Number()：`Number(null) === 0` 是**有限值**，直接 Number()
        // 会让升级前的老行（ALTER TABLE 加列后 mood_* 全是 NULL）被读成「心境=0」，
        // 而不是注释承诺的「心境=人格基线」。0 与基线 0.40 差 0.4，等于把老库的整体情绪
        // 往下拽一整档，并通过 deviationMoodScalar 把检索推向负向记忆（评审 P1）。
        if (value === null || value === undefined || value === '')
            return fallback;
        const n = Number(value);
        return Number.isFinite(n) ? clamp(n) : fallback;
    };
    const mood = {
        valence: moodNum(row.mood_valence, baseline.valence),
        arousal: moodNum(row.mood_arousal, baseline.arousal),
        dominance: moodNum(row.mood_dominance, baseline.dominance),
    };
    let processed = [];
    try {
        const parsed = JSON.parse(String(row.processed_event_ids || '[]'));
        if (Array.isArray(parsed))
            processed = parsed.map(String).filter(Boolean).slice(-128);
    }
    catch { /* recover from malformed event history */ }
    const updatedAt = Number(row.updated_at);
    const hasEvidence = Number(row.has_evidence) === 1;
    const storedEvidenceAt = Number(row.last_evidence_at);
    const storedSalience = Number(row.salience);
    return {
        version: Math.max(1, Number(row.version) || 1),
        hasEvidence,
        // Rows written before the column existed still need a usable clock; the
        // persisted `updated_at` only moves on accepted appraisals, so it is the
        // closest available answer.
        lastEvidenceAt: Number.isFinite(storedEvidenceAt) && storedEvidenceAt >= 0
            ? storedEvidenceAt
            : (hasEvidence && Number.isFinite(updatedAt) ? updatedAt : -1),
        salience: Number.isFinite(storedSalience) ? clamp(storedSalience, 0, 1) : 0,
        baseline,
        vad,
        mood,
        band: row.band === 'positive' || row.band === 'negative' ? row.band : 'neutral',
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        processedEventIds: processed,
    };
}
function readPersistedStateFromDb(db, characterId, project) {
    const row = db.prepare(`
    SELECT version, has_evidence, baseline_valence, baseline_arousal, baseline_dominance,
           vad_valence, vad_arousal, vad_dominance,
           mood_valence, mood_arousal, mood_dominance,
           band, updated_at, last_evidence_at, processed_event_ids, salience
    FROM psyche_state WHERE project = ? AND character_id = ?
  `).get(project, characterId);
    return parsePersistedStateRow(row);
}
function readPersistedState(characterId, project) {
    const proj = normalizeProject(project);
    try {
        return { state: readPersistedStateFromDb(DatabaseManager.getInstance(proj, 'general'), characterId, proj), failed: false };
    }
    catch (error) {
        const key = stateKey(characterId, project);
        if (!loadWarnings.has(key)) {
            loadWarnings.add(key);
            console.warn(`[psyche] persisted state load failed for ${key}: ${error?.message || error}`);
        }
        // Keep this retryable. A transient native binding/database-open failure
        // must not permanently pin the process to a fresh in-memory state.
        return { state: null, failed: true };
    }
}
function persistState(characterId, project, state) {
    const proj = normalizeProject(project);
    try {
        DatabaseManager.getInstance(proj, 'general').prepare(`
      INSERT INTO psyche_state (
        project, character_id, version, has_evidence,
        baseline_valence, baseline_arousal, baseline_dominance,
        vad_valence, vad_arousal, vad_dominance,
        mood_valence, mood_arousal, mood_dominance,
        band, updated_at, last_evidence_at, processed_event_ids, salience
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, character_id) DO UPDATE SET
        version = excluded.version,
        has_evidence = excluded.has_evidence,
        baseline_valence = excluded.baseline_valence,
        baseline_arousal = excluded.baseline_arousal,
        baseline_dominance = excluded.baseline_dominance,
        vad_valence = excluded.vad_valence,
        vad_arousal = excluded.vad_arousal,
        vad_dominance = excluded.vad_dominance,
        mood_valence = excluded.mood_valence,
        mood_arousal = excluded.mood_arousal,
        mood_dominance = excluded.mood_dominance,
        band = excluded.band,
        updated_at = excluded.updated_at,
        last_evidence_at = excluded.last_evidence_at,
        processed_event_ids = excluded.processed_event_ids,
        salience = excluded.salience
    `).run(proj, characterId, state.version, state.hasEvidence ? 1 : 0, state.baseline.valence, state.baseline.arousal, state.baseline.dominance, state.vad.valence, state.vad.arousal, state.vad.dominance, state.mood.valence, state.mood.arousal, state.mood.dominance, state.band, state.updatedAt, state.lastEvidenceAt, JSON.stringify(state.processedEventIds), state.salience);
        persistWarnings.delete(stateKey(characterId, project));
        return true;
    }
    catch (error) {
        const key = stateKey(characterId, project);
        if (!persistWarnings.has(key)) {
            persistWarnings.add(key);
            console.warn(`[psyche] persisted state write failed for ${key}: ${error?.message || error}`);
        }
        // Legacy/read-only stores can still use the in-process state path, but the
        // warning makes the loss of restart durability observable.
        return false;
    }
}
/** Process-local sensor state. It is separate from AgentState's explicit moodValue channel. */
export function getPsycheState(characterId, project, now = Date.now()) {
    characterId = normalizeCharacterId(characterId);
    const key = stateKey(characterId, project);
    let state = psycheStates.get(key);
    if (!loadedKeys.has(key)) {
        const candidate = readPersistedState(characterId, project);
        if (candidate.state) {
            state = candidate.state;
            loadedKeys.add(key);
            loadWarnings.delete(key);
        }
        else {
            // Keep an existing in-memory state after a transient load failure, but
            // leave the key unmarked so the next read can retry durability.
            state = state || createPsycheState({}, now);
            if (!candidate.failed)
                loadedKeys.add(key);
        }
        psycheStates.set(key, state);
    }
    if (!state)
        state = createPsycheState({}, now);
    // Decay is observable even when no new event arrives. Keep the decayed value
    // in memory but do not write on every read: context_get/search/reply can all
    // read this path many times per turn. The persisted timestamp remains the
    // last durable event; a later read or event applies the same elapsed decay,
    // so restart behavior stays mathematically equivalent without write
    // amplification.
    if (now > state.updatedAt) {
        state = transitionPsycheState(state, { kind: 'no_event' }, now);
        psycheStates.set(key, state);
    }
    return cloneState(state);
}
/**
 * Append one row per accepted appraisal. Retention is bounded so the history
 * cannot grow without limit inside the general database.
 */
function recordPsycheEvent(db, project, characterId, base, next, appraisal) {
    const retentionDays = Math.max(1, envNumber('PSYCHE_EVENT_RETENTION_DAYS', 90));
    try {
        const eventId = typeof appraisal.eventId === 'string' ? appraisal.eventId : null;
        db.prepare(`
      INSERT INTO psyche_events (
        project, character_id, at, kind, event_id,
        from_valence, from_arousal, from_dominance,
        to_valence, to_arousal, to_dominance,
        baseline_valence, band, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project, characterId, next.updatedAt, String(appraisal.kind || 'unknown'), eventId, base.vad.valence, base.vad.arousal, base.vad.dominance, next.vad.valence, next.vad.arousal, next.vad.dominance, next.baseline.valence, next.band, next.version);
        db.prepare('DELETE FROM psyche_events WHERE project = ? AND character_id = ? AND at < ?')
            .run(project, characterId, Date.now() - retentionDays * 86400000);
    }
    catch (error) {
        // History is observability, not correctness: never fail the transition.
        const key = `${project}|${characterId}`;
        if (!persistWarnings.has(key)) {
            persistWarnings.add(key);
            console.warn(`[psyche] event history write failed for ${key}: ${error?.message || error}`);
        }
    }
}
export function applyPsycheAppraisal(characterId, project, appraisal, now = Date.now(), options = {}) {
    characterId = normalizeCharacterId(characterId);
    const key = stateKey(characterId, project);
    const proj = normalizeProject(project);
    let next = null;
    let persisted = false;
    try {
        // Serialize the complete read/transition/write sequence across processes.
        // Without an IMMEDIATE transaction, two workers can both read version N,
        // apply different events, and let the last upsert erase the first event
        // from both the VAD snapshot and processed_event_ids.
        const db = DatabaseManager.getInstance(proj, 'general');
        db.exec('BEGIN IMMEDIATE');
        try {
            const durable = readPersistedStateFromDb(db, characterId, proj);
            const cached = psycheStates.get(key);
            const base = durable || cached || createPsycheState({}, now);
            next = transitionPsycheState(base, appraisal, now, options);
            db.prepare(`
        INSERT INTO psyche_state (
          project, character_id, version, has_evidence,
          baseline_valence, baseline_arousal, baseline_dominance,
          vad_valence, vad_arousal, vad_dominance,
          mood_valence, mood_arousal, mood_dominance,
          band, updated_at, last_evidence_at, processed_event_ids, salience
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, character_id) DO UPDATE SET
          version = excluded.version,
          has_evidence = excluded.has_evidence,
          baseline_valence = excluded.baseline_valence,
          baseline_arousal = excluded.baseline_arousal,
          baseline_dominance = excluded.baseline_dominance,
          vad_valence = excluded.vad_valence,
          vad_arousal = excluded.vad_arousal,
          vad_dominance = excluded.vad_dominance,
          mood_valence = excluded.mood_valence,
          mood_arousal = excluded.mood_arousal,
          mood_dominance = excluded.mood_dominance,
          band = excluded.band,
          updated_at = excluded.updated_at,
          last_evidence_at = excluded.last_evidence_at,
          processed_event_ids = excluded.processed_event_ids,
          salience = excluded.salience
      `).run(proj, characterId, next.version, next.hasEvidence ? 1 : 0, next.baseline.valence, next.baseline.arousal, next.baseline.dominance, next.vad.valence, next.vad.arousal, next.vad.dominance, next.mood.valence, next.mood.arousal, next.mood.dominance, next.band, next.updatedAt, next.lastEvidenceAt, JSON.stringify(next.processedEventIds), next.salience);
            if (next.version > base.version)
                recordPsycheEvent(db, proj, characterId, base, next, appraisal);
            db.exec('COMMIT');
            persisted = true;
        }
        catch (error) {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* transaction may not have started */ }
            throw error;
        }
    }
    catch (error) {
        // Preserve the old in-process fallback behavior for legacy/read-only
        // stores, while making the durability failure visible to callers that
        // explicitly require it.
        if (!next)
            next = transitionPsycheState(getPsycheState(characterId, project, now), appraisal, now, options);
        const warningKey = stateKey(characterId, project);
        if (!persistWarnings.has(warningKey)) {
            persistWarnings.add(warningKey);
            console.warn(`[psyche] persisted state write failed for ${warningKey}: ${error?.message || error}`);
        }
    }
    psycheStates.set(key, next);
    if (persisted)
        loadedKeys.add(key);
    else {
        loadedKeys.delete(key);
        if (options.requirePersistence) {
            throw new Error(`psyche state persistence failed for ${stateKey(characterId, project)}`);
        }
    }
    return cloneState(next);
}
export function appraisalFromVAD(vad, eventId) {
    if (!vad)
        return { kind: 'unknown', eventId };
    const values = [finite(vad.valence), finite(vad.arousal), finite(vad.dominance)];
    if (values.some(value => value === undefined))
        return { kind: 'invalid', eventId };
    if (values.every(value => Math.abs(value) < 0.05))
        return { kind: 'neutral', eventId };
    return {
        kind: 'event',
        eventId,
        delta: { valence: values[0], arousal: values[1], dominance: values[2] },
    };
}
/** Convert a model's absolute VAD reading into a bounded target appraisal. */
export function targetAppraisalFromVAD(vad, eventId, opts = {}) {
    if (!vad)
        return { kind: 'unknown', eventId };
    const v = finite(vad.valence), a = finite(vad.arousal), d = finite(vad.dominance);
    const provided = [v, a, d].filter(value => value !== undefined);
    // 缺维度默认整条拒收（不把缺失当成 0）。词表这种只对部分维度有证据的传感器
    // 显式传 allowPartial，只有提供的维度参与更新（2026-10-31）。
    if (provided.length === 0)
        return { kind: 'unknown', eventId };
    if (provided.length < 3 && !opts.allowPartial)
        return { kind: 'invalid', eventId };
    if (provided.every(value => Math.abs(value) < 0.05))
        return { kind: 'neutral', eventId };
    const target = {};
    if (v !== undefined)
        target.valence = v;
    if (a !== undefined)
        target.arousal = a;
    if (d !== undefined)
        target.dominance = d;
    return { kind: 'target', eventId, target };
}
//# sourceMappingURL=psycheState.js.map