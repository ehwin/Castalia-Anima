/**
 * 给 reflect(洞察)库补向量 —— 让"语义去重"和"漂移检测"能真正跑起来。
 *
 * 背景:reflect 库原来没有 vec_memory(洞察写入路径不嵌入),所以只能做 3-gram 字面去重。
 * 这里按库补 `vec_memory`,主键是 memory 的 rowid(sqlite-vec 的 vec0 要求)。
 *
 * 幂等:已有向量的行跳过;--force 重算。
 * 用法:
 *   MEMORY_BANK_ROOT=D:/castalia/memory-banks node scripts/backfill_reflect_vectors.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = process.env.MEMORY_BANK_ROOT || 'D:/castalia/memory-banks';
const FORCE = process.argv.includes('--force');
const BANK = process.argv.includes('--bank') ? process.argv[process.argv.indexOf('--bank') + 1] : '';

// configLoader 是 import 副作用注入(读 bank 根的 keys.enc / config.json)
process.env.MEMORY_DB_DIR = process.env.MEMORY_DB_DIR || path.join(ROOT, BANK || 'full');
await import(pathToFileURL(path.join(HERE, '..', 'dist', 'configLoader.js')).href);
const dbMod = await import(pathToFileURL(path.join(HERE, '..', 'dist', 'db.js')).href);
const sqliteVec = await import('sqlite-vec');
const Database = (await import('better-sqlite3')).default;
const { embed } = await import(pathToFileURL(path.join(HERE, '..', 'dist', 'ollama.js')).href);

const banks = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
let embedded = 0, skipped = 0, failed = 0;
for (const bank of banks) {
  if (BANK && bank !== BANK) continue;
  const dir = path.join(ROOT, bank, 'reflect');
  if (!fs.existsSync(dir)) continue;
  for (const mt of fs.readdirSync(dir)) {
    const f = path.join(dir, mt, 'memory.sqlite');
    if (!fs.existsSync(f)) continue;
    const db = new Database(f);
    try { sqliteVec.load(db); } catch {}
    try { dbMod.initProjectSchema(db); } catch {}
    const vecDim = dbMod.vecDim ? dbMod.vecDim() : 1024;
    try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${vecDim()}])`); } catch {}

    const rows = db.prepare('SELECT rowid AS rid, id, text FROM memory WHERE is_active = 1').all();
    const have = new Set();
    try { for (const r of db.prepare('SELECT rowid AS rid FROM vec_memory').all()) have.add(Number(r.rid)); } catch {}
    for (const r of rows) {
      if (!FORCE && have.has(Number(r.rid))) { skipped++; continue; }
      try {
        const vec = await embed(String(r.text), 'reflect');
        const buf = Buffer.from(new Float32Array(vec).buffer);
        if (FORCE) { try { db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(r.rid); } catch {} }
        db.prepare('INSERT INTO vec_memory(rowid, embedding) VALUES (?, ?)').run(r.rid, buf);
        embedded++;
      } catch (e) {
        failed++;
        if (failed <= 3) console.log('嵌入失败', bank, mt, String(r.text).slice(0, 30), e.message);
      }
    }
    console.log(`${bank}/${mt}: active ${rows.length}, 新向量 ${embedded}, 跳过 ${skipped}`);
    db.close();
  }
}
console.log(JSON.stringify({ embedded, skipped, failed }));
