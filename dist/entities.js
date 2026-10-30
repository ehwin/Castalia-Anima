/**
 * 实体层(Entity Layer)v1.27
 *
 * 背景:facts 一直是纯文本三元组,`subject`/`object` 是自由字符串,所以
 * "和某实体相关的事实/记忆"只能靠 LIKE 扫正文 —— 我们不需要图数据库来解决它,
 * 需要的是一张规范化的实体表 + 两张某实体到事实/记忆的关联表,然后一次 JOIN。
 *
 * 表结构(在 db.ts 里建):
 *   entities(id, key, name, kind, mention_count, first_seen, last_seen)
 *   fact_entities(fact_id, entity_id, role)     role ∈ subject|object
 *   memory_entities(memory_id, entity_id, role) role ∈ fact|mention
 *
 * 设计取舍:
 *   - 实体 id 由归一化键的 sha1 派生 → 跨进程/跨库稳定,不依赖自增,可安全 INSERT OR IGNORE。
 *   - 归一化只做确定性处理(小写、去标点空白),不调用 LLM:先保证写入路径零成本、可回归;
 *     后续要合并别名("张三"/"小张")再加 entity_aliases 表 + LLM 裁决。
 *   - 记忆的实体关联来自"它产出的事实"(`source_memory_id`),免费且语义清晰;
 *     正文抽取(记忆正文里直接出现的实体)留作后续增强。
 */
import { createHash } from 'node:crypto';
import { CHAR_ID, normalizeProject } from './env.js';
/** 归一化实体键:小写 + 标点/空白压成单空格 + 去首尾 */
export function normalizeEntityKey(text) {
    if (text === null || text === undefined)
        return '';
    return String(text)
        .toLowerCase()
        .replace(/[\s"'`。，,.、:：;；!！?？()（）[\]【】<>《》/\\|~^*_+=—-]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}
/** 归一化后太短/太长的直接丢掉(标点、单个字符噪声、整段正文误当实体) */
export function isUsableEntityKey(key, kind = 'topic') {
    if (!key)
        return false;
    const max = kind === 'path' || kind === 'url' ? 240 : 80;
    if (key.length > max)
        return false;
    if (key.length === 1 && !/[\u4e00-\u9fa5a-z0-9]/.test(key))
        return false;
    return true;
}
/**
 * 基于**原始字符串**判断类别(必须在归一化之前判断:归一化会把 `\` `/` 当标点压掉,
 * 路径/URL 的形状就没了)。
 */
export function classifyEntityName(raw) {
    const s = String(raw ?? '').trim();
    if (!s)
        return 'topic';
    const lower = s.toLowerCase();
    if (/^(user|agent|environment|reference|assistant|system|human|用户|助手|环境|参考|系统|我|你)$/.test(lower))
        return 'role';
    if (/:\/\//.test(s) || /^(https?|ftp|ws|wss)\b/.test(lower))
        return 'url';
    if (/^[a-z]:[\\/]/.test(lower) || /^\\\\/.test(s) || /^[a-z]:$/.test(lower))
        return 'path';
    if (/[\\/]/.test(s) && /\.(ts|js|mjs|cjs|json|toml|ya?ml|env|bak|log|db|sqlite|md|py|rs|exe|dll)\b/i.test(s))
        return 'path';
    if (/^\.env/i.test(s) || /^[a-z][a-z0-9_]*=/i.test(s))
        return 'config';
    if (/^[¥$€]?\d+([.,]\d+)?\s*([a-z%]+(\/[a-z]+)?)?$/i.test(s) && /\d/.test(s))
        return 'number';
    return 'topic';
}
/** 兼容:对已经归一化的键再判一次类别(历史行重算用) */
export function classifyEntityKey(key) {
    const k = String(key ?? '').trim();
    if (!k)
        return 'topic';
    if (/^(user|agent|environment|reference|assistant|system|human|用户|助手|环境|参考|系统|我|你)$/.test(k))
        return 'role';
    if (/:\/\//.test(k))
        return 'url';
    if (/^[a-z]:[\\/]/.test(k) || /^\\\\/.test(k))
        return 'path';
    if (/^\.env/.test(k) || /^[a-z][a-z0-9_]*=/.test(k))
        return 'config';
    if (/^[¥$€]?\d+([.,]\d+)?\s*([a-z%]+(\/[a-z]+)?)?$/.test(k) && /\d/.test(k))
        return 'number';
    return 'topic';
}
/** 路径/URL 这类键保留分隔符(否则 `D:\AI\x` 会变成 `d ai x`,再也匹配不回去) */
export function entityKeyFor(raw, kind) {
    const s = String(raw ?? '').trim();
    return kind === 'path' || kind === 'url' ? s.toLowerCase() : normalizeEntityKey(s);
}
/** 画图/扩散时默认跳过的噪声类别(查询不受影响) */
export const NOISE_KINDS = ['url', 'path', 'config', 'number'];
function memoryDbList(relationDb, memoryDbs) {
    const out = [];
    const seen = new Set();
    for (const item of memoryDbs || [relationDb]) {
        const db = (item && item.db) ? item.db : item;
        if (!db || seen.has(db))
            continue;
        seen.add(db);
        out.push(db);
    }
    return out;
}
/** Load memory rows by id across physical memType databases. */
function loadMemoryRows(relationDb, ids, project, characterId, limit, memoryDbs) {
    const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
    if (uniqueIds.length === 0)
        return [];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = [];
    for (const db of memoryDbList(relationDb, memoryDbs)) {
        try {
            const scope = characterId === 'any' ? 'AND (? = \'any\' OR character_id = ?)' : 'AND character_id = ?';
            const params = characterId === 'any'
                ? [...uniqueIds, project, characterId, characterId]
                : [...uniqueIds, project, characterId];
            rows.push(...db.prepare(`
        SELECT id, text, mem_type, importance, character_id, created_at, updated_at, source
        FROM memory
        WHERE id IN (${placeholders})
          AND is_active = 1
          AND project = ?
          ${scope}
          AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')
      `).all(...params));
        }
        catch { /* a missing/legacy partition must not hide other partitions */ }
    }
    const dedup = new Map();
    for (const row of rows)
        if (!dedup.has(String(row.id)))
            dedup.set(String(row.id), row);
    return [...dedup.values()]
        .sort((a, b) => {
        const importance = Number(b.importance || 0) - Number(a.importance || 0);
        if (importance !== 0)
            return importance;
        return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    })
        .slice(0, Math.max(1, limit));
}
export function entityIdFor(key) {
    return 'ent_' + createHash('sha1').update(key).digest('hex').slice(0, 16);
}
/** 只算 id/键/类别,不写库(用于"事实刚写完,顺手把摘要记忆挂上去"这类场景,不重复累加 mention_count) */
export function entityIdOfName(rawName) {
    const raw = String(rawName ?? '').trim();
    if (!raw)
        return null;
    const kind = classifyEntityName(raw);
    const key = entityKeyFor(raw, kind);
    if (!isUsableEntityKey(key, kind))
        return null;
    return { id: entityIdFor(key), key, kind };
}
/**
 * 把记忆挂到已存在的实体上(INSERT OR IGNORE + 存在性检查,不新建实体、不累加计数)。
 * 允许跨分类库:实体在 facts 所在的库,记忆行可能在别的库,id 是全局 UUID 所以关联仍然有意义。
 */
export function linkMemoryToEntityIds(db, memoryId, entityIds, role = 'fact') {
    if (!memoryId || !entityIds?.length)
        return 0;
    let linked = 0;
    const stmt = db.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role)
    SELECT ?, id, ? FROM entities WHERE id = ?`);
    db.transaction(() => {
        for (const id of new Set(entityIds)) {
            const r = stmt.run(memoryId, role, id);
            linked += r.changes;
        }
    })();
    return linked;
}
/**
 * 给一批事实算出实体 id(不写库),用于把"产出这批事实的记忆"和实体连起来。
 */
export function entityIdsOfFacts(facts) {
    const ids = new Set();
    for (const f of facts || []) {
        for (const raw of [f?.subject, f?.object]) {
            const e = entityIdOfName(raw);
            if (e)
                ids.add(e.id);
        }
    }
    return [...ids];
}
/** 插入或更新一个实体,返回 { id, key } */
export function upsertEntity(db, rawName, kind) {
    const raw = String(rawName ?? '').trim();
    const entityKind = kind ?? classifyEntityName(raw);
    const key = entityKeyFor(raw, entityKind);
    if (!isUsableEntityKey(key, entityKind))
        return null;
    const id = entityIdFor(key);
    const name = raw.slice(0, 120);
    db.prepare(`
    INSERT INTO entities (id, key, name, kind, mention_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      mention_count = entities.mention_count + 1,
      last_seen = excluded.last_seen,
      name = CASE WHEN length(entities.name) <= length(excluded.name) THEN entities.name ELSE excluded.name END
  `).run(id, key, name, entityKind, new Date().toISOString(), new Date().toISOString());
    const row = db.prepare('SELECT id, key, name FROM entities WHERE key = ?').get(key);
    return row ? { id: row.id, key: row.key, name: row.name } : null;
}
/**
 * 把一条事实的 subject/object 登记成实体并建关联。
 * 幂等:fact_entities 主键 (fact_id, entity_id, role)。
 */
export function linkFactEntities(db, factId, subject, object) {
    const ins = db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id, role) VALUES (?, ?, ?)');
    let linked = 0;
    const subjectEntity = upsertEntity(db, subject);
    const objectEntity = upsertEntity(db, object);
    if (subjectEntity)
        linked += ins.run(factId, subjectEntity.id, 'subject').changes;
    if (objectEntity)
        linked += ins.run(factId, objectEntity.id, 'object').changes;
    return { subjectEntityId: subjectEntity?.id ?? null, objectEntityId: objectEntity?.id ?? null, linked };
}
/** 记忆 ↔ 实体关联(幂等) */
export function linkMemoryToEntities(db, memoryId, entityIds, role = 'fact') {
    if (!memoryId)
        return 0;
    try {
        const source = db.prepare('SELECT source FROM memory WHERE id = ?').get(memoryId);
        if (String(source?.source || '') === 'agent_diary')
            return 0;
    }
    catch { /* legacy schema / cross-database source: preserve existing link behavior */ }
    const ins = db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)');
    let linked = 0;
    for (const entityId of entityIds)
        if (entityId)
            linked += ins.run(memoryId, entityId, role).changes;
    return linked;
}
/** 名字 → 实体:先精确 key,再前缀,再包含(都按 mention_count 排序) */
export function findEntities(db, query, limit = 10) {
    const raw = String(query ?? '').trim();
    // 同时试"归一化键"和"路径/URL 原样小写键",否则 D:\AI\x 这类查询永远匹配不到
    const keys = [...new Set([normalizeEntityKey(raw), raw.toLowerCase()])].filter(Boolean);
    if (keys.length === 0)
        return [];
    const clauses = keys.map(() => 'key = ? OR key LIKE ? OR key LIKE ?').join(' OR ');
    const params = [];
    for (const k of keys)
        params.push(k, `${k}%`, `%${k}%`);
    const order = keys.map(() => 'WHEN key = ? THEN 0 WHEN key LIKE ? THEN 1').join(' ');
    params.push(...keys.flatMap(k => [k, `${k}%`]));
    const rows = db.prepare(`
    SELECT id, key, name, kind, mention_count, first_seen, last_seen FROM entities
    WHERE ${clauses}
    ORDER BY CASE ${order} ELSE 2 END, mention_count DESC
    LIMIT ?
  `).all(...params, limit);
    return rows;
}
/** 实体 → 当前有效事实(时间点可选) */
export function entityFacts(db, entityId, at, limit = 20, characterId = CHAR_ID, project) {
    const ts = at || new Date().toISOString();
    const proj = normalizeProject(project);
    return db.prepare(`
    SELECT f.id, f.subject, f.predicate, f.object, f.confidence, f.valid_from, f.valid_to,
           f.source_memory_id, f.character_id, f.project, fe.role AS entity_role,
           (f.valid_to IS NULL OR f.valid_to = '') AS is_current
    FROM fact_entities fe
    JOIN facts f ON f.id = fe.fact_id
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE fe.entity_id = ? AND f.is_active = 1
      AND f.project = ? AND f.character_id = ?
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
      AND (f.valid_from IS NULL OR f.valid_from <= ?)
      AND (f.valid_to IS NULL OR f.valid_to = '' OR f.valid_to > ?)
    ORDER BY f.confidence DESC, f.updated_at DESC
    LIMIT ?
  `).all(entityId, proj, characterId, ts, ts, limit);
}
/** 实体 → 相关记忆(1 跳:事实源记忆 + 记忆↔实体关联) */
export function entityMemories(db, entityId, limit = 20, characterId = CHAR_ID, project, memoryDbs) {
    const proj = normalizeProject(project);
    const linked = db.prepare(`
    WITH linked AS (
      SELECT me.memory_id AS id FROM memory_entities me WHERE me.entity_id = ?
      UNION
      SELECT f.source_memory_id AS id FROM fact_entities fe JOIN facts f ON f.id = fe.fact_id
      LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
      WHERE fe.entity_id = ? AND f.source_memory_id IS NOT NULL
        AND f.is_active = 1 AND f.project = ? AND (? = 'any' OR f.character_id = ?)
        AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
    )
    SELECT id FROM linked
  `).all(entityId, entityId, proj, characterId, characterId);
    return loadMemoryRows(db, linked.map(row => String(row.id)), proj, characterId, limit, memoryDbs);
}
/**
 * 实体图的广度扩散:depth=1 只到直接关联实体,2 再跳一层。
 * 用递归 CTE 表达变长路径(Cypher 的 `*1..n` 在 SQL 里的等价物)。
 */
export function expandEntityGraph(db, entityId, depth = 1, limit = 50, characterId = CHAR_ID, project, memoryDbs) {
    const d = Math.max(1, Math.min(3, depth));
    const proj = normalizeProject(project);
    const cid = characterId || CHAR_ID;
    const entities = db.prepare(`
    WITH RECURSIVE hop(entity_id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN fe.entity_id = hop.entity_id THEN fe2.entity_id ELSE fe.entity_id END, hop.depth + 1
      FROM hop
      JOIN fact_entities fe ON fe.entity_id = hop.entity_id
      JOIN facts f ON f.id = fe.fact_id
        AND f.is_active = 1
      LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
      JOIN fact_entities fe2 ON fe2.fact_id = fe.fact_id AND fe2.entity_id != fe.entity_id
      WHERE hop.depth < ?
        AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
        AND f.project = ?
        AND f.character_id = ?
    )
    SELECT DISTINCT e.id, e.key, e.name, e.mention_count, h.depth
    FROM hop h JOIN entities e ON e.id = h.entity_id
    WHERE h.depth > 0
    ORDER BY h.depth, e.mention_count DESC
    LIMIT ?
  `).all(entityId, d, proj, cid, limit);
    const linkedMemories = db.prepare(`
    WITH RECURSIVE hop(entity_id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN fe.entity_id = hop.entity_id THEN fe2.entity_id ELSE fe.entity_id END, hop.depth + 1
      FROM hop
      JOIN fact_entities fe ON fe.entity_id = hop.entity_id
      JOIN facts f ON f.id = fe.fact_id
        AND f.is_active = 1
      LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
      JOIN fact_entities fe2 ON fe2.fact_id = fe.fact_id AND fe2.entity_id != fe.entity_id
      WHERE hop.depth < ?
        AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
        AND f.project = ?
        AND f.character_id = ?
    )
    SELECT DISTINCT f.source_memory_id AS id
    FROM hop h
    JOIN fact_entities fe ON fe.entity_id = h.entity_id
    JOIN facts f ON f.id = fe.fact_id AND f.is_active = 1
    WHERE f.project = ? AND (? = 'any' OR f.character_id = ?)
      AND f.source_memory_id IS NOT NULL
      AND COALESCE(f.source_memory_source, '') NOT IN ('agent_diary', 'agent_state')
    LIMIT ?
  `).all(entityId, d, proj, cid, proj, cid, cid, limit);
    const memories = loadMemoryRows(db, linkedMemories.map(row => String(row.id)), proj, cid, limit, memoryDbs);
    return { entities, memories };
}
/**
 * 回填:把还没有实体关联的事实补上(幂等、有上限,可在每次打开库时自愈)。
 * 线上老库第一次打开时会走这里,不需要手工迁移。
 */
export function backfillEntities(db, batch = 2000) {
    let factsLinked = 0;
    let memoriesLinked = 0;
    const pending = db.prepare(`
    SELECT f.id, f.subject, f.object, f.source_memory_id FROM facts f
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE f.is_active = 1
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
      AND NOT EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = f.id)
    LIMIT ?
  `).all(batch);
    const tx = db.transaction((rows) => {
        for (const row of rows) {
            const linked = linkFactEntities(db, row.id, row.subject, row.object);
            factsLinked++;
            if (row.source_memory_id)
                memoriesLinked += linkMemoryToEntities(db, row.source_memory_id, [linked.subjectEntityId, linked.objectEntityId]);
        }
    });
    if (pending.length > 0)
        tx(pending);
    const entities = db.prepare('SELECT COUNT(*) c FROM entities').get()?.c ?? 0;
    return { factsLinked, memoriesLinked, entities };
}
export function entityStats(db, characterId = CHAR_ID, project) {
    const proj = normalizeProject(project);
    const factScope = `
    JOIN facts f ON f.id = fe.fact_id
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE f.is_active = 1 AND f.project = ?
      AND f.character_id = ?
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')`;
    const memoryScope = `
    JOIN memory m ON m.id = me.memory_id
    WHERE m.is_active = 1 AND m.project = ?
      AND m.character_id = ?
      AND COALESCE(m.source, '') NOT IN ('agent_diary', 'agent_state')`;
    const one = (sql, ...params) => { try {
        return db.prepare(sql).get(...params)?.c ?? 0;
    }
    catch {
        return 0;
    } };
    const byKind = {};
    try {
        const rows = db.prepare(`
      SELECT e.kind, COUNT(DISTINCT e.id) c
      FROM entities e
      WHERE EXISTS (
        SELECT 1 FROM fact_entities fe
        JOIN facts f ON f.id = fe.fact_id
        LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
        WHERE fe.entity_id = e.id AND f.is_active = 1 AND f.project = ?
          AND f.character_id = ?
          AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
      ) OR EXISTS (
        SELECT 1 FROM memory_entities me
        JOIN memory m ON m.id = me.memory_id
        WHERE me.entity_id = e.id AND m.is_active = 1 AND m.project = ?
          AND m.character_id = ?
          AND COALESCE(m.source, '') NOT IN ('agent_diary', 'agent_state')
      )
      GROUP BY e.kind ORDER BY c DESC
    `).all(proj, characterId, proj, characterId);
        for (const r of rows)
            byKind[r.kind ?? 'unknown'] = r.c;
    }
    catch { /* 老库无 kind 列 */ }
    return {
        entities: one(`SELECT COUNT(DISTINCT e.id) c FROM entities e WHERE EXISTS (
      SELECT 1 FROM fact_entities fe ${factScope} AND fe.entity_id = e.id
    ) OR EXISTS (
      SELECT 1 FROM memory_entities me ${memoryScope} AND me.entity_id = e.id
    )`, proj, characterId, proj, characterId),
        factLinks: one(`SELECT COUNT(*) c FROM fact_entities fe ${factScope}`, proj, characterId),
        memoryLinks: one(`SELECT COUNT(*) c FROM memory_entities me ${memoryScope}`, proj, characterId),
        multiHopEntities: one(`SELECT COUNT(*) c FROM (
      SELECT fe.entity_id FROM fact_entities fe ${factScope}
      GROUP BY fe.entity_id HAVING COUNT(DISTINCT fe.fact_id) > 1
    )`, proj, characterId),
        byKind,
    };
}
/** 把历史行(旧 kind 值)按归一化键重算类别。幂等、有上限。 */
export function reclassifyEntities(db, batch = 5000) {
    let rows = [];
    try {
        rows = db.prepare("SELECT id, key FROM entities WHERE kind IS NULL OR kind IN ('subject','object','unknown','') LIMIT ?").all(batch);
    }
    catch {
        return 0;
    }
    if (rows.length === 0)
        return 0;
    const upd = db.prepare('UPDATE entities SET kind = ? WHERE id = ?');
    db.transaction(() => { for (const r of rows)
        upd.run(classifyEntityKey(r.key), r.id); })();
    return rows.length;
}
/**
 * 供 memory_graph 用的"实体切片":在给定的记忆节点集合上,补出
 *   - 被这些记忆提到的实体节点
 *   - 记忆 ↔ 实体边(mentions)
 *   - 实体 ↔ 实体边(同一事实里的共现,co_occurs)
 * 这样一次查询就能同时看到"记忆关系图"和"实体关系图"。
 */
export function entityGraphSlice(db, memoryIds, limit = 50, characterId = CHAR_ID, project, memoryDbs) {
    if (memoryIds.length === 0)
        return { entities: [], memoryEntityEdges: [], entityEntityEdges: [] };
    const scopedMemoryIds = [...new Set(memoryIds.map(String).filter(Boolean))];
    const placeholders = scopedMemoryIds.map(() => '?').join(',');
    const proj = normalizeProject(project);
    const cid = characterId || CHAR_ID;
    const factScope = cid === 'any'
        ? 'AND f.project = ?'
        : 'AND f.project = ? AND f.character_id = ?';
    const factScopeParams = cid === 'any' ? [proj] : [proj, cid];
    // Relations live beside facts (normally general), but memory rows may be
    // in another physical memType database. Resolve active memory IDs first,
    // then use that set for entity counts and edges.
    const relationRows = db.prepare(`
    SELECT DISTINCT me.memory_id AS memoryId, me.entity_id AS entityId, me.role AS relationType
    FROM memory_entities me
    WHERE me.memory_id IN (${placeholders})
  `).all(...scopedMemoryIds);
    const activeMemoryRows = loadMemoryRows(db, scopedMemoryIds, proj, cid, scopedMemoryIds.length, memoryDbs);
    const activeIds = new Set(activeMemoryRows.map(row => String(row.id)));
    const links = relationRows.filter(row => activeIds.has(String(row.memoryId)));
    if (links.length === 0)
        return { entities: [], memoryEntityEdges: [], entityEntityEdges: [] };
    const linkedEntityIds = [...new Set(links.map(row => String(row.entityId)).filter(Boolean))];
    const entityPlaceholders = linkedEntityIds.map(() => '?').join(',');
    // 排序用"在这批记忆里被提到几次",而不是全局 mention_count ——
    // 否则高热的角色位(user/environment)会挤掉真正和这批记忆相关的实体,边也跟着丢。
    const entities = db.prepare(`
    SELECT e.id, e.key, e.name, e.mention_count, e.kind,
           (SELECT COUNT(*) FROM memory_entities me2
            WHERE me2.entity_id = e.id AND me2.memory_id IN (${placeholders})) AS hits
    FROM entities e
    WHERE e.id IN (${entityPlaceholders})
      AND COALESCE(e.kind, 'topic') NOT IN ('url', 'path', 'config', 'number')
    GROUP BY e.id
    ORDER BY hits DESC, e.mention_count DESC LIMIT ?
  `).all(...scopedMemoryIds, ...linkedEntityIds, limit);
    const entityIds = entities.map(e => e.id);
    if (entityIds.length === 0)
        return { entities, memoryEntityEdges: [], entityEntityEdges: [] };
    const entPlaceholders = entityIds.map(() => '?').join(',');
    const memoryEntityEdges = links
        .filter(row => entityIds.includes(String(row.entityId)))
        .map(row => ({ sourceId: String(row.memoryId), targetId: String(row.entityId), relationType: row.relationType }));
    const entityEntityEdges = db.prepare(`
    SELECT DISTINCT a.entity_id AS sourceId, b.entity_id AS targetId, 'co_occurs' AS relationType
    FROM fact_entities a
    JOIN fact_entities b ON a.fact_id = b.fact_id AND a.entity_id < b.entity_id
    JOIN facts f ON f.id = a.fact_id
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE a.entity_id IN (${entPlaceholders}) AND b.entity_id IN (${entPlaceholders})
      AND f.is_active = 1
      AND (f.valid_to IS NULL OR f.valid_to = '')
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
      ${factScope}
    LIMIT 500
  `).all(...entityIds, ...entityIds, ...factScopeParams);
    return { entities, memoryEntityEdges, entityEntityEdges };
}
/** 矛盾/失效报告:被推翻的历史事实 + 同 subject 下的当前多值(潜在冲突) */
export function conflictsReport(db, limit = 50, characterId = CHAR_ID, project) {
    const proj = normalizeProject(project);
    const invalidated = db.prepare(`
    SELECT f.id, f.subject, f.predicate, f.object, f.valid_from, f.valid_to, f.source_memory_id
    FROM facts f
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE f.is_active = 1 AND f.project = ?
      AND f.character_id = ?
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
      AND f.valid_to IS NOT NULL AND f.valid_to != ''
    ORDER BY f.valid_to DESC LIMIT ?
  `).all(proj, characterId, limit);
    const multiValued = db.prepare(`
    SELECT f.subject, f.predicate, COUNT(DISTINCT f.object) AS values_count,
           GROUP_CONCAT(DISTINCT f.object) AS objects
    FROM facts f
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE f.is_active = 1 AND f.project = ?
      AND f.character_id = ?
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
      AND (f.valid_to IS NULL OR f.valid_to = '')
    GROUP BY f.subject, f.predicate
    HAVING COUNT(DISTINCT f.object) > 1
    ORDER BY values_count DESC LIMIT ?
  `).all(proj, characterId, limit);
    return { invalidated, multiValued };
}
//# sourceMappingURL=entities.js.map