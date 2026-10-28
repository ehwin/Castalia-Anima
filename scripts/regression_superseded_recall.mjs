// v1.28 检索层回归：被接管的旧记忆「默认不返回 / 回指时带标记降权返回」+ 时间衰减锚点。
// 纯离线：临时库 + EMBED_MODE=none（走标签 + 文本回退，无向量，结果确定）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-recall-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({}));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp, MEMORY_CONFIG: config,
  CHAR_ID: 'airi', EMBED_MODE: 'none',
});

const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager } = await load('db');
const { saveMemory, findDbByMemoryId } = await load('store');
const { searchMemory, isBackReferenceQuery, SUPERSEDED_PENALTY } = await load('search');

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, `${message} (期望 ${expected}，实际 ${actual})`);
  checks++;
};

const project = 'anima-recall';
const OLD_TEXT = '她说她住在杭州，租房在西湖边';
const NEW_TEXT = '她搬到上海了，杭州的房子已经退租';

// ── 0. 判据本身 ───────────────────────────────────────────────────────────
check(isBackReferenceQuery('我以前说过什么'), '以前 → 回指');
check(isBackReferenceQuery('上次那个计划呢'), '上次 → 回指');
check(isBackReferenceQuery('did you forget what I said before'), 'before/i said → 回指');
check(!isBackReferenceQuery('今天天气怎么样'), '普通查询不是回指');
check(!isBackReferenceQuery(''), '空查询不是回指');

// ── 1. 造一对「旧记忆被新记忆接管」────────────────────────────────────────
const older = await saveMemory({ project, text: OLD_TEXT, memType: 'general', source: 'conversation_log', importance: 0.8 });
const newer = await saveMemory({ project, text: NEW_TEXT, memType: 'general', source: 'conversation_log', importance: 0.8 });
// 复刻 reflect.ts 的接管写法（v1.23）：metadata.supersededBy + status='superseded'
const db = findDbByMemoryId(older.id, project).db;
db.prepare("UPDATE memory SET status='superseded', metadata=? WHERE id=?")
  .run(JSON.stringify({ supersededBy: [newer.id] }), older.id);
eq(db.prepare("SELECT status FROM memory WHERE id=?").get(older.id).status, 'superseded', '旧记忆已标记被接管');

// ── 2. 普通查询：被接管的旧记忆不返回（避免与接管它的新记忆重复讲同一段历史）──
let hits = await searchMemory({ query: '杭州 近况', project, topK: 5 });
let ids = hits.map(h => h.id);
check(!ids.includes(older.id), '普通查询不返回被接管的旧记忆');
check(ids.includes(newer.id), '普通查询返回当前有效的记忆');

// ── 3. 回指查询：旧的带标记 + 降权返回 ────────────────────────────────────
hits = await searchMemory({ query: '以前的居住地 杭州', project, topK: 5 });
const oldHit = hits.find(h => h.id === older.id);
const newHit = hits.find(h => h.id === newer.id);
check(!!oldHit, '回指查询把被接管的旧记忆召回');
eq(oldHit.superseded, true, '旧记忆带 superseded 标记');
check(Array.isArray(oldHit.supersededBy) && oldHit.supersededBy.includes(newer.id),
  'supersededBy 指向接管它的记忆');
eq(oldHit.text, OLD_TEXT, '旧记忆原文仍在（不删除，可解释"我以前说过…"）');
if (newHit && oldHit) {
  check(oldHit.score < newHit.score, `旧记忆被降权（${oldHit.score} < ${newHit.score}）`);
  check(SUPERSEDED_PENALTY === 0.6, '降权系数是 0.6');
}
check(hits.every(h => h.superseded !== true || h.supersededBy !== undefined),
  '凡带 superseded 标记的都带 supersededBy（不产生半截标记）');

// ── 4. 时间衰减锚点：回忆刷新时钟 ─────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();
const fresh = await saveMemory({ project, text: '她昨天提到过灯塔与旧船票，说想去看看', memType: 'general', importance: 0.8 });
const stale = await saveMemory({ project, text: '她昨天提到过灯塔与旧船票，记在了小本子上', memType: 'general', importance: 0.8 });
check(fresh.id !== stale.id, '两条是不同行（同文本会被去重合并）');
// 两条都在 200 天前写下；区别只在「有没有被回忆过」（last_accessed_at）
db.prepare('UPDATE memory SET created_at=?, last_accessed_at=? WHERE id=?').run(ago(200), ago(200), stale.id);
db.prepare('UPDATE memory SET created_at=?, last_accessed_at=? WHERE id=?').run(ago(200), ago(1 / 24), fresh.id);

hits = await searchMemory({ query: '灯塔 旧船票', project, topK: 5 });
const freshHit = hits.find(h => h.id === fresh.id);
const staleHit = hits.find(h => h.id === stale.id);
check(!!freshHit && !!staleHit, '两条都返回（同一文本、同一重要度）');
check(freshHit.score > staleHit.score,
  `刚被回忆过的记忆分数更高（${freshHit.score} > ${staleHit.score}）—— 衰减锚点不是 created_at`);

// ── 5. 稳定性：同一查询连跑两次，结果 id 一致（无随机、无跨请求污染）────────
const again = await searchMemory({ query: '杭州 近况', project, topK: 5 });
eq(again.map(h => h.id).join(','), ids.join(','), '同一查询结果稳定');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, productionWrites: 0 }));
