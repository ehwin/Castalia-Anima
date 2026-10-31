// agent_diary 不回流普通记忆检索的回归测试。
// 运行前先 build：node scripts/regression_diary_isolation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'store.js')) ? root : path.join(root, 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-diary-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, '{}');
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: 'diary-isolation',
});

const load = name => import(pathToFileURL(path.join(distRoot, `${name}.js`)).href);
const { DatabaseManager } = await load('db');
const { saveMemory, saveSelfDiary, updateMemory, forgetMemory, restoreMemory, markColdMemories } = await load('store');
const { searchMemory, pinnedAnchors, getRecentMemories } = await load('search');
const { recallForInjection } = await load('recallForInjection');
const { listAllMemories } = await load('reflect');
const { getRecentConversations } = await load('digest');
const { vadQueueStatus } = await load('emotion');

const project = 'diary-isolation';
const characterId = 'default';
const projectDb = DatabaseManager.getInstance(project, 'project');
const evidence = await saveMemory({
  text: '用户事实：喜欢蓝色咖啡杯，蓝色咖啡杯是重要偏好。',
  project, characterId, memType: 'project', source: 'conversation_log',
  tags: ['蓝色咖啡杯'], skipEmbed: true,
});
const queueBeforeDiary = vadQueueStatus(project, characterId);
const diary = await saveSelfDiary({
  text: '[自循环日记] 我观察到用户提到蓝色咖啡杯。',
  project, characterId, evidenceIds: [evidence.id], stateVersion: 1,
});
await saveSelfDiary({
  text: '钉住的自循环日记：蓝色咖啡杯。',
  project, characterId, evidenceIds: [evidence.id], stateVersion: 1,
});
const queueAfterDiary = vadQueueStatus(project, characterId);
assert.equal(queueAfterDiary.size, queueBeforeDiary.size, 'diary writes do not add VAD work');

// Derived records are append-only outputs. Generic memory mutation must not
// be able to hide, restore, or rewrite them.
assert.equal(forgetMemory(diary.id, project, characterId), false, 'generic delete cannot retire agent_diary');
assert.equal(restoreMemory(diary.id, project, characterId), false, 'generic restore cannot mutate agent_diary');
const diaryRowAfterRejectedDelete = projectDb.prepare('SELECT is_active FROM memory WHERE id = ?').get(diary.id);
assert.equal(diaryRowAfterRejectedDelete?.is_active, 1, 'rejected diary delete leaves row active');

// Maintenance must preserve the derived-record boundary too: an old diary is
// still a diary, not a normal standard memory eligible for cold storage.
projectDb.prepare("UPDATE memory SET created_at = datetime('now', '-90 day'), last_accessed_at = datetime('now', '-90 day') WHERE id = ?").run(diary.id);
assert.equal(markColdMemories(project, characterId), 0, 'cold maintenance excludes agent_diary rows');
assert.equal(projectDb.prepare('SELECT status FROM memory WHERE id = ?').get(diary.id)?.status, null, 'diary status is unchanged by cold maintenance');

await assert.rejects(
  () => updateMemory(diary.id, { text: '被通用 memory API 改写' }, characterId),
  /immutable|self-cycle writer/i,
  'generic memory updates cannot mutate diary prose',
);
const diaryAfterRejectedUpdate = (await searchMemory({
  query: '蓝色咖啡杯', project, characterId, topK: 10, minScore: 0, includeDiary: true,
})).find(row => row.id === diary.id);
assert.equal(diaryAfterRejectedUpdate?.text, diary.text, 'rejected diary update leaves text unchanged');

// Once the original evidence is analyzed, saving the same conversation again
// only increments its reference count; it must not requeue the old evidence.
const { flushVadQueue } = await load('emotion');
await flushVadQueue(project, { force: true });
assert.equal(vadQueueStatus(project, characterId).size, 0, 'initial evidence flush drains its queue');
await saveMemory({
  text: evidence.text, project, characterId, source: 'conversation_log', skipEmbed: true,
});
assert.equal(vadQueueStatus(project, characterId).size, 0, 'analyzed exact duplicate is not requeued');

const normal = await searchMemory({ query: '蓝色咖啡杯', project, characterId, topK: 10, minScore: 0 });
assert.ok(normal.some(row => row.id === evidence.id), 'conversation evidence remains searchable');
assert.ok(!normal.some(row => row.id === diary.id), 'agent diary is excluded from default search');

const explicit = await searchMemory({ query: '蓝色咖啡杯', project, characterId, topK: 10, minScore: 0, includeDiary: true });
assert.ok(explicit.some(row => row.id === diary.id), 'includeDiary explicitly enables diary search');

const anchors = pinnedAnchors({ project, characterId, limit: 10 });
assert.ok(!anchors.some(row => row.source === 'agent_diary'), 'diary is excluded from default pinned anchors');
const recent = getRecentMemories(characterId, 20, 24, project);
assert.ok(!recent.some(row => row.source === 'agent_diary'), 'diary is excluded from recent memories');
const reflected = listAllMemories(characterId, 50, project);
assert.ok(!reflected.some(row => row.source === 'agent_diary'), 'diary is excluded from reflection input');

const injected = await recallForInjection('蓝色咖啡杯', {
  project, characterId, includeTemporal: false, includeFacts: false, topK: 10,
  minSimilarityLexical: 0, strongLexical: 0,
});
assert.ok(!injected.text.includes('自循环日记'), 'injection does not contain diary by default');

const recentConversations = getRecentConversations(characterId, 24, 20, project);
assert.ok(recentConversations.some(row => row.id === evidence.id), 'conversation evidence is visible to self-cycle input');
assert.ok(!recentConversations.some(row => row.id === diary.id), 'diary is not conversation evidence');
const freshEvidence = await saveMemory({
  text: '用户事实：今天继续确认蓝色咖啡杯的偏好。',
  project, characterId, source: 'conversation_log', skipEmbed: true,
});
DatabaseManager.close();
console.log('PASS diary isolation');
