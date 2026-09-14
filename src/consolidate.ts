/**
 * 记忆整理 — sigmoid 时间衰减 + reference_count 升华
 *
 * 去重完全交给大模型 reflect 接口做语义判断，consolidate 只做纯规则维护：
 * - Phase 1: sigmoid 时间衰减 → 旧记忆自动降权，低于阈值软删除
 * - Phase 2: reference_count 升华 → 被反复引用的记忆重要性提升
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { cosineSimilarity } from './ollama.js';
import { isEmbedEnabled, normalizeProject } from './env.js';

const ACTIVATION_THRESHOLD = 0.15;

// ═══ v1.10: 记忆整合候选预筛配置(env 可配;config.json 的 consolidate.similarity 会覆盖) ═══
export const CONSOLIDATE_SIMILARITY = (() => {
  const v = parseFloat(process.env.CONSOLIDATE_SIMILARITY || '0.88');
  return Number.isFinite(v) && v > 0 ? v : 0.88;
})();

/** 候选对数上限,防止相似爆炸 */
export const CONSOLIDATE_MAX_PAIRS = (() => {
  const v = parseInt(process.env.CONSOLIDATE_MAX_PAIRS || '50', 10);
  return Number.isFinite(v) && v > 0 ? v : 50;
})();

export interface SimilarCandidate {
  idA: string;
  idB: string;
  similarity: number;
}

/**
 * v1.10: 向量预筛相似记忆对(cos 相似度 > threshold)。
 * - EMBED_MODE=none → 直接返回 [] (LLM 全量扫兜底)
 * - vec0 虚拟表禁止 JOIN:先对每条记忆做 KNN 取候选 rowid,再二段过滤 project/locked
 * - 每对去重(不重复 idA/idB、不反向),数量上限 limit 防爆炸
 */
export async function findSimilarCandidates(
  project?: string,
  threshold: number = CONSOLIDATE_SIMILARITY,
  limit: number = CONSOLIDATE_MAX_PAIRS,
): Promise<SimilarCandidate[]> {
  if (!isEmbedEnabled()) return [];
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);

  const mems = db.prepare(`
    SELECT m.rowid, m.id FROM memory m
    WHERE m.is_active = 1 AND m.project = ? AND (m.locked IS NULL OR m.locked = 0)
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(proj) as any[];
  if (mems.length < 2) return [];

  const rowidList = mems.map(m => Number(m.rowid));
  let vecRows: any[] = [];
  try {
    vecRows = db.prepare(`
      SELECT rowid, embedding FROM vec_memory WHERE rowid IN (${rowidList.map(() => '?').join(',')})
    `).all(...rowidList) as any[];
  } catch { return []; }
  if (vecRows.length < 2) return [];

  const memByRowid = new Map<number, string>();
  for (const m of mems) memByRowid.set(Number(m.rowid), m.id);

  const vecByRowid = new Map<number, number[]>();
  for (const r of vecRows) {
    const b = r.embedding;
    vecByRowid.set(Number(r.rowid), Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)));
  }
  if (vecByRowid.size < 2) return [];

  const scanK = Math.min(20, mems.length);
  const seen = new Set<string>();
  const pairs: SimilarCandidate[] = [];

  for (const m of mems) {
    const rowid = Number(m.rowid);
    const vec = vecByRowid.get(rowid);
    if (!vec) continue;
    let knn: any[] = [];
    try {
      knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
      `).all(new Float32Array(vec), scanK) as any[];
    } catch { continue; }
    for (const n of knn) {
      const nRowid = Number(n.rowid);
      if (nRowid === rowid) continue;
      // 二段过滤:只保留同项目 active 记忆(locked 已排除)的邻居
      const otherId = memByRowid.get(nRowid);
      if (!otherId) continue;
      const otherVec = vecByRowid.get(nRowid);
      if (!otherVec) continue;
      const sim = cosineSimilarity(vec, otherVec);
      if (sim < threshold) continue;
      const a = m.id;
      const b = otherId;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ idA: a, idB: b, similarity: Math.round(sim * 1000) / 1000 });
      if (pairs.length >= limit) return pairs;
    }
  }
  return pairs;
}

export interface ConsolidateResult {
  success: boolean;
  decayedOrUpdated: number;
  pruned: number;
  consolidated: number;
}

// ═══ 衰减/升华参数(config.json 的 consolidate.* → env,均可在部署侧自定义)═══
// 默认值即原行为:sigmoid 衰减(0.04 陡度 / 90 天中点),重要度 <0.15 且年龄 >60 天剪枝;
// 引用数 >2 升华 +0.1,上限 0.95。调大 midpointDays = 衰减更慢;调小 = 更快被剪。
const _pnum = (v: string | undefined, d: number): number => {
  const n = parseFloat(v || '');
  return Number.isFinite(n) && n > 0 ? n : d;
};
const DECAY_STEEPNESS = _pnum(process.env.CONSOLIDATE_DECAY_STEEPNESS, 0.04);
const DECAY_MIDPOINT_DAYS = _pnum(process.env.CONSOLIDATE_DECAY_MIDPOINT_DAYS, 90);
const DECAY_MIN_IMPORTANCE = _pnum(process.env.CONSOLIDATE_DECAY_MIN_IMPORTANCE, ACTIVATION_THRESHOLD);
const DECAY_MIN_AGE_DAYS = _pnum(process.env.CONSOLIDATE_DECAY_MIN_AGE_DAYS, 60);
const PROMOTE_REF_COUNT = _pnum(process.env.CONSOLIDATE_PROMOTE_REF_COUNT, 2);
const PROMOTE_BOOST = _pnum(process.env.CONSOLIDATE_PROMOTE_BOOST, 0.1);
const PROMOTE_CAP = _pnum(process.env.CONSOLIDATE_PROMOTE_CAP, 0.95);

export async function consolidate(): Promise<ConsolidateResult> {
  const now = Date.now();
  let prunedCount = 0;
  let updatedCount = 0;
  let consolidateCount = 0;

  // ═══ 衰减范围(分级口径,与检索侧的 decayFor 对齐)═══
  // 检索侧:critical→永不衰减 / 时效类→10天半衰 / 其余→30天半衰。
  // 存储侧沿用同一原则:只让 general(流水/未分类)参与衰减+升华;
  // 四个语义分类库 user(画像)/feedback(纠偏)/project(项目)/reference(资料)**永不衰减**。
  // 覆盖方式:env CONSOLIDATE_DECAY_MEMTYPES(逗号分隔;"all" = 全部分类库),
  //          或 memory/config.json 的 consolidate.decayMemTypes。
  const proj = normalizeProject(undefined);
  const decayTypes = (process.env.CONSOLIDATE_DECAY_MEMTYPES || 'general')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const decayAll = decayTypes.includes('all');
  const decayDirs = listMemTypeDirs(proj)
    .filter(mt => decayAll || decayTypes.includes(mt.toLowerCase()));
  for (const mt of decayDirs) {
    const db = DatabaseManager.getInstance(proj, mt);

    // ═══ Phase 1: sigmoid 时间衰减 ═══
    const activeRecords = db.prepare(`
      SELECT id, importance, last_accessed_at
      FROM memory WHERE is_active = 1 AND COALESCE(source, '') != 'manual_lore' AND tier != 'critical' AND (locked IS NULL OR locked = 0)
    `).all() as any[];

    const decayTx = db.transaction(() => {
      for (const mem of activeRecords) {
        const ts = new Date(mem.last_accessed_at).getTime();
        if (!Number.isFinite(ts)) continue;  // 非法时间戳跳过,避免 importance 被写成 NaN
        const hoursSince = (now - ts) / 3600000;
        const daysSince = hoursSince / 24;
        const decay = 1.0 / (1.0 + Math.exp(DECAY_STEEPNESS * (daysSince - DECAY_MIDPOINT_DAYS)));
        const newImportance = Math.round(mem.importance * decay * 1000) / 1000;

        if (newImportance < DECAY_MIN_IMPORTANCE && daysSince > DECAY_MIN_AGE_DAYS) {
          db.prepare('UPDATE memory SET is_active = 0, importance = ? WHERE id = ?')
            .run(newImportance, mem.id);
          prunedCount++;
        } else {
          db.prepare('UPDATE memory SET importance = ? WHERE id = ?')
            .run(newImportance, mem.id);
          updatedCount++;
        }
      }
    });
    decayTx();

    // ═══ Phase 2: reference_count 升华 ═══
    const dupes = db.prepare(
      `SELECT id FROM memory WHERE is_active = 1 AND reference_count > ${PROMOTE_REF_COUNT} LIMIT 20`
    ).all() as any[];

    for (const dup of dupes) {
      db.prepare(
        `UPDATE memory SET reference_count = 0, importance = MIN(${PROMOTE_CAP}, importance + ${PROMOTE_BOOST}) WHERE id = ?`
      ).run(dup.id);
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
