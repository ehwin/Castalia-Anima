/**
 * 按批次恢复被软删的对话原文（source='conversation_log'）。
 *
 * 背景：2026-10-31 交接单 —— 示例应用 库里 23 条对话原文 is_active=0，导致
 *   emotion.ts 的 VAD 队列丢弃它们（:648 要求 is_active=1）、检索/注入看不到原文。
 *   行还在、正文完整，只是"标死了"。本脚本只翻 is_active 并打批次标记，**不碰向量**。
 *
 * 用法：
 *   node scripts/restore_conversation_log.mjs                       # dry-run，只报数
 *   node scripts/restore_conversation_log.mjs --apply               # 真写（默认 bank = default）
 *   node scripts/restore_conversation_log.mjs --bank D:/castalia/memory-banks/default --apply
 *   node scripts/restore_conversation_log.mjs --allow-reflect       # 不加 noReflect 标记
 *   node scripts/restore_conversation_log.mjs --rollback --batch 2026-10-31 --apply
 *
 * 安全：
 *   - 默认只恢复 metadata 里带 restoreBatch 之外的行；重复跑同一批次幂等（已恢复的行 is_active=1 不再命中）。
 *   - 每行写 metadata：restoreBatch / restoredAt / restoredBy / restoredReason / noReflect。
 *   - --rollback 只把"本批次标记过"的行改回 is_active=0，不删任何行。
 *   - 跳过 _backup* 目录；不重建向量（可用 scripts/backfill_reflect_vectors.mjs 单独排期）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('better-sqlite3');

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APPLY = has('--apply');
const ROLLBACK = has('--rollback');
const BATCH = arg('--batch', '2026-10-31');
const RESTORED_BY = arg('--restored-by', 'agent:host');
const REASON = arg('--reason', 'soft-deleted by reflect/legacy path; see handoff 2026-10-31');
const ALLOW_REFLECT = has('--allow-reflect');
const BANK = arg('--bank', process.env.CASTALIA_BANK_ROOT
  ? path.join(process.env.CASTALIA_BANK_ROOT, 'default')
  : 'D:/castalia/memory-banks/default');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('_backup')) walk(p); }
    else if (e.name === 'memory.sqlite') files.push(p);
  }
})(BANK);

const iso = new Date().toISOString();
let touched = 0;
const perDb = [];

for (const file of files) {
  const db = new D(file, { readonly: !APPLY, fileMustExist: true });
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('memory')").all().map(r => r.name);
    if (!cols.includes('source')) { db.close(); continue; }

    if (ROLLBACK) {
      const target = db.prepare(`SELECT id FROM memory
        WHERE source = 'conversation_log' AND is_active = 1 AND metadata LIKE ?
        LIMIT 5000`).all(`%"restoreBatch":"${BATCH}"%`);
      if (!target.length) { db.close(); continue; }
      perDb.push([file.split(/memory-banks[\\/]/)[1] || file, 'rollback', target.length]);
      if (APPLY) {
        const upd = db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?');
        db.transaction(ids => ids.forEach(({ id }) => upd.run(id)))(target);
      }
      touched += target.length;
      db.close();
      continue;
    }

    const rows = db.prepare(`SELECT id, created_at, metadata, length(trim(text)) len
      FROM memory WHERE source = 'conversation_log' AND is_active = 0
      ORDER BY created_at`).all();
    if (!rows.length) { db.close(); continue; }

    perDb.push([file.split(/memory-banks[\\/]/)[1] || file, 'restore', rows.length]);
    touched += rows.length;

    for (const r of rows.slice(0, 5)) {
      console.log(`  · ${r.created_at}  len=${r.len}  ${r.id}`);
    }

    if (APPLY) {
      const upd = db.prepare('UPDATE memory SET is_active = 1, metadata = ? WHERE id = ? AND is_active = 0');
      const tx = db.transaction(list => {
        for (const r of list) {
          let meta = {};
          try { meta = r.metadata ? JSON.parse(String(r.metadata)) : {}; } catch { meta = { _unparsedMetadata: String(r.metadata) }; }
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = { _previousMetadata: r.metadata };
          const next = {
            ...meta,
            restoreBatch: BATCH,
            restoredAt: iso,
            restoredBy: RESTORED_BY,
            restoredReason: REASON,
          };
          if (!ALLOW_REFLECT) next.noReflect = true;
          upd.run(JSON.stringify(next), r.id);
        }
      });
      tx(rows);
    }
    db.close();
  } catch (e) {
    console.error(`  ! ${file}: ${e.message}`);
    try { db.close(); } catch { /* ignore */ }
  }
}

console.log(`\nbank = ${BANK}`);
console.log(`batch = ${BATCH}  mode = ${APPLY ? (ROLLBACK ? 'ROLLBACK' : 'APPLY') : 'dry-run'}  noReflect = ${!ALLOW_REFLECT}`);
if (!perDb.length) console.log('no matching rows');
for (const [name, mode, n] of perDb) console.log(`  ${name}  ${mode}  ${n} rows`);
console.log(`total rows ${ROLLBACK ? 'rolled back' : 'to restore'}: ${touched}`);
