// v1.28 事实层回归：谓词易变性裁决 + 双时间轴 + 顺序守卫。
// 纯离线：临时库 + EMBED_MODE=none，不触网、不写生产库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-temporal-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({}));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp, MEMORY_CONFIG: config,
  CHAR_ID: 'default', EMBED_MODE: 'none',
});

const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager } = await load('db');
const { saveFacts } = await load('store');
const { shouldSupersede, needsEvidence } = await load('volatility');

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, `${message} (期望 ${expected}，实际 ${actual})`);
  checks++;
};
const near = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message} (期望 ${expected} ±${tolerance}，实际 ${actual})`);
  checks++;
};

const project = 'anima-temporal';
const P = () => DatabaseManager.getInstance(project);
const save = (rows, cid = 'default') =>
  saveFacts(rows.map(r => ({ confidence: 0.9, ...r })), null, cid, project);
const factRows = (subject, predicate) => P().prepare(
  "SELECT * FROM facts WHERE project=? AND subject=? AND predicate=? ORDER BY COALESCE(valid_from, created_at)"
).all(project, subject, predicate);
const newIdOf = (subject, predicate, object) => P().prepare(
  "SELECT id FROM facts WHERE project=? AND subject=? AND predicate=? AND object=?"
).get(project, subject, predicate, object).id;

// ── 1. 单值种子表：新值接管旧值，且写双时间轴 ──────────────────────────────
await save([{ subject: 'u1', predicate: '居住地', object: '杭州', validFrom: '2026-01-01T00:00:00.000Z' }]);
await save([{ subject: 'u1', predicate: '居住地', object: '上海', validFrom: '2026-06-01T00:00:00.000Z' }]);
let rows = factRows('u1', '居住地');
eq(rows.length, 2, '居住地两条历史都在（不删除）');
eq(rows[0].object, '杭州', '旧值仍在库里');
eq(rows[0].valid_to, '2026-06-01T00:00:00.000Z', 'valid_to = 新值的 valid_from，不是 now');
check(!!rows[0].expired_at && rows[0].expired_at !== rows[0].valid_to,
  'expired_at（判定时刻）与 valid_to（失效时刻）分开');
eq(rows[0].superseded_by, newIdOf('u1', '居住地', '上海'), 'superseded_by 指向推翻它的新事实');
eq(rows[1].valid_to, null, '新值仍然有效');

// ── 2. 计划类：只并存，不失效（Graphiti 软截止守卫） ────────────────────────
await save([{ subject: 'u2', predicate: '计划', object: '去日本', validFrom: '2026-01-05T00:00:00.000Z' }]);
await save([{ subject: 'u2', predicate: '计划', object: '去泰国', validFrom: '2026-02-05T00:00:00.000Z' }]);
rows = factRows('u2', '计划');
eq(rows.length, 2, '计划变更保留两条');
check(rows.every(r => !r.valid_to), '计划类永不自动失效');

// ── 3. 多值关系：永不自动失效 ─────────────────────────────────────────────
await save([{ subject: 'u3', predicate: '喜欢', object: '猫', validFrom: '2026-01-01T00:00:00.000Z' }]);
await save([{ subject: 'u3', predicate: '喜欢', object: '狗', validFrom: '2026-01-02T00:00:00.000Z' }]);
rows = factRows('u3', '喜欢');
check(rows.every(r => !r.valid_to), '喜欢（可多值）两条都有效');

// ── 4. 表外慢变谓词：3 次换值、间隔 ≥7 天 → 旧值失效 ────────────────────────
await save([{ subject: 'u4', predicate: '当前项目', object: '甲', validFrom: '2026-01-01T00:00:00.000Z' }]);
await save([{ subject: 'u4', predicate: '当前项目', object: '乙', validFrom: '2026-02-01T00:00:00.000Z' }]);
let mid = factRows('u4', '当前项目');
check(!mid[0].valid_to, '只有 2 条样本时保守不失效');
await save([{ subject: 'u4', predicate: '当前项目', object: '丙', validFrom: '2026-03-01T00:00:00.000Z' }]);
rows = factRows('u4', '当前项目');
check(!!rows[0].valid_to && !!rows[1].valid_to && !rows[2].valid_to,
  '第 3 次换值后前两条失效、最新有效');
eq(rows[0].valid_to, '2026-02-01T00:00:00.000Z', '旧值终点取下一个值的起点');

// ── 5. 表外高易变：几天内连续翻转 → 只并存 ────────────────────────────────
await save([{ subject: 'u5', predicate: '心情', object: '好', validFrom: '2026-06-01T00:00:00.000Z' }]);
await save([{ subject: 'u5', predicate: '心情', object: '差', validFrom: '2026-06-02T00:00:00.000Z' }]);
await save([{ subject: 'u5', predicate: '心情', object: '还行', validFrom: '2026-06-03T00:00:00.000Z' }]);
rows = factRows('u5', '心情');
check(rows.every(r => !r.valid_to), '3 天内快速翻转视为状态，只并存');

// ── 6. 顺序守卫：回溯补录的历史事实不被后写入的当前值打掉 ────────────────────
await save([{ subject: 'u6', predicate: '居住地', object: '北京', validFrom: '2026-05-01T00:00:00.000Z' }]);
await save([{ subject: 'u6', predicate: '居住地', object: '广州', validFrom: '2026-01-01T00:00:00.000Z' }]);
rows = factRows('u6', '居住地');
const beijing = rows.find(r => r.object === '北京');
const guangzhou = rows.find(r => r.object === '广州');
check(!!beijing && !beijing.valid_to, 'valid_from 更晚的那条保持开口');
eq(guangzhou.valid_to, '2026-05-01T00:00:00.000Z', '补录的旧事实被正确的值闭合（不是自由漂浮）');

// ── 7. 幂等：同一 SPO 重复写入不产生新的失效 ──────────────────────────────
const before = P().prepare("SELECT COUNT(*) c FROM facts WHERE project=? AND valid_to IS NOT NULL").get(project).c;
await save([{ subject: 'u1', predicate: '居住地', object: '上海', validFrom: '2026-06-01T00:00:00.000Z' }]);
const after = P().prepare("SELECT COUNT(*) c FROM facts WHERE project=? AND valid_to IS NOT NULL").get(project).c;
eq(after, before, '重复写入同一条事实不新增失效');
check(factRows('u1', '居住地')[0].valid_to === '2026-06-01T00:00:00.000Z', '旧值终点不被覆写');

// ── 8. 纯函数边界 ────────────────────────────────────────────────────────
check(shouldSupersede({ predicate: '居住地' }).reason === 'functional-predicate', '种子表走先验');
check(shouldSupersede({ predicate: '计划' }).reason === 'plan-predicate', '计划类被判为并存');
check(shouldSupersede({ predicate: '喜欢' }).reason === 'open-predicate', '多值关系判为并存');
check(shouldSupersede({ predicate: '野生谓词' }).reason === 'insufficient-evidence', '无证据不失效');
check(needsEvidence('野生谓词') && !needsEvidence('居住地') && !needsEvidence('计划') && !needsEvidence('喜欢'),
  '只有表外谓词需要查证据');

// ── 9. 角色隔离：另一个角色的事实不参与裁决 ────────────────────────────────
await save([{ subject: 'u7', predicate: '当前项目', object: '甲', validFrom: '2026-01-01T00:00:00.000Z' }], 'cardB');
await save([{ subject: 'u7', predicate: '当前项目', object: '乙', validFrom: '2026-02-01T00:00:00.000Z' }], 'cardB');
await save([{ subject: 'u7', predicate: '当前项目', object: '丙', validFrom: '2026-03-01T00:00:00.000Z' }], 'default');
rows = P().prepare("SELECT * FROM facts WHERE project=? AND subject=? AND COALESCE(character_id,'')='cardB'").all(project, 'u7');
check(rows.every(r => !r.valid_to), '别的角色的历史不算本角色的证据');

// ── 10. 同一批写入的两个值（同一时刻）不互相接管（v1.23-fix 的行为由此自然成立） ──
await save([{ subject: 'u8', predicate: '姓名', object: '张三', validFrom: '2026-07-01T00:00:00.000Z' }]);
await save([
  { subject: 'u8', predicate: '姓名', object: '李四', validFrom: '2026-07-02T00:00:00.000Z' },
  { subject: 'u8', predicate: '姓名', object: '王五', validFrom: '2026-07-02T00:00:00.000Z' },
]);
rows = factRows('u8', '姓名');
eq(rows.length, 3, '三条历史都在');
eq(rows[0].object, '张三', '更早的那条排在最前');
check(!!rows[0].valid_to, '更早的那条被同批的新值闭合');
check(!rows[1].valid_to && !rows[2].valid_to, '同一时刻的两个值并存，不互相打 valid_to');

// ── 11. 变更风险率 α（RoMem Semantic Speed Gate 的闭式估计）──────────────────
const { estimatePredicateVolatility } = await load('volatility');
await save([
  { subject: 'u9', predicate: '当前主题', object: '甲', validFrom: '2026-01-01T00:00:00.000Z' },
  { subject: 'u9', predicate: '当前主题', object: '乙', validFrom: '2026-05-01T00:00:00.000Z' },
  { subject: 'u9', predicate: '当前主题', object: '丙', validFrom: '2026-10-28T00:00:00.000Z' },
]);
const ev = estimatePredicateVolatility(P(), project, 'u9', '当前主题', 'default');
eq(ev.samples, 3, '证据条数 = 3');
eq(ev.distinctObjects, 3, '三个不同 object');
near(ev.alphaPerDay, 2 / 300, 0.0005, 'α = 换值次数 / 观测跨度天数 = 2/300');
near(ev.pChange7d, 1 - Math.exp(-(2 / 300) * 7), 0.002, 'pChange7d = 1 - exp(-α·7)');
// 危险率模型的自洽性：用落库的 α 外推一年（α 已取整到 3 位，容差按此放宽）
near(1 - Math.exp(-ev.alphaPerDay * 365), 0.922, 0.004, 'p(365 天) = 1 - exp(-α·365)');
check(1 - Math.exp(-ev.alphaPerDay * 365) > ev.pChange7d, 'Δ 越大越可能变更（单调）');
check(ev.pChange7d <= 0.5, 'α 小 → 判为慢变 → 允许失效');
rows = factRows('u9', '当前主题');
check(!!rows[0].valid_to && !!rows[1].valid_to && !rows[2].valid_to, '慢变链：前两条闭合、最新开口');

// ── 12. 老行（valid_from 为空 → 用 created_at，SQLite 格式）排序必须按时间，不能按字典序 ──
// 混用格式时字典序会翻车：'2026-03-01 10:00:00' < '2026-03-01T09:00:00.000Z'（空格 < "T"）。
P().prepare(`
  INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active, created_at, updated_at, valid_from)
  VALUES ('legacy-row', 'u10', '居住地', '旧值', ?, 0.9, 'default', 1, '2026-03-01 10:00:00', '2026-03-01 10:00:00', NULL)
`).run(project);
await save([{ subject: 'u10', predicate: '居住地', object: '新值', validFrom: '2026-03-01T09:00:00.000Z' }]);
const legacy = P().prepare("SELECT * FROM facts WHERE id='legacy-row'").get();
const fresh = factRows('u10', '居住地').find(r => r.object === '新值');
check(!legacy.valid_to, '10:00 的老行是较晚的值 → 保持开口（字典序会把它误判成最早）');
eq(fresh.valid_to, '2026-03-01 10:00:00', '09:00 的新行被较晚的老行闭合');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, productionWrites: 0 }));
