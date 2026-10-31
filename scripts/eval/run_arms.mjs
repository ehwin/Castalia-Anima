#!/usr/bin/env node
/**
 * run_arms.mjs —— 金标检索基准：每个臂一份独立库副本，跑同一批查询，报 命中@k / MRR。
 *
 * 为什么要有它：`src/search.ts` 的权重、相似度上限、时间衰减都是「看起来能拍脑袋改」
 * 的常量，而仓库里此前没有任何办法在仓库内回答「这次改动让检索变好还是变差」。
 * 这个跑法把 2026-10-31 那轮实验的判据固化下来（69 条金标，见 queries.gold.json）。
 *
 * 用法：
 *   node scripts/eval/run_arms.mjs --db <库根> --project airi
 *   node scripts/eval/run_arms.mjs --db <库根> --project airi --arms default,time015,emo0
 *   node scripts/eval/run_arms.mjs --db <库根> --project airi --dist <另一个构建的 dist>
 *
 * 参数：
 *   --db <dir>        库根（其下有 <project>/<character>/<memtype>/memory.sqlite）。
 *                     **必须是一份可丢弃的副本**：每个臂都会再复制一份，源库只读。
 *   --project <name>  项目名，默认 airi
 *   --character <id>  角色名，默认与 project 相同
 *   --arms <list>     逗号分隔，默认 default。可用臂见 ARMS 表，也可写自定义
 *                     `name:ENV=VAL;ENV=VAL` 形式。
 *   --dist <dir>      被评测的构建目录，默认仓库内 dist/。要比较「改代码常量」的两个
 *                     构建（例如相似度上限 0.70 与 0.95）就各跑一次并传不同的 --dist。
 *   --topk <n>        默认 10（命中@10 需要它）
 *   --embed <mode>    默认 none：纯词法。向量路需要可用的嵌入端点，跨机器不可复现，
 *                     所以基准默认关掉；要测向量路显式传 --embed auto。
 *   --out <file>      把完整结果（含逐条排名）写进 JSON。
 *   --keep            保留臂副本（排障用），默认跑完即删。
 *   --json            只打 JSON（供别的脚本消费）。
 *
 * 退出码：0 = default 臂不低于 expected.json 的命中@1 − 2pp；
 *         1 = 低于；2 = 环境/参数错误（缺 dist、缺查询集、库不存在）。
 *
 * 纪律（README 里也写了，因为这是踩出来的）：
 *   1) 每臂独立副本 —— 检索会写 memory_access_log / last_accessed_at，共用副本会污染
 *      后续臂（2026-10-31 因此作废过一整轮）。
 *   2) 报数必须同时报常数基线（--arms constant），否则会把常数先验读成机制收益。
 *   3) 金标是「查询=原文片段」，词法通道天然容易命中；它测的是「权重会不会把正确的
 *      行挤下去」，不是绝对检索难度。别拿它当线上效果。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));

/** 臂表：只放「可被环境变量表达」的旋钮。改代码常量的对照要用 --dist 换构建。 */
const ARMS = {
  default: {},
  // 2026-10-31 之前的时间衰减权重（R38 的对照）
  time015: { WEIGHT_TIME: '0.15' },
  // 情感权重：0 = 关掉情感项；1.0 = 实验里被否掉的那一档（R33）
  emo0: { WEIGHT_EMOTION: '0' },
  emo100: { WEIGHT_EMOTION: '1.0' },
  // 常数基线：永远返回同一批 id（README 纪律 2 的对照）
  constant: { __CONSTANT__: '1' },
};

function parseArgs(argv) {
  const out = {
    db: '', project: 'airi', character: '', arms: 'default', dist: path.join(REPO, 'dist'),
    topk: 10, embed: 'none', out: '', keep: false, json: false,
    child: '', childOut: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--db') out.db = next();
    else if (a === '--project') out.project = next();
    else if (a === '--character') out.character = next();
    else if (a === '--arms') out.arms = next();
    else if (a === '--dist') out.dist = next();
    else if (a === '--topk') out.topk = Number(next());
    else if (a === '--embed') out.embed = next();
    else if (a === '--out') out.out = next();
    else if (a === '--keep') out.keep = true;
    else if (a === '--json') out.json = true;
    // 内部：子进程模式
    else if (a === '--_child') out.child = next();
    else if (a === '--_child-out') out.childOut = next();
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  if (!out.character) out.character = out.project;
  return out;
}

const QS_PATH = path.join(HERE, 'queries.gold.json');
const EXP_PATH = path.join(HERE, 'expected.json');

// ─────────────────────────────────────────────────────────────────────────────
// 子进程模式：真正跑一个臂。模块级常量在 import 时读取，所以每个臂必须是新进程。
// ─────────────────────────────────────────────────────────────────────────────
async function runChild(opts) {
  // 驱动进程用 JSON 字符串传臂定义（跨进程只能是字符串）
  const spec = typeof opts.child === 'string' ? JSON.parse(opts.child) : opts.child;
  const QS = JSON.parse(fs.readFileSync(QS_PATH, 'utf8'));
  await import(pathToFileURL(path.join(opts.dist, 'configLoader.js')).href);
  const { searchMemory } = await import(pathToFileURL(path.join(opts.dist, 'search.js')).href);
  const Database = require('better-sqlite3');

  const dbPath = path.join(opts.db, opts.project, opts.character, 'general', 'memory.sqlite');
  const db = fs.existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null;
  const constantIds = spec.__CONSTANT__
    ? (db ? db.prepare('SELECT id FROM memory WHERE is_active = 1 ORDER BY created_at DESC LIMIT ?')
      .all(opts.topk).map(r => String(r.id)) : [])
    : null;
  if (db) db.close();

  const per = [];
  for (const item of QS.查询) {
    let items = [];
    try {
      const r = constantIds
        ? constantIds.map((id, i) => ({ id, score: 1 - i * 1e-6 }))
        : await searchMemory({ query: item.q, project: opts.project, topK: opts.topk, accessChannel: 'diagnostic' });
      items = r.map(x => ({ id: String(x.id), score: x.score }));
    } catch (e) {
      items = [];
      per.push({ q: item.q, error: String(e?.message || e), ids: [] });
      continue;
    }
    per.push({ q: item.q, ids: items.map(i => i.id), scores: items.map(i => +(i.score ?? 0).toFixed(4)) });
  }
  const payload = { per };
  if (opts.childOut) fs.writeFileSync(opts.childOut, JSON.stringify(payload));
  else process.stdout.write('__EVAL__' + JSON.stringify(payload));
}

// ─────────────────────────────────────────────────────────────────────────────
// 驱动模式
// ─────────────────────────────────────────────────────────────────────────────
function expandArms(list) {
  const names = list.split(',').map(s => s.trim()).filter(Boolean);
  return names.map(name => {
    if (ARMS[name]) return { name, env: ARMS[name] };
    const idx = name.indexOf(':');
    if (idx > 0) {
      const env = {};
      for (const kv of name.slice(idx + 1).split(';')) {
        const [k, ...rest] = kv.split('=');
        if (k && rest.length) env[k.trim()] = rest.join('=').trim();
      }
      return { name: name.slice(0, idx), env };
    }
    throw new Error(`未知臂: ${name}（可用: ${Object.keys(ARMS).join(', ')}，或 name:ENV=VAL）`);
  });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.child) return runChild(opts);

  if (!opts.db) { console.error('缺少 --db <库根>'); process.exit(2); }
  if (!fs.existsSync(path.join(opts.dist, 'search.js'))) {
    console.error(`找不到 ${path.join(opts.dist, 'search.js')}（先 npm run build）`); process.exit(2);
  }
  if (!fs.existsSync(path.join(opts.db, opts.project))) {
    console.error(`库里没有项目 ${opts.project}: ${path.join(opts.db, opts.project)}`); process.exit(2);
  }
  if (!fs.existsSync(QS_PATH)) { console.error(`缺少 ${QS_PATH}`); process.exit(2); }

  const QS = JSON.parse(fs.readFileSync(QS_PATH, 'utf8'));
  const { summarize, mcnemarExact } = await import(pathToFileURL(path.join(HERE, 'metrics.mjs')).href);
  const goldOf = new Map(QS.查询.map(x => [x.q, new Set(x.gold)]));

  const arms = expandArms(opts.arms);
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-eval-'));
  const results = [];

  for (const arm of arms) {
    const armRoot = path.join(runRoot, arm.name);
    // 每臂独立副本：只复制该项目的目录，源库只读。
    copyDir(path.join(opts.db, opts.project), path.join(armRoot, opts.project));
    const childOut = path.join(armRoot, '__eval.json');
    const env = {
      ...process.env,
      MEMORY_DB_DIR: armRoot,
      CASTALIA_PROJECT: opts.project,
      CHAR_ID: opts.character,
      MEMORY_CONFIG: path.join(armRoot, '__empty-config.json'),
      ...(opts.embed === 'none' ? { EMBED_MODE: 'none' } : {}),
      ...arm.env,
    };
    fs.writeFileSync(env.MEMORY_CONFIG, '{}');
    const child = spawnSync(process.execPath, [
      fileURLToPath(import.meta.url),
      '--_child', JSON.stringify(arm.env),
      '--_child-out', childOut,
      '--db', armRoot, '--project', opts.project, '--character', opts.character,
      '--dist', opts.dist, '--topk', String(opts.topk),
    ], { env, encoding: 'utf8' });
    if (child.status !== 0 || !fs.existsSync(childOut)) {
      console.error(`[${arm.name}] 子进程失败 (exit=${child.status})`);
      if (child.stderr) console.error(child.stderr.trim().split('\n').slice(-6).join('\n'));
      results.push({ arm: arm.name, failed: true });
    } else {
      const { per } = JSON.parse(fs.readFileSync(childOut, 'utf8'));
      const s = summarize(per, goldOf);
      results.push({ arm: arm.name, env: arm.env, ...s });
    }
    if (!opts.keep) fs.rmSync(armRoot, { recursive: true, force: true });
  }
  // --keep 要真的留住副本（原来是无条件删，flag 形同虚设，评审 P3-5）
  if (!opts.keep) fs.rmSync(runRoot, { recursive: true, force: true });
  else console.log(`\n（--keep）臂副本保留在: ${runRoot}`);

  const byArm = new Map(results.map(r => [r.arm, r]));
  const base = byArm.get('default');
  // default 臂失败 ≠ 通过：门禁只对「真的跑出数」的 default 有意义。
  if (!base || base.failed) {
    console.error('default 臂没有产出结果（见上面的子进程错误），无法判定门禁');
    process.exit(2);
  }
  const pairings = [];
  for (const r of results) {
    if (r.failed || r === base) continue;
    for (const k of [1, 5]) {
      const m = mcnemarExact(base.perQuery, r.perQuery, k);
      pairings.push({ 对比: `default vs ${r.arm}`, 指标: `命中@${k}`, ...m, p显示: m.p < 1e-4 ? '<0.0001' : String(m.p) });
    }
  }

  const expected = fs.existsSync(EXP_PATH) ? JSON.parse(fs.readFileSync(EXP_PATH, 'utf8')) : null;
  let gate = null;
  if (expected && base && !base.failed) {
    const floor = expected.hit1 - 0.02;
    // 常数臂必须≈0：金标宽到「永远返回同一批 id 也能中」，那这份基准就没有判别力。
    // expected.json 里写了这条，但代码原来只是打印（评审 P3-5）。
    const constArm = byArm.get('constant');
    const constLimit = 0.05;
    gate = {
      期望命中1: expected.hit1, 下限: +floor.toFixed(3), 实测命中1: base.hit1,
      常数臂命中1: constArm && !constArm.failed ? constArm.hit1 : null,
      常数臂上限: constLimit,
      ok: base.hit1 >= floor && (!constArm || constArm.failed || constArm.hit1 <= constLimit),
    };
    if (constArm && !constArm.failed && constArm.hit1 > constLimit) {
      gate.原因 = `常数基线臂命中@1=${constArm.hit1} > ${constLimit} —— 金标太宽，先修查询集`;
    }
  }

  const report = {
    _meta: {
      脚本: 'scripts/eval/run_arms.mjs',
      构建: opts.dist,
      查询集: `queries.gold.json（${QS.总数} 条）`,
      嵌入: opts.embed,
      topK: opts.topk,
      生成时间: new Date().toISOString(),
    },
    各臂: results.map(({ perQuery, ...rest }) => ({ ...rest, 逐条: perQuery ?? [] })),
    配对: pairings,
    门禁: gate,
  };
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`构建: ${opts.dist}   嵌入: ${opts.embed}   查询: ${QS.总数} 条\n`);
    console.log('臂            命中@1  命中@5  命中@10  MRR    未命中');
    for (const r of results) {
      if (r.failed) { console.log(`${r.arm.padEnd(13)} 失败`); continue; }
      console.log(`${r.arm.padEnd(13)} ${(r.hit1 * 100).toFixed(1).padStart(6)}% ${(r.hit5 * 100).toFixed(1).padStart(6)}% ${(r.hit10 * 100).toFixed(1).padStart(6)}%  ${r.mrr.toFixed(3)}  ${r.misses}`);
    }
    for (const p of pairings) {
      console.log(`配对 ${p.对比} · ${p.指标}: 仅前者命中 ${p.onlyA} / 仅后者 ${p.onlyB}，精确 McNemar p=${p.p显示}`);
    }
    if (gate) {
      console.log(`\n门禁: default 命中@1 ${(gate.实测命中1 * 100).toFixed(1)}% vs 期望 ${(gate.期望命中1 * 100).toFixed(1)}%（下限 ${(gate.下限 * 100).toFixed(1)}%）→ ${gate.ok ? '通过' : '不通过'}`);
    } else if (!expected) {
      console.log('\n（没有 expected.json，跳过门禁）');
    }
  }
  process.exit(gate && !gate.ok ? 1 : 0);
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(2); });
