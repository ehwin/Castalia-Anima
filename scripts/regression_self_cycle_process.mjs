// Cross-process self-cycle regression. Run after `pnpm run build`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'store.js')) ? root : path.join(root, 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-self-cycle-process-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, '{}');
const project = 'self-cycle-process';
const characterId = 'cycle-character';
const env = {
  ...process.env,
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: project,
  CHAR_ID: characterId,
  SELF_CYCLE_INTERVAL_MINUTES: '0',
};
Object.assign(process.env, env);

const load = async name => import(pathToFileURL(path.join(distRoot, `${name}.js`)).href);
const { DatabaseManager } = await load('db');
const { saveMemory, saveSelfDiary } = await load('store');
const { runSelfCycle } = await load('selfCycle');

const evidence = await saveMemory({
  text: '跨进程回归：用户提到一盏蓝色台灯。',
  project,
  characterId,
  source: 'conversation_log',
  skipEmbed: true,
});

const childCode = `
  const { runSelfCycle } = await import(${JSON.stringify(pathToFileURL(path.join(distRoot, 'selfCycle.js')).href)});
  const result = await runSelfCycle({ project: ${JSON.stringify(project)}, characterId: ${JSON.stringify(characterId)}, hoursBack: 24, minIntervalHours: 0, limit: 20 });
  process.stdout.write(JSON.stringify(result));
`;

function runChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`));
      try {
        const jsonLine = stdout.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
        resolve(JSON.parse(jsonLine || stdout));
      }
      catch (error) { reject(new Error(`invalid child output: ${stdout}\n${stderr}\n${error.message}`)); }
    });
  });
}

const [first, second] = await Promise.all([runChild(), runChild()]);
assert.equal(first.ok, true, 'first process settles');
assert.equal(second.ok, true, 'second process settles');
assert.equal(Number(Boolean(first.diaryId)) + Number(Boolean(second.diaryId)), 1, 'one process creates the diary');
assert.ok(
  [first.reason, second.reason].some(reason => ['already_claimed', 'no_new_evidence'].includes(reason)),
  `losing process observes durable claim or advanced cursor: ${JSON.stringify([first, second])}`,
);

const projectDb = DatabaseManager.getInstance(project, 'project');
const diaries = projectDb.prepare(`
  SELECT id, metadata FROM memory
  WHERE project = ? AND character_id = ? AND source = 'agent_diary' AND is_active = 1
`).all(project, characterId);
assert.equal(diaries.length, 1, 'cross-process claim yields one active diary');
assert.equal(projectDb.prepare(`SELECT COUNT(*) AS c FROM self_cycle_runs WHERE project = ? AND character_id = ?`).get(project, characterId).c, 1, 'one durable run claim');
assert.equal(projectDb.prepare(`SELECT COUNT(*) AS c FROM memory WHERE source = 'conversation_log' AND project = ?`).get(project).c, 0, 'conversation evidence stays in general database');

// Same prose in a later cycle must remain a separate derived record when its
// evidence set changes; generic text de-duplication must not erase provenance.
const secondEvidence = await saveMemory({
  text: '跨进程回归：用户再次提到一盏蓝色台灯。',
  project,
  characterId,
  source: 'conversation_log',
  skipEmbed: true,
});
const sameTextA = await saveSelfDiary({
  text: '固定日记文本', project, characterId, evidenceIds: ['cycle-a'], stateVersion: 1,
  metadata: { evidence_key: 'cycle-a' },
});
const sameTextB = await saveSelfDiary({
  text: '固定日记文本', project, characterId, evidenceIds: ['cycle-b'], stateVersion: 1,
  metadata: { evidence_key: 'cycle-b' },
});
assert.notEqual(sameTextA.id, sameTextB.id, 'different evidence keys retain separate same-text diaries');
assert.equal(projectDb.prepare(`SELECT COUNT(*) AS c FROM memory WHERE source = 'agent_diary' AND text LIKE '%固定日记文本%' AND is_active = 1`).get().c, 2, 'same-text diaries keep provenance');

// A duplicate evidence key converges on the original row, even through the
// dedicated writer called from a fresh process.
const duplicate = await saveSelfDiary({
  text: '另一份文本', project, characterId, evidenceIds: ['cycle-a'], stateVersion: 2,
  metadata: { evidence_key: 'cycle-a' },
});
assert.equal(duplicate.id, sameTextA.id, 'duplicate evidence key returns the committed diary');

DatabaseManager.close();
console.log('PASS self-cycle process regression (10 checks)');
