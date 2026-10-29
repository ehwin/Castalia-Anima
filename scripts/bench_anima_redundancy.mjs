/**
 * 注入块冗余度测量 —— 用来判断"MMR 多样性"这一项到底值不值得接。
 *
 * 背景:LivingMemory(AstrBot 插件)的检索链里有 MMR(λ=0.7)控制多样性;
 * castalia-Anima 没有。但"别人有"不等于"我们缺" —— 如果我们的 top-5 本来就彼此不像,
 * MMR 就只是加复杂度。这里用真实 airi bank + 真实嵌入,量一量。
 *
 * 指标:
 *   maxSim   —— 每条结果与"块内其它结果"的最高余弦(近重复,越接近 1 越该去重)
 *   meanPair —— 块内所有两两余弦的均值(整体同质感)
 *
 * 用法: node scripts/bench_anima_redundancy.mjs [bankRoot] [topK]
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const BANK = process.argv[2] || 'D:/castalia/memory-banks/airi';
const TOPK = Number(process.argv[3] || 5);

process.env.MEMORY_DB_DIR = BANK;   // bank 根;项目目录是 <bank>/<project>/<memType>
process.env.MEMORY_CONFIG = path.join(BANK, 'config.json');
process.env.CHAR_ID = 'airi';
if (!process.env.EMBED_MODE) process.env.EMBED_MODE = 'api';

await import(pathToFileURL(path.join(DIST, 'configLoader.js')).href);
const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const searchMod = await import(pathToFileURL(path.join(DIST, 'search.js')).href);
const D = (await import('better-sqlite3')).default;
const sqliteVec = await import('sqlite-vec');

// 从各库把 rowid → 向量读出来(node:sqlite 开不了 vec0,这里用 better-sqlite3)
const vecByFile = new Map();
function loadVectors(file) {
  try {
    const db = new D(file, { readonly: true });
    sqliteVec.load(db);
    const rows = db.prepare('SELECT rowid, embedding FROM vec_memory').all();
    const map = new Map();
    for (const r of rows) {
      const f32 = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      map.set(Number(r.rowid), Float32Array.from(f32));
    }
    db.close();
    return map;
  } catch { return new Map(); }
}
const memTypeDirs = ['general', 'user', 'project', 'reference', 'feedback'];
for (const mt of memTypeDirs) {
  const f = path.join(BANK, 'airi', mt, 'memory.sqlite');
  if (fs.existsSync(f)) vecByFile.set(mt, loadVectors(f));
}

const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
};

const QUERIES = [
  '你还记得我们第一次见面吗',
  '我上次说累的时候你在做什么',
  '你答应过我的那件事是什么',
  '我们吵过一次架，因为什么',
  '黑潮把你的命运怎么了',
  '你最喜欢我做的什么',
  '那天雨夜我们说了什么',
  '你叫什么名字',
  '我生日那天发生了什么',
  '你为什么看不见命运了',
];

console.log(`bank=${BANK} topK=${TOPK} embed=${process.env.EMBED_MODE}`);
let allMax = [], allPair = [], dup = 0, total = 0;
for (const q of QUERIES) {
  const hits = await searchMod.searchMemory({ query: q, project: 'airi', characterId: 'airi', topK: TOPK, minScore: 0 });
  const vecs = [];
  for (const h of hits) {
    const mt = h.memType || 'general';
    const map = vecByFile.get(mt);
    if (!map) continue;
    const db = dbMod.DatabaseManager.getInstance('airi', mt);
    const row = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(h.id);
    const v = row && map.get(Number(row.rowid));
    if (v) vecs.push(v);
  }
  if (vecs.length < 2) { console.log(`  「${q}」 → ${hits.length} 条(向量不足,跳过)`); continue; }
  let maxSim = 0, sum = 0, pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    let localMax = 0;
    for (let j = 0; j < vecs.length; j++) {
      if (i === j) continue;
      const c = cos(vecs[i], vecs[j]);
      sum += c; pairs++;
      localMax = Math.max(localMax, c);
    }
    maxSim = Math.max(maxSim, localMax);
  }
  allMax.push(maxSim);
  allPair.push(sum / pairs);
  total += hits.length;
  if (maxSim > 0.92) dup++;
  console.log(`  「${q}」 ${hits.length} 条 | maxSim ${maxSim.toFixed(3)} | meanPair ${(sum / pairs).toFixed(3)} | ${hits.map(h => h.basis).join(',')}`);
}
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log(`\n汇总(${allMax.length} 条查询):平均 maxSim ${avg(allMax).toFixed(3)},平均 meanPair ${avg(allPair).toFixed(3)},近重复块 ${dup}/${allMax.length}`);
console.log(avg(allMax) > 0.9 ? '→ 块内普遍近重复,MMR 值得接' : '→ 块内已足够分散,MMR 收益有限');
