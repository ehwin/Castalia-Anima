// 原料行（conversation_log）不可被自动路径软删的回归测试。
//
// 对应 2026-10-31 交接单 §7 A1：merge / split / delete 三条反思路径跑完后，
// conversation_log 行必须仍然 is_active=1。附带覆盖 maintenance 路径
// （冷存 / consolidate 衰减 / 孤儿清扫）与"恢复后不被重抽"的 noReflect 标记。
//
// 跑法：先 build，再 node scripts/regression_raw_conversation_immutable.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'store.js')) ? root : path.join(root, 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-raw-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, '{}');
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: 'raw-immutable',
});

const load = name => import(pathToFileURL(path.join(distRoot, `${name}.js`)).href);
const { DatabaseManager } = await load('db');
const { saveConversationTurn, saveMemory, forgetMemory, restoreMemory, markColdMemories } = await load('store');
const { applyReflectActions } = await load('reflect');
const { getUnanalyzedConversations } = await load('reflectionSources');
const { consolidate } = await load('consolidate');
const { orphanMemories } = await load('orphan');

const project = 'raw-immutable';
const characterId = 'airi';
const db = DatabaseManager.getInstance(project, 'general');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const activeOf = id => db.prepare('SELECT is_active, source FROM memory WHERE id = ?').get(id);

const turn1 = await saveConversationTurn('用户今天在改记忆体', '助手：改哪一段？', characterId, undefined, undefined, project);
const turn2 = await saveConversationTurn('用户今天在改记忆体，顺便重装系统', '助手：重装前先备份。', characterId, undefined, undefined, project);
check(turn1?.id && turn2?.id, 'conversation turns are written');
const conv1 = activeOf(turn1.id), conv2 = activeOf(turn2.id);
check(conv1?.is_active === 1 && conv1?.source === 'conversation_log', 'turn 1 is active conversation_log');
check(conv2?.is_active === 1 && conv2?.source === 'conversation_log', 'turn 2 is active conversation_log');

// ── merge：原料行不能当源 ─────────────────────────────────────────────
const mergeResult = await applyReflectActions(
  [{ action: 'merge', sourceIds: [turn1.id, turn2.id], newText: '用户今天在改记忆体并重装系统。' }],
  characterId, project, { consolidation: true },
);
check(mergeResult.applied === 0, 'merge with raw conversation sources applies nothing');
check(mergeResult.errors.some(e => /raw-material|not found/i.test(e)), 'merge reports the raw-material refusal');
check(activeOf(turn1.id)?.is_active === 1, 'merge leaves turn 1 active');
check(activeOf(turn2.id)?.is_active === 1, 'merge leaves turn 2 active');
check(db.prepare("SELECT COUNT(*) c FROM memory WHERE source = 'reflect_merge'").get().c === 0,
  'refused merge writes no reflect_merge row');

// ── split：原料行不可拆 ───────────────────────────────────────────────
const splitResult = await applyReflectActions(
  [{ action: 'split', targetId: turn1.id, fragments: [{ text: '片段一' }, { text: '片段二' }] }],
  characterId, project,
);
const splitReceipt = splitResult.receipts.find(r => r.action === 'split');
check(splitReceipt?.status === 'failed', 'split receipt reports failure for raw material');
check((splitResult.errors || []).some(e => /raw-material/i.test(e)), 'split refuses a conversation_log source');
check(db.prepare("SELECT COUNT(*) c FROM memory WHERE source = 'reflect_split'").get().c === 0,
  'refused split writes no reflect_split row');
check(activeOf(turn1.id)?.is_active === 1, 'split leaves turn 1 active');

// ── delete：原料行不可删 ──────────────────────────────────────────────
const deleteResult = await applyReflectActions(
  [{ action: 'delete', targetId: turn1.id }],
  characterId, project,
);
const deleteReceipt = deleteResult.receipts.find(r => r.action === 'delete');
check(deleteReceipt?.status === 'failed', 'delete receipt reports failure for raw material');
check(activeOf(turn1.id)?.is_active === 1, 'delete leaves turn 1 active');

// ── 反思来源可见性 ────────────────────────────────────────────────────
const sources = getUnanalyzedConversations(characterId, undefined, 30, project);
check(sources.some(s => s.id === turn1.id) && sources.some(s => s.id === turn2.id),
  'active conversation rows stay in the reflection input');

// 恢复批次打上 noReflect 后不再进入反思输入（避免重抽旧对话）
const meta = { restoreBatch: '2099-01-01', noReflect: true };
db.prepare('UPDATE memory SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), turn2.id);
check(!getUnanalyzedConversations(characterId, undefined, 30, project).some(s => s.id === turn2.id),
  'noReflect rows are skipped by the reflection input');
check(activeOf(turn2.id)?.is_active === 1, 'noReflect is a metadata marker, not a soft delete');

// ── 维护路径：冷存 / 衰减 / 孤儿 ──────────────────────────────────────
db.prepare("UPDATE memory SET created_at = datetime('now', '-200 day'), last_accessed_at = datetime('now', '-200 day'), importance = 0.5 WHERE id = ?")
  .run(turn1.id);
check(markColdMemories(project, characterId) === 0, 'cold maintenance does not touch conversation_log');
check(db.prepare('SELECT status FROM memory WHERE id = ?').get(turn1.id)?.status === null, 'cold maintenance leaves status alone');

await consolidate();
check(activeOf(turn1.id)?.is_active === 1, 'consolidate decay never prunes conversation_log');

const orphan = orphanMemories(db, { project, aliveSessionIds: [], dryRun: true, limit: 100 });
check(!orphan.sample.some(r => r.id === turn1.id || r.id === turn2.id), 'orphan sweep never targets conversation rows');

// ── 人工遗忘仍然是用户权利（且可恢复）───────────────────────────────
check(forgetMemory(turn1.id, project, characterId) === true, 'manual forget can still retire a conversation row');
check(activeOf(turn1.id)?.is_active === 0, 'manual forget takes effect');
check(restoreMemory(turn1.id, project, characterId) === true, 'manual restore brings it back');
check(activeOf(turn1.id)?.is_active === 1, 'restored row is active again');

// ── 普通记忆仍可合并（保护不是全局禁用）──────────────────────────────
const ordinary1 = await saveMemory({ text: '普通记忆甲：蓝色咖啡杯。', project, characterId, type: 'semantic', category: 'general', skipEmbed: true });
const ordinary2 = await saveMemory({ text: '普通记忆乙：蓝色咖啡杯与杯子。', project, characterId, type: 'semantic', category: 'general', skipEmbed: true });
const okMerge = await applyReflectActions(
  [{ action: 'merge', sourceIds: [ordinary1.id, ordinary2.id], newText: '普通记忆：用户喜欢蓝色咖啡杯。' }],
  characterId, project, { consolidation: true },
);
check(okMerge.applied === 1, 'ordinary memories can still be merged');
check(activeOf(ordinary1.id)?.is_active === 0 && activeOf(ordinary2.id)?.is_active === 0,
  'ordinary merged sources are retired as before');

try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows keeps sqlite handles open; temp dir is harmless */ }
console.log(`PASS raw conversation immutability regression — ${checks} checks`);
