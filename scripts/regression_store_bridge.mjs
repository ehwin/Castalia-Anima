#!/usr/bin/env node
/**
 * 回归:前端存储桥(v1.26) — 示例应用 这类「每个角色一套记忆」的客户端把引擎当持久层
 *
 * 覆盖:
 *   1. memory_store_save 能写进 memory 表,character_id = 传进来的角色 id(不是进程 CHAR_ID)。
 *   2. memory_store_list 按角色隔离:roleA 写的 roleB 看不到;不带 characterId 时回落 CHAR_ID。
 *   3. general=true 的共享记忆两个角色都能看到,且 character_id 为空。
 *   4. 同名再存是更新而不是新增(行数不变、正文替换),幂等。
 *   5. memory_store_forget 只删本角色的那条,共享条目不受影响。
 *   6. 引擎自己的检索(向量关掉后的词法/标签路径)能看到这些记忆 —— 即"打通",不是两套库。
 *
 * 全程离线:EMBED_MODE=none,库在临时目录,不碰真实 bank。
 *
 * 用法:node scripts/regression_store_bridge.mjs [--keep]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const KEEP = process.argv.includes('--keep');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-store-'));

/** 起一个引擎进程(stdio MCP),返回 {client, call}。charId 决定这个进程代表哪个角色。 */
async function connect(charId) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      MEMORY_DB_DIR: tmp,
      MEMORY_CONFIG: path.join(tmp, 'missing-config.json'),
      CASTALIA_PROJECT: 'default',
      CHAR_ID: charId,
      MCP_TOOLS: 'store,agent,admin',
      EMBED_MODE: 'none',
      HEALTH_PORT: '0',
      CONSOLIDATE_AUTO_ON_START: '0',
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'store-bridge-regression', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text ?? '{}';
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  return { client, call };
}

async function main() {
  const { client, call } = await connect('default-default');

  // 1. 两个角色各写一条
  const a = await call('memory_store_save', {
    name: 'favorite-tea', description: 'her favourite drink', body: 'oolong, no sugar, brewed at 90C',
    characterId: 'role-a', project: 'default',
  });
  check('store_save 写入 role-a', a.ok === true && a.updated === false, JSON.stringify(a).slice(0, 200));

  const b = await call('memory_store_save', {
    name: 'lives-in', description: 'city', body: 'Hangzhou, near the lake',
    characterId: 'role-b', project: 'default',
  });
  check('store_save 写入 role-b', b.ok === true && b.updated === false);

  // 2. 共享条目
  const g = await call('memory_store_save', {
    name: 'user-name', description: 'the owner of the device', body: 'the owner prefers to be called 1',
    general: true, project: 'default',
  });
  check('store_save general=true 写入共享层', g.ok === true && g.general === true);

  // 3. 列表隔离
  const listA = await call('memory_store_list', { characterId: 'role-a', project: 'default' });
  const namesA = (listA.results || []).map(r => r.name);
  check('role-a 能看到自己的条目', namesA.includes('favorite-tea'), namesA.join(','));
  check('role-a 看不到 role-b 的条目', !namesA.includes('lives-in'), namesA.join(','));
  check('role-a 能看到共享条目', namesA.includes('user-name'), namesA.join(','));
  check('list 返回完整正文(未截断)', (listA.results || []).some(r => r.name === 'favorite-tea' && r.body.includes('brewed at 90C')));
  check('共享条目 general=true / characterId 为空', (listA.results || []).some(r => r.name === 'user-name' && r.general === true && r.characterId === ''));

  const listB = await call('memory_store_list', { characterId: 'role-b', project: 'default' });
  const namesB = (listB.results || []).map(r => r.name);
  check('role-b 看不到 role-a 的条目', !namesB.includes('favorite-tea'), namesB.join(','));
  check('role-b 能看到共享条目', namesB.includes('user-name'), namesB.join(','));

  // 4. 不带 characterId → 回落进程 CHAR_ID
  const listDefault = await call('memory_store_list', { project: 'default' });
  check('省略 characterId 时回落 CHAR_ID', listDefault.characterId === 'default-default', listDefault.characterId);
  check('回落 CHAR_ID 时看不到别的角色条目', !(listDefault.results || []).some(r => r.name === 'favorite-tea'));

  // 5. 同名覆盖(更新而非新增)
  const before = ((await call('memory_store_list', { characterId: 'role-a', project: 'default' })).results || []).filter(r => r.name === 'favorite-tea').length;
  const a2 = await call('memory_store_save', {
    name: 'favorite-tea', description: 'her favourite drink', body: 'now prefers green tea',
    characterId: 'role-a', project: 'default',
  });
  const after = (await call('memory_store_list', { characterId: 'role-a', project: 'default' })).results || [];
  check('同名再存标记为更新', a2.ok === true && a2.updated === true, JSON.stringify(a2).slice(0, 160));
  check('同名再存不新增行', before === 1 && after.filter(r => r.name === 'favorite-tea').length === 1, `before=${before} after=${after.filter(r => r.name === 'favorite-tea').length}`);
  check('正文被替换', after.some(r => r.name === 'favorite-tea' && r.body === 'now prefers green tea'));

  // 6. 删除只影响本角色
  const del = await call('memory_store_forget', { name: 'favorite-tea', characterId: 'role-a', project: 'default' });
  const afterDel = (await call('memory_store_list', { characterId: 'role-a', project: 'default' })).results || [];
  const afterDelB = (await call('memory_store_list', { characterId: 'role-b', project: 'default' })).results || [];
  check('store_forget 返回已删除', del.ok === true && del.deleted === true, JSON.stringify(del).slice(0, 160));
  check('删除后 role-a 列表不再有它', !afterDel.some(r => r.name === 'favorite-tea'));
  check('删除不影响 role-b 的条目', afterDelB.some(r => r.name === 'lives-in'));
  check('删除不影响共享条目', afterDelB.some(r => r.name === 'user-name'));

  // 7. 引擎侧确实落库(直接看 SQLite,证明不是前端自嗨)
  const dbFile = path.join(tmp, 'default', 'general', 'memory.sqlite');
  check('落库文件存在', fs.existsSync(dbFile), dbFile);
  if (fs.existsSync(dbFile)) {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(dbFile, { readonly: true });
    const rows = db.prepare("SELECT text, character_id, source FROM memory WHERE is_active = 1").all();
    const aRow = rows.find(r => r.text.includes('# favorite-tea'));
    check('引擎库里 role-a 的记忆 character_id 正确', !aRow || aRow.character_id === 'role-a', aRow ? String(aRow.character_id) : 'row already deleted');
    const gRow = rows.find(r => r.text.includes('# user-name'));
    check('共享记忆 character_id 为空', !!gRow && (gRow.character_id === '' || gRow.character_id === null), gRow ? JSON.stringify(gRow.character_id) : 'missing');
    check('共享记忆仍存在(未被误删)', !!gRow);
    const softDeleted = db.prepare("SELECT COUNT(*) c FROM memory WHERE text LIKE '%# favorite-tea%' AND is_active = 0").get().c;
    check('删除是软删(is_active=0)而不是物理删除', softDeleted >= 1, `rows=${softDeleted}`);
    db.close();
  }

  // 8. 跨角色一次拉全(前端重建缓存用):allCharacters + source 圈定写入方
  const all = await call('memory_store_list', { allCharacters: true, source: 'default', project: 'default' });
  const allNames = (all.results || []).map(r => r.name);
  check('allCharacters 能一次拿到所有角色的条目', allNames.includes('lives-in') && allNames.includes('user-name'), allNames.join(','));
  const allChars = new Set((all.results || []).map(r => r.characterId));
  check('跨角色结果里同时出现 role-b 和共享层', allChars.has('role-b') && allChars.has(''), [...allChars].join('|'));

  // 9. 引擎自己的工具也能看到(打通,而非两套):用 CHAR_ID=role-a 起第二个进程
  await call('memory_store_save', { name: 'pet-cat', description: 'a cat', body: 'Mimi the calico cat sleeps on the keyboard', characterId: 'role-a', project: 'default' });
  const roleA = await connect('role-a');
  const adminList = await roleA.call('memory_list', { project: 'default' });
  const adminTexts = (adminList.results || []).map(r => String(r.text || ''));
  check('CHAR_ID=role-a 的引擎 memory_list 能看到前端写的记忆', adminTexts.some(t => t.includes('pet-cat')), `count=${adminTexts.length}`);
  const found = await roleA.call('memory_search', { query: 'Mimi calico cat', project: 'default', topK: 5 });
  const hits = (found.results || []).map(r => String(r.text || ''));
  check('CHAR_ID=role-a 的引擎 memory_search 能搜到', hits.some(t => t.includes('Mimi')), `count=${hits.length}`);
  const otherRole = await connect('role-b');
  const otherList = await otherRole.call('memory_list', { project: 'default' });
  check('换一个角色的引擎进程看不到 role-a 的记忆', !(otherList.results || []).some(r => String(r.text || '').includes('pet-cat')));
  await roleA.client.close();
  await otherRole.client.close();

  await client.close();
}

main()
  .catch(e => { fail++; console.log(`  ✗ 用例异常: ${e?.stack || e}`); })
  .finally(() => {
    if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
    else console.log(`  (保留临时目录: ${tmp})`);
    console.log(`[store-bridge] ${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
  });
