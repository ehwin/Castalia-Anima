/**
 * AIRI Memory Store — 原文秒存，去重软抑制
 *
 * v5.0: skipEmbed 参数 — digest 暂不向量化，reflect 后统一 embed
 * v4.0: 去重不再丢弃，SQLite 持久化 embedding 缓存
 */
import { DatabaseManager, generateId } from './db.js';
import { embed, getEmbeddingCached } from './ollama.js';
import { recordTopics } from './bias.js';
let saveCount = 0;
const CONSOLIDATE_INTERVAL = 50;
export async function saveMemory(params) {
    const db = DatabaseManager.getInstance();
    const now = new Date().toISOString();
    const skipEmbed = params.skipEmbed === true;
    // ═══ 精确去重：完全相同的文本不重复存 ═══
    const exactDup = db.prepare(`
    SELECT id FROM memory
    WHERE is_active = 1 AND LOWER(TRIM(text)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(params.text?.trim() || '');
    if (exactDup) {
        db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(exactDup.id);
        return {
            id: exactDup.id, text: params.text,
            type: params.type ?? 'episodic', category: params.category ?? 'general',
            subcategory: params.subcategory ?? null, tags: params.tags ?? [],
            emotionalImpact: params.emotionalImpact ?? 0, importance: params.importance ?? 0.5,
            characterId: params.characterId ?? null, source: params.source ?? null,
            subject: params.subject ?? 'user', agentMood: params.agentMood ?? null,
            agentDesire: params.agentDesire ?? null,
            tier: params.tier ?? 'standard', expiresAt: null,
            isActive: true,
            createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
        };
    }
    // ═══ 向量去重：仅当不跳过 embed 时执行 ═══
    let vector = null;
    let isNearDup = false;
    let dupId = null;
    if (!skipEmbed) {
        try {
            vector = await getEmbeddingCached(params.text);
            const floatVec = new Float32Array(vector);
            const knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ?
        ORDER BY distance LIMIT 1
      `).all(floatVec);
            if (knn.length > 0 && knn[0].distance < 0.05) {
                const dupRow = db.prepare('SELECT id FROM memory WHERE rowid = ?').get(Number(knn[0].rowid));
                if (dupRow) {
                    dupId = dupRow.id;
                    isNearDup = true;
                    db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(dupId);
                }
            }
        }
        catch {
            // KNN 不可用，跳过去重检查
        }
    }
    // ═══ 存入新记忆（不管是否近重复，都存） ═══
    const id = generateId();
    // tier + expires_at 计算
    const tier = params.tier || 'standard';
    const expiresAt = params.expiresAt || (tier === 'temporary'
        ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() // 3天TTL
        : null // standard/critical 永不过期
    );
    const record = {
        id, text: params.text,
        type: params.type ?? 'episodic',
        category: params.category ?? 'general',
        subcategory: params.subcategory ?? null,
        tags: params.tags ?? [],
        emotionalImpact: params.emotionalImpact ?? 0,
        importance: params.importance ?? 0.5,
        characterId: params.characterId ?? null,
        source: params.source ?? null,
        subject: params.subject ?? 'user',
        agentMood: params.agentMood ?? null,
        agentDesire: params.agentDesire ?? null,
        tier,
        expiresAt,
        isActive: true,
        createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
    };
    const storeTx = db.transaction(() => {
        db.prepare(`
      INSERT INTO memory (id, text, type, category, subcategory, tags, emotional_impact, importance, character_id, source, subject, agent_mood, agent_desire, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.text, record.type, record.category, record.subcategory, JSON.stringify(record.tags), record.emotionalImpact, record.importance, record.characterId, record.source, record.subject, record.agentMood, record.agentDesire, record.tier, record.expiresAt, 1, record.createdAt, record.updatedAt, record.lastAccessedAt, 0, 0);
        // v5.0: 仅在非 skipEmbed 时写入向量
        if (!skipEmbed && vector) {
            const info = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(record.id);
            const rowid = BigInt(info.rowid);
            db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(rowid, new Float32Array(vector));
        }
    });
    storeTx();
    // 记录 tags 到 bias
    if (record.tags.length > 0 && record.characterId) {
        recordTopics(record.characterId, record.tags);
    }
    // 定期整理
    saveCount++;
    if (saveCount >= CONSOLIDATE_INTERVAL) {
        saveCount = 0;
        try {
            const { consolidate } = await import('./consolidate.js');
            consolidate().catch(() => { });
        }
        catch { }
    }
    return record;
}
export function forgetMemory(id) {
    const db = DatabaseManager.getInstance();
    return db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id).changes > 0;
}
export function restoreMemory(id) {
    const db = DatabaseManager.getInstance();
    return db.prepare('UPDATE memory SET is_active = 1 WHERE id = ?').run(id).changes > 0;
}
export async function updateMemory(id, updates) {
    const db = DatabaseManager.getInstance();
    const existing = db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
    if (!existing)
        return null;
    const fields = [];
    const values = [];
    if (updates.text !== undefined) {
        fields.push('text = ?');
        values.push(updates.text);
    }
    if (updates.type !== undefined) {
        fields.push('type = ?');
        values.push(updates.type);
    }
    if (updates.category !== undefined) {
        fields.push('category = ?');
        values.push(updates.category);
    }
    if (updates.subcategory !== undefined) {
        fields.push('subcategory = ?');
        values.push(updates.subcategory);
    }
    if (updates.tags !== undefined) {
        fields.push('tags = ?');
        values.push(JSON.stringify(updates.tags));
    }
    if (updates.emotionalImpact !== undefined) {
        fields.push('emotional_impact = ?');
        values.push(updates.emotionalImpact);
    }
    if (updates.importance !== undefined) {
        fields.push('importance = ?');
        values.push(updates.importance);
    }
    if (fields.length === 0)
        return existing;
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    db.prepare(`UPDATE memory SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (updates.text !== undefined) {
        const newVec = await getEmbeddingCached(updates.text);
        db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id);
        const rowInfo = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id);
        db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(rowInfo.rowid), new Float32Array(newVec));
    }
    return db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
}
/**
 * 存储对话原文（轻量，不做分析，不做向量化）
 * v5.0: 对话原文永不 embed — digest 分拣后再由 reflect 统一向量化
 */
export async function saveConversationTurn(userMsg, assistantMsg, characterId = 'airi', moodValue, moodReason) {
    const db = DatabaseManager.getInstance();
    const now = new Date().toISOString();
    const id = generateId();
    let moodPrefix = '';
    if (moodValue !== undefined) {
        moodPrefix = `[mood: ${moodValue}`;
        if (moodReason)
            moodPrefix += `, "${moodReason}"`;
        moodPrefix += ']\n';
    }
    const text = `${moodPrefix}用户: ${userMsg}\n助手: ${assistantMsg}`;
    db.prepare(`
    INSERT INTO memory (id, text, type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
    VALUES (?, ?, 'episodic', 'conversation', '[]', 0.5, ?, 'conversation_log', 'user', 'standard', 1, ?, ?, ?, 0, 0)
  `).run(id, text, characterId, now, now, now);
    return { id, ok: true };
}
/**
 * 清理过期的临时记忆 (tier='temporary', expires_at < now)
 * 返回清理数量
 */
// ═══ v1.3: 热度升格 — 常被访问的记忆自动变强(UPSP 热度思想) ═══
const HEAT_PROMOTE_THRESHOLD = parseInt(process.env.HEAT_PROMOTE_THRESHOLD || '5', 10);
export function promoteByAccess() {
    const db = DatabaseManager.getInstance();
    const now = new Date().toISOString();
    const r = db.prepare(`
    UPDATE memory SET tier = 'standard', updated_at = ?
    WHERE tier = 'temporary' AND accessed_count >= ? AND is_active = 1
  `).run(now, HEAT_PROMOTE_THRESHOLD);
    if (r.changes > 0)
        console.error(`[memory] heat promote: ${r.changes} temporary → standard`);
    return r.changes;
}
export function cleanupExpiredMemories() {
    const db = DatabaseManager.getInstance();
    const now = new Date().toISOString();
    // 先升格再清理:被反复访问的 temporary 不该被清
    promoteByAccess();
    const result = db.prepare(`
    UPDATE memory SET is_active = 0, updated_at = ?
    WHERE tier = 'temporary' AND expires_at IS NOT NULL AND expires_at < ? AND is_active = 1
  `).run(now, now);
    return result.changes;
}
/**
 * v5.0: 重新向量化单条记忆 — reflect 后调用
 * 删旧向量 + embed 新文本 + 插入新向量
 */
export async function reEmbedMemory(id) {
    const db = DatabaseManager.getInstance();
    const mem = db.prepare('SELECT rowid, text FROM memory WHERE id = ? AND is_active = 1').get(id);
    if (!mem)
        return false;
    try {
        const vec = new Float32Array(await embed(mem.text));
        db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(mem.rowid));
        db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(mem.rowid), vec);
        return true;
    }
    catch (e) {
        console.error(`[store] reEmbedMemory failed for ${id}: ${e.message}`);
        return false;
    }
}
/**
 * v5.0: 批量向量化 — reflect 后一次性处理所有未嵌入记忆
 * 扫描 is_active=1 但 vec_memory 中无对应向量的记录
 */
export async function batchEmbedPending(characterId = 'airi') {
    const db = DatabaseManager.getInstance();
    const errors = [];
    // 找所有有记忆但无向量的记录
    const pending = db.prepare(`
    SELECT m.id, m.text, m.rowid FROM memory m
    WHERE m.is_active = 1
      AND m.character_id = ?
      AND m.source != 'conversation_log'
      AND m.rowid NOT IN (SELECT rowid FROM vec_memory)
    ORDER BY m.created_at ASC
    LIMIT 200
  `).all(characterId);
    let embedded = 0;
    for (const row of pending) {
        try {
            const vec = new Float32Array(await embed(row.text));
            db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
            embedded++;
        }
        catch (e) {
            errors.push(`${row.id}: ${e.message}`);
        }
    }
    return { embedded, errors };
}
/**
 * 批量存储事实 — 自动处理去重（subject+predicate+object 唯一）
 *
 * 去重策略：
 *   - 同一 S-P-O → 更新 confidence 为 MAX(old, new)，不重复插入
 *   - 不同 S-P-O → 正常插入
 */
export async function saveFacts(facts, sourceMemoryId = null, characterId = 'airi') {
    if (!facts || facts.length === 0)
        return { inserted: 0, updated: 0 };
    const db = DatabaseManager.getInstance();
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    const upsert = db.prepare(`
    INSERT INTO facts (id, subject, predicate, object, confidence, source_memory_id, character_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(subject, predicate, object) DO UPDATE SET
      confidence = MAX(confidence, excluded.confidence),
      updated_at = excluded.updated_at,
      is_active = 1,
      accessed_count = facts.accessed_count
  `);
    for (const f of facts) {
        const id = generateId();
        const before = db.prepare('SELECT id, confidence FROM facts WHERE subject=? AND predicate=? AND object=?').get(f.subject, f.predicate, f.object);
        upsert.run(id, f.subject, f.predicate, f.object, f.confidence, sourceMemoryId, characterId, now, now);
        if (before) {
            updated++;
        }
        else {
            inserted++;
        }
    }
    // 为新增 / 更新的事实生成 embedding 并写入 vec_facts
    try {
        const allFacts = db.prepare(`
      SELECT rowid, subject, predicate, object FROM facts
      WHERE subject || ' ' || predicate || ' ' || object IN (
        ${facts.map(() => '?').join(',')}
      )
    `).all(...facts.map(f => `${f.subject} ${f.predicate} ${f.object}`));
        for (const row of allFacts) {
            const factText = `${row.subject} ${row.predicate} ${row.object}`;
            try {
                const vec = new Float32Array(await getEmbeddingCached(factText));
                // upsert: delete old + insert new
                db.prepare('DELETE FROM vec_facts WHERE rowid = ?').run(BigInt(row.rowid));
                db.prepare('INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
            }
            catch { }
        }
    }
    catch { }
    return { inserted, updated };
}
/**
 * 查询某个主体的所有活跃事实
 */
export function getFactsBySubject(subject, characterId) {
    const db = DatabaseManager.getInstance();
    let query = 'SELECT * FROM facts WHERE subject = ? AND is_active = 1';
    const params = [subject];
    if (characterId) {
        query += ' AND character_id = ?';
        params.push(characterId);
    }
    query += ' ORDER BY confidence DESC, updated_at DESC LIMIT 50';
    return db.prepare(query).all(...params);
}
