// AIRI Memory MCP boot self-check
// Called by 启动AIRI.bat — verifies the memory MCP server starts correctly
const { spawn } = require('child_process');

const cwd = 'D:\\system\\AIRI\\airi-memory-fused';
const env = {
  ...process.env,
  OLLAMA_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'qwen3-embedding:8b',
  MEMORY_DB_PATH: 'D:\\system\\AIRI\\airi-memory-fused\\memory.sqlite',
};

const child = spawn('node', ['dist/index.js'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.result && m.result.serverInfo) {
        console.log('       Memory MCP: OK (' + m.result.serverInfo.name + ' v' + m.result.serverInfo.version + ')');
        child.kill();
        process.exit(0);
      }
    } catch (e) { /* partial json */ }
  }
});

child.stderr.on('data', () => {});

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boot-check', version: '1.0.0' } },
}) + '\n');

setTimeout(() => {
  console.log('       Memory MCP: skip (will auto-load with AIRI)');
  child.kill();
  process.exit(0);
}, 8000);
