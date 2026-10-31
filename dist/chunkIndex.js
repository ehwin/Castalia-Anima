/**
 * 句级分块索引（2026-10-28）
 *
 * 为什么需要：整行向量在长记忆上被严重稀释。实测 default 库（BAAI/bge-m3，1024 维）：
 *   记忆行「官方档案里，我的生日一栏写的是「未知」…」（约 100 字）
 *   问句「你的生日是哪天」→ 整行余弦 0.599，而同一条里最贴的那句是 0.675；
 *   长行更糟：**整行 0.405~0.52，最佳句 0.51~0.69**（14 条真值行全部如此）。
 * 后果是"要点的行排在 15~39 名甚至池外"，注入里永远见不到它。
 *
 * 做法：把记忆切成 20~60 字的片段单独嵌入，检索时取**该行所有片段的最大余弦**作为
 * 这条记忆的向量相似度（行级向量仍然保留，两者取大）。行不需要改动，注入仍然整行给。
 *
 * 一致性：chunk_meta 存每段的原文与 sha1，检索时只信 hash 与当前正文一致的段；
 * 正文被改写后旧段自动失效（下次回填重建），不会把过期片段当成命中。
 */
import crypto from 'node:crypto';
import { embed } from './ollama.js';
import { vecDim } from './db.js';
import { isEmbedEnabled } from './env.js';
const CHUNK_MAX = 60; // 单段上限(字)
const CHUNK_MIN = 10; // 单段下限,过短的片段信息量太低
const MAX_CHUNKS = 24; // 单行最大段数,防长文档爆炸
export function chunkText(text) {
    const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length <= CHUNK_MAX)
        return raw.length >= CHUNK_MIN ? [raw] : [];
    // 先按句末标点切，再按逗号切超长句
    const pieces = [];
    for (const sent of raw.split(/(?<=[。；;！？!?])/)) {
        const s = sent.trim();
        if (!s)
            continue;
        if (s.length <= CHUNK_MAX) {
            pieces.push(s);
            continue;
        }
        for (const clause of s.split(/(?<=[，,])/)) {
            const c = clause.trim();
            if (!c)
                continue;
            if (c.length <= CHUNK_MAX) {
                pieces.push(c);
                continue;
            }
            for (let i = 0; i < c.length; i += CHUNK_MAX)
                pieces.push(c.slice(i, i + CHUNK_MAX));
        }
    }
    // 合并过短片段到前一段（避免「回来了。」这种独立段）
    const merged = [];
    for (const p of pieces) {
        if (merged.length && (p.length < CHUNK_MIN || merged[merged.length - 1].length < CHUNK_MIN)) {
            const joined = merged[merged.length - 1] + p;
            if (joined.length <= CHUNK_MAX + CHUNK_MIN) {
                merged[merged.length - 1] = joined;
                continue;
            }
        }
        merged.push(p);
    }
    return merged.filter(p => p.length >= CHUNK_MIN).slice(0, MAX_CHUNKS);
}
export function chunkKey(memRowid, idx) {
    return memRowid * 1000 + idx;
}
export function memRowidOfChunk(key) {
    return Math.floor(key / 1000);
}
function sha1(s) {
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}
export function ensureChunkTables(db) {
    try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunk USING vec0(embedding float[${vecDim()}])`);
    }
    catch (_e) { /* 嵌入关闭时建表失败无所谓 */ }
    db.exec(`CREATE TABLE IF NOT EXISTS chunk_meta (
    mem_rowid INTEGER NOT NULL,
    chunk_idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (mem_rowid, chunk_idx)
  )`);
}
/** 该行现有片段是否与当前正文一致（不一致则视为需要重建） */
function chunksFresh(db, memRowid, parts) {
    const rows = db.prepare('SELECT chunk_idx, text_hash FROM chunk_meta WHERE mem_rowid = ? ORDER BY chunk_idx').all(memRowid);
    if (rows.length !== parts.length)
        return false;
    return rows.every((r, i) => r.chunk_idx === i && r.text_hash === sha1(parts[i]));
}
export function purgeRowChunks(db, memRowid) {
    const rows = db.prepare('SELECT chunk_idx FROM chunk_meta WHERE mem_rowid = ?').all(memRowid);
    const del = db.prepare('DELETE FROM vec_chunk WHERE rowid = ?');
    for (const r of rows) {
        try {
            del.run(BigInt(chunkKey(memRowid, r.chunk_idx)));
        }
        catch (_e) { }
    }
    db.prepare('DELETE FROM chunk_meta WHERE mem_rowid = ?').run(memRowid);
}
/**
 * 给一行记忆建立/修复片段向量。force=false 时若片段已是最新则直接跳过（便宜）。
 * 返回实际新嵌入的片段数。
 */
export async function ensureChunksForRow(db, memRowid, text, opts = {}) {
    if (!isEmbedEnabled())
        return 0;
    const parts = chunkText(text);
    if (parts.length === 0)
        return 0;
    if (!opts.force && chunksFresh(db, memRowid, parts))
        return 0;
    ensureChunkTables(db);
    purgeRowChunks(db, memRowid);
    const insVec = db.prepare('INSERT OR REPLACE INTO vec_chunk (rowid, embedding) VALUES (?, ?)');
    const insMeta = db.prepare('INSERT OR REPLACE INTO chunk_meta (mem_rowid, chunk_idx, text, text_hash, updated_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
        try {
            const v = new Float32Array(await embed(parts[i]));
            insVec.run(BigInt(chunkKey(memRowid, i)), v);
            insMeta.run(memRowid, i, parts[i], sha1(parts[i]), now);
            n++;
        }
        catch (_e) { /* 单段失败不影响其他段 */ }
    }
    return n;
}
/** 行级缺段/过期时补建（批量回填用；只看 chunk_meta 与正文是否一致） */
export async function backfillChunks(db, rows) {
    let done = 0, skipped = 0;
    for (const r of rows) {
        const parts = chunkText(r.text);
        if (!parts.length) {
            skipped++;
            continue;
        }
        if (chunksFresh(db, r.rowid, parts)) {
            skipped++;
            continue;
        }
        const n = await ensureChunksForRow(db, r.rowid, r.text, { force: true });
        if (n > 0)
            done++;
        else
            skipped++;
    }
    return { done, skipped };
}
/**
 * 片段级 KNN → 每行取最大余弦。返回值 key 是 memory.rowid。
 * 只信 hash 与当前正文一致的片段（正文被改过就丢弃旧片段）。
 */
export function chunkKnnSearch(db, queryVector, limit) {
    const out = new Map();
    let knnRows = [];
    try {
        knnRows = db.prepare('SELECT rowid, distance FROM vec_chunk WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
            .all(queryVector, Math.max(8, limit * 4));
    }
    catch (_e) {
        return out;
    }
    if (knnRows.length === 0)
        return out;
    const meta = db.prepare('SELECT text_hash FROM chunk_meta WHERE mem_rowid = ? AND chunk_idx = ?');
    const cur = db.prepare("SELECT text FROM memory WHERE rowid = ? AND is_active = 1 AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')");
    const freshCache = new Map();
    for (const r of knnRows) {
        const key = Number(r.rowid);
        const memRowid = memRowidOfChunk(key);
        const idx = key % 1000;
        const m = meta.get(memRowid, idx);
        if (!m)
            continue;
        // 过期校验:用**同一套切分**重算当前正文的片段,比对 hash。
        // 不能用"片段原文是否为正文子串" —— chunkText 会把空白规范化(换行→空格、去首尾空白),
        // 带换行的行因此永远校验失败,片段索引等于没用(2026-10-28 踩过)。
        let parts = freshCache.get(memRowid);
        if (parts === undefined) {
            const row = cur.get(memRowid);
            parts = row ? chunkText(String(row.text || '')) : null;
            freshCache.set(memRowid, parts);
        }
        if (!parts || !parts[idx])
            continue;
        if (sha1(parts[idx]) !== m.text_hash)
            continue;
        const sim = Math.max(0, Math.min(1, 1 - (Number(r.distance) ** 2) / 2)); // vec0 是 L2:cos = 1 - d²/2
        const prev = out.get(memRowid) ?? 0;
        if (sim > prev)
            out.set(memRowid, sim);
    }
    return out;
}
//# sourceMappingURL=chunkIndex.js.map