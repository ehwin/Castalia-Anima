/**
 * Emotion System v6.0 — VAD 3D 情感引擎
 *
 * 基于社区调研（Michaol/ST EchoText/AffectiveRAG）设计：
 *   P0 — VAD 三维连续向量替代标量 emotional_impact
 *   P1 — 差异化半衰期（Verduyn & Lavrijsen 2014 实证）
 *   P2 — 人格基线回归（OU 过程）
 *   补丁 — 傲娇记忆衰减减速（tsundere factor）
 *
 * 情感提取不再用正则 → 全部走 Ollama 本地模型
 */
import { normalizeCharacterId, normalizeProject, CHAR_ID } from './env.js';
import { scoreAffect, affectImpact } from './affectLexicon.js';
import { DatabaseManager } from './db.js';
import { serializeTags } from './tags.js';
// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════
/** Anima 人格基线 — "sharp, resourceful, no-nonsense" */
export const DEFAULT_BASELINE = {
    vad: { valence: 0.4, arousal: 0.3, dominance: 0.6 },
    traits: {
        sharp: { valence: 0, arousal: 0.15, dominance: 0.10 },
        resourceful: { valence: 0.10, arousal: 0, dominance: 0.05 },
        noNonsense: { valence: -0.05, arousal: -0.05, dominance: 0 },
    },
};
/**
 * 记忆 VAD 的衰减时间常数 τ（小时）—— 注意是 τ，不是半衰期。
 * `decayDimension` 用的是 exp(−h/τ)，24h 后剩 e⁻¹≈0.368；真正的半衰期要写 2^(−h/H)。
 *
 * 2026-10-31：撤掉「Verduyn & Lavrijsen 2014」这个依据声明 —— 那篇比较的是不同情绪
 * 经历的持续时间（悲伤最久等），没有给出 V/A/D 三个维度各自的衰减常数。
 * 24/4/36 是产品初值，不是论文常数。
 */
export const DECAY_TAU = {
    valence: 24,
    arousal: 4,
    dominance: 36,
};
/** @deprecated 名字有误导（它是 τ 不是半衰期），仅为兼容保留；新代码用 DECAY_TAU。 */
export const HALF_LIFE = DECAY_TAU;
/**
 * 夜间倍率与傲娇减速：默认**停用**。
 *
 * 反例（可复现）：一条 24h 的旧记忆只因为查询时刻落在 22:00 之后，arousal 就从
 * 2.48e−3 掉到 1.52e−8、dominance 反而从 0.513 升到 0.717 —— 同一段过去被重新解释，
 * 且入夜时支配感突然回升。傲娇减速同理：它让「傲娇浓度」直接决定记忆衰减率，
 * 而人格表达不该等于遗忘速度。
 * 需要复现实验时用 ANIMA_NIGHT_DECAY=1 / ANIMA_TSUNDERE_DECAY=1 显式打开。
 */
const NIGHT_MULTIPLIER = {
    valence: 1.5,
    arousal: 3.0, // 睡眠时激活度大幅下降
    dominance: 0.5, // 支配感在夜间反而不易衰减
};
const NIGHT_DECAY_ENABLED = process.env.ANIMA_NIGHT_DECAY === '1';
/** 傲娇减速因子 — 默认停用，见上。 */
const TSUNDERE_SLOWDOWN_MAX = 0.5; // 最高减速 50%
const TSUNDERE_DECAY_ENABLED = process.env.ANIMA_TSUNDERE_DECAY === '1';
/** @deprecated 未接入（全仓无调用）。保留仅为记录旧的每轮回归实验；按真实时间的恢复走 psycheState.decay。 */
const REGRESSION_RATE = 0.05;
// ═══════════════════════════════════════════════════════════════════
// VAD → Plutchik 映射（KNN 近似）
// ═══════════════════════════════════════════════════════════════════
/**
 * 将 VAD 连续向量映射到 Plutchik 8 离散情绪
 * 使用 Sigmoid 激活 + 阈值近似 KNN
 */
export function vapToPlutchik(vad) {
    const { valence, arousal, dominance } = vad;
    // joy: 高 valence + 中高 arousal
    const joy = sigmoid(valence * 3) * sigmoid(arousal * 2 + 0.5);
    // sadness: 低 valence + 低 arousal
    const sadness = sigmoid(-valence * 3) * sigmoid(-arousal * 2 + 0.5);
    // anger: 低 valence + 高 arousal + 高 dominance
    const anger = sigmoid(-valence * 2.5) * sigmoid(arousal * 2.5) * sigmoid(dominance * 2);
    // fear: 低 valence + 高 arousal + 低 dominance
    const fear = sigmoid(-valence * 2.5) * sigmoid(arousal * 2.5) * sigmoid(-dominance * 2);
    // trust: 高 valence + 低 arousal + 中 dominance
    const trust = sigmoid(valence * 2.5) * sigmoid(-Math.abs(arousal) * 1.5 + 0.5) * sigmoid(dominance);
    // disgust: 低 valence + 中 arousal
    const disgust = sigmoid(-valence * 3) * sigmoid(Math.abs(arousal) * 1.5 - 0.3);
    // surprise: 高 arousal（与 valence 符号无关）
    const surprise = sigmoid(Math.abs(arousal) * 3 - 1.5) * (1 - sigmoid(Math.abs(valence) * 3 - 2));
    // anticipation: 中 valence + 中 arousal + 中高 dominance
    const anticipation = sigmoid(valence * 1.5) * sigmoid(arousal * 1.5) * sigmoid(dominance * 1.5 + 0.3);
    return { joy, trust, fear, surprise, sadness, disgust, anger, anticipation };
}
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}
// ═══════════════════════════════════════════════════════════════════
// 情感衰减（P1: 差异化半衰期 → P1补丁: tsundere 减速）
// ═══════════════════════════════════════════════════════════════════
/**
 * 计算情感衰减 — 从事件发生到现在
 * @param storedVAD    记忆存储时的 VAD
 * @param hoursSince    距离事件发生的小时数
 * @param tsundereLevel 傲娇浓度 [0, 10]
 * @param isNight       是否处于夜间（22:00-06:00）
 */
export function computeDecay(storedVAD, hoursSince, tsundereLevel = 0, isNight = false) {
    if (!storedVAD) {
        return { vad: { valence: 0, arousal: 0, dominance: 0 }, intensity: 0 };
    }
    // 傲娇减速因子：默认停用（见 TSUNDERE_DECAY_ENABLED）
    const tsundereSlowdown = TSUNDERE_DECAY_ENABLED
        ? 1 - TSUNDERE_SLOWDOWN_MAX * (tsundereLevel / 10)
        : 1;
    const nightMult = (dim) => (NIGHT_DECAY_ENABLED && isNight) ? NIGHT_MULTIPLIER[dim] : 1;
    // 计算各维度衰减
    const decayValence = decayDimension(storedVAD.valence, hoursSince, DECAY_TAU.valence, tsundereSlowdown, nightMult('valence'));
    const decayArousal = decayDimension(storedVAD.arousal, hoursSince, DECAY_TAU.arousal, tsundereSlowdown, nightMult('arousal'));
    const decayDominance = decayDimension(storedVAD.dominance, hoursSince, DECAY_TAU.dominance, tsundereSlowdown, nightMult('dominance'));
    const vad = { valence: decayValence, arousal: decayArousal, dominance: decayDominance };
    // 综合强度 = 三维绝对值的归一化均值
    const intensity = Math.min(1, (Math.abs(vad.valence) + Math.abs(vad.arousal) + Math.abs(vad.dominance)) / 3);
    return { vad, intensity };
}
/**
 * 单维度指数衰减
 * E(t) = E0 * exp(-tsundereSlowdown * nightMult * t / halfLife)
 */
function decayDimension(value, hours, halfLife, slowdown, nightMult) {
    if (halfLife <= 0)
        return value;
    const lambda = slowdown * nightMult / halfLife; // 衰减速率
    return value * Math.exp(-lambda * hours);
}
/**
 * 判断当前时间是否夜间（22:00-06:00）
 */
export function isNightTime(now = new Date()) {
    const hour = now.getHours();
    return hour >= 22 || hour < 6;
}
// ═══════════════════════════════════════════════════════════════════
// 人格基线回归（P2: OU 过程）
// ═══════════════════════════════════════════════════════════════════
/**
 * 将当前 VAD 向人格基线回归一步
 * dX = theta(mu - X) * rate
 *
 * @deprecated 全仓无调用（只有一个遗留 import，已于 2026-10-31 移除）。
 * `rate` 是「每次调用」的比例，不是按真实时间的恢复率 —— 调一次算一次会随调用频率
 * 改变衰减速度。按真实时间的恢复请用 psycheState.decay（2^(−dt/H)）。
 * 这个函数还会把「人格基线」和「当前心境」混在一次算术里，正是上一轮报告点名的问题。
 */
export function regressToBaseline(currentVAD, baseline = DEFAULT_BASELINE.vad, rate = REGRESSION_RATE) {
    return {
        valence: currentVAD.valence + rate * (baseline.valence - currentVAD.valence),
        arousal: currentVAD.arousal + rate * (baseline.arousal - currentVAD.arousal),
        dominance: currentVAD.dominance + rate * (baseline.dominance - currentVAD.dominance),
    };
}
// ═══════════════════════════════════════════════════════════════════
// Ollama 本地模型接口（Qwen3.5-2B / 4B 等）
// ═══════════════════════════════════════════════════════════════════
/** Ollama 配置 — 可通过环境变量覆盖 */
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const VAD_MODEL = process.env.VAD_MODEL || 'qwen3.5:2b'; // 默认模型名，待下载完成后更新
const VAD_TIMEOUT_MS = parseInt(process.env.VAD_TIMEOUT_MS || '15000', 10);
class InvalidVadResponseError extends Error {
    code = 'INVALID_VAD_RESPONSE';
}
/**
 * 调用 Ollama 本地模型做 VAD 情感分析
 *
 * Prompt 设计原则（防对齐陷阱）：
 * - LLM 只输出结构化 JSON，不做道德评判
 * - 明确要求检测"表面表达 vs 真实感受"的差异
 * - valence 正负由文本事实决定，不由 LLM 价值判断
 *
 * @param text     待分析文本
 * @param context  可选上下文（前几条对话）
 * @returns VAD 分析结果
 */
export async function ollamaDetectVAD(text, context) {
    const systemPrompt = `You are Anima's interaction-appraisal sensor. Output ONLY valid JSON, no commentary.

Analyze the affective impact of the labelled interaction on Anima's current state,
goals, and relationship using the VAD model. Do not claim to know the user's
private inner emotion; the input may contain both [USER] and [ASSISTANT] turns.
- valence: [-1,1] NUMBER. positive=pleasant, negative=unpleasant. Neutral=0. NEVER output outside [-1,1].
- arousal: [-1,1] NUMBER. high=excited/angry, low=calm/bored. Neutral=0. NEVER output outside [-1,1].
- dominance: [-1,1] NUMBER. high=in_control/confident, low=helpless/overwhelmed. Neutral=0. NEVER output outside [-1,1].

CRITICAL RULES:
1. Neutral/factual or purely procedural interactions → ALL values ≈ 0, confidence high.
2. Values MUST stay strictly within [-1, 1]. If unsure, output 0.
3. tsundere_level is optional and should be 0 unless the interaction itself
   clearly contradicts Anima's observable stance. Do not infer hidden feelings.
4. Tags: ALWAYS in Chinese, 1-5 keywords.

Output JSON:
{
  "vad": {"valence": 0, "arousal": 0, "dominance": 0},
  "tsundere_level": 0,
  "confidence": 0.9,
  "tags": []
}`;
    const userPrompt = context
        ? `Context:\n${context}\n\nAnalyze this message:\n${text}`
        : `Analyze this message:\n${text}`;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VAD_TIMEOUT_MS);
        const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: VAD_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: { temperature: 0.1, num_predict: 256 },
                keep_alive: '5m',
                think: false,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok) {
            throw new Error(`Ollama returned ${resp.status}`);
        }
        let data;
        try {
            data = await resp.json();
        }
        catch {
            throw new InvalidVadResponseError('Invalid JSON response from Ollama');
        }
        const rawContent = data?.message?.content;
        const rawThinking = data?.message?.thinking;
        const content = typeof rawContent === 'string'
            ? rawContent.replace(/```json\n?/g, '').replace(/```/g, '') : '';
        const thinking = typeof rawThinking === 'string' ? rawThinking : '';
        // 提取 JSON（content 优先；reasoning 模型回退 thinking 字段）
        const rawText = content || thinking;
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new InvalidVadResponseError('No JSON found in Ollama response');
        }
        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        }
        catch {
            throw new InvalidVadResponseError('Malformed VAD JSON');
        }
        // Accept the current contract and legacy field names only when the
        // supplied dimensions are already finite and in range. Clamping malformed
        // model output would turn a parser error into trusted affect evidence.
        const tsundereRaw = parsed.tsundere_level;
        const tsundereLevel = tsundereRaw === undefined ? 0 : boundedNumber(tsundereRaw, 0, 10);
        if (tsundereLevel === null)
            throw new InvalidVadResponseError('Invalid tsundere_level');
        const rawVad = parsed.vad || (tsundereLevel > 3 ? parsed.true_vad : parsed.surface_vad) || parsed.true_vad;
        if (!rawVad || typeof rawVad !== 'object' || Array.isArray(rawVad))
            throw new InvalidVadResponseError('Missing vad object');
        const valence = boundedNumber(rawVad.valence, -1, 1);
        const arousal = boundedNumber(rawVad.arousal, -1, 1);
        const dominance = boundedNumber(rawVad.dominance, -1, 1);
        if (valence === null || arousal === null || dominance === null)
            throw new InvalidVadResponseError('Invalid vad dimensions');
        const confidence = parsed.confidence === undefined ? 0.5 : boundedNumber(parsed.confidence, 0, 1);
        if (confidence === null)
            throw new InvalidVadResponseError('Invalid confidence');
        return {
            vad: {
                valence,
                arousal,
                dominance,
            },
            tsundereLevel,
            confidence,
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === 'string').slice(0, 5) : [],
        };
    }
    catch (err) {
        if (err?.code === 'INVALID_VAD_RESPONSE') {
            console.warn('[emotion] Ollama VAD contract failure:', err.message);
            throw err;
        }
        if (err.name === 'AbortError') {
            console.warn('[emotion] Ollama VAD timeout, using fallback');
        }
        else {
            console.warn('[emotion] Ollama VAD failed:', err.message);
        }
        return fallbackVAD(text);
    }
}
/**
 * 回退方案：Ollama 不可用时用简单启发式
 * 只在模型加载失败/超时时使用
 */
/**
 * The offline lexicon has no speaker model. When the live contract carries
 * role labels, score the assistant turn only: a user's self-report such as
 * "我很难过" is not evidence that Anima itself is sad. Legacy unlabeled
 * callers keep the old text-only behavior until they migrate to the labelled
 * queue contract.
 */
function interactionAffectText(text) {
    const raw = String(text || '');
    const assistant = /\[ASSISTANT\]\s*/gi;
    const userOrItem = /\n\s*(?:\[USER\]|\[\d+\])\s*/gi;
    const matches = Array.from(raw.matchAll(assistant));
    if (matches.length === 0)
        return raw;
    const segments = [];
    for (const match of matches) {
        const start = (match.index ?? 0) + match[0].length;
        const remainder = raw.slice(start);
        const boundary = userOrItem.exec(remainder);
        const end = boundary && boundary.index !== undefined ? start + boundary.index : raw.length;
        const segment = raw.slice(start, end).trim();
        if (segment)
            segments.push(segment);
        userOrItem.lastIndex = 0;
    }
    return segments.join('\n');
}
function fallbackVAD(text) {
    const lower = interactionAffectText(text).toLowerCase();
    // 极简启发式 — 只做最安全的基础判断
    const hasPositive = /开心|哈哈|喜欢|爱|好棒|太好了|nice|棒|赞|谢谢|感动|温暖|幸福/.test(lower);
    const hasNegative = /难过|伤心|哭|烦|生气|愤怒|讨厌|恨|崩溃|绝望|焦虑|害怕/.test(lower);
    const hasHighEnergy = /！|!!|啊啊|卧槽|天哪|救命|激动|太.*了/.test(lower);
    const hasLowEnergy = /累|困|疲惫|无力|不想|算了|随便/.test(lower);
    const hasControl = /我来|我知道|我能|我会|听我的|决定/.test(lower);
    const hasNoControl = /没办法|被迫|不得不|随便你|由你/.test(lower);
    return {
        vad: {
            valence: hasPositive ? 0.4 : (hasNegative ? -0.4 : 0),
            arousal: hasHighEnergy ? 0.5 : (hasLowEnergy ? -0.4 : 0),
            dominance: hasControl ? 0.4 : (hasNoControl ? -0.4 : 0),
        },
        tsundereLevel: 0, // fallback 不判断傲娇
        confidence: 0.3, // 低置信度标记
        tags: [],
    };
}
function boundedNumber(value, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function numberOr(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function clamp(v, min, max) {
    const n = Number.isFinite(v) ? v : 0;
    return Math.max(min, Math.min(max, n));
}
// ═══════════════════════════════════════════════════════════════════
// 新增：拆三维 — baseIntensity / recency / decayedIntensity
// ═══════════════════════════════════════════════════════════════════
/**
 * 计算原始 VAD 幅度 — 事件本身的情绪烈度，永不变
 * baseIntensity = (|v| + |a| + |d|) / 3
 */
export function computeBaseIntensity(storedVAD) {
    if (!storedVAD)
        return 0;
    return Math.min(1, (Math.abs(storedVAD.valence) + Math.abs(storedVAD.arousal) + Math.abs(storedVAD.dominance)) / 3);
}
/**
 * 纯时间衰减因子 — 不涉及情感维度，只代表"这件事有多新鲜"。
 * 近因权重：exp(−h/τ)。参数是**时间常数 τ**，不是半衰期（半衰期要 2^(−h/H)）。
 * 默认沿用 dominance 的 36h 只是因为历史上就这么取，不代表「支配感 = 可提取性」。
 */
export function computeRecency(hoursSince, tauHours = DECAY_TAU.dominance) {
    return Math.exp(-hoursSince / tauHours);
}
// ═══════════════════════════════════════════════════════════════════
// 格式化输出 — 供 prompt 注入
// ═══════════════════════════════════════════════════════════════════
/** 将 VAD 分析转为可注入 prompt 的文本 */
export function formatVADForPrompt(analysis) {
    const { vad, tsundereLevel, confidence } = analysis;
    const plutchik = vapToPlutchik(vad);
    const dominant = Object.entries(plutchik)
        .filter(([, v]) => v > 0.3)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([k]) => k)
        .join(', ');
    return [
        `[Current emotion] ${dominant || 'calm'} (v=${vad.valence.toFixed(2)} a=${vad.arousal.toFixed(2)} d=${vad.dominance.toFixed(2)})`,
        tsundereLevel > 3 ? `WARNING tsundere mode (level=${tsundereLevel}/10) — surface words may contradict true feelings` : '',
        confidence < 0.5 ? '(low confidence)' : '',
    ].filter(Boolean).join(' ');
}
// ═══════════════════════════════════════════════════════════════════
// VAD 异步队列 — 批量分析，不阻塞消息管道
// ═══════════════════════════════════════════════════════════════════
/** 队列配置 */
const VAD_QUEUE_MAX_SIZE = 15;
const VAD_QUEUE_MIN_BATCH = 5;
const VAD_QUEUE_MAX_AGE_MS = 10 * 60 * 1000;
const EMOTION_SMOOTH_ALPHA = 0.3;
const VAD_TURN_MAX_CHARS = 2400;
let vadQueue = [];
let lastFlushTime = 0;
// Avoid concurrent consumers taking the same snapshot and issuing duplicate
// model requests. New entries queued while a flush is running remain pending
// for the next flush.
// A scoped flush and an unscoped `*` flush can overlap and consume the same
// queue. Use one process-wide single-flight key; correctness matters more than
// allowing two model requests to run at once.
const vadFlushInFlight = new Map();
/** 平滑状态按 project 分区：A 项目的情绪不该被 B 项目的对话带动。 */
const smoothedByProject = new Map();
function smoothedKey(project, characterId = CHAR_ID) {
    return `${normalizeProject(project)}|${normalizeCharacterId(characterId)}`;
}
function smoothedFor(project, characterId = CHAR_ID) {
    const proj = normalizeProject(project);
    const key = smoothedKey(proj, characterId);
    let s = smoothedByProject.get(key);
    if (!s) {
        s = { vad: { ...DEFAULT_BASELINE.vad }, tsundere: 0 };
        smoothedByProject.set(key, s);
    }
    return s;
}
/** Stable role-labelled evidence for the interaction sensor. */
export function formatInteractionForVad(userMessage, assistantMessage) {
    const clip = (value) => {
        const text = String(value || '').trim();
        if (text.length <= VAD_TURN_MAX_CHARS)
            return text;
        const head = Math.floor(VAD_TURN_MAX_CHARS * 0.75);
        const tail = VAD_TURN_MAX_CHARS - head;
        return `${text.slice(0, head)}\n…[截断 ${text.length - VAD_TURN_MAX_CHARS} 字符]…\n${text.slice(-tail)}`;
    };
    return `[USER]\n${clip(userMessage)}\n[ASSISTANT]\n${clip(assistantMessage)}`.trim();
}
/**
 * Rebuild the role-labelled sensor contract from a persisted conversation row.
 * The durable log keeps the human-readable `用户:/助手:` form, while the live
 * enqueue path uses `[USER]/[ASSISTANT]`; recovery must keep that prompt shape
 * stable across restarts.
 */
export function formatStoredConversationForVad(text) {
    const raw = String(text || '').trim();
    if (!raw)
        return '';
    if (raw.startsWith('[USER]\n'))
        return raw;
    const withoutMood = raw.replace(/^\[mood:[^\n]*\]\s*\n?/, '');
    const userPrefix = '用户: ';
    if (!withoutMood.startsWith(userPrefix))
        return raw;
    const body = withoutMood.slice(userPrefix.length);
    const assistantName = (process.env.CASTALIA_ASSISTANT_NAME || '助手').trim() || '助手';
    const assistantPrefix = `\n${assistantName}: `;
    let assistantAt = body.indexOf(assistantPrefix);
    let assistantPrefixLength = assistantPrefix.length;
    // The assistant display name is configurable and may change between the
    // write process and a later recovery.  A bounded line-label fallback keeps
    // that restart path role-safe without treating arbitrary inline colons as a
    // speaker boundary.
    if (assistantAt < 0) {
        const fallback = body.match(/\n[^\r\n:]{1,64}: /);
        if (fallback && fallback.index !== undefined) {
            assistantAt = fallback.index;
            assistantPrefixLength = fallback[0].length;
        }
    }
    if (assistantAt < 0)
        return formatInteractionForVad(body, '');
    return formatInteractionForVad(body.slice(0, assistantAt), body.slice(assistantAt + assistantPrefixLength));
}
export function queueForVad(text, project, memoryId, characterId, queuedAt) {
    const proj = normalizeProject(project);
    const cid = normalizeCharacterId(characterId);
    // VAD is an evidence channel for raw conversation rows only. Keep this
    // boundary at the public queue entry as well as at recovery/flush, so a
    // caller cannot accidentally feed a self-cycle diary or another memory
    // type into the psyche state machine.
    if (!memoryId) {
        // A text-only item has no durable provenance and cannot be safely matched
        // back to a row after concurrency or restart.
        console.warn('[emotion] VAD queue rejected entry without memoryId');
        return;
    }
    if (memoryId) {
        try {
            const row = DatabaseManager.getInstance(proj).prepare(`
        SELECT source, is_active, character_id
        FROM memory
        WHERE id = ? AND project = ?
      `).get(memoryId, proj);
            if (!row || Number(row.is_active) !== 1 || row.source !== 'conversation_log'
                || String(row.character_id || '').trim() !== cid) {
                console.warn(`[emotion] VAD queue rejected non-conversation memory: ${String(memoryId).slice(0, 16)}`);
                return;
            }
        }
        catch (e) {
            // Fail closed when an id was supplied: an unverified row must never
            // become affect evidence. Callers can retry after the store is ready.
            console.warn('[emotion] VAD queue validation failed:', e?.message || e);
            return;
        }
    }
    // Multiple adapters may observe the same saved turn (for example
    // auto_process followed by a legacy classifyMessage call). Keep one queue
    // pointer per durable evidence row so the model and psyche sensor do not do
    // duplicate work.
    if (vadQueue.some(entry => entry.project === proj
        && entry.memoryId === memoryId
        && (entry.characterId || CHAR_ID) === cid))
        return;
    const timestamp = Number.isFinite(Number(queuedAt)) ? Number(queuedAt) : Date.now();
    const entry = { text, timestamp, project: proj };
    if (memoryId)
        entry.memoryId = memoryId;
    if (characterId && String(characterId).trim())
        entry.characterId = cid;
    vadQueue.push(entry);
    // 只按本项目的待处理条数触发自动 flush，避免被别的项目撑爆
    const pending = vadQueue.filter(q => q.project === proj).length;
    if (pending >= VAD_QUEUE_MAX_SIZE) {
        flushVadQueue(proj, { force: true }).catch(e => console.warn('[emotion] auto-flush failed:', e.message));
    }
}
let localAffectWarned = false;
function requeueVadEntries(entries) {
    if (entries.length === 0)
        return;
    const existing = new Set(vadQueue);
    const retry = entries.filter(entry => !existing.has(entry));
    if (retry.length > 0)
        vadQueue = [...retry, ...vadQueue];
}
/**
 * Validate the durable boundary before consuming a disposable queue pointer.
 * A missing/deactivated row is stale and may be dropped; a database error is
 * retryable and must never be mistaken for a stale row.
 */
function validateVadEntry(entry) {
    if (!entry.memoryId)
        return 'stale';
    try {
        const row = DatabaseManager.getInstance(entry.project).prepare(`
      SELECT source, is_active, character_id
      FROM memory
      WHERE id = ? AND project = ?
    `).get(entry.memoryId, entry.project);
        const expectedCharacterId = normalizeCharacterId(entry.characterId);
        return !!row
            && Number(row.is_active) === 1
            && row.source === 'conversation_log'
            && normalizeCharacterId(row.character_id) === expectedCharacterId
            ? 'valid'
            : 'stale';
    }
    catch {
        // The row may still be valid. Keep the pointer so a transient SQLite or
        // connection failure can be retried after the database is available.
        return 'retry';
    }
}
/**
 * 消费 VAD 队列（按 project 分组，不同 project 永不进同一批 prompt）。
 * - 传 project：只处理该项目的分组；默认立即处理，opts.force=false 时才应用
 *   “攒够 5 条或最老 10 分钟”的批量阈值（digest 周期调用走这条）。
 * - 不传 project：显式全量 flush，逐组分析；管理/测试入口。
 */
/**
 * 离线兜底:按词表给每条记忆打 VAD 并写库(只在 ollamaDetectVAD 不可用时调用)。
 *
 * 实测背景:default bank 262 条活跃记忆里 0 条有 vad_valence —— 唯一来源是 Ollama,
 * 而本机没跑 Ollama,于是情感维度整体空转。词表兜底的目标是"让争吵和吃了面分开";
 * confidence 故意压低(0.25~0.75),不与模型结果混淆。
 */
export function tagWithLocalAffect(entries, project, characterId = CHAR_ID) {
    const proj = normalizeProject(project);
    const db = DatabaseManager.getInstance(proj);
    let updated = 0;
    const stmt = db.prepare(`UPDATE memory SET character_id = ?, vad_valence = ?, vad_arousal = ?, vad_dominance = ?,
      emotional_impact = CASE WHEN COALESCE(emotional_impact, 0) = 0 THEN ? ELSE emotional_impact END,
      tags = CASE WHEN tags IS NULL OR tags = '[]' THEN ? ELSE tags END,
      affect_status = 'pending', affect_analyzed_at = ?, affect_source = 'local_lexicon'
      WHERE id = ? AND project = ? AND character_id = ?
        AND source = 'conversation_log' AND is_active = 1`);
    const abstain = db.prepare(`UPDATE memory SET character_id = ?, affect_status = 'abstain', affect_analyzed_at = ?, affect_source = 'local_lexicon'
      WHERE id = ? AND project = ? AND character_id = ?
        AND source = 'conversation_log' AND is_active = 1`);
    const writeAll = db.transaction(() => {
        for (const e of entries) {
            if (!e.memoryId)
                continue;
            const sc = scoreAffect(interactionAffectText(e.text));
            if (sc.confidence <= 0) {
                try {
                    const r = abstain.run(characterId, new Date().toISOString(), e.memoryId, proj, characterId);
                    if (r.changes > 0)
                        updated++;
                }
                catch (err) {
                    console.warn('[emotion] local affect abstain write failed:', err.message);
                    throw err;
                }
                continue;
            }
            const tags = JSON.stringify(sc.matched.slice(0, 3));
            try {
                const r = stmt.run(characterId, sc.valence, sc.arousal, sc.dominance, affectImpact(sc), tags, new Date().toISOString(), e.memoryId, proj, characterId);
                if (r.changes > 0)
                    updated++;
            }
            catch (err) {
                console.warn('[emotion] local affect write failed:', err.message);
                // The queue entry was removed before this write. Propagate the failure
                // so flushVadQueue can put the current batch back for a later retry.
                throw err;
            }
        }
    });
    writeAll();
    return updated;
}
/**
 * Mark the rows whose affect analysis has landed (VAD + impact written).
 * Conversation-log rows enter the queue as `pending`; the local lexicon
 * fallback commits them here, the model path writes `analyzed` directly.
 */
export function markAffectAnalyzed(entries, project, characterId = CHAR_ID) {
    const ids = Array.from(new Set(entries.map(entry => entry.memoryId).filter(Boolean)));
    if (ids.length === 0)
        return 0;
    const proj = normalizeProject(project);
    const db = DatabaseManager.getInstance(proj);
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`
    UPDATE memory SET affect_status = 'analyzed', affect_analyzed_at = COALESCE(affect_analyzed_at, ?)
    WHERE id IN (${placeholders}) AND project = ? AND character_id = ?
      AND source = 'conversation_log' AND is_active = 1 AND affect_status = 'pending'
  `).run(new Date().toISOString(), ...ids, proj, characterId);
    return result.changes;
}
export function summarizeLocalAffect(entries) {
    let count = 0;
    let valence = 0;
    let arousal = 0;
    let dominance = 0;
    for (const entry of entries) {
        const score = scoreAffect(interactionAffectText(entry.text));
        if (score.confidence <= 0)
            continue;
        valence += score.valence;
        arousal += score.arousal;
        dominance += score.dominance;
        count++;
    }
    if (count === 0)
        return null;
    return {
        valence: valence / count,
        arousal: arousal / count,
        dominance: dominance / count,
    };
}
async function flushVadQueueInternal(project, opts = {}) {
    if (vadQueue.length === 0)
        return { analysis: null, updated: 0, batches: 0, source: 'none' };
    const scoped = typeof project === 'string' && project.trim().length > 0;
    const target = scoped ? normalizeProject(project) : null;
    const now = Date.now();
    const groups = new Map();
    for (const entry of vadQueue) {
        if (target !== null && entry.project !== target)
            continue;
        // Never aggregate evidence from different characters into one state
        // transition. The model batch can still be shared per character/project.
        const groupKey = `${entry.project}|${normalizeCharacterId(entry.characterId)}`;
        const list = groups.get(groupKey) || [];
        list.push(entry);
        groups.set(groupKey, list);
    }
    if (groups.size === 0)
        return { analysis: null, updated: 0, batches: 0, source: 'none' };
    // 显式调用 flush = 立即处理；只有 digest 显式传 force:false 才保留批量阈值。
    const force = opts.force !== false;
    const batches = [];
    const stale = new Set();
    for (const [groupKey, entries] of groups) {
        const [proj, rawCharacterId = CHAR_ID] = groupKey.split('|');
        const characterId = normalizeCharacterId(rawCharacterId);
        let validationRetry = false;
        const verified = entries.filter(entry => {
            const status = validateVadEntry(entry);
            if (status === 'stale')
                stale.add(entry);
            if (status === 'retry')
                validationRetry = true;
            return status === 'valid';
        });
        if (validationRetry) {
            // Nothing has been removed from vadQueue yet. Abort before taking any
            // batch so every entry remains available for the next flush attempt.
            throw new Error(`VAD queue validation temporarily unavailable for ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
        }
        if (verified.length === 0)
            continue;
        const oldestAge = now - Math.min(...verified.map(e => e.timestamp));
        if (!force && verified.length < VAD_QUEUE_MIN_BATCH && oldestAge < VAD_QUEUE_MAX_AGE_MS)
            continue;
        // Drop stale pointers. They must not be requeued forever and must never
        // become affect evidence after a source row changed underneath the queue.
        //
        // Psyche advances once per batch, and the model is asked for a SINGLE VAD
        // across the whole batch. One batch of 15 turns therefore collapsed 15
        // utterances into one state step, so a single cutting remark was averaged
        // away by its neighbours. Split the verified rows into bounded appraisal
        // chunks instead: 15 turns become at most ceil(15/chunk) transitions.
        const chunkSize = Math.max(1, Math.min(VAD_QUEUE_MAX_SIZE, Number.parseInt(process.env.VAD_APPRAISAL_CHUNK || '3', 10) || 3));
        for (let i = 0; i < verified.length; i += chunkSize) {
            batches.push({ project: proj, characterId, entries: verified.slice(i, i + chunkSize) });
        }
    }
    if (batches.length === 0) {
        if (stale.size > 0)
            vadQueue = vadQueue.filter(entry => !stale.has(entry));
        return { analysis: null, updated: 0, batches: 0, source: 'none' };
    }
    // 只摘掉本次真正要处理的条目；未达阈值/别的项目的条目留在队列里
    const taken = new Set();
    for (const b of batches)
        for (const e of b.entries)
            taken.add(e);
    vadQueue = vadQueue.filter(e => !taken.has(e) && !stale.has(e));
    lastFlushTime = now;
    let lastResult = null;
    let processed = 0;
    let usedLocal = false;
    let usedOllama = false;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        try {
            const lines = batch.entries.map((q, i) => '[' + (i + 1) + '] ' + q.text).join('\n');
            const batchText = 'Analyze the interaction appraisal across these ' + batch.entries.length
                + ' recent messages:\n' + lines
                + '\n\nEach item is role-labelled evidence. Estimate how this interaction affects Anima\'s goals and relationship, not the user\'s private inner emotion. Output a SINGLE VAD and tsundere_level representing the current interaction state; omit VAD when there is no reliable affect evidence.';
            // Ollama 不可用时 ollamaDetectVAD **不抛错**,而是返回 confidence≈0 的默认值
            // (实测日志:"[emotion] Ollama VAD failed: fetch failed");旧代码随后 `confidence<0.3 → continue`
            // 就静默跳过了 —— 这正是 default bank 262 条记忆 0 条 VAD 的直接原因。所以两条路都要兜底。
            let result = null;
            try {
                result = await ollamaDetectVAD(batchText);
            }
            catch (e) {
                if (e?.code === 'INVALID_VAD_RESPONSE')
                    throw e;
                result = null;
                if (!localAffectWarned)
                    console.warn('[emotion] Ollama VAD 抛错:', e.message);
            }
            // 注意:ollamaDetectVAD 失败时返回 fallbackVAD,它的 confidence **正好是 0.3**,
            // 而下面原来的 `confidence < 0.3` 判不到它 —— 于是继续调用 batchClassifyAndTag(第二次 Ollama),
            // 再失败一次,整批静默丢弃。这就是 0 条 VAD 的完整链路。用 <= 0.35 把它接住。
            if (!result || result.confidence <= 0.35) {
                if (!localAffectWarned) {
                    console.warn('[emotion] Ollama 不可用或置信度过低,改用本地情感词表兜底(只影响 VAD,不改其他字段)');
                    localAffectWarned = true;
                }
                const updatedForBatch = tagWithLocalAffect(batch.entries, batch.project, batch.characterId);
                processed += updatedForBatch;
                if (updatedForBatch === 0) {
                    const validation = batch.entries.map(entry => validateVadEntry(entry));
                    if (validation.includes('retry') || validation.includes('valid')) {
                        throw new Error('VAD local fallback wrote no rows while queued conversation evidence remains retryable');
                    }
                }
                usedLocal = true;
                if (updatedForBatch > 0)
                    markAffectAnalyzed(batch.entries, batch.project, batch.characterId);
                continue;
            }
            lastResult = result;
            usedOllama = true;
            if (result.confidence < 0.3)
                continue;
            const smoothed = smoothedFor(batch.project, batch.characterId);
            smoothed.vad = {
                valence: smoothed.vad.valence + EMOTION_SMOOTH_ALPHA * (result.vad.valence - smoothed.vad.valence),
                arousal: smoothed.vad.arousal + EMOTION_SMOOTH_ALPHA * (result.vad.arousal - smoothed.vad.arousal),
                dominance: smoothed.vad.dominance + EMOTION_SMOOTH_ALPHA * (result.vad.dominance - smoothed.vad.dominance),
            };
            smoothed.tsundere = smoothed.tsundere + EMOTION_SMOOTH_ALPHA * (result.tsundereLevel - smoothed.tsundere);
            // 批量分类 + 回写标签/VAD 到每条消息。必须 await：调用方 flush 完就能读到更新。
            const updatedForBatch = await batchClassifyAndTag(batch.entries, batch.project, batch.characterId, result.vad);
            processed += updatedForBatch;
            if (updatedForBatch === 0) {
                // A row can change between preflight validation and the SQLite UPDATE.
                // If it is still a valid conversation row, a zero-change write is a
                // transient race or storage failure; retain the pointer for retry.
                const retryEntries = batch.entries.filter(entry => validateVadEntry(entry) === 'valid');
                if (retryEntries.length > 0) {
                    throw new Error(`VAD batch wrote no rows while ${retryEntries.length} conversation entr${retryEntries.length === 1 ? 'y remains' : 'ies remain'} valid`);
                }
            }
        }
        catch (e) {
            // All batches were removed before processing. Put this and later batches
            // back so a transient model/database failure is retryable.
            requeueVadEntries(batches.slice(batchIndex).flatMap(item => item.entries));
            throw e;
        }
    }
    if (processed > 0) {
        console.warn(`[emotion] VAD flush: ${batches.length} project batch(es), ${processed} memories tagged`);
    }
    return {
        analysis: lastResult,
        updated: processed,
        batches: batches.length,
        source: usedLocal && usedOllama ? 'mixed' : usedLocal ? 'local' : usedOllama ? 'ollama' : 'none',
    };
}
/**
 * Serialize queue consumers. The returned promise is shared by concurrent
 * callers, so only one flush can take entries and call the model at a time.
 */
export function flushVadQueueDetailed(project, opts = {}) {
    const key = '*';
    const existing = vadFlushInFlight.get(key);
    // Keep callers' scopes intact. A project B flush arriving while project A
    // is running must wait for A, then run its own pass; returning A's Promise
    // would report success while leaving B's entries pending indefinitely.
    const task = existing
        ? existing.catch(() => undefined).then(() => flushVadQueueInternal(project, opts))
        : flushVadQueueInternal(project, opts);
    let tracked;
    tracked = task.finally(() => {
        if (vadFlushInFlight.get(key) === tracked)
            vadFlushInFlight.delete(key);
    });
    vadFlushInFlight.set(key, tracked);
    return tracked;
}
/** Rebuild the disposable in-memory queue from rows left pending by a restart. */
export function recoverPendingVadQueue(project, characterId = CHAR_ID) {
    const proj = normalizeProject(project);
    characterId = normalizeCharacterId(characterId);
    const db = DatabaseManager.getInstance(proj);
    const rows = db.prepare(`
    SELECT id, text, created_at, character_id FROM memory
    WHERE source = 'conversation_log' AND project = ?
      AND character_id = ?
      AND is_active = 1
      AND (affect_status = 'pending' OR (affect_status IS NULL AND vad_valence IS NULL))
    ORDER BY created_at ASC, rowid ASC
  `).all(proj, characterId || CHAR_ID);
    let added = 0;
    for (const row of rows) {
        if (vadQueue.some(entry => entry.project === proj && entry.memoryId === row.id))
            continue;
        const timestamp = Date.parse(String(row.created_at || ''));
        const rowCharacterId = normalizeCharacterId(row.character_id || characterId);
        queueForVad(formatStoredConversationForVad(String(row.text || '')), proj, String(row.id), rowCharacterId, timestamp);
        added++;
    }
    return added;
}
/** Backwards-compatible view used by older callers that only need the model analysis. */
export function flushVadQueue(project, opts = {}) {
    return flushVadQueueDetailed(project, opts).then(result => result.analysis);
}
export function getSmoothedVAD(project, characterId = CHAR_ID) {
    const s = smoothedFor(project, characterId);
    return {
        vad: { ...s.vad },
        tsundereLevel: Math.round(s.tsundere),
    };
}
export function vadQueueStatus(project, characterId) {
    const now = Date.now();
    const scoped = typeof project === 'string' && project.trim().length > 0;
    const scopedCharacter = characterId === undefined ? undefined : normalizeCharacterId(characterId);
    const pending = vadQueue.filter(q => (!scoped || q.project === normalizeProject(project))
        && (scopedCharacter === undefined || normalizeCharacterId(q.characterId) === scopedCharacter));
    const oldest = pending.reduce((min, entry) => Math.min(min, entry.timestamp), now);
    const s = smoothedFor(scoped ? project : undefined, scopedCharacter || CHAR_ID);
    const ts = Math.round(s.tsundere);
    return {
        size: pending.length,
        oldestAgeSec: Math.round((now - oldest) / 1000),
        smoothed: 'v=' + s.vad.valence.toFixed(2) + ' a=' + s.vad.arousal.toFixed(2) + ' tsun=' + ts,
    };
}
// ═══════════════════════════════════════════════════════════════════
// Ollama 分类 — tier/category/importance/tags — 替代结构正则
// ═══════════════════════════════════════════════════════════════════
/**
 * 启发式默认分类 — O(1)，0ms，Ollama 不可用时的回退
 * 短消息 → temporary，其他 → standard
 */
export function fallbackClassify(text) {
    const len = text.length;
    if (len < 8) {
        return { tier: 'temporary', category: 'general', importance: 0.2, tags: [] };
    }
    if (len < 30) {
        return { tier: 'standard', category: 'general', importance: 0.4, tags: [] };
    }
    return { tier: 'standard', category: 'general', importance: 0.5, tags: [] };
}
/**
 * 用 Ollama 分类一条消息 — 返回 tier + category + importance + tags
 * 供 digest 周期调用（可以等 5s）
 */
export async function ollamaClassify(text) {
    const systemPrompt = 'You are a memory classifier. Classify this message by its content type and importance.\n' +
        'tier: "temporary" (trivial/small talk/greetings), "standard" (normal conversation), "critical" (identity info/milestones/strong relationship signals)\n' +
        'category: "identity"|"milestone"|"emotional"|"knowledge"|"preference"|"plan"|"relationship"|"general"\n' +
        'importance: 0-1 number\n' +
        'tags: 1-5 Chinese keywords.\n' +
        'Output ONLY JSON: {"tier":"standard","category":"general","importance":0.5,"tags":["标签1"],"confidence":0.9}';
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch((process.env.OLLAMA_URL || 'http://127.0.0.1:11434') + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: process.env.VAD_MODEL || 'qwen3.5:2b',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: 'Classify: ' + text },
                ],
                stream: false,
                options: { temperature: 0.1, num_predict: 128 },
                keep_alive: '5m',
                think: false,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok)
            throw new Error('Ollama ' + resp.status);
        const data = await resp.json();
        const content = data.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            throw new Error('No JSON');
        const parsed = JSON.parse(jsonMatch[0]);
        const validCategories = ['identity', 'milestone', 'emotional', 'knowledge', 'preference', 'plan', 'relationship', 'general'];
        const importance = clamp(numberOr(parsed.importance, 0.5), 0, 1);
        // 从 importance 推导 tier — 确定性规则，不由 LLM 判断
        const tier = importance >= 0.7 ? 'critical' : (importance <= 0.3 ? 'temporary' : 'standard');
        return {
            tier,
            category: validCategories.includes(parsed.category) ? parsed.category : 'general',
            importance,
            tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
            confidence: clamp(numberOr(parsed.confidence, 0.5), 0, 1),
        };
    }
    catch (e) {
        console.warn('[emotion] ollamaClassify failed:', e.message);
        return { ...fallbackClassify(text), confidence: 0.3, tier: 'standard', category: 'general' };
    }
}
// ═══════════════════════════════════════════════════════════════════
// 批量分类 — 一次 Ollama 调用处理 N 条消息，结果回写 DB
// ═══════════════════════════════════════════════════════════════════
/** 把模型返回的 vad 对象解析成严格 [-1,1] 三维；越界或缺字段视为未提供 VAD。 */
function parseVadResult(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const nums = [raw.valence, raw.arousal, raw.dominance].map((v) => {
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
            return Number(v);
        return null;
    });
    if (nums.some(n => n === null))
        return null;
    // Model output is untrusted. An out-of-range scalar is invalid evidence,
    // not a value to silently turn into a boundary value by clamping.
    if (nums.some(n => Math.abs(n) > 1))
        return null;
    return {
        valence: nums[0],
        arousal: nums[1],
        dominance: nums[2],
    };
}
/**
 * 一批消息 → 一条 Ollama prompt → N 个分类结果。
 * 回写按 memoryId 精确 UPDATE；没有 id 的条目才回退到“本项目 + created_at DESC”的位置对齐。
 * 模型返回 vad 时同时写入 vad_valence/arousal/dominance（clamp 到 [-1,1]，与 search.ts 读取约定一致）。
 */
export async function batchClassifyAndTag(entries, project, characterId, fallbackVad) {
    if (entries.length === 0)
        return 0;
    const proj = normalizeProject(project);
    // A batch writes one character partition. Reject mixed-character input
    // instead of allowing the first entry's character to scope all updates.
    const requestedCharacter = characterId === undefined ? undefined : normalizeCharacterId(characterId);
    const entryCharacters = new Set(entries.map(entry => normalizeCharacterId(entry.characterId || requestedCharacter)));
    if (entryCharacters.size > 1 || (requestedCharacter !== undefined && [...entryCharacters].some(id => id !== requestedCharacter))) {
        throw new Error('Batch classification cannot mix character partitions');
    }
    const systemPrompt = 'Classify each numbered message. For EACH, output: importance (0-1), category, tags (Chinese), and vad.\n' +
        'importance: identity/job/name → 0.8+. milestones/promises → 0.7+. preferences/knowledge → 0.4-0.6. trivial → 0.1-0.3.\n' +
        'category: identity|milestone|emotional|knowledge|preference|plan|relationship|general\n' +
        'vad: {"valence":-1..1,"arousal":-1..1,"dominance":-1..1} — interaction appraisal for Anima from THAT role-labelled turn, not a claim about the user\'s private emotion; omit "vad" entirely if you cannot judge it.\n' +
        'Output ONLY a JSON array, one object per message: [{"importance":0.8,"category":"identity","tags":["标签1"],"vad":{"valence":0.4,"arousal":0.2,"dominance":0.1}}, ...]';
    const lines = entries.map((e, i) => '[' + (i + 1) + '] ' + e.text).join('\n');
    const userPrompt = 'Classify each message:\n' + lines;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch((process.env.OLLAMA_URL || 'http://127.0.0.1:11434') + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: process.env.VAD_MODEL || 'qwen3.5:2b',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: { temperature: 0.1, num_predict: 1024 },
                keep_alive: '5m',
                think: false,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok)
            throw new Error('Ollama ' + resp.status);
        const data = await resp.json();
        const content = data.message?.content || '';
        const jsonMatch = content.trim().match(/\[[\s\S]*\]/);
        if (!jsonMatch)
            throw new Error('No JSON array');
        let results;
        try {
            results = JSON.parse(jsonMatch[0]);
        }
        catch (parseErr) {
            // 修复常见 JSON 错误：缺逗号、多余空白、未闭合等
            let fixed = jsonMatch[0]
                .replace(/}\s*{/g, '},{') // 对象间缺逗号
                .replace(/,\s*}/g, '}') // 尾随逗号
                .replace(/,\s*\]/g, ']') // 数组尾随逗号
                .replace(/\]\s*$/g, ']'); // 确保闭合
            try {
                results = JSON.parse(fixed);
            }
            catch (e2) {
                console.warn('[emotion] batchClassify JSON parse error:', e2.message, 'raw:', jsonMatch[0].substring(0, 200));
                throw new Error('Invalid batch classification JSON: ' + e2.message);
            }
        }
        if (!Array.isArray(results))
            throw new Error('Not an array');
        // A short response would otherwise mark the missing queue entries as
        // consumed. Treat both short and overlong responses as a failed batch so
        // flushVadQueue can requeue the entire batch for a later retry.
        if (results.length !== entries.length) {
            throw new Error(`Expected ${entries.length} classification results, got ${results.length}`);
        }
        const validCategories = ['identity', 'milestone', 'emotional', 'knowledge', 'preference', 'plan', 'relationship', 'general'];
        // 导入 DB 模块回写；conversation_log 落在项目的 general 库
        let { DatabaseManager } = await import('./db.js');
        const db = DatabaseManager.getInstance(proj);
        // ── 没有 memoryId 的条目：仅作为旧调用方的兜底，按“本项目 + created_at DESC”位置对齐。
        // 队列顺序是旧→新，而 SQL 是 DESC（新→旧），所以先把无 id 条目按 timestamp 倒序再配对，
        // 避免整体错位一条。有 id 的条目绝不走这条路径（审计第 1 组要求 c）。
        const noId = entries
            .map((entry, index) => ({ entry, index }))
            .filter(x => !x.entry.memoryId)
            .sort((a, b) => (b.entry.timestamp ?? 0) - (a.entry.timestamp ?? 0));
        const batchCharacterId = normalizeCharacterId(characterId || entries.find(entry => entry.characterId)?.characterId);
        const fallbackIds = noId.length === 0 ? [] : db.prepare(`
      SELECT id FROM memory
      WHERE source = 'conversation_log' AND project = ? AND is_active = 1
        AND character_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(proj, batchCharacterId, noId.length).map((r) => r.id);
        const fallbackIdByIndex = new Map();
        noId.forEach((x, k) => fallbackIdByIndex.set(x.index, fallbackIds[k]));
        // Validate and normalize the entire response before touching SQLite. If a
        // malformed result appears at any index, the queue retry must not observe
        // a half-written batch.
        const writes = [];
        for (let i = 0; i < results.length && i < entries.length; i++) {
            const r = results[i];
            if (!r || typeof r !== 'object' || Array.isArray(r)) {
                throw new Error(`Invalid classification result at index ${i}`);
            }
            const targetId = entries[i].memoryId || fallbackIdByIndex.get(i);
            if (!targetId)
                continue;
            const imp = clamp(numberOr(r.importance, 0.5), 0, 1);
            const tier = imp >= 0.7 ? 'critical' : (imp <= 0.3 ? 'temporary' : 'standard');
            const cat = validCategories.includes(r.category) ? r.category : 'general';
            const tags = serializeTags(Array.isArray(r.tags) ? r.tags.slice(0, 5) : []);
            // The batch appraisal is still useful when the small classifier omits
            // per-row VAD. Treat it as a bounded fallback instead of converting a
            // successfully sensed conversation into `abstain` and starving psyche.
            const vad = parseVadResult(r.vad)
                || (fallbackVad !== undefined ? parseVadResult(fallbackVad) : null);
            writes.push({ targetId, category: cat, importance: imp, tier, tags, vad });
        }
        let updated = 0;
        const updateWithVad = db.prepare(`UPDATE memory SET character_id = ?, category = ?, importance = ?, tier = ?, tags = ?,
        vad_valence = ?, vad_arousal = ?, vad_dominance = ?, affect_status = ?,
        affect_analyzed_at = ?, affect_source = 'ollama'
        WHERE id = ? AND project = ?
          AND character_id = ?
          AND source = 'conversation_log' AND is_active = 1`);
        const updateWithoutVad = db.prepare(`UPDATE memory SET character_id = ?, category = ?, importance = ?, tier = ?, tags = ?,
        affect_status = ?, affect_analyzed_at = ?, affect_source = 'ollama'
        WHERE id = ? AND project = ?
          AND character_id = ?
          AND source = 'conversation_log' AND is_active = 1`);
        const writeBatch = db.transaction(() => {
            const analyzedAt = new Date().toISOString();
            for (const write of writes) {
                const res = write.vad
                    ? updateWithVad.run(batchCharacterId, write.category, write.importance, write.tier, write.tags, write.vad.valence, write.vad.arousal, write.vad.dominance, 'analyzed', analyzedAt, write.targetId, proj, batchCharacterId)
                    : updateWithoutVad.run(batchCharacterId, write.category, write.importance, write.tier, write.tags, 'abstain', analyzedAt, write.targetId, proj, batchCharacterId);
                if (res.changes > 0)
                    updated++;
            }
        });
        writeBatch();
        return updated;
    }
    catch (e) {
        console.warn('[emotion] batchClassifyAndTag failed:', e.message);
        throw e;
    }
}
//# sourceMappingURL=emotion.js.map