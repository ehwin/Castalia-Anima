/**
 * 情感显著性排序回归测试 —— 用"人会不会这么记"而不是 precision/recall 来验收。
 *
 * 每条 check 对应一条研究结论:
 *   ACT-R 间隔效应 / MemoryBank 衰减 / AFT 情绪一致 / Hebbian 共振 / 锚点不衰减 / 沉默策略
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const m = await import(pathToFileURL(path.join(DIST, 'emotionalRanking.js')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const close = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

const DAY = 86400000;
const now = Date.UTC(2026, 9, 29, 12, 0, 0);

console.log('[emotional-ranking]');

console.log('\n1) ACT-R 间隔效应');
// 同一件事:三次分散 vs 三次挤在一起 —— 分散的"记得更牢"
const spread = [now - 9 * DAY, now - 5 * DAY, now - 1 * DAY];
const bunched = [now - 9 * DAY, now - 9 * DAY + 2000, now - 9 * DAY + 4000];
const aSpread = m.baseLevelActivation(spread, now);
const aBunched = m.baseLevelActivation(bunched, now);
check('分散出现 > 集中出现', aSpread > aBunched, `${aSpread.toFixed(3)} vs ${aBunched.toFixed(3)}`);
check('从未召回 = -Infinity', m.baseLevelActivation([], now) === Number.NEGATIVE_INFINITY);
check('越久没想起越低', m.baseLevelActivation([now - 365 * DAY], now) < m.baseLevelActivation([now - 1 * DAY], now));

console.log('\n2) 情绪一致性(mood-congruent recall)');
const sad = { valence: -0.7, arousal: 0.6 };
const happy = { valence: 0.8, arousal: 0.5 };
check('难过时:悲伤记忆 > 快乐记忆', m.moodCongruence(sad, { valence: -0.6, arousal: 0.6 }) > m.moodCongruence(sad, happy));
check('开心时:快乐记忆 > 悲伤记忆', m.moodCongruence(happy, { valence: 0.7, arousal: 0.5 }) > m.moodCongruence(happy, { valence: -0.6, arousal: 0.6 }));
check('没有心情数据时中性 0.5', m.moodCongruence(null, { valence: 0.7, arousal: 0.5 }) === 0.5);
check('无 VAD 的记忆不被打死(≥0.5)', m.moodCongruence(sad, null) === 0.5);
check('同调分数落在 (0.5, 1]', m.moodCongruence(sad, { valence: -0.6, arousal: 0.6 }) > 0.5);

console.log('\n3) 共振(Hebbian):一起被想起过的会被带上来');
const res = { other: 10, far: 1 };
check('共激活 10 次 > 1 次', m.resonanceBoost('x', ['other'], res) > m.resonanceBoost('x', ['far'], res));
check('没有种子 = 0', m.resonanceBoost('x', [], res) === 0);
check('不给自己加权', m.resonanceBoost('other', ['other'], res) === 0);

console.log('\n4) 排序:锚点 > 强情感 > 杂事');
const cands = [
  { id: 'pinned-confession', intensity: 0.2, importance: 0.5, accessTimes: [], pinned: true },
  { id: 'fight', intensity: 0.9, importance: 0.8, accessTimes: [now - 2 * DAY, now - 1 * DAY], vad: { valence: -0.7, arousal: 0.8 } },
  { id: 'trivia', intensity: 0.05, importance: 0.1, accessTimes: [now - 300 * DAY] },
  { id: 'recent-small', intensity: 0.2, importance: 0.3, accessTimes: [now - 3600000] },
];
const ranked = m.rankBySalience(cands, now, sad, ['fight']);
const order = ranked.map(r => r.id);
check('锚点排第一', order[0] === 'pinned-confession', order.join(','));
check('强情感排第二', order[1] === 'fight', order.join(','));
check('陈年杂事垫底', order[order.length - 1] === 'trivia', order.join(','));
check('分数单调不增', ranked.every((r, i) => i === 0 || ranked[i - 1].score >= r.score));

console.log('\n5) 注入策略:难过时不主动翻旧账');
check('锚点 → always', m.injectionPolicy(0.1, { pinned: true }) === 'always');
check('高分 → inject', m.injectionPolicy(0.8) === 'inject');
check('中分 + 心情正常 → inject', m.injectionPolicy(0.4, { mood: { valence: 0.2, arousal: 0.4 } }) === 'inject');
check('中分 + 强负心情 → context-only', m.injectionPolicy(0.4, { mood: sad }) === 'context-only');
check('低分 → skip', m.injectionPolicy(0.1) === 'skip');

console.log('\n6) 情绪强烈的记忆衰减更慢(与 MemoryBank 一致)');
// 同样 30 天没想起:高强度记忆的显著度应高于低强度
const decayed = m.rankBySalience([
  { id: 'strong', intensity: 0.85, importance: 0.6, accessTimes: [now - 30 * DAY] },
  { id: 'weak', intensity: 0.15, importance: 0.6, accessTimes: [now - 30 * DAY] },
], now, null);
check('高强度 > 低强度', decayed[0].id === 'strong', decayed.map(d => d.id).join(','));

console.log('\n7) Bjork 双重强度:存储不衰减,提取会');
const fresh = { storage: 0.4, retrieval: 0.9 };
const old = m.bjorkDecay(fresh, 24 * 30);           // 30 天没想起
check('30 天后提取强度显著下降', old.retrieval < 0.3, `got ${old.retrieval.toFixed(3)}`);
check('存储强度不衰减', old.storage === fresh.storage, `${old.storage} vs ${fresh.storage}`);
const strongS = m.bjorkDecay({ storage: 0.95, retrieval: 0.9 }, 24 * 30);
check('存储强度高 → 衰减更慢', strongS.retrieval > old.retrieval, `${strongS.retrieval.toFixed(3)} vs ${old.retrieval.toFixed(3)}`);

const hard = m.bjorkUpdate({ storage: 0.2, retrieval: 0.1 }, 'retrieve');   // 费劲想起
const easy = m.bjorkUpdate({ storage: 0.2, retrieval: 0.9 }, 'retrieve');   // 轻松想起
check('难度越高,S 涨得越多(间隔效应)', (hard.storage - 0.2) > (easy.storage - 0.2),
  `${(hard.storage - 0.2).toFixed(3)} vs ${(easy.storage - 0.2).toFixed(3)}`);

const re = m.bjorkUpdate({ storage: 0.5, retrieval: 0.05 }, 're-encounter');
check('重新遇到 → 提取强度大幅回升', re.retrieval > 0.8, `got ${re.retrieval.toFixed(3)}`);
check('bjorkStrength 有存储兜底(不会归零)', m.bjorkStrength({ storage: 1, retrieval: 0 }) > 0.2, `got ${m.bjorkStrength({ storage: 1, retrieval: 0 }).toFixed(3)}`);
check('bjorkStrength 单调:提取强度高者更高', m.bjorkStrength({ storage: 0.5, retrieval: 0.9 }) > m.bjorkStrength({ storage: 0.5, retrieval: 0.2 }));

console.log('8) 激活用绝对标度,不是候选集 min-max');
check('1 小时前单次 ≈ 0.80', close(m.activationScore([now - 3600000], now), 0.80, 0.06), `got ${m.activationScore([now - 3600000], now).toFixed(3)}`);
check('30 天前单次 < 0.10', m.activationScore([now - 30 * DAY], now) < 0.10, `got ${m.activationScore([now - 30 * DAY], now).toFixed(3)}`);
check('从没被提起 = 0', m.activationScore([], now) === 0);
check('分散 3 次 > 单次', m.activationScore(spread, now) > m.activationScore([spread[2]], now));
const staleSet = m.rankBySalience([
  { id: 'a', intensity: 0.2, importance: 0.3, accessTimes: [now - 200 * DAY] },
  { id: 'b', intensity: 0.2, importance: 0.3, accessTimes: [now - 400 * DAY] },
], now, null);
check('全是陈年记忆时不会有 1.0 分', staleSet[0].score < 0.9, `got ${staleSet[0].score.toFixed(3)}`);
check('陈年 vs 陈年仍能看到相对差', staleSet[0].parts.activation > staleSet[1].parts.activation);

console.log('9) agentState 的 −10..+10 心情可直接用');
const m1 = m.moodFromScalar(-8);
check('moodFromScalar(-8).valence = -0.8', close(m1.valence, -0.8, 0.01), `got ${m1.valence}`);
check('负心情时与悲伤记忆更同调', m.moodCongruence(m1, { valence: -0.7, arousal: 0.8 }) > m.moodCongruence(m1, { valence: 0.7, arousal: 0.5 }));
check('moodFromScalar 越界被夹住', m.moodFromScalar(-99).valence === -1 && m.moodFromScalar(99).valence === 1);

console.log('10) 只有用户侧才算强化(注入不算)');
check('user_reference 算', m.shouldReinforce('user_reference') === true);
check('injection 不算', m.shouldReinforce('injection') === false);
check('空字符串不算', m.shouldReinforce('') === false);

console.log(`\n[emotional-ranking] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
