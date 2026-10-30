/**
 * digest v6.2 — 轻量周期任务
 *
 * 职责：
 *   1. 消费 VAD 队列（批量情感分析 + 批量贴标签）
 *   2. 清理过期临时记忆
 *
 * 不负责：
 *   ✗ 合并对话 → reflect 做
 *   ✗ 提纯/升华 → reflect 做
 *   ✗ 打分新生成句子 → reflect 做
 *
 * 事件驱动：有新对话才跑，间隔 ≥ 1 分钟
 */

import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeCharacterId, normalizeProject, CHAR_ID } from './env.js';
import { flushVadQueueDetailed, recoverPendingVadQueue, regressToBaseline, isNightTime } from './emotion.js';
import { cleanupExpiredMemories } from './store.js';
import { getAgentState } from './agentState.js';

const MIN_DIGEST_GAP_MS = 60 * 1000;
// v1.23.2-fix: 按 project 节流（旧实现全局单值，一个项目跑 digest 会压制其它项目 60s）
const lastDigestTimes = new Map<string, number>();

export interface DigestResult {
  success: boolean;
  vadUpdated: boolean;
  cleaned: number;
  restored: number;
  errors: string[];
  details?: string[];
}

export async function runDigest(characterId: string = CHAR_ID, project?: string): Promise<DigestResult> {
  const db = DatabaseManager.getInstance(project);
  const cid = normalizeCharacterId(characterId);
  const result: DigestResult = {
    success: true,
    vadUpdated: false,
    cleaned: 0,
    restored: 0,
    errors: [],
  };

  // 1. 消费 VAD 队列 — 只处理本项目分组（不同 project 不混批）。
  //    显式 normalize：不传 project 时也固定落到默认项目，避免一次 digest 把别人的队列全消费掉。
  //    force:false = 保留周期批量的“攒够 5 条 / 最老 10 分钟”阈值，避免每条消息一次 LLM 调用。
  try {
    // The in-memory queue is intentionally disposable. Rebuild it from the
    // durable pending marker after a restart before applying batch thresholds.
    recoverPendingVadQueue(normalizeProject(project), cid);
    const vadResult = await flushVadQueueDetailed(normalizeProject(project), { force: false });
    if (vadResult.updated > 0) {
      result.vadUpdated = true;
      result.details = result.details || [];
      result.details.push('VAD updated=' + vadResult.updated + ' source=' + vadResult.source);
      if (vadResult.analysis) {
        result.details.push('VAD: v=' + vadResult.analysis.vad.valence.toFixed(2)
          + ' a=' + vadResult.analysis.vad.arousal.toFixed(2)
          + ' tsun=' + vadResult.analysis.tsundereLevel);
      }
    }
    result.details?.push('queue flushed');
  } catch (e: any) {
    result.success = false;
    result.errors.push('VAD flush: ' + e.message);
  }

  // 2. 清理过期临时记忆(memdir:遍历项目全部分类库;v1.24 只清本角色)
  result.cleaned = cleanupExpiredMemories(project, cid);

  // 3. critical 记忆不再无条件复活（对齐 Lite/Full 的等价实现）：
  //    inactive 可能代表人工删除、合并删除或跨 memType 迁移墓碑；
  //    无条件 UPDATE ... is_active = 1 会让用户显式删掉的 critical 在 60s 定时器下反复活过来。
  //    只有显式人工恢复接口(store.restoreMemory)可以恢复。
  return result;
}

export function maybeDigest(characterId: string = CHAR_ID, project?: string): Promise<DigestResult> | null {
  const now = Date.now();
  const projKey = normalizeProject(project);
  const cid = normalizeCharacterId(characterId);
  const throttleKey = `${projKey}|${cid}`;
  if (now - (lastDigestTimes.get(throttleKey) || 0) < MIN_DIGEST_GAP_MS) return null;

  const db = DatabaseManager.getInstance(project);
  // `last_accessed_at` is a retrieval clock, not an affect-analysis marker:
  // search/recall can update it before digest runs and would permanently hide
  // an otherwise unanalyzed conversation. Until older databases have the
  // explicit affect_status migration, a NULL VAD is the durable pending signal.
  const unanalyzed = (db.prepare(`
    SELECT COUNT(*) as c FROM memory
    WHERE is_active = 1 AND source = 'conversation_log'
      AND character_id = ?
      AND (affect_status IN ('pending', 'pending_psyche') OR (affect_status IS NULL AND vad_valence IS NULL))
  `).get(cid) as any)?.c || 0;

  if (unanalyzed === 0) return null;

  lastDigestTimes.set(throttleKey, now);
  return runDigest(cid, project);
}

export function getRecentConversations(characterId: string = CHAR_ID, hoursBack: number = 24, limit: number = 50, project?: string, nowMs = Date.now()): any[] {
  const db = DatabaseManager.getInstance(project);
  characterId = normalizeCharacterId(characterId);
  const since = new Date(nowMs - hoursBack * 3600000).toISOString();
  const proj = normalizeProject(project);
  return db.prepare(`
    SELECT id, rowid, text, created_at, importance
    FROM memory WHERE source = 'conversation_log' AND project = ?
      AND character_id = ?
      AND is_active = 1
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(proj, characterId || CHAR_ID, since, limit) as any[];
}

/**
 * Read the oldest page in the recent window. Self-cycle uses this for its
 * first run so a backlog larger than the page size is drained by the durable
 * cursor instead of jumping straight to the newest row and losing history.
 */
export function getEarliestConversations(characterId: string = CHAR_ID, hoursBack: number = 24, limit: number = 50, project?: string, nowMs = Date.now()): any[] {
  const db = DatabaseManager.getInstance(project);
  characterId = normalizeCharacterId(characterId);
  const since = new Date(nowMs - hoursBack * 3600000).toISOString();
  const proj = normalizeProject(project);
  return db.prepare(`
    SELECT id, rowid, text, created_at, importance
    FROM memory WHERE source = 'conversation_log' AND project = ?
      AND character_id = ?
      AND is_active = 1
      AND julianday(created_at) IS NOT NULL
      AND julianday(created_at) > julianday(?)
    ORDER BY julianday(created_at) ASC, rowid ASC
    LIMIT ?
  `).all(
    proj, characterId || CHAR_ID, since,
    Math.max(1, Math.trunc(Number(limit) || 1)),
  ) as any[];
}

/**
 * Read the earliest conversation evidence after a durable self-cycle cursor.
 * The first self-cycle keeps the recent-window behavior above; subsequent
 * cycles consume this ordered page so a burst larger than `limit` is drained
 * over multiple runs instead of being skipped by a latest-window query.
 */
export function getConversationsAfter(
  characterId: string = CHAR_ID,
  cursor: { createdAt: string; rowid: number },
  hoursBack: number = 24,
  limit: number = 50,
  project?: string,
  nowMs = Date.now(),
): any[] {
  const db = DatabaseManager.getInstance(project);
  characterId = normalizeCharacterId(characterId);
  // Once a cursor exists it is the durable lower bound. Applying the recent
  // window again here would discard evidence produced during a long outage.
  // Keep the parameters for API symmetry with getRecentConversations; they
  // are intentionally used only by the first-run path.
  void hoursBack;
  void nowMs;
  const proj = normalizeProject(project);
  return db.prepare(`
    SELECT id, rowid, text, created_at, importance
    FROM memory WHERE source = 'conversation_log' AND project = ?
      AND character_id = ?
      AND is_active = 1
      AND julianday(created_at) IS NOT NULL
      AND (
        julianday(created_at) > julianday(?)
        OR (julianday(created_at) = julianday(?) AND rowid > ?)
      )
    ORDER BY julianday(created_at) ASC, rowid ASC
    LIMIT ?
  `).all(
    proj, characterId || CHAR_ID,
    cursor.createdAt, cursor.createdAt, Math.trunc(Number(cursor.rowid)),
    Math.max(1, Math.trunc(Number(limit) || 1)),
  ) as any[];
}
