/**
 * Independent self-cycle.
 *
 * It reads only conversation_log evidence plus the current short-term state,
 * then writes one explicitly marked diary memory. A diary is never a source
 * for this function, so the loop cannot amplify its own prose indefinitely.
 */
import { DatabaseManager } from './db.js';
import { normalizeCharacterId, normalizeProject } from './env.js';
import { getAgentState } from './agentState.js';
import { getPsycheState } from './psycheState.js';
import { getEarliestConversations, getConversationsAfter } from './digest.js';
import { saveSelfDiary } from './store.js';
import { compareEvidenceCursor, isAfterEvidenceCursor, maxEvidenceCursor, parseEvidenceTime } from './selfCycleCursor.js';
// Self-cycle is normally triggered by a timer, but MCP callers can invoke the
// same operation concurrently. Share one in-flight run per project/character
// so both callers cannot observe the same evidence watermark and write two
// diary rows. The durable evidence watermark below still protects retries
// after the promise has completed.
const selfCycleInFlight = new Map();
function selfCycleKey(project, characterId) {
    return `${project}|${characterId}`;
}
function evidenceKey(evidenceIds) {
    return Array.from(new Set(evidenceIds.map(String).filter(Boolean))).sort().join('\u001f');
}
function diaryForEvidenceKey(project, characterId, key) {
    if (!key)
        return null;
    try {
        const db = DatabaseManager.getInstance(project, 'project');
        const rows = db.prepare(`
      SELECT id, metadata
      FROM memory
      WHERE source = 'agent_diary' AND subject = 'self' AND project = ?
        AND character_id = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
    `).all(project, characterId);
        for (const row of rows) {
            try {
                const metadata = JSON.parse(String(row.metadata || '{}'));
                const rowKey = typeof metadata?.evidence_key === 'string'
                    ? metadata.evidence_key
                    : evidenceKey(Array.isArray(metadata?.evidence_ids) ? metadata.evidence_ids : []);
                if (rowKey === key)
                    return String(row.id);
            }
            catch { /* tolerate legacy or malformed diary metadata */ }
        }
    }
    catch { /* keep claim path retryable */ }
    return null;
}
function claimEvidenceSet(project, characterId, evidenceIds, watermark, now) {
    const key = evidenceKey(evidenceIds);
    if (!key)
        return 'failed';
    try {
        const db = DatabaseManager.getInstance(project, 'project');
        const inserted = db.prepare(`
      INSERT OR IGNORE INTO self_cycle_runs (
        project, character_id, evidence_key, evidence_watermark_created_at,
        evidence_watermark_rowid, claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(project, characterId, key, watermark?.createdAt || null, watermark?.rowid ?? null, now.toISOString());
        if (inserted.changes > 0) {
            // The claim row itself may have been lost by an operator while the
            // diary remained. Reconcile that durable diary before creating another.
            const existingDiaryId = diaryForEvidenceKey(project, characterId, key);
            if (existingDiaryId) {
                return completeEvidenceClaim(project, characterId, evidenceIds, existingDiaryId)
                    ? 'already_claimed' : 'failed';
            }
            return 'claimed';
        }
        // A process crash can leave an uncompleted claim. Allow a bounded reclaim
        // after one hour, while never reclaiming a completed diary run.
        const existing = db.prepare(`
      SELECT diary_id, claimed_at FROM self_cycle_runs
      WHERE project = ? AND character_id = ? AND evidence_key = ?
    `).get(project, characterId, key);
        if (existing?.diary_id)
            return 'already_claimed';
        // A crash may have committed the diary before claim completion. Recover
        // that durable write immediately instead of waiting for stale reclaim.
        const existingDiaryId = diaryForEvidenceKey(project, characterId, key);
        if (existingDiaryId) {
            return completeEvidenceClaim(project, characterId, evidenceIds, existingDiaryId)
                ? 'already_claimed' : 'failed';
        }
        const claimedAt = Date.parse(String(existing?.claimed_at || ''));
        if (Number.isFinite(claimedAt) && now.getTime() - claimedAt > 3600000) {
            const reclaimed = db.prepare(`
        UPDATE self_cycle_runs SET claimed_at = ?, evidence_watermark_created_at = ?, evidence_watermark_rowid = ?
        WHERE project = ? AND character_id = ? AND evidence_key = ?
          AND diary_id IS NULL AND claimed_at = ?
      `).run(now.toISOString(), watermark?.createdAt || null, watermark?.rowid ?? null, project, characterId, key, existing.claimed_at);
            return reclaimed.changes > 0 ? 'claimed' : 'already_claimed';
        }
        return 'already_claimed';
    }
    catch (error) {
        console.warn(`[self-cycle] evidence claim failed for ${project}|${characterId}: ${error?.message || error}`);
        return 'failed';
    }
}
function completeEvidenceClaim(project, characterId, evidenceIds, diaryId) {
    const key = evidenceKey(evidenceIds);
    if (!key || !diaryId)
        return false;
    try {
        const db = DatabaseManager.getInstance(project, 'project');
        const result = db.prepare(`
      UPDATE self_cycle_runs SET diary_id = ?
      WHERE project = ? AND character_id = ? AND evidence_key = ?
        AND (diary_id IS NULL OR diary_id = ?)
    `).run(diaryId, project, characterId, key, diaryId);
        if (result.changes > 0)
            return true;
        const row = db.prepare(`
      SELECT diary_id FROM self_cycle_runs
      WHERE project = ? AND character_id = ? AND evidence_key = ?
    `).get(project, characterId, key);
        return String(row?.diary_id || '') === diaryId;
    }
    catch (error) {
        console.warn(`[self-cycle] evidence claim completion failed for ${project}|${characterId}: ${error?.message || error}`);
        return false;
    }
}
function releaseEvidenceClaim(project, characterId, evidenceIds) {
    const key = evidenceKey(evidenceIds);
    try {
        DatabaseManager.getInstance(project, 'project').prepare(`
      DELETE FROM self_cycle_runs
      WHERE project = ? AND character_id = ? AND evidence_key = ? AND diary_id IS NULL
    `).run(project, characterId, key);
    }
    catch { /* leave the claim for stale reclaim */ }
}
/** Repair durable diary writes whose claim update was interrupted. */
function repairPendingClaims(project, characterId) {
    try {
        const db = DatabaseManager.getInstance(project, 'project');
        const rows = db.prepare(`
      SELECT evidence_key
      FROM self_cycle_runs
      WHERE project = ? AND character_id = ? AND diary_id IS NULL
    `).all(project, characterId);
        for (const row of rows) {
            const ids = String(row.evidence_key || '').split('\u001f').filter(Boolean);
            const diaryId = diaryForEvidenceKey(project, characterId, String(row.evidence_key || ''));
            if (diaryId && !completeEvidenceClaim(project, characterId, ids, diaryId)) {
                console.warn(`[self-cycle] could not repair completed diary claim for ${project}|${characterId}`);
            }
        }
    }
    catch (error) {
        console.warn(`[self-cycle] pending claim repair failed for ${project}|${characterId}: ${error?.message || error}`);
    }
}
function latestDiary(project, characterId) {
    try {
        const db = DatabaseManager.getInstance(project, 'project');
        const rows = db.prepare(`
      SELECT id, created_at AS createdAt, metadata
      FROM memory
      WHERE source = 'agent_diary' AND subject = 'self' AND project = ?
        AND character_id = ? AND is_active = 1
      ORDER BY datetime(created_at) DESC, rowid DESC
    `).all(project, characterId);
        const row = rows[0];
        // A diary can be soft-deleted by an operator. The durable completed claim
        // must still remain the cursor, otherwise the next cycle would treat the
        // same conversation rows as fresh evidence and recreate the diary.
        const completedClaims = db.prepare(`
      SELECT evidence_key, evidence_watermark_created_at AS watermarkCreatedAt,
             evidence_watermark_rowid AS watermarkRowid, claimed_at AS claimedAt, diary_id
      FROM self_cycle_runs
      WHERE project = ? AND character_id = ? AND diary_id IS NOT NULL
      ORDER BY claimed_at DESC
    `).all(project, characterId);
        if (!row && completedClaims.length === 0)
            return null;
        // Keep the union across diary entries. Using only the latest entry would
        // make an older conversation look new again after the next diary is made.
        const evidenceIds = new Set();
        let watermarkCreatedAt = null;
        let watermarkRowid = null;
        for (const item of rows) {
            try {
                const metadata = JSON.parse(String(item.metadata || '{}'));
                if (Array.isArray(metadata?.evidence_ids)) {
                    for (const id of metadata.evidence_ids.map(String).filter(Boolean))
                        evidenceIds.add(id);
                }
                const candidateCreatedAt = typeof metadata?.evidence_watermark_created_at === 'string'
                    ? metadata.evidence_watermark_created_at : null;
                const candidateRowid = Number(metadata?.evidence_watermark_rowid);
                if (candidateCreatedAt && (!watermarkCreatedAt
                    || compareEvidenceCursor({ createdAt: candidateCreatedAt, rowid: Number.isFinite(candidateRowid) ? candidateRowid : -1 }, { createdAt: watermarkCreatedAt, rowid: watermarkRowid ?? -1 }) > 0)) {
                    watermarkCreatedAt = candidateCreatedAt;
                    watermarkRowid = Number.isFinite(candidateRowid) && candidateRowid >= 0
                        ? Math.trunc(candidateRowid) : null;
                }
            }
            catch { /* tolerate legacy diary metadata */ }
        }
        for (const claim of completedClaims) {
            for (const id of String(claim.evidence_key || '').split('\u001f').filter(Boolean))
                evidenceIds.add(id);
            const candidateCreatedAt = typeof claim.watermarkCreatedAt === 'string' ? claim.watermarkCreatedAt : null;
            const candidateRowid = Number(claim.watermarkRowid);
            if (candidateCreatedAt && (!watermarkCreatedAt
                || compareEvidenceCursor({ createdAt: candidateCreatedAt, rowid: Number.isFinite(candidateRowid) ? candidateRowid : -1 }, { createdAt: watermarkCreatedAt, rowid: watermarkRowid ?? -1 }) > 0)) {
                watermarkCreatedAt = candidateCreatedAt;
                watermarkRowid = Number.isFinite(candidateRowid) && candidateRowid >= 0
                    ? Math.trunc(candidateRowid) : null;
            }
        }
        return {
            id: row?.id || completedClaims[0]?.diary_id || '',
            createdAt: row?.createdAt || completedClaims[0]?.claimedAt || '',
            evidenceIds, watermarkCreatedAt, watermarkRowid,
        };
    }
    catch {
        return null;
    }
}
function formatDiary(state, psyche, conversations) {
    const ownMood = state.currentMood >= 0 ? `+${state.currentMood.toFixed(1)}` : state.currentMood.toFixed(1);
    const interaction = psyche.hasEvidence
        ? `v=${psyche.vad.valence.toFixed(2)} a=${psyche.vad.arousal.toFixed(2)} d=${psyche.vad.dominance.toFixed(2)}`
        : 'unknown（暂无已分析的互动证据）';
    const recent = conversations
        .slice()
        .reverse()
        .slice(0, 3)
        .map(row => String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 240))
        .filter(Boolean);
    const lines = [
        '[自循环日记]',
        `角色自我状态：情绪指数 ${ownMood}；精力：${state.energy}/100。`,
        `本轮互动状态估计：${psyche.hasEvidence ? psyche.band : 'unknown'}（${interaction}）。这是互动传感器估计，不是用户事实。`,
    ];
    if (state.currentDesire)
        lines.push(`当前倾向：${state.currentDesire}。`);
    if (recent.length > 0) {
        lines.push('近期互动记录：');
        for (const item of recent)
            lines.push(`- ${item}`);
    }
    lines.push('记录用途：整理当前状态与近期互动，供后续检索参考；不作为用户事实或新的情绪事件。');
    return lines.join('\n');
}
/** Run one bounded self-cycle. It is opt-in and safe to call periodically. */
async function runSelfCycleOnce(options = {}) {
    const project = normalizeProject(options.project);
    const characterId = normalizeCharacterId(options.characterId);
    const now = options.now || new Date();
    const minIntervalHours = Math.max(0, Number(options.minIntervalHours ?? 6) || 0);
    repairPendingClaims(project, characterId);
    const previous = latestDiary(project, characterId);
    if (previous) {
        const previousTime = parseEvidenceTime(previous.createdAt);
        const age = Number.isFinite(previousTime) ? now.getTime() - previousTime : Number.NaN;
        if (age >= 0 && age < minIntervalHours * 3600000) {
            return { ok: true, skipped: true, reason: 'interval', evidenceIds: [], project };
        }
    }
    const hoursBack = Math.max(1, Math.min(24 * 30, Number(options.hoursBack ?? 48) || 48));
    const limit = Math.max(1, Math.min(20, options.limit ?? 6));
    const conversations = previous?.watermarkCreatedAt && Number.isFinite(previous.watermarkRowid ?? NaN)
        ? getConversationsAfter(characterId, { createdAt: previous.watermarkCreatedAt, rowid: previous.watermarkRowid }, hoursBack, limit, project, now.getTime())
        : getEarliestConversations(characterId, hoursBack, limit, project, now.getTime());
    const previousCursor = previous?.watermarkCreatedAt && Number.isFinite(previous.watermarkRowid ?? NaN)
        ? { createdAt: previous.watermarkCreatedAt, rowid: previous.watermarkRowid }
        : null;
    const evidence = previous
        ? conversations.filter(row => {
            const cursor = { createdAt: String(row.created_at || ''), rowid: Number(row.rowid) };
            const afterWatermark = previousCursor
                ? isAfterEvidenceCursor(cursor, previousCursor)
                : parseEvidenceTime(cursor.createdAt) > parseEvidenceTime(previous.createdAt);
            return afterWatermark && !previous.evidenceIds.has(String(row.id));
        })
        : conversations;
    if (evidence.length === 0) {
        return {
            ok: true,
            skipped: true,
            reason: previous ? 'no_new_evidence' : 'no_conversations',
            evidenceIds: [],
            project,
        };
    }
    const state = getAgentState(characterId, project).getSnapshot();
    const psyche = getPsycheState(characterId, project);
    const evidenceIds = evidence.map(row => String(row.id)).filter(Boolean);
    const watermark = maxEvidenceCursor(evidence.map(row => ({
        createdAt: String(row.created_at || ''),
        rowid: Number(row.rowid),
    })));
    const claim = claimEvidenceSet(project, characterId, evidenceIds, watermark, now);
    if (claim === 'already_claimed') {
        return { ok: true, skipped: true, reason: 'already_claimed', evidenceIds: [], project };
    }
    if (claim === 'failed') {
        return { ok: false, skipped: true, reason: 'claim_failed', evidenceIds: [], project };
    }
    let diary;
    try {
        diary = await saveSelfDiary({
            text: formatDiary(state, psyche, evidence),
            project,
            characterId,
            evidenceIds,
            stateVersion: psyche.version,
            metadata: {
                evidence_key: evidenceKey(evidenceIds),
                ...(watermark ? {
                    evidence_watermark_created_at: watermark.createdAt,
                    evidence_watermark_rowid: watermark.rowid,
                } : {}),
            },
        });
    }
    catch (error) {
        releaseEvidenceClaim(project, characterId, evidenceIds);
        throw error;
    }
    if (!completeEvidenceClaim(project, characterId, evidenceIds, diary.id)) {
        // The diary is durable and carries its evidence key, so a later run can
        // repair the claim. Surface the failure to callers instead of pretending
        // the durable cursor advanced.
        return { ok: false, skipped: false, reason: 'claim_failed', diaryId: diary.id, evidenceIds, project };
    }
    return { ok: true, skipped: false, diaryId: diary.id, evidenceIds, project };
}
/** Serialize concurrent callers for one project/character pair. */
export function runSelfCycle(options = {}) {
    const project = normalizeProject(options.project);
    const characterId = normalizeCharacterId(options.characterId);
    const key = selfCycleKey(project, characterId);
    const existing = selfCycleInFlight.get(key);
    if (existing)
        return existing;
    const task = runSelfCycleOnce(options);
    let tracked;
    tracked = task.finally(() => {
        if (selfCycleInFlight.get(key) === tracked)
            selfCycleInFlight.delete(key);
    });
    selfCycleInFlight.set(key, tracked);
    return tracked;
}
//# sourceMappingURL=selfCycle.js.map