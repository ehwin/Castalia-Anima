#!/usr/bin/env node
/**
 * 句级片段索引回填（2026-10-28）
 *
 * 用法: CastaliaNode.exe scripts/build_chunk_index.mjs [bank] [project]
 * 幂等: 只重建"片段与当前正文不一致"的行(chunk_meta 存 sha1),重复跑很快。
 * 为什么需要: 整行向量在长记忆上被稀释 —— 实测 default 库整行余弦 0.40~0.52 而最佳句
 * 0.51~0.69,要点的记忆行因此排到 15~39 名、进不了注入。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BANK = process.argv[2] || 'default';
const PROJ = process.argv[3] || 'default';
const MTS = ['general', 'user', 'project', 'reference', 'feedback'];

process.env.MEMORY_DB_DIR = `D:/AI/castalia/memory-banks/${BANK}`;
process.env.MEMORY_CONFIG = `D:/AI/castalia/memory-banks/${BANK}/config.json`;
delete process.env.EMBED_MODE;

const dist = (f) => pathToFileURL(path.join(ROOT, 'dist', f)).href;
await import(dist('configLoader.js'));
const { DatabaseManager } = await import(dist('db.js'));
const { backfillChunks, chunkText } = await import(dist('chunkIndex.js'));

let rowsDone = 0, rowsSkipped = 0, chunksTotal = 0;
const t0 = Date.now();
for (const mt of MTS) {
  let db;
  try { db = DatabaseManager.getInstance(PROJ, mt); } catch { continue; }
  let rows;
  try {
    rows = db.prepare('SELECT rowid, text FROM memory WHERE is_active = 1').all();
  } catch { continue; }
  if (!rows.length) continue;
  const before = (() => { try { return db.prepare('SELECT COUNT(*) c FROM vec_chunk').get().c; } catch { return 0; } })();
  const r = await backfillChunks(db, rows.map(x => ({ rowid: Number(x.rowid), text: String(x.text || '') })));
  const after = (() => { try { return db.prepare('SELECT COUNT(*) c FROM vec_chunk').get().c; } catch { return 0; } })();
  rowsDone += r.done; rowsSkipped += r.skipped;
  chunksTotal += after;
  const planned = rows.reduce((n, x) => n + chunkText(String(x.text || '')).length, 0);
  console.log(`  ${mt.padEnd(10)} 行 ${String(rows.length).padStart(4)} | 重建 ${String(r.done).padStart(4)} 跳过 ${String(r.skipped).padStart(4)} | 片段 ${before} → ${after}（按正文应为 ${planned}）`);
}
console.log(`\n  合计: 重建 ${rowsDone} 行 / 跳过 ${rowsSkipped} 行 / 片段总数 ${chunksTotal} | 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
