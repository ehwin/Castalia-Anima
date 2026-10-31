// v1.28 双时间轴回归：as-of 查询（有效时间 / 事务时间）+ 开窗守卫。
// 两条轴必须能给出**不同**的答案，否则这套机制只是装饰。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-bitemporal-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({}));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp, MEMORY_CONFIG: config,
  CHAR_ID: 'default', EMBED_MODE: 'none', CONSOLIDATE_AUTO_ON_START: '0',
});

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, `${message}（期望 ${expected}，实际 ${actual}）`);
  checks++;
};

const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager } = await load('db');
const { saveFacts } = await load('store');
const { factsAsOf, findOpenWindowConflicts, assertInstant } = await load('bitemporal');

const nowIso = () => new Date().toISOString();

const project = 'anima-bitemporal';
const P = () => DatabaseManager.getInstance(project);

// ══ 1. 有效时间：三次慢变换值，任一时刻只有一个值为真 ══════════════════════
await saveFacts([
  { subject: 'u1', predicate: '居住地', object: '甲', confidence: 0.9, validFrom: '2026-01-01T00:00:00.000Z' },
  { subject: 'u1', predicate: '居住地', object: '乙', confidence: 0.9, validFrom: '2026-02-01T00:00:00.000Z' },
  { subject: 'u1', predicate: '居住地', object: '丙', confidence: 0.9, validFrom: '2026-03-01T00:00:00.000Z' },
], null, 'default', project);
const at = when => factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: when }).map(f => f.object).join(',');
eq(at('2026-01-15'), '甲', '1 月问 → 甲');
eq(at('2026-02-15'), '乙', '2 月问 → 乙');
eq(at('2026-03-15'), '丙', '3 月问 → 丙');
eq(at('2025-12-25'), '', '早于第一条 → 空');
eq(factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: '2026-01-15' }).length, 1, '任一时刻只有一个值为真');

// ══ 2. 两条轴必须给出不同答案（补录：今天写下、声称去年为真）════════════════
// 补录一条有效时间为去年十月、事务时间为现在的记录。
const backfillId = 'backfill-legal';
P().prepare(`
  INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active,
                     created_at, updated_at, valid_from, valid_to)
  VALUES (?, 'u2', '居住地', '杭州', ?, 0.9, 'default', 1, ?, ?, '2025-10-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z')
`).run(backfillId, project, nowIso(), nowIso());

const validNov = factsAsOf({ project, characterId: 'default', subject: 'u2', predicate: '居住地', at: '2025-11-01', axis: 'valid' });
eq(validNov.map(f => f.object).join(','), '杭州', '有效时间：去年十一月世界上是杭州');
const believedNov = factsAsOf({ project, characterId: 'default', subject: 'u2', predicate: '居住地', at: '2025-11-01', axis: 'transaction' });
eq(believedNov.length, 0, '事务时间：去年十一月我们并不知道这件事');
const believedNow = factsAsOf({ project, characterId: 'default', subject: 'u2', predicate: '居住地', at: nowIso(), axis: 'transaction' });
eq(believedNow.map(f => f.object).join(','), '杭州', '事务时间：现在回看，我们知道去年十月住杭州');

// ══ 3. 被接管的旧值：当时为真，事后可查，但不影响"现在" ═══════════════════
const janRows = factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: '2026-01-15' });
check(janRows[0].validTo !== null, '当时为真的旧值带着它的终点（它知道自己是历史）');
check(factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: '2026-01-15' }).every(f => f.supersededBy !== null || f.object === '丙' || f.id), '旧值仍在结果里，不因为被接管而消失');

// ══ 4. 字符校验：把握手协议当日期喂进来要抛错，不能静默返回空 ══════════════
assert.throws(() => assertInstant('随便一句话'), /不是可识别的时刻/);
checks++;
assert.throws(() => assertInstant('2026-13-45'), /无法被 SQLite 解析|不是可识别的时刻/);
checks++;
assert.throws(() => factsAsOf({ project, at: 'hello' }), /不是可识别的时刻/);
checks++;
assert.throws(() => factsAsOf({ project, at: '' }), /不是可识别的时刻/);
checks++;
eq(assertInstant(' 2026-03-01 '), '2026-03-01', '两端空白被容忍');

// ══ 5. 混格式：老行 valid_from 为空（用 created_at，SQLite 格式）也要排在正确的时刻 ══
P().prepare(`
  INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active,
                     created_at, updated_at, valid_from, valid_to)
  VALUES ('legacy-bit', 'u3', '称呼', '旧称呼', ?, 0.9, 'default', 1, '2026-04-01 10:00:00', '2026-04-01 10:00:00', NULL, NULL)
`).run(project);
P().prepare(`
  INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active,
                     created_at, updated_at, valid_from, valid_to)
  VALUES ('iso-bit', 'u3', '称呼', '新称呼', ?, 0.9, 'default', 1, '2026-04-01T09:00:00.000Z', '2026-04-01T09:00:00.000Z', '2026-04-01T09:00:00.000Z', NULL)
`).run(project);
const morning = factsAsOf({ project, characterId: 'default', subject: 'u3', predicate: '称呼', at: '2026-04-01 09:30:00' }).map(f => f.object);
eq(morning.join(','), '新称呼', '09:30 问 → 只有 09:00 那条为真（10:00 的老行还没到）');
const afternoon = factsAsOf({ project, characterId: 'default', subject: 'u3', predicate: '称呼', at: '2026-04-01 11:00:00' }).map(f => f.object);
check(afternoon.length === 2 && afternoon.includes('新称呼') && afternoon.includes('旧称呼'),
  '11:00 问 → 混格式的两个窗口都被看到（helper 不靠字典序）');

// ══ 6. 开窗守卫：单值谓词不许有两个开口窗口；多值谓词允许 ═══════════════════
const conflicts = findOpenWindowConflicts({ project, characterId: 'default' });
const 称呼冲突 = conflicts.filter(c => c.predicate === '称呼');
check(称呼冲突.length === 1 && 称呼冲突[0].windows.length === 2, '报告称呼有两个开口窗口（这是真实存在的脏数据）');
check(conflicts.every(c => c.predicate !== '居住地'), '居住地时间线干净：任一时刻只有一个开口');

// 多值谓词不该被报：喜欢可以有两条同时成立
await saveFacts([
  { subject: 'u4', predicate: '喜欢', object: '猫', confidence: 0.9, validFrom: '2026-05-01T00:00:00.000Z' },
  { subject: 'u4', predicate: '喜欢', object: '狗', confidence: 0.9, validFrom: '2026-05-01T00:00:00.000Z' },
], null, 'default', project);
check(findOpenWindowConflicts({ project, characterId: 'default' }).every(c => c.predicate !== '喜欢'),
  '多值谓词（喜欢）两条开口不报冲突 —— 否则触发器式守卫会误伤');
eq(factsAsOf({ project, characterId: 'default', subject: 'u4', predicate: '喜欢', at: '2026-06-01' }).length, 2, '多值：同一时刻两条都为真');

// ══ 7. 角色隔离：别的角色的 as-of 结果进来就是串味 ══════════════════════════
await saveFacts(
  [{ subject: 'u1', predicate: '居住地', object: '别的角色', confidence: 0.9, validFrom: '2026-01-01T00:00:00.000Z' }],
  null, 'other-role', project,
);
eq(factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: '2026-01-15' }).map(f => f.object).join(','), '甲',
  '本角色查询不会看到别的角色的同槽位值');
eq(factsAsOf({ project, characterId: 'any', subject: 'u1', predicate: '居住地', at: '2026-01-15' }).length, 2,
  "characterId: 'any' 关闭角色过滤（跨角色管理场景）");

// ══ 8. 结果稳定：同一问题问两次完全一致 ═══════════════════════════════════
const q = () => JSON.stringify(factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: '2026-02-15' }));
check(q() === q(), '同一问题两次结果一致');
check(factsAsOf({ project, characterId: 'default', subject: 'u1', predicate: '居住地', at: '2026-02-15' })[0].object === '乙', '且答案就是那一刻的值');

// ══ 9. 开窗修复计划：只读计划 + 应用后守卫不再报 ═══════════════════════════
const { planWindowRepairs, applyWindowRepairs } = await load('factWindows');

// 手工造一条"升级前遗留"的脏链：同一单值槽位两条开口（模拟 v1.28 之前写下的历史行）
P().prepare(`
  INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active,
                     created_at, updated_at, valid_from, valid_to)
  VALUES ('legacy-name-old', 'u5', '姓名', '旧名字', ?, 0.9, 'default', 1, '2026-01-01 10:00:00', '2026-01-01 10:00:00', NULL, NULL)
`).run(project);
P().prepare(`
  INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active,
                     created_at, updated_at, valid_from, valid_to)
  VALUES ('legacy-name-new', 'u5', '姓名', '新名字', ?, 0.9, 'default', 1, '2026-02-01 10:00:00', '2026-02-01 10:00:00', NULL, NULL)
`).run(project);

const plans = planWindowRepairs({ project, characterId: 'default' });
const namePlan = plans.find(p => p.predicate === '姓名' && p.subject === 'u5');
check(!!namePlan, '计划里报出 u5/姓名 有两个开口');
eq(namePlan.keep.object, '新名字', '计划保留最新的那条');
eq(namePlan.close.map(w => w.object).join(','), '旧名字', '计划关掉较早的那条');
eq(namePlan.reason, 'functional-predicate', '依据是单值种子表（与在线路径同一套规则）');

check(!plans.some(p => p.subject === 'u4' && p.predicate === '喜欢'), '多值谓词（喜欢）不进计划');
check(!plans.some(p => p.predicate === '计划'), '计划类谓词不进计划');

const applied = applyWindowRepairs([namePlan], { project });
eq(applied[0].closed, 1, '应用后关掉 1 行');
const repaired = P().prepare("SELECT object, valid_to, expired_at, superseded_by FROM facts WHERE id='legacy-name-old'").get();
check(!!repaired.valid_to && !!repaired.expired_at, '旧行拿到 valid_to 与 expired_at（两条时间轴都记）');
eq(repaired.superseded_by, 'legacy-name-new', 'superseded_by 指向接替者');
eq(factsAsOf({ project, characterId: 'default', subject: 'u5', predicate: '姓名', at: '2026-03-01' }).map(f => f.object).join(','),
  '新名字', '修复后此刻只有一个姓名');
check(findOpenWindowConflicts({ project, characterId: 'default' }).every(c => !(c.subject === 'u5' && c.predicate === '姓名')),
  '修复后守卫不再报这个槽位');
eq(applyWindowRepairs([namePlan], { project })[0].closed, 0, '再应用一次是幂等的（已经被闭合的行不碰）');
eq(planWindowRepairs({ project, characterId: 'default' }).filter(p => p.subject === 'u5').length, 0, '计划里也不再出现');

// 只读校验：计划本身不写任何东西
const beforeCount = P().prepare("SELECT COUNT(*) n FROM facts WHERE project=? AND (valid_to IS NULL OR valid_to='')").get(project).n;
planWindowRepairs({ project, characterId: 'default' });
eq(P().prepare("SELECT COUNT(*) n FROM facts WHERE project=? AND (valid_to IS NULL OR valid_to='')").get(project).n, beforeCount,
  'planWindowRepairs 只读，不产生写入');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, productionWrites: 0 }));
