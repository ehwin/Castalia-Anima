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

/** 归一化实体键:小写 + 标点/空白压成单空格 + 去首尾 */
export function normalizeEntityKey(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text)
    .toLowerCase()
    .replace(/[\s"'`。，,.、:：;；!！?？()（）[\]【】<>《》/\\|~^*_+=—-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 归一化后太短/太长的直接丢掉(标点、单个字符噪声、整段正文误当实体) */
export function isUsableEntityKey(key: string, kind: EntityKind = 'topic'): boolean {
  if (!key) return false;
  const max = kind === 'path' || kind === 'url' ? 240 : 80;
  if (key.length > max) return false;
  if (key.length === 1 && !/[\u4e00-\u9fa5a-z0-9]/.test(key)) return false;
  return true;
}

/**
 * 给实体分类,便于把"角色位/文件路径/URL/配置项/数字"从真正的知识实体里分出来。
 *
 * 为什么需要:实测线上数据里,从 facts.object 直接归一化出来的实体有相当比例是
 * `D:\AI\...`、`http://localhost:11434`、`.env.bak-20260731`、`1024`、`¥0.07/M` 这类东西。
 * 它们不是知识图谱的节点,而是"当时顺手记下的字符串"。分类之后:
 *   - 查询仍能命中(kind 只是标注,不删数据);
 *   - memory_graph 只画 topic/role,不把路径噪声画成节点。
 */
export type EntityKind = 'role' | 'url' | 'path' | 'config' | 'number' | 'topic';

/**
 * 基于**原始字符串**判断类别(必须在归一化之前判断:归一化会把 `\` `/` 当标点压掉,
 * 路径/URL 的形状就没了)。
 */
export function classifyEntityName(raw: string): EntityKind {
  const s = String(raw ?? '').trim();
  if (!s) return 'topic';
  const lower = s.toLowerCase();
  if (/^(user|agent|environment|reference|assistant|system|human|用户|助手|环境|参考|系统|我|你)$/.test(lower)) return 'role';
  if (/:\/\//.test(s) || /^(https?|ftp|ws|wss)\b/.test(lower)) return 'url';
  if (/^[a-z]:[\\/]/.test(lower) || /^\\\\/.test(s) || /^[a-z]:$/.test(lower)) return 'path';
  if (/[\\/]/.test(s) && /\.(ts|js|mjs|cjs|json|toml|ya?ml|env|bak|log|db|sqlite|md|py|rs|exe|dll)\b/i.test(s)) return 'path';
  if (/^\.env/i.test(s) || /^[a-z][a-z0-9_]*=/i.test(s)) return 'config';
  if (/^[¥$€]?\d+([.,]\d+)?\s*([a-z%]+(\/[a-z]+)?)?$/i.test(s) && /\d/.test(s)) return 'number';
  return 'topic';
}

/** 兼容:对已经归一化的键再判一次类别(历史行重算用) */
export function classifyEntityKey(key: string): EntityKind {
  const k = String(key ?? '').trim();
  if (!k) return 'topic';
  if (/^(user|agent|environment|reference|assistant|system|human|用户|助手|环境|参考|系统|我|你)$/.test(k)) return 'role';
  if (/:\/\//.test(k)) return 'url';
  if (/^[a-z]:[\\/]/.test(k) || /^\\\\/.test(k)) return 'path';
  if (/^\.env/.test(k) || /^[a-z][a-z0-9_]*=/.test(k)) return 'config';
  if (/^[¥$€]?\d+([.,]\d+)?\s*([a-z%]+(\/[a-z]+)?)?$/.test(k) && /\d/.test(k)) return 'number';
  return 'topic';
}

/** 路径/URL 这类键保留分隔符(否则 `D:\AI\x` 会变成 `d ai x`,再也匹配不回去) */
export function entityKeyFor(raw: string, kind: EntityKind): string {
  const s = String(raw ?? '').trim();
  return kind === 'path' || kind === 'url' ? s.toLowerCase() : normalizeEntityKey(s);
}

/** 画图/扩散时默认跳过的噪声类别(查询不受影响) */
export const NOISE_KINDS: EntityKind[] = ['url', 'path', 'config', 'number'];

export function entityIdFor(key: string): string {
  return 'ent_' + createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/** 只算 id/键/类别,不写库(用于"事实刚写完,顺手把摘要记忆挂上去"这类场景,不重复累加 mention_count) */
export function entityIdOfName(rawName: string | null | undefined): { id: string; key: string; kind: EntityKind } | null {
  const raw = String(rawName ?? '').trim();
  if (!raw) return null;
  const kind = classifyEntityName(raw);
  const key = entityKeyFor(raw, kind);
  if (!isUsableEntityKey(key, kind)) return null;
  return { id: entityIdFor(key), key, kind };
}

/**
 * 把记忆挂到已存在的实体上(INSERT OR IGNORE + 存在性检查,不新建实体、不累加计数)。
 * 允许跨分类库:实体在 facts 所在的库,记忆行可能在别的库,id 是全局 UUID 所以关联仍然有意义。
 */
export function linkMemoryToEntityIds(db: any, memoryId: string, entityIds: string[], role = 'fact'): number {
  if (!memoryId || !entityIds?.length) return 0;
  let linked = 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role)
    SELECT ?, id, ? FROM entities WHERE id = ?`);
  db.transaction(() => {
    for (const id of new Set(entityIds)) { const r = stmt.run(memoryId, role, id); linked += r.changes; }
  })();
  return linked;
}

/**
 * 给一批事实算出实体 id(不写库),用于把"产出这批事实的记忆"和实体连起来。
 */
export function entityIdsOfFacts(facts: Array<{ subject?: string; object?: string }>): string[] {
  const ids = new Set<string>();
  for (const f of facts || []) {
    for (const raw of [f?.subject, f?.object]) {
      const e = entityIdOfName(raw);
      if (e) ids.add(e.id);
    }
  }
  return [...ids];
}

/** 插入或更新一个实体,返回 { id, key } */
export function upsertEntity(db: any, rawName: string | null | undefined, kind?: string): { id: string; key: string; name: string } | null {
  const raw = String(rawName ?? '').trim();
  const entityKind = (kind as EntityKind) ?? classifyEntityName(raw);
  const key = entityKeyFor(raw, entityKind);
  if (!isUsableEntityKey(key, entityKind)) return null;
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
  const row = db.prepare('SELECT id, key, name FROM entities WHERE key = ?').get(key) as any;
  return row ? { id: row.id, key: row.key, name: row.name } : null;
}

/**
 * 把一条事实的 subject/object 登记成实体并建关联。
 * 幂等:fact_entities 主键 (fact_id, entity_id, role)。
 */
export function linkFactEntities(db: any, factId: string, subject: string | null, object: string | null): { subjectEntityId: string | null; objectEntityId: string | null; linked: number } {
  const ins = db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id, role) VALUES (?, ?, ?)');
  let linked = 0;
  const subjectEntity = upsertEntity(db, subject);
  const objectEntity = upsertEntity(db, object);
  if (subjectEntity) linked += ins.run(factId, subjectEntity.id, 'subject').changes;
  if (objectEntity) linked += ins.run(factId, objectEntity.id, 'object').changes;
  return { subjectEntityId: subjectEntity?.id ?? null, objectEntityId: objectEntity?.id ?? null, linked };
}

/** 记忆 ↔ 实体关联(幂等) */
export function linkMemoryToEntities(db: any, memoryId: string | null | undefined, entityIds: Array<string | null | undefined>, role = 'fact'): number {
  if (!memoryId) return 0;
  const ins = db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)');
  let linked = 0;
  for (const entityId of entityIds) if (entityId) linked += ins.run(memoryId, entityId, role).changes;
  return linked;
}

/** 名字 → 实体:先精确 key,再前缀,再包含(都按 mention_count 排序) */
export function findEntities(db: any, query: string, limit = 10): any[] {
  const raw = String(query ?? '').trim();
  // 同时试"归一化键"和"路径/URL 原样小写键",否则 D:\AI\x 这类查询永远匹配不到
  const keys = [...new Set([normalizeEntityKey(raw), raw.toLowerCase()])].filter(Boolean);
  if (keys.length === 0) return [];
  const clauses = keys.map(() => 'key = ? OR key LIKE ? OR key LIKE ?').join(' OR ');
  const params: any[] = [];
  for (const k of keys) params.push(k, `${k}%`, `%${k}%`);
  const order = keys.map(() => 'WHEN key = ? THEN 0 WHEN key LIKE ? THEN 1').join(' ');
  params.push(...keys.flatMap(k => [k, `${k}%`]));
  const rows = db.prepare(`
    SELECT id, key, name, kind, mention_count, first_seen, last_seen FROM entities
    WHERE ${clauses}
    ORDER BY CASE ${order} ELSE 2 END, mention_count DESC
    LIMIT ?
  `).all(...params, limit) as any[];
  return rows;
}

/** 实体 → 当前有效事实(时间点可选) */
export function entityFacts(db: any, entityId: string, at?: string, limit = 20): any[] {
  const ts = at || new Date().toISOString();
  return db.prepare(`
    SELECT f.id, f.subject, f.predicate, f.object, f.confidence, f.valid_from, f.valid_to,
           f.source_memory_id, f.character_id, f.project, fe.role AS entity_role,
           (f.valid_to IS NULL OR f.valid_to = '') AS is_current
    FROM fact_entities fe
    JOIN facts f ON f.id = fe.fact_id
    WHERE fe.entity_id = ? AND f.is_active = 1
      AND (f.valid_from IS NULL OR f.valid_from <= ?)
      AND (f.valid_to IS NULL OR f.valid_to = '' OR f.valid_to > ?)
    ORDER BY f.confidence DESC, f.updated_at DESC
    LIMIT ?
  `).all(entityId, ts, ts, limit) as any[];
}

/** 实体 → 相关记忆(1 跳:事实源记忆 + 记忆↔实体关联) */
export function entityMemories(db: any, entityId: string, limit = 20): any[] {
  return db.prepare(`
    WITH linked AS (
      SELECT me.memory_id AS id FROM memory_entities me WHERE me.entity_id = ?
      UNION
      SELECT f.source_memory_id AS id FROM fact_entities fe JOIN facts f ON f.id = fe.fact_id
      WHERE fe.entity_id = ? AND f.source_memory_id IS NOT NULL
    )
    SELECT m.id, m.text, m.mem_type, m.importance, m.character_id, m.created_at
    FROM linked JOIN memory m ON m.id = linked.id
    WHERE m.is_active = 1
    ORDER BY m.importance DESC, m.updated_at DESC
    LIMIT ?
  `).all(entityId, entityId, limit) as any[];
}

/**
 * 实体图的广度扩散:depth=1 只到直接关联实体,2 再跳一层。
 * 用递归 CTE 表达变长路径(Cypher 的 `*1..n` 在 SQL 里的等价物)。
 */
export function expandEntityGraph(db: any, entityId: string, depth = 1, limit = 50): { entities: any[]; memories: any[] } {
  const d = Math.max(1, Math.min(3, depth));
  const entities = db.prepare(`
    WITH RECURSIVE hop(entity_id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN fe.entity_id = hop.entity_id THEN fe2.entity_id ELSE fe.entity_id END, hop.depth + 1
      FROM hop
      JOIN fact_entities fe ON fe.entity_id = hop.entity_id
      JOIN fact_entities fe2 ON fe2.fact_id = fe.fact_id AND fe2.entity_id != fe.entity_id
      WHERE hop.depth < ?
    )
    SELECT DISTINCT e.id, e.key, e.name, e.mention_count, h.depth
    FROM hop h JOIN entities e ON e.id = h.entity_id
    WHERE h.depth > 0
    ORDER BY h.depth, e.mention_count DESC
    LIMIT ?
  `).all(entityId, d, limit) as any[];

  const memories = db.prepare(`
    WITH RECURSIVE hop(entity_id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN fe.entity_id = hop.entity_id THEN fe2.entity_id ELSE fe.entity_id END, hop.depth + 1
      FROM hop
      JOIN fact_entities fe ON fe.entity_id = hop.entity_id
      JOIN fact_entities fe2 ON fe2.fact_id = fe.fact_id AND fe2.entity_id != fe.entity_id
      WHERE hop.depth < ?
    )
    SELECT DISTINCT m.id, m.text, m.importance
    FROM hop h
    JOIN fact_entities fe ON fe.entity_id = h.entity_id
    JOIN facts f ON f.id = fe.fact_id AND f.is_active = 1 AND (f.valid_to IS NULL OR f.valid_to = '')
    JOIN memory m ON m.id = f.source_memory_id AND m.is_active = 1
    LIMIT ?
  `).all(entityId, d, limit) as any[];

  return { entities, memories };
}

/**
 * 回填:把还没有实体关联的事实补上(幂等、有上限,可在每次打开库时自愈)。
 * 线上老库第一次打开时会走这里,不需要手工迁移。
 */
export function backfillEntities(db: any, batch = 2000): { factsLinked: number; memoriesLinked: number; entities: number } {
  let factsLinked = 0;
  let memoriesLinked = 0;
  const pending = db.prepare(`
    SELECT f.id, f.subject, f.object, f.source_memory_id FROM facts f
    WHERE f.is_active = 1 AND NOT EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = f.id)
    LIMIT ?
  `).all(batch) as any[];

  const tx = db.transaction((rows: any[]) => {
    for (const row of rows) {
      const linked = linkFactEntities(db, row.id, row.subject, row.object);
      factsLinked++;
      if (row.source_memory_id)
        memoriesLinked += linkMemoryToEntities(db, row.source_memory_id, [linked.subjectEntityId, linked.objectEntityId]);
    }
  });
  if (pending.length > 0) tx(pending);
  const entities = (db.prepare('SELECT COUNT(*) c FROM entities').get() as any)?.c ?? 0;
  return { factsLinked, memoriesLinked, entities };
}

export function entityStats(db: any): { entities: number; factLinks: number; memoryLinks: number; multiHopEntities: number; byKind: Record<string, number> } {
  const one = (sql: string) => { try { return (db.prepare(sql).get() as any)?.c ?? 0; } catch { return 0; } };
  const byKind: Record<string, number> = {};
  try {
    for (const r of db.prepare('SELECT kind, COUNT(*) c FROM entities GROUP BY kind ORDER BY c DESC').all() as any[]) byKind[r.kind ?? 'unknown'] = r.c;
  } catch { /* 老库无 kind 列 */ }
  return {
    entities: one('SELECT COUNT(*) c FROM entities'),
    factLinks: one('SELECT COUNT(*) c FROM fact_entities'),
    memoryLinks: one('SELECT COUNT(*) c FROM memory_entities'),
    multiHopEntities: one(`SELECT COUNT(*) c FROM (SELECT entity_id FROM fact_entities GROUP BY entity_id HAVING COUNT(DISTINCT fact_id) > 1)`),
    byKind,
  };
}

/** 把历史行(旧 kind 值)按归一化键重算类别。幂等、有上限。 */
export function reclassifyEntities(db: any, batch = 5000): number {
  let rows: any[] = [];
  try {
    rows = db.prepare("SELECT id, key FROM entities WHERE kind IS NULL OR kind IN ('subject','object','unknown','') LIMIT ?").all(batch) as any[];
  } catch { return 0; }
  if (rows.length === 0) return 0;
  const upd = db.prepare('UPDATE entities SET kind = ? WHERE id = ?');
  db.transaction(() => { for (const r of rows) upd.run(classifyEntityKey(r.key), r.id); })();
  return rows.length;
}

/**
 * 供 memory_graph 用的"实体切片":在给定的记忆节点集合上,补出
 *   - 被这些记忆提到的实体节点
 *   - 记忆 ↔ 实体边(mentions)
 *   - 实体 ↔ 实体边(同一事实里的共现,co_occurs)
 * 这样一次查询就能同时看到"记忆关系图"和"实体关系图"。
 */
export function entityGraphSlice(db: any, memoryIds: string[], limit = 50): { entities: any[]; memoryEntityEdges: any[]; entityEntityEdges: any[] } {
  if (memoryIds.length === 0) return { entities: [], memoryEntityEdges: [], entityEntityEdges: [] };
  const placeholders = memoryIds.map(() => '?').join(',');

  // 排序用"在这批记忆里被提到几次",而不是全局 mention_count ——
  // 否则高热的角色位(user/environment)会挤掉真正和这批记忆相关的实体,边也跟着丢。
  const entities = db.prepare(`
    SELECT e.id, e.key, e.name, e.mention_count, e.kind, COUNT(*) AS hits
    FROM memory_entities me JOIN entities e ON e.id = me.entity_id
    WHERE me.memory_id IN (${placeholders})
      AND COALESCE(e.kind, 'topic') NOT IN ('url', 'path', 'config', 'number')
    GROUP BY e.id
    ORDER BY hits DESC, e.mention_count DESC LIMIT ?
  `).all(...memoryIds, limit) as any[];
  const entityIds = entities.map(e => e.id);
  if (entityIds.length === 0) return { entities, memoryEntityEdges: [], entityEntityEdges: [] };
  const entPlaceholders = entityIds.map(() => '?').join(',');

  const memoryEntityEdges = db.prepare(`
    SELECT DISTINCT me.memory_id AS sourceId, me.entity_id AS targetId, me.role AS relationType
    FROM memory_entities me
    WHERE me.memory_id IN (${placeholders}) AND me.entity_id IN (${entPlaceholders})
  `).all(...memoryIds, ...entityIds) as any[];

  const entityEntityEdges = db.prepare(`
    SELECT DISTINCT a.entity_id AS sourceId, b.entity_id AS targetId, 'co_occurs' AS relationType
    FROM fact_entities a
    JOIN fact_entities b ON a.fact_id = b.fact_id AND a.entity_id < b.entity_id
    WHERE a.entity_id IN (${entPlaceholders}) AND b.entity_id IN (${entPlaceholders})
    LIMIT 500
  `).all(...entityIds, ...entityIds) as any[];

  return { entities, memoryEntityEdges, entityEntityEdges };
}

/** 矛盾/失效报告:被推翻的历史事实 + 同 subject 下的当前多值(潜在冲突) */
export function conflictsReport(db: any, limit = 50): { invalidated: any[]; multiValued: any[] } {
  const invalidated = db.prepare(`
    SELECT f.id, f.subject, f.predicate, f.object, f.valid_from, f.valid_to, f.source_memory_id
    FROM facts f
    WHERE f.is_active = 1 AND f.valid_to IS NOT NULL AND f.valid_to != ''
    ORDER BY f.valid_to DESC LIMIT ?
  `).all(limit) as any[];

  const multiValued = db.prepare(`
    SELECT f.subject, f.predicate, COUNT(DISTINCT f.object) AS values_count,
           GROUP_CONCAT(DISTINCT f.object) AS objects
    FROM facts f
    WHERE f.is_active = 1 AND (f.valid_to IS NULL OR f.valid_to = '')
    GROUP BY f.subject, f.predicate
    HAVING COUNT(DISTINCT f.object) > 1
    ORDER BY values_count DESC LIMIT ?
  `).all(limit) as any[];

  return { invalidated, multiValued };
}
