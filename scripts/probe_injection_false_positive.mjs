/**
 * probe_injection_false_positive —— 外部语料误注入基准（只出数字，不做断言）
 *
 * 为什么需要它：注入策略的任何改动都会在"噪音"和"召回"两侧来回换。仓库里的
 * regression 用的是自己造的探针（取记忆前 24 字当查询），它天然偏向词法命中，
 * 看不出"真实用户随口一句话会不会带出记忆"。这个探针补上那一面。
 *
 * 查询集：scripts/fixtures/external_queries_lccc.json
 *   来自 LCCC（thu-coai/CDial-GPT 仓库 data/toy_*.txt），11,365 条去重真实中文闲聊，
 *   按长度分层抽 150(1–5 字) / 100(6–12) / 50(13–40)，与任何个人记忆库无关，
 *   所以这里的每一次注入都是假阳性。
 *
 * 不做断言的理由：当前真实基线 19~36%，钉一个阈值等于把现状当成正确。
 * 用法：
 *   MEMORY_DB_DIR=D:/castalia/memory-banks/default CASTALIA_PROJECT=default \
 *   USE_VECTOR=1 node scripts/probe_injection_false_positive.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist');
const PROJECT = process.env.CASTALIA_PROJECT || 'default';

const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const Database = requireFromRoot('better-sqlite3');

const dbDir = process.env.MEMORY_DB_DIR;
if (!dbDir) { console.error('需要 MEMORY_DB_DIR'); process.exit(2); }

if (process.env.USE_VECTOR === '1') {
  if (!process.env.MEMORY_CONFIG) process.env.MEMORY_CONFIG = path.join(dbDir, 'config.json');
  delete process.env.EMBED_MODE;
} else {
  delete process.env.MEMORY_CONFIG;
  process.env.EMBED_MODE = 'none';
}
process.env.MCP_LOG_TOOLS = '0';

// character_id 取库内最常见的一个，避免跨角色串台
let charId = '';
const dbf = path.join(dbDir, PROJECT, 'general', 'memory.sqlite');
if (fs.existsSync(dbf)) {
  const db = new Database(dbf, { readonly: true, fileMustExist: true });
  charId = db.prepare("select coalesce(character_id,'') c, count(*) n from memory where is_active=1 group by 1 order by n desc limit 1").get()?.c || '';
  db.close();
}

await import(pathToFileURL(path.join(DIST, 'configLoader.js')).href);
const { recallForInjection } = await import(pathToFileURL(path.join(DIST, 'recallForInjection.js')).href);

const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'external_queries_lccc.json'), 'utf8'));
const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : 0);

const out = {};
let tot = 0, inj = 0;
for (const [stratum, list] of Object.entries(fx.queries)) {
  let n = 0, hit = 0;
  for (const q of list) {
    let r;
    try { r = await recallForInjection(q, { project: PROJECT, characterId: charId }); } catch { continue; }
    n++; tot++;
    if ((r.stats.count || 0) > 0) { hit++; inj++; }
  }
  out[stratum] = { n, injected: `${pct(hit, n)}%` };
}
out.all = { n: tot, injected: `${pct(inj, tot)}%` };
console.log(JSON.stringify({ project: PROJECT, charId, db: dbf, queries: fx._meta?.来源?.slice(0, 60), ...out }, null, 1));
