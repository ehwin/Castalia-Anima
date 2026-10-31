/**
 * 增量反思账本(Anima 版)回归测试 — 不需要外网、不花一分钱。
 *
 * 用一个本地 mock LLM 服务器返回合法 insights JSON,验证:
 *   1) 首轮:全部记录进 fresh,写库 + 记账
 *   2) 复跑:skipReason='no-new',**零次 LLM 调用**(这是常态成本≈0 的关键路径)
 *   3) 改了正文:该条重新入列(键含内容哈希,不是只按 id)
 *   4) 账本损坏:退回全量(宁可多花一次钱,不漏记忆)
 *   5) all:true:忽略账本全量跑(逃生门)
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-anima-ledger-'));
const bank = path.join(tmp, 'bank');
const ledgerFile = path.join(bank, 'reflect-ledger.json');
fs.mkdirSync(bank, { recursive: true });

// ── mock LLM ────────────────────────────────────────────────────────────────
let calls = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    calls++;
    let insights = [];
    try {
      const payload = JSON.parse(body);
      const user = (payload.messages || []).map(m => m.content).join('\n');
      const i = user.indexOf('输出严格 JSON：');
      const arr = JSON.parse(user.slice(i + '输出严格 JSON：'.length).trim());
      insights = arr.map(r => ({
        text: `洞察(${r.instance}/${r.project}/${r.id})`,
        memType: 'general',
        importance: 0.6,
        tags: ['ledger-test'],
        sources: [{ instance: r.instance, project: r.project, id: r.id, memType: r.memType }],
      }));
    } catch (e) { /* 解析失败就返回空 insights,测试会因 checks 失败而暴露 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ insights }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.MEMORY_DB_DIR = bank;
process.env.REFLECT_DIR = bank;
process.env.REFLECT_LEDGER_FILE = ledgerFile;
process.env.CHAR_ID = 'default';
process.env.EMBED_MODE = 'none';
process.env.REFLECT_LLM_URL = `http://127.0.0.1:${port}`;
process.env.REFLECT_LLM_API_KEY = 'mock';
process.env.REFLECT_LLM_MODEL = 'mock-model';

const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const ra = await import(pathToFileURL(path.join(DIST, 'plugins', 'fullPipeline', 'reflectAll.js')).href);

const db = dbMod.DatabaseManager.getInstance('proj', 'general');
const ids = [];
for (const text of ['第一条记忆:用户在做 示例应用 桌面应用', '第二条记忆:检索要用 bigram 切词']) {
  const id = dbMod.generateId();
  db.prepare('INSERT INTO memory (id, text, project, character_id, mem_type) VALUES (?,?,?,?,?)')
    .run(id, text, 'proj', 'default', 'general');
  ids.push(id);
}

console.log(`[reflect-ledger-anima] 临时库: ${tmp}`);

console.log('\n1) 首轮:全部新增');
const r1 = await ra.runReflectAll({ projects: ['proj'] });
check('ok', r1.ok === true, JSON.stringify(r1.errors));
check('fresh = 2', r1.fresh === 2, `got ${r1.fresh}`);
check('unchanged = 0', r1.unchanged === 0, `got ${r1.unchanged}`);
check('调用 1 次 LLM', calls === 1, `got ${calls}`);
check('账本文件已写', fs.existsSync(ledgerFile));
check('账本无 .tmp 残留', fs.readdirSync(bank).every(f => !f.includes('.tmp-')));

console.log('\n2) 复跑:no-new,零调用');
const before = calls;
const r2 = await ra.runReflectAll({ projects: ['proj'] });
check('ok', r2.ok === true, JSON.stringify(r2.errors));
check("skipReason = 'no-new'", r2.skipReason === 'no-new', `got ${r2.skipReason}`);
check('fresh = 0', r2.fresh === 0, `got ${r2.fresh}`);
check('unchanged = 2', r2.unchanged === 2, `got ${r2.unchanged}`);
check('没有新增 LLM 调用', calls === before, `calls ${before} → ${calls}`);

console.log('\n3) 改正文 → 该条重新入列');
db.prepare('UPDATE memory SET text = ? WHERE id = ?')
  .run('第一条记忆(已修订):用户在做 示例应用 桌面应用 + 插件内嵌引擎', ids[0]);
const r3 = await ra.runReflectAll({ projects: ['proj'] });
check('fresh = 1', r3.fresh === 1, `got ${r3.fresh}`);
check('unchanged = 1', r3.unchanged === 1, `got ${r3.unchanged}`);
check('多调用 1 次', calls === before + 1, `got ${calls}`);

console.log('\n4) 账本损坏 → 退回全量');
fs.writeFileSync(ledgerFile, '{ this is not json');
const r4 = await ra.runReflectAll({ projects: ['proj'] });
check('fresh 回到 2(全量)', r4.fresh === 2, `got ${r4.fresh}`);
check('报告账本读取问题', (r4.errors || []).some(e => String(e).includes('账本')), JSON.stringify(r4.errors));

console.log('\n5) all:true 逃生门');
const r5 = await ra.runReflectAll({ projects: ['proj'], all: true });
check('all:true 时 fresh = 2', r5.fresh === 2, `got ${r5.fresh}`);

console.log('\n6) 纯函数:键带内容哈希');
const k1 = ra.reflectRecordKey({ instance: 'i', project: 'p', id: 'x', text: 'a' });
const k2 = ra.reflectRecordKey({ instance: 'i', project: 'p', id: 'x', text: 'b' });
check('同 id 不同正文 → 不同键', k1 !== k2, `${k1} vs ${k2}`);
check('if 不含正文原文(只存前缀)', !k1.includes('a|'), k1);

// 先彻底关掉 mock 服务器再退出:Node 24 上 process.exit() 撞上仍在关闭的
// libuv async handle 会触发 `Assertion failed: !(flags & UV_HANDLE_CLOSING)`。
try { server.closeAllConnections?.(); } catch (_e) {}
await new Promise(res => server.close(res));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
console.log(`\n[reflect-ledger-anima] ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
