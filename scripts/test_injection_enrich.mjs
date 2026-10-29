/**
 * 注入层的四项加固(来自 10-29 召回研究报告里"成熟系统都这么做"的几条):
 *   1) 条目带 id(模型可 memory_get 回查,而不是只能转述)
 *   2) recentIds 去重(连续同话题不重复塞同一段)
 *   3) margin 落差 → 只降 uncertainty,不丢结果
 *   4) stats 里给 marginTop2 / deduped / ms(整条链路可见)
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

const hit = (id, sim, text = '一段记忆正文') => ({
  id, text, project: 'default', type: 'episodic', memType: 'general', category: 'general',
  subcategory: null, tags: [], emotionalImpact: 0, importance: 0.6, characterId: 'airi',
  source: null, subject: 'user', agentMood: null, agentDesire: null, tier: 'standard',
  score: sim, similarity: sim, basis: 'vector', createdAt: '2026-10-01T00:00:00Z',
  lastAccessedAt: '2026-10-01T00:00:00Z', accessedCount: 0, biasBoost: 1,
});

console.log('[injection-enrich]');

console.log('\n1) 条目带 id');
const r1 = m.renderInjectionBlock([hit('abcd1234-ffff', 0.72)], { now: Date.parse('2026-10-29') });
check('注入文本非空', r1.text.length > 0);
check('带 id 前缀', r1.text.includes('id abcd1234'), r1.text.slice(0, 160));
check('仍带日期/imp/sim', /imp 0\.6/.test(r1.text) && /sim 0\.72/.test(r1.text));

console.log('\n2) recentIds 去重');
const two = [hit('aaaaaaaa', 0.72), hit('bbbbbbbb', 0.66)];
const r2 = m.renderInjectionBlock(two, { recentIds: ['aaaaaaaa'], now: Date.parse('2026-10-29') });
check('被去重的那条不进块', !r2.text.includes('id aaaaaaaa'), r2.text.slice(0, 200));
check('另一条仍在', r2.text.includes('id bbbbbbbb'));
check('stats.deduped = 1', r2.stats.deduped === 1, `got ${r2.stats.deduped}`);
const r2b = m.renderInjectionBlock(two, { recentIds: ['aaaaaaaa', 'bbbbbbbb'], now: Date.parse('2026-10-29') });
check('全部去重 → 空块', r2b.text === '' && r2b.stats.count === 0, JSON.stringify(r2b.stats));

console.log('\n3) margin 落差只降信心,不丢结果');
const close = [hit('cccccccc', 0.61), hit('dddddddd', 0.60)];
const noMargin = m.renderInjectionBlock(close, { now: Date.parse('2026-10-29') });
const withMargin = m.renderInjectionBlock(close, { now: Date.parse('2026-10-29'), margin: 0.05 });
check('两条都还在', withMargin.stats.count === 2, `got ${withMargin.stats.count}`);
check('无 margin 时 uncertainty=low(0.61 距门槛够远)', noMargin.text.includes('uncertainty="low"'), noMargin.text.slice(0, 90));
check('margin=0.05 时降为 medium', withMargin.text.includes('uncertainty="medium"'), withMargin.text.slice(0, 90));
check('stats.marginTop2 ≈ 0.01', Math.abs((withMargin.stats.marginTop2 ?? 0) - 0.01) < 1e-6, `got ${withMargin.stats.marginTop2}`);

console.log('\n4) 可观测字段');
const r4 = m.renderInjectionBlock([hit('eeeeeeee', 0.8)], { now: Date.parse('2026-10-29') });
check('topSim = 0.8', Math.abs(r4.stats.topSim - 0.8) < 1e-6, `got ${r4.stats.topSim}`);
check('deduped 默认为 0', r4.stats.deduped === 0);

console.log(`\n[injection-enrich] ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
