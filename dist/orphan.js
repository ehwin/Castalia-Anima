/**
 * 找出(并可选地软删)指向已消失会话的记忆。
 *
 * 注意:这里不判断"会话是否被回滚过" —— 那是宿主的事。引擎只回答一个可验证的问题:
 * 这条记忆声称属于哪个 session,而那个 session 还在不在。
 */
export function orphanMemories(db, opts) {
    const project = String(opts.project || '').trim();
    const alive = Array.isArray(opts.aliveSessionIds) ? [...new Set(opts.aliveSessionIds.map(String))] : null;
    const dryRun = opts.dryRun !== false; // 默认就是 dry-run:想写必须显式 dryRun:false
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 5000;
    const base = {
        ok: false, dryRun, anchored: 0, orphans: 0, orphaned: 0, skippedNoAnchor: 0, sample: [],
    };
    if (!project)
        return { ...base, refused: 'project 必填' };
    if (alive === null)
        return { ...base, refused: 'aliveSessionIds 必须是数组' };
    if (alive.length === 0 && opts.allowEmpty !== true) {
        return { ...base, refused: 'aliveSessionIds 为空:拒绝执行(避免一次误调用软删整库)' };
    }
    const rowOf = (sql, ...p) => {
        try {
            return db.prepare(sql).get(...p);
        }
        catch {
            return null;
        }
    };
    const total = Number(rowOf("SELECT COUNT(*) n FROM memory WHERE is_active = 1 AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')")?.n ?? 0);
    const anchored = Number(rowOf("SELECT COUNT(*) n FROM memory WHERE is_active = 1 AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') AND session_id IS NOT NULL AND session_id <> ''")?.n ?? 0);
    base.anchored = anchored;
    base.skippedNoAnchor = Math.max(0, total - anchored);
    if (anchored === 0)
        return { ...base, ok: true };
    const placeholders = alive.map(() => '?').join(',');
    const where = alive.length > 0
        ? `m.is_active = 1 AND m.session_id IS NOT NULL AND m.session_id <> '' AND m.session_id NOT IN (${placeholders})`
        : "m.is_active = 1 AND m.session_id IS NOT NULL AND m.session_id <> ''";
    let rows = [];
    try {
        rows = db.prepare(`
      SELECT m.id, m.session_id, m.text, m.created_at, m.source, m.metadata
      FROM memory m
      WHERE COALESCE(m.source, '') NOT IN ('agent_diary', 'agent_state') AND ${where}
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(...alive, limit);
    }
    catch (e) {
        return { ...base, refused: `查询失败: ${e.message}` };
    }
    base.orphans = rows.length;
    base.sample = rows.slice(0, 5).map(r => ({
        id: String(r.id),
        sessionId: String(r.session_id),
        text: String(r.text || '').slice(0, 60),
        createdAt: String(r.created_at || ''),
        source: r.source ? String(r.source) : null,
    }));
    if (dryRun || rows.length === 0)
        return { ...base, ok: true };
    const upd = db.prepare('UPDATE memory SET is_active = 0, metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const now = new Date().toISOString();
    let orphaned = 0;
    const tx = db.transaction((list) => {
        for (const r of list) {
            let meta = {};
            try {
                meta = r.metadata ? JSON.parse(String(r.metadata)) : {};
            }
            catch {
                meta = { _unparsed: String(r.metadata) };
            }
            meta.orphanedAt = now;
            meta.orphanedReason = 'session-gone';
            meta.orphanedSession = String(r.session_id);
            upd.run(JSON.stringify(meta), String(r.id));
            orphaned++;
        }
    });
    try {
        tx(rows);
    }
    catch (e) {
        return { ...base, refused: `写入失败: ${e.message}` };
    }
    return { ...base, ok: true, orphaned };
}
/** 审计:各 session 下有多少条活跃记忆(给"要不要对账"提供数据) */
export function sessionInventory(db, limit = 200) {
    try {
        return db.prepare(`
      SELECT session_id AS sessionId, COUNT(*) AS memories, MAX(created_at) AS latest
      FROM memory WHERE is_active = 1 AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') AND session_id IS NOT NULL AND session_id <> ''
      GROUP BY session_id ORDER BY memories DESC LIMIT ?
    `).all(limit).map(r => ({
            sessionId: String(r.sessionId), memories: Number(r.memories) || 0, latest: String(r.latest || ''),
        }));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=orphan.js.map