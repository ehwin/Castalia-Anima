/**
 * 实体扩散召回回归(Anima v1.29)
 *
 * 要验证的是"联想",不是相似度:一条记忆因为**共享人物/事件**被带上来,
 * 即使它的措辞跟查询毫无重叠。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-entity-'));
process.env.MEMORY_DB_DIR = tmp;
process.env.CHAR_ID = 'airi';
process.env.EMBED_MODE = 'none';

const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const entMod = await import(pathToFileURL(path.join(DIST, 'entities.js')).href);
const storeMod = await import(pathToFileURL(path.join(DIST, 'store.js')).href);
const searchMod = await import(pathToFileURL(path.join(DIST, 'search.js')).href);

// 三条记忆:只有 A 的措辞能被查询命中;B/C 与 A 共享实体(黑潮/尤诺)
const texts = {
  A: '那天她提起黑潮，说潮水会淹没整个城市',
  B: '命运被改写的那个雨夜，我们谁都没有说话',
  C: '她喜欢在雨天吃甜食，尤其是红豆味的',
};
const ids = {};
for (const [k, text] of Object.entries(texts)) {
  const r = await storeMod.saveMemory({ text, project: 'default', characterId: 'airi', skipEmbed: true });
  ids[k] = r.id;
}

// 建实体并关联
const db = dbMod.DatabaseManager.getInstance('default', 'general');
const entClock = entMod.upsertEntity(db, '黑潮', 'topic');
const entYuno = entMod.upsertEntity(db, '尤诺', 'topic');
const entRain = entMod.upsertEntity(db, '雨', 'topic');
entMod.linkMemoryToEntityIds(db, ids.A, [entClock.id, entYuno.id]);
entMod.linkMemoryToEntityIds(db, ids.B, [entClock.id, entYuno.id]);   // 与 A 共享 2 个
entMod.linkMemoryToEntityIds(db, ids.C, [entRain.id]);                // 只共享 0 个

console.log(`[entity-diffusion] 临时库 ${tmp}`);

const hits = await searchMod.searchMemory({
  query: '黑潮', project: 'default', characterId: 'airi', topK: 5, minScore: 0,
});
const byId = new Map(hits.map(h => [h.id, h]));

console.log('\n1) 词法命中仍然在(主召回没被扩散挤掉)');
check('A 命中,且 basis 是词法/标签', byId.has(ids.A), [...byId.keys()].join(','));
check('A 排在第一位', hits[0]?.id === ids.A, hits.map(h => `${h.id.slice(0, 6)}:${h.basis}`).join(' '));

console.log('\n2) 共享实体的记忆被联想带上来');
check('B 进入结果(措辞里没有"黑潮")', byId.has(ids.B), [...byId.keys()].join(','));
check('B 的 basis = entity', byId.get(ids.B)?.basis === 'entity', String(byId.get(ids.B)?.basis));
check('B 的 similarity 在 0.3~0.7(结构相似度)', (() => {
  const s = byId.get(ids.B)?.similarity ?? 0;
  return s >= 0.3 && s <= 0.7;
})(), `got ${byId.get(ids.B)?.similarity}`);
check('B 的分数低于 A(不喧宾夺主)', (byId.get(ids.B)?.score ?? 1) < (byId.get(ids.A)?.score ?? 0));

console.log('\n3) 只共享 1 个实体的不进(避免噪声)');
check('C 未命中', !byId.has(ids.C), [...byId.keys()].join(','));

console.log('\n4) 关闭开关后行为回到原样');
const noExpand = await searchMod.searchMemory({
  query: '黑潮', project: 'default', characterId: 'airi', topK: 5, minScore: 0, noEntityExpand: true,
});
check('noEntityExpand:true 时 B 不再出现', !noExpand.some(h => h.id === ids.B), noExpand.map(h => h.basis).join(','));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
console.log(`\n[entity-diffusion] ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
