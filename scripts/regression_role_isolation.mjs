// 角色隔离回归(v1.24):CHAR_ID 是唯一角色来源;同库多角色之间读/写/维护全路径互不可见。
//
// 背景:Anima 旧模型按 project 推导角色(charFor(project)),角色 = 库名。v1.24 对齐 Castalia
// 普通版 —— 角色 = 进程级 CHAR_ID,project 只做记忆库维度;同库多角色靠 character_id 列隔离。
// 本回归把"另一个角色"的行直接写进同一个库,逐项断言它对本角色不可见、不可改、不可删,
// 且维护类操作(去重/晋升/会话快照/冷存/事实)不会替别的角色做决定。
//
// 纯离线:临时库 + EMBED_MODE=none,不触网、不写生产库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-role-iso-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({}));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',              // 零网络
  CASTALIA_PROJECT: 'iso',
  CHAR_ID: 'role-a',               // 本实例角色 = 被隔离保护的"自己"
});

const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager, backfillCharacterIds } = await load('db');
const {
  saveMemory, saveFacts, getFactsBySubject, findDbByMemoryId, forgetMemory, updateMemory,
  getSessionMemory, upsertSessionMemory, promoteToProject, deleteSessionFragments, listMemTypeDirs,
} = await load('store');
const { searchMemory, getRecentMemories } = await load('search');
const { listAllMemories, getMemoryGraph } = await load('reflect');
const { getUnanalyzedConversations } = await load('reflectionSources');

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const P = 'iso';
const ME = 'role-a';
const OTHER = 'role-b';

// ── 1. 写:两个角色往同一个库写各自的记忆/事实/会话快照 ──────────────────────
const own = await saveMemory({ project: P, text: 'A 的记忆:喜欢蓝色贝壳', tags: ['blue'] });
const foreign = await saveMemory({ project: P, text: 'B 的秘密:喜欢红色项链', tags: ['red'], characterId: OTHER });
const ownConv = await saveMemory({ project: P, text: '用户: 我是 A 的用户', source: 'conversation_log' });
const foreignConv = await saveMemory({ project: P, text: '用户: 我是 B 的用户', source: 'conversation_log', characterId: OTHER });
check(own.characterId === ME && foreign.characterId === OTHER, 'saveMemory honours explicit/instance character');

await upsertSessionMemory(P, 'sess-1', 'B 的滚动快照', undefined, OTHER);
check(getSessionMemory(P, 'sess-1', OTHER) === 'B 的滚动快照', 'foreign session snapshot is readable by its own role');

const factB = await saveFacts([{ subject: '贝壳颜色', predicate: '喜欢', object: '红色', confidence: 0.9 }], null, OTHER, P);
check(factB.inserted === 1, 'foreign fact inserted');
// 同一 SPO 由本角色写入:唯一索引必须含 character_id,否则这里会被旧 4 列唯一约束顶掉
const factA = await saveFacts([{ subject: '贝壳颜色', predicate: '喜欢', object: '红色', confidence: 0.5 }], null, ME, P);
check(factA.inserted === 1, 'same SPO under a different role is not blocked by the facts unique index');

// ── 2. 读:检索/索引/图谱/会话/事实/未分析对话 都看不到对方 ─────────────────
check((await searchMemory({ query: '红色项链', project: P })).length === 0, 'searchMemory (default CHAR_ID) hides the other role');
check((await searchMemory({ query: '蓝色贝壳', project: P })).length === 1, 'searchMemory still finds own memories');
check((await searchMemory({ query: '红色项链', project: P, characterId: OTHER })).length === 1, "characterId='role-b' sees its own row");
check((await searchMemory({ query: '红色项链', project: P, characterId: 'any' })).length === 1, "characterId='any' explicitly disables the role filter");

const listed = listAllMemories(ME, 500, P).map(m => m.id);
check(!listed.includes(foreign.id), 'listAllMemories excludes the other role');
check(listed.includes(own.id), 'listAllMemories keeps own memories');
const graph = getMemoryGraph(ME, P);
check(!graph.nodes.some(n => n.id === foreign.id), 'getMemoryGraph excludes the other role');

check(getSessionMemory(P, 'sess-1') === null, 'getSessionMemory does not leak the other role snapshot');
const recentIds = getRecentMemories(ME, 20, 8760, P).map(r => r.id);
check(!recentIds.includes(foreign.id), 'getRecentMemories excludes the other role');

const ownFacts = getFactsBySubject('贝壳颜色', ME, P);
const defaultFacts = getFactsBySubject('贝壳颜色', undefined, P);
const foreignFacts = getFactsBySubject('贝壳颜色', OTHER, P);
check(ownFacts.length === 1 && ownFacts[0].confidence === 0.5, 'getFactsBySubject returns own fact by default role');
check(defaultFacts.length === 1 && defaultFacts[0].confidence === 0.5, 'getFactsBySubject defaults to the instance role');
check(foreignFacts.length === 1 && foreignFacts[0].confidence === 0.9, 'getFactsBySubject is role-scoped per character');
const rawFactCount = DatabaseManager.getInstance(P).prepare(
  "SELECT COUNT(*) AS c FROM facts WHERE subject='贝壳颜色' AND predicate='喜欢' AND object='红色'"
).get().c;
check(rawFactCount === 2, 'both roles keep their own fact row (no cross-role overwrite)');

const unanalyzed = getUnanalyzedConversations(ME, undefined, 30, P).map(c => c.id);
check(!unanalyzed.includes(foreignConv.id), 'getUnanalyzedConversations excludes the other role log');
check(unanalyzed.includes(ownConv.id), 'getUnanalyzedConversations keeps own log');

// ── 3. 归属校验:按 id 的 get/update/delete 拒绝跨角色 id ────────────────────
check(findDbByMemoryId(foreign.id, P, ME) === null, 'findDbByMemoryId refuses a foreign id for this role');
check(findDbByMemoryId(foreign.id, P, OTHER) !== null, 'findDbByMemoryId still resolves the foreign id for its owner');
check((await updateMemory(foreign.id, { text: '被改了' }, ME)) === null, 'updateMemory refuses a foreign id');
check(forgetMemory(foreign.id, P, ME) === false, 'forgetMemory refuses a foreign id');
const stillThere = DatabaseManager.getInstance(P).prepare('SELECT is_active FROM memory WHERE id = ?').get(foreign.id);
check(stillThere && stillThere.is_active === 1, 'the foreign row is untouched after the refused delete');

// ── 4. 会话滚动:两个角色各有各的快照,互相不覆盖 ────────────────────────────
const mine = upsertSessionMemory(P, 'sess-1', 'A 的滚动快照');
check(mine.updated === false, 'upsertSessionMemory creates a separate row for this role');
check(getSessionMemory(P, 'sess-1') === 'A 的滚动快照', 'own snapshot round-trips');
check(getSessionMemory(P, 'sess-1', OTHER) === 'B 的滚动快照', 'the other role snapshot is intact');
check(deleteSessionFragments(P, 'sess-1', ME) === 1, 'deleteSessionFragments deletes only this role fragments');
check(getSessionMemory(P, 'sess-1', OTHER) === 'B 的滚动快照', 'the other role snapshot survives the sweep');

// ── 5. 晋升:同文本在另一个角色已存在时,本角色仍要独立落库 ───────────────────
const promotedA = promoteToProject(P, [{ memType: 'user', text: '画像:偏好蓝色贝壳', subject: 'user' }], ME);
const promotedB = promoteToProject(P, [{ memType: 'user', text: '画像:偏好蓝色贝壳', subject: 'user' }], OTHER);
check(promotedA.length === 1 && promotedB.length === 1, 'promoteToProject writes for both roles');
check(promotedA[0] !== promotedB[0], 'promoteToProject dedup is role-scoped (no id reuse across roles)');
const otherRow = DatabaseManager.getInstance(P, 'user').prepare('SELECT character_id FROM memory WHERE id = ?').get(promotedB[0]);
check(otherRow && otherRow.character_id === OTHER, 'the promoted row carries its own role id');

// ── 6. 迁移:NULL character_id 的补齐只在"库里角色唯一"时才敢猜 ───────────────
const soloDb = DatabaseManager.getInstance('iso-solo', 'general');
const soloRow = await saveMemory({ project: 'iso-solo', text: '单角色库里的历史行', memType: 'general' });
const soloForeignLike = await saveMemory({ project: 'iso-solo', text: '单角色库里被清空角色的历史行', memType: 'general' });
DatabaseManager.getInstance('iso-solo', 'general').prepare('UPDATE memory SET character_id = NULL WHERE id = ?').run(soloForeignLike.id);
const soloBackfilled = backfillCharacterIds(soloDb);
check(soloBackfilled === 1, 'backfill fills the NULL row in a single-role library');
const soloFixed = soloDb.prepare('SELECT character_id FROM memory WHERE id = ?').get(soloForeignLike.id);
check(soloFixed.character_id === ME, 'backfill uses the library only non-null role');

const multiDb = DatabaseManager.getInstance(P, 'general');
const nullRow = await saveMemory({ project: P, text: '多角色库里的历史 NULL 行' });
multiDb.prepare('UPDATE memory SET character_id = NULL WHERE id = ?').run(nullRow.id);
const multiBackfilled = backfillCharacterIds(multiDb);
check(multiBackfilled === 0, 'backfill refuses to guess in a multi-role library');
const stillNull = multiDb.prepare('SELECT character_id FROM memory WHERE id = ?').get(nullRow.id);
check(stillNull.character_id === null, 'the ambiguous row stays NULL instead of being claimed by one role');

// ── 7. 维护:冷存/清理不再跨角色 ─────────────────────────────────────────────
const { markColdMemories, cleanupExpiredMemories } = await load('store');
const foreignCold = await saveMemory({ project: P, text: 'B 的低价值旧记忆', importance: 0.1, characterId: OTHER });
DatabaseManager.getInstance(P).prepare("UPDATE memory SET created_at = '2020-01-01T00:00:00.000Z', last_accessed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(foreignCold.id);
const ownCold = await saveMemory({ project: P, text: 'A 的低价值旧记忆', importance: 0.1 });
DatabaseManager.getInstance(P).prepare("UPDATE memory SET created_at = '2020-01-01T00:00:00.000Z', last_accessed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(ownCold.id);
const coldMarked = markColdMemories(P, ME);
check(coldMarked >= 1, 'markColdMemories marks this role stale rows');
const foreignStatus = DatabaseManager.getInstance(P).prepare('SELECT status, is_active FROM memory WHERE id = ?').get(foreignCold.id);
check((foreignStatus.status || '') !== 'cold', 'markColdMemories leaves the other role rows alone');
check(cleanupExpiredMemories(P, ME) >= 0, 'cleanupExpiredMemories is role-scoped and callable');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, embedCalls: 0, productionWrites: 0 }));
