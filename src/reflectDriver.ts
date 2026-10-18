/**
 * Reflect Driver — LLM reflection driver (bundled into the MCP server)
 *
 * Ported from the original reflect design: fetch memories → call LLM → parse actions → apply
 * - reflect_auto: unanalyzed conversations → daily digest / memory extraction
 * - reflect_deep: all memories → dedup / profile / graph
 *
 * Env config:
 *   REFLECT_LLM_URL       default https://api.deepseek.com/v1 (OpenAI-compatible)
 *   REFLECT_LLM_API_KEY   required; skipped when unset
 *   REFLECT_LLM_MODEL     default deepseek-chat
 *   REFLECT_FACT_EXTRACTION auto | off  (default auto) — off 时 prompt 不要求 facts,也不落 facts
 *   REFLECT_MAX_FACTS     每轮最多提取 facts 条数 (default 15)
 *   REFLECT_INTERVAL_HOURS auto-reflect interval (hours), 0 = off, default 0
 */
import { getUnanalyzedConversations, listAllMemories, applyReflectResult, applyReflectActions, ReflectAction, ReflectReceipt, ReflectResult } from './reflect.js';
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeProject, isEmbedEnabled } from './env.js';
import { isMemType } from './memType.js';
import { findSimilarCandidates, SimilarCandidate, CONSOLIDATE_SIMILARITY, CONSOLIDATE_MAX_PAIRS } from './consolidate.js';
import { getRecentConversations } from './digest.js';
import { loadPromptOverride } from './promptFile.js';
import { callLlm, makeLlmChannel, parseJsonRobust, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
export { callLlm, makeLlmChannel, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
export type { LlmChannel, LlmResponse } from './reflectionLlm.js';
import { wholeRecordBatches, emotionalReflectPrompt, EMOTIONAL_FIDELITY } from './reflectionFidelity.js';
import { markConversationsReflected, deepReflectionCursor } from './reflectionSources.js';

const FACT_EXTRACTION = (process.env.REFLECT_FACT_EXTRACTION || 'auto').trim().toLowerCase();
const MAX_FACTS = parseInt(process.env.REFLECT_MAX_FACTS || '15', 10) || 15;

// 启动自动反思触发阈值(条件达成后,下次启动 server 时自动执行一次)
const MIN_GAP_HOURS = (() => { const v = parseFloat(process.env.REFLECT_MIN_GAP_HOURS || '24'); return Number.isFinite(v) && v > 0 ? v : 24; })();
const MIN_UNANALYZED = (() => { const v = parseInt(process.env.REFLECT_MIN_UNANALYZED || '5', 10); return Number.isFinite(v) && v >= 0 ? v : 5; })();

// v1.10: 启动自动整合触发阈值(active 记忆条数 > 该值 → 下次启动自动整合一次)
const CONSOLIDATE_MIN_MEMORIES = (() => { const v = parseInt(process.env.CONSOLIDATE_MIN_MEMORIES || '15', 10); return Number.isFinite(v) && v >= 0 ? v : 15; })();

/**
 * v1.11: LLM 通道 — 三通道架构(LLM1 triage / 向量模型 / LLM2 reflect)。
 * 构造 `${PREFIX}_LLM_URL / ${PREFIX}_LLM_API_KEY / ${PREFIX}_LLM_MODEL` 配置:
 *   优先取前缀通道自身值;缺省回退 REFLECT_*(旧单通道);再回退内置默认。
 *   供 triage(LLM1) 与 reflect(LLM2) 复用。
 */
export function isReflectConfigured(): boolean {
  return !!makeLlmChannel('reflect').apiKey;
}

export function isFactExtractionEnabled(): boolean {
  return FACT_EXTRACTION !== 'off';
}

export interface ReflectCondition {
  should: boolean;
  reason: string;
}

/**
 * 启动自动反思条件检查(两个同时满足才反思):
 *   a. REFLECT_LLM_API_KEY 已配置
 *   b. 距上次反思 ≥ REFLECT_MIN_GAP_HOURS(默认 24h;从未反思 → 视为超时,满足)
 *   c. 未分析对话数 > REFLECT_MIN_UNANALYZED(默认 5)
 * 按 project 维度查询(默认项目用 charId + normalizeProject)。
 */
export function shouldAutoReflect(charId: string = 'airi', project?: string): ReflectCondition {
  if (!isReflectConfigured()) {
    return { should: false, reason: 'REFLECT_LLM_API_KEY 未配置' };
  }
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);

  // 最近一次反思时间(source='reflect_summary',按 project 过滤)
  const last = db.prepare(`
    SELECT created_at FROM memory
    WHERE source = 'reflect_summary' AND project = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(proj) as any;
  const lastTime = last?.created_at ? new Date(last.created_at).getTime() : null;

  const hoursSince = lastTime === null
    ? Number.POSITIVE_INFINITY  // 从未反思 → 视为超时,满足时间条件
    : (Date.now() - lastTime) / 3600000;
  const timeOk = hoursSince >= MIN_GAP_HOURS;
  const gapLabel = lastTime === null ? '∞' : `${Math.floor(hoursSince * 10) / 10}`;

  if (!timeOk) {
    return { should: false, reason: `距上次反思 ${gapLabel} 小时,未到 ${MIN_GAP_HOURS}h` };
  }

  const count = getUnanalyzedConversations(charId, undefined, MIN_UNANALYZED + 1, project).length;

  if (count <= MIN_UNANALYZED) {
    return { should: false, reason: `未分析对话 ${count} 条,未超 ${MIN_UNANALYZED}` };
  }

  return { should: true, reason: `距上次反思 ${gapLabel}h 且未分析对话 ${count} 条` };
}

/**
 * v1.10: 启动自动整合条件检查 — active 记忆条数 > CONSOLIDATE_MIN_MEMORIES(默认 15)即达成。
 * 注意:整合只需记忆足够多,不依赖 REFLECT_LLM_API_KEY(无 key 时 runConsolidate 会报错跳过)。
 */
export function shouldAutoConsolidate(project?: string): { should: boolean; count: number; min: number; reason: string } {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const count = (db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active = 1 AND project = ?').get(proj) as any)?.c ?? 0;
  const min = CONSOLIDATE_MIN_MEMORIES;
  if (count > min) return { should: true, count, min, reason: `${count} > ${min}` };
  return { should: false, count, min, reason: `${count} 未超 ${min}` };
}

/** Anima keeps its own emotional strategy; overrides receive the same fidelity guard. */
export function buildReflectSystemPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS): string {
  const custom = loadPromptOverride('REFLECT_PROMPT_FILE', '');
  return (custom ? custom + '\n' : '') + emotionalReflectPrompt(factExtraction, maxFacts);
}
export function buildDeepReflectPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS): string {
  const custom = loadPromptOverride('REFLECT_DEEP_PROMPT_FILE', '');
  return (custom ? custom + '\n' : '') + emotionalReflectPrompt(factExtraction, maxFacts);
}

/** 向后兼容：默认配置下的 prompt（外部可能仍引用这两个常量） */
export const REFLECT_SYSTEM_PROMPT: string = buildReflectSystemPrompt();
export const DEEP_REFLECT_PROMPT: string = buildDeepReflectPrompt();

/**
 * 多策略解析 LLM 返回的 JSON(容忍常见错误)
 * 支持 [...] 数组和 {...} 对象,以及 markdown 代码围栏包裹:
 *   - 数组 → 包成 { actions: [...] }(老 prompt 的只返回数组格式)
 *   - 对象 → 原样返回
 */
/** 把 parseJsonRobust 结果规范化为 applyReflectResult 期望的 ReflectResult */
function normalizeReflectResult(parsed: any): ReflectResult {
  const out: any = { ...parsed };
  out.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (FACT_EXTRACTION === 'off') {
    out.facts = [];
  } else if (Array.isArray(parsed.facts)) {
    out.facts = parsed.facts.slice(0, MAX_FACTS);
  } else {
    out.facts = [];
  }
  return out as ReflectResult;
}

export interface ReflectRunResult {
  ok: boolean;
  mode: 'auto' | 'deep';
  conversationCount?: number;
  memoryCount?: number;
  actions: number;
  applied: number;
  factsInserted?: number;
  factsUpdated?: number;
  errors: string[];
  skipped?: boolean;
  receipts?: ReflectReceipt[];
  processedCount?: number;
  deferredCount?: number;
}

/** 日常反思:未分析对话 → 日记浓缩/提取 */
export async function runAutoReflect(charId: string, limit = 30, project?: string): Promise<ReflectRunResult> {
  const base: ReflectRunResult = { ok: false, mode: 'auto', actions: 0, applied: 0, errors: [] };
  if (!isReflectConfigured()) {
    return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
  }
  try {
    const conversations = getUnanalyzedConversations(charId, undefined, limit, project);
    if (conversations.length === 0) {
      return { ...base, ok: true, conversationCount: 0, skipped: true, errors: ['无未分析对话'] };
    }
    const batches = wholeRecordBatches(conversations);
    const out: ReflectRunResult = { ...base, conversationCount: conversations.length, processedCount: 0, deferredCount: conversations.length, receipts: [] };
    for (const batch of batches) {
      const llm = await callLlm(buildReflectSystemPrompt(), `请逐条分析完整情感对话：\n${JSON.stringify(batch)}`, undefined, REFLECT_DEEP_MAX_TOKENS);
      if (!llm || llm.finishReason === 'length') { out.errors.push(!llm ? 'LLM 调用失败' : 'LLM 输出被截断；本批未写入，保留待重试'); break; }
      const parsed = parseJsonRobust(llm.content);
      if (!parsed || !Array.isArray(parsed.actions)) { out.errors.push('未返回完整 JSON actions；本批保留待重试'); break; }
      const allowed = new Set(batch.map(c => c.id));
      const ids: string[] = parsed.processedSourceIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !allowed.has(id))) {
        out.errors.push('缺少合法的 processedSourceIds；本批未写入，保留待重试'); break;
      }
      const result = normalizeReflectResult(parsed);
      const r = await applyReflectResult(result, charId, project, { automatic: true, allowedSourceIds: allowed });
      out.actions += result.actions!.length; out.applied += r.actionsApplied;
      out.factsInserted = (out.factsInserted || 0) + r.factsInserted;
      out.factsUpdated = (out.factsUpdated || 0) + r.factsUpdated;
      out.errors.push(...r.errors); out.receipts!.push(...r.receipts);
      if (r.errors.length) break;
      markConversationsReflected(ids, project);
      out.processedCount! += ids.length; out.deferredCount! -= ids.length;
      if (ids.length < batch.length) { out.errors.push('本批部分来源尚未完成，保留待重试'); break; }
    }
    out.ok = out.errors.length === 0;
    return out;
  } catch (e: any) {
    return { ...base, errors: [e.message] };
  }
}

/** 深度校准:全量记忆 → 去重/画像/图谱 */
export async function runDeepReflect(charId: string, limit = 500, project?: string): Promise<ReflectRunResult> {
  const base: ReflectRunResult = { ok: false, mode: 'deep', actions: 0, applied: 0, errors: [] };
  if (!isReflectConfigured()) {
    return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
  }
  try {
    const memories = listAllMemories(charId, limit, project) as any[];
    if (memories.length === 0) {
      return { ...base, ok: true, memoryCount: 0, skipped: true, errors: ['库为空'] };
    }
    memories.sort((a, b) => a.id.localeCompare(b.id));
    const cursor = deepReflectionCursor(project);
    const nextIndex = memories.findIndex(m => m.id > cursor);
    if (nextIndex > 0) memories.push(...memories.splice(0, nextIndex));
    const slim = memories.map(m => ({
      id: m.id,
      text: m.text || '',
      subject: m.subject, vad: m.vad, agentMood: m.agentMood,
      type: m.type, memType: m.memType || 'general', category: m.category,
      tags: m.tags || [], importance: m.importance ?? 0.5,
      emotionalImpact: m.emotionalImpact ?? 0, tier: m.tier || 'standard',
      locked: m.locked || 0, source: m.source || '',
      date: (m.createdAt || '').slice(0, 10),
    }));
    const chunk = Math.max(1, Number(process.env.REFLECT_DEEP_CHUNK || 12) || 12);
    const maxCalls = Math.max(1, Number(process.env.REFLECT_DEEP_MAXCALLS || 4) || 4);
    const batches = wholeRecordBatches(slim, 30000, chunk);
    const out: ReflectRunResult = { ...base, memoryCount: memories.length, processedCount: 0, receipts: [] };
    for (const batch of batches.slice(0, maxCalls)) {
      const llm = await callLlm(buildDeepReflectPrompt(), `请深度分析本批完整情感记忆：\n${JSON.stringify(batch)}`, undefined, REFLECT_DEEP_MAX_TOKENS);
      if (!llm || llm.finishReason === 'length') { out.errors.push(!llm ? 'LLM 调用失败' : 'LLM 输出被截断；本批未写入，游标不前进'); break; }
      const parsed = parseJsonRobust(llm.content);
      if (!parsed || !Array.isArray(parsed.actions)) { out.errors.push('未返回完整 JSON actions；游标不前进'); break; }
      const result = normalizeReflectResult(parsed);
      const r = await applyReflectResult(result, charId, project, { automatic: true, allowedSourceIds: new Set(batch.map(m => m.id)) });
      out.actions += result.actions!.length; out.applied += r.actionsApplied;
      out.factsInserted = (out.factsInserted || 0) + r.factsInserted;
      out.factsUpdated = (out.factsUpdated || 0) + r.factsUpdated;
      out.errors.push(...r.errors); out.receipts!.push(...r.receipts);
      if (r.errors.length) break;
      deepReflectionCursor(project, batch[batch.length - 1].id);
      out.processedCount! += batch.length;
    }
    out.deferredCount = memories.length - out.processedCount!;
    out.ok = out.errors.length === 0;
    return out;
  } catch (e: any) {
    return { ...base, errors: [e.message] };
  }
}

// ═══════════════════════════════════════════════════════════════════
// v1.10: 记忆整合子进程(Memory Consolidator)
// 忠实还原 Claude Code MEMORY_CONSOLIDATION_PROMPT 精神(用户确认,不自定义改动):
//   - CONFLICT RESOLUTION:矛盾时 ALWAYS 偏最新用户决定;被撤销/取代的规则 REMOVE
//   - DEDUPLICATION & MERGING:同主题碎片归并,输出严格保持 4 种封闭类型之一
//   - PRUNING & COMPRESSION:删临时调试/错误日志/误存代码;相对日期转绝对日期
//   - NEVER invent new facts(铁律):保持用户偏好原样
// 执行:先读后写,原子完成。
// ═══════════════════════════════════════════════════════════════════

export function buildConsolidationPrompt(): string {
  return loadPromptOverride('CONSOLIDATE_PROMPT_FILE', builtinConsolidationPrompt()) + '\n' + EMOTIONAL_FIDELITY;
}

function builtinConsolidationPrompt(): string {
  return `${EMOTIONAL_FIDELITY}
情感整合保留事件原文，只提取有来源的关系/约定模式或分类纠正。旧约定被撤销时记录撤销日期及新条件，不删除历史约定。
输出完整 JSON 数组，只用 extract/reclassify/relate 或 keep；不需要操作时返回 []。`;
}

export const MEMORY_CONSOLIDATION_PROMPT: string = buildConsolidationPrompt();

/** 把整合 LLM 输出的动作规范化为 applyReflectActions 认识的 ReflectAction(keep 不落地,只计数) */
function normalizeConsolidationActions(raw: any): { actions: ReflectAction[]; kept: number; errors: string[] } {
  const list: any[] = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.actions) ? raw.actions : []);
  const actions: ReflectAction[] = [];
  let kept = 0;
  const errors: string[] = [];
  for (const a of list) {
    const action = a?.action;
    if (action === 'merge') {
      const ids = Array.isArray(a.sourceIds) ? a.sourceIds.filter((x: any) => typeof x === 'string' && x.length > 0) : [];
      if (ids.length >= 2 && typeof a.newText === 'string' && a.newText.trim().length > 0) {
        actions.push({ action: 'merge', sourceIds: ids, newText: a.newText, newMemType: isMemType(a.newMemType) ? a.newMemType : undefined });
      } else {
        errors.push('merge: need sourceIds(≥2) and newText, skipped');
      }
    } else if (action === 'delete') {
      if (typeof a.id === 'string' && a.id.length > 0) actions.push({ action: 'delete', targetId: a.id });
      else errors.push('delete: need id, skipped');
    } else if (['extract', 'reclassify', 'relate'].includes(action)) {
      actions.push({ ...a });
    } else if (action === 'keep') {
      if (typeof a.id === 'string' && a.id.length > 0) kept++;
      else errors.push('keep: need id, skipped');
    } else {
      errors.push(`unknown consolidation action: ${action || '(missing)'}, skipped`);
    }
  }
  return { actions, kept, errors };
}

export interface ConsolidateRunResult {
  ok: boolean;
  scanned: number;      // 扫描的 active 记忆条数
  candidates: number;   // 向量预筛出的候选对数(EMBED_MODE=none 全量扫兜底时为 0)
  merged: number;
  deleted: number;
  kept: number;
  actions: number;
  applied: number;
  errors: string[];
  skipped?: boolean;
  receipts?: ReflectReceipt[];
}

/**
 * v1.10: 记忆整合主流程 — 向量预筛 → LLM 整合 → applyReflectActions 原子执行。
 * - EMBED_MODE=none:预筛返回空 → LLM 全量扫兜底
 * - 有向量但无相似候选 → 直接返回空结果,不再调 LLM(省 token)
 */
export async function runConsolidate(
  charId: string = 'default',
  project?: string,
  threshold?: number,
  limit?: number,
): Promise<ConsolidateRunResult> {
  const base: ConsolidateRunResult = { ok: false, scanned: 0, candidates: 0, merged: 0, deleted: 0, kept: 0, actions: 0, applied: 0, errors: [] };
  if (!isReflectConfigured()) {
    return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过整合'] };
  }
  const proj = normalizeProject(project);

  // v1.11.2 memdir:逐 memType 库扫描并合并 —— 旧版只读 general:候选即便从别库产生,也会在下面
  // 的 `mems.filter(...)`(按候选 id 过滤)里被丢掉,等于白算。这里把各库并起来再按重要度截断。
  const mems: any[] = [];
  for (const mt of listMemTypeDirs(proj)) {
    try {
      mems.push(...(DatabaseManager.getInstance(project, mt).prepare(`
        SELECT id, mem_type, text, created_at, importance FROM memory
        WHERE is_active = 1 AND project = ? AND (locked IS NULL OR locked = 0)
        ORDER BY importance DESC, created_at DESC
        LIMIT 500
      `).all(proj) as any[]));
    } catch { /* 单个库读不到不影响其它库 */ }
  }
  mems.sort((a: any, b: any) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
  if (mems.length > 500) mems.length = 500;
  const scanned = mems.length;
  if (scanned < 2) {
    return { ...base, ok: true, scanned, skipped: true, errors: ['active 记忆不足 2 条,无需整合'] };
  }

  // 1. 向量预筛(EMBED_MODE=none 返回空 → 全量扫兜底)
  let candidates: SimilarCandidate[] = [];
  if (isEmbedEnabled()) {
    candidates = await findSimilarCandidates(proj, threshold ?? CONSOLIDATE_SIMILARITY, limit ?? CONSOLIDATE_MAX_PAIRS);
    if (candidates.length === 0) {
      // 有向量但确实无相似对 → 不再调 LLM,省 token
      return { ...base, ok: true, scanned, skipped: true, errors: ['无相似候选,无需整合'] };
    }
  }

  // 2. 组装 LLM 输入:向量模式 → 候选涉及的记忆;全量模式 → 全部记忆
  const candidateIds = new Set<string>();
  for (const p of candidates) { candidateIds.add(p.idA); candidateIds.add(p.idB); }
  const inputMems = candidates.length > 0 ? mems.filter(m => candidateIds.has(m.id)) : mems;
  const today = new Date().toISOString().slice(0, 10);
  const itemsJson = JSON.stringify(inputMems.map(m => ({
    id: m.id,
    memType: m.mem_type || 'general',
    text: m.text || '',
    createdAt: (m.created_at || '').slice(0, 10),
  })), null, 1);
  const pairsJson = JSON.stringify(candidates, null, 1);

  // 3. 最近对话转录(conversation_log,捕捉最新用户修正)
  let transcript = '';
  try {
    const convs = getRecentConversations(charId, 24 * 7, 20, proj);
    transcript = convs.map(c => (c as any).text).join('\n---\n');
  } catch { transcript = ''; }

  const userPrompt = `今天是 ${today}(相对日期转绝对日期时以此为准)。
请整合以下候选记忆,输出整合 JSON 数组。

【候选记忆】
${itemsJson}

【候选相似对】
${pairsJson}

【近期对话转录】
${transcript || '无近期对话转录'}`;

  const llm = await callLlm(buildConsolidationPrompt(), userPrompt, undefined, REFLECT_DEEP_MAX_TOKENS);
  if (!llm) return { ...base, scanned, candidates: candidates.length, errors: ['LLM 调用失败'] };
  if (llm.finishReason === 'length') return { ...base, scanned, candidates: candidates.length, errors: ['LLM 输出被截断；未应用整合'] };
  const parsed = parseJsonRobust(llm.content);
  if (!parsed) return { ...base, scanned, candidates: candidates.length, errors: ['未找到有效 JSON 结果'] };

  // 4. 规范化 + 原子执行(keep 不落地;merge/delete 复用 applyReflectActions)
  const norm = normalizeConsolidationActions(parsed);
  let r: { applied: number; errors: string[]; receipts: ReflectReceipt[] } = { applied: 0, errors: [], receipts: [] };
  if (norm.actions.length > 0) {
    try {
      r = await applyReflectActions(norm.actions, charId, proj, { automatic: true, allowedSourceIds: new Set(inputMems.map(m => m.id)) });
    } catch (e: any) {
      norm.errors.push(e.message);
    }
  }
  const merged = r.receipts.filter(x => x.action === 'merge' && x.status === 'applied').length;
  const deleted = r.receipts.filter(x => x.action === 'delete' && x.status === 'applied').length;

  return {
    ok: norm.errors.length === 0 && r.errors.length === 0,
    scanned,
    candidates: candidates.length,
    merged,
    deleted,
    kept: norm.kept,
    actions: norm.actions.length,
    applied: r.applied,
    errors: [...norm.errors, ...r.errors],
    receipts: r.receipts,
  };
}
