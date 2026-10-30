// Facts source ownership regression. Run after `pnpm run build`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'store.js')) ? root : path.join(root, 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-facts-provenance-'));
const project = 'facts-provenance';

Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: project,
  CHAR_ID: 'airi',
});

const store = await import(pathToFileURL(path.join(distRoot, 'store.js')).href);
const { DatabaseManager } = await import(pathToFileURL(path.join(distRoot, 'db.js')).href);

const ownGeneral = await store.saveMemory({
  text: '同角色 general 来源', memType: 'general', characterId: 'airi', project,
});
const ownProject = await store.saveMemory({
  text: '同角色 project 来源', memType: 'project', characterId: 'airi', project,
});
const otherRole = await store.saveMemory({
  text: '另一角色来源', memType: 'general', characterId: 'other', project,
});
const diary = await store.saveSelfDiary({
  text: '[自循环日记]\n派生观察', characterId: 'airi', project, evidenceIds: ['conversation-1'],
});

const crossPartition = await store.saveFacts([
  { subject: 'user', predicate: '偏好', object: '茶', confidence: 0.9 },
], ownProject.id, 'airi', project);
assert.deepEqual(crossPartition, { inserted: 1, updated: 0 }, 'active cross-partition source is accepted');

const generalFact = await store.saveFacts([
  { subject: 'user', predicate: '来源', object: 'general', confidence: 0.8 },
], ownGeneral.id, 'airi', project);
assert.deepEqual(generalFact, { inserted: 1, updated: 0 }, 'active same-partition source is accepted');

await assert.rejects(
  store.saveFacts([{ subject: 'user', predicate: '错误', object: '未知', confidence: 0.5 }], 'missing-id', 'airi', project),
  /source memory not found/,
  'unknown source id is rejected',
);
await assert.rejects(
  store.saveFacts([{ subject: 'user', predicate: '错误', object: '跨角色', confidence: 0.5 }], otherRole.id, 'airi', project),
  /source memory not found|does not belong/,
  'cross-character source id is rejected',
);
await assert.rejects(
  store.saveFacts([{ subject: 'user', predicate: '错误', object: '日记', confidence: 0.5 }], diary.id, 'airi', project),
  /agent_diary cannot be used as a fact source/,
  'agent diary source is rejected',
);

assert.equal(store.forgetMemory(ownGeneral.id, project, 'airi'), true, 'source can be soft deleted');
await assert.rejects(
  store.saveFacts([{ subject: 'user', predicate: '错误', object: '失活', confidence: 0.5 }], ownGeneral.id, 'airi', project),
  /source memory not found|does not belong/,
  'inactive source id is rejected',
);

const noSource = await store.saveFacts([
  { subject: 'user', predicate: '无来源', object: '允许', confidence: 0.5 },
], null, 'airi', project);
assert.deepEqual(noSource, { inserted: 1, updated: 0 }, 'null source remains an explicit allowed mode');

const db = DatabaseManager.getInstance(project, 'general');
const row = db.prepare("SELECT source_memory_id, source_memory_source, source_memory_mem_type, character_id FROM facts WHERE object = '茶'").get();
assert.deepEqual(row, {
  source_memory_id: ownProject.id,
  source_memory_source: null,
  source_memory_mem_type: 'project',
  character_id: 'airi',
}, 'cross-partition provenance is durable');

DatabaseManager.close();
console.log('PASS facts provenance regression (10 checks)');
