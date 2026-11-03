// 记忆体表面回归：store_list 的时间字段类型与截断上报。
// 背景：真库里 updated_at 既有 INTEGER(epoch) 也有 TEXT，只要默认“一定是字符串”，
// 客户端第一行整数就会抛 value.includes is not a function；列表被 cap 截断时也必须能看出来。
// 用法：node scripts/regression_store_surface.mjs .
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const variant = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-store-'));
const env = {
  ...process.env,
  MEMORY_DB_DIR: temp,
  EMBED_MODE: 'none',
  CHAR_ID: 'probe',
  CASTALIA_PROJECT: 'probe',
  MCP_TOOLS: 'all',
};
delete env.MEMORY_DB_PATH;

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

// 1) 用引擎自己的写入路径建库并落三条，然后把其中两条的时间改成 INTEGER（秒 / 毫秒）
Object.assign(process.env, env);   // 父进程同样要落在临时库，不能写进仓库的 memory/
const { saveMemory } = await import(pathToFileURL(path.join(variant, 'dist', 'store.js')).href);
const ids = [];
for (const i of [1, 2, 3]) {
  const r = await saveMemory({ text: `STORE_SURFACE_${i} 记忆体表面回归`, project: 'probe', characterId: 'probe', memType: 'general', source: 'probe', skipEmbed: true });
  ids.push(r.id);
}
const dbPath = path.join(temp, 'probe', 'general', 'memory.sqlite');
const raw = new Database(dbPath);
raw.prepare('UPDATE memory SET updated_at = ? WHERE id = ?').run(1751600000, ids[1]);            // 秒
raw.prepare('UPDATE memory SET updated_at = ?, created_at = ? WHERE id = ?').run(1751600000123, 1751600000123, ids[2]); // 毫秒
raw.close();

// 2) 起 MCP server（stdio），走真实工具面
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env, cwd: variant, stderr: 'pipe' });
const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} });
await client.connect(transport);
const parse = r => JSON.parse((r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join(''));

try {
  const list = parse(await client.callTool({ name: 'memory_store_list', arguments: { project: 'probe', characterId: 'probe', limit: 500 } }));
  check(list.ok === true, 'store_list 正常返回');
  check(list.total === 3, `total 要等于库里总行数（实际 ${list.total}）`);
  check(list.truncated === false, '未超限时 truncated=false');
  for (const row of list.results) {
    check(typeof row.createdAt === 'string', `createdAt 必须是字符串，收到 ${typeof row.createdAt}（${row.id}）`);
    check(typeof row.updatedAt === 'string', `updatedAt 必须是字符串，收到 ${typeof row.updatedAt}（${row.id}）`);
    check(!Number.isNaN(Date.parse(row.updatedAt)), `updatedAt 必须可解析为时间：${row.updatedAt}`);
  }

  const limited = parse(await client.callTool({ name: 'memory_store_list', arguments: { project: 'probe', characterId: 'probe', limit: 1 } }));
  check(limited.results.length === 1, 'limit=1 只返回一行');
  check(limited.total === 3, 'limit 不影响 total');
  check(limited.truncated === true, '超限时必须 truncated=true');

  const one = parse(await client.callTool({ name: 'memory_get', arguments: { id: ids[0] } }));
  check(typeof one.result?.createdAt === 'string', 'memory_get.createdAt 必须是字符串');
  check(typeof one.result?.updatedAt === 'string', 'memory_get.updatedAt 必须是字符串');
} finally {
  await client.close().catch(() => {});
  // Windows 上子进程可能还握着 sqlite 句柄；清理失败不影响结论
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}

console.log(JSON.stringify({ variant, checks, ok: true }));
