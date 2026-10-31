// End-to-end smoke over MCP stdio: initialize -> memory_save -> memory_search.
// Proves the packaged engine actually writes and retrieves, not just lists tools.
// usage: node tools/e2e_memory.mjs [dist/index.js]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const entry = process.argv[2] || 'dist/index.js';
const bank = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-e2e-'));
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, MEMORY_DB_DIR: bank, EMBED_MODE: 'none', MCP_TOOLS: 'all', CASTALIA_PROJECT: 'e2e' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {}); // engine logs to stderr

const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
  });
}
const payload = (resp) => {
  if (resp.error) throw new Error(JSON.stringify(resp.error));
  const text = resp.result?.content?.[0]?.text;
  if (resp.result?.isError) throw new Error(text || 'tool error');
  return JSON.parse(text);
};

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const saved = payload(await rpc('tools/call', {
    name: 'memory_save',
    arguments: { text: '用户喜欢在凌晨改向量索引，喝手冲咖啡。', project: 'e2e', memType: 'project', source: 'manual' },
  }));
  console.log('save:', JSON.stringify(saved).slice(0, 160));

  const found = payload(await rpc('tools/call', {
    name: 'memory_search',
    arguments: { query: '手冲咖啡', project: 'e2e', topK: 5 },
  }));
  const hit = (found.results || []).some(r => String(r.text || '').includes('手冲咖啡'));
  console.log('search count:', found.count, 'hit:', hit);
  if (!hit) throw new Error('saved memory not retrievable');
  console.log('E2E PASS');
} catch (e) {
  console.error('E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => { try { fs.rmSync(bank, { recursive: true, force: true }); } catch {} process.exit(process.exitCode || 0); }, 500);
}
