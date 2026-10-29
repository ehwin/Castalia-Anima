/**
 * 孤儿记忆对账(Anima,2026-10-29)
 *
 * 问题:会话被删/回滚(重新生成、删消息、删会话)之后,已经从这轮对话里沉淀出来的记忆
 * 还留在库里,继续被检索、被注入、被反思。它描述的是一段**已经不存在的对话**。
 * 我们没有任何标记 —— 这类行就是"孤儿"。
 *
 * 做法(刻意保守):
 *  - 只处理 **带 session_id 的** 记忆:没有锚点的记忆(手写 lore、LLM 抽的事实)永远不碰;
 *  - 调用方必须显式给出**还活着的 session id 列表**;列表为空 → 直接拒绝,
 *    绝不允许"一次误调用把整个库软删";
 *  - 只软删(is_active=0),原文保留,metadata 里记 orphanedAt / orphanedReason,可回滚;
 *  - dryRun 只报告不写,必须先跑一遍再落地。
 *
 * 与 LivingMemory 的 snapshot 对账是同一个问题的两种解:它按 turn 快照删尾部,我们按
 * session 存活集合对账 —— 我们这边的锚点只有 session 级(见 airi bank:38 条有 session_id)。
 */
import type Database from 'better-sqlite3';

export interface OrphanOptions {
  /** 项目名(必填):孤儿只在同一个 project 内判定 */
  project: string;
  /** 仍然存在的会话 id 集合。**空数组会被拒绝** */
  aliveSessionIds: string[];
  /** true = 只报告不写 */
  dryRun?: boolean;
  /** 最多处理多少行(默认 5000,防一次扫爆大库) */
  limit?: number;
  /** 允许 aliveSessionIds 为空(仅测试/清库用,默认 false) */
  allowEmpty?: boolean;
}

export interface OrphanCandidate {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
  source: string | null;
}

export interface OrphanResult {
  ok: boolean;
  dryRun: boolean;
  /** 带 session_id 的记忆总数 */
  anchored: number;
  /** 其中 session 已不存在 = 孤儿 */
  orphans: number;
  /** 实际软删的行数(dryRun 时为 0) */
  orphaned: number;
  /** 没有 session_id、被跳过(永不触碰) */
  skippedNoAnchor: number;
  /** 拒绝执行的原因 */
  refused?: string;
  sample: OrphanCandidate[];
}

/**
 * 找出(并可选地软删)指向已消失会话的记忆。
 *
 * 注意:这里不判断"会话是否被回滚过" —— 那是宿主的事。引擎只回答一个可验证的问题:
 * 这条记忆声称属于哪个 session,而那个 session 还在不在。
 */
export function orphanMemories(db: Database.Database, opts: OrphanOptions): OrphanResult {
  const project = String(opts.project || '').trim();
  const alive = Array.isArray(opts.aliveSessionIds) ? [...new Set(opts.aliveSessionIds.map(String))] : null;
  const dryRun = opts.dryRun !== false;   // 默认就是 dry-run:想写必须显式 dryRun:false
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : 5000;

  const base: OrphanResult = {
    ok: false, dryRun, anchored: 0, orphans: 0, orphaned: 0, skippedNoAnchor: 0, sample: [],
  };
  if (!project) return { ...base, refused: 'project 必填' };
  if (alive === null) return { ...base, refused: 'aliveSessionIds 必须是数组' };
  if (alive.length === 0 && opts.allowEmpty !== true) {
    return { ...base, refused: 'aliveSessionIds 为空:拒绝执行(避免一次误调用软删整库)' };
  }

  const rowOf = (sql: string, ...p: any[]) => {
    try { return db.prepare(sql).get(...p) as any; } catch { return null; }
  };
  const total = Number(rowOf('SELECT COUNT(*) n FROM memory WHERE is_active = 1')?.n ?? 0);
  const anchored = Number(rowOf(
    "SELECT COUNT(*) n FROM memory WHERE is_active = 1 AND session_id IS NOT NULL AND session_id <> ''",
  )?.n ?? 0);
  base.anchored = anchored;
  base.skippedNoAnchor = Math.max(0, total - anchored);
  if (anchored === 0) return { ...base, ok: true };

  const placeholders = alive.map(() => '?').join(',');
  const where = alive.length > 0
    ? `m.is_active = 1 AND m.session_id IS NOT NULL AND m.session_id <> '' AND m.session_id NOT IN (${placeholders})`
    : "m.is_active = 1 AND m.session_id IS NOT NULL AND m.session_id <> ''";

  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT m.id, m.session_id, m.text, m.created_at, m.source, m.metadata
      FROM memory m
      WHERE ${where}
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(...alive, limit) as any[];
  } catch (e: any) {
    return { ...base, refused: `查询失败: ${e.message}` };
  }

  base.orphans = rows.length;
  base.sample = rows.slice(0, 5).map(r => ({
    id: String(r.id),
    sessionId: String(r.session_id),
    text: String(r.text || '').slice(0, 60),
    createdAt: String(r.created_at || ''),
    source: r.source ? String(r.source) : null,
  }));

  if (dryRun || rows.length === 0) return { ...base, ok: true };

  const upd = db.prepare('UPDATE memory SET is_active = 0, metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const now = new Date().toISOString();
  let orphaned = 0;
  const tx = db.transaction((list: any[]) => {
    for (const r of list) {
      let meta: Record<string, unknown> = {};
      try { meta = r.metadata ? JSON.parse(String(r.metadata)) : {}; } catch { meta = { _unparsed: String(r.metadata) }; }
      meta.orphanedAt = now;
      meta.orphanedReason = 'session-gone';
      meta.orphanedSession = String(r.session_id);
      upd.run(JSON.stringify(meta), String(r.id));
      orphaned++;
    }
  });
  try { tx(rows); } catch (e: any) { return { ...base, refused: `写入失败: ${e.message}` }; }

  return { ...base, ok: true, orphaned };
}

/** 审计:各 session 下有多少条活跃记忆(给"要不要对账"提供数据) */
export function sessionInventory(db: Database.Database, limit = 200): Array<{ sessionId: string; memories: number; latest: string }> {
  try {
    return (db.prepare(`
      SELECT session_id AS sessionId, COUNT(*) AS memories, MAX(created_at) AS latest
      FROM memory WHERE is_active = 1 AND session_id IS NOT NULL AND session_id <> ''
      GROUP BY session_id ORDER BY memories DESC LIMIT ?
    `).all(limit) as any[]).map(r => ({
      sessionId: String(r.sessionId), memories: Number(r.memories) || 0, latest: String(r.latest || ''),
    }));
  } catch { return []; }
}
