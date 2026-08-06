/**
 * 第四轮融合冒烟测试(临时文件,可删除)
 * 验证:MCP server 启动后 tools/list = 31 个工具,
 *       含 Anima 独有 mood_journal / user_observe 与通用版新增
 *       memory_context / consolidate_deep / instruction_save。
 * 附带:调用 memory_save(mood/emotionalImpact)、mood_journal、user_observe、
 *       context_get、auto_process(带 sessionId)验证 handler 不崩。
 * 运行:node scripts/smoke_round4.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testMemDir = path.join(root, 'scripts', '.test-memory-r4');

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${detail ? ' :: ' + detail : ''}`);
}

fs.rmSync(testMemDir, { recursive: true, force: true });
fs.mkdirSync(testMemDir, { recursive: true });

const child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
  cwd: root,
  env: {
    ...process.env,
    MEMORY_DB_DIR: testMemDir,
    EMBED_MODE: 'none',
    CHAR_ID: 'airi',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

const pending = new Map();
let nextId = 1;
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting ${method}`));
    }, 20000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

(async () => {
  try {
    // 1. initialize
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke-round4', version: '0.0.1' },
    });
    check('initialize 返回 serverInfo', init.result && init.result.serverInfo, JSON.stringify(init.result?.serverInfo));

    // 2. initialized notification
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // 3. tools/list
    const listRes = await rpc('tools/list', {});
    check('tools/list 返回工具数组', listRes.result && Array.isArray(listRes.result.tools), JSON.stringify(listRes.error || ''));

    const tools = (listRes.result && listRes.result.tools) || [];
    const names = tools.map(t => t.name);
    check('工具总数 = 31', names.length === 31, 'count=' + names.length);
    check('无重复工具名', new Set(names).size === names.length, 'unique=' + new Set(names).size);

    const required = [
      'mood_journal', 'user_observe',
      'memory_context', 'consolidate_deep', 'instruction_save',
      'memory_get', 'memory_index', 'memory_log', 'project_list', 'instruction_list', 'instruction_delete',
      'reflect_batch_embed', 'daily_summary_data', 'recent_conversations', 'stats_get',
    ];
    for (const t of required) check(`含工具 ${t}`, names.includes(t));

    const expected31 = [
      'memory_search', 'fact_search', 'memory_save', 'memory_delete', 'memory_update', 'memory_log',
      'auto_process', 'digest_run', 'conversation_save', 'context_get', 'memory_context', 'stats_get',
      'memory_list', 'memory_get', 'memory_graph', 'memory_recent', 'memory_index', 'recent_conversations',
      'reflect_analyze', 'reflect_apply', 'reflect_auto', 'reflect_deep', 'reflect_batch_embed',
      'consolidate_deep', 'daily_summary_data', 'project_list',
      'instruction_save', 'instruction_list', 'instruction_delete',
      'mood_journal', 'user_observe',
    ];
    const missing = expected31.filter(n => !names.includes(n));
    check('31 清单逐一对齐(missing=' + missing.length + ')', missing.length === 0, missing.join(','));

    // 4. memory_save(mood + emotionalImpact)
    const saveRes = await rpc('tools/call', { name: 'memory_save', arguments: {
      text: '用户提到最近分手,情绪低落', category: 'emotional', emotionalImpact: 8.2,
      importance: 0.8, type: 'episodic', source: 'smoke_r4', skipEmbed: true,
    } });
    check('memory_save(emotionalImpact) 执行成功', saveRes.result && !saveRes.result.isError, JSON.stringify(saveRes.result?.isError));

    // 5. mood_journal
    const moodRes = await rpc('tools/call', { name: 'mood_journal', arguments: { days: 7 } });
    check('mood_journal 执行成功', moodRes.result && !moodRes.result.isError, JSON.stringify(moodRes.result?.isError));
    if (moodRes.result && !moodRes.result.isError) {
      const parsed = JSON.parse(moodRes.result.content[0].text);
      check('mood_journal 返回 moods 含 emotion 记忆', parsed.ok && Array.isArray(parsed.moods) && parsed.moods.some(m => m.value === 8.2), 'moods=' + (parsed.moods?.length ?? 0));
    }

    // 6. user_observe
    const obsRes = await rpc('tools/call', { name: 'user_observe', arguments: { message: '我今天加班到很晚才回家' } });
    check('user_observe 执行成功', obsRes.result && !obsRes.result.isError, JSON.stringify(obsRes.result?.isError));

    // 7. context_get(agent 状态 + 记忆上下文)
    const ctxRes = await rpc('tools/call', { name: 'context_get', arguments: {} });
    check('context_get 执行成功', ctxRes.result && !ctxRes.result.isError, JSON.stringify(ctxRes.result?.isError));
    if (ctxRes.result && !ctxRes.result.isError) {
      const parsed = JSON.parse(ctxRes.result.content[0].text);
      check('context_get 含 state(agent 情感态)', parsed.ok && typeof parsed.state === 'string' && parsed.state.length > 0, String(parsed.state).slice(0, 60));
      check('context_get 含 bias/profile 字段', parsed.ok && 'bias' in parsed && 'profile' in parsed);
      check('context_get 含 stats.total', parsed.ok && typeof parsed.stats?.total === 'number', String(parsed.stats?.total));
    }

    // 8. auto_process(sessionId 缓冲 + mood 透传)
    const apRes = await rpc('tools/call', { name: 'auto_process', arguments: {
      userMessage: '今天心情不错,代码写完很顺畅',
      assistantMessage: '太好了,为你高兴。',
      moodValue: 7.5, moodReason: '用户开心',
      sessionId: 'sess-r4-001',
    } });
    check('auto_process(sessionId+mood) 执行成功', apRes.result && !apRes.result.isError, JSON.stringify(apRes.result?.isError));
    if (apRes.result && !apRes.result.isError) {
      const parsed = JSON.parse(apRes.result.content[0].text);
      check('auto_process 透传 moodProcessed=true', parsed.ok && parsed.moodProcessed === true, String(parsed.moodProcessed));
      check('auto_process 会话缓冲 +1', parsed.ok && Array.isArray(parsed.details) && parsed.details.some(d => d.includes('session buffer +1')), JSON.stringify(parsed.details));
    }

    // 9. digest_run(EMBED_MODE=none 下安全,消费 VAD 队列)
    const dgRes = await rpc('tools/call', { name: 'digest_run', arguments: {} });
    check('digest_run 执行成功', dgRes.result && !dgRes.result.isError, JSON.stringify(dgRes.result?.isError));

    // 10. memory_context(prompt 组装,带 instructions 层)
    const mcRes = await rpc('tools/call', { name: 'memory_context', arguments: { query: '分手', asText: true } });
    check('memory_context 执行成功', mcRes.result && !mcRes.result.isError, JSON.stringify(mcRes.result?.isError));

    // 11. MCP_TOOLS=agent 时只注册 agent 组(验证分组机制)
    const nlines = stderrBuf.split('\n').filter(l => l.trim()).length;
    console.log(`\n[stderr] ${nlines} 行日志;工具跳过行(应有 0): ${(stderrBuf.match(/\[tools\] skipped/g) || []).length}`);
  } catch (e) {
    console.error('SMOKE TEST ERROR:', e.message);
    failures++;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    child.kill('SIGKILL');
  }

  fs.rmSync(testMemDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
