/**
 * 派生证据不构成独立支持（2026-10-31）。
 *
 * 对应审计 `docs/research/anima-paper-feasibility-2026-10-31.md` §5：
 *   第 3 项 `bias.ts` 冷启动回填用当前时间 recordTopics → 重启让旧兴趣"变新"
 *   第 4 项 重复写入抬 reference_count，consolidate 据 >2 提重要度 → 内部重复被当独立证据
 *
 * 跑法：node --test scripts/test_derived_evidence.mjs（需先 npm run build）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['db.js', 'bias.js', 'store.js']) {
  if (!fs.existsSync(path.join(root, 'dist', name))) {
    console.error(`[derived-evidence] dist/${name} missing; run npm run build first`);
    process.exit(2);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-derived-'));
process.env.MEMORY_DB_DIR = path.join(tmp, 'bank');
delete process.env.MEMORY_DB_PATH;
process.env.MEMORY_CONFIG = path.join(tmp, 'missing-config.json');
process.env.EMBED_MODE = 'none';
process.env.CHAR_ID = 'derivedtest';
process.env.CASTALIA_PROJECT = 'derivedproj';
process.env.CONSOLIDATE_AUTO_ON_START = '0';
process.env.REFLECT_INTERVAL_HOURS = '0';

const load = name => import(pathToFileURL(path.join(root, 'dist', `${name}.js`)).href);
const { DatabaseManager } = await load('db');
const { loadBiasesFromDb, getBiases } = await load('bias');
const { saveMemory } = await load('store');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
};

const PROJ = 'derivedproj';
const db = DatabaseManager.getInstance(PROJ, 'general');
const DAYS = d => new Date(Date.now() - d * 86400000).toISOString();

// ── 第 3 项：冷启动回填必须用标签当年被记下的时间 ──
await check('cold-start bias backfill uses the memory time, not the process start time', () => {
  db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
    character_id,source,created_at,updated_at,last_accessed_at,accessed_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'old-topic', '三个月前聊过一次咖啡。', PROJ, 'episodic', 'general', 'conversation',
    '["咖啡"]', 0.5, 'biascold', 'conversation_log', DAYS(90), DAYS(90), DAYS(90), 0,
  );
  loadBiasesFromDb('biascold', PROJ);
  const old = getBiases('biascold', 10, PROJ).find(t => t.topic === '咖啡');
  // 旧行为：lastSeen=进程启动时间 → 权重约 1.0（"刚刚又提了一次"）。
  // 新行为：lastSeen=90 天前 → 衰减到 0.3 以下（可能已被裁剪）。
  assert.ok(!old || old.weight < 0.3, `90-day-old topic came back at weight ${old?.weight}`);
});

await check('a tag from today still registers as a fresh topic', () => {
  db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
    character_id,source,created_at,updated_at,last_accessed_at,accessed_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'new-topic', '今天又聊到咖啡了。', PROJ, 'episodic', 'general', 'conversation',
    '["咖啡"]', 0.5, 'biasfresh', 'conversation_log', DAYS(0), DAYS(0), DAYS(0), 0,
  );
  loadBiasesFromDb('biasfresh', PROJ);
  const topics = getBiases('biasfresh', 10, PROJ).map(t => t.topic);
  assert.equal(topics.includes('咖啡'), true, 'a topic discussed today must be registered');
});

// ── 第 4 项：内部重复不抬 reference_count ──
const TEXT = '用户明确表示只喝无糖咖啡。';
const refCount = id => {
  const row = db.prepare('SELECT reference_count, metadata FROM memory WHERE id = ?').get(id);
  return { count: Number(row?.reference_count ?? -1), metadata: String(row?.metadata ?? '') };
};

await check('external repeat writes still count as independent references', async () => {
  const first = await saveMemory({ text: TEXT, project: PROJ, characterId: 'reftest', source: 'conversation_log' });
  await saveMemory({ text: TEXT, project: PROJ, characterId: 'reftest', source: 'conversation_log' });
  assert.equal(refCount(first.id).count, 1, 'two external mentions = one extra reference');
});

await check('a reflection re-writing the same text does NOT add an independent reference', async () => {
  const before = refCount((await saveMemory({ text: TEXT, project: PROJ, characterId: 'reftest', source: 'conversation_log' })).id);
  const same = await saveMemory({ text: TEXT, project: PROJ, characterId: 'reftest', source: 'reflect_insight' });
  const after = refCount(same.id);
  assert.equal(after.count, before.count, 'derived rewrite must not inflate reference_count');
  assert.match(after.metadata, /derivedRewrites/, 'the rewrite should still be recorded for diagnostics');
});

if (failures) { console.error(`\n[derived-evidence] ${failures} failed`); process.exit(1); }
console.log('\n[derived-evidence] all checks passed');
db.close();
