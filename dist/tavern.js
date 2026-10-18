import crypto from 'node:crypto';
import { DatabaseManager, safeFilePart } from './db.js';
/** Synchronize the selected chat snapshot. No reflection, persona or user-profile side effects. */
export function syncTavernChat(project, messages) {
    if (!/^st_[a-f0-9]{40}$/.test(project) || safeFilePart(project) !== project) {
        throw new Error('SillyTavern requires an isolated st_<sha1> project');
    }
    const db = DatabaseManager.getInstance(project);
    const now = new Date().toISOString();
    const ids = new Set();
    const rows = messages.map(message => {
        if (ids.has(message.id))
            throw new Error('Duplicate chat message ID');
        ids.add(message.id);
        return {
            id: `st_${crypto.createHash('sha256').update(`${project}:${message.id}`).digest('hex')}`,
            text: `${message.name}（${message.role === 'user' ? '用户扮演角色' : '角色'}）: ${message.text}`,
            createdAt: message.createdAt && Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : now,
        };
    });
    let changed = 0;
    let deleted = 0;
    db.transaction(() => {
        const existing = db.prepare("SELECT id, text, is_active, rowid FROM memory WHERE project=? AND source='sillytavern_chat'").all(project);
        const previous = new Map(existing.map(row => [row.id, row]));
        const current = new Set(rows.map(row => row.id));
        for (const row of existing) {
            if (!current.has(row.id) && row.is_active) {
                db.prepare('UPDATE memory SET is_active=0, updated_at=? WHERE id=?').run(now, row.id);
                db.prepare('DELETE FROM vec_memory WHERE rowid=?').run(row.rowid);
                deleted++;
            }
        }
        for (const row of rows) {
            const old = previous.get(row.id);
            if (old?.is_active && old.text === row.text)
                continue;
            if (old) {
                db.prepare('UPDATE memory SET text=?, is_active=1, updated_at=? WHERE id=?').run(row.text, now, row.id);
                db.prepare('DELETE FROM vec_memory WHERE rowid=?').run(old.rowid);
            }
            else {
                db.prepare(`INSERT INTO memory (id,text,project,session_id,type,mem_type,category,tags,importance,character_id,source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,reference_count)
          VALUES (?,?,?,?,'episodic','general','conversation','[]',0.5,?,'sillytavern_chat','environment','standard',1,?,?,?,0,0)`)
                    .run(row.id, row.text, project, project, project, row.createdAt, now, now);
            }
            changed++;
        }
    })();
    return { project, count: rows.length, changed, deleted };
}
