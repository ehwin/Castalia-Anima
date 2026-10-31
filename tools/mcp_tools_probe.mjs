// Probe an MCP stdio server: initialize, then list tools. Prints names + count.
// usage: node tools/mcp_tools_probe.mjs <path-to-dist/index.js>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const entry = process.argv[2];
if (!entry) { console.error('usage: node tools/mcp_tools_probe.mjs <dist/index.js>'); process.exit(2); }

const bank = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-probe-'));
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, MEMORY_DB_DIR: bank, EMBED_MODE: 'none', MCP_TOOLS: 'all', CASTALIA_PROJECT: 'probe' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const tools = [];
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (msg.id === 2) {
      if (msg.result?.tools) tools.push(...msg.result.tools.map(t => t.name));
      else if (msg.error) { console.error('tools/list error', JSON.stringify(msg.error)); }
      console.log(JSON.stringify({ count: tools.length, tools: tools.sort() }, null, 2));
      child.kill();
      fs.rmSync(bank, { recursive: true, force: true });
      process.exit(0);
    }
    if (msg.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  }
});
child.stderr.on('data', d => process.stderr.write(d));

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
setTimeout(() => { console.error('timeout'); child.kill(); process.exit(1); }, 30000);
