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
import { queueForVad, fallbackClassify, formatVADForPrompt, formatInteractionForVad } from './emotion.js';
import { getBuffer } from './buffer.js';
import { PROJECT_ID, CHAR_ID, normalizeCharacterId, normalizeProject } from './env.js';
/** 兜底：saveConversationTurn 没返回 id 时，按 (project, 角色, 用户原文) 回查最近一条 conversation_log。 */
function findConversationTurnId(project, userMessage, characterId = CHAR_ID) {
    try {
        const db = DatabaseManager.getInstance(project);
        const row = db.prepare(`
      SELECT id FROM memory
      WHERE source = 'conversation_log' AND project = ? AND is_active = 1
        AND character_id = ?
        AND instr(text, ?) > 0
      ORDER BY rowid DESC LIMIT 1
    `).get(project, characterId, '用户: ' + userMessage);
        return row?.id;
    }
    catch {
        return undefined;
    }
}
export async function autoProcess(args) {
    // v1.24: 角色由进程级 CHAR_ID 决定(与 Castalia 普通版一致);args.characterId 仅作内部显式覆盖
    const cid = normalizeCharacterId(args.characterId);
    const proj = normalizeProject(args.project || PROJECT_ID);
    const results = {
        success: true,
        moodProcessed: false,
        conversationSaved: false,
        vadAnalysis: null,
        details: [],
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
    let memoryId;
    try {
        const saved = await saveConversationTurn(args.userMessage, args.assistantMessage, cid, args.moodValue, args.moodReason, proj);
        results.conversationSaved = true;
        results.details.push('conversation saved');
        memoryId = saved?.id;
    }
    catch (e) {
        results.details.push('save error: ' + e.message);
    }
    // 返回值没带 id 时（旧版 store / 未来重构），从本项目 conversation_log 回查最近一条。
    // 仅在本轮确实落库成功时回查；save 失败时不能把上一轮同文本的行认成本轮。
    if (!memoryId && results.conversationSaved)
        memoryId = findConversationTurnId(proj, args.userMessage, cid);
    // VAD 异步队列 — 不阻塞消息管道；条目带上 project + memoryId，flush 时精确回写。
    // 落库失败时不入队：没有本轮记录可回写，位置兜底可能误伤上一轮同文本的行。
    if (results.conversationSaved && memoryId) {
        try {
            queueForVad(formatInteractionForVad(args.userMessage, args.assistantMessage), proj, memoryId, cid);
            results.details.push('VAD queued (async batch)');
        }
        catch (e) {
            results.details.push('VAD queue error: ' + e.message);
        }
    }
    else if (results.conversationSaved) {
        results.details.push('VAD queue skipped (conversation has no memory id)');
    }
    else {
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
        }
        catch (e) {
            results.details.push('session buffer error: ' + e.message);
        }
    }
    return results;
}
export { formatVADForPrompt };
/**
 * 实时分拣：用启发式返回默认分类 + 推入 Ollama 异步队列
 *
 * 真正的 tier/category/importance 由两处补齐：
 *   - digest 周期：ollamaClassify() 单次调用重分类
 *   - reflect 周期：LLM 深度反思兜底
 */
export async function classifyMessage(text, context, project, memoryId, characterId) {
    // A queue item without its durable memory id can only be matched by position,
    // which is unsafe under concurrent projects. Legacy callers may still pass
    // no id and receive the cheap fallback classification, but they do not enter
    // the VAD write-back queue.
    if (memoryId)
        queueForVad(text, project, memoryId, characterId);
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
//# sourceMappingURL=autoProcessor.js.map