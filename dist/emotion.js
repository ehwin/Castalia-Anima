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
// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════
/** AIRI 人格基线 — "sharp, resourceful, no-nonsense" */
export const AIRI_BASELINE = {
    vad: { valence: 0.4, arousal: 0.3, dominance: 0.6 },
    traits: {
        sharp: { valence: 0, arousal: 0.15, dominance: 0.10 },
        resourceful: { valence: 0.10, arousal: 0, dominance: 0.05 },
        noNonsense: { valence: -0.05, arousal: -0.05, dominance: 0 },
    },
};
/** 差异化半衰期（小时）— Verduyn & Lavrijsen 2014 */
export const HALF_LIFE = {
    valence: 24, // 情绪效价最持久
    arousal: 4, // 唤醒度快速消退
    dominance: 36, // 支配感最持久
};
/** 夜间衰减倍率 — 模拟睡眠情绪调节 */
const NIGHT_MULTIPLIER = {
    valence: 1.5,
    arousal: 3.0, // 睡眠时激活度大幅下降
    dominance: 0.5, // 支配感在夜间反而不易衰减
};
/** 傲娇减速因子 — 傲娇记忆衰减更慢 */
const TSUNDERE_SLOWDOWN_MAX = 0.5; // 最高减速 50%
/** 基线回归速率 — 每轮操作回归比例 */
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
    // 傲娇减速因子：傲娇浓度越高，衰减越慢
    // tsundereLevel=0 → slowdown=1.0（正常）；=10 → slowdown=0.5（半速衰减）
    const tsundereSlowdown = 1 - TSUNDERE_SLOWDOWN_MAX * (tsundereLevel / 10);
    // 计算各维度衰减
    const decayValence = decayDimension(storedVAD.valence, hoursSince, HALF_LIFE.valence, tsundereSlowdown, isNight ? NIGHT_MULTIPLIER.valence : 1);
    const decayArousal = decayDimension(storedVAD.arousal, hoursSince, HALF_LIFE.arousal, tsundereSlowdown, isNight ? NIGHT_MULTIPLIER.arousal : 1);
    const decayDominance = decayDimension(storedVAD.dominance, hoursSince, HALF_LIFE.dominance, tsundereSlowdown, isNight ? NIGHT_MULTIPLIER.dominance : 1);
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
 */
export function regressToBaseline(currentVAD, baseline = AIRI_BASELINE.vad, rate = REGRESSION_RATE) {
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
    const systemPrompt = `You are an emotion analyzer. Output ONLY valid JSON, no commentary.

Analyze the speaker's emotional state using the VAD model:
- valence: [-1,1] NUMBER. positive=pleasant, negative=unpleasant. Neutral=0. NEVER output outside [-1,1].
- arousal: [-1,1] NUMBER. high=excited/angry, low=calm/bored. Neutral=0. NEVER output outside [-1,1].
- dominance: [-1,1] NUMBER. high=in_control/confident, low=helpless/overwhelmed. Neutral=0. NEVER output outside [-1,1].

CRITICAL RULES:
1. Neutral/factual statements (e.g. "today is Wednesday") → ALL values ≈ 0, confidence high.
2. Values MUST stay strictly within [-1, 1]. If unsure, output 0.
3. tsundere_level: ONLY set >3 when surface words clearly CONTRADICT true feelings.
   - Pure anger where words match feelings → tsundere_level 0-1
   - Pure sadness where words match feelings → tsundere_level 0-1
   - "Not like I care about you" → surface v=-0.7 true v=0.3, tsundere_level 7
   - "I don't care anymore" → surface v=-0.2 true v=-0.7, tsundere_level 6
4. Tags: ALWAYS in Chinese, 1-5 keywords.

Output JSON:
{
  "surface_vad": {"valence": 0, "arousal": 0, "dominance": 0},
  "true_vad": {"valence": 0, "arousal": 0, "dominance": 0},
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
        const data = await resp.json();
        let content = (data.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '');
        const thinking = data.message?.thinking || '';
        // 提取 JSON（content 优先；reasoning 模型回退 thinking 字段）
        const rawText = content || thinking;
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No JSON found in Ollama response');
        }
        const parsed = JSON.parse(jsonMatch[0]);
        // 从 surface_vad 和 true_vad 中取 true_vad（真实情感）
        // tsundere_level > 3 时用 true_vad，否则用 surface_vad
        const tsundereLevel = Math.max(0, Math.min(10, parsed.tsundere_level || 0));
        const useTrue = tsundereLevel > 3;
        const rawVad = useTrue ? parsed.true_vad : parsed.surface_vad;
        return {
            vad: {
                valence: clamp(rawVad.valence || 0, -1, 1),
                arousal: clamp(rawVad.arousal || 0, -1, 1),
                dominance: clamp(rawVad.dominance || 0, -1, 1),
            },
            tsundereLevel,
            confidence: clamp(parsed.confidence || 0.5, 0, 1),
            tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
        };
    }
    catch (err) {
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
function fallbackVAD(text) {
    const lower = text.toLowerCase();
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
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
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
 * 纯时间衰减因子 — 不涉及情感维度，只代表"这件事有多新鲜"
 * recency = exp(-t / halfLife)
 * 使用各维度中衰减最慢的 dominance 半衰期（36h）作为统一基准
 */
export function computeRecency(hoursSince, halfLife = HALF_LIFE.dominance) {
    return Math.exp(-hoursSince / halfLife);
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
const VAD_QUEUE_MAX_AGE_MS = 10 * 60 * 1000;
const EMOTION_SMOOTH_ALPHA = 0.3;
let vadQueue = [];
let lastFlushTime = 0;
let _smoothedVAD = { ...AIRI_BASELINE.vad };
let _smoothedTsundere = 0;
export function queueForVad(text) {
    vadQueue.push({ text, timestamp: Date.now() });
    if (vadQueue.length >= VAD_QUEUE_MAX_SIZE) {
        flushVadQueue().catch(e => console.warn('[emotion] auto-flush failed:', e.message));
    }
}
export async function flushVadQueue() {
    if (vadQueue.length === 0)
        return null;
    const now = Date.now();
    const oldestAge = now - (vadQueue[0]?.timestamp || now);
    if (vadQueue.length < 5 && oldestAge < VAD_QUEUE_MAX_AGE_MS) {
        return null;
    }
    const batch = [...vadQueue];
    vadQueue = [];
    lastFlushTime = now;
    const lines = batch.map((q, i) => '[' + (i + 1) + '] ' + q.text).join('\n');
    const batchText = 'Analyze the emotional trajectory across these ' + batch.length
        + ' recent messages:\n' + lines
        + '\n\nOutput a SINGLE VAD and tsundere_level representing the current overall emotional state.';
    const result = await ollamaDetectVAD(batchText);
    if (result.confidence < 0.3)
        return result;
    _smoothedVAD = {
        valence: _smoothedVAD.valence + EMOTION_SMOOTH_ALPHA * (result.vad.valence - _smoothedVAD.valence),
        arousal: _smoothedVAD.arousal + EMOTION_SMOOTH_ALPHA * (result.vad.arousal - _smoothedVAD.arousal),
        dominance: _smoothedVAD.dominance + EMOTION_SMOOTH_ALPHA * (result.vad.dominance - _smoothedVAD.dominance),
    };
    _smoothedTsundere = _smoothedTsundere + EMOTION_SMOOTH_ALPHA * (result.tsundereLevel - _smoothedTsundere);
    // 批量分类 + 回写标签到每条消息
    batchClassifyAndTag(batch.map(q => q.text)).catch(() => { });
    return result;
}
export function getSmoothedVAD() {
    return {
        vad: { ..._smoothedVAD },
        tsundereLevel: Math.round(_smoothedTsundere),
    };
}
export function vadQueueStatus() {
    const now = Date.now();
    const oldest = vadQueue[0]?.timestamp || now;
    const ts = Math.round(_smoothedTsundere);
    return {
        size: vadQueue.length,
        oldestAgeSec: Math.round((now - oldest) / 1000),
        smoothed: 'v=' + _smoothedVAD.valence.toFixed(2) + ' a=' + _smoothedVAD.arousal.toFixed(2) + ' tsun=' + ts,
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
        const importance = clamp(parsed.importance || 0.5, 0, 1);
        // 从 importance 推导 tier — 确定性规则，不由 LLM 判断
        const tier = importance >= 0.7 ? 'critical' : (importance <= 0.3 ? 'temporary' : 'standard');
        return {
            tier,
            category: validCategories.includes(parsed.category) ? parsed.category : 'general',
            importance,
            tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
            confidence: clamp(parsed.confidence || 0.5, 0, 1),
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
/**
 * 一批消息 → 一条 Ollama prompt → N 个分类结果
 * 不阻塞，每条消息获得独立的 category/importance/tags
 */
export async function batchClassifyAndTag(texts) {
    if (texts.length === 0)
        return 0;
    const systemPrompt = 'Classify each numbered message. For EACH, output: importance (0-1), category, tags (Chinese).\n' +
        'importance: identity/job/name → 0.8+. milestones/promises → 0.7+. preferences/knowledge → 0.4-0.6. trivial → 0.1-0.3.\n' +
        'category: identity|milestone|emotional|knowledge|preference|plan|relationship|general\n' +
        'Output ONLY a JSON array, one object per message: [{"importance":0.8,"category":"identity","tags":["标签1"]}, ...]';
    const lines = texts.map((t, i) => '[' + (i + 1) + '] ' + t).join('\n');
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
                return 0;
            }
        }
        if (!Array.isArray(results))
            throw new Error('Not an array');
        const validCategories = ['identity', 'milestone', 'emotional', 'knowledge', 'preference', 'plan', 'relationship', 'general'];
        // 导入 DB 模块回写标签到最近的 conversation_log
        let { DatabaseManager } = await import('./db.js');
        const db = DatabaseManager.getInstance();
        const recentIds = db.prepare(`
      SELECT id FROM memory
      WHERE source = 'conversation_log' AND is_active = 1
      ORDER BY created_at DESC
      LIMIT ${texts.length}
    `).all().map((r) => r.id);
        let updated = 0;
        for (let i = 0; i < results.length && i < recentIds.length; i++) {
            const r = results[i];
            const imp = clamp(r.importance || 0.5, 0, 1);
            const tier = imp >= 0.7 ? 'critical' : (imp <= 0.3 ? 'temporary' : 'standard');
            const cat = validCategories.includes(r.category) ? r.category : 'general';
            const tags = Array.isArray(r.tags) ? r.tags.slice(0, 5).join(',') : '';
            db.prepare(`UPDATE memory SET category = ?, importance = ?, tier = ?, tags = ? WHERE id = ?`)
                .run(cat, imp, tier, tags, recentIds[i]);
            updated++;
        }
        return updated;
    }
    catch (e) {
        console.warn('[emotion] batchClassifyAndTag failed:', e.message);
        return 0;
    }
}
