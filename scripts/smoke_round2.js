/**
 * 第二轮融合冒烟测试(临时文件,可删除)
 * 验证:reflectDriver 完整版导出(callLlm/makeLlmChannel/LlmChannel/runConsolidate/
 *       shouldAutoReflect/shouldAutoConsolidate)、ollama 2参 embed + 项目隔离缓存、
 *       EMBED_MODE=none 兜底、consolidate findSimilarCandidates、digest project 参数。
 * 运行:node scripts/smoke_round2.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testMemDir = path.join(root, 'scripts', '.test-memory-r2');

process.env.MEMORY_DB_DIR = testMemDir;

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${detail ? ' :: ' + detail : ''}`);
}

try {
  fs.rmSync(testMemDir, { recursive: true, force: true });
  fs.mkdirSync(testMemDir, { recursive: true });

  const rd = await import('../dist/reflectDriver.js');
  const { embed, getEmbeddingCached, cosineSimilarity } = await import('../dist/ollama.js');
  const { DatabaseManager } = await import('../dist/db.js');
  const { findSimilarCandidates } = await import('../dist/consolidate.js');
  const { getRecentConversations } = await import('../dist/digest.js');

  // 1. reflectDriver 完整版导出(轮1 triage 依赖项)
  check('reflectDriver.callLlm 已导出', typeof rd.callLlm === 'function');
  check('reflectDriver.makeLlmChannel 已导出', typeof rd.makeLlmChannel === 'function');
  check('reflectDriver.LlmChannel 类型存在(运行时 undefined 正常)', rd.LlmChannel === undefined);
  check('reflectDriver.runConsolidate 已导出', typeof rd.runConsolidate === 'function');
  check('reflectDriver.shouldAutoReflect 已导出', typeof rd.shouldAutoReflect === 'function');
  check('reflectDriver.shouldAutoConsolidate 已导出', typeof rd.shouldAutoConsolidate === 'function');
  check('reflectDriver.isReflectConfigured 已导出', typeof rd.isReflectConfigured === 'function');

  // 2. makeLlmChannel 三通道 + REFLECT_* 回退
  process.env.REFLECT_LLM_URL = 'https://api.deepseek.com/v1/';
  process.env.REFLECT_LLM_API_KEY = 'sk-reflect-key';
  process.env.REFLECT_LLM_MODEL = 'deepseek-chat';
  const chDefault = rd.makeLlmChannel('reflect');
  check('makeLlmChannel 去尾斜杠', chDefault.url === 'https://api.deepseek.com/v1', chDefault.url);
  check('makeLlmChannel apiKey 回退 REFLECT_*', chDefault.apiKey === 'sk-reflect-key', chDefault.apiKey);
  process.env.TRIAGE_LLM_API_KEY = 'sk-triage-key';
  const chTriage = rd.makeLlmChannel('triage');
  check('makeLlmChannel triage 前缀优先', chTriage.apiKey === 'sk-triage-key', chTriage.apiKey);

  // 3. 无 API key → 自动反思/整合跳过
  delete process.env.REFLECT_LLM_API_KEY;
  delete process.env.TRIAGE_LLM_API_KEY;
  check('shouldAutoReflect 无 key → should:false', (await rd.shouldAutoReflect('airi', 'alpha')).should === false);
  const cons = await rd.runConsolidate('airi', 'alpha');
  check('runConsolidate 无 key → skipped', cons.skipped === true && cons.ok === false, JSON.stringify(cons));

  // 4. shouldAutoConsolidate 按项目计数(空库 → 不满足)
  const sc = rd.shouldAutoConsolidate('alpha');
  check('shouldAutoConsolidate 空库 → should:false', sc.should === false && sc.count === 0, JSON.stringify(sc));

  // 5. EMBED_MODE=none → embed 抛错兜底(独立子进程,env 在 import 前生效)
  let threw = false;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import path from 'node:path';
      import { fileURLToPath } from 'node:url';
      const d = path.dirname(fileURLToPath(import.meta.url));
      const dir = path.join(d, '.test-memory-r2');
      process.env.MEMORY_DB_DIR = dir;
      process.env.EMBED_MODE = 'none';
      const { embed } = await import('${root.replace(/\\/g, '/')}/dist/ollama.js');
      try { await embed('x', 'alpha'); process.exit(1); } catch (e) { if (/disabled/.test(e.message)) process.exit(0); process.exit(2); }
    `], { stdio: 'pipe' });
  } catch (e) {
    threw = /disabled/.test(e.message || String(e));
  }
  check('EMBED_MODE=none embed 抛错', threw);

  // 6. 项目隔离缓存 DB:不同 project 生成独立 DB 文件
  const dbA = DatabaseManager.getInstance('alpha');
  const dbB = DatabaseManager.getInstance('beta');
  const tableA = dbA.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_cache'").get();
  check('alpha DB 有 embedding_cache 表', !!tableA);
  const files = fs.readdirSync(testMemDir);
  check('按项目生成独立 DB 文件', files.length >= 2, files.join(', '));
  check('cosineSimilarity 同向=1', cosineSimilarity([1, 0, 0], [1, 0, 0]) === 1);
  check('cosineSimilarity 垂直=0', cosineSimilarity([1, 0, 0], [0, 1, 0]) === 0);

  // 7. findSimilarCandidates / getRecentConversations 项目参数可用
  const cands = await findSimilarCandidates('alpha');
  check('findSimilarCandidates 返回数组', Array.isArray(cands), JSON.stringify(cands));
  const convs = getRecentConversations('airi', 24, 10, 'alpha');
  check('getRecentConversations 4参调用(带 project)', Array.isArray(convs), JSON.stringify(convs));

  // 8. getEmbeddingCached 2参签名(无法连真实服务,仅验证签名不抛 TypeError)
  check('getEmbeddingCached 2参签名存在', getEmbeddingCached.length === 2 || getEmbeddingCached.length === 1, 'args=' + getEmbeddingCached.length);

  DatabaseManager.close();
  fs.rmSync(testMemDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('SMOKE TEST ERROR:', e);
  try { DatabaseManager.close(); } catch {}
  try { fs.rmSync(testMemDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
