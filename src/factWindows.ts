/**
 * 开窗修复计划：把升级前遗留的"多个当前值"重新算成一条时间线。
 *
 * v1.28 的链式重算只在**发生写入**时跑。升级前写下的历史行 `valid_to` 一直是空，
 * 于是同一个单值槽位可能同时有两条"当前值"（本机生产库里 `agent/姓名` 就是这样）。
 * 这不影响回溯查询的语义（有效时间轴按 valid_from 排，多开口就都算为真），但会让
 * "现在叫什么"这种问题同时返回两个答案。
 *
 * 计划与应用分两步，`planWindowRepairs` 只读。真库上先看计划再决定，不默认改数据。
 * 判定复用与写入路径**同一套**规则（`shouldSupersede`），避免回填与日常写入给出不一致的结论：
 *   - 多值谓词（喜欢/兴趣…）与计划类谓词（计划/打算…）：不管。
 *   - 单值种子表（姓名/居住地/称呼…）：只留最新一条开口。
 *   - 表外谓词：证据够且判为慢变才动手，否则保守不动（与在线路径一致）。
 */
import { DatabaseManager as Db } from './db.js';
import { CHAR_ID, normalizeProject, PROJECT_ID } from './env.js';
import { estimatePredicateVolatility, normalizePredicate, shouldSupersede } from './volatility.js';
import type { FactWindow } from './bitemporal.js';

export interface WindowRepairPlan {
  subject: string;
  predicate: string;
  /** 保留开口的那条（有效时间最新）。 */
  keep: FactWindow;
  /** 会被打上 valid_to 的行，按时间倒序。 */
  close: FactWindow[];
  /** 判定依据，与在线路径同一套。 */
  reason: string;
}

function characterFilter(characterId: string | undefined): { clause: string; params: unknown[] } {
  const cid = characterId ?? CHAR_ID;
  if (cid === 'any') return { clause: '', params: [] };
  if (cid === '') return { clause: "(character_id IS NULL OR character_id = '')", params: [] };
  return { clause: 'character_id = ?', params: [cid] };
}

function openWindows(project: string, characterId: string | undefined): FactWindow[] {
  const db = Db.getInstance(project);
  const conditions = ['project = ?', 'is_active = 1', "(valid_to IS NULL OR valid_to = '')"];
  const params: unknown[] = [project];
  const scope = characterFilter(characterId);
  if (scope.clause) {
    conditions.push(scope.clause);
    params.push(...scope.params);
  }
  const rows = db.prepare(`
    SELECT id, subject, predicate, object, confidence, valid_from, valid_to,
           created_at, expired_at, superseded_by
    FROM facts
    WHERE ${conditions.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM memory source_memory
        WHERE source_memory.id = facts.source_memory_id
          AND source_memory.source IN ('agent_diary', 'agent_state')
      )
      AND COALESCE(facts.source_memory_source, '') NOT IN ('agent_diary', 'agent_state')
    ORDER BY julianday(COALESCE(valid_from, created_at)) DESC
  `).all(...params) as any[];
  return rows.map(row => ({
    id: String(row.id),
    subject: String(row.subject),
    predicate: String(row.predicate),
    object: String(row.object),
    confidence: Number(row.confidence ?? 0),
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    createdAt: String(row.created_at ?? ''),
    expiredAt: row.expired_at ?? null,
    supersededBy: row.superseded_by ?? null,
  }));
}

/**
 * 只读：列出需要修复的槽位。
 *
 * `now` 只用于取证据窗口（证据按当前时刻回看），不写入任何东西。
 */
export function planWindowRepairs(options: {
  project?: string;
  characterId?: string;
  now?: number;
} = {}): WindowRepairPlan[] {
  const project = normalizeProject(options.project ?? PROJECT_ID);
  const grouped = new Map<string, FactWindow[]>();
  for (const window of openWindows(project, options.characterId)) {
    const key = `${window.subject}\u0000${normalizePredicate(window.predicate)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), window]);
  }

  const plans: WindowRepairPlan[] = [];
  for (const [key, windows] of grouped) {
    if (windows.length < 2) continue;
    const predicate = key.split('\u0000')[1];
    // 表外谓词才查证据；单值种子表与多值/计划表直接由先验决定。
    const decision = shouldSupersede({
      predicate,
      evidence: estimatePredicateVolatility(Db.getInstance(project), project, options.characterId ?? CHAR_ID, key.split('\u0000')[0], predicate),
    });
    if (!decision.supersede) continue;
    const sorted = [...windows].sort((left, right) =>
      Date.parse(right.validFrom ?? right.createdAt) - Date.parse(left.validFrom ?? left.createdAt));
    plans.push({
      subject: sorted[0].subject,
      predicate,
      keep: sorted[0],
      close: sorted.slice(1),
      reason: decision.reason,
    });
  }
  return plans.sort((left, right) =>
    left.subject.localeCompare(right.subject) || left.predicate.localeCompare(right.predicate));
}

export interface AppliedRepair {
  subject: string;
  predicate: string;
  closed: number;
  keptObject: string;
}

/**
 * 执行一份计划。
 *
 * 语义与 store 的时间线重算一致：旧值的 `valid_to` 取**接替者的有效时间起点**，不是"现在"；
 * 事务时间 `expired_at` 才记判定时刻。只动仍然开口的行，已经被别人闭合的行不碰。
 */
export function applyWindowRepairs(plans: readonly WindowRepairPlan[], options: { project?: string; now?: string } = {}): AppliedRepair[] {
  const project = normalizeProject(options.project ?? PROJECT_ID);
  const db = Db.getInstance(project);
  const stamp = options.now ?? new Date().toISOString();
  const applied: AppliedRepair[] = [];
  for (const plan of plans) {
    const handoverAt = plan.keep.validFrom ?? plan.keep.createdAt;
    let closed = 0;
    for (const window of plan.close) {
      const result = db.prepare(`
        UPDATE facts SET valid_to = ?, expired_at = ?, superseded_by = ?, updated_at = ?
        WHERE id = ? AND project = ? AND (valid_to IS NULL OR valid_to = '')
      `).run(handoverAt, stamp, plan.keep.id, stamp, window.id, project);
      closed += Number(result.changes ?? 0);
    }
    applied.push({ subject: plan.subject, predicate: plan.predicate, closed, keptObject: plan.keep.object });
  }
  return applied;
}
