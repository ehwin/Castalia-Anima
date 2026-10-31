import { normalizeCharacterId, normalizeProject } from './env.js';
import { DatabaseManager } from './db.js';
export const DEFAULT_PSYCHE_BASELINE = {
    valence: 0.4,
    arousal: 0.3,
    dominance: 0.6,
};
/** 3× the valence half-life: leftover deviation is ~12%, i.e. no longer an observation. */
export const DEFAULT_EVIDENCE_TTL_HOURS = 72;
function envNumber(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) ? raw : fallback;
}
/**
 * Runtime tuning. The constants below started as placeholders: the audit says
 * half-life and thresholds must come from a replay/calibration set, so every
 * one of them is overridable from the environment instead of needing a rebuild.
 */
export function readPsycheTuning() {
    return {
        baseline: {
            valence: envNumber('PSYCHE_BASELINE_VALENCE', DEFAULT_PSYCHE_BASELINE.valence),
            arousal: envNumber('PSYCHE_BASELINE_AROUSAL', DEFAULT_PSYCHE_BASELINE.arousal),
            dominance: envNumber('PSYCHE_BASELINE_DOMINANCE', DEFAULT_PSYCHE_BASELINE.dominance),
        },
        halfLife: {
            valence: envNumber('PSYCHE_HALF_LIFE_VALENCE_HOURS', DEFAULT_HALF_LIFE.valence),
            arousal: envNumber('PSYCHE_HALF_LIFE_AROUSAL_HOURS', DEFAULT_HALF_LIFE.arousal),
            dominance: envNumber('PSYCHE_HALF_LIFE_DOMINANCE_HOURS', DEFAULT_HALF_LIFE.dominance),
        },
        targetGain: envNumber('PSYCHE_TARGET_GAIN', 0.55),
        eventGain: envNumber('PSYCHE_EVENT_GAIN', 0.35),
        bandEnter: envNumber('PSYCHE_BAND_ENTER', 0.25),
        bandHold: envNumber('PSYCHE_BAND_HOLD', 0.1),
        evidenceTtlHours: envNumber('PSYCHE_EVIDENCE_TTL_HOURS', DEFAULT_EVIDENCE_TTL_HOURS),
    };
}
const psycheStates = new Map();
const loadedKeys = new Set();
const loadWarnings = new Set();
const persistWarnings = new Set();
const DEFAULT_HALF_LIFE = {
    valence: 24,
    arousal: 4,
    dominance: 36,
};
function clamp(value, min = -1, max = 1) {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}
function finite(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function bandFor(valence, baselineValence, previous, enter, hold) {
    // Hysteresis prevents a model hovering around a boundary from changing the
    // externally visible label on every turn.
    //
    // The label is measured against the personality baseline, not against zero:
    // the default baseline is +0.40, so an absolute ±0.25 threshold could never
    // be re-crossed by decay (it converges on 0.40 → permanently "positive",
    // and a negative event used to flip to "positive" after ~10 days of silence).
    const rel = valence - baselineValence;
    if (previous === 'positive' && rel > hold)
        return 'positive';
    if (previous === 'negative' && rel < -hold)
        return 'negative';
    if (rel >= enter)
        return 'positive';
    if (rel <= -enter)
        return 'negative';
    return 'neutral';
}
function decay(current, baseline, elapsedHours, halfLife) {
    if (elapsedHours <= 0 || halfLife <= 0)
        return current;
    const factor = Math.pow(0.5, elapsedHours / halfLife);
    return baseline + (current - baseline) * factor;
}
export function createPsycheState(baseline = {}, now = Date.now()) {
    const tuning = readPsycheTuning();
    const b = {
        valence: clamp(finite(baseline.valence) ?? tuning.baseline.valence),
        arousal: clamp(finite(baseline.arousal) ?? tuning.baseline.arousal),
        dominance: clamp(finite(baseline.dominance) ?? tuning.baseline.dominance),
    };
    return {
        version: 1,
        hasEvidence: false,
        lastEvidenceAt: -1,
        baseline: b,
        vad: { ...b },
        // Personality baseline is not an observed affect event. Keep the visible
        // band neutral until a real appraisal arrives.
        band: 'neutral',
        updatedAt: now,
        processedEventIds: [],
    };
}
/** Apply time decay and, for valid new events, an inertial signed impact. */
export function transitionPsycheState(previous, appraisal, now = Date.now(), options = {}) {
    // Event delivery can be delayed or replayed after a restart. Never let an
    // older event move the state clock backwards, otherwise a later read would
    // apply the same decay twice.
    const effectiveNow = Math.max(Number.isFinite(now) ? now : Date.now(), previous.updatedAt);
    const elapsedHours = Math.max(0, effectiveNow - previous.updatedAt) / 3600000;
    const tuning = readPsycheTuning();
    const halfLife = { ...tuning.halfLife, ...(options.halfLifeHours || {}) };
    const decayed = {
        valence: decay(previous.vad.valence, previous.baseline.valence, elapsedHours, halfLife.valence),
        arousal: decay(previous.vad.arousal, previous.baseline.arousal, elapsedHours, halfLife.arousal),
        dominance: decay(previous.vad.dominance, previous.baseline.dominance, elapsedHours, halfLife.dominance),
    };
    const seen = new Set(previous.processedEventIds);
    // TypeScript callers are constrained to AppraisalKind, but model adapters
    // and JavaScript callers can still pass arbitrary status strings. An
    // untrusted status must never become affect evidence. `neutral` is an
    // explicit valid observation; `valid` leaves the kind semantics intact.
    const runtimeStatus = typeof appraisal.status === 'string' ? appraisal.status.trim().toLowerCase() : undefined;
    const statusAccepted = runtimeStatus === undefined || runtimeStatus === ''
        || runtimeStatus === 'valid' || runtimeStatus === 'neutral';
    const effectiveKind = runtimeStatus === 'neutral' ? 'neutral' : appraisal.kind;
    const eventId = typeof appraisal.eventId === 'string' ? appraisal.eventId.trim() : '';
    const duplicate = Boolean(eventId && seen.has(eventId));
    const validEvidence = statusAccepted
        && (effectiveKind === 'event' || effectiveKind === 'target' || effectiveKind === 'neutral');
    const shouldApply = validEvidence && !duplicate;
    // Absolute sensor targets need to cross a band boundary on the first clear
    // reading. Signed event impacts are intentionally slower: they are already
    // deltas around the current state, so applying the target gain to them would
    // make one noisy turn dominate the short-term psyche. Callers can still
    // provide eventGain when a source has its own calibration.
    const gain = clamp(finite(options.eventGain) ?? (effectiveKind === 'target' ? tuning.targetGain : tuning.eventGain), 0, 1);
    const next = { ...decayed };
    if (shouldApply) {
        if (effectiveKind === 'neutral') {
            // An explicit neutral observation is evidence, but carries no signed
            // delta even when an adapter accidentally supplied one alongside the
            // runtime status marker.
        }
        else if (effectiveKind === 'target') {
            // Model VAD prompts commonly describe the current observed state, not an
            // incremental impact. A bounded error step prevents repeated batches from
            // accumulating the same absolute reading toward a rail.
            const target = appraisal.target || {};
            const targetValence = finite(target.valence);
            const targetArousal = finite(target.arousal);
            const targetDominance = finite(target.dominance);
            if (targetValence !== undefined)
                next.valence = clamp(next.valence + gain * (clamp(targetValence) - next.valence));
            if (targetArousal !== undefined)
                next.arousal = clamp(next.arousal + gain * (clamp(targetArousal) - next.arousal));
            if (targetDominance !== undefined)
                next.dominance = clamp(next.dominance + gain * (clamp(targetDominance) - next.dominance));
        }
        else {
            next.valence = clamp(next.valence + gain * (finite(appraisal.delta?.valence) ?? 0));
            next.arousal = clamp(next.arousal + gain * (finite(appraisal.delta?.arousal) ?? 0));
            next.dominance = clamp(next.dominance + gain * (finite(appraisal.delta?.dominance) ?? 0));
        }
        if (eventId) {
            seen.add(eventId);
            const max = Math.max(1, Math.floor(options.maxProcessedEvents ?? 128));
            while (seen.size > max) {
                const oldest = previous.processedEventIds.find(id => seen.has(id));
                if (!oldest)
                    break;
                seen.delete(oldest);
            }
        }
    }
    const processedEventIds = [...seen];
    // An absolute target is still observed evidence. Without this branch the
    // Ollama path could move `vad` while callers kept treating the state as
    // sensor-empty and fell back to the unrelated AgentState mood scalar.
    //
    // Evidence also has a shelf life: `updatedAt` follows reads (decay), so it
    // cannot answer "when was the last real observation". Without an expiry the
    // first appraisal owns the visible band forever and AgentState mood never
    // gets the state back, even after days of pure `abstain`.
    const evidenceTtlHours = finite(options.evidenceTtlHours) !== undefined
        ? Math.max(1, Number(options.evidenceTtlHours))
        : Math.max(1, tuning.evidenceTtlHours);
    // -1 means "never observed"; 0 is a legitimate timestamp in tests and replays.
    const evidenceAgeHours = previous.lastEvidenceAt >= 0
        ? (effectiveNow - previous.lastEvidenceAt) / 3600000
        : Number.POSITIVE_INFINITY;
    const evidenceFresh = previous.hasEvidence && evidenceAgeHours <= evidenceTtlHours;
    const observedNow = statusAccepted
        && (effectiveKind === 'event' || effectiveKind === 'target' || effectiveKind === 'neutral');
    const hasEvidence = observedNow || evidenceFresh;
    const lastEvidenceAt = shouldApply ? effectiveNow : previous.lastEvidenceAt;
    const holdNeutralBand = previous.hasEvidence
        && previous.band === 'neutral'
        && effectiveKind === 'no_event';
    const newlyObservedNeutral = effectiveKind === 'neutral' && shouldApply;
    const duplicateNeutral = effectiveKind === 'neutral' && duplicate;
    return {
        version: previous.version + (shouldApply ? 1 : 0),
        hasEvidence,
        lastEvidenceAt,
        baseline: { ...previous.baseline },
        vad: next,
        band: hasEvidence
            ? (newlyObservedNeutral
                ? 'neutral'
                : duplicateNeutral
                    ? previous.band
                    : holdNeutralBand
                        ? 'neutral'
                        : bandFor(next.valence, previous.baseline.valence, previous.band, tuning.bandEnter, tuning.bandHold))
            : 'neutral',
        updatedAt: effectiveNow,
        processedEventIds,
    };
}
function stateKey(characterId, project) {
    return `${normalizeProject(project)}|${normalizeCharacterId(characterId)}`;
}
function cloneState(state) {
    return {
        ...state,
        baseline: { ...state.baseline },
        vad: { ...state.vad },
        processedEventIds: [...state.processedEventIds],
    };
}
function parsePersistedStateRow(row) {
    if (!row)
        return null;
    const baseline = {
        valence: clamp(Number(row.baseline_valence)),
        arousal: clamp(Number(row.baseline_arousal)),
        dominance: clamp(Number(row.baseline_dominance)),
    };
    const vad = {
        valence: clamp(Number(row.vad_valence)),
        arousal: clamp(Number(row.vad_arousal)),
        dominance: clamp(Number(row.vad_dominance)),
    };
    let processed = [];
    try {
        const parsed = JSON.parse(String(row.processed_event_ids || '[]'));
        if (Array.isArray(parsed))
            processed = parsed.map(String).filter(Boolean).slice(-128);
    }
    catch { /* recover from malformed event history */ }
    const updatedAt = Number(row.updated_at);
    const hasEvidence = Number(row.has_evidence) === 1;
    const storedEvidenceAt = Number(row.last_evidence_at);
    return {
        version: Math.max(1, Number(row.version) || 1),
        hasEvidence,
        // Rows written before the column existed still need a usable clock; the
        // persisted `updated_at` only moves on accepted appraisals, so it is the
        // closest available answer.
        lastEvidenceAt: Number.isFinite(storedEvidenceAt) && storedEvidenceAt >= 0
            ? storedEvidenceAt
            : (hasEvidence && Number.isFinite(updatedAt) ? updatedAt : -1),
        baseline,
        vad,
        band: row.band === 'positive' || row.band === 'negative' ? row.band : 'neutral',
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        processedEventIds: processed,
    };
}
function readPersistedStateFromDb(db, characterId, project) {
    const row = db.prepare(`
    SELECT version, has_evidence, baseline_valence, baseline_arousal, baseline_dominance,
           vad_valence, vad_arousal, vad_dominance, band, updated_at, last_evidence_at, processed_event_ids
    FROM psyche_state WHERE project = ? AND character_id = ?
  `).get(project, characterId);
    return parsePersistedStateRow(row);
}
function readPersistedState(characterId, project) {
    const proj = normalizeProject(project);
    try {
        return { state: readPersistedStateFromDb(DatabaseManager.getInstance(proj, 'general'), characterId, proj), failed: false };
    }
    catch (error) {
        const key = stateKey(characterId, project);
        if (!loadWarnings.has(key)) {
            loadWarnings.add(key);
            console.warn(`[psyche] persisted state load failed for ${key}: ${error?.message || error}`);
        }
        // Keep this retryable. A transient native binding/database-open failure
        // must not permanently pin the process to a fresh in-memory state.
        return { state: null, failed: true };
    }
}
function persistState(characterId, project, state) {
    const proj = normalizeProject(project);
    try {
        DatabaseManager.getInstance(proj, 'general').prepare(`
      INSERT INTO psyche_state (
        project, character_id, version, has_evidence,
        baseline_valence, baseline_arousal, baseline_dominance,
        vad_valence, vad_arousal, vad_dominance, band, updated_at, last_evidence_at, processed_event_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, character_id) DO UPDATE SET
        version = excluded.version,
        has_evidence = excluded.has_evidence,
        baseline_valence = excluded.baseline_valence,
        baseline_arousal = excluded.baseline_arousal,
        baseline_dominance = excluded.baseline_dominance,
        vad_valence = excluded.vad_valence,
        vad_arousal = excluded.vad_arousal,
        vad_dominance = excluded.vad_dominance,
        band = excluded.band,
        updated_at = excluded.updated_at,
        last_evidence_at = excluded.last_evidence_at,
        processed_event_ids = excluded.processed_event_ids
    `).run(proj, characterId, state.version, state.hasEvidence ? 1 : 0, state.baseline.valence, state.baseline.arousal, state.baseline.dominance, state.vad.valence, state.vad.arousal, state.vad.dominance, state.band, state.updatedAt, state.lastEvidenceAt, JSON.stringify(state.processedEventIds));
        persistWarnings.delete(stateKey(characterId, project));
        return true;
    }
    catch (error) {
        const key = stateKey(characterId, project);
        if (!persistWarnings.has(key)) {
            persistWarnings.add(key);
            console.warn(`[psyche] persisted state write failed for ${key}: ${error?.message || error}`);
        }
        // Legacy/read-only stores can still use the in-process state path, but the
        // warning makes the loss of restart durability observable.
        return false;
    }
}
/** Process-local sensor state. It is separate from AgentState's explicit moodValue channel. */
export function getPsycheState(characterId, project, now = Date.now()) {
    characterId = normalizeCharacterId(characterId);
    const key = stateKey(characterId, project);
    let state = psycheStates.get(key);
    if (!loadedKeys.has(key)) {
        const candidate = readPersistedState(characterId, project);
        if (candidate.state) {
            state = candidate.state;
            loadedKeys.add(key);
            loadWarnings.delete(key);
        }
        else {
            // Keep an existing in-memory state after a transient load failure, but
            // leave the key unmarked so the next read can retry durability.
            state = state || createPsycheState({}, now);
            if (!candidate.failed)
                loadedKeys.add(key);
        }
        psycheStates.set(key, state);
    }
    if (!state)
        state = createPsycheState({}, now);
    // Decay is observable even when no new event arrives. Keep the decayed value
    // in memory but do not write on every read: context_get/search/reply can all
    // read this path many times per turn. The persisted timestamp remains the
    // last durable event; a later read or event applies the same elapsed decay,
    // so restart behavior stays mathematically equivalent without write
    // amplification.
    if (now > state.updatedAt) {
        state = transitionPsycheState(state, { kind: 'no_event' }, now);
        psycheStates.set(key, state);
    }
    return cloneState(state);
}
/**
 * Append one row per accepted appraisal. Retention is bounded so the history
 * cannot grow without limit inside the general database.
 */
function recordPsycheEvent(db, project, characterId, base, next, appraisal) {
    const retentionDays = Math.max(1, envNumber('PSYCHE_EVENT_RETENTION_DAYS', 90));
    try {
        const eventId = typeof appraisal.eventId === 'string' ? appraisal.eventId : null;
        db.prepare(`
      INSERT INTO psyche_events (
        project, character_id, at, kind, event_id,
        from_valence, from_arousal, from_dominance,
        to_valence, to_arousal, to_dominance,
        baseline_valence, band, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project, characterId, next.updatedAt, String(appraisal.kind || 'unknown'), eventId, base.vad.valence, base.vad.arousal, base.vad.dominance, next.vad.valence, next.vad.arousal, next.vad.dominance, next.baseline.valence, next.band, next.version);
        db.prepare('DELETE FROM psyche_events WHERE project = ? AND character_id = ? AND at < ?')
            .run(project, characterId, Date.now() - retentionDays * 86400000);
    }
    catch (error) {
        // History is observability, not correctness: never fail the transition.
        const key = `${project}|${characterId}`;
        if (!persistWarnings.has(key)) {
            persistWarnings.add(key);
            console.warn(`[psyche] event history write failed for ${key}: ${error?.message || error}`);
        }
    }
}
export function applyPsycheAppraisal(characterId, project, appraisal, now = Date.now(), options = {}) {
    characterId = normalizeCharacterId(characterId);
    const key = stateKey(characterId, project);
    const proj = normalizeProject(project);
    let next = null;
    let persisted = false;
    try {
        // Serialize the complete read/transition/write sequence across processes.
        // Without an IMMEDIATE transaction, two workers can both read version N,
        // apply different events, and let the last upsert erase the first event
        // from both the VAD snapshot and processed_event_ids.
        const db = DatabaseManager.getInstance(proj, 'general');
        db.exec('BEGIN IMMEDIATE');
        try {
            const durable = readPersistedStateFromDb(db, characterId, proj);
            const cached = psycheStates.get(key);
            const base = durable || cached || createPsycheState({}, now);
            next = transitionPsycheState(base, appraisal, now, options);
            db.prepare(`
        INSERT INTO psyche_state (
          project, character_id, version, has_evidence,
          baseline_valence, baseline_arousal, baseline_dominance,
          vad_valence, vad_arousal, vad_dominance, band, updated_at, last_evidence_at, processed_event_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, character_id) DO UPDATE SET
          version = excluded.version,
          has_evidence = excluded.has_evidence,
          baseline_valence = excluded.baseline_valence,
          baseline_arousal = excluded.baseline_arousal,
          baseline_dominance = excluded.baseline_dominance,
          vad_valence = excluded.vad_valence,
          vad_arousal = excluded.vad_arousal,
          vad_dominance = excluded.vad_dominance,
          band = excluded.band,
          updated_at = excluded.updated_at,
          last_evidence_at = excluded.last_evidence_at,
          processed_event_ids = excluded.processed_event_ids
      `).run(proj, characterId, next.version, next.hasEvidence ? 1 : 0, next.baseline.valence, next.baseline.arousal, next.baseline.dominance, next.vad.valence, next.vad.arousal, next.vad.dominance, next.band, next.updatedAt, next.lastEvidenceAt, JSON.stringify(next.processedEventIds));
            if (next.version > base.version)
                recordPsycheEvent(db, proj, characterId, base, next, appraisal);
            db.exec('COMMIT');
            persisted = true;
        }
        catch (error) {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* transaction may not have started */ }
            throw error;
        }
    }
    catch (error) {
        // Preserve the old in-process fallback behavior for legacy/read-only
        // stores, while making the durability failure visible to callers that
        // explicitly require it.
        if (!next)
            next = transitionPsycheState(getPsycheState(characterId, project, now), appraisal, now, options);
        const warningKey = stateKey(characterId, project);
        if (!persistWarnings.has(warningKey)) {
            persistWarnings.add(warningKey);
            console.warn(`[psyche] persisted state write failed for ${warningKey}: ${error?.message || error}`);
        }
    }
    psycheStates.set(key, next);
    if (persisted)
        loadedKeys.add(key);
    else {
        loadedKeys.delete(key);
        if (options.requirePersistence) {
            throw new Error(`psyche state persistence failed for ${stateKey(characterId, project)}`);
        }
    }
    return cloneState(next);
}
export function appraisalFromVAD(vad, eventId) {
    if (!vad)
        return { kind: 'unknown', eventId };
    const values = [finite(vad.valence), finite(vad.arousal), finite(vad.dominance)];
    if (values.some(value => value === undefined))
        return { kind: 'invalid', eventId };
    if (values.every(value => Math.abs(value) < 0.05))
        return { kind: 'neutral', eventId };
    return {
        kind: 'event',
        eventId,
        delta: { valence: values[0], arousal: values[1], dominance: values[2] },
    };
}
/** Convert a model's absolute VAD reading into a bounded target appraisal. */
export function targetAppraisalFromVAD(vad, eventId) {
    if (!vad)
        return { kind: 'unknown', eventId };
    const values = [finite(vad.valence), finite(vad.arousal), finite(vad.dominance)];
    if (values.some(value => value === undefined))
        return { kind: 'invalid', eventId };
    if (values.every(value => Math.abs(value) < 0.05))
        return { kind: 'neutral', eventId };
    return {
        kind: 'target',
        eventId,
        target: { valence: values[0], arousal: values[1], dominance: values[2] },
    };
}
//# sourceMappingURL=psycheState.js.map