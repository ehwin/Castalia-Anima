// Exact duplicate conversation saves must not restart affect processing after
// the durable row has already been analyzed or abstained.
// Offline regression: temporary SQLite database, no embeddings or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-dup-enqueue-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, '{}');
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: 'duplicate-enqueue',
  CHAR_ID: 'airi',
  OLLAMA_URL: 'http://127.0.0.1:1',
});

const load = name => import(pathToFileURL(path.join(root, 'dist', `${name}.js`)).href);
const { DatabaseManager } = await load('db');
const { saveMemory } = await load('store');
const { flushVadQueue, vadQueueStatus } = await load('emotion');

// Keep the fallback path deterministic and offline.
globalThis.fetch = async () => { throw new Error('network disabled in regression'); };

const project = 'duplicate-enqueue';
const params = {
  text: '用户: 我很开心，今天聊得很好\n助手: 我也很开心',
  project,
  characterId: 'airi',
  memType: 'general',
  source: 'conversation_log',
  subject: 'user',
  skipEmbed: true,
};

const first = await saveMemory(params);
assert.equal(vadQueueStatus(project, 'airi').size, 1, 'first conversation save queues affect work');

const pendingDuplicate = await saveMemory(params);
assert.equal(pendingDuplicate.id, first.id, 'exact duplicate returns the original row');
assert.equal(vadQueueStatus(project, 'airi').size, 1, 'pending duplicate does not add a second queue entry');

await flushVadQueue(project, { force: true });
const db = DatabaseManager.getInstance(project, 'general');
const analyzed = db.prepare('SELECT affect_status FROM memory WHERE id = ?').get(first.id);
assert.equal(analyzed?.affect_status, 'analyzed', 'fallback flush durably marks the row analyzed');
assert.equal(vadQueueStatus(project, 'airi').size, 0, 'flush drains the pending queue');

await saveMemory(params);
assert.equal(vadQueueStatus(project, 'airi').size, 0, 'analyzed duplicate does not restart affect processing');

db.prepare('UPDATE memory SET affect_status = ?, vad_valence = NULL, vad_arousal = NULL, vad_dominance = NULL WHERE id = ?')
  .run('abstain', first.id);
await saveMemory(params);
assert.equal(vadQueueStatus(project, 'airi').size, 0, 'abstained duplicate does not restart affect processing');

db.prepare('UPDATE memory SET affect_status = NULL, vad_valence = NULL, vad_arousal = NULL, vad_dominance = NULL WHERE id = ?')
  .run(first.id);
await saveMemory(params);
assert.equal(vadQueueStatus(project, 'airi').size, 1, 'missing affect status can be recovered by a duplicate save');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log('PASS duplicate conversation enqueue regression');
