/**
 * 用现存 1,532 条洞察回测"质量闸":多少条会被拦下、按什么理由。
 *
 * 这不是"重反思",是**用新闸重新判卷** —— 前提是把它们当作系统应当放行的样本,
 * 所以拦下的比例越高,说明原来的入库标准越松(而不是新闸越严)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const q = await import(pathToFileURL(path.join(HERE, '..', 'dist', 'insightQuality.js')).href);
const ROOT = process.env.MEMORY_BANK_ROOT || 'D:/castalia/memory-banks';

const banks = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const perBank = {};
const reasons = { restatement: 0, 'near-duplicate': 0, 'evidence-not-in-source': 0 };
const dupIds = new Set();
let total = 0;
const dbCache = new Map();
const srcCache = new Map();

function openDb(f) { if (!dbCache.has(f)) { try { dbCache.set(f, new DatabaseSync(f, { readOnly: true })); } catch { dbCache.set(f, null); } } return dbCache.get(f); }
function sourceText(s) {
  const key = `${s.instance}|${s.project}|${s.memType || 'general'}|${s.id}`;
  if (srcCache.has(key)) return srcCache.get(key);
  let t = null;
  for (const f of [
    path.join(ROOT, String(s.instance || ''), String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
    path.join(ROOT, String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
  ]) {
    const db = fs.existsSync(f) ? openDb(f) : null;
    if (!db) continue;
    try { const r = db.prepare('SELECT text FROM memory WHERE id = ?').get(String(s.id)); if (r) { t = String(r.text || ''); break; } } catch {}
  }
  srcCache.set(key, t);
  return t;
}

for (const bank of banks) {
  const dir = path.join(ROOT, bank, 'reflect');
  if (!fs.existsSync(dir)) continue;
  const all = [];
  for (const mt of fs.readdirSync(dir)) {
    const f = path.join(dir, mt, 'memory.sqlite');
    const db = fs.existsSync(f) ? openDb(f) : null;
    if (!db) continue;
    let rows = []; try { rows = db.prepare('SELECT id, text, importance, metadata FROM memory WHERE is_active = 1').all(); } catch {}
    for (const r of rows) {
      let srcs = []; try { srcs = JSON.parse(String(r.metadata || '{}'))?.reflection?.sources || []; } catch {}
      all.push({ id: String(r.id), text: String(r.text || ''), importance: Number(r.importance) || 0.5, srcs });
    }
  }
  const stats = { total: all.length, restatement: 0, nearDuplicate: 0, pass: 0, noveltyMean: 0 };
  const existing = all.map(x => ({ id: x.id, text: x.text }));
  for (const ins of all) {
    const sources = ins.srcs.map(s => ({ id: String(s.id), text: sourceText(s) || '' })).filter(s => s.text);
    const v = q.evaluateInsight({
      text: ins.text,
      sources,
      srcImportance: ins.importance,
      existing: existing.filter(e => e.id !== ins.id),
    });
    if (v.reasons.includes('restatement')) { stats.restatement++; reasons.restatement++; }
    if (v.reasons.includes('near-duplicate')) { stats.nearDuplicate++; reasons['near-duplicate']++; dupIds.add(ins.id); }
    if (v.ok) stats.pass++;
    stats.noveltyMean += v.novelty;
  }
  stats.noveltyMean = Number((stats.noveltyMean / Math.max(1, all.length)).toFixed(3));
  total += all.length;
  if (all.length) perBank[bank] = stats;
}

console.log(JSON.stringify({ total, perBank, reasons, duplicatedInsights: dupIds.size }, null, 2));
for (const db of dbCache.values()) { try { db?.close(); } catch {} }
