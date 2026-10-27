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
import { getUnanalyzedConversations, listAllMemories, applyReflectResult, applyReflectActions } from './reflect.js';
import { DatabaseManager, listMemTypeDirs, currentMemDir } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeProject, isEmbedEnabled, CHAR_ID } from './env.js';
import { isMemType } from './memType.js';
import { findSimilarCandidates, CONSOLIDATE_SIMILARITY, CONSOLIDATE_MAX_PAIRS } from './consolidate.js';
import { getRecentConversations } from './digest.js';
import { loadPromptOverride } from './promptFile.js';
import { callLlm, makeLlmChannel, parseJsonRobust, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
export { callLlm, makeLlmChannel, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
import { wholeRecordBatches, emotionalReflectPrompt, CONSOLIDATION_FIDELITY } from './reflectionFidelity.js';
import { markConversationsReflected, deepReflectionCursor } from './reflectionSources.js';
const FACT_EXTRACTION = (process.env.REFLECT_FACT_EXTRACTION || 'auto').trim().toLowerCase();
const MAX_FACTS = parseInt(process.env.REFLECT_MAX_FACTS || '15', 10) || 15;
// 启动自动反思触发阈值(条件达成后,下次启动 server 时自动执行一次)
const MIN_GAP_HOURS = (() => { const v = parseFloat(process.env.REFLECT_MIN_GAP_HOURS || '24'); return Number.isFinite(v) && v > 0 ? v : 24; })();
const MIN_UNANALYZED = (() => { const v = parseInt(process.env.REFLECT_MIN_UNANALYZED || '5', 10); return Number.isFinite(v) && v >= 0 ? v : 5; })();
// v1.10: 启动自动整合触发阈值(active 记忆条数 > 该值 → 下次启动自动整合一次)
const CONSOLIDATE_MIN_MEMORIES = (() => { const v = parseInt(process.env.CONSOLIDATE_MIN_MEMORIES || '15', 10); return Number.isFinite(v) && v >= 0 ? v : 15; })();
// 2026-10-23 审计:整合一次 ≈ 2.7 万 prompt + 1.2 万输出、多数 merged=0,而"记忆条数超过 15"永远成立,
// 导致每次桥启动(含重启风暴里每 25 秒一次)都重跑一遍。最小间隔 = 硬闸。
const CONSOLIDATE_MIN_INTERVAL_HOURS = (() => { const v = parseFloat(process.env.CONSOLIDATE_MIN_INTERVAL_HOURS || '6'); return Number.isFinite(v) && v >= 0 ? v : 6; })();
/**
 * v1.23.1: 反思失败退避。失败不写 reflect_summary → 24h 闸门永远"已到时间"，
 * 每次桥重启都会立刻重试同一批（content_filter/超时/超大 prompt 时尤其明显）。
 * 失败后至少隔这么久才允许下一次**自动**尝试；显式调用工具不受限制。
 */
const REFLECT_FAIL_BACKOFF_HOURS = (() => { const v = parseFloat(process.env.REFLECT_FAIL_BACKOFF_HOURS || '1'); return Number.isFinite(v) && v >= 0 ? v : 1; })();
function reflectStatePath(proj) {
    return path.join(currentMemDir(), `reflect-state-${proj}.json`);
}
function readReflectState(proj) {
    try {
        return JSON.parse(fs.readFileSync(reflectStatePath(proj), 'utf8'));
    }
    catch {
        return null;
    }
}
/** 只记"真正发起过 LLM 尝试"的一轮；跳过（无积压/未配置）不写状态。 */
function recordReflectAttempt(proj, ok, errors = [], processed = 0) {
    try {
        fs.mkdirSync(path.dirname(reflectStatePath(proj)), { recursive: true });
        fs.writeFileSync(reflectStatePath(proj), JSON.stringify({
            at: new Date().toISOString(), ok, processed, errors: errors.slice(0, 5),
        }), 'utf8');
    }
    catch { /* 状态写失败不影响主流程 */ }
}
/**
 * v1.11: LLM 通道 — 三通道架构(LLM1 triage / 向量模型 / LLM2 reflect)。
 * 构造 `${PREFIX}_LLM_URL / ${PREFIX}_LLM_API_KEY / ${PREFIX}_LLM_MODEL` 配置:
 *   优先取前缀通道自身值;缺省回退 REFLECT_*(旧单通道);再回退内置默认。
 *   供 triage(LLM1) 与 reflect(LLM2) 复用。
 */
export function isReflectConfigured() {
    return !!makeLlmChannel('reflect').apiKey;
}
export function isFactExtractionEnabled() {
    return FACT_EXTRACTION !== 'off';
}
/**
 * 启动自动反思条件检查(两个同时满足才反思):
 *   a. REFLECT_LLM_API_KEY 已配置
 *   b. 距上次反思 ≥ REFLECT_MIN_GAP_HOURS(默认 24h;从未反思 → 视为超时,满足)
 *   c. 未分析对话数 > REFLECT_MIN_UNANALYZED(默认 5)
 * 按 project 维度查询(默认项目用 charId + normalizeProject)。
 */
export function shouldAutoReflect(charId = CHAR_ID, project) {
    if (!isReflectConfigured()) {
        return { should: false, reason: 'REFLECT_LLM_API_KEY 未配置' };
    }
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    // v1.23.1: 失败退避放在最前 —— 上次尝试失败时，即便时间/积压都满足也不自动重试。
    const attempt = readReflectState(proj);
    if (attempt?.ok === false && attempt.at) {
        const ageMs = Date.now() - Date.parse(attempt.at);
        const floorMs = REFLECT_FAIL_BACKOFF_HOURS * 3600 * 1000;
        if (Number.isFinite(ageMs) && ageMs >= 0 && floorMs > 0 && ageMs < floorMs) {
            const first = attempt.errors?.[0] ? `：${String(attempt.errors[0]).slice(0, 80)}` : '';
            return { should: false, reason: `上次反思失败${first}；退避中 ${(ageMs / 3600000).toFixed(1)}h < ${REFLECT_FAIL_BACKOFF_HOURS}h` };
        }
    }
    // 最近一次反思时间(source='reflect_summary',按 project + 角色过滤)
    const last = db.prepare(`
    SELECT created_at FROM memory
    WHERE source = 'reflect_summary' AND project = ? AND character_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(proj, charId || CHAR_ID);
    const lastTime = last?.created_at ? new Date(last.created_at).getTime() : null;
    const hoursSince = lastTime === null
        ? Number.POSITIVE_INFINITY // 从未反思 → 视为超时,满足时间条件
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
export function shouldAutoConsolidate(project, characterId = CHAR_ID) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    const count = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active = 1 AND project = ? AND character_id = ?').get(proj, characterId || CHAR_ID)?.c ?? 0;
    const min = CONSOLIDATE_MIN_MEMORIES;
    if (count > min)
        return { should: true, count, min, reason: `${count} > ${min}` };
    return { should: false, count, min, reason: `${count} 未超 ${min}` };
}
/** Anima keeps its own emotional strategy; overrides receive the same fidelity guard. */
export function buildReflectSystemPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS) {
    const custom = loadPromptOverride('REFLECT_PROMPT_FILE', '');
    return (custom ? custom + '\n' : '') + emotionalReflectPrompt(factExtraction, maxFacts);
}
export function buildDeepReflectPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS) {
    const custom = loadPromptOverride('REFLECT_DEEP_PROMPT_FILE', '');
    return (custom ? custom + '\n' : '') + emotionalReflectPrompt(factExtraction, maxFacts);
}
/** 向后兼容：默认配置下的 prompt（外部可能仍引用这两个常量） */
export const REFLECT_SYSTEM_PROMPT = buildReflectSystemPrompt();
export const DEEP_REFLECT_PROMPT = buildDeepReflectPrompt();
/**
 * 多策略解析 LLM 返回的 JSON(容忍常见错误)
 * 支持 [...] 数组和 {...} 对象,以及 markdown 代码围栏包裹:
 *   - 数组 → 包成 { actions: [...] }(老 prompt 的只返回数组格式)
 *   - 对象 → 原样返回
 */
/**
 * facts 必须是 SPO 三元组对象。情感保真提示词只给了 `facts: []` 的形状，没有字段契约，
 * 模型经常写成字符串或 {sourceId,text}；这些条目进 facts 表会 NOT NULL 崩掉整批。
 * 这里按形状过滤：宁可少存事实，也不能让整轮反思作废。
 */
function coerceFacts(raw, max) {
    if (!Array.isArray(raw))
        return { facts: [], dropped: 0 };
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const facts = [];
    let dropped = 0;
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            dropped++;
            continue;
        }
        const subject = text(item.subject);
        const predicate = text(item.predicate);
        const object = text(item.object);
        if (!subject || !predicate || !object) {
            dropped++;
            continue;
        }
        const rawConfidence = Number(item.confidence);
        facts.push({
            subject,
            predicate,
            object,
            confidence: Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.6,
        });
        if (facts.length >= max)
            break;
    }
    return { facts, dropped };
}
/** 把 parseJsonRobust 结果规范化为 applyReflectResult 期望的 ReflectResult */
function normalizeReflectResult(parsed) {
    const out = { ...parsed };
    out.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    if (FACT_EXTRACTION === 'off') {
        out.facts = [];
        out.factsDropped = 0;
    }
    else {
        const { facts, dropped } = coerceFacts(parsed.facts, MAX_FACTS);
        out.facts = facts;
        out.factsDropped = dropped;
    }
    return out;
}
/** 日常反思:未分析对话 → 日记浓缩/提取 */
export async function runAutoReflect(charId, limit = 30, project) {
    const base = { ok: false, mode: 'auto', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const conversations = getUnanalyzedConversations(charId, undefined, limit, project);
        if (conversations.length === 0) {
            return { ...base, ok: true, conversationCount: 0, skipped: true, errors: ['无未分析对话'] };
        }
        const batches = wholeRecordBatches(conversations);
        const out = { ...base, conversationCount: conversations.length, processedCount: 0, deferredCount: conversations.length, receipts: [] };
        for (const batch of batches) {
            const llm = await callLlm(buildReflectSystemPrompt(), `请逐条分析完整情感对话：\n${JSON.stringify(batch)}`, undefined, REFLECT_DEEP_MAX_TOKENS);
            if (!llm || llm.finishReason === 'length') {
                out.errors.push(!llm ? 'LLM 调用失败' : 'LLM 输出被截断；本批未写入，保留待重试');
                break;
            }
            const parsed = parseJsonRobust(llm.content);
            if (!parsed || !Array.isArray(parsed.actions)) {
                out.errors.push('未返回完整 JSON actions；本批保留待重试');
                break;
            }
            const allowed = new Set(batch.map(c => c.id));
            const ids = parsed.processedSourceIds;
            if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !allowed.has(id))) {
                out.errors.push('缺少合法的 processedSourceIds；本批未写入，保留待重试');
                break;
            }
            const result = normalizeReflectResult(parsed);
            const r = await applyReflectResult(result, charId, project, { automatic: true, allowedSourceIds: allowed });
            out.actions += result.actions.length;
            out.applied += r.actionsApplied;
            out.factsInserted = (out.factsInserted || 0) + r.factsInserted;
            out.factsUpdated = (out.factsUpdated || 0) + r.factsUpdated;
            if (result.factsDropped) {
                (out.warnings ||= []).push(`丢弃 ${result.factsDropped} 条形状不符的 facts（需 subject/predicate/object）`);
            }
            for (const w of r.warnings || []) {
                (out.warnings ||= []).push(w);
                console.error('[reflect] warning:', w);
            }
            out.errors.push(...r.errors);
            out.receipts.push(...r.receipts);
            if (r.errors.length)
                break;
            markConversationsReflected(ids, project);
            out.processedCount += ids.length;
            out.deferredCount -= ids.length;
            if (ids.length < batch.length) {
                out.errors.push('本批部分来源尚未完成，保留待重试');
                break;
            }
        }
        out.ok = out.errors.length === 0;
        // v1.23.1: 记录本轮尝试（成功清除退避；失败触发 ≥1h 退避）
        recordReflectAttempt(normalizeProject(project), out.ok, out.errors, out.processedCount);
        return out;
    }
    catch (e) {
        recordReflectAttempt(normalizeProject(project), false, [e.message]);
        return { ...base, errors: [e.message] };
    }
}
/** 深度校准:全量记忆 → 去重/画像/图谱 */
export async function runDeepReflect(charId, limit = 500, project) {
    const base = { ok: false, mode: 'deep', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const memories = listAllMemories(charId, limit, project);
        if (memories.length === 0) {
            return { ...base, ok: true, memoryCount: 0, skipped: true, errors: ['库为空'] };
        }
        memories.sort((a, b) => a.id.localeCompare(b.id));
        const cursor = deepReflectionCursor(project);
        const nextIndex = memories.findIndex(m => m.id > cursor);
        if (nextIndex > 0)
            memories.push(...memories.splice(0, nextIndex));
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
        const out = { ...base, memoryCount: memories.length, processedCount: 0, receipts: [] };
        for (const batch of batches.slice(0, maxCalls)) {
            const llm = await callLlm(buildDeepReflectPrompt(), `请深度分析本批完整情感记忆：\n${JSON.stringify(batch)}`, undefined, REFLECT_DEEP_MAX_TOKENS);
            if (!llm || llm.finishReason === 'length') {
                out.errors.push(!llm ? 'LLM 调用失败' : 'LLM 输出被截断；本批未写入，游标不前进');
                break;
            }
            const parsed = parseJsonRobust(llm.content);
            if (!parsed || !Array.isArray(parsed.actions)) {
                out.errors.push('未返回完整 JSON actions；游标不前进');
                break;
            }
            const result = normalizeReflectResult(parsed);
            const r = await applyReflectResult(result, charId, project, { automatic: true, allowedSourceIds: new Set(batch.map(m => m.id)) });
            out.actions += result.actions.length;
            out.applied += r.actionsApplied;
            out.factsInserted = (out.factsInserted || 0) + r.factsInserted;
            out.factsUpdated = (out.factsUpdated || 0) + r.factsUpdated;
            out.errors.push(...r.errors);
            out.receipts.push(...r.receipts);
            if (r.errors.length)
                break;
            deepReflectionCursor(project, batch[batch.length - 1].id);
            out.processedCount += batch.length;
        }
        out.deferredCount = memories.length - out.processedCount;
        out.ok = out.errors.length === 0;
        return out;
    }
    catch (e) {
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
export function buildConsolidationPrompt() {
    // v1.23-fix: 任务提示词只描述"整合"；保真策略由 runConsolidate 以约束段追加
    // （CONSOLIDATION_FIDELITY），不再拼进任务提示词本身，避免覆盖 CONSOLIDATE_PROMPT_FILE 时丢约束。
    return loadPromptOverride('CONSOLIDATE_PROMPT_FILE', builtinConsolidationPrompt());
}
function builtinConsolidationPrompt() {
    return `你是记忆整合引擎(Memory Consolidator)。输入:
1. 候选记忆(带 id/memType/text/createdAt)
2. 候选相似对(向量预筛结果,可能为空)
3. 现有事实(判断非功能性冲突用)
4. 近期对话转录(捕捉最新用户决定)

任务是全量"去重 + 矛盾消解 + 主题归并"。先读后写,原子完成。

━━━━━━━━━━━━━━━━━━━━
【CONFLICT RESOLUTION(矛盾消解)】
- 记忆互相矛盾时,ALWAYS prefer the most recent user decision(以最近一次用户决定为准)。
- 被撤销/取代的旧约定用 merge 归并保留撤销日期与新条件;不要改写或删除情感事件原文。
- 用户偏好保持原样,不擅自改写。

【DEDUPLICATION & MERGING(去重归并)】
- 同主题碎片合并为一条整合后的 Markdown 文本(用 merge)。
- merge 输出的 newMemType 必须严格是 4 种封闭类型之一:user / feedback / project / reference。
- 不相关的主题不要合并;不同日期/主体/触发条件/承诺的情感事件不是重复。

【PRUNING & COMPRESSION(剪枝压缩)】
- 压缩临时调试步骤/错误日志/误存的代码片段。
- 相对日期转成绝对日期(如 "yesterday" → 今天日期,见输入顶部)。
- 唯一无重复的记忆 → keep 保留。

【NEVER invent new facts(铁律)】
- 绝不虚构输入中不存在的事实;用户偏好原文保留,不添加不存在的细节。

━━━━━━━━━━━━━━━━━━━━
【输出】只返回严格 JSON 数组,不要代码围栏,不要任何其他文字:
[
  {"action":"merge","sourceIds":["a","b"],"newText":"整合后的 Markdown 文本","newMemType":"feedback"},
  {"action":"delete","id":"c","reason":"被最新用户决定取代"},
  {"action":"invalidate","factId":"f1","reason":"这条事实已被新记忆明确推翻"},
  {"action":"keep","id":"d","reason":"唯一无重复"}
]
- merge 的 newMemType 必须属于 4 种封闭类型;不需要操作时返回 []。
- 只允许 merge / delete / invalidate / keep 四种 action。**不要输出 relate、boost、reclassify、split、extract 等其它动作**——执行器不认,会整条丢弃,白花 token。
- Anima 保真层不执行 delete（会被丢弃，且不删除任何情感事件）：冲突请用 merge 归并或 keep 保留。
- 只有"现有事实"里明确被推翻的条目才 invalidate（用给定 id），拿不准就 keep。`;
}
export const MEMORY_CONSOLIDATION_PROMPT = buildConsolidationPrompt();
/** 把整合 LLM 输出的动作规范化为 applyReflectActions 认识的 ReflectAction(keep 不落地,只计数) */
function normalizeConsolidationActions(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.actions) ? raw.actions : []);
    const actions = [];
    const invalidate = [];
    let kept = 0;
    const errors = [];
    for (const a of list) {
        const action = a?.action;
        if (action === 'merge') {
            const ids = Array.isArray(a.sourceIds) ? a.sourceIds.filter((x) => typeof x === 'string' && x.length > 0) : [];
            if (ids.length >= 2 && typeof a.newText === 'string' && a.newText.trim().length > 0) {
                actions.push({ action: 'merge', sourceIds: ids, newText: a.newText, newMemType: isMemType(a.newMemType) ? a.newMemType : undefined });
            }
            else {
                errors.push('merge: need sourceIds(≥2) and newText, skipped');
            }
        }
        else if (action === 'delete') {
            if (typeof a.id === 'string' && a.id.length > 0)
                actions.push({ action: 'delete', targetId: a.id });
            else
                errors.push('delete: need id, skipped');
        }
        else if (action === 'keep') {
            if (typeof a.id === 'string' && a.id.length > 0)
                kept++;
            else
                errors.push('keep: need id, skipped');
        }
        else if (action === 'invalidate') {
            // v1.23 非功能性冲突：新记忆明确推翻旧事实 → 旧事实只打 valid_to，保留历史
            if (typeof a.factId === 'string' && a.factId.length > 0)
                invalidate.push(a.factId);
            else
                errors.push('invalidate: need factId, skipped');
        }
        else if (action === 'extract') {
            // v1.23-fix: 整合不是重新提取。以前这里放行 extract，配合保真提示词会把整合变成逐条
            // 重摘要（净增记忆、merged 恒 0）。现在明确拒绝，让提示词/解析不一致立刻暴露。
            errors.push('extract 不属于整合动作（整合只允许 merge/delete/invalidate/keep），skipped');
        }
        else {
            errors.push(`unknown consolidation action: ${action || '(missing)'}, skipped`);
        }
    }
    return { actions, kept, invalidate, errors };
}
/**
 * v1.10: 记忆整合主流程 — 向量预筛 → LLM 整合 → applyReflectActions 原子执行。
 * - EMBED_MODE=none:预筛返回空 → LLM 全量扫兜底
 * - 有向量但无相似候选 → 直接返回空结果,不再调 LLM(省 token)
 */
export async function runConsolidate(charId = CHAR_ID, project, threshold, limit, opts = {}) {
    const base = { ok: false, scanned: 0, candidates: 0, merged: 0, deleted: 0, kept: 0, actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过整合'] };
    }
    const force = opts.force === true;
    const proj = normalizeProject(project);
    // v1.11.2 memdir:逐 memType 库扫描并合并 —— 旧版只读 general:候选即便从别库产生,也会在下面
    // 的 `mems.filter(...)`(按候选 id 过滤)里被丢掉,等于白算。这里把各库并起来再按重要度截断。
    // v1.23: critical(核心记忆)与 cold(冷存)一律不进入整合窗口 —— 这是"哪些不参加新沉淀"的唯一入口。
    // v1.23 轮转：窗口 = "重要度前 300" + "最久未更新 200" 两片各自保底。
    // 只取重要度会让低分老记忆永远轮不到；若先合并再按重要度截断到 500，最久那 200 条会被整片丢掉
    // （Full 现网实现的缺陷），所以这里先定 head=top300，再从最久片补满 200，合计 ≤500。
    // v1.24: 角色隔离 — 整合窗口只含本实例角色(charId='any' 关闭过滤)。
    const cid = charId || CHAR_ID;
    const windowWhere = `is_active = 1 AND project = ? AND (? = 'any' OR character_id = ?) AND (locked IS NULL OR locked = 0)
        AND COALESCE(tier, 'standard') <> 'critical'
        AND COALESCE(status, '') <> 'cold'`;
    const headRows = [];
    const tailRows = [];
    const headSeen = new Set();
    const tailSeen = new Set();
    for (const mt of listMemTypeDirs(proj)) {
        try {
            const db = DatabaseManager.getInstance(project, mt);
            for (const r of db.prepare(`
        SELECT id, mem_type, text, created_at, importance, COALESCE(updated_at, created_at) AS stale_at FROM memory
        WHERE ${windowWhere}
        ORDER BY importance DESC, created_at DESC
        LIMIT 300
      `).all(proj, cid, cid)) {
                if (!headSeen.has(r.id)) {
                    headSeen.add(r.id);
                    headRows.push(r);
                }
            }
            for (const r of db.prepare(`
        SELECT id, mem_type, text, created_at, importance, COALESCE(updated_at, created_at) AS stale_at FROM memory
        WHERE ${windowWhere}
        ORDER BY COALESCE(updated_at, created_at) ASC
        LIMIT 200
      `).all(proj, cid, cid)) {
                if (!tailSeen.has(r.id)) {
                    tailSeen.add(r.id);
                    tailRows.push(r);
                }
            }
        }
        catch { /* 单个库读不到不影响其它库 */ }
    }
    headRows.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    if (headRows.length > 300)
        headRows.length = 300;
    // 时间列同样混有 ISO "T…Z" 与 SQLite "YYYY-MM-DD HH:MM:SS"，排序前先归一化成时间戳。
    const staleTs = (v) => { const t = Date.parse(String(v || '').replace(' ', 'T')); return Number.isFinite(t) ? t : 0; };
    tailRows.sort((a, b) => staleTs(a.stale_at) - staleTs(b.stale_at));
    const mems = [...headRows];
    const windowPicked = new Set(mems.map((m) => m.id));
    let tailAdded = 0;
    for (const r of tailRows) {
        if (tailAdded >= 200)
            break;
        if (windowPicked.has(r.id))
            continue;
        windowPicked.add(r.id);
        mems.push(r);
        tailAdded++;
    }
    if (mems.length > 500)
        mems.length = 500;
    const scanned = mems.length;
    if (scanned < 2) {
        return { ...base, ok: true, scanned, skipped: true, errors: ['active 记忆不足 2 条,无需整合'] };
    }
    const windowIds = new Set(mems.map((m) => m.id));
    // 1. 向量预筛(EMBED_MODE=none 返回空 → 全量扫兜底)
    let candidates = [];
    if (isEmbedEnabled()) {
        candidates = await findSimilarCandidates(proj, threshold ?? CONSOLIDATE_SIMILARITY, limit ?? CONSOLIDATE_MAX_PAIRS, cid);
        // v1.23: 候选对必须两端都在本次窗口内 —— 否则模型会拿到窗口外的 id，动作必被
        // `allowedSourceIds` 拒绝（"target is outside the current reflection input" 的根因）。
        const before = candidates.length;
        candidates = candidates.filter(p => windowIds.has(p.idA) && windowIds.has(p.idB));
        if (candidates.length !== before) {
            console.error(`[consolidate] 候选对裁剪：${before} → ${candidates.length}（窗口外 ${before - candidates.length} 对）`);
        }
        if (candidates.length === 0) {
            // 有向量但窗口内确实无相似对 → 不再调 LLM,省 token
            return { ...base, ok: true, scanned, skipped: true, errors: ['无相似候选,无需整合'] };
        }
    }
    // 2. 组装 LLM 输入:向量模式 → 候选涉及的记忆;全量模式 → 全部记忆
    const candidateIds = new Set();
    for (const p of candidates) {
        candidateIds.add(p.idA);
        candidateIds.add(p.idB);
    }
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
        transcript = convs.map(c => c.text).join('\n---\n');
    }
    catch {
        transcript = '';
    }
    // 3.5 现有事实（用于非功能性冲突裁决）：同一 subject 下互斥的旧事实打 valid_to，不删除。
    //     只取高置信度、上限 80 条，避免把 prompt 撑大。Anima 的 facts 表恒在 general 库。
    let factRows = [];
    try {
        factRows = DatabaseManager.getInstance(proj).prepare(`
      SELECT id, subject, predicate, object, confidence FROM facts
      WHERE is_active = 1 AND project = ? AND (? = 'any' OR character_id = ?) AND confidence >= 0.6
        AND (valid_to IS NULL OR valid_to = '')
      ORDER BY updated_at DESC LIMIT 80
    `).all(proj, cid, cid);
    }
    catch { /* facts 表不存在时忽略 */ }
    const factsJson = JSON.stringify(factRows.map(f => ({ id: f.id, s: f.subject, p: f.predicate, o: f.object })), null, 1);
    // 4. 输入指纹门：整合是"每次启动跑一次整库"的重活，输入没变时重复调用纯烧 token。
    // 指纹相同则成功结果复用 7 天、失败复用 1 小时（重启风暴里不会反复重烧）。
    const fingerprint = crypto.createHash('sha1')
        .update((candidates.length
        ? candidates.map(p => `${p.idA}|${p.idB}`).sort().join(',')
        : `all:${scanned}`) + '#' + inputMems.map(m => `${m.id}:${m.text || ''}`).join('\u0001')
        + '#' + factRows.map(f => `${f.id}:${f.object}`).join('|'))
        .digest('hex');
    const statePath = path.join(currentMemDir(), `consolidate-state-${proj}.json`);
    const readState = () => { try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
    catch {
        return null;
    } };
    const writeState = (ok, merged) => {
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({ fingerprint, at: new Date().toISOString(), ok, merged, scanned, candidates: candidates.length }), 'utf8');
        }
        catch { /* 状态写失败不影响主流程 */ }
    };
    const prevState = readState();
    if (!force && prevState) {
        const age = Date.now() - Date.parse(prevState.at);
        if (Number.isFinite(age) && age >= 0) {
            const sameInput = prevState.fingerprint === fingerprint;
            const unchangedTtl = prevState.ok && sameInput ? 7 * 24 * 3600 * 1000 : 0;
            const floorMs = CONSOLIDATE_MIN_INTERVAL_HOURS * 3600 * 1000;
            let reason = '';
            if (unchangedTtl && age < unchangedTtl) {
                reason = `输入未变（上次 ${(age / 3600000).toFixed(1)}h 前, merged=${prevState.merged ?? 0}）`;
            }
            else if (age < floorMs) {
                reason = `距上次整合 ${(age / 3600000).toFixed(1)}h,未到最小间隔 ${CONSOLIDATE_MIN_INTERVAL_HOURS}h`;
            }
            if (reason) {
                console.error(`[consolidate] 跳过：${reason}`);
                return { ...base, ok: true, scanned, candidates: candidates.length, skipped: true, errors: [] };
            }
        }
    }
    const userPrompt = `今天是 ${today}(相对日期转绝对日期时以此为准)。
请整合以下候选记忆,输出整合 JSON 数组。

【候选记忆】
${itemsJson}

【候选相似对】
${pairsJson}

【现有事实（判断矛盾用；新记忆明确推翻某条时，输出 {"action":"invalidate","factId":"事实id","reason":"…"}）】
${factsJson}

【近期对话转录】
${transcript || '无近期对话转录'}`;
    // v1.23-fix: 整合的系统提示词必须始终是"整合"任务；保真策略只作为约束段追加。
    // 不能用反思段的保真提示词替换整个 system prompt（那会明令禁止 merge、只给 extract 格式，
    // 整合于是退化成逐条重摘要：每次净增 N 条记忆、merged 永远 0）。
    const systemPrompt = buildConsolidationPrompt() + '\n' + CONSOLIDATION_FIDELITY;
    const llm = await callLlm(systemPrompt, userPrompt, undefined, REFLECT_DEEP_MAX_TOKENS);
    if (!llm) {
        writeState(false, 0);
        return { ...base, scanned, candidates: candidates.length, errors: ['LLM 调用失败'] };
    }
    if (llm.finishReason === 'length') {
        writeState(false, 0);
        return { ...base, scanned, candidates: candidates.length, errors: ['LLM 输出被截断；未应用整合'] };
    }
    const parsed = parseJsonRobust(llm.content);
    if (!parsed) {
        writeState(false, 0);
        return { ...base, scanned, candidates: candidates.length, errors: ['未找到有效 JSON 结果'] };
    }
    // 5. 规范化 + 原子执行(keep 不落地;merge/delete 复用 applyReflectActions)
    const norm = normalizeConsolidationActions(parsed);
    // v1.23-fix: Anima 的保真策略等价于 evidence —— 不删除情感事件，delete 一律丢弃（只记一行日志）。
    // 不丢的话 applyReflectActions 会把 delete 整条拒绝，导致整批 ok=false、每轮重试同一批输入。
    {
        const before = norm.actions.length;
        norm.actions = norm.actions.filter(a => a.action !== 'delete');
        const dropped = before - norm.actions.length;
        if (dropped > 0)
            console.error(`[consolidate] 保真策略(evidence)丢弃 ${dropped} 条 delete 动作（只保留可回查的合并）`);
    }
    // v1.23 诊断：模型返回了内容却零动作时，把"看到了什么"打出来，用于排查"花了 1.5 万 token 却 merged=0"。
    if (norm.actions.length === 0 && norm.invalidate.length === 0) {
        const parsedKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12) : [];
        const rawCount = Array.isArray(parsed) ? parsed.length
            : (parsed && Array.isArray(parsed.actions) ? parsed.actions.length : 0);
        const head160 = String(llm.content || '').replace(/\s+/g, ' ').slice(0, 160);
        console.error(`[consolidate] 零动作：parsed keys=[${parsedKeys.join(',')}] 动作数=${rawCount} kept=${norm.kept} 内容头160="${head160}"`);
    }
    let r = { applied: 0, errors: [], receipts: [] };
    if (norm.actions.length > 0) {
        try {
            // v1.23-fix: consolidation 模式只放行 merge（合并结果落库后再软删源，内容可回查）。
            r = await applyReflectActions(norm.actions, charId, proj, { automatic: true, consolidation: true, allowedSourceIds: new Set(inputMems.map(m => m.id)) });
        }
        catch (e) {
            norm.errors.push(e.message);
        }
    }
    const merged = r.receipts.filter(x => x.action === 'merge' && x.status === 'applied').length;
    const deleted = r.receipts.filter(x => x.action === 'delete' && x.status === 'applied').length;
    // v1.23 失效旧事实（不删除）：只对明确被推翻的 factId 打 valid_to（仅 is_active=1 且尚有效）
    let invalidated = 0;
    if (norm.invalidate.length > 0) {
        try {
            const now = new Date().toISOString();
            const db = DatabaseManager.getInstance(proj);
            const stmt = db.prepare("UPDATE facts SET valid_to = ?, updated_at = ? WHERE id = ? AND is_active = 1 AND (valid_to IS NULL OR valid_to = '')");
            for (const fid of norm.invalidate.slice(0, 50))
                invalidated += stmt.run(now, now, fid).changes;
        }
        catch (e) {
            norm.errors.push(`invalidate: ${e.message}`);
        }
    }
    const ok = norm.errors.length === 0 && r.errors.length === 0;
    writeState(ok, merged);
    return {
        ok,
        scanned,
        candidates: candidates.length,
        merged,
        deleted,
        kept: norm.kept,
        actions: norm.actions.length,
        applied: r.applied,
        invalidated,
        errors: [...norm.errors, ...r.errors],
        receipts: r.receipts,
    };
}
//# sourceMappingURL=reflectDriver.js.map