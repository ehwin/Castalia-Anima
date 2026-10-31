#!/usr/bin/env node
/**
 * tuning-support.json 契约测试（记忆+面板版）。
 *
 * 断言三件事：
 *  1. 清单里每个键都真的被引擎读（改 env → 行为/读数跟着变），不是"面板能存、引擎不看"；
 *  2. 清单里的 default 与不设 env 时的引擎默认一致（面板显示的就是实际生效值）；
 *  3. 没有情感状态机的变体不把 psyche 组写进清单（面板据此隐藏整组，而不是给一排死开关）。
 *
 * 用法：node scripts/test_tuning_surface.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tuning-support.json'), 'utf8'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-surface-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'missing.json');
process.env.EMBED_MODE = 'none';
process.env.CASTALIA_PROJECT = 'tuning-surface';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok    ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
};

let bust = 0;
async function loadFresh(file, env = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return import(pathToFileURL(path.join(DIST, file)).href + `?t=${++bust}`);
}

const row = {
  id: 'tune-row',
  text: '测试行',
  project: 'tuning-surface',
  character_id: 'default',
  tags: '[]',
  importance: 0.5,
  tier: 'standard',
  accessed_count: 0,
  emotional_impact: 8,
  // 三维修均值 ≥0.7 才满足 isHighEmotion（偏离加成的前提）
  vad_valence: 0.9,
  vad_arousal: 0.9,
  vad_dominance: 0.9,
  created_at: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
  last_accessed_at: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
};

// ── 1. 注入门槛：读数必须等于设置值 ───────────────────────────────────
const INJECT_ACCESSORS = {
  MEMORY_INJECT_MIN_SIM: 'injectionMinSimilarity',
  MEMORY_INJECT_MIN_SIM_LEXICAL: 'injectionMinSimilarityLexical',
  MEMORY_INJECT_STRONG: 'injectionStrongEvidence',
};

for (const [key, fnName] of Object.entries(INJECT_ACCESSORS)) {
  const spec = (manifest.groups.inject || []).find(s => s.key === key);
  check(`清单含 ${key}`, () => assert.ok(spec, 'missing from manifest'));
  if (!spec) continue;

  const off = await loadFresh('recallForInjection.js', { [key]: undefined });
  check(`${key} 未设 env 时取默认 ${spec.default}`, () => {
    assert.equal(Number(off[fnName]().toFixed(4)), Number(Number(spec.default).toFixed(4)));
  });

  const probe = Number(spec.default) + 0.1 <= Number(spec.max) ? Number(spec.default) + 0.1 : Number(spec.min);
  const on = await loadFresh('recallForInjection.js', { [key]: probe });
  check(`${key} 设 ${probe} 后读数跟着变`, () => {
    assert.equal(Number(on[fnName]().toFixed(4)), Number(probe.toFixed(4)));
  });
}

// ── 2. 检索权重：同一条记忆、不同权重 → 分数必须变 ─────────────────────
const WEIGHT_PROBES = {
  WEIGHT_CONSISTENCY: { env: { WEIGHT_CONSISTENCY: 0 }, other: { WEIGHT_CONSISTENCY: 2 }, similarity: 0.6 },
  WEIGHT_EMOTION: { env: { WEIGHT_EMOTION: 0 }, other: { WEIGHT_EMOTION: 2 }, similarity: 0.6 },
  WEIGHT_TIME: { env: { WEIGHT_TIME: 0 }, other: { WEIGHT_TIME: 1 }, similarity: 0.6 },
  // 偏离加成只在「低相似 + 高情绪」时触发
  WEIGHT_DEVIATION: { env: { WEIGHT_DEVIATION: 0 }, other: { WEIGHT_DEVIATION: 1 }, similarity: 0.1 },
};

for (const [key, probe] of Object.entries(WEIGHT_PROBES)) {
  const spec = (manifest.groups.search || []).find(s => s.key === key);
  check(`清单含 ${key}`, () => assert.ok(spec, 'missing from manifest'));
  if (!spec) continue;

  const a = await loadFresh('search.js', probe.env);
  const b = await loadFresh('search.js', probe.other);
  const scoreA = a.computeScore({ ...row }, probe.similarity, 'tuning-surface').score;
  const scoreB = b.computeScore({ ...row }, probe.similarity, 'tuning-surface').score;
  check(`${key}: 0 → ${scoreA} vs max → ${scoreB}（分数必须不同）`, () => {
    assert.notEqual(scoreA, scoreB);
  });
}

// ── 3. 不含 psyche：清单里不能出现状态机键 ─────────────────────────────
const allKeys = Object.values(manifest.groups).flat().map(s => s.key);
check('清单不含 PSYCHE_* / ANIMA_* 键', () => {
  const bad = allKeys.filter(k => k.startsWith('PSYCHE_') || k.startsWith('ANIMA_'));
  assert.deepEqual(bad, []);
});

// ── 4. 白名单外的一切都不在清单里 ──────────────────────────────────────
check('清单键总数 = 7（4 检索权重 + 3 注入门槛）', () => {
  assert.equal(allKeys.length, 7);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[tuning-surface] ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { for (const f of failures) console.error(' - ' + f); process.exit(1); }
