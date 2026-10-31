#!/usr/bin/env node
/**
 * Castalia Anima Memory MCP Server v1.0 — 通用版基底 + Anima 情感层(第4轮融合)
 *
 * 以通用版 refs/index.ts 为基底(register() 分组包装 / MCP_TOOLS 环境变量控制注册集 /
 * 统一信封 {ok, op, count, ...} / memory_context / consolidate_deep / instruction_* / project_list),
 * 叠加 Anima 情感层:
 *   - mood_journal(admin)、user_observe(harness) 两个情感工具
 *   - auto_process 的 moodValue/moodReason 透传、memory_save 的 emotionalImpact
 *   - context_get 返回 agent 状态(state/bias/profile) + 记忆上下文
 *   - CHAR_ID 默认 airi(env.ts),MCP_TOOLS 默认注册全部(airi 主系统依赖 harness/admin 组)
 */
// ⚠️ 必须第一个 import:加载 config.json 覆盖环境变量(嵌入/反思配置)
// 坑13:模块加载顺序决定 env 覆盖生效 — env.ts/ollama.ts/reflectDriver.ts 在读取 env 前不能先被 import
import './configLoader.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchMemory, searchFacts, getRecentMemories, searchMemoryAcross, hydrateParentExcerpts } from './search.js';
import { recallForInjection } from './recallForInjection.js';
import { factsAsOf } from './bitemporal.js';
import { applyWindowRepairs, planWindowRepairs } from './factWindows.js';
import { parseTagsSafe } from './tags.js';
import { saveMemory, forgetMemory, updateMemory, saveConversationTurn, cleanupExpiredMemories, batchEmbedPending, markColdMemories } from './store.js';
import { consolidate } from './consolidate.js';
import { DatabaseManager, listProjectNames, listMemTypeDirs, safeFilePart, currentMemDir, sweepExpiredSessionMemories } from './db.js';
import { getCategoryTree } from './category.js';
import { runDigest, getRecentConversations, maybeDigest } from './digest.js';
import { localDayOf } from './dayKey.js';
import { flushAllBuffers } from './buffer.js';
import { reflect, getAllMemories, getMemoryGraph, REFLECT_SYSTEM_PROMPT, getUnanalyzedConversations, applyReflectResult } from './reflect.js';
import { findEntities, entityFacts, entityMemories, entityGraphSlice, expandEntityGraph, conflictsReport, entityStats } from './entities.js';
import { autoProcess } from './autoProcessor.js';
import { runAutoReflect, runDeepReflect, shouldAutoReflect, runConsolidate, shouldAutoConsolidate } from './reflectDriver.js';
import { ensureSeedInstructions, saveInstruction, getInstruction, listInstructions, deleteInstruction } from './instructions.js';
import { CHAR_ID, PROJECT_ID, SERVER_NAME, SERVER_VERSION, normalizeProject, getPersona } from './env.js';
import { MEM_TYPES, MEM_TYPE_LABELS, summarizeForIndex } from './memType.js';
import { fedSearchAll, resolveFedLibraries } from './federation/index.js';
import { runReflectAll } from './reflectAll.js';
// Anima 情感层
import { getAgentState } from './agentState.js';
import { getPsycheState, absoluteMoodScalar, deviationMoodScalar } from './psycheState.js';
import { runSelfCycle } from './selfCycle.js';
import { syncTavernChat } from './tavern.js';
import { getBiasPrompt, loadBiasesFromDb } from './bias.js';
import { getUserProfilePrompt, loadUserProfilesFromDb, observeUserMessage } from './userLearning.js';
import { queueForVad, formatInteractionForVad } from './emotion.js';

console.log = console.error;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function ok(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}
function err(msg: string, code = 'ERROR') {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message: msg } }, null, 2) }], isError: true as const };
}
/**
 * 当前心情(−10..+10) —— 传给检索层做情绪一致性重排、传给注入层做"难过不翻旧账"。
 *
 * `psycheState` 是传感器证据驱动的短期状态，存在证据时它是唯一 affect
 * owner；显式 `moodValue` 仍由 AgentState 保留，作为传感器尚未产出证据时
 * 的 override/fallback。这样同一轮检索不会在三套情绪真值之间随机切换。
 * 参数顺序保留为 (project, characterId)，兼容原有调用方。
 *
 * 2026-10-31：返回的是**相对平时的偏置**（deviation），不是绝对愉悦度。
 * 检索层问的是"比平时更冷还是更暖"；绝对数值（她平时就是 +4）走 absoluteMoodScalar，
 * 用在提示词/展示，不参与一致性重排（否则一致性回忆会被永久推向正向记忆）。
 */
function currentMood(project?: string, characterId: string = CHAR_ID): number | undefined {
  try {
    const psyche = getPsycheState(characterId, project);
    if (psyche.hasEvidence) {
      const deviation = deviationMoodScalar(psyche.vad, psyche.baseline);
      if (deviation !== undefined) return deviation;
    }
    const m = Number(getAgentState(characterId, project).getSnapshot().currentMood);
    return Number.isFinite(m) ? m : undefined;
  } catch { return undefined; }
}

/** Compose the human-readable state block from the same psyche snapshot that
 * context_get returns as JSON. AgentState still owns energy/desire and explicit
 * mood history, but its independent mood line is omitted once sensor evidence
 * exists so prompts cannot see contradictory affect values. */
function unifiedStatePrompt(state: ReturnType<typeof getAgentState>, psyche: ReturnType<typeof getPsycheState>): string {
  const snapshot = state.getSnapshot();
  // 2026-10-31：与 currentMood 同一处修复 —— 绝对心境不再被相对 band 清零。
  const scalar = psyche.hasEvidence
    ? (absoluteMoodScalar(psyche.vad) ?? snapshot.currentMood)
    : snapshot.currentMood;
  const deviation = psyche.hasEvidence
    ? Number(psyche.vad.valence) - Number(psyche.baseline.valence)
    : 0;
  const moodDesc = psyche.hasEvidence
    ? (psyche.band === 'positive' ? '偏正向' : psyche.band === 'negative' ? '偏负向' : '中性')
    : scalar >= 6 ? '非常开心' : scalar >= 3 ? '心情不错' : scalar >= -2 ? '心情平静' : scalar >= -5 ? '有点低落' : '心情不好';
  const lines = [
    '[Anima 当前状态]',
    `情绪指数：${scalar >= 0 ? '+' : ''}${scalar.toFixed(1)}（${moodDesc}）`,
    `精力值：${snapshot.energy}/100`,
    '状态来源：内部情感传感器估计，不是用户事实；仅用于调整回应，不可被模型改写。',
  ];
  if (psyche.hasEvidence) {
    // 把「绝对值 / 相对平时的偏差 / 标签 / 是否有证据」分开写，避免下游把三种量混用。
    lines.push(`传感器状态：${psyche.band}（v=${psyche.vad.valence.toFixed(2)} a=${psyche.vad.arousal.toFixed(2)} d=${psyche.vad.dominance.toFixed(2)}；相对基线 ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)}，证据 ${psyche.hasEvidence ? '有效' : '已过期'}）`);
  }
  if (snapshot.currentDesire) lines.push(`当前想法：${snapshot.currentDesire}`);
  if (snapshot.moodHistory.length > 0 && !psyche.hasEvidence) {
    lines.push(`最近经历：${snapshot.moodHistory.slice(-3).map(e => e.reason).join('、')}`);
  }
  return lines.join('\n');
}

/**
 * The one explicit reader for self-cycle output.
 *
 * Diary rows are derived observations, so every default path (search, recall,
 * injection, reflect, consolidate, facts, entities) excludes them. That left
 * the whole self-cycle write-only: nothing ever read what it produced. This
 * helper returns the newest diary for a role so a caller can opt in via
 * `context_get { includeDiary: true }` without widening any default filter.
 */
function latestSelfDiary(project: string): {
  id: string;
  text: string;
  createdAt: string;
  evidenceIds: string[];
  stateVersion: number;
} | null {
  try {
    const db = DatabaseManager.getInstance(project, 'project');
    const row = db.prepare(`
      SELECT id, text, created_at AS createdAt, metadata
      FROM memory
      WHERE source = 'agent_diary' AND subject = 'self' AND project = ?
        AND character_id = ? AND is_active = 1
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1
    `).get(project, CHAR_ID) as any;
    if (!row) return null;
    let meta: any = {};
    try { meta = JSON.parse(String(row.metadata || '{}')); } catch { /* legacy diary */ }
    return {
      id: String(row.id),
      text: String(row.text || ''),
      createdAt: String(row.createdAt || ''),
      evidenceIds: Array.isArray(meta?.evidence_ids) ? meta.evidence_ids.map(String) : [],
      stateVersion: Number(meta?.state_version) || 1,
    };
  } catch {
    // A project without a `project` memType bank simply has no diary yet.
    return null;
  }
}

/** Sweep every known project for pending affect work. */
function scheduleDigestSweep(): void {
  const projects = new Set<string>([normalizeProject()]);
  try {
    for (const project of listProjectNames()) projects.add(normalizeProject(project));
  } catch (e: any) {
    console.error('[digest] project scan failed:', e?.message || e);
  }
  for (const project of projects) {
    try {
      maybeDigest(CHAR_ID, project)?.catch((e: any) => console.error('digest error:', e));
    } catch (e: any) {
      console.error('digest check error:', e?.message || e);
    }
  }
}
// ── 可选 HTTP 健康检查(默认关闭;设 HEALTH_PORT 才监听,供容器/编排/验证探活)──
const _healthPort = parseInt(process.env.HEALTH_PORT || '0', 10);
if (_healthPort > 0) {
  import('node:http').then((http) => {
    const _h = http.createServer((_req: any, res: any) => {
      if (_req.url !== '/health' && _req.url !== '/') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: SERVER_NAME, version: SERVER_VERSION }));
    });
    _h.listen(_healthPort, '127.0.0.1');
    console.error(`[health] listening on http://127.0.0.1:${_healthPort}/`);
  }).catch((e: any) => console.error('[health] init failed:', e.message));
}


/** 人格声明行:[角色声明] 我是 <name>(charId=<charId>) [。人格设定:<persona>](persona 非空时) */
function roleDeclaration(): string {
  const p = getPersona();
  return p.persona
    ? `[角色声明] 我是 ${p.name}(charId=${p.charId}) 。人格设定:${p.persona}`
    : `[角色声明] 我是 ${p.name}(charId=${p.charId})`;
}

// ═══════════════════════════════════════════════════════════════════
// Memory Snapshot Warning(借鉴 Claude Code retriever.ts formatRetrievedMemoryForPrompt)
// 记忆年龄 ≥ 1 天视为历史快照,注入时追加警告;否则返回 null
// ═══════════════════════════════════════════════════════════════════
function memorySnapshotWarn(createdAt: string): string | null {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays < 1) return null;
  let dateText: string;
  try { dateText = localDayOf(d); } catch { return null; }
  return `> ⚠️ [Memory Snapshot Warning] 该记忆记录于 ${dateText}(约 ${diffDays} 天前),属于历史快照,引用前请以最新对话/代码为准`;
}

// ═══════════════════════════════════════════════════════════════════
// 工具分级(借鉴 engram ProfileAgent/ProfileAdmin)
// 暴露面原则:主 Agent 只读(search/get/recent/fact/graph),
// 写入与管线工具归 harness,管理工具归 admin(console)。
// 环境变量 MCP_TOOLS: 逗号分隔的 profile 或工具名;Anima 默认全部注册(all)。
//   MCP_TOOLS=all    → 全部注册(默认;airi 主系统 proxy.py 依赖 harness/admin 组)
//   MCP_TOOLS=agent  → 仅 agent 组
//   MCP_TOOLS=agent,admin → agent + admin 两组
// ═══════════════════════════════════════════════════════════════════

const TOOL_GROUPS: Record<string, string[]> = {
  agent: ['memory_search', 'memory_get', 'memory_recent', 'memory_index', 'fact_search', 'fact_as_of', 'memory_graph', 'entity_lookup'],
  harness: ['auto_process', 'conversation_save', 'tavern_sync', 'digest_run', 'self_cycle', 'reflect_auto', 'reflect_deep', 'reflect_batch_embed', 'memory_save', 'memory_update', 'memory_delete', 'memory_log', 'instruction_save', 'user_observe'],
  admin: ['memory_list', 'stats_get', 'recent_conversations', 'daily_summary_data', 'reflect_analyze', 'reflect_apply', 'memory_context', 'context_get', 'project_list', 'project_create', 'memory_search_all', 'reflect_all', 'instruction_list', 'instruction_delete', 'consolidate_deep', 'mood_journal', 'facts_windows_plan', 'facts_windows_apply'],
  // v1.26: 前端存储桥(AIRI 这类"每个角色一套记忆"的客户端当持久层用)
  store: ['memory_store_list', 'memory_store_save', 'memory_store_forget', 'memory_recall'],
  // v1.27: 实体层 —— 按实体名查事实/记忆,以及事实失效(矛盾)报告
  entity: ['entity_lookup', 'facts_conflicts_report'],
};

function resolveTools(input: string | undefined): Set<string> | null {
  if (!input || input === 'all') return null; // null = 注册全部
  const result = new Set<string>();
  for (const token of input.split(',').map(t => t.trim())) {
    if (token === 'all') return null;
    if (TOOL_GROUPS[token]) TOOL_GROUPS[token].forEach(t => result.add(t));
    else result.add(token);
  }
  return result;
}

const TOOL_ALLOWLIST = resolveTools(process.env.MCP_TOOLS);
const TOOL_GROUP_OF: Record<string, string> = {};
for (const [g, tools] of Object.entries(TOOL_GROUPS)) for (const t of tools) TOOL_GROUP_OF[t] = g;

function shouldRegister(name: string): boolean {
  if (TOOL_ALLOWLIST === null) return true;
  if (TOOL_ALLOWLIST.has(name)) return true;
  if (TOOL_ALLOWLIST.has('admin') || TOOL_ALLOWLIST.has('harness') || TOOL_ALLOWLIST.has('agent')) return false; // profile 已展开,不再匹配
  return false;
}

function register(name: string, group: string, description: string, schema: any, handler: (args: any) => any) {
  if (!shouldRegister(name)) {
    if (process.env.MCP_LOG_TOOLS === '1') console.error(`[tools] skipped: ${name} (group=${group})`);
    return;
  }
  server.tool(name, description, schema, handler);
}

register('tavern_sync', 'harness', 'Synchronize the selected SillyTavern chat snapshot in an isolated project; edits, swipes and deletions replace previous versions. No emotion/profile/reflection processing.', {
  project: z.string().regex(/^st_[a-f0-9]{40}$/),
  messages: z.array(z.object({
    id: z.string().min(1).max(120),
    role: z.enum(['user', 'assistant']),
    name: z.string().min(1).max(200),
    text: z.string().min(1).max(100000),
    createdAt: z.string().optional(),
  })).max(5000),
  replace: z.boolean().optional().describe('Allow a smaller snapshot to replace (soft-delete) the existing chat history. Without it a windowed subset is rejected.'),
}, async (args) => {
  try { return ok({ op: 'tavern_sync', ...syncTavernChat(args.project, args.messages, { replace: args.replace }) }); }
  catch (e: unknown) { return err(e instanceof Error ? e.message : String(e), 'TAVERN_SYNC_FAILED'); }
});

// ═══════════════════════════════════════════════════════════════════
// 搜索类工具（LLM 可见）
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_search', 'agent',
  'Search past memories using tag-first then vector KNN fallback. Use when recalling past events, facts, or user preferences.',
  {
    query: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Max results (default 5)'),
    category: z.string().optional().describe('Filter by category'),
    memType: z.enum(MEM_TYPES).optional().describe('按用途过滤:user=AI对用户画像,feedback=行为纠正,project=情感记忆,reference=外部链接,general=默认'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    projects: z.array(z.string()).optional().describe('Cross-library search: search several libraries in one call (e.g. ["default","shared"]). "*" or ["all"] = every library of this instance. Omit for single-library search. Each result carries its source library in "project".'),
    fullText: z.boolean().optional().describe('Return complete Anima records for companion context injection'),
  },
  async (args) => {
    try {
      const r = args.projects && args.projects.length > 0
        ? await searchMemoryAcross({ query: args.query, topK: args.topK ?? 5, category: args.category, memType: args.memType, projects: args.projects })
        : await searchMemory({ query: args.query, topK: args.topK ?? 5, profile: 'balanced', category: args.category, memType: args.memType, characterId: CHAR_ID, project: args.project, mood: currentMood(args.project, CHAR_ID) });
      return ok({
        op: 'search',
        query: args.query,
        count: r.length,
        results: r.map(m => ({
          project: m.project,
          id: m.id,
          text: !args.fullText && m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: !args.fullText && m.text.length > 200,
          subject: m.subject,
          kind: m.type === 'episodic' ? 'episode' : m.type === 'semantic' ? 'reflection' : m.type,
          memType: m.memType,
          category: m.category,
          importance: m.importance,
          score: m.score,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容；Full 汇总库由 AIRI 接入层独立读取',
      });
    } catch (e: any) { return err(e.message, 'SEARCH_FAILED'); }
  }
);

register(
  'fact_search', 'agent',
  'Search structured facts (subject-predicate-object triples) about the user.',
  {
    query: z.string().describe('Query text'),
    subject: z.enum(['user', 'agent', 'environment']).optional(),
    topK: z.number().optional().describe('Max results (default 5)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await searchFacts(args.query, { subject: args.subject, topK: args.topK ?? 5, minConfidence: 0.3, project: args.project, characterId: CHAR_ID });
      return ok({
        op: 'fact_search',
        query: args.query,
        count: r.length,
        results: r.map(f => ({
          id: f.id,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          confidence: f.confidence,
          similarity: f.similarity,
        })),
      });
    } catch (e: any) { return err(e.message, 'FACT_SEARCH_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 存储类工具
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_save', 'harness',
  'Store a new memory or update existing one by exact text match. When memType is one of user/feedback/project/reference, the text is auto-wrapped into Markdown structure (# heading + - list items).',
  {
    text: z.string().min(1, 'text 不能为空').describe('Memory content'),
    type: z.enum(['episodic', 'semantic', 'entity', 'preference']).optional().default('episodic'),
    memType: z.enum(MEM_TYPES).optional().describe('用途维度:user=AI对用户画像,feedback=行为纠正,project=情感记忆(情感分区),reference=外部链接,general=默认;非general强制Markdown结构'),
    category: z.string().optional().default('general'),
    tags: z.array(z.string()).optional().default([]),
    emotionalImpact: z.number().min(0).max(10).optional().describe('Anima: emotional impact scalar (0-10). The VAD three-dimensional layer is written back separately by the emotion pipeline.'),
    importance: z.number().optional().default(0.5),
    tier: z.enum(['temporary', 'standard', 'critical']).optional().default('standard'),
    source: z.string().optional(),
    subject: z.enum(['user', 'self', 'environment']).optional().default('user'),
    skipEmbed: z.boolean().optional().default(false),
    expiresAt: z.string().optional().describe('Custom expiration (ISO datetime) for temporary memories. Overrides the default 3-day TTL. Also honored on standard/critical tiers when explicitly set.'),
    sessionId: z.string().optional().describe('Session identifier for session-scoped memories (stored in session_id column). Reserved for session-level retrieval (next version).'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await saveMemory({ text: args.text, project: args.project, sessionId: args.sessionId, type: args.type, memType: args.memType, category: args.category, tags: args.tags, emotionalImpact: args.emotionalImpact, importance: args.importance, tier: args.tier, source: args.source, subject: args.subject, characterId: CHAR_ID, skipEmbed: args.skipEmbed, expiresAt: args.expiresAt });
      return ok({ id: r.id, text: r.text.substring(0, 100), type: r.type, memType: r.memType, category: r.category });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'memory_delete', 'harness',
  'Soft-delete a memory by ID.',
  { id: z.string().describe('Memory ID to delete'), project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    const ok_ = forgetMemory(args.id, args.project, CHAR_ID);
    return ok({ deleted: ok_ });
  }
);

register(
  'memory_update', 'harness',
  'Update memory fields (text, category, tags, importance, etc.).',
  {
    id: z.string().describe('Memory ID'),
    text: z.string().optional(),
    memType: z.enum(MEM_TYPES).optional().describe('设置用途维度:user=AI对用户画像,feedback=行为纠正,project=情感记忆,reference=外部链接,general=默认'),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().optional(),
    tier: z.string().optional(),
    pinned: z.boolean().optional().describe('情感锚点:钉住的那条注入时无条件在场(告白/转折/约定),不再依赖相似度'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await updateMemory(args.id, args as any, CHAR_ID);
      return ok(r ? { updated: true, id: r.id, memType: (r as any).mem_type || 'general' } : { updated: false, error: 'not found' });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 认知记录工具 — agent 显式沉淀(决策/模式/错误)
// 结构化认知:agent 边干活边"教"记忆体,跨会话复用
// 检索:memory_search(category=decision|pattern|mistake)
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_log', 'harness',
  'Log a cognitive entry (decision/pattern/mistake) with kind. Internal mapping: decision→category=decision, pattern→knowledge+tag, mistake→category=mistake+tier=critical. Searchable via memory_search(category=...).',
  {
    kind: z.enum(['decision', 'pattern', 'mistake']).describe('Kind of cognitive entry'),
    text: z.string().max(2000).describe('The content: decision rationale / pattern insight / mistake lesson'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const kind = args.kind as 'decision' | 'pattern' | 'mistake';
      const map = {
        decision: { type: 'episodic', category: 'decision', importance: 0.6, tier: 'standard', tags: args.tags ?? [] },
        pattern: { type: 'semantic', category: 'knowledge', importance: 0.6, tier: 'standard', tags: ['pattern', ...(args.tags ?? [])] },
        mistake: { type: 'episodic', category: 'mistake', importance: 0.7, tier: 'critical', tags: args.tags ?? [] },
      } as const;
      const conf = map[kind];
      const r = await saveMemory({
        text: args.text, project: args.project, type: conf.type, category: conf.category,
        tags: conf.tags, importance: conf.importance, tier: conf.tier,
        source: 'agent_log', characterId: CHAR_ID,
      });
      return ok({ id: r.id, kind, category: conf.category, tier: conf.tier });
    } catch (e: any) { return err(e.message, 'LOG_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 对话自动化工具（proxy.py 内部调用）
// ═══════════════════════════════════════════════════════════════════

register(
  'auto_process', 'harness',
  '[Internal] Process a conversation turn: save to log, update agent mood, observe user, queue VAD analysis. Called automatically after each LLM response.',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().min(-10).max(10).optional(),
    moodReason: z.string().optional(),
    sessionId: z.string().optional().describe('Session identifier for progressive in-session reflection (rolls session memory, promotes long-term facts). Omit to keep the legacy behavior (no session buffer).'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      // v1.24: 角色由进程级 CHAR_ID 决定,不再接受调用方指定的 characterId(防跨角色伪造写入)
      const cid = CHAR_ID;
      const r = await autoProcess({ userMessage: args.userMessage, assistantMessage: args.assistantMessage, characterId: cid, moodValue: args.moodValue, moodReason: args.moodReason, sessionId: args.sessionId, project: args.project });
      // Trigger event-driven digest
      maybeDigest(cid, args.project)?.catch(() => {});
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'digest_run', 'harness',
  '[Internal] Run the digest cycle: flush VAD queue, cleanup expired memories, restore lost critical memories.',
  { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      flushAllBuffers(); // 周期兜底:强制 flush 所有会话 buffer(补漏未达阈值的尾部消息)
      const r = await runDigest(CHAR_ID, args.project);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'self_cycle', 'harness',
  '[Internal] Run one bounded self-cycle: read recent conversation evidence and write one provenance-marked diary entry. Diary entries never become conversation evidence or VAD queue items.',
  {
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    limit: z.number().int().min(1).max(20).optional().default(6),
    hoursBack: z.number().min(1).max(24 * 30).optional().default(48),
    minIntervalHours: z.number().min(0).max(24 * 30).optional().default(6),
  },
  async (args) => {
    try {
      const r = await runSelfCycle({
        project: args.project,
        limit: args.limit,
        hoursBack: args.hoursBack,
        minIntervalHours: args.minIntervalHours,
      });
      return ok({ op: 'self_cycle', ...r });
    } catch (e: any) { return err(e.message, 'SELF_CYCLE_FAILED'); }
  }
);

register(
  'conversation_save', 'harness',
  '[Internal] Save a raw conversation turn to the log (no analysis, no embedding).',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().min(-10).max(10).optional(),
    moodReason: z.string().optional(),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await saveConversationTurn(args.userMessage, args.assistantMessage, CHAR_ID, args.moodValue, args.moodReason, args.project);
      // Keep the direct harness entry consistent with auto_process: enqueue
      // immediately after the durable row exists. The pending marker still
      // lets the minute sweep recover this item after a restart.
      if (r?.id) queueForVad(formatInteractionForVad(args.userMessage, args.assistantMessage), args.project, r.id, CHAR_ID);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文/状态工具
// ═══════════════════════════════════════════════════════════════════

register(
  'context_get', 'admin',
  'Get agent state (mood/energy/desire), bias layer, user profile, and memory context summary for prompt injection.',
  {
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    includeDiary: z.boolean().optional().describe('Opt in to the newest self-cycle diary as an explicitly-labelled derived observation. Default false: diary rows never enter ordinary context.'),
  },
  async (args) => {
    try {
      const proj = normalizeProject(args.project);
      const p = getPersona();
      const state = getAgentState(CHAR_ID, args.project);
      const psyche = getPsycheState(CHAR_ID, proj);
      const bias = getBiasPrompt(CHAR_ID, args.project);
      const profile = getUserProfilePrompt(CHAR_ID, 'default', args.project);
      const recent = getRecentMemories(CHAR_ID, 5, 24, proj);
      const diary = args.includeDiary === true ? latestSelfDiary(proj) : null;
      // memdir 分库:总数跨 user/feedback/project/reference/general 聚合(v1.24: 只数本角色)
      const total = DatabaseManager.queryAll<{ c: number }>(args.project,
        "SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')", [proj, CHAR_ID])
        .reduce((n, r) => n + (r.c || 0), 0);
      const stateText = roleDeclaration() + '\n' + unifiedStatePrompt(state, psyche)
        + (diary
          ? '\n派生观察（自我日记，不是用户事实，仅作背景）：' + diary.text.replace(/\s+/g, ' ').trim().slice(0, 240)
          : '')
      return ok({
        op: 'context',
        state: stateText,
        // Only present when explicitly requested; typed as a derived record.
        ...(diary ? { derivedDiary: { ...diary, derived: true } } : {}),
        psyche: {
          band: psyche.hasEvidence ? psyche.band : 'neutral',
          hasEvidence: psyche.hasEvidence,
          vad: psyche.vad,
          // 2026-10-31：显式分开，别让调用方把「相对 band」当「绝对心境」用。
          absoluteValence: Number(psyche.vad.valence),
          deviationFromBaseline: Number(psyche.vad.valence) - Number(psyche.baseline.valence),
          arousal: Number(psyche.vad.arousal),
          moodScalar: absoluteMoodScalar(psyche.vad) ?? null,
          updatedAt: new Date(psyche.updatedAt).toISOString(),
        },
        persona: { charId: p.charId, name: p.name, persona: p.persona },
        bias,
        profile,
        recentMemories: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
        stats: { total },
        project: proj,
      });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文包工具 — 借鉴 engram mem_context / memory-os fabric_brief
// 一次调用拿到组装好的注入上下文:近期 + 相关 + 认知记录 + 事实
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_context', 'admin',
  'Assemble an injection-ready context bundle: recent important memories + memories related to the current task (optional query) + cognitive logs (decisions/mistakes/patterns) + key facts. Call at session start or when you need memory context.',
  {
    query: z.string().optional().describe('Current task/topic to find related memories (optional)'),
    hoursBack: z.number().optional().describe('Window for recent memories (default 48h)'),
    recentLimit: z.number().optional().describe('Max recent memories (default 5)'),
    relatedLimit: z.number().optional().describe('Max related memories (default 5)'),
    asText: z.boolean().optional().describe('Return ready-to-inject prompt text (default true)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    sessionId: z.string().optional().describe('Session identifier to inject its rolling session memory (progressive in-session reflection snapshot) into the prompt.'),
    path: z.string().optional().describe('Current file path for glob-filtered instructions (e.g. src/components/Button.tsx). Instructions whose paths pattern does not match are skipped.'),
  },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance(args.project);
      // v1.23.2-fix: 限幅（负数 LIMIT 在 SQLite 里等于无上限）
      const clampInt = (v: any, def: number, min: number, max: number) => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
      };
      const hoursBack = clampInt(args.hoursBack ?? 48, 48, 1, 8760);
      const recentLimit = clampInt(args.recentLimit ?? 5, 5, 1, 50);
      const relatedLimit = clampInt(args.relatedLimit ?? 5, 5, 1, 50);
      const proj = normalizeProject(args.project);
      const state = getAgentState(CHAR_ID, proj);
      const psyche = getPsycheState(CHAR_ID, proj);

      // 1. 近期重要记忆
      const recent = getRecentMemories(CHAR_ID, recentLimit, hoursBack, proj);

      // 2. 与当前任务相关的记忆(向量搜索)
      let related: any[] = [];
      if (args.query) {
        const r = await searchMemory({ query: args.query, topK: relatedLimit, profile: 'balanced', characterId: CHAR_ID, project: proj, mood: currentMood(proj, CHAR_ID) });
        related = r.map(m => ({ id: m.id, text: m.text, category: m.category, importance: m.importance, score: m.score, createdAt: m.createdAt, parentId: m.parentId || null }));
      }

      // 2.5 v1.23 Parent-Child 原文回捞：命中的是提炼记忆(leaf)，按 parent_id 取对话原文。
      //     策略照 llama_index AutoMergingRetriever：同父命中比例 > 50% 或 parent 短 → 整段；
      //     否则按 leaf 正文锚点截窗口（pre-400/post-800），总预算 3k 字符 / 最多 3 个 parent。
      const hydrated = related.length > 0
        ? hydrateParentExcerpts(proj, related, { budget: 3000, maxParents: 3, characterId: CHAR_ID })
        : [];

      // 3. 认知记录(决策/错误/模式)—— 跨分类库聚合(decision/mistake 可能落在 project 库)
      const cognitives = DatabaseManager.queryAll<any>(proj, `
        SELECT text, category, importance, created_at FROM memory
        WHERE is_active = 1 AND project = ? AND character_id = ?
          AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')
          AND (category IN ('decision','mistake') OR tags LIKE '%pattern%')
        ORDER BY created_at DESC LIMIT 9
      `, [proj, CHAR_ID]).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 9);

      // 4. 关键事实(高置信度)
      // v1.23.1: 只注入当前有效事实；被新值推翻的旧事实保留在库里（valid_to 有值）但不再进 prompt
      // v1.24: 角色隔离 — 只注入本角色事实
      const facts = db.prepare(`
        SELECT subject, predicate, object, confidence FROM facts
        LEFT JOIN memory source_memory ON source_memory.id = facts.source_memory_id
        WHERE facts.is_active = 1 AND facts.project = ? AND facts.character_id = ? AND facts.confidence >= 0.7
          AND (facts.valid_to IS NULL OR facts.valid_to = '')
          AND COALESCE(facts.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
        ORDER BY facts.confidence DESC, facts.created_at DESC LIMIT 5
      `).all(proj, CHAR_ID) as any[];

      // 4.5 记忆索引层(4 种封闭类型,轻量摘要 — 对应 Claude Code MEMORY.md,先索引后详情)
      //     这 4 类各自独立成库,必须跨库聚合;只读 general 会恒空。
      const indexRows = DatabaseManager.queryAll<any>(proj, `
        SELECT id, mem_type, substr(text, 1, 150) AS summary, length(text) AS full_len, updated_at
        FROM memory
        WHERE is_active = 1 AND project = ? AND character_id = ?
          AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')
          AND mem_type IN ('user','feedback','project','reference')
        ORDER BY updated_at DESC
        LIMIT 10
      `, [proj, CHAR_ID]).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 10);
      const indexLayer = indexRows.map((row: any) => {
        const s = row.summary || '';
        return {
          id: row.id,
          memType: row.mem_type || 'general',
          summary: row.full_len > 150 ? summarizeForIndex(s, 149) : s,
        };
      });

      // 0. 三层指令记忆(全局→用户→项目;拼接顺序 L1→L2→L3,L3 在 Prompt 末尾约束最高)
      //    path 可选:对带 paths 的指令做 glob 过滤
      const instructions = getInstruction(proj, args.path);

      // memdir 分库:统计跨全部分类库(v1.24: 只统计本角色)
      const total = DatabaseManager.queryAll<{ c: number }>(proj,
        "SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')", [proj, CHAR_ID])
        .reduce((n, r) => n + (r.c || 0), 0);
      const stats = { c: total };

      // 5. Ground Truth 提示词组装(人格声明在最前,指令分节次之)
      const sections: string[] = [];
      sections.push(roleDeclaration());
      sections.push(unifiedStatePrompt(state, psyche));
      if (instructions.length > 0) {
        const lines = instructions.map(i => {
          const base = i.scope === 'global' ? '[全局]' : i.scope === 'user' ? '[用户]' : '[项目]';
          const pathTag = i.paths && i.paths.length ? ` ${i.paths.join(', ')}` : '';
          return `${base}${pathTag} ${i.content}`;
        });
        sections.push(`【指令(全局→项目,项目约束最高)】\n${lines.join('\n')}`);
      }

      // 0.5 会话滚动状态(可选 sessionId):渐进式临时反思的滚动快照注入
      if (args.sessionId) {
        const sess = db.prepare(`
          SELECT text FROM memory
          WHERE is_active = 1 AND project = ? AND session_id = ? AND source = 'session_memory' AND character_id = ?
          ORDER BY updated_at DESC LIMIT 1
        `).get(proj, args.sessionId, CHAR_ID) as any;
        if (sess?.text) {
          sections.push(`\n■ 会话滚动状态(会话 ${args.sessionId},以此为准,勿重复询问):`);
          sections.push(sess.text);
        }
      }

      sections.push(`【当前记忆上下文】总记忆 ${stats.c} 条。请优先参考以下记忆,它们是之前会话沉淀的事实与经验:`);

      if (recent.length > 0) {
        sections.push(`\n■ 近期重要记忆(近 ${hoursBack} 小时):`);
        recent.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.category}] ${m.text}${m.importance >= 0.8 ? ' (重要)' : ''}`);
          const warn = memorySnapshotWarn(m.createdAt);
          if (warn) sections.push(`  ${warn}`);
        });
      }

      if (related.length > 0) {
        sections.push(`\n■ 与当前任务相关:「${args.query}」`);
        related.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.category}] ${m.text}`);
          const warn = memorySnapshotWarn(m.createdAt);
          if (warn) sections.push(`  ${warn}`);
        });
      }

      if (hydrated.length > 0) {
        sections.push(`\n■ 原文回捞（上面命中的是提炼记忆，以下是它对应的对话原文，用于核对细节）:`);
        hydrated.forEach((h, i) => sections.push(`${i + 1}. (来源 ${h.parentId.slice(0, 8)}，命中比 ${h.ratio}${h.mode === 'full' ? '，整段' : h.mode === 'head' ? '，锚点未命中取开头' : '，命中片段'}) ${h.excerpt}`));
      }

      if (cognitives.length > 0) {
        sections.push(`\n■ 经验沉淀(决策/错误/模式):`);
        cognitives.forEach((m: any, i: number) => {
          const tag = m.category === 'mistake' ? '⚠️教训' : m.category === 'decision' ? '🎯决策' : '📐模式';
          sections.push(`${i + 1}. ${tag} ${m.text}`);
        });
      }

      if (facts.length > 0) {
        sections.push(`\n■ 已知事实:`);
        facts.forEach((f: any, i: number) => {
          sections.push(`${i + 1}. ${f.subject} — ${f.predicate}: ${f.object}`);
        });
      }

      if (indexLayer.length > 0) {
        sections.push(`\n■ 记忆索引(仅摘要,详情用 memory_get(id) 展开):`);
        indexLayer.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.memType}] ${m.summary} (id: ${m.id})`);
        });
      }

      sections.push(`\n【要求】以上记忆来自用户的真实历史,与当前任务相关时请直接使用,不要重新询问用户已知信息。`);

      // v1.23.2-fix: 总预算封顶
      const PROMPT_BUDGET = 24000;
      let promptText = sections.join('\n');
      if (promptText.length > PROMPT_BUDGET) {
        promptText = promptText.slice(0, PROMPT_BUDGET) + `\n…（已截断，原始 ${sections.join('\n').length} 字，必要时用 memory_get/memory_search 精确取）`;
      }

      const bundle = {
        prompt: promptText,
        psyche: {
          band: psyche.hasEvidence ? psyche.band : 'neutral',
          hasEvidence: psyche.hasEvidence,
          vad: psyche.vad,
          // 2026-10-31：显式分开，别让调用方把「相对 band」当「绝对心境」用。
          absoluteValence: Number(psyche.vad.valence),
          deviationFromBaseline: Number(psyche.vad.valence) - Number(psyche.baseline.valence),
          arousal: Number(psyche.vad.arousal),
          moodScalar: absoluteMoodScalar(psyche.vad) ?? null,
          updatedAt: new Date(psyche.updatedAt).toISOString(),
        },
        instructions,
        recent: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
        related,
        hydrated,
        cognitives: cognitives.map(m => ({ text: m.text, category: m.category })),
        facts,
        index: indexLayer,
        stats: { total: stats.c },
        injectedAt: new Date().toISOString(),
      };

      return ok(args.asText === false ? bundle : { prompt: bundle.prompt });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'stats_get', 'admin',
  'Get memory system statistics: total count, by category, by source.',
  { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const proj = normalizeProject(args.project);
      // memdir:聚合项目全部分类库统计(v1.24: 只统计本角色)
      let total = 0;
      const byCategory: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const byMemType: Record<string, number> = {};
      for (const mt of listMemTypeDirs(proj)) {
        const db = DatabaseManager.getInstance(proj, mt);
        total += (db.prepare("SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").get(proj, CHAR_ID) as any).c;
        for (const r of db.prepare("SELECT category,COUNT(*) as c FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') GROUP BY category").all(proj, CHAR_ID) as any[]) {
          byCategory[r.category] = (byCategory[r.category] || 0) + r.c;
        }
        for (const r of db.prepare("SELECT source,COUNT(*) as c FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') GROUP BY source").all(proj, CHAR_ID) as any[]) {
          bySource[r.source] = (bySource[r.source] || 0) + r.c;
        }
        for (const r of db.prepare("SELECT mem_type,COUNT(*) as c FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') GROUP BY mem_type").all(proj, CHAR_ID) as any[]) {
          byMemType[r.mem_type] = (byMemType[r.mem_type] || 0) + r.c;
        }
      }
      return ok({
        op: 'stats',
        total,
        byCategory: Object.entries(byCategory).map(([category, c]) => ({ category, c })),
        bySource: Object.entries(bySource).map(([source, c]) => ({ source, c })),
        byMemType: Object.entries(byMemType).map(([mem_type, c]) => ({ mem_type, c })),
        characterId: CHAR_ID,
        project: proj,
      });
    } catch (e: any) { return err(e.message, 'STATS_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 情感层工具(Anima)
// mood_journal:情绪历史;user_observe:用户沟通模式学习
// ═══════════════════════════════════════════════════════════════════

register(
  'user_observe', 'harness',
  '[Internal] Observe a user message for communication pattern learning.',
  {
    message: z.string().describe('User message to learn from'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      observeUserMessage(CHAR_ID, 'default', args.message, args.project);
      return ok({ observed: true });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'mood_journal', 'admin',
  'Get mood history for the past N days.',
  {
    days: z.number().optional().default(7),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const proj = normalizeProject(args.project);
      // Normalize once before scanning memType partitions.  Passing an
      // omitted project into listMemTypeDirs used to reach safeFilePart(undefined)
      // and made the default mood journal fail instead of returning history.
      const dbs = listMemTypeDirs(proj).map(mt => DatabaseManager.getInstance(proj, mt));
      const p = getPersona();
      const since = new Date(Date.now() - (args.days || 7) * 86400000).toISOString();
      return ok({
        op: 'mood_journal',
        days: args.days,
        project: proj,
        persona: { charId: p.charId, name: p.name, persona: p.persona },
        // 自循环日记是派生观察，不是事件情绪证据；情绪历史默认只读原始记忆。
        moods: dbs.flatMap(db => db.prepare("SELECT emotional_impact as value, created_at, text, category FROM memory WHERE is_active=1 AND project=? AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') AND (category='emotional' OR category='mood_snapshot' OR tier='temporary') AND created_at>? ORDER BY created_at DESC LIMIT 30").all(proj, CHAR_ID, since)).sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30),
      });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 记忆列表/图谱工具
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_list', 'admin',
  'List active memories, optionally filtered. Admin tool: hard limit 50 to protect context.',
  {
    limit: z.number().max(50).optional().default(50).describe('Max results (hard cap 50)'),
    category: z.string().optional(),
    source: z.string().optional(),
    memType: z.enum(MEM_TYPES).optional().describe('按用途过滤:user=AI对用户画像,feedback=行为纠正,project=情感记忆,reference=外部链接,general=默认'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const memories = getAllMemories(CHAR_ID, args.limit, args.project);
      let filtered = memories;
      if (args.category) filtered = filtered.filter((m: any) => m.category === args.category);
      if (args.source) filtered = filtered.filter((m: any) => m.source === args.source);
      if (args.memType) filtered = filtered.filter((m: any) => m.memType === args.memType);
      const sliced = filtered.slice(0, args.limit);
      return ok({
        op: 'list',
        count: sliced.length,
        results: sliced.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          memType: m.memType || 'general',
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'LIST_FAILED'); }
  }
);

register(
  'memory_get', 'agent',
  'Get one memory by ID with full text. Use to expand a search/recent/list result.',
  {
    id: z.string().describe('Memory ID'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      // memdir:按 id 遍历项目分类库定位(v1.24: 只认本角色的记忆,跨角色 id 一律 not found)
      const proj = normalizeProject(args.project);
      let db: any = null;
      let row: any = null;
      for (const mt of listMemTypeDirs(proj)) {
        const d = DatabaseManager.getInstance(proj, mt);
        const r = d.prepare("SELECT * FROM memory WHERE id = ? AND is_active = 1 AND character_id = ? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").get(args.id, CHAR_ID) as any;
        if (r) { db = d; row = r; break; }
      }
      if (!row) return err('memory not found: ' + args.id, 'NOT_FOUND');
      // v1.3: 访问一次 → 热度 +1(配合热度升格:accessed_count ≥ 阈值自动升 tier)
      // 2026-10-31: 同时写 memory_access_log。这条路径原来只加计数不写日志,
      // 于是库里 accessed_count 已经 565、日志 0 行 —— ACT-R 的间隔效应完全拿不到数据。
      const accessedAt = new Date().toISOString();
      db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?')
        .run(accessedAt, args.id);
      try {
        db.prepare('INSERT INTO memory_access_log (memory_id, project, accessed_at, channel) VALUES (?, ?, ?, ?)')
          .run(args.id, proj, accessedAt, 'explicit_recall');
      } catch { /* 老库没有日志表:计数仍然生效 */ }
      let provenance: unknown = null;
      try {
        const parsed = row.metadata ? JSON.parse(String(row.metadata)) : null;
        provenance = parsed && typeof parsed === 'object' ? parsed : row.metadata || null;
      } catch { provenance = row.metadata || null; }
      return ok({
        op: 'get',
        result: {
          id: row.id,
          text: row.text,
          truncated: false,
          type: row.type,
          memType: row.mem_type || 'general',
          category: row.category,
          tags: parseTagsSafe(row.tags),
          importance: row.importance,
          tier: row.tier,
          source: row.source,
          subject: row.subject,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          metadata: {
            accessedCount: row.accessed_count + 1,
            referenceCount: row.reference_count,
            locked: row.locked === 1,
            provenance,
          },
        },
      });
    } catch (e: any) { return err(e.message, 'GET_FAILED'); }
  }
);

register(
  'memory_graph', 'agent',
  'Get the memory relationship graph. Neighborhood only: nodes capped by limit (default 50). via=memory 只给记忆↔记忆边;via=entity 追加实体节点/记忆↔实体/实体↔实体共现边;via=both(默认)全给。depth=实体扩散跳数(1-3)。',
  { limit: z.number().max(200).optional().default(50).describe('Max nodes (default 50)'),
    depth: z.number().min(1).max(3).optional().default(1).describe('实体层扩散跳数(1-3,v1.27;仅 via 含 entity 时生效)'),
    via: z.enum(['memory', 'entity', 'both']).optional().default('both').describe('memory=仅记忆关系图(旧行为);entity=加实体层;both=默认'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const g = getMemoryGraph(CHAR_ID, args.project);
      const limit = args.limit ?? 50;
      const via = args.via ?? 'both';
      const depth = args.depth ?? 1;
      const nodes: any[] = g.nodes.slice(0, limit).map((n: any) => ({ ...n, type: 'memory' }));
      const nodeIds = new Set(nodes.map((n: any) => n.id));
      const edges: any[] = g.edges
        .filter((e: any) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId))
        .map((e: any) => ({ ...e, kind: 'memory' }));

      let entityCount = 0;
      if (via !== 'memory') {
        try {
          // v1.27: 记忆图是跨 memType 聚合的(listAllMemories 会扫 project 下所有分类库),
          // 所以实体切片也必须逐库做 —— 否则只查 general 库,别的分类库里的节点永远匹配不到实体。
          const seenEntities = new Set<string>();
          const memTypes = listMemTypeDirs(normalizeProject(args.project));
          const memoryDbs = memTypes.map(mt => {
            try { return { db: DatabaseManager.getInstance(args.project, mt), memType: mt }; }
            catch { return null; }
          }).filter(Boolean) as any[];
          for (const mt of (memTypes.length ? memTypes : ['general'])) {
            let db: any;
            try { db = DatabaseManager.getInstance(args.project, mt); } catch { continue; }
            const slice = entityGraphSlice(db, [...nodeIds], limit, CHAR_ID, args.project, memoryDbs);
            for (const e of slice.entities) {
              if (nodes.length >= limit * 2) break;
              if (seenEntities.has(e.id)) continue;
              seenEntities.add(e.id);
              nodes.push({ id: e.id, type: 'entity', label: e.name, key: e.key, kind: e.kind, mentionCount: e.mention_count });
              entityCount++;
            }
            for (const me of slice.memoryEntityEdges) edges.push({ id: `${me.sourceId}~${me.targetId}`, sourceId: me.sourceId, targetId: me.targetId, relationType: 'mentions', kind: 'memory-entity' });
            for (const ee of slice.entityEntityEdges) edges.push({ id: `${ee.sourceId}~${ee.targetId}`, sourceId: ee.sourceId, targetId: ee.targetId, relationType: 'co_occurs', kind: 'entity-entity' });
          }
          // 兜底:本次节点集完全没有实体关联时(线上常见:按 importance 取的记忆里没有 facts),
          // 用"最近产出过事实的记忆"补一批种子,否则真实库上这张图永远是空的。
          if (entityCount === 0) {
            for (const mt of (memTypes.length ? memTypes : ['general'])) {
              if (entityCount > 0) break;
              let db: any;
              try { db = DatabaseManager.getInstance(args.project, mt); } catch { continue; }
              try {
                const seeds = (db.prepare(`SELECT DISTINCT me.memory_id AS id
                  FROM memory_entities me
                  JOIN entities e ON e.id = me.entity_id
                  WHERE COALESCE(e.kind, 'topic') NOT IN ('url', 'path', 'config', 'number')
                  LIMIT ?`).all(limit * 4) as any[]).map(r => r.id);
                if (!seeds.length) continue;
                const slice = entityGraphSlice(db, seeds, limit, CHAR_ID, args.project, memoryDbs);
                for (const e of slice.entities) {
                  if (nodes.length >= limit * 2) break;
                  if (seenEntities.has(e.id)) continue;
                  seenEntities.add(e.id);
                  nodes.push({ id: e.id, type: 'entity', label: e.name, key: e.key, kind: e.kind, mentionCount: e.mention_count, seeded: true });
                  entityCount++;
                }
                for (const me of slice.memoryEntityEdges) edges.push({ id: `${me.sourceId}~${me.targetId}`, sourceId: me.sourceId, targetId: me.targetId, relationType: 'mentions', kind: 'memory-entity' });
              } catch { /* 单库失败继续 */ }
            }
          }
          // depth>1:把实体的邻居实体也拉进来(变长路径,SQL 递归 CTE)
          if (depth > 1) {
            const extra = new Map<string, any>();
            for (const mt of (memTypes.length ? memTypes : ['general'])) {
              let db: any;
              try { db = DatabaseManager.getInstance(args.project, mt); } catch { continue; }
              for (const entityId of seenEntities) {
                const expanded = expandEntityGraph(db, String(entityId), depth, limit, CHAR_ID, args.project, memoryDbs);
                for (const e of expanded.entities) if (!seenEntities.has(e.id) && !extra.has(e.id)) extra.set(e.id, e);
              }
            }
            for (const e of extra.values()) {
              if (nodes.length >= limit * 2 + limit) break;
              nodes.push({ id: e.id, type: 'entity', label: e.name, key: e.key, kind: e.kind, mentionCount: e.mention_count, depth: e.depth });
              entityCount++;
            }
          }
        } catch { /* 实体层未迁移时退回纯记忆图 */ }
      }

      return ok({
        op: 'graph',
        count: nodes.length,
        entityCount,
        via,
        depth,
        nodes,
        edges,
        truncated: g.nodes.length > limit,
        hint: '图已按节点数截断,如需完整图用 Web Console',
      });
    } catch (e: any) { return err(e.message, 'GRAPH_FAILED'); }
  }
);

register(
  'entity_lookup', 'entity',
  '按实体名查记忆:归一化匹配实体 → 当前有效事实 + 相关记忆(1 跳)。等价于图数据库里的 (Entity)-[:MENTIONED_IN]->(Fact)->(Memory),但只需要一次 JOIN。',
  {
    name: z.string().min(1).describe('实体名/关键词(如 "猫"、"张三"、"Rust")'),
    at: z.string().optional().describe('时间点(ISO 字符串),返回该时刻有效的的历史事实;省略=现在'),
    characterId: z.string().optional().describe('Character/role id (default: process CHAR_ID)'),
    limit: z.number().min(1).max(50).optional().default(20),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    includeGraph: z.boolean().optional().default(false).describe('是否附带 1 跳实体邻居(共现实体)'),
  },
  async (args) => {
    try {
      const charId = storeCharacterId(args);
      const project = normalizeProject(args.project);
      const db = DatabaseManager.getInstance(project);
      const memoryDbs = listMemTypeDirs(project).map(mt => {
        try { return { db: DatabaseManager.getInstance(project, mt), memType: mt }; }
        catch { return null; }
      }).filter(Boolean) as any[];
      const candidates = findEntities(db, args.name, 5);
      if (candidates.length === 0) return ok({ op: 'entity_lookup', query: args.name, found: false, candidates: [], facts: [], memories: [], hint: '实体层里没有匹配;可能是历史数据尚未回填,或用词不同' });
      const entity = candidates[0];
      const facts = entityFacts(db, entity.id, args.at, args.limit, charId, project);
      const memories = entityMemories(db, entity.id, args.limit, charId, project, memoryDbs);
      const graph = args.includeGraph ? expandEntityGraph(db, entity.id, 1, args.limit, charId, project, memoryDbs) : null;
      return ok({
        op: 'entity_lookup', query: args.name, found: true,
        entity: { id: entity.id, key: entity.key, name: entity.name, mentionCount: entity.mention_count, kind: entity.kind },
        otherCandidates: candidates.slice(1).map((c: any) => ({ id: c.id, key: c.key, mentionCount: c.mention_count })),
        at: args.at ?? null,
        facts, memories,
        neighborEntities: graph ? graph.entities : undefined,
        counts: { facts: facts.length, memories: memories.length },
      });
    } catch (e: any) { return err(e.message, 'ENTITY_LOOKUP_FAILED'); }
  }
);

register(
  'facts_conflicts_report', 'entity',
  '事实健康度报告:被推翻的历史事实(valid_to 非空)+ 同一主体同一谓词下的当前多值(潜在矛盾)。用来确认"时间失效"路径真的在跑。',
  {
    limit: z.number().min(1).max(200).optional().default(50),
    characterId: z.string().optional().describe('Character/role id (default: process CHAR_ID)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const charId = storeCharacterId(args);
      const project = normalizeProject(args.project);
      const db = DatabaseManager.getInstance(project);
      const report = conflictsReport(db, args.limit ?? 50, charId, project);
      const stats = entityStats(db, charId, project);
      return ok({
        op: 'facts_conflicts_report',
        invalidatedCount: report.invalidated.length,
        multiValuedCount: report.multiValued.length,
        invalidated: report.invalidated,
        multiValued: report.multiValued,
        entityStats: stats,
        hint: report.invalidated.length === 0 ? '没有任何事实被推翻过 —— 要么还没出现功能性关系的新值,要么失效路径没被触发' : undefined,
      });
    } catch (e: any) { return err(e.message, 'CONFLICTS_REPORT_FAILED'); }
  }
);

register(
  'memory_recent', 'agent',
  'Get recent important memories (no vector search, just time+importance).',
  {
    limit: z.number().optional().default(5),
    hoursBack: z.number().optional().default(24),
    memType: z.enum(MEM_TYPES).optional().describe('按用途过滤:user=AI对用户画像,feedback=行为纠正,project=情感记忆,reference=外部链接,general=默认'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = getRecentMemories(CHAR_ID, args.limit, args.hoursBack, args.project, args.memType);
      return ok({
        op: 'recent',
        count: r.length,
        results: r.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          memType: m.memType,
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'RECENT_FAILED'); }
  }
);

register(
  'memory_index', 'agent',
  'Lightweight memory index (corresponds to Claude Code MEMORY.md): returns id + mem_type + 150-char summary per row, no full text. Use memory_get(id) to expand a summary into full detail (index-first, detail-after).',
  {
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    memType: z.enum(MEM_TYPES).optional().describe('按用途过滤:user=AI对用户画像,feedback=行为纠正,project=情感记忆,reference=外部链接,general=默认'),
    limit: z.number().max(100).optional().default(20).describe('Max index rows (default 20, hard cap 100)'),
  },
  async (args) => {
    try {
      const proj = normalizeProject(args.project);
      const limit = Math.min(args.limit ?? 20, 100);
      const conds = ['is_active = 1', 'project = ?', 'character_id = ?', "COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')"];
      const params: any[] = [proj, CHAR_ID];
      if (args.memType) { conds.push('mem_type = ?'); params.push(args.memType); }
      params.push(limit);
      // 索引层跨 5 个分类库聚合;每库先取 limit,再全局排序截断。
      const rows = DatabaseManager.queryAll<any>(proj, `
        SELECT id, mem_type, substr(text, 1, 150) AS summary, length(text) AS full_len, updated_at
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `, params).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, limit);
      return ok({
        op: 'index',
        count: rows.length,
        results: rows.map((row: any) => ({
          id: row.id,
          memType: row.mem_type || 'general',
          summary: row.summary,
          summaryTruncated: row.full_len > 150,
          updatedAt: row.updated_at,
        })),
        hint: '摘要层只含标题+150字。用 memory_get(id) 拉全文。',
      });
    } catch (e: any) { return err(e.message, 'INDEX_FAILED'); }
  }
);

register(
  'recent_conversations', 'admin',
  'Get recent conversation log entries.',
  {
    hoursBack: z.number().optional().default(24),
    limit: z.number().optional().default(50),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = getRecentConversations(CHAR_ID, args.hoursBack, args.limit, args.project);
      return ok({ count: r.length, results: r });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 反思工具
// ═══════════════════════════════════════════════════════════════════

register(
  'reflect_analyze', 'admin',
  'Get unanalyzed conversations bundled with system prompt for a big LLM to perform reflection.',
  { limit: z.number().optional().default(30),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const conversations = getUnanalyzedConversations(CHAR_ID, undefined, args.limit ?? 30, args.project);
      const prompt = JSON.stringify(conversations);
      return ok({
        conversationCount: conversations.length,
        systemPrompt: REFLECT_SYSTEM_PROMPT,
        userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt}`,
        conversationIds: conversations.map((c: any) => c.id),
      });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'reflect_apply', 'admin',
  'Apply reflection results (merge, extract, reclassify, delete actions).',
  {
    action: z.enum(['apply', 'preview']).optional().default('apply'),
    actions: z.string().describe('JSON array of reflection actions'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(args.actions);
      } catch {
        const m = args.actions.match(/```(?:json)?\s*([\s\S]*?)```/);
        parsed = m ? JSON.parse(m[1]) : JSON.parse(args.actions);
      }
      const r = await reflect(args.action, { actions: parsed, project: args.project, characterId: CHAR_ID });
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'reflect_auto', 'harness',
  'Run automatic reflection: feed unanalyzed conversations (or ALL memories when mode=deep) to the configured LLM, apply extracted actions. Requires REFLECT_LLM_API_KEY.',
  {
    limit: z.number().optional().default(30),
    mode: z.enum(['daily', 'deep']).optional().default('daily').describe('daily=unanalyzed conversations; deep=full calibration'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = args.mode === 'deep'
        ? await runDeepReflect(CHAR_ID, args.limit ?? 500, args.project)
        : await runAutoReflect(CHAR_ID, args.limit ?? 30, args.project);
      return ok({ op: args.mode === 'deep' ? 'reflect_deep' : 'reflect_auto', ...r });
    } catch (e: any) { return err(e.message, 'REFLECT_FAILED'); }
  }
);

register(
  'reflect_deep', 'harness',
  '[Legacy] Deep calibration. Use reflect_auto(mode="deep") instead.',
  { limit: z.number().optional().default(500),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const r = await runDeepReflect(CHAR_ID, args.limit ?? 500, args.project);
      return ok({ op: 'reflect_deep', ...r });
    } catch (e: any) { return err(e.message, 'REFLECT_FAILED'); }
  }
);

register(
  'reflect_batch_embed', 'harness',
  '[Internal] Batch embed all pending (un-embedded) memories. Called after reflect. characterId="any" embeds across all roles (e.g. reflect library).',
  { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    characterId: z.string().optional().describe('Character id filter (default CHAR_ID; "any" = no filter, e.g. for reflect library)') },
  async (args) => {
    try {
      const r = await batchEmbedPending(args.characterId ?? CHAR_ID, args.project);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 记忆整合工具(v1.10 Memory Consolidator)
// 向量预筛相似对 → LLM 去重/矛盾消解/主题归并 → 原子应用
// ═══════════════════════════════════════════════════════════════════

register(
  'consolidate_deep', 'admin',
  'Run memory consolidation: vector pre-screen similar pairs (cos > threshold) → LLM dedup/merge/conflict-resolution (MEMORY_CONSOLIDATION_PROMPT) → atomic apply. Requires REFLECT_LLM_API_KEY. No candidates → returns empty without calling LLM. EMBED_MODE=none falls back to LLM full scan.',
  {
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    threshold: z.number().optional().describe('Min cosine similarity for candidate pairs (default CONSOLIDATE_SIMILARITY=0.88)'),
    limit: z.number().optional().describe('Max candidate pairs (default 50)'),
  },
  async (args) => {
    try {
      // 手动/工具调用 = 显式意图,绕过"最小间隔"闸门(启动自动整合才受限)
      const r = await runConsolidate(CHAR_ID, args.project, args.threshold, args.limit, { force: true });
      return ok({ op: 'consolidate_deep', ...r });
    } catch (e: any) { return err(e.message, 'CONSOLIDATE_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 每日摘要工具
// ═══════════════════════════════════════════════════════════════════

register(
  'daily_summary_data', 'admin',
  'Get conversation and auto-process data for the past N hours.',
  { hoursBack: z.number().optional().default(24),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance(args.project);
      const since = new Date(Date.now() - (args.hoursBack || 24) * 3600000).toISOString();
      const proj = normalizeProject(args.project);
      const convs = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='conversation_log' AND project=? AND character_id=? AND created_at>? ORDER BY created_at ASC LIMIT 100").all(proj, CHAR_ID, since).map((r: any) => r.text);
      const aps = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='auto_process' AND project=? AND character_id=? AND created_at>? ORDER BY created_at ASC LIMIT 50").all(proj, CHAR_ID, since).map((r: any) => r.text);
      return ok({ conversations: [...convs, ...aps] });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'project_list', 'admin',
  'List all project namespaces and their memory/fact counts. Use to discover which projects have memories (e.g. after switching working directories).',
  {},
  async () => {
    try {
      // 兼容模式(MEMORY_DB_PATH):单库内按 project 列分组统计(旧行为)
      if (process.env.MEMORY_DB_PATH) {
        const db = DatabaseManager.getInstance();
        const mem = db.prepare(`
          SELECT project, COUNT(*) as c FROM memory
          WHERE is_active = 1 AND character_id = ?
            AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')
          GROUP BY project ORDER BY c DESC
        `).all(CHAR_ID) as any[];
        const facts = db.prepare(`
          SELECT facts.project, COUNT(*) as c FROM facts
          WHERE facts.is_active = 1 AND facts.character_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM memory source_memory
              WHERE source_memory.id = facts.source_memory_id
                AND source_memory.source IN ('agent_diary', 'agent_state')
            )
            AND COALESCE(facts.source_memory_source, '') NOT IN ('agent_diary', 'agent_state')
          GROUP BY facts.project ORDER BY c DESC
        `).all(CHAR_ID) as any[];
        const byId: Record<string, any> = {};
        for (const r of mem) byId[r.project || 'default'] = { project: r.project || 'default', memories: r.c, facts: 0 };
        for (const r of facts) {
          const key = r.project || 'default';
          if (!byId[key]) byId[key] = { project: key, memories: 0, facts: 0 };
          byId[key].facts = r.c;
        }
        const projects = Object.values(byId).sort((a: any, b: any) => (b.memories + b.facts) - (a.memories + a.facts));
        return ok({
          op: 'project_list',
          count: projects.length,
          current: PROJECT_ID,
          projects,
          hint: '读写工具传 project 参数即切换到该项目的记忆空间;不传则用当前项目(' + PROJECT_ID + ')',
        });
      }

      // 新目录结构:遍历 memory/ 下 project-*.sqlite(无库文件的项目不算)
      const gdb = DatabaseManager.getGlobal();
      const regMap = new Map<string, string>();
      try {
        for (const r of gdb.prepare('SELECT project, created_at FROM projects').all() as any[]) {
          regMap.set(r.project, r.created_at);
        }
      } catch { /* projects 表不可用时忽略 */ }

      const projects: any[] = [];
      for (const name of listProjectNames()) {
        try {
          // memdir:聚合项目全部分类库统计(v1.24: 只统计本角色)
          let mem = 0;
          let facts = 0;
          for (const mt of listMemTypeDirs(name)) {
            const db = DatabaseManager.getInstance(name, mt);
            mem += (db.prepare("SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND character_id=? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").get(CHAR_ID) as any).c;
            try {
              facts += (db.prepare(`
                SELECT COUNT(*) as c FROM facts
                WHERE facts.is_active = 1 AND facts.character_id = ?
                  AND COALESCE(facts.source_memory_source, '') NOT IN ('agent_diary', 'agent_state')
                  AND NOT EXISTS (
                    SELECT 1 FROM memory source_memory
                    WHERE source_memory.id = facts.source_memory_id
                      AND source_memory.source IN ('agent_diary', 'agent_state')
                  )
              `).get(CHAR_ID) as any).c;
            } catch {}
          }
          projects.push({
            project: name,
            memories: mem,
            facts,
            createdAt: regMap.get(name) || null,
          });
        } catch { /* 打不开的库跳过 */ }
      }
      projects.sort((a, b) => (b.memories + b.facts) - (a.memories + a.facts));
      return ok({
        op: 'project_list',
        count: projects.length,
        current: PROJECT_ID,
        projects,
        hint: '读写工具传 project 参数即切换到该项目的记忆空间;不传则用当前项目(' + PROJECT_ID + ')',
      });
    } catch (e: any) { return err(e.message, 'PROJECT_LIST_FAILED'); }
  }
);

register(
  'project_create', 'admin',
  'Create a new project (library) namespace. Immediately usable for memory_save / memory_search with project=<name>. Name uses letters/digits/._- only.',
  {
    name: z.string().min(1).describe('New library name (letters/digits/._- recommended)'),
  },
  async (args) => {
    try {
      const raw = String(args.name).trim();
      if (!raw) return err('项目名不能为空', 'INVALID_PROJECT_NAME');
      const safe = safeFilePart(raw);
      if (safe !== raw) {
        return err(`项目名包含不安全字符,已规范化为 "${safe}"。建议只用字母/数字/._-`, 'INVALID_PROJECT_NAME');
      }
      DatabaseManager.getInstance(safe);
      return ok({
        op: 'project_create',
        project: safe,
        hint: `读写工具传 project=${safe} 即指向该库;约定库名 shared 为共享层(互通语义待定)`,
      });
    } catch (e: any) { return err(e.message, 'PROJECT_CREATE_FAILED'); }
  }
);

register(
  'reflect_all', 'admin',
  'Cross-library reflection & consolidation (non-destructive): scan active memories from every memory library (this instance + FEDERATION_DIRS external instances), let the LLM merge duplicates and distill high-value insights across libraries, then write the result into the dedicated project=reflect library (skipping already-existing texts). dryRun=true only analyzes without writing. Source libraries are opened read-only and never modified. Requires REFLECT LLM channel (config.json reflect section).',
  {
    maxTotal: z.number().optional().describe('Max total memories to scan across all libraries (default 300)'),
    maxPerLib: z.number().optional().describe('Max memories per library (default 100)'),
    dryRun: z.boolean().optional().describe('true = analyze only, do not write into reflect library (default false)'),
    projects: z.array(z.string()).optional().describe('Only reflect the specified project libraries (e.g. ["hermes"]); default = all libraries'),
  },
  async (args) => {
    try {
      const r = await runReflectAll({
        maxTotal: args.maxTotal,
        maxPerLib: args.maxPerLib,
        dryRun: args.dryRun,
        projects: args.projects,
      });
      return ok(r);
    } catch (e: any) { return err(e.message, 'REFLECT_ALL_FAILED'); }
  }
);
register(
  'memory_search_all', 'admin',
  'Federation search interface (read-only): search this instance\'s libraries plus any external instances listed in FEDERATION_DIRS env ([{"name":"...","dir":"..."},...]). Explicit semantics — the engine does NOT merge libraries automatically; the caller decides interop policy. Results carry "instance" and "project".',
  {
    query: z.string().describe('Query text'),
    topK: z.number().optional().describe('Max results per library (default 5)'),
    mode: z.enum(['text', 'vector']).optional().describe('text = LIKE substring search (default); vector = reserved for sqlite-vec KNN (falls back to text in this build)'),
  },
  async (args) => {
    try {
      const topK = args.topK ?? 5;
      // 接口化(v1.14):并发检索所有成员(本实例 + 配置的成员),单成员失败不影响整体。
      const { hits, members, errors } = await fedSearchAll(currentMemDir(), args.query, topK);
      return ok({
        op: 'memory_search_all',
        query: args.query,
        members,
        libraries: resolveFedLibraries(currentMemDir()).length,
        mode: args.mode === 'vector' ? 'text_fallback' : 'text',
        count: hits.length,
        results: hits.map(r => ({
          instance: r.instance,
          member: r.member,
          project: r.project,
          memType: r.memType,
          id: r.id,
          text: r.text,
          score: r.score,
          createdAt: r.createdAt,
        })),
        errors: errors.length ? errors : undefined,
        hint: '接口先行:互通语义未定,引擎不自动合并库。成员来自 FEDERATION_MEMBERS(推荐)或 FEDERATION_DIRS(兼容);transport 支持 local-dir 与 mcp-http。',
      });
    } catch (e: any) { return err(e.message, 'FEDERATION_FAILED'); }
  }
);


// ═══════════════════════════════════════════════════════════════════
// 三层指令记忆工具(类比 CLAUDE.md 层级)
// L1 global:所有用户/项目通用规则(种子为全局规范)
// L2 user:当前用户所有项目共享
// L3 project:单项目专属规则,拼接在 Prompt 最末尾、约束最高,可覆盖 L1/L2 冲突
// rule:规则组(scope=rule),供 include 引用复用;指令带 paths 时可做 glob 路径过滤
// ═══════════════════════════════════════════════════════════════════

register(
  'instruction_save', 'harness',
  'Save (upsert) an instruction rule into one of four layers: global (all users/projects, seeded with global rules), user (current user, all projects), project (this project only), or rule (a reusable rule group referenced via include lines like include: "rule:typescript-core" in any instruction). Load order into prompt: global→user→project; project rules land at the very end and carry the highest constraint. Same scope+project overwrites the previous content. Optional paths accepts glob patterns (JSON array of strings, e.g. ["src/**","!src/temp/**"]) — when memory_context is called with a path, instructions whose paths do not match are skipped.',
  {
    scope: z.enum(['global', 'user', 'project', 'rule']).describe('Layer: global=all users/projects, user=this user shared, project=this project only, rule=reusable rule group (project = group name)'),
    project: z.string().optional().describe('Project name (REQUIRED when scope=project) or rule group name (REQUIRED when scope=rule)'),
    content: z.string().describe('Instruction rule content. May contain include lines: include: "rule:groupname" or include: ["rule:a","rule:b"]'),
    paths: z.array(z.string()).optional().describe('Glob patterns (picomatch). NULL = applies to all paths; patterns with leading ! are negations (last match wins).'),
  },
  async (args) => {
    try {
      const needsProject = args.scope === 'project' || args.scope === 'rule';
      if (needsProject && !(args.project ?? '').trim()) return err(args.scope === 'rule' ? 'scope=rule 时必须传 project 参数(规则组名)' : 'scope=project 时必须传 project 参数', 'INVALID_PROJECT');
      const proj = needsProject ? normalizeProject(args.project) : null;
      const r = saveInstruction(args.scope, proj, args.content, args.paths ?? null);
      return ok({ saved: true, scope: args.scope, project: proj, paths: args.paths ?? null, created: r.created, id: r.id });
    } catch (e: any) { return err(e.message, 'INSTRUCTION_SAVE_FAILED'); }
  }
);

register(
  'instruction_list', 'admin',
  'List all instruction layers (global/user/project/rule) with scope, project, content, paths and updated_at. Rule groups are scope=rule + project=group name. Admin tool: use instruction_save to add/update, instruction_delete to remove.',
  {},
  async () => {
    try {
      const rows = listInstructions();
      return ok({ count: rows.length, instructions: rows });
    } catch (e: any) { return err(e.message, 'INSTRUCTION_LIST_FAILED'); }
  }
);

register(
  'instruction_delete', 'admin',
  'Delete one instruction layer. scope=project requires the matching project name; scope=rule requires the rule group name. Admin tool.',
  {
    scope: z.enum(['global', 'user', 'project', 'rule']).describe('Layer to delete'),
    project: z.string().optional().describe('Project name (required when scope=project) or rule group name (required when scope=rule)'),
  },
  async (args) => {
    try {
      const needsProject = args.scope === 'project' || args.scope === 'rule';
      if (needsProject && !(args.project ?? '').trim()) return err(args.scope === 'rule' ? 'scope=rule 时必须传 project 参数(规则组名)' : 'scope=project 时必须传 project 参数', 'INVALID_PROJECT');
      const proj = needsProject ? normalizeProject(args.project) : null;
      const r = deleteInstruction(args.scope, proj);
      return ok({ deleted: r.deleted, scope: args.scope, project: proj });
    } catch (e: any) { return err(e.message, 'INSTRUCTION_DELETE_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// v1.26 前端存储桥 — 给 AIRI 这类「每个角色一套记忆」的客户端当持久层
//   角色 = memory.character_id;不传 characterId 回落到本进程 CHAR_ID
//   general=true 表示所有角色共享(character_id 写空串)
//   文本约定:第一行 `# <name>` 是索引名,第二行是用途说明,空行之后是正文
//   source='airi' 标记写入方,方便和引擎自己产生的记忆区分
// ═══════════════════════════════════════════════════════════════════

const STORE_SOURCE = 'airi';
const STORE_NAME_RE = /^#\s+([^\n]+)\n?/;

/** 拆出「索引名 / 用途说明 / 正文」。没有约定的头(引擎自己写的记忆)返回 name=null。 */
function parseStoreText(text: string): { name: string | null; description: string; body: string } {
  const m = STORE_NAME_RE.exec(text);
  if (!m) return { name: null, description: '', body: text };
  const rest = text.slice(m[0].length);
  const nl = rest.indexOf('\n');
  const description = (nl === -1 ? rest : rest.slice(0, nl)).trim();
  const body = nl === -1 ? '' : rest.slice(nl + 1).replace(/^\n/, '');
  return { name: m[1].trim(), description, body };
}

/** characterId 归一:general 优先,否则显式 id,最后回落本进程角色。 */
function storeCharacterId(args: { characterId?: string, general?: boolean }): string {
  if (args.general) return '';
  return (args.characterId ?? '').trim() || CHAR_ID;
}

function readStoreRows(project: string | undefined, characterId: string, includeGeneral: boolean, limit: number, opts: { allCharacters?: boolean, source?: string } = {}) {
  const proj = normalizeProject(project ?? PROJECT_ID);
  const cap = Math.max(1, Math.min(Math.trunc(limit) || 500, 2000));
  const conditions = ['is_active = 1'];
  const params: any[] = [];
  if (opts.allCharacters) {
    // 前端要重建自己那份缓存:只按 source 圈定写入方,不再按角色过滤
  }
  else if (characterId === '') {
    conditions.push("(character_id IS NULL OR character_id = '')");
  }
  else if (includeGeneral) {
    conditions.push("(character_id = ? OR character_id IS NULL OR character_id = '')");
    params.push(characterId);
  }
  else {
    conditions.push('character_id = ?');
    params.push(characterId);
  }
  if (opts.source) {
    conditions.push('source = ?');
    params.push(opts.source);
  } else {
    conditions.push("COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')");
  }
  const rows: any[] = [];
  for (const mt of listMemTypeDirs(proj)) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      const found = db.prepare(`
        SELECT id, text, character_id, mem_type, tags, importance, source, created_at, updated_at
        FROM memory WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?
      `).all(...params, cap) as any[];
      for (const r of found) rows.push({ ...r, mem_type: r.mem_type || mt });
    } catch { /* 单个分类库损坏不阻断 */ }
  }
  rows.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  return { project: proj, rows: rows.slice(0, cap) };
}

/** 把一行 memory 变成前端能直接用的结构。 */
function toStoreRecord(row: any) {
  const parsed = parseStoreText(String(row.text ?? ''));
  const charId = row.character_id ?? null;
  return {
    id: row.id,
    ...parsed,
    // 没有约定头的记录给一个稳定可寻址的名字,避免前端出现空名
    fallbackName: parsed.name ? undefined : `mem-${String(row.id).slice(0, 8)}`,
    characterId: charId ?? '',
    general: !charId,
    memType: row.mem_type || 'general',
    source: row.source ?? '',
    tags: parseTagsSafe(row.tags),
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

register(
  'fact_as_of', 'agent',
  'Answer what the facts were at one instant, on one of two axes. axis=valid = what was true in the world then; axis=transaction = what we already knew then (a fact backfilled today is not known for a past date). Returns rows that were true then, including ones since superseded.',
  {
    at: z.string().describe('The instant: YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS]'),
    axis: z.enum(['valid', 'transaction']).optional().describe('valid = what was true then (default); transaction = what we believed then'),
    subject: z.string().optional().describe('Filter by subject'),
    predicate: z.string().optional().describe('Filter by predicate'),
    characterId: z.string().optional().describe('Role id (default: process CHAR_ID). "any" disables the role filter'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const rows = factsAsOf({
        at: args.at,
        axis: args.axis,
        subject: args.subject,
        predicate: args.predicate,
        characterId: args.characterId,
        project: args.project,
      });
      return ok({
        op: 'fact_as_of',
        at: args.at,
        axis: args.axis ?? 'valid',
        count: rows.length,
        results: rows.map(row => ({
          id: row.id,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          confidence: row.confidence,
          validFrom: row.validFrom,
          validTo: row.validTo,
          expiredAt: row.expiredAt,
          supersededBy: row.supersededBy,
        })),
      });
    } catch (e: any) { return err(e.message, 'FACT_AS_OF_FAILED'); }
  }
);

register(
  'facts_windows_plan', 'admin',
  'Read-only: list the fact slots with more than one open window (two "current" values for one single-valued slot), and what a repair would close. Writes nothing.',
  {
    characterId: z.string().optional().describe('Role id (default: process CHAR_ID). "any" disables the role filter'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const plans = planWindowRepairs({ characterId: args.characterId, project: args.project });
      return ok({
        op: 'facts_windows_plan',
        count: plans.length,
        results: plans.map(plan => ({
          subject: plan.subject,
          predicate: plan.predicate,
          reason: plan.reason,
          keep: { id: plan.keep.id, object: plan.keep.object, validFrom: plan.keep.validFrom ?? plan.keep.createdAt },
          close: plan.close.map(window => ({ id: window.id, object: window.object, validFrom: window.validFrom ?? window.createdAt })),
        })),
      });
    } catch (e: any) { return err(e.message, 'FACTS_WINDOWS_PLAN_FAILED'); }
  }
);

register(
  'facts_windows_apply', 'admin',
  'Apply a repair from facts_windows_plan. Writes valid_to and expired_at on the older open rows. Run the plan first, and read what it would close.',
  {
    confirm: z.literal(true).describe('Must be true: this writes to the bank'),
    characterId: z.string().optional().describe('Role id (default: process CHAR_ID)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    subject: z.string().optional().describe('Only repair this subject'),
    predicate: z.string().optional().describe('Only repair this predicate'),
  },
  async (args) => {
    try {
      const plans = planWindowRepairs({ characterId: args.characterId, project: args.project })
        .filter(plan => (!args.subject || plan.subject === args.subject) && (!args.predicate || plan.predicate === args.predicate));
      const applied = applyWindowRepairs(plans, { project: args.project });
      return ok({
        op: 'facts_windows_apply',
        planCount: plans.length,
        closedRows: applied.reduce((total, item) => total + item.closed, 0),
        results: applied,
      });
    } catch (e: any) { return err(e.message, 'FACTS_WINDOWS_APPLY_FAILED'); }
  }
);

register(
  'memory_recall', 'store',
  'Recall for one query and render a ready-to-inject context block (<memory> container, char budget). Abstains with empty text when nothing passes the SIMILARITY gate, so a caller can append the block unconditionally; never blocks the turn.',
  {
    query: z.string().min(1).describe('The user turn / topic to recall for'),
    characterId: z.string().optional().describe('Character/role id (default: process CHAR_ID)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    topK: z.number().optional().describe('Max items, default 5'),
    minSimilarity: z.number().optional().describe('Cosine similarity gate (default 0.5, or MEMORY_INJECT_MIN_SIM)'),
    capChars: z.number().optional().describe('Whole-block character budget, default 1200'),
  },
  async (args) => {
    try {
      const charId = storeCharacterId(args);
      const project = normalizeProject(args.project ?? PROJECT_ID);
      const result = await recallForInjection(String(args.query), {
        project,
        characterId: charId,
        topK: args.topK,
        minSimilarity: args.minSimilarity,
        capChars: args.capChars,
        // 心情 → 情绪一致性重排 + "难过不翻旧账";agentState 取不到就按中性处理
        mood: currentMood(project, charId),
      });
      return ok({
        op: 'recall',
        project,
        characterId: charId,
        text: result.text,
        injected: result.stats.count > 0,
        ...result.stats,
      });
    } catch (e: any) { return err(e.message, 'RECALL_FAILED'); }
  }
);

register(
  'memory_store_list', 'store',
  'List a frontend store with full text: rows owned by characterId, plus shared rows when includeGeneral. No truncation, so a client can rebuild its whole index.',
  {
    characterId: z.string().optional().describe('Character/role id owning the memories (default: process CHAR_ID)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    includeGeneral: z.boolean().optional().describe('Also return memories shared by every role (default true)'),
    allCharacters: z.boolean().optional().describe('Ignore the role filter and return every role (a client rebuilding its own cache wants this)'),
    source: z.string().optional().describe('Only rows written by this source (e.g. "airi")'),
    limit: z.number().optional().describe('Max rows (default 500, hard cap 2000)'),
  },
  async (args) => {
    try {
      const charId = storeCharacterId(args);
      const { project, rows } = readStoreRows(args.project, charId, args.includeGeneral !== false, args.limit ?? 500, { allCharacters: args.allCharacters, source: args.source });
      return ok({
        op: 'store_list',
        project,
        characterId: charId,
        allCharacters: Boolean(args.allCharacters),
        count: rows.length,
        results: rows.map(toStoreRecord),
      });
    } catch (e: any) { return err(e.message, 'STORE_LIST_FAILED'); }
  }
);

register(
  'memory_store_save', 'store',
  'Create or replace one frontend store entry, addressed by its index name inside (project, characterId). Keeps the engine pipeline (embedding, edges, decay) because it goes through memory_save.',
  {
    name: z.string().min(1).describe('Kebab-case index name, unique inside the role scope'),
    description: z.string().optional().describe('One-line index text shown next to the name'),
    body: z.string().min(1).describe('Full text of the memory'),
    characterId: z.string().optional().describe('Character/role id (default: process CHAR_ID)'),
    general: z.boolean().optional().describe('Store as a memory shared by every role'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    importance: z.number().optional().describe('Importance 0..1 (default 0.5)'),
  },
  async (args) => {
    try {
      const charId = storeCharacterId(args);
      const name = String(args.name).trim();
      const description = (args.description ?? '').trim();
      const body = String(args.body).trim();
      if (!name || !body) return err('name 和 body 不能为空', 'INVALID_STORE_ENTRY');
      const text = description ? `# ${name}\n${description}\n\n${body}` : `# ${name}\n\n${body}`;
      const { project, rows } = readStoreRows(args.project, charId, false, 2000);
      const existing = rows.find(row => parseStoreText(String(row.text ?? '')).name === name);
      let id: string;
      let updated = false;
      if (existing) {
        const r = await updateMemory(String(existing.id), { text, project }, charId);
        if (!r) return err('已有同名记忆但更新失败', 'STORE_UPDATE_FAILED');
        id = String(existing.id);
        updated = true;
      }
      else {
        const r = await saveMemory({
          text,
          project,
          memType: 'general',
          type: 'episodic',
          source: STORE_SOURCE,
          subject: 'self',
          importance: args.importance ?? 0.5,
          characterId: charId,
        });
        id = r.id;
      }
      return ok({ op: 'store_save', id, name, characterId: charId, general: !charId, updated, text });
    } catch (e: any) { return err(e.message, 'STORE_SAVE_FAILED'); }
  }
);

register(
  'memory_store_forget', 'store',
  'Forget one frontend store entry by its index name inside (project, characterId).',
  {
    name: z.string().min(1).describe('Index name to forget'),
    characterId: z.string().optional().describe('Character/role id (default: process CHAR_ID)'),
    general: z.boolean().optional().describe('Forget a shared entry instead of this role\'s own'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const charId = storeCharacterId(args);
      const name = String(args.name).trim();
      const { project, rows } = readStoreRows(args.project, charId, false, 2000);
      const existing = rows.find(row => parseStoreText(String(row.text ?? '')).name === name);
      if (!existing) return ok({ op: 'store_forget', deleted: false, name, characterId: charId });
      const deleted = forgetMemory(String(existing.id), project, charId);
      return ok({ op: 'store_forget', deleted, id: existing.id, name, characterId: charId });
    } catch (e: any) { return err(e.message, 'STORE_FORGET_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

async function main() {
  // Anima:启动时加载主题偏差 + 用户画像(内存态,供 context_get / 搜索情感评分)
  loadBiasesFromDb(CHAR_ID);
  loadUserProfilesFromDb(CHAR_ID);

  // 三层指令记忆:启动时创建 memory/ 目录 + global.sqlite(建表 + L1 全局种子)
  // 项目库懒加载:首次访问某 project 才创建
  DatabaseManager.getGlobal();
  const seed = ensureSeedInstructions();
  console.error(`[instructions] L1 种子${seed.seeded ? '已写入(scope=global)' : `跳过(表已有 ${seed.count} 条)`}`);

  // v1.11 Part2: 会话记忆 TTL 孤儿清扫(启动时静默执行,默认项目 + 已存在项目库各一次)
  try {
    let swept = sweepExpiredSessionMemories();
    for (const name of listProjectNames()) {
      try { swept += sweepExpiredSessionMemories(name); } catch { /* 打不开的库跳过 */ }
    }
    if (swept > 0) console.error(`[session-memory] TTL 清扫: ${swept} 条过期会话记忆已清除`);
  } catch (e: any) {
    console.error('[session-memory] TTL 清扫失败:', e.message);
  }

  // Agent state: nothing to flush (in-memory only)

  // Consolidate every 24 hours
  setInterval(() => { consolidate().catch(() => {}); }, 24 * 60 * 60 * 1000);

  // Event-driven digest check every 1 minute
  scheduleDigestSweep();
  setInterval(() => {
    scheduleDigestSweep();
  }, 60 * 1000);

  // Self-cycle is deliberately opt-in: it writes derived diary memories and
  // must never become an invisible side effect of merely starting the server.
  // When enabled, scan the default project plus projects already present on
  // disk, while keeping one process-local sweep in flight at a time.
  const selfCycleIntervalMinutes = Number.parseFloat(process.env.SELF_CYCLE_INTERVAL_MINUTES || '0');
  if (Number.isFinite(selfCycleIntervalMinutes) && selfCycleIntervalMinutes > 0) {
    const intervalMs = Math.max(60_000, selfCycleIntervalMinutes * 60_000);
    let selfCycleSweepBusy = false;
    const runSelfCycleSweep = async () => {
      if (selfCycleSweepBusy) return;
      selfCycleSweepBusy = true;
      try {
        const projects = new Set<string>([normalizeProject(PROJECT_ID), ...listProjectNames().map(normalizeProject)]);
        for (const project of projects) {
          try {
            const result = await runSelfCycle({
              project,
              characterId: CHAR_ID,
              minIntervalHours: selfCycleIntervalMinutes / 60,
            });
            if (!result.skipped || result.reason !== 'no_new_evidence') {
              console.error(`[self-cycle-auto] project=${project} ok=${result.ok} skipped=${result.skipped} reason=${result.reason || ''}${result.diaryId ? ` diary=${result.diaryId}` : ''}`);
            }
          } catch (error: any) {
            console.error(`[self-cycle-auto] project=${project} error: ${error?.message || error}`);
          }
        }
      } finally {
        selfCycleSweepBusy = false;
      }
    };
    setTimeout(() => { runSelfCycleSweep().catch(() => {}); }, 0);
    setInterval(() => { runSelfCycleSweep().catch(() => {}); }, intervalMs);
    console.error(`[castalia] self-cycle every ${Math.round(intervalMs / 60000)}m (opt-in)`);
  }

  // 事件摘要层(P2)的调度**不在这里**：AIRI 与宿主都走 maintain()（in-process 由
  // castalia-memory.ts 的 scheduleMemoryMaintenance 每晚 04:00–06:00 + 启动 catch-up 触发，
  // 内部已调 runEventDigest）。曾经在这里加过每小时定时器 —— in-process 形态不加载 index.ts，
  // 那是第二份调度器、纯死代码。stdio 形态若要事件层，应在宿主补触发点，不要加到引擎入口。

  // WAL checkpoint every 30 minutes
  setInterval(() => {
    try {
      const r = DatabaseManager.checkpoint();
      if (r.pages > 0) console.error('[db] WAL checkpoint:', r.pages, 'pages');
    } catch {}
  }, 30 * 60 * 1000);

  // Cleanup expired every 30 minutes
  setInterval(() => {
    const cleaned = cleanupExpiredMemories();
    if (cleaned > 0) console.error(`[castalia] cleaned ${cleaned} expired temporary memories`);
  }, 30 * 60 * 1000);

  // Auto-reflect every N hours (REFLECT_INTERVAL_HOURS > 0 enables)
  const reflectIntervalHours = parseFloat(process.env.REFLECT_INTERVAL_HOURS || '0');
  if (reflectIntervalHours > 0) {
    const runOnce = () => {
      runAutoReflect(CHAR_ID).then(r => {
        if (r.skipped) return;
        console.error(`[reflect-auto] applied ${r.applied}/${r.actions} actions, errors: ${r.errors.length}`);
      }).catch((e: any) => console.error('[reflect-auto] error:', e.message));
    };
    setInterval(runOnce, reflectIntervalHours * 3600 * 1000);
    console.error(`[castalia] auto-reflect every ${reflectIntervalHours}h`);
  }

  // ═══ stdio 管道被对面关掉时的存活保护 (2026-10-28) ═══
  // stdio 模式下 process.stdout 是个 Socket。客户端(宿主/mcp-proxy)关掉会话后再回写,
  // 就是 EPIPE,而 Node 对未处理的 'error' 事件是直接抛 —— 进程当场死,端口还在听、
  // 子进程没了,看护判"空壳桥"重建,顺带把 LobeHub 重启一圈。
  // 实测: bridge-hermes-bridge.log 里 consolidate 完成后 EPIPE → exit 1,反复发生。
  // 对面已经走了,这条响应没有接收方,记一行日志即可,不该拿进程陪葬;
  // 非管道类错误照旧抛出。
  const guardStdioErrors = (stream: NodeJS.WriteStream, name: string) => {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED')) {
        console.error(`[stdio] ${name} 写入失败(对面已关闭): ${err.code}`);
        return;
      }
      throw err;
    });
  };
  guardStdioErrors(process.stdout, 'stdout');
  guardStdioErrors(process.stderr, 'stderr');

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} started — unified MCP server (proxy + LLM tools)`);

  // ═══ 启动时自动反思 ═══
  // 触发逻辑:条件达成(距上次反思 ≥ REFLECT_MIN_GAP_HOURS 且未分析对话 > REFLECT_MIN_UNANALYZED)
  // 后,下次启动 server 时自动执行一次 runAutoReflect;启动后不再周期性自动跑。
  // 用 setTimeout 异步执行,不阻塞 server 启动;失败 catch 记录不崩。
  setTimeout(() => {
    (async () => {
      try {
        const cond = shouldAutoReflect(CHAR_ID);
        if (!cond.should) {
          console.error(`[reflect-startup] 跳过: ${cond.reason}`);
          return;
        }
        console.error(`[reflect-startup] 条件达成(${cond.reason}),启动自动反思...`);
        const r = await runAutoReflect(CHAR_ID);
        console.error(`[reflect-startup] 完成: ok=${r.ok}, actions=${r.actions}, applied=${r.applied}, factsInserted=${r.factsInserted ?? 0}, factsUpdated=${r.factsUpdated ?? 0}, errors=${r.errors.length}${r.skipped ? ', skipped' : ''}`);
        if (r.errors.length > 0) console.error(`[reflect-startup] errors: ${r.errors.join('; ')}`);
      } catch (e: any) {
        console.error('[reflect-startup] error:', e.message);
      }
    })();
  }, 0);

  // ═══ v1.10: 启动时自动记忆整合 ═══
  // 触发逻辑:记忆过多(active > CONSOLIDATE_MIN_MEMORIES,默认 15)时,下次启动异步执行一次
  // consolidate_deep 流程(向量预筛 → LLM 去重/矛盾消解)。开关 CONSOLIDATE_AUTO_ON_START(默认 1;0=只手动)。
  setTimeout(() => {
    (async () => {
      try {
        if ((process.env.CONSOLIDATE_AUTO_ON_START ?? '1') === '0') {
          console.error('[consolidate-startup] 跳过: CONSOLIDATE_AUTO_ON_START=0');
          return;
        }
        const cond = shouldAutoConsolidate();
        if (!cond.should) {
          console.error(`[consolidate-startup] 跳过: 记忆 ${cond.count} 条未超阈值 ${cond.min}`);
          return;
        }
        console.error(`[consolidate-startup] 记忆 ${cond.count} 条超阈值 ${cond.min},自动整合...`);
        // v1.23: 整合前先做冷存分层（长期不用的低价值记忆退出整合窗口，但不删除、仍可检索）
        try { markColdMemories(PROJECT_ID); } catch (e: any) { console.error('[cold] error:', e.message); }
        const r = await runConsolidate(CHAR_ID);
        console.error(`[consolidate-startup] 完成: ok=${r.ok}, scanned=${r.scanned}, candidates=${r.candidates}, merged=${r.merged}, deleted=${r.deleted}, kept=${r.kept}, actions=${r.actions}, applied=${r.applied}, invalidated=${r.invalidated ?? 0}, errors=${r.errors.length}${r.skipped ? ', skipped' : ''}`);
        if (r.errors.length > 0) console.error(`[consolidate-startup] errors: ${r.errors.join('; ')}`);
      } catch (e: any) {
        console.error('[consolidate-startup] error:', e.message);
      }
    })();
  }, 500);

  process.on('SIGINT', () => { DatabaseManager.close(); process.exit(0); });
  process.on('SIGTERM', () => { DatabaseManager.close(); process.exit(0); });
}

main();
