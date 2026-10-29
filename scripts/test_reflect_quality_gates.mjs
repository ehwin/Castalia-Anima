/**
 * 反思质量闸回归(零外网、零费用:本地 mock LLM)。
 *
 * 验的是"该拦的拦住、该放的放过"四件事:
 *  1 证据在来源里找不到(编造)→ 硬拒
 *  2 复述来源、没有新增成分      → 不写
 *  3 与已有洞察近重复            → 不新增,只给已有那条 reference_count +1
 *  4 合格的洞察                  → 写入,重要度用验证器算的而不是模型自评
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-rq-'));
const bank = path.join(tmp, 'bank');
fs.mkdirSync(bank, { recursive: true });

const SRC_A = '用户决定不再用 Electron 主进程跑嵌入,改到 worker 里跑,因为主进程阻塞界面';
const SRC_B = '上周三用户说检索慢,后来发现是切词问题:中文整句不切,导致 LIKE 命中 0';

// ── mock LLM:第 1 次返回"已有洞察",第 2 次返回 5 条覆盖四种判定 ──────────────
let phase = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let insights = [];
    try {
      const payload = JSON.parse(body);
      const user = (payload.messages || []).map(m => m.content).join('\n');
      const i = user.indexOf('输出严格 JSON：');
      const arr = JSON.parse(user.slice(i + '输出严格 JSON：'.length).trim());
      const src = (n) => ({ instance: arr[n].instance, project: arr[n].project, id: arr[n].id, memType: arr[n].memType });
      if (phase++ === 0) {
        // 第一阶段:先落一条"已有洞察",用于第二阶段验近重复
        insights = [{
          text: '嵌入应放在 worker 而不是主进程,避免阻塞界面',
          memType: 'project', importance: 0.7, tags: ['架构'],
          evidence: '改到 worker 里跑', sources: [src(0)],
        }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ insights }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
        return;
      }
      insights = [
        { // 1 合格:有新增成分(因果 + 决定)+ 证据在来源里
          text: '嵌入必须从主进程挪到 worker:主进程跑嵌入会阻塞界面,这是 2026-10-29 定下的架构约束',
          memType: 'project', importance: 0.95, tags: ['架构'],
          evidence: '改到 worker 里跑', sources: [src(0)],
        },
        { // 2 编造:证据在来源里根本找不到
          text: '用户说 GPU 加速失败所以换了 CPU 嵌入',
          memType: 'project', importance: 0.9, tags: ['排障'],
          evidence: 'GPU 加速失败', sources: [src(0)],
        },
        { // 3 复述:几乎是来源原句,且没有新增成分
          text: '上周三用户说检索慢',
          memType: 'general', importance: 0.3, tags: ['检索'],
          evidence: '检索慢', sources: [src(1)],
        },
        { // 4 近重复:与预置洞察措辞高度重合
          text: '嵌入应放在 worker 而不是主进程,避免界面阻塞',
          memType: 'project', importance: 0.8, tags: ['架构'],
          evidence: '改到 worker 里跑', sources: [src(0)],
        },
        { // 5 合格:跨两条来源整合(检索慢的根因是切词 → 结论)
          text: '中文检索失效的根因是切词粒度:整句不切导致 LIKE 命中 0,不是缺向量,所以要先修切词再谈召回率',
          memType: 'general', importance: 0.85, tags: ['检索', '根因'],
          evidence: '中文整句不切', sources: [src(0), src(1)],
        },
      ];
    } catch { /* 解析失败 → 空 insights,checks 会暴露 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ insights }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.MEMORY_DB_DIR = bank;
process.env.REFLECT_DIR = bank;
process.env.REFLECT_LEDGER_FILE = path.join(bank, 'ledger.json');
process.env.CHAR_ID = 'airi';
process.env.EMBED_MODE = 'none';
process.env.REFLECT_LLM_URL = `http://127.0.0.1:${port}`;
process.env.REFLECT_LLM_API_KEY = 'mock';
process.env.REFLECT_LLM_MODEL = 'mock-model';

const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const ra = await import(pathToFileURL(path.join(DIST, 'reflectAll.js')).href);
const iq = await import(pathToFileURL(path.join(DIST, 'insightQuality.js')).href);

// 来源库:两条记录
const srcDb = dbMod.DatabaseManager.getInstance('proj', 'general');
const ids = [];
for (const text of [SRC_A, SRC_B]) {
  const id = dbMod.generateId();
  srcDb.prepare('INSERT INTO memory (id, text, project, character_id, mem_type, importance) VALUES (?,?,?,?,?,?)')
    .run(id, text, 'proj', 'airi', 'general', 0.7);
  ids.push(id);
}

// 预置洞察由第一阶段 reflect 写入(手工建表会被 initProjectSchema 的迁移清掉)
const reflectFile = path.join(bank, 'reflect', 'project', 'memory.sqlite');

console.log(`[reflect-quality-gates] 临时库: ${tmp}`);

console.log('\n1) 提示词契约');
const sys = ra.buildReflectAllSystemPrompt();
check('要求 evidence 逐字复制', sys.includes('逐字复制'));
check('要求不要复述', sys.includes('不要复述'));
check('有配额上限', sys.includes('配额'));
check('schema 里有 evidence 字段', sys.includes('"evidence"'));
check('schema 里有 adds 字段', sys.includes('"adds"'));

console.log('\n2) 四闸判定(纯函数)');
const src = [{ id: 'a', text: SRC_A }];
const vHall = iq.evaluateInsight({ text: '用户说 GPU 加速失败所以换了 CPU 嵌入', evidence: 'GPU 加速失败', sources: src });
check('编造证据被识别', vHall.evidenceOk === false, JSON.stringify(vHall));
check('编造 → not ok', vHall.ok === false);
const vRest = iq.evaluateInsight({ text: '上周三用户说检索慢', sources: [{ id: 'b', text: SRC_B }] });
check('复述被判 restatement', vRest.reasons.includes('restatement'), JSON.stringify(vRest.reasons));
const vGood = iq.evaluateInsight({
  text: '中文检索失效的根因是切词粒度:整句不切导致 LIKE 命中 0',
  evidence: '中文整句不切', sources: [{ id: 'b', text: SRC_B }],
});
check('合格洞察通过', vGood.ok === true, JSON.stringify(vGood));
check('合格洞察新颖度高', vGood.novelty > 0.5, `novelty=${vGood.novelty}`);
check('验证器重要度不是模型自评', vGood.importance !== 0.95);

console.log('\n3) 端到端写入');
const rSeed = await ra.runReflectAll({ projects: ['proj'], all: true });
check('第一阶段先落 1 条已有洞察', rSeed.quality?.written === 1, JSON.stringify(rSeed.quality));
const r = await ra.runReflectAll({ projects: ['proj'], all: true });
check('ok', r.ok === true, JSON.stringify(r.errors));
check('写入 2 条(合格 + 跨源整合)', r.quality?.written === 2, JSON.stringify(r.quality));
check('拦下 1 条编造', r.quality?.evidenceMissing === 1, JSON.stringify(r.quality));
check('拦下 1 条复述', r.quality?.restatement === 1, JSON.stringify(r.quality));
check('拦下 1 条近重复', r.quality?.nearDuplicate === 1, JSON.stringify(r.quality));
check('统计口径 = 5 条', r.quality?.evaluated === 5, JSON.stringify(r.quality));

// 洞察按 memType 落到不同库:跨源那条是 general,种子与架构那条是 project
const generalFile = path.join(bank, 'reflect', 'general', 'memory.sqlite');
const DS = (await import('node:sqlite')).DatabaseSync;
const readAll = (f) => {
  if (!fs.existsSync(f)) return [];
  const d = new DS(f, { readOnly: true });
  const out = d.prepare('SELECT id, text, importance, reference_count, metadata FROM memory WHERE is_active = 1').all();
  d.close();
  return out;
};
const rows = [...readAll(reflectFile), ...readAll(generalFile)];
check('reflect 库内共 3 条(2 新 + 1 预置)', rows.length === 3, `got ${rows.length}`);
const seed = rows.find(x => String(x.text).includes('避免阻塞界面'));
check('近重复只给已有那条 +1 引用', Number(seed.reference_count) === 1, `got ${seed.reference_count}`);
const written = rows.filter(x => x !== seed);
check('新写入的带 evidence', written.every(w => {
  try { return !!JSON.parse(String(w.metadata)).reflection.evidence; } catch { return false; }
}));
check('新写入的带验证器重要度', written.every(w => {
  try { const q = JSON.parse(String(w.metadata)).quality; return typeof q.verifierImportance === 'number' && typeof q.llmImportance === 'number'; } catch { return false; }
}));
check('写入的重要度用的是验证器口径(< 模型自评 0.95)',
  written.some(w => Number(w.importance) < 0.95), JSON.stringify(written.map(w => w.importance)));

console.log('\n4) 幂等:同一批再跑不会重复写入');
const r2 = await ra.runReflectAll({ projects: ['proj'], all: true });
const n2 = rows0 => rows0;
const countAll = () => [...readAll(reflectFile), ...readAll(generalFile)].length;
const before2 = countAll();
check('条数不变(仍 3 条)', before2 === 3, `got ${before2}`);
check('ok', r2.ok === true, JSON.stringify(r2.errors));

await new Promise(r => server.close(r));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n[reflect-quality-gates] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
