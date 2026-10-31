// Anima 侧的最小回归：facts 形状不合规不得让整轮反思作废(2026-10-23 事故)。
// 纯离线：临时库 + mock fetch，不触网、不写生产库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-facts-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({ reflect: { preservation: 'evidence' } }));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp, MEMORY_CONFIG: config,
  CHAR_ID: 'default',                 // v1.24: 角色 = 进程级实例 ID(本回归显式钉成 default)
  EMBED_MODE: 'api', OLLAMA_URL: 'https://fixture.invalid', EMBEDDING_API_KEY: 'fixture',
  REFLECT_LLM_API_KEY: 'fixture', REFLECT_LLM_URL: 'https://fixture.invalid', REFLECT_LLM_RETRIES: '1',
});
const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager } = await load('db');
const { saveMemory, findDbByMemoryId } = await load('store');
const { runAutoReflect, buildReflectSystemPrompt } = await load('reflectDriver');

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const json = value => ({ content: JSON.stringify(value), finish_reason: 'stop' });

let reply;
const vector = new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));
globalThis.fetch = async url => {
  const u = String(url);
  if (u.endsWith('/embeddings') || u.endsWith('/api/embed')) {
    return new Response(u.endsWith('/embeddings')
      ? JSON.stringify({ data: [{ embedding: vector }] })
      : JSON.stringify({ embeddings: [vector] }), { status: 200 });
  }
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }), { status: 200 });
};

const project = 'anima-facts';
const sourceId = 'anima-source-1';
const m = await saveMemory({ project, text: '用户说：今天想休息一下。', memType: 'general', source: 'conversation_log' });
// is_active 必须留 1：2026-10-29 起软删的对话不再作为抽取来源（reflectionSources 加 AND is_active=1），
// 这里要造的是"还没被分析的一轮对话"，软删它等于没有来源 —— 实测会得到「无未分析对话」。
findDbByMemoryId(m.id, project).db.prepare("UPDATE memory SET id=?, is_active=1, created_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(sourceId, m.id);

const batch = [{ id: sourceId, text: '用户说：今天想休息一下。' }];
const extraction = facts => JSON.stringify({
  processedSourceIds: [sourceId],
  summary: '导航',
  highlights: [],
  facts,
  insights: [],
  actions: [{ action: 'extract', sourceId, newText: '用户说：今天想休息一下。', newMemType: 'project', newCategory: 'emotional', newSubject: 'self' }],
});

const prompt = buildReflectSystemPrompt();
check(/subject/.test(prompt) && /predicate/.test(prompt) && /sourceId,"text"|sourceId.*text/.test(prompt), 'emotional prompt documents the facts field contract');

reply = extraction(['纯字符串事实', { sourceId, text: '非三元组' }, { subject: 'user', predicate: '称呼', object: '示例', confidence: 0.9 }]);
let r = await runAutoReflect('default', 30, project);
check(r.ok && r.processedCount === 1 && r.applied === 1, 'batch still advances: ' + JSON.stringify(r));
check(r.factsInserted === 1, 'only the well-formed fact is stored');
check((r.warnings || []).some(w => w.includes('facts')), 'dropped facts leave an audit warning');

reply = extraction(['再来一条纯字符串']);
const r2 = await runAutoReflect('default', 30, project);
check(r2.skipped || (r2.ok && r2.processedCount === 0), 'no pending sources after advancement');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, productionWrites: 0 }));
