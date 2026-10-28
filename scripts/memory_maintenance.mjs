#!/usr/bin/env node
/**
 * 记忆维护命令行（2026-10-28）
 *
 * 给托盘菜单用：一个入口、一个文件，避免为每个动作单开脚本。
 *
 *   memory_maintenance.mjs probe-embed  [bank] [project]
 *   memory_maintenance.mjs health       [bank] [project]
 *   memory_maintenance.mjs rebuild-chunks [bank] [project]
 *   memory_maintenance.mjs repair       [bank] [project]
 *   memory_maintenance.mjs eval         [bank] [project]
 *
 * 输出是给人看的短行，最后一行固定 `RESULT: ...` —— 托盘只弹这一行，其余进日志。
 * 安全性：repair 只重建**派生索引**（向量/片段/嵌入缓存），正文与关系一行不动。
 */
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const [CMD = 'health', BANK = 'airi', PROJ = 'airi'] = process.argv.slice(2);
const MTS = ['general', 'user', 'project', 'reference', 'feedback'];

// 库根目录可覆盖(自测/沙盘用):CASTALIA_BANK_ROOT=D:/.../bank-sandbox
const BANK_ROOT = process.env.CASTALIA_BANK_ROOT || 'D:/AI/castalia/memory-banks';
process.env.MEMORY_DB_DIR = `${BANK_ROOT}/${BANK}`;
process.env.MEMORY_CONFIG = `${BANK_ROOT}/${BANK}/config.json`;
delete process.env.EMBED_MODE;

const dist = (f) => pathToFileURL(path.join(ROOT, 'dist', f)).href;
await import(dist('configLoader.js'));
const { DatabaseManager } = await import(dist('db.js'));
const { embed, cosineSimilarity } = await import(dist('ollama.js'));
const { batchEmbedPending } = await import(dist('store.js'));
const { backfillChunks, chunkKnnSearch } = await import(dist('chunkIndex.js'));

const say = (s) => console.log(s);
const done = (s) => { console.log(`RESULT: ${s}`); process.exit(0); };
const fail = (s) => { console.log(`RESULT: 失败 — ${s}`); process.exit(1); };

function openDb(mt) {
  try { return DatabaseManager.getInstance(PROJ, mt); } catch { return null; }
}
const count = (db, sql, ...p) => { try { return Number(db.prepare(sql).get(...p)?.c) || 0; } catch { return -1; } };

if (CMD === 'probe-embed') {
  const t0 = Date.now();
  try {
    const v = await embed('嵌入自检：七丘四方殿');
    const ms = Date.now() - t0;
    say(`模型 ${process.env.EMBEDDING_MODEL || '(未设)'}`);
    say(`端点 ${process.env.OLLAMA_URL || '(未设)'}`);
    say(`维度 ${v.length}  延迟 ${ms}ms`);
    done(`云端嵌入可用 · ${v.length} 维 · ${ms}ms`);
  } catch (e) {
    fail(String(e.message || e).slice(0, 120));
  }
}

if (CMD === 'health') {
  let rows = 0, vecs = 0, chunks = 0, metas = 0;
  const stale = [];
  for (const mt of MTS) {
    const db = openDb(mt); if (!db) continue;
    const r = count(db, 'SELECT COUNT(*) c FROM memory WHERE is_active = 1');
    if (r <= 0) continue;
    rows += r;
    vecs += Math.max(0, count(db, 'SELECT COUNT(*) c FROM vec_memory'));
    chunks += Math.max(0, count(db, 'SELECT COUNT(*) c FROM vec_chunk'));
    metas += Math.max(0, count(db, 'SELECT COUNT(*) c FROM chunk_meta'));
    // 坏向量抽样:最老的 6 行,取原文重嵌与库存向量比余弦(同一空间 ≈1.0)
    const sample = db.prepare(`
      SELECT m.rowid rid, m.text t FROM memory m JOIN vec_memory v ON v.rowid = m.rowid
      WHERE m.is_active = 1 ORDER BY m.rowid LIMIT 6`).all();
    let bad = 0;
    for (const s of sample) {
      try {
        const stored = JSON.parse(db.prepare('SELECT vec_to_json(embedding) j FROM vec_memory WHERE rowid = ?').get(s.rid).j);
        const c = cosineSimilarity(await embed(String(s.t)), stored.flat ? stored.flat() : stored);
        if (c < 0.9) bad++;
      } catch { bad++; }
    }
    if (sample.length) stale.push(`${mt}:${bad}/${sample.length}`);
  }
  say(`记忆 ${rows} 行 | 整行向量 ${vecs} | 片段 ${chunks}（元数据 ${metas}）`);
  say(`坏向量抽样 ${stale.join(' ') || '无'}`);
  say(`嵌入空间 ${process.env.EMBEDDING_MODEL || '(未设)'}/${process.env.EMBEDDING_DIM || '默认'}`);
  const badTotal = stale.reduce((n, s) => n + Number(String(s).split(':')[1].split('/')[0]), 0);
  if (badTotal > 0) done(`发现 ${badTotal} 条坏向量（抽样）— 建议执行「修复向量索引」`);
  const missingChunks = chunks === 0;
  if (missingChunks) done(`片段索引为空 — 建议执行「重建片段索引」`);
  done(`状态正常 · ${rows} 行 · 向量 ${vecs} · 片段 ${chunks}`);
}

if (CMD === 'rebuild-chunks') {
  const t0 = Date.now();
  let doneRows = 0, skipped = 0, total = 0;
  for (const mt of MTS) {
    const db = openDb(mt); if (!db) continue;
    let rows = [];
    try { rows = db.prepare('SELECT rowid, text FROM memory WHERE is_active = 1').all(); } catch { continue; }
    if (!rows.length) continue;
    const r = await backfillChunks(db, rows.map(x => ({ rowid: Number(x.rowid), text: String(x.text || '') })));
    doneRows += r.done; skipped += r.skipped;
    total += Math.max(0, count(db, 'SELECT COUNT(*) c FROM vec_chunk'));
    say(`${mt.padEnd(10)} 行 ${rows.length} 重建 ${r.done} 跳过 ${r.skipped}`);
  }
  done(`片段索引 ${total} 段 · 重建 ${doneRows} 行 / 跳过 ${skipped} 行 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (CMD === 'repair') {
  const t0 = Date.now();
  const backups = [];
  for (const mt of MTS) {
    const db = openDb(mt); if (!db) continue;
    const v = count(db, 'SELECT COUNT(*) c FROM vec_memory');
    const c = count(db, 'SELECT COUNT(*) c FROM vec_chunk');
    if (v <= 0 && c <= 0) continue;
    // 备份只记"清空前有多少索引"（manifest），不复制 80MB 的库文件 —— 向量/片段是派生数据，
    // 随时可重建，复制整库只会让每次点菜单都写几十 MB。
    try {
      const fs = await import('node:fs');
      const b = path.join(process.env.MEMORY_DB_DIR, '_index-backup');
      fs.mkdirSync(b, { recursive: true });
      const manifest = path.join(b, 'manifest.jsonl');
      fs.appendFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), memType: mt, vectors: v, chunks: c }) + '\n');
      backups.push(mt);
    } catch { /* 记账失败不阻断重建 */ }
    try { db.exec('DELETE FROM vec_memory'); } catch {}
    try { db.exec('DELETE FROM vec_chunk'); } catch {}
    try { db.exec('DELETE FROM chunk_meta'); } catch {}
    try { db.exec('DELETE FROM embedding_cache'); } catch {}
    say(`${mt.padEnd(10)} 清空向量 ${v} / 片段 ${c}`);
  }
  const r = await batchEmbedPending('any', PROJ);
  say(`整行重嵌 ${r.embedded} 条${r.errors.length ? `，错误 ${r.errors.length}` : ''}`);
  for (const mt of MTS) {
    const db = openDb(mt); if (!db) continue;
    let rows = [];
    try { rows = db.prepare('SELECT rowid, text FROM memory WHERE is_active = 1').all(); } catch { continue; }
    if (!rows.length) continue;
    await backfillChunks(db, rows.map(x => ({ rowid: Number(x.rowid), text: String(x.text || '') })));
  }
  const totalChunks = MTS.reduce((n, mt) => { const db = openDb(mt); return n + (db ? Math.max(0, count(db, 'SELECT COUNT(*) c FROM vec_chunk')) : 0); }, 0);
  done(`向量索引已重建 · 重嵌 ${r.embedded} 条 · 片段 ${totalChunks} 段 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (CMD === 'eval') {
  const script = path.join(HERE, 'eval_injection.mjs');
  const r = spawnSync(process.execPath, [script, BANK, PROJ, PROJ], { encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pick = (k) => (out.match(new RegExp(`${k}\\s+([^\\n]+)`)) || [])[1]?.trim() || '—';
  say(out.split('\n').filter(l => l.trim()).slice(-8).join('\n'));
  done(`要点命中 ${pick('要点命中')} · 噪音 ${pick('噪音注入')} · 平均 ${pick('平均注入')}`);
}
