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

import { normalizeProject, CHAR_ID } from './env.js';
import { scoreAffect, affectImpact } from './affectLexicon.js';
import { DatabaseManager } from './db.js';
import { serializeTags } from './tags.js';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

/** VAD 三维情感向量 — 所有计算的基础单位 */
export interface VADVector {
  valence: number;    // [-1, 1] 愉悦度：正向/负向
  arousal: number;    // [-1, 1] 激活度：高能量/低能量
  dominance: number;  // [-1, 1] 支配度：掌控感/无力感
}

/** Plutchik 8 基础情绪 — 供 prompt 注入 */
export interface Plutchik8 {
  joy: number;
  trust: number;
  fear: number;
  surprise: number;
  sadness: number;
  disgust: number;
  anger: number;
  anticipation: number;
}

/** 人格基线 — 情绪回归的锚点 */
export interface PersonalityBaseline {
  vad: VADVector;
  traits: Record<string, VADVector>;
}

/** LLM 返回的 VAD 分析结果 */
export interface VADAnalysis {
  vad: VADVector;
  tsundereLevel: number;  // [0, 10] 傲娇浓度
  confidence: number;     // [0, 1] 分析置信度
  tags: string[];
}

/** 衰减后的 VAD 结果 */
export interface DecayedVAD {
  vad: VADVector;
  intensity: number;      // 综合情感强度 [0, 1]
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

/** Anima 人格基线 — "sharp, resourceful, no-nonsense" */
export const AIRI_BASELINE: PersonalityBaseline = {
  vad: { valence: 0.4, arousal: 0.3, dominance: 0.6 },
  traits: {
    sharp:       { valence: 0, arousal: 0.15, dominance: 0.10 },
    resourceful: { valence: 0.10, arousal: 0, dominance: 0.05 },
    noNonsense:  { valence: -0.05, arousal: -0.05, dominance: 0 },
  },
};

/** 差异化半衰期（小时）— Verduyn & Lavrijsen 2014 */
export const HALF_LIFE = {
  valence:   24,   // 情绪效价最持久
  arousal:   4,    // 唤醒度快速消退
  dominance: 36,   // 支配感最持久
} as const;

/** 夜间衰减倍率 — 模拟睡眠情绪调节 */
const NIGHT_MULTIPLIER = {
  valence:   1.5,
  arousal:   3.0,   // 睡眠时激活度大幅下降
  dominance: 0.5,   // 支配感在夜间反而不易衰减
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
export function vapToPlutchik(vad: VADVector): Plutchik8 {
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

function sigmoid(x: number): number {
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
export function computeDecay(
  storedVAD: VADVector | null,
  hoursSince: number,
  tsundereLevel: number = 0,
  isNight: boolean = false,
): DecayedVAD {
  if (!storedVAD) {
    return { vad: { valence: 0, arousal: 0, dominance: 0 }, intensity: 0 };
  }

  // 傲娇减速因子：傲娇浓度越高，衰减越慢
  // tsundereLevel=0 → slowdown=1.0（正常）；=10 → slowdown=0.5（半速衰减）
  const tsundereSlowdown = 1 - TSUNDERE_SLOWDOWN_MAX * (tsundereLevel / 10);

  // 计算各维度衰减
  const decayValence = decayDimension(
    storedVAD.valence, hoursSince, HALF_LIFE.valence,
    tsundereSlowdown, isNight ? NIGHT_MULTIPLIER.valence : 1
  );
  const decayArousal = decayDimension(
    storedVAD.arousal, hoursSince, HALF_LIFE.arousal,
    tsundereSlowdown, isNight ? NIGHT_MULTIPLIER.arousal : 1
  );
  const decayDominance = decayDimension(
    storedVAD.dominance, hoursSince, HALF_LIFE.dominance,
    tsundereSlowdown, isNight ? NIGHT_MULTIPLIER.dominance : 1
  );

  const vad = { valence: decayValence, arousal: decayArousal, dominance: decayDominance };

  // 综合强度 = 三维绝对值的归一化均值
  const intensity = Math.min(1, (Math.abs(vad.valence) + Math.abs(vad.arousal) + Math.abs(vad.dominance)) / 3);

  return { vad, intensity };
}

/**
 * 单维度指数衰减
 * E(t) = E0 * exp(-tsundereSlowdown * nightMult * t / halfLife)
 */
function decayDimension(
  value: number,
  hours: number,
  halfLife: number,
  slowdown: number,
  nightMult: number,
): number {
  if (halfLife <= 0) return value;
  const lambda = slowdown * nightMult / halfLife; // 衰减速率
  return value * Math.exp(-lambda * hours);
}

/**
 * 判断当前时间是否夜间（22:00-06:00）
 */
export function isNightTime(now: Date = new Date()): boolean {
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
export function regressToBaseline(
  currentVAD: VADVector,
  baseline: VADVector = AIRI_BASELINE.vad,
  rate: number = REGRESSION_RATE,
): VADVector {
  return {
    valence:  currentVAD.valence  + rate * (baseline.valence  - currentVAD.valence),
    arousal:  currentVAD.arousal  + rate * (baseline.arousal  - currentVAD.arousal),
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
export async function ollamaDetectVAD(
  text: string,
  context?: string,
): Promise<VADAnalysis> {
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

    const data = await resp.json() as any;
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
        valence:  clamp(rawVad.valence || 0, -1, 1),
        arousal:  clamp(rawVad.arousal || 0, -1, 1),
        dominance: clamp(rawVad.dominance || 0, -1, 1),
      },
      tsundereLevel,
      confidence: clamp(parsed.confidence || 0.5, 0, 1),
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
    };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[emotion] Ollama VAD timeout, using fallback');
    } else {
      console.warn('[emotion] Ollama VAD failed:', err.message);
    }
    return fallbackVAD(text);
  }
}

/**
 * 回退方案：Ollama 不可用时用简单启发式
 * 只在模型加载失败/超时时使用
 */
function fallbackVAD(text: string): VADAnalysis {
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
    confidence: 0.3,  // 低置信度标记
    tags: [],
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}


// ═══════════════════════════════════════════════════════════════════
// 新增：拆三维 — baseIntensity / recency / decayedIntensity
// ═══════════════════════════════════════════════════════════════════

/**
 * 计算原始 VAD 幅度 — 事件本身的情绪烈度，永不变
 * baseIntensity = (|v| + |a| + |d|) / 3
 */
export function computeBaseIntensity(storedVAD: VADVector | null): number {
  if (!storedVAD) return 0;
  return Math.min(1, (Math.abs(storedVAD.valence) + Math.abs(storedVAD.arousal) + Math.abs(storedVAD.dominance)) / 3);
}

/**
 * 纯时间衰减因子 — 不涉及情感维度，只代表"这件事有多新鲜"
 * recency = exp(-t / halfLife)
 * 使用各维度中衰减最慢的 dominance 半衰期（36h）作为统一基准
 */
export function computeRecency(hoursSince: number, halfLife: number = HALF_LIFE.dominance): number {
  return Math.exp(-hoursSince / halfLife);
}

// ═══════════════════════════════════════════════════════════════════
// 格式化输出 — 供 prompt 注入
// ═══════════════════════════════════════════════════════════════════

/** 将 VAD 分析转为可注入 prompt 的文本 */
export function formatVADForPrompt(analysis: VADAnalysis): string {
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

/**
 * 队列条目必须带 project。
 * v1.23.2 审计第 1 组：模块级队列只存 text 时，flush 后按“进程默认库 + created_at DESC”
 * 做位置对齐，会写脏别的项目的 conversation_log，且顺序错位。
 * memoryId 由调用方在落库后回填，flush 时优先按 id 精确回写。
 */
export interface VadQueueEntry {
  text: string;
  timestamp: number;
  project: string;
  memoryId?: string;
}

let vadQueue: VadQueueEntry[] = [];
let lastFlushTime = 0;

/** 平滑状态按 project 分区：A 项目的情绪不该被 B 项目的对话带动。 */
const smoothedByProject = new Map<string, { vad: VADVector; tsundere: number }>();

function smoothedFor(project?: string): { vad: VADVector; tsundere: number } {
  const proj = normalizeProject(project);
  let s = smoothedByProject.get(proj);
  if (!s) {
    s = { vad: { ...AIRI_BASELINE.vad }, tsundere: 0 };
    smoothedByProject.set(proj, s);
  }
  return s;
}

export function queueForVad(text: string, project?: string, memoryId?: string): void {
  const proj = normalizeProject(project);
  const entry: VadQueueEntry = { text, timestamp: Date.now(), project: proj };
  if (memoryId) entry.memoryId = memoryId;
  vadQueue.push(entry);

  // 只按本项目的待处理条数触发自动 flush，避免被别的项目撑爆
  const pending = vadQueue.filter(q => q.project === proj).length;
  if (pending >= VAD_QUEUE_MAX_SIZE) {
    flushVadQueue(proj, { force: true }).catch(e => console.warn('[emotion] auto-flush failed:', e.message));
  }
}

let localAffectWarned = false;

/**
 * 消费 VAD 队列（按 project 分组，不同 project 永不进同一批 prompt）。
 * - 传 project：只处理该项目的分组；默认立即处理，opts.force=false 时才应用
 *   “攒够 5 条或最老 10 分钟”的批量阈值（digest 周期调用走这条）。
 * - 不传 project：显式全量 flush，逐组分析；管理/测试入口。
 */
/**
 * 离线兜底:按词表给每条记忆打 VAD 并写库(只在 ollamaDetectVAD 不可用时调用)。
 *
 * 实测背景:airi bank 262 条活跃记忆里 0 条有 vad_valence —— 唯一来源是 Ollama,
 * 而本机没跑 Ollama,于是情感维度整体空转。词表兜底的目标是"让争吵和吃了面分开";
 * confidence 故意压低(0.25~0.75),不与模型结果混淆。
 */
export function tagWithLocalAffect(
  entries: Array<{ text: string; memoryId?: string }>,
  project?: string,
): number {
  const proj = normalizeProject(project);
  const db = DatabaseManager.getInstance(proj);
  let updated = 0;
  const stmt = db.prepare(`UPDATE memory SET vad_valence = ?, vad_arousal = ?, vad_dominance = ?,
      emotional_impact = ?, tags = CASE WHEN tags IS NULL OR tags = '[]' THEN ? ELSE tags END
      WHERE id = ? AND project = ?`);
  for (const e of entries) {
    if (!e.memoryId) continue;
    const sc = scoreAffect(e.text);
    if (sc.confidence <= 0) continue;
    const tags = JSON.stringify(sc.matched.slice(0, 3));
    try {
      const r = stmt.run(sc.valence, sc.arousal, sc.dominance, affectImpact(sc), tags, e.memoryId, proj);
      if (r.changes > 0) updated++;
    } catch (err: any) {
      console.warn('[emotion] local affect write failed:', err.message);
      break;
    }
  }
  return updated;
}

export async function flushVadQueue(
  project?: string,
  opts: { force?: boolean } = {},
): Promise<VADAnalysis | null> {
  if (vadQueue.length === 0) return null;

  const scoped = typeof project === 'string' && project.trim().length > 0;
  const target = scoped ? normalizeProject(project) : null;
  const now = Date.now();

  const groups = new Map<string, VadQueueEntry[]>();
  for (const entry of vadQueue) {
    if (target !== null && entry.project !== target) continue;
    const list = groups.get(entry.project) || [];
    list.push(entry);
    groups.set(entry.project, list);
  }
  if (groups.size === 0) return null;

  // 显式调用 flush = 立即处理；只有 digest 显式传 force:false 才保留批量阈值。
  const force = opts.force !== false;
  const batches: Array<{ project: string; entries: VadQueueEntry[] }> = [];
  for (const [proj, entries] of groups) {
    const oldestAge = now - Math.min(...entries.map(e => e.timestamp));
    if (!force && entries.length < VAD_QUEUE_MIN_BATCH && oldestAge < VAD_QUEUE_MAX_AGE_MS) continue;
    batches.push({ project: proj, entries });
  }
  if (batches.length === 0) return null;

  // 只摘掉本次真正要处理的条目；未达阈值/别的项目的条目留在队列里
  const taken = new Set<VadQueueEntry>();
  for (const b of batches) for (const e of b.entries) taken.add(e);
  vadQueue = vadQueue.filter(e => !taken.has(e));
  lastFlushTime = now;

  let lastResult: VADAnalysis | null = null;
  let processed = 0;
  for (const batch of batches) {
    const lines = batch.entries.map((q, i) => '[' + (i + 1) + '] ' + q.text).join('\n');
    const batchText = 'Analyze the emotional trajectory across these ' + batch.entries.length
      + ' recent messages:\n' + lines
      + '\n\nOutput a SINGLE VAD and tsundere_level representing the current overall emotional state.';

    // Ollama 不可用时 ollamaDetectVAD **不抛错**,而是返回 confidence≈0 的默认值
    // (实测日志:"[emotion] Ollama VAD failed: fetch failed");旧代码随后 `confidence<0.3 → continue`
    // 就静默跳过了 —— 这正是 airi bank 262 条记忆 0 条 VAD 的直接原因。所以两条路都要兜底。
    let result: VADAnalysis | null = null;
    try {
      result = await ollamaDetectVAD(batchText);
    } catch (e: any) {
      result = null;
      if (!localAffectWarned) console.warn('[emotion] Ollama VAD 抛错:', e.message);
    }
    // 注意:ollamaDetectVAD 失败时返回 fallbackVAD,它的 confidence **正好是 0.3**,
    // 而下面原来的 `confidence < 0.3` 判不到它 —— 于是继续调用 batchClassifyAndTag(第二次 Ollama),
    // 再失败一次,整批静默丢弃。这就是 0 条 VAD 的完整链路。用 <= 0.35 把它接住。
    if (!result || result.confidence <= 0.35) {
      if (!localAffectWarned) {
        console.warn('[emotion] Ollama 不可用或置信度过低,改用本地情感词表兜底(只影响 VAD,不改其他字段)');
        localAffectWarned = true;
      }
      processed += tagWithLocalAffect(batch.entries, batch.project);
      continue;
    }
    lastResult = result;
    if (result.confidence < 0.3) continue;

    const smoothed = smoothedFor(batch.project);
    smoothed.vad = {
      valence: smoothed.vad.valence + EMOTION_SMOOTH_ALPHA * (result.vad.valence - smoothed.vad.valence),
      arousal: smoothed.vad.arousal + EMOTION_SMOOTH_ALPHA * (result.vad.arousal - smoothed.vad.arousal),
      dominance: smoothed.vad.dominance + EMOTION_SMOOTH_ALPHA * (result.vad.dominance - smoothed.vad.dominance),
    };
    smoothed.tsundere = smoothed.tsundere + EMOTION_SMOOTH_ALPHA * (result.tsundereLevel - smoothed.tsundere);

    // 批量分类 + 回写标签/VAD 到每条消息。必须 await：调用方 flush 完就能读到更新。
    processed += await batchClassifyAndTag(batch.entries, batch.project);
  }

  if (processed > 0) {
    console.warn(`[emotion] VAD flush: ${batches.length} project batch(es), ${processed} memories tagged`);
  }
  return lastResult;
}

export function getSmoothedVAD(project?: string): { vad: VADVector; tsundereLevel: number } {
  const s = smoothedFor(project);
  return {
    vad: { ...s.vad },
    tsundereLevel: Math.round(s.tsundere),
  };
}

export function vadQueueStatus(project?: string): { size: number; oldestAgeSec: number; smoothed: string } {
  const now = Date.now();
  const scoped = typeof project === 'string' && project.trim().length > 0;
  const pending = scoped ? vadQueue.filter(q => q.project === normalizeProject(project)) : vadQueue;
  const oldest = pending[0]?.timestamp || now;
  const s = smoothedFor(scoped ? project : undefined);
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
export function fallbackClassify(text: string): { tier: 'temporary' | 'standard' | 'critical'; category: string; importance: number; tags: string[] } {
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
export async function ollamaClassify(text: string): Promise<{
  tier: 'temporary' | 'standard' | 'critical';
  category: string;
  importance: number;
  tags: string[];
  confidence: number;
}> {
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

    if (!resp.ok) throw new Error('Ollama ' + resp.status);
    const data = await resp.json() as any;
    const content = data.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');

    const parsed = JSON.parse(jsonMatch[0]);
    const validCategories = ['identity', 'milestone', 'emotional', 'knowledge', 'preference', 'plan', 'relationship', 'general'];

    const importance = clamp(parsed.importance || 0.5, 0, 1);
    // 从 importance 推导 tier — 确定性规则，不由 LLM 判断
    const tier: 'temporary' | 'standard' | 'critical' =
      importance >= 0.7 ? 'critical' : (importance <= 0.3 ? 'temporary' : 'standard');

    return {
      tier,
      category: validCategories.includes(parsed.category) ? parsed.category : 'general',
      importance,
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
      confidence: clamp(parsed.confidence || 0.5, 0, 1),
    };
  } catch (e: any) {
    console.warn('[emotion] ollamaClassify failed:', e.message);
    return { ...fallbackClassify(text), confidence: 0.3, tier: 'standard' as const, category: 'general' };
  }
}


// ═══════════════════════════════════════════════════════════════════
// 批量分类 — 一次 Ollama 调用处理 N 条消息，结果回写 DB
// ═══════════════════════════════════════════════════════════════════

/** 把模型返回的 vad 对象解析成 [-1,1] 三维；三个维度都必须是有限数字，否则整条视为“没返回 VAD”。 */
function parseVadResult(raw: any): VADVector | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nums = [raw.valence, raw.arousal, raw.dominance].map((v: any): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  });
  if (nums.some(n => n === null)) return null;
  return {
    valence: clamp(nums[0] as number, -1, 1),
    arousal: clamp(nums[1] as number, -1, 1),
    dominance: clamp(nums[2] as number, -1, 1),
  };
}

/**
 * 一批消息 → 一条 Ollama prompt → N 个分类结果。
 * 回写按 memoryId 精确 UPDATE；没有 id 的条目才回退到“本项目 + created_at DESC”的位置对齐。
 * 模型返回 vad 时同时写入 vad_valence/arousal/dominance（clamp 到 [-1,1]，与 search.ts 读取约定一致）。
 */
export async function batchClassifyAndTag(
  entries: Array<{ text: string; memoryId?: string; timestamp?: number }>,
  project?: string,
): Promise<number> {
  if (entries.length === 0) return 0;
  const proj = normalizeProject(project);

  const systemPrompt = 'Classify each numbered message. For EACH, output: importance (0-1), category, tags (Chinese), and vad.\n' +
    'importance: identity/job/name → 0.8+. milestones/promises → 0.7+. preferences/knowledge → 0.4-0.6. trivial → 0.1-0.3.\n' +
    'category: identity|milestone|emotional|knowledge|preference|plan|relationship|general\n' +
    'vad: {"valence":-1..1,"arousal":-1..1,"dominance":-1..1} — emotional tone of THAT message; 0 for neutral/factual. Omit "vad" entirely if you cannot judge it.\n' +
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

    if (!resp.ok) throw new Error('Ollama ' + resp.status);
    const data = await resp.json() as any;
    const content = data.message?.content || '';
    const jsonMatch = content.trim().match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array');

    let results: any[];
    try {
      results = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // 修复常见 JSON 错误：缺逗号、多余空白、未闭合等
      let fixed = jsonMatch[0]
        .replace(/}\s*{/g, '},{')        // 对象间缺逗号
        .replace(/,\s*}/g, '}')           // 尾随逗号
        .replace(/,\s*\]/g, ']')         // 数组尾随逗号
        .replace(/\]\s*$/g, ']');         // 确保闭合
      try {
        results = JSON.parse(fixed);
      } catch (e2: any) {
        console.warn('[emotion] batchClassify JSON parse error:', e2.message, 'raw:', jsonMatch[0].substring(0,200));
        return 0;
      }
    }
    if (!Array.isArray(results)) throw new Error('Not an array');

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
    const fallbackIds: string[] = noId.length === 0 ? [] : db.prepare(`
      SELECT id FROM memory
      WHERE source = 'conversation_log' AND project = ? AND is_active = 1 AND character_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(proj, CHAR_ID, noId.length).map((r: any) => r.id);
    const fallbackIdByIndex = new Map<number, string | undefined>();
    noId.forEach((x, k) => fallbackIdByIndex.set(x.index, fallbackIds[k]));

    let updated = 0;
    for (let i = 0; i < results.length && i < entries.length; i++) {
      const r = results[i];
      const targetId = entries[i].memoryId || fallbackIdByIndex.get(i);
      if (!targetId) continue;

      const imp = clamp(r.importance || 0.5, 0, 1);
      const tier = imp >= 0.7 ? 'critical' : (imp <= 0.3 ? 'temporary' : 'standard');
      const cat = validCategories.includes(r.category) ? r.category : 'general';
      const tags = serializeTags(Array.isArray(r.tags) ? r.tags.slice(0, 5) : []);
      const vad = parseVadResult(r.vad);

      // 有 VAD 才写三列；没有就保持 NULL（检索的 VAD 衰减分支才不会误判）
      const res = vad
        ? db.prepare(`UPDATE memory SET category = ?, importance = ?, tier = ?, tags = ?,
            vad_valence = ?, vad_arousal = ?, vad_dominance = ? WHERE id = ? AND project = ?`)
            .run(cat, imp, tier, tags, vad.valence, vad.arousal, vad.dominance, targetId, proj)
        : db.prepare(`UPDATE memory SET category = ?, importance = ?, tier = ?, tags = ? WHERE id = ? AND project = ?`)
            .run(cat, imp, tier, tags, targetId, proj);
      if (res.changes > 0) updated++;
    }

    return updated;
  } catch (e: any) {
    console.warn('[emotion] batchClassifyAndTag failed:', e.message);
    return 0;
  }
}
