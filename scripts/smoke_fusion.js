/**
 * 数据层融合冒烟测试(临时文件,可删除)
 * 验证:分库 schema + 情感列 + 默认分类 + saveMemory emotionalImpact + recordTopics + search 情感字段
 * 运行:node scripts/smoke_fusion.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testMemDir = path.join(root, 'scripts', '.test-memory-fusion');

process.env.MEMORY_DB_DIR = testMemDir;

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${detail ? ' :: ' + detail : ''}`);
}

try {
  fs.rmSync(testMemDir, { recursive: true, force: true });
  fs.mkdirSync(testMemDir, { recursive: true });

  const { DatabaseManager, listProjectNames } = await import('../dist/db.js');
  const { saveMemory, updateMemory } = await import('../dist/store.js');
  const { searchMemory } = await import('../dist/search.js');
  const { CHAR_ID, PROJECT_ID, normalizeProject, SERVER_NAME } = await import('../dist/env.js');
  const { getBiases } = await import('../dist/bias.js');

  check('env.CHAR_ID = airi', CHAR_ID === 'airi', CHAR_ID);
  check('env.SERVER_NAME = castalia-anima', SERVER_NAME === 'castalia-anima', SERVER_NAME);
  check('env.PROJECT_ID = default', PROJECT_ID === 'default', PROJECT_ID);
  check('env.normalizeProject("  ") → default', normalizeProject('  ') === 'default');

  const db = DatabaseManager.getInstance('alpha');
  const memCols = (db.prepare('PRAGMA table_info(memory)').all()).map((c) => c.name);
  for (const col of ['emotional_impact', 'agent_mood', 'agent_desire', 'vad_valence', 'vad_arousal', 'vad_dominance', 'tsundere_level', 'project', 'session_id', 'mem_type', 'tier', 'locked']) {
    check(`memory 列 ${col}`, memCols.includes(col));
  }

  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_memory_vad_valence','idx_memory_tsundere')").all()).map((r) => r.name);
  check('索引 idx_memory_vad_valence', idx.includes('idx_memory_vad_valence'));
  check('索引 idx_memory_tsundere', idx.includes('idx_memory_tsundere'));

  const cats = (db.prepare("SELECT name FROM categories").all()).map((r) => r.name);
  check('分类 emotional', cats.includes('emotional'));
  check('分类 mood_snapshot', cats.includes('mood_snapshot'));

  const projects = listProjectNames();
  check('listProjectNames 含 alpha', projects.includes('alpha'), JSON.stringify(projects));

  const r = await saveMemory({
    text: '那天晚上我哭到半夜，因为他说要离开这座城市',
    project: 'alpha',
    category: 'emotional',
    tags: ['离别', '伤心', '深夜'],
    emotionalImpact: 8.5,
    importance: 0.8,
    characterId: CHAR_ID,
    skipEmbed: true,
  });
  check('saveMemory 返回 emotionalImpact', r.emotionalImpact === 8.5, String(r.emotionalImpact));
  const stored = db.prepare('SELECT emotional_impact, vad_valence, tsundere_level, agent_mood FROM memory WHERE id = ?').get(r.id);
  check('落库 emotional_impact = 8.5', stored.emotional_impact === 8.5, String(stored.emotional_impact));
  check('落库 vad_valence NULL(尚未 VAD)', stored.vad_valence === null);

  const biases = getBiases(CHAR_ID);
  check('recordTopics 学习成功(离别/伤心)', biases.some((b) => b.topic === '离别'), JSON.stringify(biases));

  const upd = await updateMemory(r.id, { emotionalImpact: 9.0, project: 'alpha' });
  const stored2 = db.prepare('SELECT emotional_impact FROM memory WHERE id = ?').get(r.id);
  check('updateMemory 更新 emotional_impact', upd !== null && stored2.emotional_impact === 9.0, String(stored2.emotional_impact));

  const hits = await searchMemory({ query: '离别 伤心', project: 'alpha', characterId: CHAR_ID });
  check('searchMemory 返回结果', hits.length > 0);
  if (hits.length > 0) {
    check('SearchResult 含 emotionalImpact', 'emotionalImpact' in hits[0], String(hits[0].emotionalImpact));
    check('SearchResult 含 agentMood/agentDesire/biasBoost',
      'agentMood' in hits[0] && 'agentDesire' in hits[0] && 'biasBoost' in hits[0]);
    check('search 情感评分 > 0', hits[0].score > 0, String(hits[0].score));
  }

  DatabaseManager.close();
  fs.rmSync(testMemDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('SMOKE TEST ERROR:', e);
  try { DatabaseManager.close(); } catch {}
  try { fs.rmSync(testMemDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
