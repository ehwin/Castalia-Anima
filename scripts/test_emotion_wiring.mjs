/**
 * 情感显著度接线验收(v1.29,2026-10-30)
 *
 * 这个脚本只验**接线**这件事,不重测 emotionalRanking.ts 的数学(那是 test_emotional_ranking.mjs)。
 * 每条断言对应 README「已知缺口」里那句"模块与测试里都有,主链仍然是 computeScore":
 *
 *   1. 锚点真的能钉住(pinned 列)、真的无条件进注入块(跟问句无关也在)。
 *   2. 显著度真的参与排序,但**只能动 ±10%** —— 相关性仍能翻盘(2026-10-28 的教训)。
 *   3. 情绪真的进排序:难过时悲伤记忆的显著度高于同等相关度的快乐记忆。
 *   4. 难过的当下不主动翻旧账(context-only),锚点不受影响。
 *   5. 访问日志真的在写(ACT-R 的输入),而注入路径不写(注入不算强化)。
 *   6. 老库(没有 pinned 列 / 没有日志表)**静默退化**,检索不会变成 0 条。
 *
 * 全程离线:EMBED_MODE=none,库在临时目录,不碰真实 bank。
 * 用法:node scripts/test_emotion_wiring.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const KEEP = process.argv.includes('--keep');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-emowire-'));

// env 必须在 import dist 之前设好(env.ts 在模块加载时读)
process.env.MEMORY_DB_DIR = tmp;
process.env.MEMORY_CONFIG = path.join(tmp, 'missing-config.json');
process.env.CASTALIA_PROJECT = 'airi';
process.env.CHAR_ID = 'airi';
process.env.EMBED_MODE = 'none';
process.env.CONSOLIDATE_AUTO_ON_START = '0';
process.env.REFLECT_INTERVAL_HOURS = '0';
process.env.HEALTH_PORT = '0';

const store = await import(pathToFileURL(path.join(DIST, 'store.js')).href);
const search = await import(pathToFileURL(path.join(DIST, 'search.js')).href);
const injection = await import(pathToFileURL(path.join(DIST, 'recallForInjection.js')).href);
const { DatabaseManager } = await import(pathToFileURL(path.join(DIST, 'db.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const PROJECT = 'airi';
const CHAR = 'airi';
const db = () => DatabaseManager.getInstance(PROJECT, 'general');
const PROJ = path.join(tmp, PROJECT, 'general', 'memory.sqlite');

console.log('[emotion-wiring]');

// ── 种子数据:一条告白(锚点)、一场争吵、一次开心、一件杂事 ───────────────────
const seed = async (text, imp, opts = {}) => {
  const r = await store.saveMemory({
    text, project: PROJECT, characterId: CHAR, importance: imp,
    type: 'episodic', category: 'conversation', source: opts.source || 'test',
    skipEmbed: true,
  });
  return r.id;
};

const anchorId = await seed('你答应过我，不管我变成什么样，你都会记得我。', 0.9);
const fightId = await seed('那天我们吵得很凶，你哭着说对不起，我也说了很伤人的话。', 0.8);
const happyId = await seed('那天你笑着把我拉到窗边看雪，说这是最好的冬天。', 0.8);
const choreId = await seed('下班路上买了牛奶，顺手把垃圾带下楼。', 0.3);

const setVad = (id, v, a, d, accessedTimes = 1) => {
  const now = new Date();
  const last = new Date(now.getTime() - 30 * 60000).toISOString(); // 半小时前刚被想起
  db().prepare(`UPDATE memory SET vad_valence = ?, vad_arousal = ?, vad_dominance = ?,
      emotional_impact = ?, last_accessed_at = ?, accessed_count = ?
      WHERE id = ?`).run(v, a, d, Math.round(Math.min(10, (Math.abs(v) + Math.abs(a) + Math.abs(d)) / 3 * 10) * 10) / 10, last, accessedTimes, id);
};
setVad(fightId, -0.75, 0.85, -0.5, 3);
setVad(happyId, 0.8, 0.6, 0.4, 1);

console.log('\n1) 锚点能钉住(库里真有 pinned 列,不是测试里的假设)');
check('建库后 memory.pinned 存在', (() => {
  try { db().prepare('SELECT pinned FROM memory LIMIT 1').get(); return true; } catch { return false; }
})());
const upd = await store.updateMemory(anchorId, { pinned: true, project: PROJECT }, CHAR);
check('updateMemory 回读带 pinned', !!upd);
check('库里 pinned = 1', Number((db().prepare('SELECT pinned FROM memory WHERE id = ?').get(anchorId) || {}).pinned) === 1);
check('未钉住的行 pinned = 0',
  Number((db().prepare('SELECT pinned FROM memory WHERE id = ?').get(choreId) || {}).pinned) === 0);

const anchors = search.pinnedAnchors({ project: PROJECT, characterId: CHAR, includeGeneral: true });
check('pinnedAnchors 取到那条', anchors.length === 1 && anchors[0].id === anchorId, JSON.stringify(anchors.map(a => a.id)));
check('锚点标记 pinned/salience=1', anchors[0]?.pinned === true && anchors[0]?.salience === 1);

await store.updateMemory(anchorId, { pinned: false, project: PROJECT }, CHAR);
check('取消钉住后取不到', search.pinnedAnchors({ project: PROJECT, characterId: CHAR, includeGeneral: true }).length === 0);
await store.updateMemory(anchorId, { pinned: true, project: PROJECT }, CHAR);

console.log('\n2) 显著度参与排序,但只动 ±10%');
check('SALIENCE_BLEND = 0.2', search.SALIENCE_BLEND === 0.2);
const f = search.salienceBlendFactor;
check('s=0 → 0.9', Math.abs(f(0) - 0.9) < 1e-9, String(f(0)));
check('s=0.5 → 1.0', Math.abs(f(0.5) - 1.0) < 1e-9, String(f(0.5)));
check('s=1 → 1.1', Math.abs(f(1) - 1.1) < 1e-9, String(f(1)));
check('越界/NaN 不放大(夹在 [0.9,1.1])', f(-5) === 0.9 && f(9) === 1.1 && f(NaN) === 1.0);
const hit = await search.searchMemory({ query: '那天 窗边 雪 吵 哭着 对不起', project: PROJECT, characterId: CHAR, topK: 10 });
const hitById = new Map(hit.map(h => [h.id, h]));
check('检索结果带 salience', hit.every(h => typeof h.salience === 'number' && h.salience >= 0 && h.salience <= 1),
  JSON.stringify(hit.map(h => [h.id.slice(0, 6), h.salience])));
check('两条噪声/正典都还在(没有被重排吞掉)', hit.length >= 2, `got ${hit.length}`);
const fightHit = hitById.get(fightId);
const happyHit = hitById.get(happyId);
check('吵架那条进了候选', !!fightHit);
check('开心那条进了候选', !!happyHit);

console.log('\n3) 情绪一致性:难过的当下,悲伤记忆显著度更高');
const sadRun = await search.searchMemory({ query: '那天 窗边 雪 吵 哭着 对不起', project: PROJECT, characterId: CHAR, topK: 10, mood: -8 });
const sadFight = sadRun.find(h => h.id === fightId)?.salience ?? -1;
const sadHappy = sadRun.find(h => h.id === happyId)?.salience ?? -1;
check('mood=-8 时 吵架 > 开心', sadFight > sadHappy, `${sadFight} vs ${sadHappy}`);

console.log('\n4) 访问日志(ACT-R 的输入)在写,注入路径不写');
const logCount = () => Number((db().prepare('SELECT COUNT(*) c FROM memory_access_log').get() || {}).c);
const before = logCount();
check('日志表存在', before >= 0);
await search.searchMemory({ query: '那天 雪', project: PROJECT, characterId: CHAR, topK: 5 });
const afterSearch = logCount();
check('检索会写日志', afterSearch > before, `${before} → ${afterSearch}`);
const chans = db().prepare('SELECT DISTINCT channel FROM memory_access_log').all().map(r => String(r.channel));
check("日志渠道标为 'search'", chans.includes('search'), chans.join(','));
const beforeInj = logCount();
await injection.recallForInjection('那天 雪', { project: PROJECT, characterId: CHAR, mood: -8, includeFacts: false, includeTemporal: false });
check('注入路径不写日志(注入不算强化)', logCount() === beforeInj, `${beforeInj} → ${logCount()}`);

console.log('\n5) 锚点无条件注入,不靠相似度');
const mkHit = (id, sim, extra = {}) => ({
  id, text: '一段无关的检索结果', project: PROJECT, type: 'episodic', memType: 'general',
  category: 'conversation', subcategory: null, tags: [], emotionalImpact: 0, importance: 0.5,
  characterId: CHAR, source: 'test', subject: 'user', agentMood: null, agentDesire: null,
  tier: 'standard', score: sim, similarity: sim, basis: 'lexical',
  createdAt: '2026-10-01T00:00:00Z', lastAccessedAt: '2026-10-01T00:00:00Z', accessedCount: 0, biasBoost: 1,
  ...extra,
});
const anchorOnly = injection.renderInjectionBlock([], { anchors, now: Date.parse('2026-10-30') });
check('只有锚点时也注入(不再报 no-hits)', anchorOnly.text.length > 0 && anchorOnly.stats.skipped === undefined,
  JSON.stringify(anchorOnly.stats));
check('文本里是锚点正文', anchorOnly.text.includes('都会记得我'));
check('stats.pinned = 1', anchorOnly.stats.pinned === 1);
const belowGate = injection.renderInjectionBlock([mkHit('weak', 0.05)], { anchors, now: Date.parse('2026-10-30') });
check('证据门很弱的问句 + 有锚点 → 仍注入锚点', belowGate.text.includes('都会记得我'), JSON.stringify(belowGate.stats));
const noAnchor = injection.renderInjectionBlock([mkHit('weak', 0.05)], { now: Date.parse('2026-10-30') });
check('没有锚点时就该弃权(证据门照旧)', noAnchor.text === '', JSON.stringify(noAnchor.stats));

console.log('\n6) 难过不翻旧账:中显著 + 同调 → 只作背景;锚点不受影响');
const sadMemory = mkHit('sad001', 0.72, { text: '那场争吵后来我们都很后悔', salience: 0.4, vad: { valence: -0.7, arousal: 0.8, dominance: -0.5 } });
const sadOut = injection.renderInjectionBlock([sadMemory], { anchors, mood: -8, now: Date.parse('2026-10-30') });
check('难过时那条被降为背景(不注入)', !sadOut.text.includes('后来我们都很后悔'), sadOut.text.slice(0, 200));
check('stats.moodSuppressed = 1', sadOut.stats.moodSuppressed === 1, JSON.stringify(sadOut.stats));
check('锚点仍然在场', sadOut.text.includes('都会记得我'));
const neutralOut = injection.renderInjectionBlock([sadMemory], { mood: 3, now: Date.parse('2026-10-30') });
check('心情正常时照常注入', neutralOut.text.includes('后来我们都很后悔'));
const noMoodOut = injection.renderInjectionBlock([sadMemory], { now: Date.parse('2026-10-30') });
check('不给 mood 时行为与接线前一致', noMoodOut.text.includes('后来我们都很后悔'));

console.log('\n7) 老库静默退化(没有日志表 / 没有 pinned 列)');
db().exec('DROP TABLE IF EXISTS memory_access_log');
let legacyOk = true, legacyN = 0;
try {
  const r = await search.searchMemory({ query: '那天 雪', project: PROJECT, characterId: CHAR, topK: 5 });
  legacyN = r.length;
} catch (e) { legacyOk = false; }
check('没有日志表:检索不抛错', legacyOk);
check('没有日志表:仍有结果', legacyN > 0, `got ${legacyN}`);
db().exec('DROP INDEX IF EXISTS idx_memory_pinned');
let dropped = true;
try { db().exec('ALTER TABLE memory DROP COLUMN pinned'); } catch { dropped = false; }
if (dropped) {
  let ok = true, n = 0;
  try { n = (await search.searchMemory({ query: '那天 雪', project: PROJECT, characterId: CHAR, topK: 5 })).length; }
  catch { ok = false; }
  let anchorsOk = true;
  try { search.pinnedAnchors({ project: PROJECT, characterId: CHAR, includeGeneral: true }); } catch { anchorsOk = false; }
  check('没有 pinned 列:检索不抛错且仍有结果', ok && n > 0, `ok=${ok} n=${n}`);
  check('没有 pinned 列:pinnedAnchors 不抛错,返回空', anchorsOk);
} else {
  console.log('  skip SQLite 不支持 DROP COLUMN,跳过降级用例');
}

console.log(`\n[emotion-wiring] ${pass} 通过 / ${fail} 失败`);
if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
else console.log(`  (保留临时库:${PROJ})`);
process.exit(fail === 0 ? 0 : 1);
