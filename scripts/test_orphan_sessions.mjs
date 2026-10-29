/**
 * 孤儿记忆对账回归。
 *
 * 验收的是"安全边界"而不是"能删" —— 这类功能一旦写错,一次误调用就把整库软删。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-orphan-'));
process.env.MEMORY_DB_DIR = tmp;
process.env.CHAR_ID = 'airi';
process.env.EMBED_MODE = 'none';

const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const storeMod = await import(pathToFileURL(path.join(DIST, 'store.js')).href);
const orphan = await import(pathToFileURL(path.join(DIST, 'orphan.js')).href);

const db = dbMod.DatabaseManager.getInstance('default', 'general');
const mk = async (text, sessionId) => (await storeMod.saveMemory({
  text, project: 'default', characterId: 'airi', skipEmbed: true, ...(sessionId ? { sessionId } : {}),
})).id;

const alive = await mk('这是还活着的会话里的记忆', 'sess-alive');
const dead1 = await mk('这是被删会话里的记忆', 'sess-deleted');
const dead2 = await mk('这也是被删会话里的记忆', 'sess-deleted');
const noAnchor = await mk('手写 lore,没有会话锚点', null);

const active = (id) => Number(db.prepare('SELECT is_active FROM memory WHERE id = ?').get(id).is_active);
const meta = (id) => { try { return JSON.parse(String(db.prepare('SELECT metadata FROM memory WHERE id = ?').get(id).metadata || '{}')); } catch { return {}; } };

console.log(`[orphan-reconcile] 临时库 ${tmp}`);

console.log('\n1) dry-run 只报告,不动库');
const dry = orphan.orphanMemories(db, { project: 'default', aliveSessionIds: ['sess-alive'] });
check('ok', dry.ok === true, JSON.stringify(dry));
check('dryRun 默认开', dry.dryRun === true);
check('锚定 3 条(不含无锚点那条)', dry.anchored === 3, `got ${dry.anchored}`);
check('孤儿 2 条', dry.orphans === 2, `got ${dry.orphans}`);
check('实际没写', dry.orphaned === 0);
check('样本里给了原因字段', dry.sample.length > 0 && !!dry.sample[0].sessionId);
check('库里仍全部 active', active(dead1) === 1 && active(dead2) === 1);

console.log('\n2) 安全边界:空列表必须拒绝');
const refused = orphan.orphanMemories(db, { project: 'default', aliveSessionIds: [], dryRun: false });
check('拒绝执行', refused.ok === false && !!refused.refused, JSON.stringify(refused.refused));
check('拒绝时一条都没动', active(dead1) === 1);

console.log('\n3) 落地:只软删孤儿,不碰无锚点记忆');
const applied = orphan.orphanMemories(db, { project: 'default', aliveSessionIds: ['sess-alive'], dryRun: false });
check('ok', applied.ok === true, JSON.stringify(applied));
check('软删 2 条', applied.orphaned === 2, `got ${applied.orphaned}`);
check('被删会话的 2 条变 inactive', active(dead1) === 0 && active(dead2) === 0);
check('活会话那条仍是 active', active(alive) === 1);
check('无锚点那条永不触碰', active(noAnchor) === 1);
check('metadata 记了原因', meta(dead1).orphanedReason === 'session-gone', JSON.stringify(meta(dead1)));
check('metadata 记了原 session', meta(dead1).orphanedSession === 'sess-deleted');

console.log('\n4) 幂等:再跑一次不会重复计数');
const again = orphan.orphanMemories(db, { project: 'default', aliveSessionIds: ['sess-alive'], dryRun: false });
check('第二次孤儿 0 条', again.orphans === 0, `got ${again.orphans}`);

console.log('\n5) 审计报表');
const inv = orphan.sessionInventory(db);
check('只剩 1 个会话', inv.length === 1, JSON.stringify(inv));
check('该会话 1 条记忆', inv[0]?.memories === 1, JSON.stringify(inv[0]));

console.log('\n6) 记忆可以恢复(软删不是销毁)');
db.prepare('UPDATE memory SET is_active = 1 WHERE id = ?').run(dead1);
check('手工恢复后 is_active=1', active(dead1) === 1);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
console.log(`\n[orphan-reconcile] ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
