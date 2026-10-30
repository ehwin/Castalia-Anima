/**
 * 洞察的语义侧体检(零 LLM):语义近重复 + 语义漂移。
 *
 * 两个问题:
 *  1 3-gram 字面去重漏掉了多少近重复?(语义重复但措辞不同)
 *  2 洞察相对它的来源,语义漂移有多大?(4-gram 新颖度只是字面口径)
 *
 * 用法:MEMORY_BANK_ROOT=D:/castalia/memory-banks node scripts/bench_insight_semantics.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const ROOT = process.env.MEMORY_BANK_ROOT || 'D:/castalia/memory-banks';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const q = await import(new URL(`file:///${path.join(HERE, '..', 'dist', 'insightQuality.js').replace(/\\/g, '/')}`).href);

const open = (f) => {
  const db = new Database(f, { readonly: true });
  try { sqliteVec.load(db); } catch {}
  return db;
};

/* ---------- 1. 洞察 + 向量 ---------- */
const groups = new Map();   // bank|memType -> rows[{id,text,vec}]
const dbByPath = new Map();
for (const bank of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, bank, 'reflect');
  if (!fs.existsSync(dir)) continue;
  for (const mt of fs.readdirSync(dir)) {
    const f = path.join(dir, mt, 'memory.sqlite');
    if (!fs.existsSync(f)) continue;
    const db = open(f); dbByPath.set(f, db);
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT m.rowid AS rid, m.id, m.text, m.metadata
        FROM memory m WHERE m.is_active = 1
      `).all();
    } catch { rows = []; }
    const getVec = (() => {
      try {
        const st = db.prepare('SELECT embedding FROM vec_memory WHERE rowid = ?');
        return (rid) => {
          const r = st.get(rid);
          if (!r) return null;
          const b = r.embedding;
          return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        };
      } catch { return () => null; }
    })();
    const key = `${bank}|${mt}`;
    const arr = [];
    for (const r of rows) {
      let srcs = [];
      try { srcs = JSON.parse(String(r.metadata || '{}'))?.reflection?.sources || []; } catch {}
      arr.push({ id: String(r.id), text: String(r.text || ''), srcs, vec: getVec(r.rid) });
    }
    if (arr.length) groups.set(key, arr);
  }
}

const cos = (a, b) => {
  if (!a || !b) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/* ---------- 2. 语义近重复 vs 字面近重复 ---------- */
const TH = 0.92;
let pairSemantic = 0, pairLexical = 0, pairBoth = 0, pairSemanticOnly = 0;
const missedExamples = [];
for (const [key, rows] of groups) {
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const s = cos(a.vec, b.vec);
      const lex = q.jaccard(q.charNgrams(a.text, 3), q.charNgrams(b.text, 3)) >= 0.7
        || q.overlapRatio(q.charNgrams(a.text, 3), q.charNgrams(b.text, 3)) >= 0.8;
      const sem = s !== null && s >= TH;
      if (sem) pairSemantic++;
      if (lex) pairLexical++;
      if (sem && lex) pairBoth++;
      if (sem && !lex) {
        pairSemanticOnly++;
        if (missedExamples.length < 5) missedExamples.push({ cos: Number(s.toFixed(3)), a: a.text.slice(0, 55), b: b.text.slice(0, 55) });
      }
    }
  }
}

/* ---------- 3. 语义漂移:洞察 vs 它引用的来源 ---------- */
const drift = [];
let driftUnresolved = 0;
const srcVecCache = new Map();
const srcTextCache = new Map();
function srcTextOf(s) {
  const k = `${s.instance}|${s.project}|${s.memType || 'general'}|${s.id}`;
  if (srcTextCache.has(k)) return srcTextCache.get(k);
  let out = '';
  for (const f of [
    path.join(ROOT, String(s.instance || ''), String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
    path.join(ROOT, String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
  ]) {
    if (!fs.existsSync(f)) continue;
    const db = dbByPath.get(f) || open(f);
    dbByPath.set(f, db);
    try { const row = db.prepare('SELECT text FROM memory WHERE id = ?').get(String(s.id)); if (row) { out = String(row.text || ''); break; } } catch {}
  }
  srcTextCache.set(k, out);
  return out;
}
function sourceVec(s) {
  const k = `${s.instance}|${s.project}|${s.memType || 'general'}|${s.id}`;
  if (srcVecCache.has(k)) return srcVecCache.get(k);
  let out = null;
  for (const f of [
    path.join(ROOT, String(s.instance || ''), String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
    path.join(ROOT, String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
  ]) {
    if (!fs.existsSync(f)) continue;
    const db = dbByPath.get(f) || open(f);
    dbByPath.set(f, db);
    try {
      const row = db.prepare('SELECT rowid AS rid FROM memory WHERE id = ?').get(String(s.id));
      if (!row) continue;
      const v = db.prepare('SELECT embedding FROM vec_memory WHERE rowid = ?').get(row.rid);
      if (v) {
        const b = v.embedding;
        out = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        break;
      }
    } catch {}
  }
  srcVecCache.set(k, out);
  return out;
}
for (const [, rows] of groups) {
  for (const r of rows) {
    if (!r.vec || !r.srcs.length) continue;
    const vs = r.srcs.map(sourceVec).filter(Boolean);
    if (!vs.length) continue;
    // 解析守卫:来源文本与洞察几乎无字面重合 → 多半是 id 在多个 project/备份库里重名,
    // 取到了另一行;这种对子不进漂移统计,否则会把"解析错误"算成"语义漂移"。
    const insBig = q.charNgrams(r.text, 2);
    const paired = vs.map((v, i) => ({ v, txt: String(r.srcs[i]?.id ? (srcTextOf(r.srcs[i]) || '') : '') }));
    const keep = paired.filter(p => q.overlapRatio(insBig, q.charNgrams(p.txt, 2)) >= 0.02);
    const sims = (keep.length ? keep : []).map(p => cos(r.vec, p.v)).filter(x => x !== null);
    if (!sims.length) { driftUnresolved++; continue; }
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    // 多源整合洞察对**单条**来源天然偏低(它覆盖 3~5 条),所以同时记"最像的那条"。
    // 漂移判定用 max:连最像的一条都远 → 才是真的没接上。
    drift.push({ cos: mean, max: Math.max(...sims), srcs: sims.length, text: r.text.slice(0, 50) });
  }
}
const byMax = [...drift].sort((a, b) => a.max - b.max);
drift.sort((a, b) => a.cos - b.cos);
const pct = (p) => drift[Math.floor(drift.length * p)]?.cos ?? null;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

console.log(JSON.stringify({
  insights: [...groups.values()].reduce((n, r) => n + r.length, 0),
  withVector: [...groups.values()].reduce((n, r) => n + r.filter(x => x.vec).length, 0),
  nearDuplicate: {
    threshold: TH,
    semanticPairs: pairSemantic,
    lexicalPairs: pairLexical,
    both: pairBoth,
    semanticOnly: pairSemanticOnly,
    lexicalMissRate: pairSemantic ? Number((pairSemanticOnly / pairSemantic).toFixed(3)) : null,
    examples: missedExamples,
  },
  drift: {
    measured: drift.length,
    unresolvedPairsSkipped: driftUnresolved,
    mean: Number(mean(drift.map(d => d.cos)).toFixed(3)),
    p10: Number((pct(0.1) ?? 0).toFixed(3)),
    p50: Number((pct(0.5) ?? 0).toFixed(3)),
    p90: Number((pct(0.9) ?? 0).toFixed(3)),
    below060: drift.filter(d => d.cos < 0.6).length,
    below050: drift.filter(d => d.cos < 0.5).length,
    maxToAnySource: {
      mean: Number(mean(drift.map(d => d.max)).toFixed(3)),
      p10: Number((byMax[Math.floor(byMax.length * 0.1)]?.max ?? 0).toFixed(3)),
      below060: drift.filter(d => d.max < 0.6).length,
      below050: drift.filter(d => d.max < 0.5).length,
      lowest: byMax.slice(0, 5).map(d => ({ max: Number(d.max.toFixed(3)), srcs: d.srcs, text: d.text })),
    },
    lowest: drift.slice(0, 3).map(d => ({ cos: Number(d.cos.toFixed(3)), max: Number(d.max.toFixed(3)), srcs: d.srcs, text: d.text })),
  },
}, null, 2));
for (const db of dbByPath.values()) { try { db.close(); } catch {} }
