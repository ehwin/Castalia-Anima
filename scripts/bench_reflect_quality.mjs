/**
 * 反思质量离线基准(零 LLM 调用)。
 *
 * 目的:把"洞察质量"从主观印象变成可复现的数字,并且只用**确定性**指标 ——
 * 不引入 LLM 裁判(LLM-as-judge 家族内部一致性 r≈0.55,见 v318 meta-analysis)。
 *
 * 六个口径(都可以在 pg/sqlite 上纯离线算):
 *  A 锚定率 anchor   : 洞察与它引用的来源是否共享内容 bigram(0 = 完全没接上)
 *  B 新颖度 novelty  : 洞察里有多少 4-gram 在来源中不存在(太低=复述,太高=漂移)
 *  C 具体性具体的 : 是否含数字/日期/引号/外文专名(纯口号=无锚点)
 *  D 近重复 nearDup : 洞察之间 3-gram Jaccard > 0.6 的对(入库查重只做了完全相等)
 *  E 单源占比 single: 只引用 1 条来源的"洞察"其实是摘要,不是整合
 *  F 自评重要度分布  : LLM 自己给的 importance(无验证器信号)
 *
 * 用法:MEMORY_BANK_ROOT=D:/castalia/memory-banks node scripts/bench_reflect_quality.mjs [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = process.env.MEMORY_BANK_ROOT || 'D:/castalia/memory-banks';
const OUT = arg('--json', '');

const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
const bigrams = (s) => { const t = [...norm(s)]; const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t[i] + t[i + 1]); return out; };
const ngrams = (s, n) => { const t = [...norm(s)]; const out = new Set(); for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join('')); return out; };
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const jaccard = (a, b) => { const i = inter(a, b); const u = a.size + b.size - i; return u === 0 ? 0 : i / u; };
const medi = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/* ---------- 1. 收集洞察 ---------- */
const banks = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const insights = [];
for (const bank of banks) {
  const dir = path.join(ROOT, bank, 'reflect');
  if (!fs.existsSync(dir)) continue;
  for (const mt of fs.readdirSync(dir)) {
    const f = path.join(dir, mt, 'memory.sqlite');
    if (!fs.existsSync(f)) continue;
    let db; try { db = new DatabaseSync(f, { readOnly: true }); } catch { continue; }
    let rows = [];
    try {
      rows = db.prepare("SELECT id, text, mem_type, importance, created_at, metadata FROM memory WHERE is_active = 1").all();
    } catch { rows = []; }
    db.close();
    for (const r of rows) {
      let srcs = [];
      try { srcs = JSON.parse(String(r.metadata || '{}'))?.reflection?.sources || []; } catch {}
      insights.push({
        bank, memType: r.mem_type || mt, id: String(r.id), text: String(r.text || ''),
        importance: Number(r.importance) || 0, createdAt: String(r.created_at || ''), sources: srcs,
      });
    }
  }
}

/* ---------- 2. 解析来源正文 ---------- */
const srcCache = new Map();
const dbCache = new Map();
function sourceText(s) {
  const key = `${s.instance}|${s.project}|${s.memType || 'general'}|${s.id}`;
  if (srcCache.has(key)) return srcCache.get(key);
  let text = null;
  const candidates = [
    path.join(ROOT, String(s.instance || ''), String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
    path.join(ROOT, String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    let db = dbCache.get(f);
    if (!db) { try { db = new DatabaseSync(f, { readOnly: true }); dbCache.set(f, db); } catch { continue; } }
    try {
      const row = db.prepare('SELECT text FROM memory WHERE id = ?').get(String(s.id));
      if (row) { text = String(row.text || ''); break; }
    } catch {}
  }
  srcCache.set(key, text);
  return text;
}

/* ---------- 3. 计算 ---------- */
const rows = insights.map(it => {
  const texts = it.sources.map(sourceText).filter(Boolean);
  const srcConcat = texts.join('\n');
  const a = bigrams(it.text), b = bigrams(srcConcat);
  const anchor = b.size === 0 ? null : inter(a, b) / Math.max(1, Math.min(a.size, b.size));
  const g4i = ngrams(it.text, 4), g4s = ngrams(srcConcat, 4);
  const novelty = g4i.size === 0 ? 0 : 1 - inter(g4i, g4s) / g4i.size;
  const specific = /[0-9]|「|」|"|“|”|《|》|[A-Za-z]{2,}/.test(it.text);
  const len = [...it.text].length;
  return {
    ...it, resolved: texts.length, anchor, novelty, specific, len,
    g3: ngrams(it.text, 3),
  };
});

/* 近重复:同库同类型内两两比(1.5k 条 → 100 万对,可接受) */
const nearDupPairs = [];
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (a.bank !== b.bank || a.memType !== b.memType) continue;
    const jac = jaccard(a.g3, b.g3);
    if (jac > 0.6) nearDupPairs.push({ i, j, jac, a: a.text.slice(0, 40), b: b.text.slice(0, 40) });
  }
}

const anchoredRows = rows.filter(r => r.anchor !== null);
const single = rows.filter(r => (r.sources?.length || 0) <= 1);
const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    insights: rows.length,
    byBank: Object.fromEntries(banks.map(b => [b, rows.filter(r => r.bank === b).length]).filter(([, n]) => n)),
    byType: rows.reduce((m, r) => (m[r.memType] = (m[r.memType] || 0) + 1, m), {}),
    sourcesResolved: rows.reduce((n, r) => n + r.resolved, 0),
    sourcesTotal: rows.reduce((n, r) => n + (r.sources?.length || 0), 0),
  },
  anchor: {
    measured: anchoredRows.length,
    mean: Number(mean(anchoredRows.map(r => r.anchor)).toFixed(3)),
    median: Number(medi(anchoredRows.map(r => r.anchor)).toFixed(3)),
    zeroShare: Number((anchoredRows.filter(r => r.anchor < 0.02).length / Math.max(1, anchoredRows.length)).toFixed(3)),
    lowShare: Number((anchoredRows.filter(r => r.anchor < 0.15).length / Math.max(1, anchoredRows.length)).toFixed(3)),
  },
  novelty: {
    mean: Number(mean(rows.map(r => r.novelty)).toFixed(3)),
    veryLowShare: Number((rows.filter(r => r.novelty < 0.3).length / Math.max(1, rows.length)).toFixed(3)),
    veryHighShare: Number((rows.filter(r => r.novelty > 0.85).length / Math.max(1, rows.length)).toFixed(3)),
  },
  specificity: { specificShare: Number((rows.filter(r => r.specific).length / Math.max(1, rows.length)).toFixed(3)) },
  nearDup: {
    pairCount: nearDupPairs.length,
    involvedInsights: new Set(nearDupPairs.flatMap(p => [p.i, p.j])).size,
    involvedShare: Number((new Set(nearDupPairs.flatMap(p => [p.i, p.j])).size / Math.max(1, rows.length)).toFixed(3)),
    examples: nearDupPairs.sort((a, b) => b.jac - a.jac).slice(0, 3).map(p => ({ jac: Number(p.jac.toFixed(2)), a: p.a, b: p.b })),
  },
  singleSource: { count: single.length, share: Number((single.length / Math.max(1, rows.length)).toFixed(3)) },
  length: { median: medi(rows.map(r => r.len)), p90: [...rows.map(r => r.len)].sort((a, b) => a - b)[Math.floor(rows.length * 0.9)] || 0 },
  importance: {
    bins: rows.reduce((m, r) => { const k = r.importance >= 0.8 ? 'high' : r.importance >= 0.5 ? 'mid' : 'low'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    distinct: new Set(rows.map(r => r.importance.toFixed(2))).size,
  },
};

console.log(JSON.stringify(report, null, 2));
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ report, rows: rows.map(({ g3, ...r }) => r) }, null, 2)); console.log(`\n明细写入 ${OUT}`); }
