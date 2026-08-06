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
import { getAgentState } from './agentState.js';
import { observeUserMessage } from './userLearning.js';
import { queueForVad, ollamaClassify, fallbackClassify, formatVADForPrompt, VADVector } from './emotion.js';
import { getBuffer } from './buffer.js';
import { PROJECT_ID, normalizeProject } from './env.js';

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
    const state = getAgentState(cid);
    state.addMood(args.moodValue, args.moodReason || '');
    results.moodProcessed = true;
    results.details.push('mood=' + args.moodValue + ' (' + args.moodReason + ')');
  }

  observeUserMessage(cid, 'default', args.userMessage);

  // VAD 异步队列 — 不阻塞消息管道
  try {
    queueForVad(args.userMessage);
    results.details.push('VAD queued (async batch)');
  } catch (e: any) {
    results.details.push('VAD queue error: ' + e.message);
  }

  try {
    await saveConversationTurn(args.userMessage, args.assistantMessage, cid, args.moodValue, args.moodReason, proj);
    results.conversationSaved = true;
    results.details.push('conversation saved');
  } catch (e: any) {
    results.details.push('save error: ' + e.message);
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
): Promise<StructClassification & { vad: VADVector | null; tsundereLevel: number; confidence: number; vadTags: string[] }> {
  // 异步队列 — 不阻塞
  queueForVad(text);

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
