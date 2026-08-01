/**
 * 记忆整理 — sigmoid 时间衰减 + reference_count 升华
 *
 * 去重完全交给大模型 reflect 接口做语义判断，consolidate 只做纯规则维护：
 * - Phase 1: sigmoid 时间衰减 → 旧记忆自动降权，低于阈值软删除
 * - Phase 2: reference_count 升华 → 被反复引用的记忆重要性提升
 */
import { DatabaseManager } from './db.js';
const ACTIVATION_THRESHOLD = 0.15;
export async function consolidate() {
    const db = DatabaseManager.getInstance();
    const now = Date.now();
    // ═══ Phase 1: sigmoid 时间衰减 ═══
    const activeRecords = db.prepare(`
    SELECT id, importance, last_accessed_at
    FROM memory WHERE is_active = 1 AND source != 'manual_lore' AND tier != 'critical' AND (locked IS NULL OR locked = 0)
  `).all();
    let prunedCount = 0;
    let updatedCount = 0;
    const decayTx = db.transaction(() => {
        for (const mem of activeRecords) {
            const hoursSince = (now - new Date(mem.last_accessed_at).getTime()) / 3600000;
            const daysSince = hoursSince / 24;
            const decay = 1.0 / (1.0 + Math.exp(0.04 * (daysSince - 90)));
            const newImportance = Math.round(mem.importance * decay * 1000) / 1000;
            if (newImportance < ACTIVATION_THRESHOLD && daysSince > 60) {
                db.prepare('UPDATE memory SET is_active = 0, importance = ? WHERE id = ?')
                    .run(newImportance, mem.id);
                prunedCount++;
            }
            else {
                db.prepare('UPDATE memory SET importance = ? WHERE id = ?')
                    .run(newImportance, mem.id);
                updatedCount++;
            }
        }
    });
    decayTx();
    // ═══ Phase 2: reference_count 升华 ═══
    let consolidateCount = 0;
    const dupes = db.prepare('SELECT id FROM memory WHERE is_active = 1 AND reference_count > 2 LIMIT 20').all();
    for (const dup of dupes) {
        db.prepare('UPDATE memory SET reference_count = 0, importance = MIN(0.95, importance + 0.1) WHERE id = ?').run(dup.id);
        consolidateCount++;
    }
    return {
        success: true,
        decayedOrUpdated: updatedCount,
        pruned: prunedCount,
        consolidated: consolidateCount,
    };
}
