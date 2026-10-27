/**
 * digest v6.2 — 轻量周期任务
 *
 * 职责：
 *   1. 消费 VAD 队列（批量情感分析 + 批量贴标签）
 *   2. 清理过期临时记忆
 *
 * 不负责：
 *   ✗ 合并对话 → reflect 做
 *   ✗ 提纯/升华 → reflect 做
 *   ✗ 打分新生成句子 → reflect 做
 *
 * 事件驱动：有新对话才跑，间隔 ≥ 1 分钟
 */
import { DatabaseManager } from './db.js';
import { normalizeProject, CHAR_ID } from './env.js';
import { flushVadQueue } from './emotion.js';
import { cleanupExpiredMemories } from './store.js';
const MIN_DIGEST_GAP_MS = 60 * 1000;
// v1.23.2-fix: 按 project 节流（旧实现全局单值，一个项目跑 digest 会压制其它项目 60s）
const lastDigestTimes = new Map();
export async function runDigest(characterId = CHAR_ID, project) {
    const db = DatabaseManager.getInstance(project);
    const cid = characterId || CHAR_ID;
    const result = {
        success: true,
        vadUpdated: false,
        cleaned: 0,
        restored: 0,
        errors: [],
    };
    // 1. 消费 VAD 队列 — 只处理本项目分组（不同 project 不混批）。
    //    显式 normalize：不传 project 时也固定落到默认项目，避免一次 digest 把别人的队列全消费掉。
    //    force:false = 保留周期批量的“攒够 5 条 / 最老 10 分钟”阈值，避免每条消息一次 LLM 调用。
    try {
        const vadResult = await flushVadQueue(normalizeProject(project), { force: false });
        if (vadResult) {
            result.vadUpdated = true;
            result.details = result.details || [];
            result.details.push('VAD: v=' + vadResult.vad.valence.toFixed(2)
                + ' a=' + vadResult.vad.arousal.toFixed(2)
                + ' tsun=' + vadResult.tsundereLevel);
        }
        result.details?.push('queue flushed');
    }
    catch (e) {
        result.errors.push('VAD flush: ' + e.message);
    }
    // 2. 清理过期临时记忆(memdir:遍历项目全部分类库;v1.24 只清本角色)
    result.cleaned = cleanupExpiredMemories(project, cid);
    // 3. critical 记忆不再无条件复活（对齐 Lite/Full 的等价实现）：
    //    inactive 可能代表人工删除、合并删除或跨 memType 迁移墓碑；
    //    无条件 UPDATE ... is_active = 1 会让用户显式删掉的 critical 在 60s 定时器下反复活过来。
    //    只有显式人工恢复接口(store.restoreMemory)可以恢复。
    return result;
}
export function maybeDigest(characterId = CHAR_ID, project) {
    const now = Date.now();
    const projKey = normalizeProject(project);
    if (now - (lastDigestTimes.get(projKey) || 0) < MIN_DIGEST_GAP_MS)
        return null;
    const db = DatabaseManager.getInstance(project);
    const unanalyzed = db.prepare(`
    SELECT COUNT(*) as c FROM memory
    WHERE is_active = 1 AND source = 'conversation_log' AND character_id = ?
      AND last_accessed_at = created_at
  `).get(characterId || CHAR_ID)?.c || 0;
    if (unanalyzed === 0)
        return null;
    lastDigestTimes.set(projKey, now);
    return runDigest(characterId, project);
}
export function getRecentConversations(characterId = CHAR_ID, hoursBack = 24, limit = 50, project) {
    const db = DatabaseManager.getInstance(project);
    const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
    const proj = normalizeProject(project);
    return db.prepare(`
    SELECT id, text, created_at, importance
    /* 对话审计带写入时 is_active=0(store.ts saveConversationTurn);
     * 按 is_active=1 过滤会永远查不到新数据(2026-10-17 修)。 */
    FROM memory WHERE source = 'conversation_log' AND project = ? AND character_id = ?
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(proj, characterId || CHAR_ID, since, limit);
}
//# sourceMappingURL=digest.js.map