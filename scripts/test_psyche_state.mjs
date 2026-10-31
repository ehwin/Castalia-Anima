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
  assert.ok(strongTarget.vad.valence <= -0.25);
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
check('neutral event is idempotent and cannot erase a later affect band on replay', () => {
  assert.equal(neutralAfterEvent.version, event.version + 1);
  assert.equal(neutralAfterEvent.band, 'neutral');
  assert.equal(duplicateNeutral.version, neutralAfterEvent.version);
  assert.equal(duplicateNeutral.band, 'neutral');
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
  assert.ok(Math.abs(recovered.vad.valence - baseline.baseline.valence) < 0.001);
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
  assert.ok(Math.abs(afterRead.vad.valence - afterRead.baseline.valence) < 0.001);
});

check('VAD appraisal distinguishes neutral, unknown and invalid', () => {
  assert.equal(psyche.appraisalFromVAD({ valence: 0, arousal: 0, dominance: 0 }).kind, 'neutral');
  assert.equal(psyche.appraisalFromVAD(null).kind, 'unknown');
  assert.equal(psyche.appraisalFromVAD({ valence: 0, arousal: 0 }).kind, 'invalid');
});

if (process.exitCode) process.exit(process.exitCode);
