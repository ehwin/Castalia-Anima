/**
 * 对照基准:覆盖率打分(Anima 现状口径) vs BM25+IDF(内存倒排)
 *
 * 语料 = 真实 default bank 的活跃记忆(只读打开)。查询 = 从每条记忆里随机抽 3 个 bigram
 * (自然包含高频词,不人为剔除 —— 剔除就变成"给 BM25 送分")。
 * 指标:recall@5 / MRR / 平均候选数。全部离线,零 API 调用。
 *
 * 用法: node scripts/bench_anima_idf.mjs [bankRoot] [样例数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const BANK = process.argv[2] || 'D:/castalia/memory-banks/default';
const SAMPLES = Number(process.argv[3] || 40);

const { queryTerms } = await import(pathToFileURL(path.join(DIST, 'search.js')).href);
const idfMod = await import(pathToFileURL(path.join(DIST, 'lexicalIdf.js')).href);
const D = (await import('better-sqlite3')).default;

// ── 收语料 ──────────────────────────────────────────────────────────────────
const docs = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'memory.sqlite' && path.basename(path.dirname(p)) !== 'reflect') {
      try {
        const db = new D(p, { readonly: true, fileMustExist: true });
        const rows = db.prepare("SELECT id, text FROM memory WHERE is_active = 1 AND length(trim(text)) > 12").all();
        for (const r of rows) docs.push({ id: `${path.basename(path.dirname(path.dirname(p)))}/${r.id}`, text: String(r.text) });
        db.close();
      } catch (_e) { /* 跳过坏库 */ }
    }
  }
}
walk(BANK);
console.log(`语料 ${docs.length} 条(default bank,含所有 project)`);
if (docs.length < 20) { console.log('语料太少,跳过'); process.exit(0); }

const idx = idfMod.buildBm25Index(docs, (s) => queryTerms(s, 64));

// ── 生成查询 ────────────────────────────────────────────────────────────────
let seed = 20261029;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const sample = [...docs].sort(() => rnd() - 0.5).slice(0, SAMPLES);

function rank(scores, topK = 5) {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id]) => id);
}


/** Anima 现役口径(search.ts L544-595):按 IDF 加权的覆盖率 = Σ idf(命中) / Σ idf(查询词) */
function idfCoverageScores(idx, queryTerms) {
  const uniq = [...new Set(queryTerms)];
  const total = uniq.reduce((n, t) => n + idfMod.idf(idx, t), 0) || 1;
  const hits = new Map();
  for (const t of uniq) {
    const p = idx.postings.get(t);
    if (!p) continue;
    const w = idfMod.idf(idx, t);
    for (const docId of p.keys()) hits.set(docId, (hits.get(docId) || 0) + w);
  }
  const out = new Map();
  for (const [docId, w] of hits) out.set(docId, Math.min(1, w / total));
  return out;
}

let covHit = 0, bm25Hit = 0, covRr = 0, bm25Rr = 0, covCand = 0, bm25Cand = 0, skipped = 0;
let idfHit = 0, idfRr = 0;
const detail = [];
for (const d of sample) {
  // 两种查询构造:random=随机抽 3 个 bigram(考"能不能找到");phrase=取正文里一段连续短语
  // (更接近真人短问句,天然含「记得/自己」这类高频 bigram)
  const MODE = process.env.BENCH_MODE || 'random';
  let terms = queryTerms(d.text, 32).filter(t => t.length > 1);
  if (MODE === 'phrase') {
    const raw = d.text.replace(/\s+/g, '');
    const w = Math.min(8, Math.max(4, raw.length));
    const start = Math.floor(rnd() * Math.max(1, raw.length - w));
    terms = queryTerms(raw.slice(start, start + w), 32).filter(t => t.length > 1);
  }
  if (terms.length < 3) { skipped++; continue; }
  // 抽 3 个(bigram 随机,不剔除高频词)
  const picked = [];
  while (picked.length < 3 && terms.length) {
    const i = Math.floor(rnd() * terms.length);
    const t = terms.splice(i, 1)[0];
    if (!picked.includes(t)) picked.push(t);
  }
  const c = idfMod.coverageScores(idx, picked);
  const b = idfMod.bm25Scores(idx, picked);
  const i2 = idfCoverageScores(idx, picked);
  const rc = rank(c), rb = rank(b), ri = rank(i2);
  const pi = ri.indexOf(d.id);
  if (pi >= 0) { idfHit++; idfRr += 1 / (pi + 1); }
  detail.push({ q: picked.join(' '), gold: d.id, idfRank: pi < 0 ? '-' : pi + 1 });
  covCand += c.size; bm25Cand += b.size;
  const pc = rc.indexOf(d.id), pb = rb.indexOf(d.id);
  if (pc >= 0) { covHit++; covRr += 1 / (pc + 1); }
  if (pb >= 0) { bm25Hit++; bm25Rr += 1 / (pb + 1); }
  detail.push({ q: picked.join(' '), gold: d.id, covRank: pc < 0 ? '-' : pc + 1, bm25Rank: pb < 0 ? '-' : pb + 1 });
}

const n = sample.length - skipped;
const pct = (x) => `${(100 * x / Math.max(1, n)).toFixed(0)}%`;
console.log(`\n查询 ${n} 条(跳过 ${skipped} 条词太少的)\n`);
console.log('口径            recall@5   MRR     平均候选数');
console.log(`覆盖率(现状)    ${pct(covHit).padStart(5)}    ${(covRr / Math.max(1, n)).toFixed(3)}   ${(covCand / Math.max(1, n)).toFixed(1)}`);
console.log(`BM25+IDF        ${pct(bm25Hit).padStart(5)}    ${(bm25Rr / Math.max(1, n)).toFixed(3)}   ${(bm25Cand / Math.max(1, n)).toFixed(1)}`);
console.log(`IDF覆盖率(现役) ${pct(idfHit).padStart(5)}    ${(idfRr / Math.max(1, n)).toFixed(3)}   ${(covCand / Math.max(1, n)).toFixed(1)}`);
const improved = detail.filter(d => typeof d.bm25Rank === 'number' && (typeof d.covRank !== 'number' || d.bm25Rank < d.covRank)).length;
const worse = detail.filter(d => typeof d.covRank === 'number' && (typeof d.bm25Rank !== 'number' || d.bm25Rank > d.covRank)).length;
console.log(`\n逐条:BM25 更好 ${improved} 条,更差 ${worse} 条`);
console.log('\n样例(前 8 条):');
for (const d of detail.slice(0, 8)) console.log(`  「${d.q}」 gold=${d.gold.slice(0, 28)}  cov=${d.covRank} bm25=${d.bm25Rank}`);
