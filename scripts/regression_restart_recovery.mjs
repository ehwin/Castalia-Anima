#!/usr/bin/env node
/**
 * Cross-process recovery regression for the affect (VAD) queue.
 * The first process leaves one conversation pending; the second process must
 * rebuild the disposable queue from SQLite and finish the affect write.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-restart-'));
const env = {
  ...process.env,
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: path.join(temp, 'missing-config.json'),
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: 'restart-check',
  CHAR_ID: 'default',
  OLLAMA_URL: 'http://127.0.0.1:1',
};
const run = code => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`child exited ${result.status}`);
  }
  return result.stdout;
};

try {
  const seedOutput = run(`
    import { DatabaseManager, generateId } from './dist/db.js';
    const db = DatabaseManager.getInstance('restart-check', 'general');
    const id = generateId();
    db.prepare("INSERT INTO memory (id,text,project,source,character_id,is_active,affect_status) VALUES (?,?,'restart-check','conversation_log','default',1,'pending')")
      .run(id, '她说分手，我很难过');
    console.log(id);
    DatabaseManager.close();
  `);
  const memoryId = seedOutput.trim().split(/\s+/).at(-1);
  assert.match(memoryId, /^[0-9a-f-]{20,}$/i);

  const recoverOutput = run(`
    import { DatabaseManager } from './dist/db.js';
    import { recoverPendingVadQueue, vadQueueStatus, flushVadQueue } from './dist/emotion.js';
    const db = DatabaseManager.getInstance('restart-check', 'general');
    const recovered = recoverPendingVadQueue('restart-check', 'default');
    if (recovered !== 1 || vadQueueStatus('restart-check', 'default').size !== 1) process.exit(2);
    await flushVadQueue('restart-check', { force: true });
    const row = db.prepare("SELECT affect_status, vad_valence, affect_source FROM memory WHERE id = ?").get(${JSON.stringify(memoryId)});
    console.log(JSON.stringify({ row, queue: vadQueueStatus('restart-check', 'default').size }));
    DatabaseManager.close();
  `);
  const result = JSON.parse(recoverOutput.trim().split(/\r?\n/).at(-1));
  assert.equal(result.row.affect_status, 'analyzed');
  assert.equal(result.row.affect_source, 'local_lexicon');
  assert.notEqual(result.row.vad_valence, null);
  assert.equal(result.queue, 0);
  console.log('PASS restart recovery');
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
}
