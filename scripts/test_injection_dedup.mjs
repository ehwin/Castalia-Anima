/**
 * 注入去重：同一句话被多条记忆引用时只留一条（2026-11-01）
 *
 * 实测背景（真实库 airi/general）：「今天累死了，什么都不想干」注入 4 条同义记忆、
 * 1208 字符预算吃满。判据不能是文本相似度——那 4 条两两字符 bigram Jaccard 只有
 * 0.144–0.265，随机两条是 0.000–0.183，两者重叠。判据是**共用的引号片段**。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const m = await import(pathToFileURL(path.join(DIST, 'recallForInjection.js')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const hit = (id, sim, text) => ({
  id, text, project: 'default', type: 'episodic', memType: 'general', category: 'general',
  subcategory: null, tags: [], emotionalImpact: 0, importance: 0.6, characterId: 'airi',
  source: null, subject: 'user', agentMood: null, agentDesire: null, tier: 'standard',
  score: sim, similarity: sim, basis: 'vector', createdAt: '2026-11-01T00:00:00Z',
  lastAccessedAt: '2026-11-01T00:00:00Z', accessedCount: 0, biasBoost: 1,
});

console.log('[injection-dedup]');

console.log('\n1) quoteKeysOf 归一化');
check('取到引号片段', m.quoteKeysOf('摘录：「今天累死了，什么都不想干。」').length === 1);
check('标点差异归一成同一个键',
  m.quoteKeysOf('「今天累死了，什么都不想干。」')[0] === m.quoteKeysOf('「今天累死了什么都不想干」')[0]);
check('短于 8 字不当作键', m.quoteKeysOf('「收到」').length === 0);
check('没有引号返回空', m.quoteKeysOf('一段没有引用的正文').length === 0);

console.log('\n2) 同一句话 4 条 → 1 条');
const same = [
  hit('id-1', 1.00, '用户说自己累死了：「今天累死了，什么都不想干。」 摘录（她）：「那就别动了哦，什么都不用想。」'),
  hit('id-2', 1.00, '用户表示今天累死了：「今天累死了，什么都不想干。」 摘录（她）：「辛苦啦……今天是不是做了好多好多事呀？」'),
  hit('id-3', 1.00, '用户说累到极点：「今天累死了，什么都不想干。」 摘录（她）：「要不要先躺一会儿，什么都不用管？」'),
  hit('id-4', 0.90, '情感记忆：「今天累死了，什么都不想干。」 助手回应辛苦，并说可以安静陪着。'),
];
const r1 = m.renderInjectionBlock(same, { now: Date.parse('2026-11-01') });
check('只留 1 条', r1.stats.count === 1, `count=${r1.stats.count}`);
check('dedupedQuote = 3', r1.stats.dedupedQuote === 3, `dedupedQuote=${r1.stats.dedupedQuote}`);
check('保留排名最高的那条', r1.stats.ids?.[0] === 'id-1', JSON.stringify(r1.stats.ids));
check('collapsedIds 给出被折叠的 3 条', (r1.stats.collapsedIds ?? []).length === 3, JSON.stringify(r1.stats.collapsedIds));
check('正文只剩一份该原句', (r1.text.match(/今天累死了，什么都不想干/gu) ?? []).length <= 1);

console.log('\n3) 不同原句 → 全保留');
const diff = [
  hit('id-a', 0.80, '约定：「下周三一起去看展」 用户说到时候提醒他。'),
  hit('id-b', 0.78, '偏好：「他讨厌香菜」 点外卖时提过两次。'),
  hit('id-c', 0.75, '工作：「周五要交稿」 说压力有点大。'),
];
const r2 = m.renderInjectionBlock(diff, { now: Date.parse('2026-11-01') });
check('3 条都在', r2.stats.count === 3, `count=${r2.stats.count}`);
check('没有折叠', (r2.stats.dedupedQuote ?? 0) === 0);

console.log('\n4) 没有引号的行不受影响');
const noQuote = [hit('id-x', 0.8, '他妈妈上个月做过手术，恢复得还行。'), hit('id-y', 0.7, '周末通常在家写论文。')];
const r3 = m.renderInjectionBlock(noQuote, { now: Date.parse('2026-11-01') });
check('两条都保留（无判据就不猜）', r3.stats.count === 2, `count=${r3.stats.count}`);

console.log('\n5) 单条共享引号也只保留一条，且不影响其它行');
const mixed = [
  hit('id-p', 0.9, '「你还记得我喜欢什么吗」——她问过三次。'),
  hit('id-q', 0.6, '「你还记得我喜欢什么吗」——另一次追问，语气轻松。'),
  hit('id-r', 0.5, '无关的一条：冰箱里还有牛奶。'),
];
const r4 = m.renderInjectionBlock(mixed, { now: Date.parse('2026-11-01') });
check('2 条保留（1 条折叠）', r4.stats.count === 2, `count=${r4.stats.count}`);
check('无关那条没被牵连', r4.text.includes('冰箱里还有牛奶'));

console.log(`\n[injection-dedup] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
