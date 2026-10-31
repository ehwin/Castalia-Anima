/**
 * 洞察库清理(A 项):按"新闸"标记历史复述/近重复,**保守到宁可漏杀**。
 *
 * 数据安全的硬约束(2026-10-30,用户提示):
 *   another host 等库因为中途重装系统丢过原始记忆,有些洞察可能是**唯一幸存副本**。
 *   所以一条洞察只有在「它引用的每一条来源都还在、且 is_active=1」时才允许软删 ——
 *   来源可检索 = 内容没有丢;来源缺失/被软删 = 这条洞察可能是最后一手,必须留。
 *
 * 另外三条保守规则:
 *  - 没有 metadata.reflection.sources 的洞察:永不触碰(没有锚点就没有依据)
 *  - 近重复只删"另一条仍然活着"的那些,每组保留重要度高/时间早的一条
 *  - 先写备份 JSON(含原文),再软删;--restore 可整批恢复
 *
 * 用法:
 *   node scripts/prune_insights.mjs                # dry-run(默认)
 *   node scripts/prune_insights.mjs --apply        # 真软删(先写备份)
 *   node scripts/prune_insights.mjs --restore <backup.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const RESTORE = args.includes('--restore') ? args[args.indexOf('--restore') + 1] : '';
const DUMP = args.includes('--dump') ? args[args.indexOf('--dump') + 1] : '';
const ROOT = process.env.MEMORY_BANK_ROOT || 'D:/castalia/memory-banks';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const q = await import(pathToFileURL(path.join(HERE, '..', 'dist', 'insightQuality.js')).href);

const dbCache = new Map();
const openDb = (f) => {
  if (!dbCache.has(f)) {
    try { dbCache.set(f, new DatabaseSync(f)); } catch { dbCache.set(f, null); }
  }
  return dbCache.get(f);
};
const closeAll = () => { for (const d of dbCache.values()) { try { d?.close(); } catch {} } };

/* ---------- 恢复模式 ---------- */
if (RESTORE) {
  const items = JSON.parse(fs.readFileSync(RESTORE, 'utf-8')).items || [];
  let restored = 0;
  for (const it of items) {
    const db = openDb(it.file);
    if (!db) continue;
    try {
      db.prepare('UPDATE memory SET is_active = 1, metadata = ? WHERE id = ?').run(it.metadataBefore || '{}', it.id);
      restored++;
    } catch (e) { console.log('restore 失败', it.id, e.message); }
  }
  console.log(`已恢复 ${restored}/${items.length} 条`);
  closeAll();
  process.exit(0);
}

/* ---------- 1. 收集洞察 ---------- */
const banks = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const insights = [];
for (const bank of banks) {
  const dir = path.join(ROOT, bank, 'reflect');
  if (!fs.existsSync(dir)) continue;
  for (const mt of fs.readdirSync(dir)) {
    const f = path.join(dir, mt, 'memory.sqlite');
    if (!fs.existsSync(f)) continue;
    const db = openDb(f);
    if (!db) continue;
    let rows = [];
    try { rows = db.prepare('SELECT id, text, mem_type, importance, created_at, metadata FROM memory WHERE is_active = 1').all(); } catch {}
    for (const r of rows) {
      let srcs = []; let meta = {};
      try { meta = JSON.parse(String(r.metadata || '{}')); srcs = meta?.reflection?.sources || []; } catch {}
      insights.push({
        file: f, bank, memType: r.mem_type || mt, id: String(r.id), text: String(r.text || ''),
        importance: Number(r.importance) || 0.5, createdAt: String(r.created_at || ''),
        sources: srcs, metadata: String(r.metadata || '{}'),
      });
    }
  }
}

/* ---------- 2. 解析来源(存在性 + 是否仍然活跃) ---------- */
const srcState = new Map();
function checkSource(s) {
  const key = `${s.instance}|${s.project}|${s.memType || 'general'}|${s.id}`;
  if (srcState.has(key)) return srcState.get(key);
  let out = { key, exists: false, active: false, text: '' };
  const candidates = [
    path.join(ROOT, String(s.instance || ''), String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
    path.join(ROOT, String(s.project || ''), String(s.memType || 'general'), 'memory.sqlite'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const db = openDb(f);
    if (!db) continue;
    try {
      const row = db.prepare('SELECT text, is_active FROM memory WHERE id = ?').get(String(s.id));
      if (row) { out = { key, exists: true, active: Number(row.is_active) === 1, text: String(row.text || '') }; break; }
    } catch {}
  }
  srcState.set(key, out);
  return out;
}

/* ---------- 3. 逐条判定 ---------- */
/** 最长公共子串长度(规范化后) —— 用来确认"删掉这条,内容仍然逐字存在于来源里" */
function longestCommonSubstring(a, b) {
  const A = [...a], B = [...b];
  if (!A.length || !B.length) return 0;
  let best = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 保值保护(用户明示:术数断语与古籍引文是不可压缩资产,要逐字保真)——
 * 这类文本即使被判成复述也不自动删:命理/卦象/古籍引用在别处不一定等价可复现。
 * 要放开加 --no-protect。
 */
const PROTECT = [
  // 术数/命理:断语、卦象、排盘、运程、命盘、十神 —— 用户明确要求逐字保真的资产
  /卦|爻|断语|八字|紫微|六爻|术数|命理|命盘|星盘|大运|流年|小限|大限|占[卜断]|起卦|排盘|子平|卜筮|庙陷|日主|十神|天干|地支|五行|伤官|食神|正印|偏印|七杀|正财|偏财|比肩|劫财/,
  // 紫微斗数:十二宫、禄存/四化、主星辅星 —— 这套术语出现即视为命理资产
  /命宫|身宫|命主|命身同宫|父母宫|兄弟宫|夫妻宫|子女宫|财帛宫|疾厄宫|迁移宫|仆役宫|官禄宫|田宅宫|福德宫|禄存|天马|化禄|化权|化科|化忌|四化|主星|辅星|煞星/,
  // 古籍/典籍引用:书名号 + 引用语义词(原文/曰/云/章/卷/篇/诀/赋/论),覆盖《增删卜易·某章》原文 这类
  /《[^》]{2,}》.{0,12}(原文|引用|曰|云|章|卷|篇|诀|赋|论)/,
  // 书名号本身就是典籍名(命稿/通会/斗数/…)的
  /《[^》]*(渊海|三命|滴天髓|真诠|斗数|通会|穷通|神峰|命稿|卜易|周易|易经|梅花易|奇门|大六壬|太乙|道德经|论语|庄子|孟子|孙子)[^》]*》/,
];
const NO_PROTECT = args.includes('--no-protect');
const isProtected = (t) => !NO_PROTECT && PROTECT.some(re => re.test(String(t || '')));

const stats = {
  total: insights.length,
  noSources: 0,
  lostSources: 0,     // 至少一条来源缺失/已软删 → 永不删
  restatement: 0,
  nearDuplicate: 0,
  keep: 0,
};
const candidates = [];
for (const ins of insights) {
  if (!ins.sources.length) { stats.noSources++; stats.keep++; continue; }
  const states = ins.sources.map(checkSource);
  const allSafe = states.every(s => s.active);
  if (!allSafe) { stats.lostSources++; stats.keep++; ins.unsafe = true; continue; }

  const srcText = states.map(s => s.text).join('\n');
  const v = q.evaluateInsight({ text: ins.text, sources: states.map((s, i) => ({ id: String(ins.sources[i].id || ''), text: s.text })), srcImportance: ins.importance });
  // 生存检查:规范化后,洞察的长度里至少 80% 能以**连续子串**形式在来源里找到,
  // 否则"删了它就等于丢内容",一律留(source 存在也可能只是同话题的另一条记忆)
  const normIns = q.normText(ins.text);
  const lcs = longestCommonSubstring(normIns, q.normText(srcText));
  ins.survival = Number((lcs / Math.max(1, normIns.length)).toFixed(3));
  if (v.reasons.includes('restatement') && ins.survival < 0.8) {
    stats.unverifiedSurvival = (stats.unverifiedSurvival || 0) + 1;
    stats.keep++;
    continue;
  }
  ins.protected = isProtected(ins.text);
  if (v.reasons.includes('restatement') && ins.protected) { stats.protectedKept = (stats.protectedKept || 0) + 1; stats.keep++; continue; }
  if (v.reasons.includes('restatement')) {
    stats.restatement++;
    candidates.push({ ins, reason: 'restatement', novelty: v.novelty });
    continue;
  }
  ins.novelty = v.novelty;
}

/* ---------- 4. 近重复(同库同类型) ---------- */
const byGroup = new Map();
for (const ins of insights) {
  if (ins.unsafe || !ins.sources.length) continue;
  const k = `${ins.bank}|${ins.memType}`;
  if (!byGroup.has(k)) byGroup.set(k, []);
  byGroup.get(k).push(ins);
}
const prunedIds = new Set(candidates.map(c => c.ins.id));
for (const [, group] of byGroup) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      if (prunedIds.has(a.id) || prunedIds.has(b.id)) continue;
      const v = q.evaluateInsight({
        text: b.text, sources: b.sources.map((s, n) => ({ id: String(s.id || ''), text: checkSource(s).text })),
        existing: [{ id: a.id, text: a.text }],
      });
      if (!v.duplicateOf) continue;
      // 近重复的"生存"依据是**保留的那条**,不是来源:要求删掉的内容在保留条里也能连续找到
      const dropText = q.normText(b.text);
      const keeperFor = (b.importance > a.importance) ? a : b;
      const otherText = q.normText(keeperFor === a ? b.text : a.text);
      const survival = longestCommonSubstring(dropText, otherText) / Math.max(1, dropText.length);
      if (survival < 0.8) continue;
      if ((a.protected || b.protected)) { const p = a.protected ? a : b; if (!prunedIds.has(p.id)) { stats.protectedKept = (stats.protectedKept || 0) + 1; prunedIds.add(p.id); } continue; }
      // 保留重要度高者(同分留时间早者),删另一条
      const drop = (b.importance > a.importance) ? a : b;
      const keep = drop === a ? b : a;
      if (prunedIds.has(drop.id)) continue;
      prunedIds.add(drop.id);
      stats.nearDuplicate++;
      candidates.push({ ins: drop, reason: 'near-duplicate', keptId: keep.id });
    }
  }
}
stats.keep = insights.length - candidates.length;
stats.pruneShare = Number((candidates.length / Math.max(1, insights.length)).toFixed(3));

/* ---------- 5. 报告 ---------- */
const report = {
  mode: APPLY ? 'apply' : 'dry-run',
  bankRoot: ROOT,
  stats,
  byBank: Object.fromEntries(banks.map(b => [b, {
    total: insights.filter(i => i.bank === b).length,
    pruned: candidates.filter(c => c.ins.bank === b).length,
  }]).filter(([, v]) => v.total)),
  highImportancePruned: candidates.filter(c => c.ins.importance >= 0.8).length,
  multiSourcePruned: candidates.filter(c => (c.ins.sources || []).length >= 2).length,
  sample: candidates.slice(0, 10).map(c => ({
    reason: c.reason, bank: c.ins.bank, memType: c.ins.memType,
    text: c.ins.text.slice(0, 70), novelty: c.novelty, srcCount: c.ins.sources.length,
  })),
};
console.log(JSON.stringify(report, null, 2));
if (DUMP) {
  fs.writeFileSync(DUMP, JSON.stringify(candidates.map(c => ({
    id: c.ins.id, bank: c.ins.bank, memType: c.ins.memType, reason: c.reason,
    importance: c.ins.importance, srcCount: (c.ins.sources || []).length,
    survival: c.ins.survival, novelty: c.novelty, text: c.ins.text,
  })), null, 2), 'utf-8');
  console.log(`候选清单已写入 ${DUMP}`);
}

if (!APPLY) {
  closeAll();
  process.exit(0);
}

/* ---------- 6. 落地:先备份,再软删 ---------- */
if (stats.pruneShare > 0.6 && !FORCE) {
  console.log(`\n拒绝执行:拟删比例 ${(stats.pruneShare * 100).toFixed(1)}% 超过 60% 安全线(要强删加 --force)`);
  closeAll();
  process.exit(3);
}
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(ROOT, `insight-prune-${ts}.json`);
fs.writeFileSync(backupFile, JSON.stringify({
  createdAt: new Date().toISOString(), root: ROOT, stats,
  items: candidates.map(c => ({
    file: c.ins.file, id: c.ins.id, bank: c.ins.bank, memType: c.ins.memType,
    reason: c.reason, text: c.ins.text, metadataBefore: c.ins.metadata,
  })),
}, null, 2), 'utf-8');
console.log(`备份: ${backupFile} (${candidates.length} 条)`);

let done = 0, failed = 0;
for (const c of candidates) {
  const db = openDb(c.ins.file);
  if (!db) { failed++; continue; }
  try {
    let meta = {};
    try { meta = JSON.parse(c.ins.metadata || '{}'); } catch { meta = {}; }
    meta.prunedAt = new Date().toISOString();
    meta.prunedReason = c.reason;
    meta.prunedBy = 'reflect-quality-gate-v1';
    if (c.keptId) meta.prunedDuplicateOf = c.keptId;
    db.prepare('UPDATE memory SET is_active = 0, metadata = ? WHERE id = ?').run(JSON.stringify(meta), c.ins.id);
    done++;
  } catch (e) { failed++; console.log('软删失败', c.ins.id, e.message); }
}
console.log(`软删 ${done} 条,失败 ${failed} 条;恢复用 --restore ${backupFile}`);
closeAll();
