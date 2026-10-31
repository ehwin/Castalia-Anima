import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modPath = path.join(root, 'dist', 'psycheState.js');
if (!fs.existsSync(modPath)) {
  console.error('[psyche-state] dist/psycheState.js missing; run npm run build first');
  process.exit(2);
}
const psyche = await import(pathToFileURL(modPath).href);

const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

const baseline = psyche.createPsycheState({}, 0);
check('baseline has no observed band', () => {
  assert.equal(baseline.hasEvidence, false);
  assert.equal(baseline.band, 'neutral');
});

check('unknown, invalid and no_event do not create evidence', () => {
  for (const kind of ['unknown', 'invalid', 'no_event']) {
    const next = psyche.transitionPsycheState(baseline, { kind }, 0);
    assert.equal(next.hasEvidence, false);
    assert.deepEqual(next.vad, baseline.vad);
  }
});

check('runtime-invalid appraisal status cannot advance state or consume event id', () => {
  const next = psyche.transitionPsycheState(baseline, {
    kind: 'event', status: 'invalid', eventId: 'runtime-invalid',
    delta: { valence: -1, arousal: 1, dominance: -1 },
  }, 3600000);
  assert.equal(next.hasEvidence, false);
  assert.equal(next.version, baseline.version);
  assert.deepEqual(next.processedEventIds, []);
  assert.ok(next.updatedAt >= baseline.updatedAt);
});

check('runtime-neutral status is an explicit neutral observation', () => {
  const next = psyche.transitionPsycheState(baseline, {
    kind: 'event', status: 'neutral', eventId: 'runtime-neutral',
    delta: { valence: -1 },
  }, 0);
  assert.equal(next.hasEvidence, true);
  assert.equal(next.band, 'neutral');
  assert.deepEqual(next.vad, baseline.vad);
});

const neutral = psyche.transitionPsycheState(baseline, { kind: 'neutral', eventId: 'n1' }, 0);
check('neutral is evidence but does not move VAD', () => {
  assert.equal(neutral.hasEvidence, true);
  assert.deepEqual(neutral.vad, baseline.vad);
});

const event = psyche.transitionPsycheState(neutral, {
  kind: 'event',
  eventId: 'e1',
  delta: { valence: 1, arousal: 0.5, dominance: -0.5 },
}, 3600000);
check('event applies bounded inertial delta', () => {
  assert.ok(event.vad.valence > baseline.vad.valence);
  assert.ok(event.vad.arousal > baseline.vad.arousal);
  assert.ok(event.vad.dominance < baseline.vad.dominance);
  assert.equal(event.band, 'positive');
});

const target1 = psyche.transitionPsycheState(neutral, {
  kind: 'target',
  eventId: 't1',
  target: { valence: -1, arousal: 1, dominance: -1 },
}, 0, { eventGain: 0.35 });
const target2 = psyche.transitionPsycheState(target1, {
  kind: 'target',
  eventId: 't2',
  target: { valence: -1, arousal: 1, dominance: -1 },
}, 0, { eventGain: 0.35 });
check('absolute target readings converge without accumulating past the target', () => {
  assert.equal(target1.hasEvidence, true);
  assert.equal(target2.hasEvidence, true);
  assert.ok(target1.vad.valence < neutral.vad.valence);
  assert.ok(target2.vad.valence < target1.vad.valence);
  assert.ok(target2.vad.valence >= -1);
  assert.ok(target2.vad.arousal <= 1);
  assert.ok(target2.vad.dominance >= -1);
  assert.equal(psyche.targetAppraisalFromVAD({ valence: -0.8, arousal: 0.5, dominance: 0 }).kind, 'target');
});

const strongTarget = psyche.transitionPsycheState(baseline, {
  kind: 'target',
  eventId: 'strong-negative',
  target: { valence: -0.8, arousal: 0.8, dominance: -0.4 },
}, 0);
check('first strong target crosses the negative band', () => {
  // 单步限幅（maxStep=0.35）是「一件事只能把状态推这么远」。从 +0.40 起步，单步最低
  // 到 +0.05 —— 所以旧断言 `vad ≤ −0.25` 是加限幅之前的数字，现在物理上达不到。
  // 要守的性质有两条：跨进 negative band；位移不超过单步上限（不是被削到不动）。
  const moved = strongTarget.baseline.valence - strongTarget.vad.valence;
  assert.ok(moved > 0.3, `must move decisively: ${moved}`);
  assert.ok(moved <= 0.35 + 1e-9, `must not exceed maxStep: ${moved}`);
  assert.equal(strongTarget.band, 'negative');
});

const duplicate = psyche.transitionPsycheState(event, {
  kind: 'event',
  eventId: 'e1',
  delta: { valence: -1, arousal: -1, dominance: -1 },
}, 7200000);
check('duplicate event id is idempotent while time still decays', () => {
  assert.ok(duplicate.vad.valence < event.vad.valence);
  assert.ok(duplicate.vad.valence > baseline.vad.valence);
});

const neutralAfterEvent = psyche.transitionPsycheState(event, {
  kind: 'neutral',
  eventId: 'neutral-after-event',
}, 3600000);
const duplicateNeutral = psyche.transitionPsycheState(neutralAfterEvent, {
  kind: 'neutral',
  eventId: 'neutral-after-event',
}, 7200000);
check('neutral event is idempotent and does not erase an existing affect band', () => {
  // 2026-10-31 语义变更：事件级 `neutral`（这一轮没有情绪事件）只刷新证据、不改标签。
  // 原来它会把 band 直接写成 neutral，于是「被伤到之后来一句中性的日常话」会把
  // negative/positive 标签清掉（vad 仍是负的，标签却变中性，index.ts 再按中性返回 0）。
  // 需要「她现在确实回到基线」时用 kind:'state_neutral'（见文件末尾的用例）。
  assert.equal(neutralAfterEvent.version, event.version + 1);
  assert.equal(neutralAfterEvent.band, event.band);
  assert.equal(duplicateNeutral.version, neutralAfterEvent.version);
  assert.equal(duplicateNeutral.band, neutralAfterEvent.band);
});

const positiveThenReplayNeutral = psyche.transitionPsycheState(neutralAfterEvent, {
  kind: 'event', eventId: 'positive-after-neutral', delta: { valence: 1 },
}, 3600000, { eventGain: 1 });
const replayedNeutral = psyche.transitionPsycheState(positiveThenReplayNeutral, {
  kind: 'neutral', eventId: 'neutral-after-event',
}, 3600000);
check('replayed neutral does not reset a positive state', () => {
  assert.equal(positiveThenReplayNeutral.band, 'positive');
  assert.equal(replayedNeutral.band, 'positive');
});

const monotonic = psyche.transitionPsycheState(positiveThenReplayNeutral, {
  kind: 'no_event',
}, 1);
check('late event cannot move updatedAt backwards', () => {
  assert.equal(monotonic.updatedAt, positiveThenReplayNeutral.updatedAt);
});

const held = psyche.transitionPsycheState(event, {
  kind: 'event',
  eventId: 'e2',
  delta: { valence: -0.19 },
}, 3600000, { eventGain: 1 });
check('band hysteresis holds a positive label just below the entry threshold', () => {
  // Bands are measured against the personality baseline now, so the hold zone is
  // baseline +0.10 .. +0.25 rather than an absolute 0.10 .. 0.25.
  const rel = held.vad.valence - held.baseline.valence;
  assert.ok(rel > 0.1 && rel < 0.25);
  assert.equal(held.band, 'positive');
});

const recovered = psyche.transitionPsycheState(event, { kind: 'no_event' }, 3600000 * 240);
check('long elapsed time returns toward personality baseline', () => {
  // 同样的两层理由：240h 后剩下的是心境尾巴（τs→H≈45.75h → ≈2.7%），不是卡住。
  const dev0 = Math.abs(event.vad.valence - baseline.baseline.valence);
  const dev1 = Math.abs(recovered.vad.valence - baseline.baseline.valence);
  assert.ok(dev1 < dev0 * 0.05, `should be back near the baseline: ${dev0} → ${dev1}`);
});

// Regression: bands used to be absolute, so a baseline of +0.40 sat above the
// +0.25 entry threshold and every decay converged on "positive" — a negative
// event turned into "偏正向" after ~10 days of silence.
check('decayed baseline is neutral, not positive', () => {
  assert.equal(recovered.band, 'neutral');
  assert.equal(recovered.hasEvidence, false);
});

check('a negative event cannot decay into a positive label', () => {
  const neg = psyche.transitionPsycheState(baseline, {
    kind: 'target', eventId: 'neg-target', target: { valence: -0.9 },
  }, 1000);
  assert.equal(neg.band, 'negative');
  const later = psyche.transitionPsycheState(neg, { kind: 'no_event' }, 1000 + 3600000 * 240);
  assert.equal(later.band, 'neutral');
  assert.equal(later.hasEvidence, false);
});

check('evidence expiry is configurable and hands the band back to neutral', () => {
  const fresh = psyche.transitionPsycheState(baseline, {
    kind: 'event', eventId: 'ttl-event', delta: { valence: 1 },
  }, 0, { eventGain: 1, evidenceTtlHours: 6 });
  assert.equal(fresh.hasEvidence, true);
  assert.equal(fresh.band, 'positive');
  const within = psyche.transitionPsycheState(fresh, { kind: 'no_event' }, 3600000 * 3, { evidenceTtlHours: 6 });
  assert.equal(within.hasEvidence, true);
  const expired = psyche.transitionPsycheState(within, { kind: 'no_event' }, 3600000 * 9, { evidenceTtlHours: 6 });
  assert.equal(expired.hasEvidence, false);
  assert.equal(expired.band, 'neutral');
});

const readKey = 'test-read-decay';
psyche.applyPsycheAppraisal(readKey, 'test', {
  kind: 'event',
  eventId: 'read-event',
  delta: { valence: -1 },
}, 0, { eventGain: 1 });
const beforeRead = psyche.getPsycheState(readKey, 'test', 0);
const afterRead = psyche.getPsycheState(readKey, 'test', 3600000 * 240);
check('state decays when read without a new event', () => {
  assert.ok(beforeRead.vad.valence < beforeRead.baseline.valence);
  const dev0 = Math.abs(beforeRead.vad.valence - beforeRead.baseline.valence);
  const dev1 = Math.abs(afterRead.vad.valence - afterRead.baseline.valence);
  // 两层结构（2026-10-31 起默认开启）里，快层回到心境、心境按 τs→H≈45.75h 才回人格基线，
  // 所以 240h 后残留的是**心境**的尾巴（≈2.7%），不是「状态卡住」。断言改成
  // 「几乎全部回落」而不是绝对 0.001，否则会跟慢层结构打架。
  assert.ok(dev1 < dev0 * 0.05, `expected near-total decay, dev ${dev0} → ${dev1}`);
});

check('单层（关闭慢层）时读一次就精确回到基线', () => {
  process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS = '0';
  try {
    const k = 'test-read-decay-single';
    psyche.applyPsycheAppraisal(k, 'test', { kind: 'event', eventId: 'e', delta: { valence: -1 } }, 0, { eventGain: 1 });
    const later = psyche.getPsycheState(k, 'test', 3600000 * 240);
    assert.ok(Math.abs(later.vad.valence - later.baseline.valence) < 1e-9);
  } finally {
    delete process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS;
  }
});

check('VAD appraisal distinguishes neutral, unknown and invalid', () => {
  assert.equal(psyche.appraisalFromVAD({ valence: 0, arousal: 0, dominance: 0 }).kind, 'neutral');
  assert.equal(psyche.appraisalFromVAD(null).kind, 'unknown');
  assert.equal(psyche.appraisalFromVAD({ valence: 0, arousal: 0 }).kind, 'invalid');
});

// ── 2026-10-31：缺失值 / 事件级 neutral / 状态观测（复核报告 P0）──

check('null and empty-string dims are not zero observations', () => {
  const s = psyche.transitionPsycheState(baseline, {
    kind: 'target', eventId: 'null-dims',
    target: { valence: null, arousal: '', dominance: undefined },
  }, 3600000, { eventGain: 0.55 });
  assert.deepEqual(s.vad, baseline.vad, 'missing dims must leave the dimension untouched');
});

const negativeState = psyche.transitionPsycheState(baseline, {
  kind: 'target', eventId: 'neg-1',
  target: { valence: -1, arousal: 0.7, dominance: -0.4 },
}, 0, { eventGain: 0.55 });

check('a fresh event-level neutral does not clear a negative band', () => {
  assert.equal(negativeState.band, 'negative');
  const afterNeutral = psyche.transitionPsycheState(negativeState, { kind: 'neutral', eventId: 'n-fresh' }, 3600000);
  assert.equal(afterNeutral.band, 'negative', 'neutral event = zero impact, not "she is calm now"');
  assert.ok(afterNeutral.vad.valence < afterNeutral.baseline.valence);
});

check('state_neutral is an observation toward the baseline and sets a neutral band', () => {
  const s = psyche.transitionPsycheState(negativeState, { kind: 'state_neutral', eventId: 'sn-1' }, 0, { eventGain: 1 });
  assert.equal(s.band, 'neutral');
  assert.equal(s.hasEvidence, true);
  // 朝向的是**人格基线**（0.40），不是 0 —— 这正是这条观测要防的 bug。
  const dev0 = Math.abs(negativeState.vad.valence - negativeState.baseline.valence);
  const dev1 = Math.abs(s.vad.valence - s.baseline.valence);
  assert.ok(s.vad.valence > negativeState.vad.valence, 'state must move up toward the baseline');
  assert.ok(dev1 < dev0 * 0.6, `one observation closes most of the gap: ${dev0} → ${dev1}`);
  assert.ok(s.vad.valence > 0, 'must not collapse to zero: the baseline is +0.40, not 0');
  // 反复观测（每次都是一次证据）才允许收敛到基线：惯性项会折价反向位移，单步不到 1e-9。
  let cur = negativeState;
  for (let i = 0; i < 40; i++) cur = psyche.transitionPsycheState(cur, { kind: 'state_neutral', eventId: `sn-${i}` }, 0, { eventGain: 1 });
  assert.ok(Math.abs(cur.vad.valence - cur.baseline.valence) < 0.01, `repeated observations converge, got ${cur.vad.valence}`);
});

check('abstain status never creates evidence or moves state', () => {
  const s = psyche.transitionPsycheState(baseline, {
    kind: 'event', status: 'abstain', eventId: 'ab-1', delta: { valence: -1 },
  }, 0);
  assert.equal(s.hasEvidence, false);
  assert.deepEqual(s.vad, baseline.vad);
  assert.equal(s.version, baseline.version);
});

check('absoluteMoodScalar ignores the relative band', () => {
  // v=+0.10 相对基线 .40 是负向，但绝对值仍是 +1 —— 两种量必须分开读
  assert.equal(psyche.absoluteMoodScalar({ valence: 0.1, arousal: 0.3, dominance: 0.6 }), 1);
  assert.equal(psyche.absoluteMoodScalar({ valence: 0, arousal: 0, dominance: 0 }), 0);
  assert.equal(psyche.absoluteMoodScalar({ valence: NaN, arousal: 0, dominance: 0 }), undefined);
});

check('deviationMoodScalar is the retrieval channel (not the display one)', () => {
  const baselineVad = { valence: 0.4, arousal: 0.3, dominance: 0.6 };
  // 平时 = 0（不偏向任何一类记忆）；显示仍是 +4
  assert.equal(psyche.deviationMoodScalar({ ...baselineVad }, baselineVad), 0);
  assert.equal(psyche.absoluteMoodScalar(baselineVad), 4);
  // 略低于平时：deviation −3，绝对值 +1 —— 两个通道给出不同且都合理的结果
  assert.equal(psyche.deviationMoodScalar({ valence: 0.1, arousal: 0.3, dominance: 0.6 }, baselineVad), -3);
  assert.equal(psyche.absoluteMoodScalar({ valence: 0.1, arousal: 0.3, dominance: 0.6 }), 1);
  assert.equal(psyche.deviationMoodScalar({ valence: NaN, arousal: 0, dominance: 0 }, baselineVad), undefined);
});

check('band is measured against the baseline, not against zero', () => {
  const slightlyPositive = { ...baseline, hasEvidence: true, lastEvidenceAt: 0, updatedAt: 0,
    band: 'neutral', vad: { valence: 0.1, arousal: 0.3, dominance: 0.6 } };
  const next = psyche.transitionPsycheState(slightlyPositive, { kind: 'event', eventId: 'z', delta: {} }, 0);
  assert.equal(next.band, 'negative', 'v=.10 vs baseline .40 → −.30 → negative (documented semantics)');
});

check('partial VAD is rejected by default but allowed explicitly', () => {
  // 缺维度默认整条拒收，绝不把缺失当成 0
  assert.equal(psyche.targetAppraisalFromVAD({ valence: -0.5, dominance: 0.1 }, 'x').kind, 'invalid');
  // 词表这类只有部分维度证据的传感器显式放行，只有给出的维度参与更新
  const partial = psyche.targetAppraisalFromVAD({ valence: -0.5, dominance: 0.1 }, 'y', { allowPartial: true });
  assert.equal(partial.kind, 'target');
  assert.equal(partial.target.valence, -0.5);
  assert.equal(partial.target.dominance, 0.1);
  assert.equal('arousal' in partial.target, false);
  // 一个维度都没有 → unknown（不是中性票）
  assert.equal(psyche.targetAppraisalFromVAD({}, 'z', { allowPartial: true }).kind, 'unknown');
});

// ── 2026-10-31 评审 P1/P2-1：老库 NULL mood 与旧形状 state ──────────────

check('没有 mood 字段的旧 state 不抛错（退化成单层）', () => {
  const legacy = { ...baseline };
  delete legacy.mood;
  const next = psyche.transitionPsycheState(legacy, { kind: 'no_event' }, 3600000);
  assert.ok(Number.isFinite(next.vad.valence));
  assert.ok(Number.isFinite(next.mood.valence));
});

// 升级前的库：ALTER TABLE 加的 mood_* 全是 NULL。`Number(null) === 0` 是有限值，
// 所以这里必须落回人格基线，不能被读成「心境=0」（评审 P1）。用 upsert，重复跑也成立。
const dbmod = await import(pathToFileURL(path.join(root, 'dist', 'db.js')).href);
const testDb = dbmod.DatabaseManager.getInstance('test');
testDb.prepare(`
  INSERT INTO psyche_state (
    project, character_id, version, has_evidence,
    baseline_valence, baseline_arousal, baseline_dominance,
    vad_valence, vad_arousal, vad_dominance,
    band, updated_at, last_evidence_at, processed_event_ids, salience,
    mood_valence, mood_arousal, mood_dominance
  ) VALUES ('test', 'legacy-mood', 1, 1, 0.4, 0.3, 0.6, 0.32, 0.28, 0.55, 'neutral', ?, ?, '[]', 0, NULL, NULL, NULL)
  ON CONFLICT(project, character_id) DO UPDATE SET
    mood_valence = NULL, mood_arousal = NULL, mood_dominance = NULL,
    baseline_valence = 0.4, baseline_arousal = 0.3, baseline_dominance = 0.6,
    vad_valence = 0.32, vad_arousal = 0.28, vad_dominance = 0.55,
    updated_at = excluded.updated_at, has_evidence = 1
`).run(Date.now(), Date.now());

check('老库 mood_* 为 NULL 时读回人格基线，而不是 0', () => {
  const legacy = psyche.getPsycheState('legacy-mood', 'test', Date.now() + 60_000);
  // 1 分钟的松弛会往 vad(0.32) 挪一点点，所以用容差；关键是**不是 0**。
  assert.ok(Math.abs(legacy.mood.valence - 0.4) < 0.01, `mood.valence=${legacy.mood.valence}`);
  assert.ok(Math.abs(legacy.mood.arousal - 0.3) < 0.01, `mood.arousal=${legacy.mood.arousal}`);
  assert.ok(Math.abs(legacy.mood.dominance - 0.6) < 0.01, `mood.dominance=${legacy.mood.dominance}`);
  assert.ok(legacy.mood.valence > 0.3, '不能被读成 0（Number(null)==0 的坑）');
  assert.ok(Math.abs(legacy.vad.valence - 0.4) < 0.15, `vad 不该被拽到 0 附近: ${legacy.vad.valence}`);
});

if (process.exitCode) process.exit(process.exitCode);
