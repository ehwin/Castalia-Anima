/**
 * 孤儿记忆审计/对账 CLI(默认 dry-run)。
 *
 * 用法:
 *   node scripts/audit_orphans.mjs                       # 只看各 session 的行数
 *   node scripts/audit_orphans.mjs --alive a,b,c          # 对账(dry-run)
 *   node scripts/audit_orphans.mjs --alive a,b,c --apply  # 真软删
 *
 * 环境:MEMORY_DB_DIR 指向 bank 根(如 D:/castalia/memory-banks/airi),
 *      --project 默认取 CASTALIA_PROJECT 或 'airi'。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const aliveArg = arg('--alive', '');
const project = arg('--project', process.env.CASTALIA_PROJECT || 'airi');

if (!process.env.MEMORY_DB_DIR) {
  console.error('需要 MEMORY_DB_DIR(bank 根)');
  process.exit(2);
}
process.env.EMBED_MODE = process.env.EMBED_MODE || 'none';

const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const orphan = await import(pathToFileURL(path.join(DIST, 'orphan.js')).href);
const db = dbMod.DatabaseManager.getInstance(project, 'general');

const inv = orphan.sessionInventory(db, 50);
console.log(`project=${project}  带 session 的会话 ${inv.length} 个`);
for (const s of inv.slice(0, 20)) console.log(`  ${s.sessionId.padEnd(36)} ${String(s.memories).padStart(3)} 条  最新 ${s.latest}`);

if (!aliveArg) {
  console.log('\n(只审计。要给 alive 列表才会判定孤儿:) --alive id1,id2');
  process.exit(0);
}
const alive = aliveArg.split(',').map(x => x.trim()).filter(Boolean);
const r = orphan.orphanMemories(db, { project, aliveSessionIds: alive, dryRun: !APPLY });
console.log(`\n${APPLY ? '对账(写入)' : '对账(dry-run)'}: 锚定 ${r.anchored} 条,孤儿 ${r.orphans} 条`
  + `${APPLY ? `,已软删 ${r.orphaned} 条` : ''}${r.refused ? `,拒绝: ${r.refused}` : ''}`);
for (const s of r.sample) console.log(`  [${s.sessionId}] ${s.text}…`);
