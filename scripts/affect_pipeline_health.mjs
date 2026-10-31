#!/usr/bin/env node
/**
 * 情感/记忆反馈链路的体检（只读，不写任何库）。
 *
 * 审计 `docs/research/anima-paper-feasibility-2026-10-31.md` §3 的结论是
 * "现有材料无法重建情绪—检索—反思轨迹"，原因是关键表全是 0 行。这个脚本把
 * "到底是没写、还是写了没落库"一次说清，之后做前瞻实验可以直接当基线。
 *
 * 用法：
 *   node scripts/affect_pipeline_health.mjs [banksDir] [--json]
 * 默认 banksDir = D:/castalia/memory-banks（可用 MEMORY_BANKS_DIR 覆盖）。
 * 每个 sqlite 以 readonly 打开；缺表 = 该部署没跑过这条链路（不是错误）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const banks = path.resolve(argv[0] || process.env.MEMORY_BANKS_DIR || 'D:/castalia/memory-banks');
const asJson = process.argv.includes('--json');
if (!fs.existsSync(banks)) {
  console.error(`[affect-health] banks dir not found: ${banks}`);
  process.exit(2);
}

const TABLES = {
  memory: 'SELECT COUNT(*) AS n FROM memory',
  active: 'SELECT COUNT(*) AS n FROM memory WHERE is_active = 1',
  touched: 'SELECT COUNT(*) AS n FROM memory WHERE accessed_count > 0',
  accessLog: 'SELECT COUNT(*) AS n FROM memory_access_log',
  psycheState: 'SELECT COUNT(*) AS n FROM psyche_state',
  psycheEvidence: 'SELECT COUNT(*) AS n FROM psyche_state WHERE has_evidence = 1',
  psycheEvents: 'SELECT COUNT(*) AS n FROM psyche_events',
  selfCycle: 'SELECT COUNT(*) AS n FROM self_cycle_runs',
  convLog: "SELECT COUNT(*) AS n FROM memory WHERE source = 'conversation_log'",
  reflect: "SELECT COUNT(*) AS n FROM memory WHERE source LIKE 'reflect%'",
};

const rows = [];
function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (/backup|_retired|snapshot|node_modules|\.git/i.test(ent.name)) continue;
      walk(full, depth + 1);
      continue;
    }
    if (!ent.name.endsWith('.sqlite')) continue;
    let db;
    try { db = new Database(full, { readonly: true, fileMustExist: true }); } catch { continue; }
    const rec = { file: path.relative(banks, full).replaceAll('\\', '/'), missing: [] };
    for (const [key, sql] of Object.entries(TABLES)) {
      try { rec[key] = Number(db.prepare(sql).get()?.n ?? 0); }
      catch { rec[key] = null; rec.missing.push(key); }
    }
    try { db.close(); } catch {}
    rows.push(rec);
  }
}
walk(banks);

const sum = key => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

if (asJson) {
  console.log(JSON.stringify({ banks, partitions: rows.length, totals: Object.fromEntries(Object.keys(TABLES).map(k => [k, sum(k)])), rows }, null, 2));
  process.exit(0);
}

const head = ['file', 'memory', 'active', 'touched', 'accessLog', 'psycheState', 'psycheEvidence', 'psycheEvents', 'selfCycle', 'convLog', 'reflect'];
const width = [44, 7, 7, 8, 9, 11, 14, 12, 9, 8, 7];
console.log(head.map((h, i) => h.padEnd(width[i])).join(''));
console.log(width.map(w => '-'.repeat(w)).join(''));
const fmt = v => (v === null ? '  --' : String(v));
for (const r of rows) {
  if (!r.memory && !r.convLog) continue;
  console.log([
    r.file.length > 43 ? '…' + r.file.slice(-42) : r.file,
    r.memory, r.active, r.touched, r.accessLog, r.psycheState, r.psycheEvidence, r.psycheEvents, r.selfCycle, r.convLog, r.reflect,
  ].map((v, i) => fmt(v).padEnd(width[i])).join(''));
}

console.log('\n合计:', Object.fromEntries(Object.keys(TABLES).map(k => [k, sum(k)])));
console.log('\n判读：');
const touched = sum('touched'), log = sum('accessLog'), ev = sum('psycheEvents'), st = sum('psycheEvidence');
if (touched > 0 && log === 0) {
  console.log(`  ⚠ accessed_count>0 有 ${touched} 条，但 memory_access_log 为 0 —— 访问时间的间隔信息从未落库（ACT-R 拿不到数据）。`);
} else if (log > 0) {
  console.log(`  ✓ 访问日志在写（${log} 行），可以算间隔效应。`);
}
if (st > 0 && ev === 0) {
  console.log(`  ⚠ 有证据状态 ${st} 条但 psyche_events 为 0 —— 状态更新发生过却没有事件历史（无法重放）。`);
} else if (ev > 0) {
  console.log(`  ✓ 情感事件历史在写（${ev} 行），可重放。`);
} else if (st === 0 && ev === 0) {
  console.log('  · 情感链路尚未产生任何持久化状态 —— 这条管线在这个部署里没跑过（digest 驱动 VAD 队列 → psyche）。');
}
if (sum('selfCycle') === 0) console.log('  · self_cycle_runs 为空：日记/自我循环未运行过。');
