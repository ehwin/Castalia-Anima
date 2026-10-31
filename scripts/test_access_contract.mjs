/**
 * 访问记账契约回归（2026-10-31）。
 *
 * 对应审计 `docs/research/anima-paper-feasibility-2026-10-31.md` §4.1：
 *   1) accessChannel:'diagnostic' 的诊断读取不该改变记忆权重（shouldReinforce 从未被执行）
 *   2) 标签快速路径把请求的 explicit_recall 记成 'search'
 *
 * 跑法：node --test scripts/test_access_contract.mjs（需先 npm run build）
 * 用临时 MEMORY_DB_DIR，不碰任何真实库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['db.js', 'search.js', 'emotionalRanking.js']) {
  if (!fs.existsSync(path.join(root, 'dist', name))) {
    console.error(`[access-contract] dist/${name} missing; run npm run build first`);
    process.exit(2);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-access-'));
process.env.MEMORY_DB_DIR = path.join(tmp, 'bank');
delete process.env.MEMORY_DB_PATH;
process.env.MEMORY_CONFIG = path.join(tmp, 'missing-config.json');
process.env.EMBED_MODE = 'none';
process.env.CHAR_ID = 'acctest';
process.env.CASTALIA_PROJECT = 'acctest';
process.env.CONSOLIDATE_AUTO_ON_START = '0';
process.env.REFLECT_INTERVAL_HOURS = '0';

const load = name => import(pathToFileURL(path.join(root, 'dist', `${name}.js`)).href);
const { DatabaseManager } = await load('db');
const { searchMemory, getAccessStats } = await load('search');
const { shouldCountAccess, shouldReinforce } = await load('emotionalRanking');

const db = DatabaseManager.getInstance('acctest', 'general');
const OLD = new Date(Date.now() - 30 * 86400000).toISOString();
db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
  character_id,source,created_at,updated_at,last_accessed_at,accessed_count)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'probe-memory', '咖啡偏好记录：用户明确表示只接受无糖咖啡，不能加糖。',
  'acctest', 'episodic', 'general', 'conversation', '[]', 0.5,
  'acctest', 'conversation_log', OLD, OLD, OLD, 0,
);

const base = { query: '咖啡', project: 'acctest', characterId: 'acctest', topK: 1, minScore: 0 };
const snapshot = () => ({
  row: db.prepare('SELECT accessed_count, last_accessed_at, status FROM memory WHERE id=?').get('probe-memory'),
  logs: db.prepare('SELECT channel, COUNT(*) AS rows FROM memory_access_log GROUP BY channel').all(),
});
const reset = (tags = '[]') => {
  db.prepare('UPDATE memory SET accessed_count=0, last_accessed_at=?, tags=? WHERE id=?').run(OLD, tags, 'probe-memory');
  db.exec('DELETE FROM memory_access_log');
};

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
};

// ── 契约谓词 ──
await check('shouldCountAccess blocks internal channels only', () => {
  for (const ch of ['diagnostic', 'injection', 'internal', 'reflection', 'self_cycle', 'maintenance', 'audit', 'test']) {
    assert.equal(shouldCountAccess(ch), false, `${ch} must not write access`);
  }
  for (const ch of ['search', 'explicit_recall', 'user_reference', 'user_repeat', '']) {
    assert.equal(shouldCountAccess(ch), true, `${ch} must still write access`);
  }
  // 白名单仍然只表达"算强化支持"，与执行口径分开
  assert.equal(shouldReinforce('diagnostic'), false);
  assert.equal(shouldReinforce('explicit_recall'), true);
});

// ── 1. 只读检索不写 ──
await check('countAccess:false leaves the row and the log untouched', async () => {
  reset();
  const before = snapshot();
  await searchMemory({ ...base, countAccess: false });
  assert.deepEqual(snapshot(), before);
});

// ── 2. 诊断读取不改变权重（审计 §4.1 的核心缺陷）──
await check('diagnostic reads do not increment access or write a log row', async () => {
  reset();
  const stats0 = getAccessStats();
  const before = snapshot();
  const during = (await searchMemory({ ...base, accessChannel: 'diagnostic' }))[0];
  const after = snapshot();
  assert.equal(after.row.accessed_count, 0, 'diagnostic must not bump accessed_count');
  assert.equal(after.row.last_accessed_at, before.row.last_accessed_at, 'diagnostic must not refresh last_accessed_at');
  assert.deepEqual(after.logs, [], 'diagnostic must not write memory_access_log');
  assert.ok(getAccessStats().suppressed > stats0.suppressed, 'suppression must be observable via getAccessStats()');
  // 同一查询在不同条件下分数必须一致（不再被自己的诊断读取抬高）
  const clean = (await searchMemory({ ...base, countAccess: false }))[0];
  assert.equal(during?.score, clean?.score, 'diagnostic read must not change the score it just measured');
  assert.equal(during?.salience, clean?.salience);
});

// ── 3. 真正的显式回忆仍然记账 ──
await check('explicit_recall still counts and logs under its own channel', async () => {
  reset();
  await searchMemory({ ...base, accessChannel: 'explicit_recall' });
  const s = snapshot();
  assert.equal(s.row.accessed_count, 1);
  assert.deepEqual(s.logs, [{ channel: 'explicit_recall', rows: 1 }]);
});

// ── 4. 标签快速路径保留渠道（审计 §4.1 第二处）──
await check('tag fast path records the requested channel, not "search"', async () => {
  reset('["咖啡"]');
  await searchMemory({ ...base, accessChannel: 'explicit_recall' });
  const s = snapshot();
  assert.equal(s.row.accessed_count, 1, 'tag fast path must still count');
  assert.deepEqual(s.logs, [{ channel: 'explicit_recall', rows: 1 }], 'requested channel must survive the fast path');
  reset('["咖啡"]');
  await searchMemory({ ...base, accessChannel: 'diagnostic' });
  const d = snapshot();
  assert.equal(d.row.accessed_count, 0, 'internal channel must be suppressed on the tag path too');
  assert.deepEqual(d.logs, []);
});

if (failures) { console.error(`\n[access-contract] ${failures} failed`); process.exit(1); }
console.log('\n[access-contract] all checks passed');
db.close();
