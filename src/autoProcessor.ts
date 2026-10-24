/**
 * AutoProcessor v6.3 — Anima 情感层 + 通用版会话缓冲
 *
 * 分类逻辑：特别短 → 启发式默认 / 中等 → Ollama批量队列 / 重要 → reflect LLM 兜底
 * 消息管道不阻塞：所有 LLM 调用都是异步队列
 *
 * v6.3(第4轮融合):在 Anima 基底(observeUserMessage / VAD queue / moodValue)上,
 * 叠加通用版 v1.11 Part2 的 sessionId 会话缓冲(渐进式临时反思) + project 参数。
 */

import { saveConversationTurn } from './store.js';
import { DatabaseManager } from './db.js';
import { getAgentState } from './agentState.js';
import { observeUserMessage } from './userLearning.js';
import { queueForVad, ollamaClassify, fallbackClassify, formatVADForPrompt, VADVector } from './emotion.js';
import { getBuffer } from './buffer.js';
import { PROJECT_ID, normalizeProject } from './env.js';

/** 兜底：saveConversationTurn 没返回 id 时，按 (project, 用户原文) 回查最近一条 conversation_log。 */
function findConversationTurnId(project: string, userMessage: string): string | undefined {
  try {
    const db = DatabaseManager.getInstance(project);
    const row = db.prepare(`
      SELECT id FROM memory
      WHERE source = 'conversation_log' AND project = ? AND is_active = 1
        AND instr(text, ?) > 0
      ORDER BY rowid DESC LIMIT 1
    `).get(project, '用户: ' + userMessage) as any;
    return row?.id;
  } catch {
    return undefined;
  }
}

export async function autoProcess(args: {
  userMessage: string;
  assistantMessage: string;
  moodValue?: number;
  moodReason?: string;
  characterId?: string;
  project?: string;
  sessionId?: string;  // v1.11 Part2: 会话 ID — 传了才启用会话记忆缓冲(渐进式临时反思),不传保持旧行为
}): Promise<any> {
  const cid = args.characterId || 'airi';
  const proj = normalizeProject(args.project || PROJECT_ID);
  const results: any = {
    success: true,
    moodProcessed: false,
    conversationSaved: false,
    vadAnalysis: null as any,
    details: [] as string[],
  };

  if (args.moodValue !== undefined) {
    const state = getAgentState(cid, proj);
    state.addMood(args.moodValue, args.moodReason || '');
    results.moodProcessed = true;
    results.details.push('mood=' + args.moodValue + ' (' + args.moodReason + ')');
  }

  observeUserMessage(cid, 'default', args.userMessage, proj);

  // v1.23.2 审计第 1 组：必须先落库拿到记录 id，再入 VAD 队列。
  // 旧顺序是先 queue 后 save，flush 只能靠“默认库 + created_at DESC”猜行，跨项目/并发会写错行。
  let memoryId: string | undefined;
  try {
    const saved = await saveConversationTurn(args.userMessage, args.assistantMessage, cid, args.moodValue, args.moodReason, proj);
    results.conversationSaved = true;
    results.details.push('conversation saved');
    memoryId = saved?.id;
  } catch (e: any) {
    results.details.push('save error: ' + e.message);
  }

  // 返回值没带 id 时（旧版 store / 未来重构），从本项目 conversation_log 回查最近一条。
  // 仅在本轮确实落库成功时回查；save 失败时不能把上一轮同文本的行认成本轮。
  if (!memoryId && results.conversationSaved) memoryId = findConversationTurnId(proj, args.userMessage);

  // VAD 异步队列 — 不阻塞消息管道；条目带上 project + memoryId，flush 时精确回写。
  // 落库失败时不入队：没有本轮记录可回写，位置兜底可能误伤上一轮同文本的行。
  if (results.conversationSaved) {
    try {
      queueForVad(args.userMessage, proj, memoryId);
      results.details.push('VAD queued (async batch)' + (memoryId ? '' : ' [no memory id]'));
    } catch (e: any) {
      results.details.push('VAD queue error: ' + e.message);
    }
  } else {
    results.details.push('VAD queue skipped (conversation not saved)');
  }

  // v1.11 Part2: 会话记忆缓冲 — sessionId 可选;不传 → 不启用,保持向后兼容。
  // 每轮对话入缓冲,累计 BUFFER_SIZE 轮后后台异步增量反思(不阻塞)。
  if (args.sessionId && String(args.sessionId).trim()) {
    try {
      getBuffer(proj, String(args.sessionId).trim(), cid).onNewMessage([
        { role: 'user', content: args.userMessage },
        { role: 'assistant', content: args.assistantMessage },
      ]);
      results.details.push('session buffer +1');
    } catch (e: any) {
      results.details.push('session buffer error: ' + e.message);
    }
  }

  return results;
}

export { formatVADForPrompt };

// ═══════════════════════════════════════════════════════════════════
// 统一分拣接口 — v6.2 简化版
// ═══════════════════════════════════════════════════════════════════

export interface StructClassification {
  tier: 'temporary' | 'standard' | 'critical';
  category: string;
  importance: number;
  tags: string[];
}

/**
 * 实时分拣：用启发式返回默认分类 + 推入 Ollama 异步队列
 *
 * 真正的 tier/category/importance 由两处补齐：
 *   - digest 周期：ollamaClassify() 单次调用重分类
 *   - reflect 周期：LLM 深度反思兜底
 */
export async function classifyMessage(
  text: string,
  context?: string,
  project?: string,
): Promise<StructClassification & { vad: VADVector | null; tsundereLevel: number; confidence: number; vadTags: string[] }> {
  // 异步队列 — 不阻塞；project 进了队列，flush 时不会串到默认库
  queueForVad(text, project);

  // 启发式默认值 — 最多 <1ms
  const cls = fallbackClassify(text);

  return {
    ...cls,
    vad: null,
    tsundereLevel: 0,
    confidence: 0,
    vadTags: [],
  };
}
