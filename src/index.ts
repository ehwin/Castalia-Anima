#!/usr/bin/env node
/**
 * AIRI Memory MCP Server v5.0 — Unified
 *
 * 合并了原 _memory_engine.mjs（proxy 自定义协议）的功能，
 * 全部通过标准 MCP 协议暴露。proxy.py 通过 Python MCP client 调用。
 *
 * AIRI LLM 只看到 proxy.py 过滤后的工具（memory_search / fact_search），
 * 其余工具由 proxy.py 内部调用。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchMemory, searchFacts, getRecentMemories } from './search.js';
import { saveMemory, forgetMemory, updateMemory, saveConversationTurn, cleanupExpiredMemories, batchEmbedPending } from './store.js';
import { consolidate } from './consolidate.js';
import { DatabaseManager } from './db.js';
import { loadBiasesFromDb, getBiasPrompt, recordTopics } from './bias.js';
import { loadUserProfilesFromDb, getUserProfilePrompt, observeUserMessage } from './userLearning.js';
import { getAgentState } from './agentState.js';
import { getCategoryTree } from './category.js';
import { runDigest, getRecentConversations, maybeDigest } from './digest.js';
import { reflect, getAllMemories, getMemoryGraph, REFLECT_SYSTEM_PROMPT, getUnanalyzedConversations, applyReflectResult } from './reflect.js';
import { autoProcess } from './autoProcessor.js';
import { runAutoReflect, runDeepReflect } from './reflectDriver.js';
import { CHAR_ID, SERVER_NAME, SERVER_VERSION } from './env.js';

console.log = console.error;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function ok(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true as const };
}

// ═══════════════════════════════════════════════════════════════════
// 搜索类工具（LLM 可见）
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_search',
  'Search past memories using tag-first then vector KNN fallback. Use when recalling past events, facts, or user preferences.',
  {
    query: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Max results (default 5)'),
    category: z.string().optional().describe('Filter by category'),
  },
  async (args) => {
    try {
      const r = await searchMemory({ query: args.query, topK: args.topK ?? 5, profile: 'balanced', category: args.category, characterId: CHAR_ID });
      return ok({ count: r.length, results: r.map(m => ({ text: m.text, type: m.type, category: m.category, subject: m.subject, importance: m.importance, score: m.score, createdAt: m.createdAt })) });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'fact_search',
  'Search structured facts (subject-predicate-object triples) about the user.',
  {
    query: z.string().describe('Query text'),
    subject: z.enum(['user', 'airi', 'environment']).optional(),
    topK: z.number().optional().describe('Max results (default 5)'),
  },
  async (args) => {
    try {
      const r = await searchFacts(args.query, { subject: args.subject, topK: args.topK ?? 5, minConfidence: 0.3 });
      return ok({ count: r.length, results: r.map(f => ({ fact: `${f.subject} ${f.predicate} ${f.object}`, confidence: f.confidence, similarity: f.similarity })) });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 存储类工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_save',
  'Store a new memory or update existing one by exact text match.',
  {
    text: z.string().describe('Memory content'),
    type: z.enum(['episodic', 'semantic', 'entity', 'preference']).optional().default('episodic'),
    category: z.string().optional().default('general'),
    tags: z.array(z.string()).optional().default([]),
    emotionalImpact: z.number().optional().default(0),
    importance: z.number().optional().default(0.5),
    tier: z.enum(['temporary', 'standard', 'critical']).optional().default('standard'),
    source: z.string().optional(),
    subject: z.enum(['user', 'self', 'environment']).optional().default('user'),
    skipEmbed: z.boolean().optional().default(false),
  },
  async (args) => {
    try {
      const r = await saveMemory({ text: args.text, type: args.type, category: args.category, tags: args.tags, emotionalImpact: args.emotionalImpact, importance: args.importance, tier: args.tier, source: args.source, subject: args.subject, characterId: CHAR_ID, skipEmbed: args.skipEmbed });
      return ok({ id: r.id, text: r.text.substring(0, 100), type: r.type, category: r.category });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_delete',
  'Soft-delete a memory by ID.',
  { id: z.string().describe('Memory ID to delete') },
  async (args) => {
    const ok_ = forgetMemory(args.id);
    return ok({ deleted: ok_ });
  }
);

server.tool(
  'memory_update',
  'Update memory fields (text, category, tags, importance, etc.).',
  {
    id: z.string().describe('Memory ID'),
    text: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().optional(),
    tier: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await updateMemory(args.id, args as any);
      return ok(r ? { updated: true, id: r.id } : { updated: false, error: 'not found' });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 对话自动化工具（proxy.py 内部调用）
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'auto_process',
  '[Internal] Process a conversation turn: save to log, update agent mood, observe user, queue VAD analysis. Called automatically after each LLM response.',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await autoProcess({ userMessage: args.userMessage, assistantMessage: args.assistantMessage, characterId: CHAR_ID, moodValue: args.moodValue, moodReason: args.moodReason });
      // Trigger event-driven digest
      maybeDigest(CHAR_ID)?.catch(() => {});
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'digest_run',
  '[Internal] Run the digest cycle: flush VAD queue, cleanup expired memories, restore lost critical memories.',
  {},
  async () => {
    try {
      const r = await runDigest(CHAR_ID);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'conversation_save',
  '[Internal] Save a raw conversation turn to the log (no analysis, no embedding).',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await saveConversationTurn(args.userMessage, args.assistantMessage, CHAR_ID, args.moodValue, args.moodReason);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文/状态工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'context_get',
  'Get current agent state (mood/energy/desire), bias layer, and user profile for prompt injection.',
  {},
  async () => {
    try {
      const state = getAgentState(CHAR_ID);
      const bias = getBiasPrompt(CHAR_ID);
      const profile = getUserProfilePrompt(CHAR_ID, 'default');
      return ok({ state: state.toPromptString(), bias, profile });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'stats_get',
  'Get memory system statistics: total count, by category, by source.',
  {},
  async () => {
    try {
      const db = DatabaseManager.getInstance();
      const total = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get() as any;
      return ok({
        total: total.c,
        byCategory: db.prepare('SELECT category,COUNT(*) as c FROM memory WHERE is_active=1 GROUP BY category').all(),
        bySource: db.prepare('SELECT source,COUNT(*) as c FROM memory WHERE is_active=1 GROUP BY source').all(),
      });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'user_observe',
  '[Internal] Observe a user message for communication pattern learning.',
  { message: z.string() },
  async (args) => {
    observeUserMessage(CHAR_ID, 'default', args.message);
    return ok({ ok: true });
  }
);

server.tool(
  'mood_journal',
  'Get mood history for the past N days.',
  { days: z.number().optional().default(7) },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance();
      const since = new Date(Date.now() - (args.days || 7) * 86400000).toISOString();
      return ok({
        days: args.days,
        moods: db.prepare("SELECT emotional_impact as value, created_at, text, category FROM memory WHERE is_active=1 AND (category='emotional' OR category='mood_snapshot' OR tier='temporary') AND created_at>? ORDER BY created_at DESC LIMIT 30").all(since),
      });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 记忆列表/图谱工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_list',
  'List all active memories, optionally filtered.',
  {
    limit: z.number().optional().default(200),
    category: z.string().optional(),
    source: z.string().optional(),
  },
  async (args) => {
    try {
      const memories = getAllMemories(CHAR_ID, args.limit);
      let filtered = memories;
      if (args.category) filtered = filtered.filter((m: any) => m.category === args.category);
      if (args.source) filtered = filtered.filter((m: any) => m.source === args.source);
      return ok({ count: filtered.length, results: filtered.slice(0, args.limit) });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_graph',
  'Get the memory relationship graph.',
  {},
  async () => {
    try {
      return ok(getMemoryGraph(CHAR_ID));
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_recent',
  'Get recent important memories (no vector search, just time+importance).',
  {
    limit: z.number().optional().default(5),
    hoursBack: z.number().optional().default(24),
  },
  async (args) => {
    try {
      const r = getRecentMemories(CHAR_ID, args.limit, args.hoursBack);
      return ok({ count: r.length, results: r });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'recent_conversations',
  'Get recent conversation log entries.',
  {
    hoursBack: z.number().optional().default(24),
    limit: z.number().optional().default(50),
  },
  async (args) => {
    try {
      const r = getRecentConversations(CHAR_ID, args.hoursBack, args.limit);
      return ok({ count: r.length, results: r });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 反思工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'reflect_analyze',
  'Get unanalyzed conversations bundled with system prompt for a big LLM to perform reflection.',
  { limit: z.number().optional().default(30) },
  async (args) => {
    try {
      const conversations = getUnanalyzedConversations(CHAR_ID, undefined, args.limit ?? 30);
      const prompt = conversations.map((c: any) => c.text).join('\n---\n');
      return ok({
        conversationCount: conversations.length,
        systemPrompt: REFLECT_SYSTEM_PROMPT,
        userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt.substring(0, 30000)}`,
        conversationIds: conversations.map((c: any) => c.id),
      });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_apply',
  'Apply reflection results (merge, extract, reclassify, delete actions).',
  {
    action: z.enum(['apply', 'preview']).optional().default('apply'),
    actions: z.string().describe('JSON array of reflection actions'),
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
      const r = await reflect(args.action, { actions: parsed });
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_batch_embed',
  '[Internal] Batch embed all pending (un-embedded) memories. Called after reflect.',
  {},
  async () => {
    try {
      const r = await batchEmbedPending(CHAR_ID);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_auto',
  'Run automatic reflection: feed unanalyzed conversations to the configured LLM, apply extracted memories/digest. Requires REFLECT_LLM_API_KEY.',
  { limit: z.number().optional().default(30) },
  async (args) => {
    try {
      const r = await runAutoReflect(CHAR_ID, args.limit ?? 30);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_deep',
  'Run deep calibration: feed ALL memories to the configured LLM for dedup/profile/graph actions. Requires REFLECT_LLM_API_KEY.',
  { limit: z.number().optional().default(500) },
  async (args) => {
    try {
      const r = await runDeepReflect(CHAR_ID, args.limit ?? 500);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 每日摘要工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'daily_summary_data',
  'Get conversation and auto-process data for the past N hours.',
  { hoursBack: z.number().optional().default(24) },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance();
      const since = new Date(Date.now() - (args.hoursBack || 24) * 3600000).toISOString();
      const convs = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='conversation_log' AND created_at>? ORDER BY created_at ASC LIMIT 100").all(since).map((r: any) => r.text);
      const aps = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='auto_process' AND created_at>? ORDER BY created_at ASC LIMIT 50").all(since).map((r: any) => r.text);
      return ok({ conversations: [...convs, ...aps] });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

async function main() {
  loadBiasesFromDb(CHAR_ID);
  loadUserProfilesFromDb(CHAR_ID);

  // Agent state: nothing to flush (in-memory only)

  // Consolidate every 24 hours
  setInterval(() => { consolidate().catch(() => {}); }, 24 * 60 * 60 * 1000);

  // Event-driven digest check every 1 minute
  setInterval(() => {
    maybeDigest(CHAR_ID)?.catch((e: any) => console.error('digest error:', e));
  }, 60 * 1000);

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
    if (cleaned > 0) console.error(`[airi-memory] cleaned ${cleaned} expired temporary memories`);
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
    console.error(`[airi-memory] auto-reflect every ${reflectIntervalHours}h`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[airi-memory] v5.0.0 started — unified MCP server (proxy + LLM tools)');

  process.on('SIGINT', () => { DatabaseManager.close(); process.exit(0); });
  process.on('SIGTERM', () => { DatabaseManager.close(); process.exit(0); });
}

main();
