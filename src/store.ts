/**
 * Memory Store — 原文秒存，去重软抑制
 *
 * v5.0: skipEmbed 参数 — digest 暂不向量化，reflect 后统一 embed
 * v4.0: 去重不再丢弃，SQLite 持久化 embedding 缓存
 */
import { DatabaseManager, generateId, listMemTypeDirs } from './db.js';
import { linkFactEntities, linkMemoryToEntities } from './entities.js';
import type Database from 'better-sqlite3';
import { embed, getEmbeddingCached } from './ollama.js';
import { ensureChunksForRow } from './chunkIndex.js';
import { recordTopics } from './bias.js';
import { PROJECT_ID, CHAR_ID, normalizeProject, isEmbedEnabled } from './env.js';
import { MemType, isClosedMemType, normalizeMarkdown, normalizeMemType } from './memType.js';
import { parseTagsSafe, normalizeTagsForWrite, serializeTags } from './tags.js';
import { estimatePredicateVolatility, needsEvidence, shouldSupersede } from './volatility.js';

let saveCount = 0;
const CONSOLIDATE_INTERVAL = 50;

export interface StoreParams {
  text: string;
  project?: string;  // v1.5: 项目隔离 — 默认 PROJECT_ID(env CASTALIA_PROJECT)
  sessionId?: string;  // v1.11: 会话标识 — 落 session_id 列(会话级记忆,暂不参与检索)
  type?: 'episodic' | 'semantic' | 'entity' | 'preference';
  memType?: MemType;  // v1.8: 用途维度(user/feedback/project/reference/general),默认 general
  category?: string;
  subcategory?: string;
  tags?: string[];
  emotionalImpact?: number;  // v6.0: 情感冲击标量(0-10),VAD 三维由情感层单独回写
  importance?: number;
  characterId?: string;
  source?: string;
  subject?: 'user' | 'self' | 'environment';
  tier?: 'temporary' | 'standard' | 'critical';
  expiresAt?: string;
  skipEmbed?: boolean;  // v5.0: digest 暂不向量化
}

export interface MemoryRecord {
  id: string;
  text: string;
  project: string;
  sessionId: string | null;
  type: string;
  memType: MemType;
  category: string;
  subcategory: string | null;
  tags: string[];
  emotionalImpact: number;
  importance: number;
  characterId: string | null;
  source: string | null;
  subject: string;
  tier: string;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessedCount: number;
}

export async function saveMemory(params: StoreParams): Promise<MemoryRecord> {
  if (!params.text || !params.text.trim()) throw new Error('memory text must not be empty');
  // memdir 路由:按 memType 落对应分类库(memory/<project>/<memType>/memory.sqlite)
  const db = DatabaseManager.getInstance(params.project, params.memType);
  const now = new Date().toISOString();
  const skipEmbed = params.skipEmbed === true;
  const project = normalizeProject(params.project);
  const memType = normalizeMemType(params.memType);
  // v1.8: 4 种封闭类型(memType≠general)且 text 非 Markdown 时,自动规范化包装(加标题行+转列表)
  const text = normalizeMarkdown(params.text, memType);
  // v1.24: 角色 = 调用方显式指定,否则进程级 CHAR_ID —— 写入永不落 NULL(否则新行对所有角色都不可见)。
  const charId = params.characterId ?? CHAR_ID;

  // ═══ 精确去重：完全相同的文本不重复存(仅限同项目 + 同角色) ═══
  // v1.24: 角色隔离 — 去重也必须限定 character_id,否则会把别的角色的同文本记忆
  // 当成本次命中(reference_count 记到别人头上),返回的 id 对当前角色还不可见。
  const exactDup = db.prepare(`
    SELECT * FROM memory
    WHERE is_active = 1 AND project = ? AND TRIM(text) = TRIM(?)
      AND session_id IS ? AND subject = ? AND character_id IS ?
    LIMIT 1
  `).get(project, text?.trim() || '', params.sessionId ?? null, params.subject ?? 'user', charId) as any;

  if (exactDup) {
    db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(exactDup.id);
    const storedTags = parseTagsSafe(exactDup.tags);
    return {
      id: exactDup.id, text: exactDup.text, project: exactDup.project,
      sessionId: exactDup.session_id ?? null,
      type: exactDup.type, memType: exactDup.mem_type || memType, category: exactDup.category,
      subcategory: exactDup.subcategory ?? null, tags: storedTags,
      emotionalImpact: exactDup.emotional_impact ?? 0, importance: exactDup.importance ?? 0.5,
      characterId: exactDup.character_id ?? null, source: exactDup.source ?? null,
      subject: exactDup.subject ?? 'user',
      tier: exactDup.tier ?? 'standard', expiresAt: exactDup.expires_at ?? null,
      isActive: true,
      createdAt: exactDup.created_at, updatedAt: exactDup.updated_at, lastAccessedAt: exactDup.last_accessed_at,
      accessedCount: exactDup.accessed_count ?? 0,
    } as MemoryRecord;
    }

    // ═══ 向量去重：仅当不跳过 embed 且嵌入可用时执行(仅限同项目) ═══
  let vector: number[] | null = null;
  let isNearDup = false;
  let dupId: string | null = null;

  if (!skipEmbed && isEmbedEnabled()) {
    try {
      vector = await getEmbeddingCached(text, project);
      const floatVec = new Float32Array(vector);
      const knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ? ORDER BY distance LIMIT 10
      `).all(floatVec) as any[];

      if (knn.length > 0 && knn[0].distance < 0.05) {
        // v1.5: 项目隔离；v1.24: 角色隔离 — 仅当最近邻属于同项目 + 同角色才算重复
        const dupRow = db.prepare('SELECT id FROM memory WHERE rowid = ? AND project = ? AND character_id IS ?')
          .get(Number(knn[0].rowid), project, charId) as any;
        if (dupRow) {
          dupId = dupRow.id;
          isNearDup = true;
          db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(dupId);
        }
      }
    } catch {
      // KNN 不可用，跳过去重检查
    }
  }

  // ═══ 存入新记忆（不管是否近重复，都存） ═══
  const id = generateId();

  // tier + expires_at 计算:显式 expiresAt 优先;否则 temporary 默认 3 天 TTL,standard/critical 永不过期
  const tier = params.tier || 'standard';
  const expiresAt = params.expiresAt || (
    tier === 'temporary'
      ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() // 3天TTL
      : null // standard/critical 永不过期
  );

  const record: MemoryRecord = {
    id, text, project,
    sessionId: params.sessionId ?? null,
    type: params.type ?? 'episodic',
    memType,
    category: params.category ?? 'general',
    subcategory: params.subcategory ?? null,
    // v1.28-fix: 写入路径统一归一化 —— 落库的 tags 必然是 string[] 的 JSON 序列化结果，
    // 不再可能出现 '[1,null]' 这类"合法 JSON 但不是字符串数组"的脏值（历史脏行正来源于此）。
    tags: normalizeTagsForWrite(params.tags),
    emotionalImpact: Math.max(0, Math.min(10, Number(params.emotionalImpact) || 0)),
    importance: params.importance ?? 0.5,
    characterId: charId,
    source: params.source ?? null,
    subject: params.subject ?? 'user',
    tier,
    expiresAt,
    isActive: true,
    createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
  };

  const storeTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, emotional_impact, importance, base_importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.text, record.project, record.sessionId, record.type, record.memType, record.category, record.subcategory,
      serializeTags(record.tags), record.emotionalImpact,
      record.importance, record.importance,
      record.characterId, record.source, record.subject,
      record.tier, record.expiresAt, 1,
      record.createdAt, record.updatedAt, record.lastAccessedAt, 0, 0
    );

    // v5.0: 仅在非 skipEmbed 时写入向量
    if (!skipEmbed && vector) {
      const info = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(record.id) as any;
      const rowid = BigInt(info.rowid);
      // v1.28-fix: 这个 rowid 若还残留旧向量（历史孤儿 / 进程外硬删），先清再写。
      // 否则 INSERT 撞 sqlite-vec 的 vec0 主键，整个事务回滚 → 该条记忆永久保存失败且粘性。
      db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(rowid);
      db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(rowid, new Float32Array(vector));
    }
  });
  storeTx();

  // 记录 tags 到 bias(bias 学习:兴趣权重积累,随记忆沉淀人格)
  if (record.tags.length > 0 && record.characterId) {
    recordTopics(record.characterId, record.tags, record.project);
  }

  // 定期整理
  saveCount++;
  if (saveCount >= CONSOLIDATE_INTERVAL) {
    saveCount = 0;
    try {
      const { consolidate } = await import('./consolidate.js');
      consolidate().catch(() => {});
    } catch {}
  }

  return record;
}

/** 按 id 定位记忆所在分类库(memdir 遍历),返回库连接+分类;找不到返回 null。
 *  v1.24: 传 characterId 时只认该角色的行(角色隔离:跨角色 id 一律视为不存在)。 */
export function findDbByMemoryId(id: string, project?: string, characterId?: string): { db: Database.Database; memType: string } | null {
  const proj = normalizeProject(project);
  const own = characterId ? ' AND character_id = ?' : '';
  const ownArgs = characterId ? [characterId] : [];
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    if (db.prepare(`SELECT id FROM memory WHERE id = ? AND is_active = 1${own}`).get(id, ...ownArgs)) return { db, memType: mt };
  }
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    if (db.prepare(`SELECT id FROM memory WHERE id = ?${own}`).get(id, ...ownArgs)) return { db, memType: mt };
  }
  return null;
}

export function forgetMemory(id: string, project?: string, characterId?: string): boolean {
  const found = findDbByMemoryId(id, project, characterId);
  if (!found) return false;
  return found.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id).changes > 0;
}
export function restoreMemory(id: string, project?: string, characterId?: string): boolean {
  const found = findDbByMemoryId(id, project, characterId);
  if (!found) return false;
  return found.db.prepare('UPDATE memory SET is_active = 1 WHERE id = ?').run(id).changes > 0;
}
export async function updateMemory(id: string, updates: Partial<StoreParams>, characterId?: string): Promise<MemoryRecord | null> {
  const found = findDbByMemoryId(id, updates.project, characterId);
  if (!found) return null;
  let db = found.db;
  const existing = db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
  if (!existing) return null;

  // memdir 跨分类移动:memType 变更 → 复制到新分类库 + 软删原库
  const newMt = updates.memType !== undefined ? normalizeMemType(updates.memType) : found.memType;
  if (newMt !== found.memType) {
    const proj = normalizeProject(updates.project);
    const newDb = DatabaseManager.getInstance(proj, newMt);
    const text = updates.text !== undefined ? normalizeMarkdown(updates.text, newMt) : existing.text;
    const tags = updates.tags !== undefined
      ? serializeTags(updates.tags)
      : JSON.stringify(parseTagsSafe(existing.tags));  // v1.28-fix: 搬移时不把历史脏值原样抄到新库
    const now = new Date().toISOString();
    newDb.prepare(`
      INSERT OR REPLACE INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, base_importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, locked, emotional_impact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      text,
      proj,
      existing.session_id,
      updates.type !== undefined ? updates.type : existing.type,
      newMt,
      updates.category !== undefined ? updates.category : existing.category,
      updates.subcategory !== undefined ? updates.subcategory : existing.subcategory,
      tags,
      updates.importance !== undefined ? updates.importance : existing.importance,
      updates.importance !== undefined ? updates.importance : (existing.base_importance ?? existing.importance),
      updates.characterId !== undefined ? updates.characterId : existing.character_id,
      updates.source !== undefined ? updates.source : existing.source,
      updates.subject !== undefined ? updates.subject : existing.subject,
      updates.tier !== undefined ? updates.tier : existing.tier,
      existing.expires_at ?? null,
      existing.created_at, now, now,
      existing.accessed_count, existing.reference_count ?? 0,
      existing.locked ?? 0,
      updates.emotionalImpact ?? existing.emotional_impact ?? 0,
    );
    const emotionFields = ['metadata', 'agent_mood', 'agent_desire', 'vad_valence', 'vad_arousal', 'vad_dominance', 'tsundere_level'];
    newDb.prepare(`UPDATE memory SET ${emotionFields.map(name => `${name} = ?`).join(', ')} WHERE id = ?`)
      .run(...emotionFields.map(name => existing[name] ?? null), id);
    // 向量一并搬移(若有)
    try {
      const srcVec = db.prepare('SELECT embedding FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').get(id) as any;
      if (srcVec) {
        newDb.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id);
        const rowInfo = newDb.prepare('SELECT rowid FROM memory WHERE id = ?').get(id) as any;
        newDb.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(rowInfo.rowid), srcVec.embedding);
      }
    } catch { /* 无向量/损坏忽略 */ }
    db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id);
    db = newDb;
    // 已处理 memType 变更,移除以免重复 SET
    if (updates.memType !== undefined) delete (updates as any).memType;
    return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
  }

  const fields: string[] = [];
  const values: any[] = [];
  let text: string | undefined;
  if (updates.text !== undefined) {
    // v1.8: memType 为 4 种封闭类型时,更新 text 同样规范化包装
    text = normalizeMarkdown(updates.text, updates.memType);
    fields.push('text = ?'); values.push(text);
  }
  if (updates.memType !== undefined) { fields.push('mem_type = ?'); values.push(normalizeMemType(updates.memType)); }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
  if (updates.subcategory !== undefined) { fields.push('subcategory = ?'); values.push(updates.subcategory); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(serializeTags(updates.tags)); }
  if (updates.importance !== undefined) {
    fields.push('importance = ?, base_importance = ?');
    values.push(updates.importance, updates.importance);
  }

  if (fields.length === 0) return existing;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE memory SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  if (updates.text !== undefined && isEmbedEnabled()) {
    const newVec = await getEmbeddingCached(text!, updates.project);
    db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id);
    const rowInfo = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id) as any;
    db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(
      BigInt(rowInfo.rowid),
      new Float32Array(newVec)
    );
  }

  return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
}
/**
 * 存储对话原文（轻量，不做分析，不做向量化）
 * v5.0: 对话原文永不 embed — digest 分拣后再由 reflect 统一向量化
 */
export async function saveConversationTurn(
  userMsg: string,
  assistantMsg: string,
  characterId: string = CHAR_ID,
  moodValue?: number,
  moodReason?: string,
  project?: string,  // v1.5: 项目隔离
): Promise<any> {
  const db = DatabaseManager.getInstance(project);
  const now = new Date().toISOString();
  const id = generateId();
  const proj = normalizeProject(project);

  let moodPrefix = '';
  if (moodValue !== undefined) {
    moodPrefix = `[mood: ${moodValue}`;
    if (moodReason) moodPrefix += `, "${moodReason}"`;
    moodPrefix += ']\n';
  }

  const assistantName = (process.env.CASTALIA_ASSISTANT_NAME || '助手').trim() || '助手';
  const text = `${moodPrefix}用户: ${userMsg}\n${assistantName}: ${assistantMsg}`;

  db.prepare(`
    INSERT INTO memory (id, text, project, type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
    VALUES (?, ?, ?, 'episodic', 'conversation', '[]', 0.5, ?, 'conversation_log', 'user', 'standard', 1, ?, ?, ?, 0, 0)
  `).run(id, text, proj, characterId, now, now, now);

  return { id, ok: true };
}

/**
 * 清理过期的临时记忆 (tier='temporary', expires_at < now)
 * 返回清理数量
 */
// ═══ v1.3: 热度升格 — 常被访问的记忆自动变强(UPSP 热度思想) ═══
// 访问次数 ≥ HEAT_PROMOTE_THRESHOLD 的 temporary 记忆自动升 standard(免清理)
const HEAT_PROMOTE_THRESHOLD = parseInt(process.env.HEAT_PROMOTE_THRESHOLD || '5', 10);

// ═══ v1.23 冷存分层：长期不用的低价值记忆退出"新沉淀"，但不删除、仍可检索 ═══
// 判定：非 critical / 非 locked / 非 superseded，importance < 0.6，无引用，且
//       last_accessed_at（没有则 created_at）超过 N 天（默认 60）。
const COLD_AFTER_DAYS = (() => { const v = parseFloat(process.env.COLD_AFTER_DAYS || '60'); return Number.isFinite(v) && v > 0 ? v : 60; })();
const COLD_MAX_IMPORTANCE = (() => { const v = parseFloat(process.env.COLD_MAX_IMPORTANCE || '0.6'); return Number.isFinite(v) && v > 0 ? v : 0.6; })();

export function markColdMemories(project?: string, characterId: string = CHAR_ID): number {
  const proj = normalizeProject(project);
  const cid = characterId ?? CHAR_ID;
  const cutoff = new Date(Date.now() - COLD_AFTER_DAYS * 86400000).toISOString();
  let marked = 0;
  for (const mt of listMemTypeDirs(proj)) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      // v1.23-fix: last_accessed_at/created_at 同时存在 ISO "T…Z" 与 SQLite "YYYY-MM-DD HH:MM:SS"
      // 两种格式，直接做字符串比较会把同一天不同时刻判错（' ' < 'T'），差一天。
      // 统一过 datetime() 归一化后再比。
      // v1.24: 角色隔离 — 维护动作只作用于本实例角色,不替其它角色降权。
      const r = db.prepare(`
        UPDATE memory SET status = 'cold'
        WHERE project = ? AND character_id = ? AND is_active = 1
          AND COALESCE(status, '') NOT IN ('cold', 'superseded')
          AND COALESCE(tier, 'standard') = 'standard'
          AND (locked IS NULL OR locked = 0)
          AND importance < ?
          AND COALESCE(reference_count, 0) = 0
          AND datetime(COALESCE(last_accessed_at, created_at)) < datetime(?)
      `).run(proj, cid, COLD_MAX_IMPORTANCE, cutoff);
      marked += r.changes;
    } catch { /* 单库失败不影响其它库 */ }
  }
  if (marked > 0) console.error(`[cold] ${marked} 条记忆转为冷存（>${COLD_AFTER_DAYS} 天未访问且 importance<${COLD_MAX_IMPORTANCE}）`);
  return marked;
}

export function promoteByAccess(project?: string, characterId: string = CHAR_ID): number {
  const proj = normalizeProject(project);
  const cid = characterId ?? CHAR_ID;
  const now = new Date().toISOString();
  let total = 0;
  // memdir:遍历项目全部分类库(临时记忆可能落在任意 memType 分类库)
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    const r = db.prepare(`
      UPDATE memory SET tier = 'standard', updated_at = ?
      WHERE tier = 'temporary' AND accessed_count >= ? AND is_active = 1 AND character_id = ?
    `).run(now, HEAT_PROMOTE_THRESHOLD, cid);
    total += r.changes;
  }
  if (total > 0) console.error(`[memory] heat promote: ${total} temporary → standard`);
  return total;
}

export function cleanupExpiredMemories(project?: string, characterId: string = CHAR_ID): number {
  const proj = normalizeProject(project);
  const cid = characterId ?? CHAR_ID;
  const now = new Date().toISOString();
  // 先升格再清理:被反复访问的 temporary 不该被清
  promoteByAccess(project, cid);
  let total = 0;
  // memdir:遍历项目全部分类库清理过期 temporary(避免只清 general 漏掉 user/feedback/project/reference)
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    const result = db.prepare(`
      UPDATE memory SET is_active = 0, updated_at = ?
      WHERE tier = 'temporary' AND expires_at IS NOT NULL AND expires_at < ? AND is_active = 1 AND character_id = ?
    `).run(now, now, cid);
    total += result.changes;
  }
  return total;
}

/**
 * v5.0: 重新向量化单条记忆 — reflect 后调用
 * 删旧向量 + embed 新文本 + 插入新向量
 */
export async function reEmbedMemory(id: string, project?: string): Promise<boolean> {
  // v1.23.2-fix: 按 id 定位真实分类库（旧实现只查默认 general 库，跨库记忆永远重嵌失败）
  const found = findDbByMemoryId(id, project);
  if (!found) return false;
  const db = found.db;
  const mem = db.prepare('SELECT rowid, text FROM memory WHERE id = ? AND is_active = 1').get(id) as any;
  if (!mem) return false;

  try {
    const vec = new Float32Array(await embed(mem.text, project));
    db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(mem.rowid));
    db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(mem.rowid), vec);
    return true;
  } catch (e: any) {
    console.error(`[store] reEmbedMemory failed for ${id}: ${e.message}`);
    return false;
  }
}

/**
 * v5.0: 批量向量化 — reflect 后一次性处理所有未嵌入记忆
 * v1.5: 支持按项目隔离 — 传 project 只处理该项目;不传则默认项目
 * 扫描 is_active=1 但 vec_memory 中无对应向量的记录
 */
export async function batchEmbedPending(characterId: string = CHAR_ID, project?: string): Promise<{ embedded: number; errors: string[] }> {
  if (!isEmbedEnabled()) return { embedded: 0, errors: ['embedding disabled (EMBED_MODE=none)'] };
  const proj = normalizeProject(project);
  let embedded = 0;
  const errors: string[] = [];
  // memdir:遍历项目全部分类库补嵌入
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);

  // 找所有有记忆但无向量的记录(source 为 NULL 也算,修复 NULL != 'x' 恒假的坑)
  // characterId='any' 时不按角色过滤(跨库产物如 reflect 库 character_id 为 NULL 也能补嵌入)
  const conditions = [
    'm.is_active = 1',
    'm.rowid NOT IN (SELECT rowid FROM vec_memory)',
    'COALESCE(m.embed_fail_count, 0) < 3',
  ];
  const params: any[] = [];
  if (characterId !== 'any') {
    conditions.push('m.character_id = ?');
    params.push(characterId);
  }
  conditions.push("COALESCE(m.source, '') != 'conversation_log'");
  if (project) {
    conditions.push('m.project = ?');
    params.push(proj);
  }
  const pending = db.prepare(`
    SELECT m.id, m.text, m.rowid FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(m.embed_fail_count, 0) ASC, m.created_at ASC
    LIMIT 200
  `).all(...params) as any[];

  for (const row of pending) {
    try {
      const vec = new Float32Array(await embed(row.text, project));
      db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
      db.prepare('UPDATE memory SET embed_fail_count = 0 WHERE rowid = ?').run(row.rowid);
      // 2026-10-28:整行向量之外再建句级片段索引(长记忆的整行余弦被稀释,详见 chunkIndex.ts)
      try { await ensureChunksForRow(db, Number(row.rowid), String(row.text)); } catch { /* 片段失败不影响整行 */ }
      embedded++;
    } catch (e: any) {
      try { db.prepare('UPDATE memory SET embed_fail_count = COALESCE(embed_fail_count, 0) + 1 WHERE rowid = ?').run(row.rowid); } catch { /* 旧库无列 */ }
      errors.push(`${row.id}: ${e.message}`);
    }
  }
  }
  return { embedded, errors };
}

// ═══════════════════════════════════════════════════════════════════
// Facts: Subject-Predicate-Object 三元组存储
// ═══════════════════════════════════════════════════════════════════

export interface FactRecord {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceMemoryId: string | null;
  characterId: string | null;
  isActive: boolean;
  accessedCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 批量存储事实 — 自动处理去重（subject+predicate+object 唯一）
 *
 * 去重策略：
 *   - 同一 S-P-O → 更新 confidence 为 MAX(old, new)，不重复插入
 *   - 不同 S-P-O → 正常插入
 */
export async function saveFacts(
  facts: { subject: string; predicate: string; object: string; confidence: number; evidence?: string; validFrom?: string; validTo?: string }[],
  sourceMemoryId: string | null = null,
  characterId: string = CHAR_ID,
  project?: string,  // v1.5: 项目隔离
): Promise<{ inserted: number; updated: number }> {
  if (!facts || facts.length === 0) return { inserted: 0, updated: 0 };

  const db = DatabaseManager.getInstance(project);
  const now = new Date().toISOString();
  const proj = normalizeProject(project);
  let inserted = 0;
  let updated = 0;

  // v1.24: 角色隔离 — 事实按 (SPO + project + character_id) 去重。
  // 不再用 ON CONFLICT(旧唯一索引只有 4 列,同库多角色会被互相覆盖/顶掉),
  // 改成显式 SELECT→UPDATE/INSERT,唯一性由 idx_facts_spo_char(含 character_id) 保证。
  const selectFact = db.prepare(
    'SELECT id, confidence, valid_to FROM facts WHERE subject=? AND predicate=? AND object=? AND project=? AND COALESCE(character_id, \'\') = ?'
  );
  const updateFact = db.prepare(`
    UPDATE facts SET confidence = MAX(confidence, ?), updated_at = ?, is_active = 1,
      evidence = COALESCE(NULLIF(?, ''), evidence),
      valid_from = COALESCE(?, valid_from), valid_to = ?
    WHERE id = ?
  `);
  const insertFact = db.prepare(`
    INSERT INTO facts (id, subject, predicate, object, project, confidence, source_memory_id, character_id, is_active, created_at, updated_at, evidence, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `);

  for (const f of facts) {
    const existing = selectFact.get(f.subject, f.predicate, f.object, proj, characterId ?? '') as any;
    const factId = existing ? existing.id : generateId();
    if (existing) {
      // v1.28: 复写一条"已被失效"的事实 = 重新断言它。它的有效起点要回到现在，否则按
      // valid_from 排序的时间线上它仍排在接管它的那个值之前，会被立刻重新闭合 —— v1.23 的
      // "复写清空 valid_to" 就失效了（regression_v123_anima 7b）。显式给了 validFrom 时以调用方为准。
      const wasInvalidated = !!(existing.valid_to && String(existing.valid_to).length > 0) && !f.validFrom;
      updateFact.run(f.confidence, now, f.evidence ?? '', f.validFrom ?? null, f.validTo ?? null, factId);
      updated++;
      if (wasInvalidated) {
        try { db.prepare('UPDATE facts SET valid_from = ? WHERE id = ?').run(now, factId); } catch { /* 列未迁移 */ }
      }
      // v1.27: 老行的 valid_from 为空时补成 now —— 否则"按时刻查有效事实"会把
      // 2026 年才写入的事实也算进 2000 年(未知起点被当成永恒为真)。
      try { db.prepare('UPDATE facts SET valid_from = ? WHERE id = ? AND (valid_from IS NULL OR valid_from = \'\')').run(now, factId); } catch { /* 列未迁移 */ }
    } else {
      insertFact.run(
        factId, f.subject, f.predicate, f.object, proj, f.confidence, sourceMemoryId, characterId, now, now,
        f.evidence ?? null, f.validFrom ?? now, f.validTo ?? null,
      );
      inserted++;
    }
    // v1.27 实体层:事实一落库就登记实体 + 建立 fact/memory ↔ entity 关联,
    // 这样"某实体的当前有效事实/相关记忆"是一次 JOIN,而不是 LIKE 扫正文。
    try {
      const linked = linkFactEntities(db, factId, f.subject, f.object);
      if (sourceMemoryId) linkMemoryToEntities(db, sourceMemoryId, [linked.subjectEntityId, linked.objectEntityId]);
    } catch { /* 实体表未迁移时静默跳过 */ }
  }

  // v1.28 冲突失效：语义先验（多值关系永不失效 / 计划类只并存 / 单值种子表）+ 证据补充（详见 volatility.ts）。
  // 裁决为"失效"时重算整条时间线：每个值只在对它成立的那段时间里有效 ——
  //   valid_to      = 链上下一个值的 valid_from（不是 now —— 记的是"何时起不再成立"）
  //   expired_at    = 判定时刻（事务时间，与 valid_to 分开才能"按当时已知重放"）
  //   superseded_by = 接管它的那一行 id
  // 重构而不是"把当前值之前的所有行都打成 now"：这样"第 2 次因为证据不足没失效、第 3 次才判失效"
  // 的链也能被修正成正确的区间。同一时刻的两个值（同一批写入）无法排序，按 Graphiti 的
  // "区间不相交就不算推翻"保持并存。
  try {
    // v1.23-fix「同批不互相失效」改成显式判据：只有"同一批写入 + 时间戳相同"的两个值才无法排序、
    // 保持并存；不同批（哪怕时间戳撞在同一毫秒）按写入顺序先后接管。
    const batchObjects = new Map<string, Set<string>>();
    for (const f of facts) {
      const key = `${f.subject}\u0000${String(f.predicate).trim()}`;
      const set = batchObjects.get(key) || new Set<string>();
      set.add(String(f.object));
      batchObjects.set(key, set);
    }
    const loadChain = db.prepare(`
      SELECT id, object, COALESCE(valid_from, created_at) AS at FROM facts
      WHERE project = ? AND COALESCE(character_id, '') = ? AND subject = ? AND predicate = ? AND is_active = 1
      ORDER BY julianday(COALESCE(valid_from, created_at)), rowid
    `);
    // 只管理"开口"的窗口（valid_to 为空）：调用方显式给的 validTo 是事实，不被重算覆盖
    // （regression_v123_anima「explicit validTo is respected」）。
    const setWindow = db.prepare('UPDATE facts SET valid_to = ?, superseded_by = ?, expired_at = ?, updated_at = ? WHERE id = ? AND (valid_to IS NULL OR valid_to = \'\')');

    for (const f of facts) {
      const predicate = String(f.predicate).trim();
      const key = `${f.subject}\u0000${predicate}`;
      const inThisBatch = batchObjects.get(key) || new Set<string>();
      // 表外谓词才查历史证据（表内谓词由语义先验直接决定，省一次查询）。
      const evidence = needsEvidence(predicate)
        ? estimatePredicateVolatility(db, proj, f.subject, predicate, characterId)
        : undefined;
      if (!shouldSupersede({ predicate, evidence }).supersede) continue;

      const chain = loadChain.all(proj, characterId ?? '', f.subject, predicate) as any[];
      for (let i = 0; i < chain.length - 1; i++) {
        const next = chain[i + 1];
        // 同批 + 同时间戳 = 无法排序的两个值 → 并存（v1.23-fix 的语义）
        const unordered = next.at === chain[i].at
          && inThisBatch.has(String(chain[i].object)) && inThisBatch.has(String(next.object));
        const closes = !unordered;
        setWindow.run(closes ? next.at : null, closes ? next.id : null, closes ? now : null, now, chain[i].id);
      }
      if (chain.length > 0) {
        // 链尾是当前值：保持开口（重算也把之前误闭合的窗口清干净）
        setWindow.run(null, null, null, now, chain[chain.length - 1].id);
      }
    }
  } catch { /* 列未迁移时静默跳过 */ }

  // 为新增 / 更新的事实生成 embedding 并写入 vec_facts
  if (!isEmbedEnabled()) return { inserted, updated };
  try {
    const allFacts = db.prepare(`
      SELECT rowid, subject, predicate, object FROM facts
      WHERE project = ? AND COALESCE(character_id, '') = ? AND subject || ' ' || predicate || ' ' || object IN (
        ${facts.map(() => '?').join(',')}
      )
    `).all(proj, characterId ?? '', ...facts.map(f => `${f.subject} ${f.predicate} ${f.object}`)) as any[];

    for (const row of allFacts) {
      const factText = `${row.subject} ${row.predicate} ${row.object}`;
      try {
        const vec = new Float32Array(await getEmbeddingCached(factText, proj));
        // upsert: delete old + insert new
        db.prepare('DELETE FROM vec_facts WHERE rowid = ?').run(BigInt(row.rowid));
        db.prepare('INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
      } catch {}
    }
  } catch {}

  return { inserted, updated };
}

/**
 * 查询某个主体的所有活跃事实
 */
export function getFactsBySubject(subject: string, characterId?: string, project?: string): FactRecord[] {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  // v1.23.1: 默认只返回当前有效事实；历史版本留在表里（valid_to 有值）供按需追溯
  // v1.24: 角色隔离 — 未指定 characterId 时按当前实例角色过滤(不再跨角色泄露)
  const cid = characterId ?? CHAR_ID;
  let query = "SELECT * FROM facts WHERE subject = ? AND is_active = 1 AND project = ? AND (valid_to IS NULL OR valid_to = '')";
  const params: any[] = [subject, proj];
  if (cid !== 'any') {
    query += ' AND character_id = ?';
    params.push(cid);
  }
  query += ' ORDER BY confidence DESC, updated_at DESC LIMIT 50';
  return db.prepare(query).all(...params) as FactRecord[];
}

// ═══════════════════════════════════════════════════════════════════
// v1.11 Part2: 会话记忆数据层 — 渐进式临时反思
//   getSessionMemory      : 读会话滚动快照(source=session_memory)
//   upsertSessionMemory   : 会话滚动状态滚动覆盖(同 session_id 单行 upsert)
//   promoteToProject      : 长效干货晋升到项目级(session_id=NULL, 4 类强制 Markdown)
//   deleteSessionFragments: 晋升即删(清空该会话已晋升的 session_memory 碎片)
// ═══════════════════════════════════════════════════════════════════

/** 读取某会话当前滚动记忆快照(source=session_memory,最新一条);v1.24: 按角色隔离 */
export function getSessionMemory(project: string, sessionId: string, characterId: string = CHAR_ID): string | null {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const row = db.prepare(`
    SELECT text FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1 AND character_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId, characterId) as any;
  return row?.text ?? null;
}

/**
 * 会话滚动状态覆盖:按 (project, session_id, character_id) 查同会话已有 session_memory
 * → 有则 UPDATE text(覆盖),无则 INSERT(session_id 非空, source=session_memory,
 *   memType=general 或 LLM 给的, category=session)。
 * 单会话单行,实现"滚动覆盖"而非碎片堆积。
 * v1.24: 会话快照同样打 character_id —— 否则同库多角色会互相覆盖/串味。
 */
export function upsertSessionMemory(
  project: string,
  sessionId: string,
  content: string,
  memType?: MemType,
  characterId: string = CHAR_ID,
): { id: string; updated: boolean } {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1 AND character_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId, characterId) as any;
  if (existing) {
    db.prepare('UPDATE memory SET text = ?, updated_at = ? WHERE id = ?').run(content, now, existing.id);
    return { id: existing.id, updated: true };
  }
  const id = generateId();
  db.prepare(`
    INSERT INTO memory (id, text, project, session_id, type, mem_type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
    VALUES (?, ?, ?, ?, 'episodic', ?, 'session', '[]', 0.5, ?, 'session_memory', 'user', 'standard', 1, ?, ?, ?, 0, 0)
  `).run(id, content, proj, sessionId, normalizeMemType(memType), characterId, now, now, now);
  return { id, updated: false };
}

/**
 * 长效干货晋升:每条 INSERT 到项目级(session_id=NULL, memType, 4 类强制 Markdown)。
 * 返回落库 ids。
 * 设计取舍:不用 saveMemory(其精确去重不区分 session_id,可能把晋升项去重到
 * 会话级碎片——而碎片随后会被"晋升即删"删掉,导致晋升引到已删行)。
 * 这里自己做"仅项目级"精确去重(session_id IS NULL),命中返回已有 id,否则直接 INSERT。
 * 同步执行 + 不嵌向量:后台反思不依赖嵌入服务。
 */
export function promoteToProject(
  project: string,
  items: { memType: MemType; text: string; category?: string; subject?: 'user' | 'self' | 'environment' }[],
  characterId?: string,
): string[] {
  const cid = characterId || CHAR_ID;
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const item of items || []) {
    const mt = isClosedMemType(item.memType) ? item.memType : undefined;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!mt || !text) continue;
    // memdir 路由:反思晋升产物按 memType 落对应分类库
    const db = DatabaseManager.getInstance(proj, mt);
    const md = normalizeMarkdown(text, mt);
    const dup = db.prepare(`
      SELECT id FROM memory
      WHERE is_active = 1 AND project = ? AND session_id IS NULL AND TRIM(text) = TRIM(?) AND subject = ? AND character_id IS ?
      LIMIT 1
    `).get(proj, md, item.subject || 'user', cid) as any;
    if (dup) { ids.push(dup.id); continue; }
    const id = generateId();
    db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, ?, NULL, 'semantic', ?, ?, '[]', 0.6, ?, 'session_promoted', ?, 'standard', 1, ?, ?, ?, 0, 0)
    `).run(id, md, proj, mt, (item.category && String(item.category).trim().slice(0, 40)) || 'knowledge', cid, item.subject || 'user', now, now, now);
    ids.push(id);
  }
  return ids;
}
/**
 * 晋升即删(吸收 Claude cleaner.onPromoted):晋升成功后清空该会话
 * source=session_memory 的已晋升碎片。硬删(内部家计行;v1.28 起若已补过向量一并清)。
 */
export function deleteSessionFragments(project: string, sessionId: string, characterId: string = CHAR_ID): number {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  // v1.28-fix: 与启动 sweep 保持一致 —— 硬删前先清 vec_memory。
  // 只删 memory 会把向量变成孤儿:rowid 复用时撞 vec0 主键,且孤儿向量会被 KNN 命中。
  try {
    const tx = db.transaction(() => {
      const rows = db.prepare(`
        SELECT rowid FROM memory
        WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1 AND character_id = ?
      `).all(proj, sessionId, characterId) as any[];
      if (rows.length === 0) return 0;
      const delVec = db.prepare('DELETE FROM vec_memory WHERE rowid = ?');
      for (const row of rows) {
        try { delVec.run(row.rowid); } catch { /* 无 vec 表/未加载扩展 */ }
      }
      return db.prepare(`
        DELETE FROM memory
        WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1 AND character_id = ?
      `).run(proj, sessionId, characterId).changes;
    });
    return tx();
  } catch {
    return 0;
  }
}
