/**
 * 记忆整理 — sigmoid 时间衰减 + reference_count 升华
 *
 * 去重完全交给大模型 reflect 接口做语义判断，consolidate 只做纯规则维护：
 * - Phase 1: sigmoid 时间衰减 → 旧记忆自动降权，低于阈值软删除
 * - Phase 2: reference_count 升华 → 被反复引用的记忆重要性提升
 *
 * v1.10: findSimilarCandidates — 记忆整合(Memory Consolidator)的向量预筛候选。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { cosineSimilarity } from './ollama.js';
import { isEmbedEnabled, normalizeProject, CHAR_ID } from './env.js';
const ACTIVATION_THRESHOLD = 0.15;
// ═══ v1.10: 记忆整合候选预筛配置(env 可配;config.json 的 consolidate.similarity 会覆盖) ═══
export const CONSOLIDATE_SIMILARITY = (() => {
    const v = parseFloat(process.env.CONSOLIDATE_SIMILARITY || '0.88');
    return Number.isFinite(v) && v > 0 ? v : 0.88;
})();
/**
 * v1.11 结构兜底候选:反思/摘要写出的"报告式"记忆(表头形如 `# User Profile: …`)表头相同、内容各异,
 * 实测组内向量余弦中位 0.55、词袋重叠 0.06 —— 纯语义预筛(0.88)抓不到,这类"看着像重复"的记忆
 * 永远进不了 LLM 裁决。这里按 (memType + `# 表头`) 分桶补候选:每桶以最长的一条为锚,最多 N 对,
 * 判断权仍完全交给 LLM(它可以判"不是重复")。设 0 关闭。
 */
export const CONSOLIDATE_BUCKET_PAIRS = (() => {
    const v = parseInt(process.env.CONSOLIDATE_BUCKET_PAIRS || '3', 10);
    return Number.isFinite(v) && v >= 0 ? v : 3;
})();
/** v1.23.1: 给结构兜底候选预留名额，避免语义候选占满 limit 后同表头重复永远进不了裁决。 */
export const CONSOLIDATE_BUCKET_RESERVE = (() => {
    const v = parseInt(process.env.CONSOLIDATE_BUCKET_RESERVE || '15', 10);
    return Number.isFinite(v) && v >= 0 ? v : 15;
})();
/** 候选对数上限,防止相似爆炸 */
export const CONSOLIDATE_MAX_PAIRS = (() => {
    const v = parseInt(process.env.CONSOLIDATE_MAX_PAIRS || '50', 10);
    return Number.isFinite(v) && v > 0 ? v : 50;
})();
/**
 * v1.10: 向量预筛相似记忆对(cos 相似度 > threshold)。
 * - EMBED_MODE=none → 直接返回 [] (LLM 全量扫兜底)
 * - vec0 虚拟表禁止 JOIN:先对每条记忆做 KNN 取候选 rowid,再二段过滤 project/locked
 * - 每对去重(不重复 idA/idB、不反向),数量上限 limit 防爆炸
 */
/** v1.11.2 单个 memType 库的语义预筛(向量 KNN);候选并入共享 seen/pairs。 */
function scanVectorPairs(db, proj, threshold, limit, seen, pairs, characterId = CHAR_ID) {
    const cid = characterId || CHAR_ID;
    const mems = db.prepare(`
    SELECT m.rowid, m.id FROM memory m
    WHERE m.is_active = 1 AND m.project = ? AND (? = 'any' OR m.character_id = ?) AND (m.locked IS NULL OR m.locked = 0)
      AND COALESCE(m.tier, 'standard') <> 'critical'
      AND COALESCE(m.status, '') NOT IN ('cold', 'superseded')
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(proj, cid, cid);
    if (mems.length < 2)
        return;
    const rowidList = mems.map(m => Number(m.rowid));
    let vecRows = [];
    try {
        vecRows = db.prepare(`
      SELECT rowid, embedding FROM vec_memory WHERE rowid IN (${rowidList.map(() => '?').join(',')})
    `).all(...rowidList);
    }
    catch {
        return;
    }
    if (vecRows.length < 2)
        return;
    const memByRowid = new Map();
    for (const m of mems)
        memByRowid.set(Number(m.rowid), m.id);
    const vecByRowid = new Map();
    for (const r of vecRows) {
        const b = r.embedding;
        vecByRowid.set(Number(r.rowid), Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)));
    }
    if (vecByRowid.size < 2)
        return;
    const scanK = Math.min(20, mems.length);
    for (const m of mems) {
        const rowid = Number(m.rowid);
        const vec = vecByRowid.get(rowid);
        if (!vec)
            continue;
        let knn = [];
        try {
            knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
      `).all(new Float32Array(vec), scanK);
        }
        catch {
            continue;
        }
        for (const n of knn) {
            const nRowid = Number(n.rowid);
            if (nRowid === rowid)
                continue;
            // 二段过滤:只保留同项目 active 记忆(locked 已排除)的邻居
            const otherId = memByRowid.get(nRowid);
            if (!otherId)
                continue;
            const otherVec = vecByRowid.get(nRowid);
            if (!otherVec)
                continue;
            const sim = cosineSimilarity(vec, otherVec);
            if (sim < threshold)
                continue;
            const a = m.id;
            const b = otherId;
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            pairs.push({ idA: a, idB: b, similarity: Math.round(sim * 1000) / 1000 });
            if (pairs.length >= limit)
                return;
        }
    }
}
/** v1.11.2 单个 memType 库的结构兜底(同 `# 表头` 分桶);由 findSimilarCandidates 跨库调度。 */
function scanStructPairs(db, proj, limit, seen, pairs, characterId = CHAR_ID) {
    const cid = characterId || CHAR_ID;
    // ═══ v1.11 结构兜底:同 `# 表头` + 同 memType 分桶补候选(similarity 记 0 = 结构配对,非语义相似)═══
    if (CONSOLIDATE_BUCKET_PAIRS > 0 && pairs.length < limit) {
        let rows2 = [];
        try {
            rows2 = db.prepare(`
        SELECT id, text, mem_type FROM memory
        WHERE is_active = 1 AND project = ? AND (? = 'any' OR character_id = ?) AND (locked IS NULL OR locked = 0)
          AND COALESCE(tier, 'standard') <> 'critical'
          AND COALESCE(status, '') NOT IN ('cold', 'superseded')
        ORDER BY created_at DESC LIMIT 500
      `).all(proj, cid, cid);
        }
        catch {
            rows2 = [];
        }
        const buckets = new Map();
        for (const r of rows2) {
            const mm = /^\s*#\s*([^:\n·]{2,26})/.exec(String(r.text || ''));
            if (!mm)
                continue;
            const head = mm[1].replace(/\s+/g, ' ').trim();
            if (!head)
                continue;
            const key = String(r.mem_type || 'general') + '\u0000' + head;
            if (!buckets.has(key))
                buckets.set(key, []);
            buckets.get(key).push(r);
        }
        for (const [, arr] of buckets) {
            if (arr.length < 2)
                continue;
            const sorted = arr.slice().sort((a, b) => String(b.text || '').length - String(a.text || '').length);
            let added = 0;
            for (let i = 1; i < sorted.length && added < CONSOLIDATE_BUCKET_PAIRS; i++) {
                const a = String(sorted[0].id), b = String(sorted[i].id);
                if (!a || !b || a === b)
                    continue;
                const k = a < b ? `${a}|${b}` : `${b}|${a}`;
                if (seen.has(k))
                    continue;
                seen.add(k);
                pairs.push({ idA: a, idB: b, similarity: 0 });
                added++;
                if (pairs.length >= limit)
                    return;
            }
        }
    }
    return;
}
export async function findSimilarCandidates(project, threshold = CONSOLIDATE_SIMILARITY, limit = CONSOLIDATE_MAX_PAIRS, characterId = CHAR_ID) {
    if (!isEmbedEnabled())
        return [];
    const proj = normalizeProject(project);
    const cid = characterId || CHAR_ID;
    const seen = new Set();
    const pairs = [];
    // v1.11.2 memdir:每个 memType 是**独立 sqlite** —— 旧版只扫 general,user/feedback/project 里的
    // "报告式"重复(带 # 表头的成组记录)完全够不到,LLM 也就无从裁决。
    // 逐库扫描并把候选并起来;两阶段(先全库语义 → 再全库结构)是为了让表头对不挤占语义候选的名额。
    // v1.24: 角色隔离 — 候选只在本实例角色内配对(charId='any' 关闭过滤)。
    const dirs = listMemTypeDirs(proj);
    // 语义预筛给结构兜底预留名额（v1.23.1）
    const structReserve = Math.min(CONSOLIDATE_BUCKET_RESERVE, limit);
    const vecLimit = Math.max(1, limit - structReserve);
    for (const mt of dirs) {
        if (pairs.length >= vecLimit)
            break;
        scanVectorPairs(DatabaseManager.getInstance(project, mt), proj, threshold, vecLimit, seen, pairs, cid);
    }
    if (CONSOLIDATE_BUCKET_PAIRS > 0) {
        for (const mt of dirs) {
            if (pairs.length >= limit)
                break;
            scanStructPairs(DatabaseManager.getInstance(project, mt), proj, limit, seen, pairs, cid);
        }
    }
    return pairs.slice(0, limit);
}
export async function consolidate() {
    const now = Date.now();
    const cid = CHAR_ID;
    let prunedCount = 0;
    let updatedCount = 0;
    let consolidateCount = 0;
    // memdir:遍历默认项目全部分类库(时间衰减/升华不只作用 general)
    // v1.24: 角色隔离 — 衰减/剪枝/升华只作用于本实例角色,不替其它角色改记忆。
    const proj = normalizeProject(undefined);
    for (const mt of listMemTypeDirs(proj)) {
        const db = DatabaseManager.getInstance(proj, mt);
        // ═══ Phase 1: sigmoid 时间衰减 ═══
        // v1.23.2-fix: 从 base_importance 基线算（否则衰减取决于 consolidate 运行次数）；
        // identity_locked 与 forgetMemory 同款保护，不参与自动剪枝。
        // 2026-10-29: 对话流水(conversation_log)与状态快照(agent_state)不参与衰减/剪枝。
        //   它们是反刍的**原料**，不是"记忆"：旧对话 importance=0.5，60 天后就够被清，
        //   reflect 还没来得及抽，内容就没了 —— 那批对话永远进不了 facts。
        // 2026-10-30: 事件层(daily_event)同理 —— 它是逐字引文 + 来源 rowid 的**导航层**，
        //   不是可再生的摘要：progress 表已把对话标记"整理过"，被剪掉就无法重跑重建（实测 200 天 → 0.007 → 软删）。
        const activeRecords = db.prepare(`
      SELECT id, importance, COALESCE(base_importance, importance) AS base_importance, last_accessed_at
      FROM memory WHERE is_active = 1 AND character_id = ?
        AND COALESCE(source, '') NOT IN ('manual_lore', 'conversation_log', 'agent_state', 'daily_event')
        AND COALESCE(tier, 'standard') != 'critical' AND (locked IS NULL OR locked = 0)
        AND COALESCE(identity_locked, 0) = 0
    `).all(cid);
        const decayTx = db.transaction(() => {
            for (const mem of activeRecords) {
                const ts = new Date(mem.last_accessed_at).getTime();
                if (!Number.isFinite(ts))
                    continue; // 非法时间戳跳过,避免 importance 被写成 NaN
                const hoursSince = (now - ts) / 3600000;
                const daysSince = hoursSince / 24;
                const decay = 1.0 / (1.0 + Math.exp(0.04 * (daysSince - 90)));
                const base = Number(mem.base_importance ?? mem.importance) || 0;
                const newImportance = Math.round(base * decay * 1000) / 1000;
                if (newImportance < ACTIVATION_THRESHOLD && daysSince > 60) {
                    db.prepare('UPDATE memory SET is_active = 0, importance = ? WHERE id = ?')
                        .run(newImportance, mem.id);
                    prunedCount++;
                }
                else {
                    db.prepare('UPDATE memory SET importance = ?, base_importance = ? WHERE id = ?')
                        .run(newImportance, base, mem.id);
                    updatedCount++;
                }
            }
        });
        decayTx();
        // ═══ Phase 2: reference_count 升华 ═══
        const dupes = db.prepare('SELECT id FROM memory WHERE is_active = 1 AND character_id = ? AND reference_count > 2 LIMIT 20').all(cid);
        for (const dup of dupes) {
            db.prepare(`UPDATE memory SET reference_count = 0,
           importance = MIN(0.95, COALESCE(base_importance, importance) + 0.1),
           base_importance = MIN(0.95, COALESCE(base_importance, importance) + 0.1)
         WHERE id = ?`).run(dup.id);
            consolidateCount++;
        }
    }
    return {
        success: true,
        decayedOrUpdated: updatedCount,
        pruned: prunedCount,
        consolidated: consolidateCount,
    };
}
//# sourceMappingURL=consolidate.js.map