/** Original records and explicit processing progress, independent of summaries. */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeProject, CHAR_ID } from './env.js';
function ensureReflectionProgress(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS reflection_progress (
    conversation_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    project TEXT NOT NULL,
    character_id TEXT NOT NULL,
    PRIMARY KEY (project, character_id, conversation_id)
  )`);
    const columns = db.prepare('PRAGMA table_info(reflection_progress)').all();
    const hasCharacter = columns.some(column => column.name === 'character_id');
    const primaryKey = columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => column.name);
    const expectedPrimaryKey = ['project', 'character_id', 'conversation_id'];
    if (!hasCharacter || primaryKey.join('|') !== expectedPrimaryKey.join('|')) {
        // Older tables had no role key (or used only project + conversation_id).
        // Their rows predate role isolation, so keep them under the process default
        // role. Do not use the caller's role here: a new role must not inherit an
        // old role's cursor just because it was the first one to trigger migration.
        const legacy = `reflection_progress_legacy_${Date.now()}`;
        db.transaction(() => {
            db.exec(`ALTER TABLE reflection_progress RENAME TO ${legacy};
        CREATE TABLE reflection_progress (
          conversation_id TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          project TEXT NOT NULL,
          character_id TEXT NOT NULL,
          PRIMARY KEY (project, character_id, conversation_id)
        );`);
            const legacyColumns = db.prepare(`PRAGMA table_info(${legacy})`).all();
            const hasLegacyCharacter = legacyColumns.some(column => column.name === 'character_id');
            if (hasLegacyCharacter) {
                db.prepare(`INSERT OR IGNORE INTO reflection_progress (conversation_id, processed_at, project, character_id)
          SELECT conversation_id, processed_at, project, COALESCE(NULLIF(character_id, ''), ?) FROM ${legacy}`)
                    .run(CHAR_ID);
            }
            else {
                db.prepare(`INSERT OR IGNORE INTO reflection_progress (conversation_id, processed_at, project, character_id)
          SELECT conversation_id, processed_at, project, ? FROM ${legacy}`)
                    .run(CHAR_ID);
            }
            db.exec(`DROP TABLE ${legacy};`);
        })();
    }
}
export function markConversationsReflected(ids, project, characterId = CHAR_ID) {
    if (!ids.length)
        return;
    const proj = normalizeProject(project);
    const cid = characterId || CHAR_ID;
    const now = new Date().toISOString();
    const db = DatabaseManager.getInstance(proj);
    ensureReflectionProgress(db);
    const stmt = db.prepare('INSERT OR REPLACE INTO reflection_progress (conversation_id, processed_at, project, character_id) VALUES (?, ?, ?, ?)');
    db.transaction((values) => values.forEach(id => stmt.run(id, now, proj, cid)))(ids);
}
export function deepReflectionCursor(project, nextId) {
    const db = DatabaseManager.getInstance(project);
    db.exec('CREATE TABLE IF NOT EXISTS reflection_scan (project TEXT PRIMARY KEY, last_id TEXT NOT NULL)');
    const proj = normalizeProject(project);
    if (nextId !== undefined)
        db.prepare('INSERT OR REPLACE INTO reflection_scan (project, last_id) VALUES (?, ?)').run(proj, nextId);
    return db.prepare('SELECT last_id FROM reflection_scan WHERE project = ?').get(proj)?.last_id || '';
}
export function getUnanalyzedConversations(characterId = CHAR_ID, since, // 可选日期筛选，处理进度始终按来源 ID 记录
limit = 30, project) {
    const proj = normalizeProject(project);
    const cid = characterId || CHAR_ID;
    const dbs = listMemTypeDirs(proj).map(mt => DatabaseManager.getInstance(proj, mt));
    // A summary timestamp is not a processing cursor: a failed/partial run may still
    // create a summary and would permanently hide the remaining conversation log.
    const processed = new Set();
    try {
        const progressDb = DatabaseManager.getInstance(proj);
        ensureReflectionProgress(progressDb);
        const progressRows = cid === 'any'
            ? progressDb.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ?').all(proj)
            : progressDb.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ? AND character_id = ?').all(proj, cid);
        for (const row of progressRows)
            processed.add(row.conversation_id);
    }
    catch { /* use the per-library fallback below */ }
    for (const db of dbs) {
        try {
            ensureReflectionProgress(db);
            const progressRows = cid === 'any'
                ? db.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ?').all(proj)
                : db.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ? AND character_id = ?').all(proj, cid);
            for (const row of progressRows)
                processed.add(row.conversation_id);
        }
        catch { /* older databases are created lazily */ }
    }
    // Anima 对话审计原文含活跃和历史行；跨库按时间排序，再应用全局 limit。
    // v1.24: 角色隔离 — 只取本实例角色(charId='any' 时关闭过滤,供跨库管理场景)。
    const all = [];
    for (const db of dbs) {
        try {
            all.push(...db.prepare(`
        SELECT id, text, created_at, subject, mem_type, emotional_impact,
               vad_valence, vad_arousal, vad_dominance, agent_mood, agent_desire, tsundere_level
        FROM memory
        WHERE source = 'conversation_log'
          -- 2026-10-29:软删(is_active=0)的对话不再作为抽取来源。
          -- 实测:被软删的自检对话仍被当成"待分析",抽出「自检习惯」这类事实写回库;
          -- 删掉的东西又被反刍复活,是用户永远关不掉的污染源。
          AND is_active = 1
          -- 2026-10-31: 显式标了 noReflect 的行(如按批次恢复的历史原文)不参与重抽,
          -- 否则恢复三个月前的对话等于把同一批原文再抽一遍,产出重复洞察。
          AND COALESCE(metadata, '') NOT LIKE '%"noReflect":true%'
          AND project = ?
          -- Legacy NULL rows are unowned; only an explicit cross-role caller
          -- may inspect them.
          AND (? = 'any' OR character_id = ?)
          AND (? IS NULL OR created_at > ?)
        ORDER BY created_at ASC
      `).all(proj, cid, cid, since || null, since || null));
        }
        catch { /* 单分类库失败不影响其它库 */ }
    }
    all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    const ids = new Set();
    for (const row of all) {
        if (ids.has(row.id))
            throw new Error(`Ambiguous conversation ID across memory types: ${row.id}`);
        ids.add(row.id);
    }
    return all.filter(row => !processed.has(row.id)).slice(0, limit).map(row => ({
        id: row.id, text: row.text, createdAt: row.created_at, subject: row.subject,
        memType: row.mem_type || 'general', emotionalImpact: row.emotional_impact ?? 0,
        vad: { valence: row.vad_valence, arousal: row.vad_arousal, dominance: row.vad_dominance },
        agentMood: row.agent_mood, agentDesire: row.agent_desire, tsundereLevel: row.tsundere_level ?? 0,
    }));
}
//# sourceMappingURL=reflectionSources.js.map