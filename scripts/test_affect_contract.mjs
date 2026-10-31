import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (f) => path.join(root, 'dist', f);
for (const f of ['emotion.js', 'psycheState.js', 'emotionalRanking.js']) {
  if (!fs.existsSync(dist(f))) {
    console.error(`[affect-contract] dist/${f} missing; run npm run build first`);
    process.exit(2);
  }
}
const emotion = await import(pathToFileURL(dist('emotion.js')).href);
const psyche = await import(pathToFileURL(dist('psycheState.js')).href);
const rank = await import(pathToFileURL(dist('emotionalRanking.js')).href);

const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
};

// ── 量尺：词表 arousal 0..1 → psyche −1..1，0.5 是中性点 ──
check('lexicon 0..1 arousal maps to bipolar around 0.5', () => {
  // 0 = 没有任何唤醒线索 → 这一维不更新（不是"极度平静"）
  assert.equal(emotion.lexiconArousalToBipolar({ arousal: 0 }).arousal, undefined);
  assert.equal(emotion.lexiconArousalToBipolar({ arousal: 0.5 }).arousal, 0);
  assert.equal(emotion.lexiconArousalToBipolar({ arousal: 1 }).arousal, 1);
  // 单调 + 越界夹紧
  assert.ok(emotion.lexiconArousalToBipolar({ arousal: 0.75 }).arousal >
            emotion.lexiconArousalToBipolar({ arousal: 0.25 }).arousal);
  assert.equal(emotion.lexiconArousalToBipolar({ arousal: 2 }).arousal, 1);
  // 其他维度不动
  const v = emotion.lexiconArousalToBipolar({ valence: -0.4, arousal: 0.5, dominance: 0.2 });
  assert.equal(v.valence, -0.4);
  assert.equal(v.dominance, 0.2);
});

// ── 夜间倍率 / 傲娇减速默认停用：同一段过去不能被查询时刻重新解释 ──
check('night multiplier is off by default (same age, same result)', () => {
  const day = emotion.computeDecay({ valence: 0, arousal: 1, dominance: 1 }, 24, 0, false);
  const night = emotion.computeDecay({ valence: 0, arousal: 1, dominance: 1 }, 24, 0, true);
  assert.deepEqual(night, day, 'isNight must not change decay unless ANIMA_NIGHT_DECAY=1');
});

check('tsundere level does not change decay by default', () => {
  const calm = emotion.computeDecay({ valence: 1, arousal: 1, dominance: 1 }, 24, 0, false);
  const tsundere10 = emotion.computeDecay({ valence: 1, arousal: 1, dominance: 1 }, 24, 10, false);
  assert.deepEqual(tsundere10, calm, 'tsundereLevel must not move decay unless ANIMA_TSUNDERE_DECAY=1');
});

check('switches still work when explicitly enabled', () => {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(dist('emotion.js')).href)});
    const d = m.computeDecay({valence:0,arousal:1,dominance:1},24,10,false);
    const n = m.computeDecay({valence:0,arousal:1,dominance:1},24,10,true);
    console.log(JSON.stringify({day:d.vad,night:n.vad}));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ANIMA_NIGHT_DECAY: '1', ANIMA_TSUNDERE_DECAY: '1' }, encoding: 'utf8',
  }));
  assert.ok(out.night.arousal < out.day.arousal * 1e-2, `night arousal must decay much faster when enabled (day=${out.day.arousal}, night=${out.night.arousal})`);
  assert.ok(out.night.dominance > out.day.dominance, 'night dominance decays slower when enabled');
});

// ── 两套时钟的量纲确实不同：τ（e^-1）vs 半衰期（0.5）──
check('memory tau and psyche half-life are different quantities', () => {
  const legacy24 = emotion.computeDecay({ valence: 1, arousal: 0, dominance: 0 }, 24, 0, false).vad.valence;
  assert.ok(Math.abs(legacy24 - Math.exp(-1)) < 1e-9, `expected e^-1≈0.3679, got ${legacy24}`);
  const seeded = { ...psyche.createPsycheState({ valence: 0.4, arousal: 0.3, dominance: 0.6 }, 0),
    vad: { valence: 1, arousal: 0.3, dominance: 0.6 } };
  // 慢层关掉再断言：两层结构下快层朝**心境**回归，t=H 时不会正好减去一半
  // （心境被情绪推高，反向拉回；实测比例 ≈0.35）。这条断言要守的是「参数语义是 H
  // 不是 τ」，所以必须在纯单层下测。
  process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS = '0';
  let after;
  try {
    after = psyche.transitionPsycheState(seeded, { kind: 'no_event' }, 24 * 3600000, { halfLifeHours: { valence: 24 } });
  } finally {
    delete process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS;
  }
  const devBefore = 1 - 0.4, devAfter = after.vad.valence - 0.4;
  assert.ok(Math.abs(devAfter - devBefore / 2) < 1e-9, `half-life must halve the deviation, got ${devAfter}`);
});

// ── 注入策略：skip 与 context-only 都不该进注入块 ──
check('policyAllowsInjection excludes skip and context-only', () => {
  assert.equal(rank.policyAllowsInjection('always'), true);
  assert.equal(rank.policyAllowsInjection('inject'), true);
  assert.equal(rank.policyAllowsInjection('context-only'), false);
  assert.equal(rank.policyAllowsInjection('skip'), false);
  const mood = { valence: -0.5, arousal: 0.2 };
  assert.equal(rank.injectionPolicy(0.1, { mood }), 'skip');
  assert.equal(rank.injectionPolicy(0.45, { mood }), 'context-only');
  assert.equal(rank.injectionPolicy(0.45, { mood: { valence: 0.2, arousal: 0 } }), 'inject');
  assert.equal(rank.injectionPolicy(0.2, { pinned: true, mood }), 'always');
});

// ── 记录当前行为（不是目标，只是防止静默漂移）──
check('bjork fusion still has a 61.5% floor at storage=1', () => {
  assert.ok(Math.abs(rank.bjorkStrength({ storage: 1, retrieval: 0 }) - 0.615) < 1e-9);
});

// ── 精力独立时钟：改 mood/desire 不再凭空恢复精力 ──
const { getAgentState } = await import(pathToFileURL(dist('agentState.js')).href);
check('energy has its own clock; desire/mood writes do not restore it', () => {
  const s = getAgentState('__test_energy__', '__test_affect__');
  s.energy = 100;
  s.energyUpdatedAt = Date.now() - 24 * 3600 * 1000;   // 空闲 24h
  const idle = s.getCurrentEnergy();
  assert.ok(idle > 25 && idle < 35, `24h idle should be ≈30, got ${idle}`);
  s.setDesire('想听更多故事');                          // 旧实现会在这里把时间戳按回 now → 读回 100
  assert.equal(s.getCurrentEnergy(), idle, 'setDesire must not change the energy reading');
  s.boostEnergy(0);                                    // 先结算再叠加：+0 不该回血
  assert.ok(Math.abs(s.getCurrentEnergy() - idle) <= 1, 'boostEnergy(0) must not restore energy');
  s.boostEnergy(20);
  assert.ok(s.getCurrentEnergy() > idle + 15, 'a real boost should raise energy above the decayed value');
});

if (process.exitCode) process.exit(process.exitCode);
