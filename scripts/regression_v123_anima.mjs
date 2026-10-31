// v1.23 回移回归（Anima 侧）：facts 时间有效性 / 同批冲突 / 复写清空 valid_to、
// 冷存打标与回温、superseded 不进检索、invalidate 动作、Parent-Child 回捞、hardFacts 跨库落库。
// 纯离线：临时库 + mock fetch（只 mock LLM，EMBED_MODE=none 完全不联网），不写 memory-banks。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-v123-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({ reflect: { preservation: 'evidence' } }));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',              // 零网络：不调 Ollama / embedding API
  CASTALIA_PROJECT: 'anima-v123',
  CHAR_ID: 'default',                 // v1.24: 角色 = 进程级实例 ID(本回归显式钉成 default)
  COLD_AFTER_DAYS: '60',
  COLD_MAX_IMPORTANCE: '0.6',
  REFLECT_LLM_API_KEY: 'fixture',
  REFLECT_LLM_URL: 'https://fixture.invalid',
  REFLECT_LLM_RETRIES: '1',
  CONSOLIDATE_MIN_INTERVAL_HOURS: '0',
});

const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager } = await load('db');
const { saveMemory, saveFacts, markColdMemories, findDbByMemoryId, getFactsBySubject } = await load('store');
const { searchMemory, getRecentMemories, hydrateParentExcerpts } = await load('search');
const { applyReflectResult, applyReflectActions, listAllMemories } = await load('reflect');
const { runConsolidate, runAutoReflect, shouldAutoReflect } = await load('reflectDriver');
const { consolidate } = await load('consolidate');

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const P = 'anima-v123';
const gdb = DatabaseManager.getInstance(P);   // facts 恒在 general 库

// ── mock fetch：只允许 LLM 通道，任何 embedding 调用都算越界 ──
let reply = '';
let embedCalls = 0;
let lastPrompt = '';
let lastSystemPrompt = '';
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('embed')) { embedCalls++; throw new Error('unexpected embedding call: ' + u); }
  try {
    const body = JSON.parse(init?.body || '{}');
    lastSystemPrompt = body?.messages?.[0]?.content || '';
    lastPrompt = body?.messages?.[1]?.content || '';
  } catch { /* 非 JSON 请求体忽略 */ }
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }), { status: 200 });
};

const factRow = (s, p, o) => gdb.prepare('SELECT * FROM facts WHERE project=? AND subject=? AND predicate=? AND object=?').get(P, s, p, o);
const memDb = (id) => findDbByMemoryId(id, P).db;
const setMem = (id, sql, ...args) => memDb(id).prepare(sql).run(...args, id);
const memRow = (id) => memDb(id).prepare('SELECT * FROM memory WHERE id = ?').get(id);

// ══════════════════════════════════════════════════════════════
// 1) facts：功能性谓词失效 / 同批不互相失效 / 复写清空 valid_to
// ══════════════════════════════════════════════════════════════
await saveFacts([{ subject: 'user', predicate: '职业', object: '程序员', confidence: 0.9, evidence: '用户说自己是程序员' }], null, 'default', P);
let f1 = factRow('user', '职业', '程序员');
check(!!f1, 'fact inserted');
check(f1.valid_to == null, 'new fact is valid (valid_to NULL)');
// v1.27: valid_from 默认取写入时间 —— 否则"按时刻查有效事实"会把新事实算成历史任一时刻为真。
check(!!f1.valid_from && f1.valid_from >= '2020-01-01', 'new fact carries valid_from = write time');
check(f1.evidence === '用户说自己是程序员', 'evidence column persisted');

await saveFacts([{ subject: 'user', predicate: '职业', object: '设计师', confidence: 0.9 }], null, 'default', P);
const f1Old = factRow('user', '职业', '程序员');
const f2 = factRow('user', '职业', '设计师');
check(!!f1Old.valid_to, 'functional predicate conflict stamps old fact valid_to');
check(f2.valid_to == null, 'new functional value stays valid');
check(f1Old.is_active === 1, 'invalidated fact is kept (soft invalidation, not delete)');
check(f1Old.id === f1.id, 'same row kept (no duplicate insert)');

// 7a) 同批冲突不互相失效
await saveFacts([
  { subject: 'user', predicate: '姓名', object: '张三', confidence: 0.9 },
  { subject: 'user', predicate: '姓名', object: '李四', confidence: 0.9 },
], null, 'default', P);
const zs = factRow('user', '姓名', '张三');
const ls = factRow('user', '姓名', '李四');
check(!!zs && !!ls, 'both same-batch functional facts stored');
check(zs.valid_to == null && ls.valid_to == null, 'same-batch functional facts do not invalidate each other');

// 7b) 复写已失效的同一 SPO → valid_to 清空
await saveFacts([{ subject: 'user', predicate: '职业', object: '程序员', confidence: 0.95 }], null, 'default', P);
const f1Back = factRow('user', '职业', '程序员');
check(f1Back.valid_to == null || f1Back.valid_to === '', 'rewriting an invalidated SPO clears valid_to');
const design = factRow('user', '职业', '设计师');
check(!!design.valid_to, 'rewrite still invalidates the superseded functional value');

// 显式 validTo 不被清空
await saveFacts([{ subject: 'user', predicate: '昵称', object: '小张', confidence: 0.8, validTo: '2026-01-01T00:00:00.000Z' }], null, 'default', P);
check(String(factRow('user', '昵称', '小张').valid_to).includes('2026-01-01'), 'explicit validTo is respected');

// ══════════════════════════════════════════════════════════════
// 2) 冷存打标（含 ISO/SQLite 两种时间格式归一化）+ 检索回温
// ══════════════════════════════════════════════════════════════
const oldIso = new Date(Date.now() - 3 * 365 * 86400000).toISOString();
const coldOld = await saveMemory({ project: P, text: '冷存测试锚点：很久以前的一条低价值记录', tags: ['coldmark'], importance: 0.3 });
setMem(coldOld.id, 'UPDATE memory SET last_accessed_at = ? WHERE id = ?', oldIso);

// bug(c)：同一日期、SQLite 'YYYY-MM-DD HH:MM:SS' 格式、时刻晚于 cutoff → 不该被判冷
const cutoffMs = Date.now() - 60 * 86400000;
const cutoff = new Date(cutoffMs).toISOString();
const cutoffDate = cutoff.slice(0, 10);
let laterMs = cutoffMs + 6 * 3600 * 1000;
if (new Date(laterMs).toISOString().slice(0, 10) !== cutoffDate) laterMs = Date.parse(cutoffDate + 'T23:59:59.000Z');
if (laterMs <= cutoffMs) laterMs = cutoffMs + 1000;
const laterSqlite = new Date(laterMs).toISOString().slice(0, 10) + ' ' + new Date(laterMs).toISOString().slice(11, 19);
const sameDay = await saveMemory({ project: P, text: '同一天但时刻晚于 cutoff 的 SQLite 格式记录', tags: ['samedaymark'], importance: 0.3 });
setMem(sameDay.id, 'UPDATE memory SET last_accessed_at = ? WHERE id = ?', laterSqlite);

const keepCritical = await saveMemory({ project: P, text: '核心记忆不该冷存', importance: 0.2, tier: 'critical' });
setMem(keepCritical.id, 'UPDATE memory SET last_accessed_at = ? WHERE id = ?', oldIso);
const keepRef = await saveMemory({ project: P, text: '被引用过的记忆不该冷存', importance: 0.2 });
setMem(keepRef.id, 'UPDATE memory SET last_accessed_at = ?, reference_count = 1 WHERE id = ?', oldIso);
const keepImportant = await saveMemory({ project: P, text: '高重要度记忆不该冷存', importance: 0.9 });
setMem(keepImportant.id, 'UPDATE memory SET last_accessed_at = ? WHERE id = ?', oldIso);

const marked = markColdMemories(P);
check(marked >= 1, 'markColdMemories marked at least one memory (got ' + marked + ')');
check(memRow(coldOld.id).status === 'cold', 'old low-value memory became cold');
check(memRow(sameDay.id).status == null, 'SQLite-format recent timestamp is not misjudged (datetime normalization)');
check(memRow(keepCritical.id).status == null, 'critical memory is never cold');
check(memRow(keepRef.id).status == null, 'referenced memory is never cold');
check(memRow(keepImportant.id).status == null, 'important memory is never cold');

// 冷存仍可检索，且命中即回温
const thawHits = await searchMemory({ query: 'coldmark', topK: 10, minScore: 0, project: P });
check(thawHits.some(r => r.id === coldOld.id), 'cold memory is still retrievable');
check(memRow(coldOld.id).status == null, 'search hit thaws cold memory (status cleared)');

// ══════════════════════════════════════════════════════════════
// 3) superseded 不进检索（tag / text 两条路径都过滤）
// ══════════════════════════════════════════════════════════════
const sup = await saveMemory({ project: P, text: '被接管的旧记忆 suptag 内容', tags: ['suptag'], importance: 0.8 });
setMem(sup.id, "UPDATE memory SET status = 'superseded' WHERE id = ?");
const supHits = await searchMemory({ query: 'suptag', topK: 10, minScore: 0, project: P });
check(!supHits.some(r => r.id === sup.id), 'superseded memory is excluded from retrieval');

// ══════════════════════════════════════════════════════════════
// 4) 整合 invalidate 动作：只打 valid_to，只对 is_active=1 且 valid_to 为空
// ══════════════════════════════════════════════════════════════
await saveFacts([{ subject: 'user', predicate: '偏好饮料', object: '咖啡', confidence: 0.9 }], null, 'default', P);
const coffee = factRow('user', '偏好饮料', '咖啡');
reply = JSON.stringify([{ action: 'invalidate', factId: coffee.id, reason: '用户改喝无咖啡因' }]);
const cons1 = await runConsolidate('default', P, undefined, undefined, { force: true });
check(cons1.scanned >= 2, 'consolidate scanned window (got ' + cons1.scanned + ')');
check(cons1.invalidated === 1, 'invalidate action stamped exactly one fact (got ' + cons1.invalidated + ')');
check(!!factRow('user', '偏好饮料', '咖啡').valid_to, 'invalidated fact has valid_to');
const cons2 = await runConsolidate('default', P, undefined, undefined, { force: true });
check(cons2.invalidated === 0, 'already-invalidated fact is not stamped twice');

// ══════════════════════════════════════════════════════════════
// 5) Parent-Child 回捞：锚点窗口 / 整段 / 锚点失败=head / 检索带 parentId
// ══════════════════════════════════════════════════════════════
const anchorSentence = '锚点句：用户说把端口从 8080 改成了 9090，并且记下了路径 C:\\bank。';
const parentText = '【对话原文】' + '前'.repeat(2800) + anchorSentence + '后'.repeat(1200);
const parent1 = await saveMemory({ project: P, text: parentText, source: 'conversation_log', importance: 0.5 });
const leaf1 = await saveMemory({ project: P, text: anchorSentence, source: 'reflect_extract', tags: ['anchor-leaf'], importance: 0.6 });
const leaf2 = await saveMemory({ project: P, text: '另一条提炼：同一段对话里的第二个要点，用于测同父命中比例。', source: 'reflect_extract', importance: 0.6 });
setMem(leaf1.id, 'UPDATE memory SET parent_id = ? WHERE id = ?', parent1.id);
setMem(leaf2.id, 'UPDATE memory SET parent_id = ? WHERE id = ?', parent1.id);

const hydSingle = hydrateParentExcerpts(P, [{ id: leaf1.id, text: leaf1.text, parentId: parent1.id }]);
check(hydSingle.length === 1, 'parent hydrated for one leaf');
check(hydSingle[0].mode === 'excerpt', 'minority hit + long parent → excerpt (got ' + hydSingle[0].mode + ')');
check(hydSingle[0].excerpt.includes('9090'), 'excerpt contains the anchored sentence');
check(!hydSingle[0].excerpt.startsWith('【对话原文】'), 'excerpt is anchored, not truncated from head');
check(hydSingle[0].ratio === 0.5, 'ratio = hits / active leaves (got ' + hydSingle[0].ratio + ')');

const hydFull = hydrateParentExcerpts(P, [
  { id: leaf1.id, text: leaf1.text, parentId: parent1.id },
  { id: leaf2.id, text: leaf2.text, parentId: parent1.id },
]);
check(hydFull.length === 1 && hydFull[0].mode === 'full', 'majority hit → full parent (got ' + hydFull[0].mode + ')');
check(hydFull[0].excerpt.length > 1800, 'full mode returns the whole parent');

const parent2Text = '【另一段对话】' + '甲'.repeat(2500) + '结尾。';
const parent2 = await saveMemory({ project: P, text: parent2Text, source: 'conversation_log', importance: 0.5 });
const missLeaf = await saveMemory({ project: P, text: '这段文字完全不在父对话里，用来触发锚点失败分支。', source: 'reflect_extract', importance: 0.6 });
const missLeaf2 = await saveMemory({ project: P, text: '第二片叶子，仅用于把同父命中比压到 0.5。', source: 'reflect_extract', importance: 0.6 });
setMem(missLeaf.id, 'UPDATE memory SET parent_id = ? WHERE id = ?', parent2.id);
setMem(missLeaf2.id, 'UPDATE memory SET parent_id = ? WHERE id = ?', parent2.id);
const hydHead = hydrateParentExcerpts(P, [{ id: missLeaf.id, text: missLeaf.text, parentId: parent2.id }]);
check(hydHead.length === 1 && hydHead[0].mode === 'head', 'anchor miss → fallback head (got ' + hydHead[0].mode + ')');
check(hydHead[0].excerpt.startsWith('【另一段对话】'), 'head fallback starts from parent head');
check(hydrateParentExcerpts(P, [{ id: leaf1.id, text: leaf1.text, parentId: null }]).length === 0, 'leaf without parentId is skipped');

const leafHits = await searchMemory({ query: 'anchor-leaf', topK: 10, minScore: 0, project: P });
const hitLeaf = leafHits.find(r => r.id === leaf1.id);
check(!!hitLeaf && hitLeaf.parentId === parent1.id, 'SearchResult carries parentId');

// ══════════════════════════════════════════════════════════════
// 6) hardFacts 落库：extract 跨分类库时 source_memory_id 必须为 NULL
// ══════════════════════════════════════════════════════════════
const srcA = await saveMemory({ project: P, text: '源对话：用户说服务器是 10.0.0.5，端口 9090。', source: 'conversation_log', importance: 0.4 });
const resA = await applyReflectResult({
  summary: '', highlights: [], facts: [], insights: [],
  actions: [{
    action: 'extract', sourceId: srcA.id, newText: '服务器 10.0.0.5 端口 9090', newMemType: 'project',
    hardFacts: [
      { subject: 'server', predicate: 'ip', object: '10.0.0.5', confidence: 0.9, evidence: '用户说服务器是 10.0.0.5' },
      { subject: 'server', predicate: '端口', object: '9090', confidence: 0.8 },
    ],
  }],
}, 'default', P, { allowedSourceIds: new Set([srcA.id]) });
check(resA.actionsApplied === 1, 'extract action applied with hardFacts');
const hfIp = gdb.prepare('SELECT * FROM facts WHERE project=? AND subject=? AND predicate=?').get(P, 'server', 'ip');
check(!!hfIp, 'hardFacts landed in facts table');
check(hfIp.source_memory_id === null, 'cross-library hardFact keeps source_memory_id NULL (no FK blowup)');
check(hfIp.evidence === '用户说服务器是 10.0.0.5', 'hardFact evidence stored');
const hfPort = gdb.prepare('SELECT * FROM facts WHERE project=? AND subject=? AND predicate=?').get(P, 'server', '端口');
check(!!hfPort && hfPort.source_memory_id === null, 'second hardFact also has NULL source');

// 同库（general）extract 也保持 NULL —— 不挂跨库 id 是硬约束
const srcB = await saveMemory({ project: P, text: '源对话二：用户说项目代号是 bluebird-7。', source: 'conversation_log', importance: 0.4 });
await applyReflectResult({
  summary: '', highlights: [], facts: [], insights: [],
  actions: [{ action: 'extract', sourceId: srcB.id, newText: '项目代号 bluebird-7', hardFacts: [{ subject: 'project', predicate: '代号', object: 'bluebird-7', confidence: 0.8 }] }],
}, 'default', P, { allowedSourceIds: new Set([srcB.id]) });
const hfCodename = gdb.prepare('SELECT * FROM facts WHERE project=? AND subject=? AND predicate=?').get(P, 'project', '代号');
check(!!hfCodename && hfCodename.source_memory_id === null, 'general-lib extract also stores NULL source_memory_id');
// extract 记忆本身仍挂 parent_id（leaf → 对话原文），与 facts 的 source_memory_id 是两件事
const extractRow = gdb.prepare("SELECT id, parent_id FROM memory WHERE project=? AND source='reflect_extract' AND text LIKE '%bluebird-7%'").get(P);
check(!!extractRow && extractRow.parent_id === srcB.id, 'extract leaf points back to its source via parent_id');

// ══════════════════════════════════════════════════════════════
// 7) 证据附录 + linkedMemoryIds（接管旧记忆但不覆盖）
// ══════════════════════════════════════════════════════════════
const srcC = await saveMemory({ project: P, text: '配置写在 C:\\bank\\config.json，端口 9090，版本 1.23.4。', source: 'conversation_log', importance: 0.4 });
const resC = await applyReflectResult({
  summary: '', highlights: [], facts: [], insights: [],
  actions: [{ action: 'extract', sourceId: srcC.id, newText: '配置已完成', newMemType: 'project' }],
}, 'default', P, { allowedSourceIds: new Set([srcC.id]) });
check((resC.warnings || []).some(w => w.includes('证据附录')), 'low hard-fact coverage emits an evidence-appendix warning');
const appendixRow = DatabaseManager.queryAll(P, "SELECT text FROM memory WHERE project=? AND source='reflect_extract' AND text LIKE '%证据附录%'", [P])[0];
check(!!appendixRow && appendixRow.text.includes('9090'), 'evidence appendix appends the missing original sentence');

const oldMemory = await saveMemory({ project: P, text: '旧版的端口说明，等待被新提取接管。', importance: 0.6 });
const lockedMemory = await saveMemory({ project: P, text: '被锁定的记忆不该被接管。', importance: 0.6 });
setMem(lockedMemory.id, 'UPDATE memory SET locked = 1 WHERE id = ?');
const srcD = await saveMemory({ project: P, text: '源对话：端口已从 8080 改为 9090。', source: 'conversation_log', importance: 0.4 });
const resD = await applyReflectResult({
  summary: '', highlights: [], facts: [], insights: [],
  actions: [{ action: 'extract', sourceId: srcD.id, newText: '端口改为 9090', linkedMemoryIds: [oldMemory.id, lockedMemory.id] }],
}, 'default', P, { allowedSourceIds: new Set([srcD.id]) });
check(resD.actionsApplied === 1, 'extract with linkedMemoryIds applied');
const oldRow = memRow(oldMemory.id);
check(oldRow.status === 'superseded', 'linked memory is superseded, not deleted');
check(oldRow.is_active === 1, 'linked memory keeps its data (soft takeover)');
check(Array.isArray(JSON.parse(oldRow.metadata || '{}').supersededBy) && JSON.parse(oldRow.metadata || '{}').supersededBy.length === 1, 'metadata.supersededBy records the new extract id');
check(memRow(lockedMemory.id).status == null, 'locked target is not superseded');

// ══════════════════════════════════════════════════════════════
// 8) 整合窗口轮转：top300 + 最久 200 各自保底，总数 ≤500
//    （Full 现网实现先合并再按 importance 截断，会把"最久 200"整片丢掉）
// ══════════════════════════════════════════════════════════════
const headIds = [];
for (let i = 0; i < 400; i++) {
  const m = await saveMemory({ project: P, text: '窗口头部记忆 #' + i + ' hhhhhhhhhh', importance: 0.9 });
  headIds.push(m.id);
}
const tailIds = [];
const staleAt = new Date(Date.now() - 400 * 86400000).toISOString();
for (let i = 0; i < 200; i++) {
  const m = await saveMemory({ project: P, text: '窗口最久记忆 #' + i + ' tttttttttt', importance: 0.2 });
  setMem(m.id, 'UPDATE memory SET created_at = ?, updated_at = ? WHERE id = ?', staleAt, staleAt);
  tailIds.push(m.id);
}
reply = '[]';
const win = await runConsolidate('default', P, undefined, undefined, { force: true });
check(win.scanned === 500, 'window is capped at 500 (got ' + win.scanned + ')');
check(tailIds.every(id => lastPrompt.includes(id)), 'all 200 oldest memories survive the 500 cap');
check(headIds.filter(id => lastPrompt.includes(id)).length === 300, 'window head keeps exactly the top 300 by importance');
check(lastPrompt.includes('【现有事实'), 'consolidation prompt includes the existing-facts section');

// ══════════════════════════════════════════════════════════════
// 9) 整合模式：放行 merge（merged===1）、拒绝 extract（不净增记忆）、丢弃 delete
// ══════════════════════════════════════════════════════════════
const mergeA = tailIds[0];
const mergeB = tailIds[1];
reply = JSON.stringify([{ action: 'merge', sourceIds: [mergeA, mergeB], newText: '整合后的合并记忆：两条窗口最久记忆归并。', newMemType: 'feedback' }]);
const consMerge = await runConsolidate('default', P, undefined, undefined, { force: true });
check(consMerge.merged === 1, 'consolidation mode allows merge (merged=' + consMerge.merged + ', errors=' + JSON.stringify(consMerge.errors) + ')');
check(memRow(mergeA).is_active === 0 && memRow(mergeB).is_active === 0, 'merge soft-deletes both sources (rows kept)');
const mergedRow = DatabaseManager.queryAll(P, "SELECT id, text FROM memory WHERE project=? AND text LIKE '%整合后的合并记忆%'", [P])[0];
check(!!mergedRow, 'merged memory landed');

const countActive = () => DatabaseManager.queryAll(P, 'SELECT COUNT(*) c FROM memory WHERE project=? AND is_active=1', [P])
  .reduce((n, r) => n + (Number(r.c) || 0), 0);
const activeBeforeExtract = countActive();
reply = JSON.stringify([{ action: 'extract', sourceId: tailIds[2], newText: '整合里不该出现的净增记忆。', newMemType: 'project' }]);
const consExtract = await runConsolidate('default', P, undefined, undefined, { force: true });
check((consExtract.errors || []).some(e => e.includes('extract')), 'extract is rejected as a consolidation action');
check(consExtract.applied === 0 && consExtract.merged === 0, 'rejected extract applies nothing');
check(countActive() === activeBeforeExtract, 'rejected extract writes no new memory');

reply = JSON.stringify([{ action: 'delete', id: tailIds[3] }]);
const consDelete = await runConsolidate('default', P, undefined, undefined, { force: true });
check(consDelete.deleted === 0 && memRow(tailIds[3]).is_active === 1, 'delete is dropped by Anima fidelity (no deletion)');

// ══════════════════════════════════════════════════════════════
// 10) 整合系统提示词 = 整合任务 + 保真约束段；反思段仍然禁 merge
// ══════════════════════════════════════════════════════════════
check(lastSystemPrompt.includes('记忆整合引擎'), 'consolidation system prompt stays a consolidation task');
check(!lastSystemPrompt.includes('不允许 merge/delete/split'), 'consolidation prompt no longer forbids merge');
check(lastSystemPrompt.includes('整合只允许 merge'), 'consolidation fidelity block is appended');
const refused = await applyReflectActions(
  [{ action: 'merge', sourceIds: [headIds[2], headIds[3]], newText: '反思段不该合并的记忆' }],
  'default', P, { automatic: true, allowedSourceIds: new Set([headIds[2], headIds[3]]) },
);
check(refused.receipts[0]?.status === 'failed', 'reflection mode (no consolidation flag) still blocks merge');
check((refused.errors || []).some(e => e.includes('emotional fidelity')), 'reflection merge refusal keeps the emotional-fidelity error');
check(memRow(headIds[2]).is_active === 1 && memRow(headIds[3]).is_active === 1, 'refused merge leaves sources untouched');

// ══════════════════════════════════════════════════════════════
// 11) 近期记忆 / 深反思扫描不再返回 superseded（深反思还排除 cold）
// ══════════════════════════════════════════════════════════════
const recentMem = await saveMemory({ project: P, text: '近期注入测试：这条应出现在近期记忆里。', characterId: 'default', importance: 0.95 });
check(getRecentMemories('default', 10, 48, P).some(m => m.id === recentMem.id), 'getRecentMemories returns an active memory');
setMem(recentMem.id, "UPDATE memory SET status = 'superseded' WHERE id = ?");
check(!getRecentMemories('default', 10, 48, P).some(m => m.id === recentMem.id), 'getRecentMemories drops superseded memories');

const coldScan = await saveMemory({ project: P, text: '深反思扫描测试：这条该被冷存排除。', importance: 0.2 });
setMem(coldScan.id, 'UPDATE memory SET last_accessed_at = ? WHERE id = ?', new Date(Date.now() - 400 * 86400000).toISOString());
markColdMemories(P);
check(memRow(coldScan.id).status === 'cold', 'cold scan memory marked cold');
const listed = listAllMemories('default', 4000, P).map(m => m.id);
check(!listed.includes(coldScan.id), 'listAllMemories skips cold memories');
check(!listed.includes(sup.id), 'listAllMemories skips superseded memories');

// ══════════════════════════════════════════════════════════════
// 12) 反思失败退避：失败后 1h 内不自动重试，显式调用可跑通并清除退避
// ══════════════════════════════════════════════════════════════
{
  const BP = 'anima-backoff';
  const src = await saveMemory({ project: BP, text: '退避验证用来源：端口 3318。', memType: 'general', source: 'conversation_log' });
  const srcId = 'backoff-src';
  // is_active=1：2026-10-29 起软删的对话不再作为抽取来源，软删这里会得到「无未分析对话」(ok:true/skipped)，
  // 于是一个**该失败**的反思被当成成功，退避也就测不到。
  findDbByMemoryId(src.id, BP).db
    .prepare("UPDATE memory SET id=?, is_active=1, created_at='2026-01-01T00:00:00.000Z' WHERE id=?")
    .run(srcId, src.id);
  reply = '{"summary":"partial","actions":[';
  const failed = await runAutoReflect('default', 10, BP);
  check(!failed.ok, 'failed reflection is recorded as a failure');
  const cond1 = shouldAutoReflect('default', BP);
  check(cond1.should === false && /退避/.test(cond1.reason), 'auto reflection backs off after a failure: ' + JSON.stringify(cond1));
  reply = JSON.stringify({ processedSourceIds: [srcId], summary: '退避验证', facts: [], insights: [], actions: [{ action: 'extract', sourceId: srcId, newText: '退避验证提取 3318', newMemType: 'project', newCategory: 'context' }] });
  const okRun = await runAutoReflect('default', 10, BP);
  check(okRun.ok, 'an explicit retry still runs (tool call bypasses backoff): ' + JSON.stringify(okRun));
  const cond2 = shouldAutoReflect('default', BP);
  check(!/退避/.test(cond2.reason), 'a successful run clears the backoff: ' + JSON.stringify(cond2));
}

// ══════════════════════════════════════════════════════════════
// 13) 读侧只返回当前有效事实 + identity_locked 删除保护
// ══════════════════════════════════════════════════════════════
await saveFacts([{ subject: 'user', predicate: '居住地', object: '北京', confidence: 0.9 }], null, 'default', P);
await saveFacts([{ subject: 'user', predicate: '居住地', object: '上海', confidence: 0.9 }], null, 'default', P);
const currentHome = getFactsBySubject('user', undefined, P).filter(f => f.predicate === '居住地');
check(currentHome.length === 1 && currentHome[0].object === '上海',
  'fact read path hides invalidated values: ' + JSON.stringify(currentHome.map(f => f.object)));
const lockMem = await saveMemory({ project: P, text: '身份锁删除保护测试' });
setMem(lockMem.id, 'UPDATE memory SET identity_locked = 1 WHERE id = ?');
const delRes = await applyReflectActions([{ action: 'delete', targetId: lockMem.id }], 'default', P,
  { allowedSourceIds: new Set([lockMem.id]) });
check(delRes.receipts[0]?.status === 'failed' && memRow(lockMem.id).is_active === 1,
  'identity-locked memory cannot be deleted by reflection');

// ══════════════════════════════════════════════════════════════
// 14) 脏 tags 不炸检索 + 情绪值 clamp
// ══════════════════════════════════════════════════════════════
const dirty = await saveMemory({ project: P, text: '脏 tags 检索测试 3318', tags: ['正常'] });
memDb(dirty.id).prepare("UPDATE memory SET tags='不是JSON,逗号串' WHERE id=?").run(dirty.id);
const dirtyHits = await searchMemory({ query: '脏 tags 检索', topK: 5, project: P });
check(dirtyHits.some(h => h.id === dirty.id), 'a row with non-JSON tags does not break search');
const over = await saveMemory({ project: P, text: '情绪上限 clamp 测试', emotionalImpact: 99 });
check(Number(memRow(over.id).emotional_impact) <= 10, 'emotionalImpact is clamped to the 0-10 range');

// ══════════════════════════════════════════════════════════════
// 15) 衰减幂等：重复 consolidate 不再按运行次数叠加衰减
// ══════════════════════════════════════════════════════════════
{
  const old = new Date(Date.now() - 61 * 86400000).toISOString();
  const dec = await saveMemory({ project: P, text: '衰减幂等 3318', importance: 0.9 });
  memDb(dec.id).prepare('UPDATE memory SET base_importance=0.9, importance=0.9, last_accessed_at=?, created_at=? WHERE id=?').run(old, old, dec.id);
  await consolidate();
  const a = Number(memRow(dec.id).importance);
  await consolidate();
  const b = Number(memRow(dec.id).importance);
  check(Math.abs(a - b) < 1e-9, `repeated consolidation is idempotent (${a} vs ${b})`);
}

check(embedCalls === 0, 'no embedding/network calls were made');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, embedCalls, productionWrites: 0 }));
