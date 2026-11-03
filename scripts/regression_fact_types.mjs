// 事实类型回归：事实路不能再把"角色设定 / 行为归纳"统一写成"已经确认过的稳定事实"。
// 纯离线：临时库 + 直接调用 dist 里的 saveFacts / recallFactsForQuery，不调 LLM、不算向量。
// 跑法：node scripts/regression_fact_types.mjs            （默认读 ./dist）
//       node scripts/regression_fact_types.mjs ./dist     （显式指定构建目录）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'store.js')) ? root : path.join(root, 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-fact-types-'));
const project = 'fact-types';

Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: project,
  CHAR_ID: 'airi',
});

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

const store = await import(pathToFileURL(path.join(distRoot, 'store.js')).href);
const { DatabaseManager } = await import(pathToFileURL(path.join(distRoot, 'db.js')).href);
const factType = await import(pathToFileURL(path.join(distRoot, 'factType.js')).href);
const { recallFactsForQuery } = await import(pathToFileURL(path.join(distRoot, 'factRecall.js')).href);

// ── 1. 纯规则：类型判定本身 ────────────────────────────────────────────────
const { classifyFactType } = factType;
const cases = [
  [{ subject: 'user', predicate: '姓名', object: '小托' }, 'user_fact', '用户现实陈述 → user_fact'],
  [{ subject: 'user', predicate: '健康事件', object: '7月拔牙' }, 'user_fact', '健康事件 → user_fact'],
  [{ subject: 'user', predicate: '习惯', object: '熬夜折腾技术' }, 'hypothesis', '行为归纳（习惯）→ hypothesis'],
  [{ subject: 'user', predicate: '社交模式', object: '需要陪伴欲望时强时弱' }, 'hypothesis', '行为归纳（社交模式）→ hypothesis'],
  [{ subject: 'agent', predicate: '身份', object: '七丘四方殿谕女，预言能力最强' }, 'canon', '角色设定 → canon'],
  [{ subject: 'agent', predicate: '习惯', object: '深夜陪伴聊天' }, 'canon', '角色的行为也要按设定算 → canon'],
  [{ subject: 'environment', predicate: '项目', object: '七丘世界存在黑潮灾难' }, 'canon', '世界设定 → canon'],
  [{ subject: 'agent', predicate: '具备能力', object: '能读取并描述用户屏幕内容' }, 'meta', '角色主语的实现/能力 → meta'],
  [{ subject: 'environment', predicate: '端口', object: '桥 3310' }, 'meta', '环境侧纯技术谓词 → meta'],
  [{ subject: 'user', predicate: '姓名', object: '小托', source: 'agent_diary' }, 'hypothesis', '日记来源即使写主语也是推测'],
  [{ subject: 'someone', predicate: '姓名', object: '???' }, 'unknown', '未知主语 → unknown'],
  [{ subject: '', predicate: '姓名', object: 'x' }, 'unknown', '空主语 → unknown'],
];
for (const [input, expected, message] of cases) {
  assert.equal(classifyFactType(input), expected, `${message}（期望 ${expected}，实际 ${classifyFactType(input)}）`);
  checks++;
}

// ── 2. 写入点：saveFacts 落 fact_type ─────────────────────────────────────
const saved = await store.saveFacts([
  { subject: 'agent', predicate: '身份', object: '七丘四方殿谕女，预言能力最强', confidence: 0.95 },
  { subject: 'user', predicate: '姓名', object: '小托', confidence: 0.9 },
  { subject: 'user', predicate: '习惯', object: '熬夜折腾技术', confidence: 0.7 },
], null, 'airi', project);
assert.deepEqual(saved, { inserted: 3, updated: 0 }, '三条事实写入');

const generalDb = DatabaseManager.getInstance(project, 'general');
const rows = generalDb.prepare('SELECT subject, predicate, fact_type FROM facts ORDER BY predicate').all();
const typeOf = (subject, predicate) => rows.find(r => r.subject === subject && r.predicate === predicate)?.fact_type;
assert.equal(typeOf('agent', '身份'), 'canon', '设定落 canon');
assert.equal(typeOf('user', '姓名'), 'user_fact', '用户陈述落 user_fact');
assert.equal(typeOf('user', '习惯'), 'hypothesis', '行为归纳落 hypothesis');
checks += 3;

// 显式传入的类型优先于规则（写入方可覆盖）
await store.saveFacts([
  { subject: 'user', predicate: '喜好', object: '咖啡', confidence: 0.6, factType: 'hypothesis' },
], null, 'airi', project);
assert.equal(
  generalDb.prepare("SELECT fact_type t FROM facts WHERE object = '咖啡'").get().t,
  'hypothesis',
  '显式 factType 覆盖默认分类',
);
checks++;

// ── 3. 注入块：抬头 + 类型标签 ────────────────────────────────────────────
const habit = recallFactsForQuery('你还记得我有什么习惯吗', { project, characterId: 'airi', limit: 4 });
check(habit.facts.length >= 1, '习惯问句能召回事实');
check(!habit.text.includes('已经确认过的稳定事实'), '抬头不再声称"已经确认过的稳定事实"');
check(habit.text.includes('记忆库既有记录'), '抬头说明这是记忆库记录');
check(habit.text.includes('[系统]'), '抬头给出系统/实现类的说明');
check(habit.text.includes('[推测]') || habit.text.includes('[设定]') || habit.text.includes('[用户]'),
  '每条带类型标签');
check(habit.facts[0].predicate === '习惯', `问习惯时首条应是习惯（实际 ${habit.facts[0].predicate}）`);
check(habit.facts[0].type === 'hypothesis', '首条习惯的类型是 hypothesis');
check(habit.facts.every(f => f.typeStored === true), '新行类型来自库里的 fact_type');

// ── 4. 问"你是谁"时设定类优先 ─────────────────────────────────────────────
const identity = recallFactsForQuery('你还记得你的身份吗，你是谁', { project, characterId: 'airi', limit: 4 });
check(identity.families.includes('身份'), '身份问句命中身份族');
check(identity.facts[0].type === 'canon', `问身份时设定类优先（实际 ${identity.facts[0].type}）`);

// ── 5. 老行（fact_type 为 NULL）读取时现算 ───────────────────────────────
generalDb.prepare('UPDATE facts SET fact_type = NULL').run();
const legacy = recallFactsForQuery('你还记得我有什么习惯吗', { project, characterId: 'airi', limit: 4 });
check(legacy.facts.length >= 1, '老行仍能召回');
check(legacy.facts.every(f => f.typeStored === false), '老行标记为读取时现算');
check(legacy.facts.find(f => f.predicate === '习惯')?.type === 'hypothesis', '老行的习惯仍判成推测');
check(legacy.text.includes('[推测]'), '老行输出仍带类型标签');

// ── 6. 字数预算不被抬头挤爆 ───────────────────────────────────────────────
const tight = recallFactsForQuery('你还记得我有什么习惯吗', {
  project, characterId: 'airi', limit: 8, maxChars: 120,
});
check(tight.chars <= 120, ` budgets 守得住（实际 ${tight.chars}）`);
check(tight.facts.length >= 1, '预算收紧时至少留一条');

console.log(`fact-types regression: ${checks} checks passed`);
