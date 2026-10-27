import crypto from 'node:crypto';
import { DatabaseManager, safeFilePart } from './db.js';
import { CHAR_ID } from './env.js';

export interface TavernMessage {
  id: string;
  role: 'user' | 'assistant';
  name: string;
  text: string;
  createdAt?: string;
}

export interface TavernSyncOptions {
  /**
   * 显式确认“用更小的快照覆盖整段历史”。
   * 缺省 false：本次条数 < 已有活跃条数时拒绝（SillyTavern 客户端可能只传窗口化子集，
   * 直接套用会把整段历史软删掉 —— v1.23.2 审计第 2 组）。
   */
  replace?: boolean;
}

/** Synchronize the selected chat snapshot. No reflection, persona or user-profile side effects. */
export function syncTavernChat(project: string, messages: TavernMessage[], opts: TavernSyncOptions = {}) {
  if (!/^st_[a-f0-9]{40}$/.test(project) || safeFilePart(project) !== project) {
    throw new Error('SillyTavern requires an isolated st_<sha1> project');
  }
  // 空数组不是“同步”，是清空；直接拒绝，任何删除都不执行。
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Tavern snapshot is empty; refusing to clear the existing chat history (send the full snapshot)');
  }
  const db = DatabaseManager.getInstance(project);
  const now = new Date().toISOString();

  // v1.24: 角色隔离 —— 本模块自己的行从"按 project 当角色"迁移到进程级 CHAR_ID。
  // 只动 source='sillytavern_chat' 的行(本模块独占),避免影响该库里其它来源的记忆。
  try {
    db.prepare("UPDATE memory SET character_id = ? WHERE project = ? AND source = 'sillytavern_chat' AND (character_id IS NULL OR character_id = ?)")
      .run(CHAR_ID, project, project);
  } catch { /* 旧库无列时忽略 */ }

  // 窗口化子集保护：只有显式 replace:true 才允许“本次条数 < 已有条数”的收缩。
  const previousActive = (db.prepare(
    "SELECT COUNT(*) AS c FROM memory WHERE project=? AND source='sillytavern_chat' AND is_active=1"
  ).get(project) as any)?.c || 0;
  if (messages.length < previousActive && opts.replace !== true) {
    throw new Error(`Tavern snapshot has ${messages.length} message(s) but ${previousActive} active message(s) already exist; `
      + 'this looks like a windowed subset. Pass replace:true to confirm deleting the missing messages.');
  }

  const ids = new Set<string>();
  const rows = messages.map(message => {
    if (ids.has(message.id)) throw new Error('Duplicate chat message ID');
    ids.add(message.id);
    return {
      id: `st_${crypto.createHash('sha256').update(`${project}:${message.id}`).digest('hex')}`,
      text: `${message.name}（${message.role === 'user' ? '用户扮演角色' : '角色'}）: ${message.text}`,
      createdAt: message.createdAt && Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : now,
    };
  });
  // v1.23.2-fix: 条数相同但内容整体换了一批（swipe 全替换/切到另一段）也要显式 replace
  const prevActiveIds = new Set<string>(
    (db.prepare("SELECT id FROM memory WHERE project=? AND source='sillytavern_chat' AND is_active=1").all(project) as any[]).map(r => r.id),
  );
  const overlap = rows.reduce((n, r) => n + (prevActiveIds.has(r.id) ? 1 : 0), 0);
  if (prevActiveIds.size > 0 && opts.replace !== true && overlap === 0 && rows.length <= prevActiveIds.size) {
    throw new Error(`Tavern snapshot shares no message with the ${prevActiveIds.size} active message(s); `
      + 'this looks like a different/truncated window. Pass replace:true to confirm replacing the chat history.');
  }

  let changed = 0;
  let deleted = 0;
  db.transaction(() => {
    const existing = db.prepare("SELECT id, text, is_active, rowid FROM memory WHERE project=? AND source='sillytavern_chat'").all(project) as Array<{id: string; text: string; is_active: number; rowid: number}>;
    const previous = new Map(existing.map(row => [row.id, row]));
    const current = new Set(rows.map(row => row.id));
    for (const row of existing) {
      if (!current.has(row.id) && row.is_active) {
        db.prepare('UPDATE memory SET is_active=0, updated_at=? WHERE id=?').run(now, row.id);
        db.prepare('DELETE FROM vec_memory WHERE rowid=?').run(row.rowid);
        deleted++;
      }
    }
    for (const row of rows) {
      const old = previous.get(row.id);
      if (old?.is_active && old.text === row.text) continue;
      if (old) {
        db.prepare('UPDATE memory SET text=?, is_active=1, updated_at=? WHERE id=?').run(row.text, now, row.id);
        db.prepare('DELETE FROM vec_memory WHERE rowid=?').run(old.rowid);
      } else {
        db.prepare(`INSERT INTO memory (id,text,project,session_id,type,mem_type,category,tags,importance,character_id,source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,reference_count)
          VALUES (?,?,?,?,'episodic','general','conversation','[]',0.5,?,'sillytavern_chat','environment','standard',1,?,?,?,0,0)`)
          .run(row.id, row.text, project, project, CHAR_ID, row.createdAt, now, now);
      }
      changed++;
    }
  })();
  return { project, count: rows.length, changed, deleted };
}
