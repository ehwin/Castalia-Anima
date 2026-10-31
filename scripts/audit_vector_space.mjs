/**
 * 向量空间审计:找出"存量向量与当前嵌入模型不一致"的行。
 *
 * 为什么需要:嵌入实现换过(例如 Ollama bge-m3 → 云端 bge-m3),维度一样(1024),
 * 但向量空间不同 —— 这些行的 KNN 会命中错误邻居,而且完全无声。
 * 判定:用当前模型重算同一条文本,与存量向量余弦 < 0.9 即判为不一致。
 *
 * 用法:
 *   MEMORY_BANK_ROOT=D:/castalia/memory-banks node scripts/audit_vector_space.mjs --bank default
 *   ... --fix        # 重算并覆盖(只覆盖不一致的行)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = process.env.MEMORY_BANK_ROOT || 'D:/castalia/memory-banks';
const BANK = arg('--bank', '');
const FIX = args.includes('--fix');
const LIMIT = Number(arg('--limit', '0')) || 0;

process.env.MEMORY_DB_DIR = process.env.MEMORY_DB_DIR || path.join(ROOT, BANK || 'default');
await import(pathToFileURL(path.resolve('dist', 'configLoader.js')).href);
const { embed } = await import(pathToFileURL(path.resolve('dist', 'ollama.js')).href);

const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); };

const banks = fs.readdirSync(ROOT).filter(b => fs.statSync(path.join(ROOT, b)).isDirectory() && (!BANK || b === BANK));
const summary = {};
for (const bank of banks) {
  if (bank === 'reflect' && BANK !== 'reflect') continue;
  const bp = path.join(ROOT, bank);
  let checked = 0, bad = 0, fixed = 0, missing = 0;
  const badSamples = [];
  for (const proj of fs.readdirSync(bp)) {
    const pp = path.join(bp, proj);
    if (!fs.statSync(pp).isDirectory()) continue;
    for (const mt of fs.readdirSync(pp)) {
      const f = path.join(pp, mt, 'memory.sqlite');
      if (!fs.existsSync(f)) continue;
      if (LIMIT && checked >= LIMIT) break;
      const db = new Database(f);
      try { sqliteVec.load(db); } catch {}
      let rows = [];
      try { rows = db.prepare('SELECT rowid rid, text FROM memory WHERE is_active = 1 AND length(text) > 10').all(); } catch { rows = []; }
      for (const r of rows) {
        if (LIMIT && checked >= LIMIT) break;
        let stored = null;
        try {
          const x = db.prepare('SELECT embedding FROM vec_memory WHERE rowid = ?').get(r.rid);
          if (x) { const b = x.embedding; stored = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }
        } catch {}
        if (!stored) { missing++; continue; }
        let c = null;
        try {
          const fresh = await embed(String(r.text), bank);
          c = cos(fresh, stored);
          checked++;
          if (c < 0.9) {
            bad++;
            if (badSamples.length < 3) badSamples.push({ cos: Number(c.toFixed(3)), text: String(r.text).slice(0, 50) });
            if (FIX) {
              db.prepare('UPDATE vec_memory SET embedding = ? WHERE rowid = ?').run(Buffer.from(new Float32Array(fresh).buffer), r.rid);
              fixed++;
            }
          }
        } catch { /* 嵌入失败跳过,不误判 */ }
      }
      db.close();
    }
  }
  if (checked) summary[bank] = { checked, mismatched: bad, rate: Number((bad / checked).toFixed(3)), fixed, noVector: missing, samples: badSamples };
}
console.log(JSON.stringify({ mode: FIX ? 'fix' : 'audit', summary }, null, 2));
