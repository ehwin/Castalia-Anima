/**
 * digest v6.2 — 轻量周期任务
 *
 * 职责：
 *   1. 消费 VAD 队列（批量情感分析 + 批量贴标签）
 *   2. 清理过期临时记忆
 *   3. 恢复丢失的 critical 记忆
 *
 * 不负责：
 *   ✗ 合并对话 → reflect 做
 *   ✗ 提纯/升华 → reflect 做
 *   ✗ 打分新生成句子 → reflect 做
 *
 * 事件驱动：有新对话才跑，间隔 ≥ 1 分钟
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeProject } from './env.js';
import { flushVadQueue } from './emotion.js';
import { cleanupExpiredMemories } from './store.js';
const MIN_DIGEST_GAP_MS = 60 * 1000;
// v1.23.2-fix: 按 project 节流（旧实现全局单值，一个项目跑 digest 会压制其它项目 60s）
const lastDigestTimes = new Map();
export async function runDigest(characterId = 'airi', project) {
    const db = DatabaseManager.getInstance(project);
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
    // 2. 清理过期临时记忆(memdir:遍历项目全部分类库)
    result.cleaned = cleanupExpiredMemories(project);
    // 3. 恢复被误标记的 critical 记忆(memdir:遍历项目全部分类库)
    const proj = normalizeProject(project);
    let restored = 0;
    for (const mt of listMemTypeDirs(proj)) {
        try {
            const mdb = DatabaseManager.getInstance(proj, mt);
            const lostCritical = mdb.prepare(`
        UPDATE memory SET is_active = 1
        WHERE tier = 'critical' AND is_active = 0
      `).run();
            restored += lostCritical.changes;
        }
        catch (e) {
            result.errors.push('restore critical: ' + e.message);
        }
    }
    result.restored = restored;
    return result;
}
export function maybeDigest(characterId = 'airi', project) {
    const now = Date.now();
    const projKey = normalizeProject(project);
    if (now - (lastDigestTimes.get(projKey) || 0) < MIN_DIGEST_GAP_MS)
        return null;
    const db = DatabaseManager.getInstance(project);
    const unanalyzed = db.prepare(`
    SELECT COUNT(*) as c FROM memory
    WHERE is_active = 1 AND source = 'conversation_log'
      AND last_accessed_at = created_at
  `).get()?.c || 0;
    if (unanalyzed === 0)
        return null;
    lastDigestTimes.set(projKey, now);
    return runDigest(characterId, project);
}
export function getRecentConversations(characterId, hoursBack = 24, limit = 50, project) {
    const db = DatabaseManager.getInstance(project);
    const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
    const proj = normalizeProject(project);
    return db.prepare(`
    SELECT id, text, created_at, importance
    /* 对话审计带写入时 is_active=0(store.ts saveConversationTurn);
     * 按 is_active=1 过滤会永远查不到新数据(2026-10-17 修)。 */
    FROM memory WHERE source = 'conversation_log' AND project = ?
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(proj, since, limit);
}
