#!/usr/bin/env node
/**
 * Offline failure-path regression for the emotion queue.
 *
 * This intentionally imports dist/, because that is what production loads.
 * It refuses to run against a stale build: run `npm run build` first when the
 * source has changed. No Ollama process is required; fetch is stubbed below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const distEmotion = path.join(DIST, 'emotion.js');
const distText = fs.existsSync(distEmotion) ? fs.readFileSync(distEmotion, 'utf8') : '';
const requiredBuildMarkers = [
  'vadFlushInFlight',
  'Invalid batch classification JSON',
  'Expected ${entries.length} classification results',
];
const missing = requiredBuildMarkers.filter(marker => !distText.includes(marker));
if (missing.length > 0) {
  console.error('[emotion-failure] stale or missing dist/emotion.js');
  console.error('  run: npm run build');
  console.error('  missing markers: ' + missing.join(', '));
  process.exit(2);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-emotion-failure-'));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: path.join(temp, 'missing-config.json'),
  CASTALIA_PROJECT: 'emotion-failure',
  CHAR_ID: 'airi',
  EMBED_MODE: 'none',
  OLLAMA_URL: 'http://127.0.0.1:1',
  VAD_MODEL: 'fixture',
});

const load = name => import(pathToFileURL(path.join(DIST, name + '.js')).href);
const { DatabaseManager, generateId } = await load('db');
const emotion = await load('emotion');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const insertMemory = (project, text) => {
  const db = DatabaseManager.getInstance(project, 'general');
  const id = generateId();
  db.prepare(`INSERT INTO memory
    (id, text, project, type, mem_type, character_id, source, is_active)
    VALUES (?, ?, ?, 'episodic', 'general', 'airi', 'conversation_log', 1)`)
    .run(id, text, project);
  return { db, id };
};

console.log('[emotion-failure]');

// 1) A local affect write failure must leave the entry pending. A read-only
// SQLite connection reproduces the real write error without deleting schema.
console.log('\n1) local fallback write failure is retryable');
const localProject = 'emotion-local-failure';
const localText = '她跟我说分手，我很难过';
const local = insertMemory(localProject, localText);
emotion.queueForVad(localText, localProject, local.id);
local.db.pragma('query_only = ON');
let localRejected = false;
try {
  await emotion.flushVadQueue(localProject, { force: true });
} catch (error) {
  localRejected = true;
  console.log('  expected local failure:', error.message);
}
check('local write failure rejects flush', localRejected);
check('local write failure requeues entry', emotion.vadQueueStatus(localProject).size === 1,
  JSON.stringify(emotion.vadQueueStatus(localProject)));
local.db.pragma('query_only = OFF');
await emotion.flushVadQueue(localProject, { force: true });
const localRow = local.db.prepare('SELECT vad_valence, emotional_impact FROM memory WHERE id = ?').get(local.id);
check('retry writes local VAD', localRow?.vad_valence != null && localRow.vad_valence < 0, JSON.stringify(localRow));
check('successful retry consumes entry', emotion.vadQueueStatus(localProject).size === 0);

// 2) A malformed batch response must not partially consume the queue. The
// next response is valid and proves that requeued entries remain usable.
console.log('\n2) malformed model response is retryable');
const classifyProject = 'emotion-classify-failure';
const classifyText = '用户说了一件重要的事';
const classified = insertMemory(classifyProject, classifyText);
let classifyMode = 'invalid';
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || '{}');
  const system = body?.messages?.[0]?.content || '';
  if (system.includes('interaction-appraisal sensor')) {
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      surface_vad: { valence: 0.2, arousal: 0.1, dominance: 0 },
      true_vad: { valence: 0.2, arousal: 0.1, dominance: 0 },
      tsundere_level: 0,
      confidence: 0.9,
      tags: [],
    }) } }), { status: 200 });
  }
  if (system.includes('Classify each numbered message')) {
    const content = classifyMode === 'invalid'
      ? '[]'
      : JSON.stringify([{ importance: 0.8, category: 'milestone', tags: ['retry'] }]);
    return new Response(JSON.stringify({ message: { content } }), { status: 200 });
  }
  throw new Error('unexpected mock request');
};
emotion.queueForVad(classifyText, classifyProject, classified.id);
let classifyRejected = false;
try {
  await emotion.flushVadQueue(classifyProject, { force: true });
} catch (error) {
  classifyRejected = true;
  console.log('  expected classify failure:', error.message);
}
check('malformed response rejects flush', classifyRejected);
check('malformed response requeues entry', emotion.vadQueueStatus(classifyProject).size === 1,
  JSON.stringify(emotion.vadQueueStatus(classifyProject)));
classifyMode = 'valid';
await emotion.flushVadQueue(classifyProject, { force: true });
const classifiedRow = classified.db.prepare('SELECT category, importance FROM memory WHERE id = ?').get(classified.id);
check('retry writes classification', classifiedRow?.category === 'milestone' && classifiedRow?.importance === 0.8,
  JSON.stringify(classifiedRow));
check('successful classification retry consumes entry', emotion.vadQueueStatus(classifyProject).size === 0);

// 3) Two consumers must share one in-flight flush, otherwise both can submit
// duplicate prompts before either one removes the queue snapshot.
console.log('\n3) concurrent flush is single-flight');
const concurrentProject = 'emotion-concurrent';
const concurrent = insertMemory(concurrentProject, '并发 flush 测试消息');
emotion.queueForVad('并发 flush 测试消息', concurrentProject, concurrent.id);
let modelCalls = 0;
globalThis.fetch = async (_url, init) => {
  modelCalls++;
  const body = JSON.parse(init?.body || '{}');
  const system = body?.messages?.[0]?.content || '';
  if (system.includes('interaction-appraisal sensor')) {
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      surface_vad: { valence: 0, arousal: 0, dominance: 0 },
      true_vad: { valence: 0, arousal: 0, dominance: 0 },
      tsundere_level: 0, confidence: 0.9, tags: [],
    }) } }), { status: 200 });
  }
  return new Response(JSON.stringify({ message: { content: JSON.stringify([
    { importance: 0.5, category: 'general', tags: [] },
  ]) } }), { status: 200 });
};
const [first, second] = await Promise.all([
  emotion.flushVadQueue(concurrentProject, { force: true }),
  emotion.flushVadQueue(concurrentProject, { force: true }),
]);
check('concurrent callers both settle', first === null || first?.confidence >= 0, String(first));
check('concurrent flush does not duplicate model calls', modelCalls === 2, `calls=${modelCalls}`);
check('concurrent flush consumes entry once', emotion.vadQueueStatus(concurrentProject).size === 0);

// 4) A reachable model that violates the VAD contract is not silently
// converted into local evidence. The queue remains retryable for inspection
// or a later model response.
console.log('\n4) malformed VAD contract is retryable');
const vadContractProject = 'emotion-vad-contract-failure';
const vadContract = insertMemory(vadContractProject, '模型返回越界 VAD');
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || '{}');
  const system = body?.messages?.[0]?.content || '';
  if (system.includes('interaction-appraisal sensor')) {
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      vad: { valence: 4, arousal: 0, dominance: 0 },
      confidence: 0.9,
      tags: [],
    }) } }), { status: 200 });
  }
  return new Response(JSON.stringify({ message: { content: JSON.stringify([
    { importance: 0.5, category: 'general', tags: [] },
  ]) } }), { status: 200 });
};
emotion.queueForVad('模型返回越界 VAD', vadContractProject, vadContract.id);
let vadContractRejected = false;
try {
  await emotion.flushVadQueue(vadContractProject, { force: true });
} catch (error) {
  vadContractRejected = true;
  console.log('  expected VAD contract failure:', error.message);
}
check('malformed VAD rejects flush', vadContractRejected);
check('malformed VAD requeues entry', emotion.vadQueueStatus(vadContractProject).size === 1,
  JSON.stringify(emotion.vadQueueStatus(vadContractProject)));

console.log(`\n[emotion-failure] ${pass} passed / ${fail} failed`);
DatabaseManager.close();
try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
