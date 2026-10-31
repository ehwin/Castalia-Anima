#!/usr/bin/env node
/**
 * 回归:实体层 v1.27
 *
 * 覆盖:
 *   1. 事实落库即登记实体(entities / fact_entities / memory_entities),subject 与 object 都建关联。
 *   2. 记忆 ↔ 实体关联来自事实的 source_memory_id(免费,不需要 LLM)。
 *   3. 功能性谓词冲突:姓名=张三 → 姓名=李四 时旧事实被 valid_to 标记(不删除),
 *      facts_conflicts_report 能看到,且 entity_lookup 默认只返回当前有效的那条。
 *   4. entity_lookup:按实体名(大小写/标点无关)命中,返回事实 + 相关记忆 + 邻居实体。
 *   5. memory_graph via=both/depth=2 会带出实体节点与 memory-entity / entity-entity 边。
 *   6. 回填自愈:清掉 fact_entities 后 backfillEntities 能重建,不需要手工迁移。
 *   7. 老库(有 facts 没实体关联)在 DatabaseManager 打开时自动回填。
 *
 * 全程离线:EMBED_MODE=none;库在临时目录,不碰真实 bank。
 * 用法:node scripts/regression_entities.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-entities-'));
const PROJECT = 'enttest';
const CHAR = 'ent-char';

process.env.MEMORY_DB_DIR = tmp;
process.env.MEMORY_CONFIG = path.join(tmp, 'missing-config.json');
process.env.CASTALIA_PROJECT = PROJECT;
process.env.CHAR_ID = CHAR;
process.env.EMBED_MODE = 'none';
process.env.HEALTH_PORT = '0';
process.env.CONSOLIDATE_AUTO_ON_START = '0';

const distUrl = name => pathToFileURL(path.join(ROOT, 'dist', name)).href;
const dbMod = await import(distUrl('db.js'));
const storeMod = await import(distUrl('store.js'));
const entMod = await import(distUrl('entities.js'));
const searchMod = await import(distUrl('search.js'));

async function connect() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      MEMORY_DB_DIR: tmp,
      MEMORY_CONFIG: path.join(tmp, 'missing-config.json'),
      CASTALIA_PROJECT: PROJECT,
      CHAR_ID: CHAR,
      MCP_TOOLS: 'entity,agent,admin',
      EMBED_MODE: 'none',
      HEALTH_PORT: '0',
      CONSOLIDATE_AUTO_ON_START: '0',
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'entities-regression', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text ?? '{}';
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  return { client, call };
}

async function main() {
  // ── 1. 写入:一条记忆 + 三组事实 ──────────────────────────────
  const mem = await storeMod.saveMemory({
    text: '用户自称张三,住在杭州,喜欢乌龙茶。',
    memType: 'general',
    importance: 0.8,
    characterId: CHAR,
    project: PROJECT,
  });
  check('saveMemory 返回 id', typeof mem?.id === 'string' && mem.id.length > 0, JSON.stringify(mem)?.slice(0, 160));

  const r1 = await storeMod.saveFacts([
    { subject: 'user', predicate: '姓名', object: '张三', confidence: 0.95 },
    { subject: 'user', predicate: '居住地', object: '杭州', confidence: 0.9 },
    { subject: '用户', predicate: '喜欢', object: '乌龙茶', confidence: 0.7 },
  ], mem.id, CHAR, PROJECT);
  check('saveFacts 写入 3 条', r1.inserted === 3, JSON.stringify(r1));

  const db = dbMod.DatabaseManager.getInstance(PROJECT);
  const entCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
  const feCount = db.prepare('SELECT COUNT(*) c FROM fact_entities').get().c;
  const meCount = db.prepare('SELECT COUNT(*) c FROM memory_entities').get().c;
  check('entities 已登记(>=5: user/张三/杭州/用户/乌龙茶)', entCount >= 5, `entities=${entCount}`);
  check('fact_entities 每个 fact 两行(2×3=6)', feCount === 6, `fact_entities=${feCount}`);
  check('memory_entities 关联到源记忆', meCount > 0, `memory_entities=${meCount}`);

  const zhangsan = db.prepare("SELECT * FROM entities WHERE key = '张三'").get();
  check('实体键归一化(张三)', !!zhangsan);

  // ── 2. 查询:entity_lookup 的底层函数 ────────────────────────
  const found = entMod.findEntities(db, '  张三 ');
  check('findEntities 忽略首尾空格/大小写', found.length > 0 && found[0].key === '张三', JSON.stringify(found).slice(0, 160));
  const factsOfUser = entMod.entityFacts(db, db.prepare("SELECT id FROM entities WHERE key='user'").get().id, undefined, 20);
  check('entityFacts 返回 user 的 2 条当前事实', factsOfUser.length === 2, `got=${factsOfUser.length}`);
  const memsOfUser = entMod.entityMemories(db, db.prepare("SELECT id FROM entities WHERE key='user'").get().id, 20);
  check('entityMemories 回到源记忆', memsOfUser.some(m => m.id === mem.id), JSON.stringify(memsOfUser).slice(0, 160));

  // ── 2.5 跨 memType: facts/entities 在 general,源记忆在 project ───────
  const crossMem = await storeMod.saveMemory({
    text: '跨分类源记忆:用户偏好嵌入式图引擎。',
    memType: 'project',
    importance: 0.7,
    characterId: CHAR,
    project: PROJECT,
  });
  await storeMod.saveFacts([
    { subject: 'user', predicate: '偏好', object: '嵌入式图引擎', confidence: 0.88 },
  ], crossMem.id, CHAR, PROJECT);
  const memoryDbs = ['general', 'user', 'feedback', 'project', 'reference']
    .map(mt => ({ db: dbMod.DatabaseManager.getInstance(PROJECT, mt), memType: mt }));
  const crossEntity = db.prepare("SELECT id FROM entities WHERE key='嵌入式图引擎'").get();
  const crossMems = entMod.entityMemories(db, crossEntity.id, 20, CHAR, PROJECT, memoryDbs);
  check('跨 memType entityMemories 找回 project 源记忆', crossMems.some(m => m.id === crossMem.id), JSON.stringify(crossMems).slice(0, 240));

  // 2.5b entity-expanded search must also cross the physical partition
  // boundary. The project memory deliberately does not contain the query
  // words; it is reachable only through the two shared fact entities.
  const seedMem = await storeMod.saveMemory({
    text: '用户最近讨论了嵌入式图引擎的取舍。',
    memType: 'general',
    importance: 0.8,
    characterId: CHAR,
    project: PROJECT,
  });
  await storeMod.saveFacts([
    { subject: 'user', predicate: '讨论主题', object: '嵌入式图引擎', confidence: 0.86 },
  ], seedMem.id, CHAR, PROJECT);
  const expandedMem = await storeMod.saveMemory({
    text: '用户在项目库里记录了一次架构方案取舍。',
    memType: 'project',
    importance: 0.8,
    characterId: CHAR,
    project: PROJECT,
  });
  await storeMod.saveFacts([
    { subject: 'user', predicate: '架构选择', object: '嵌入式图引擎', confidence: 0.84 },
  ], expandedMem.id, CHAR, PROJECT);
  const expanded = await searchMod.searchMemory({
    query: '嵌入式图引擎', project: PROJECT, characterId: CHAR,
    topK: 10, countAccess: false,
  });
  check('实体扩散跨 memType 找回 project 记忆', expanded.some(r => r.id === expandedMem.id && r.basis === 'entity'),
    JSON.stringify(expanded.map(r => ({ id: r.id, basis: r.basis, memType: r.memType }))));

  // ── 2.6 provenance 边界:显式来源必须存在且属于目标角色 ────────
  let rejectedUnknownSource = false;
  try {
    await storeMod.saveFacts([
      { subject: 'user', predicate: '未知来源测试', object: '不应落库', confidence: 0.5 },
    ], 'memory-does-not-exist', CHAR, PROJECT);
  } catch (error) {
    rejectedUnknownSource = /source memory not found/i.test(String(error?.message || error));
  }
  check('saveFacts 拒绝未知 sourceMemoryId', rejectedUnknownSource);
  check('未知来源事实没有写入', db.prepare("SELECT COUNT(*) c FROM facts WHERE predicate='未知来源测试'").get().c === 0);

  const otherCharMem = await storeMod.saveMemory({
    text: '另一角色的来源记忆,不能给当前角色背书。',
    memType: 'general',
    importance: 0.7,
    characterId: 'other-character',
    project: PROJECT,
  });
  let rejectedCrossCharacterSource = false;
  try {
    await storeMod.saveFacts([
      { subject: 'user', predicate: '跨角色来源测试', object: '不应落库', confidence: 0.5 },
    ], otherCharMem.id, CHAR, PROJECT);
  } catch (error) {
    rejectedCrossCharacterSource = /source memory not found|does not belong/i.test(String(error?.message || error));
  }
  check('saveFacts 拒绝跨角色 sourceMemoryId', rejectedCrossCharacterSource);
  check('跨角色来源事实没有写入', db.prepare("SELECT COUNT(*) c FROM facts WHERE predicate='跨角色来源测试'").get().c === 0);

  // ── 3. 冲突失效:姓名 张三 → 李四 ───────────────────────────
  await storeMod.saveFacts([{ subject: 'user', predicate: '姓名', object: '李四', confidence: 0.99 }], mem.id, CHAR, PROJECT);
  const report = entMod.conflictsReport(db, 50);
  check('旧事实被标记 valid_to(不删除)', report.invalidated.some(f => f.object === '张三'), JSON.stringify(report.invalidated).slice(0, 200));
  const userEnt = db.prepare("SELECT id FROM entities WHERE key='user'").get().id;
  const current = entMod.entityFacts(db, userEnt, undefined, 20);
  check('当前事实只剩 李四(默认时间点=现在)', current.filter(f => f.predicate === '姓名').length === 1 && current.some(f => f.object === '李四'), JSON.stringify(current.map(f => `${f.predicate}=${f.object}`)));
  const atPast = entMod.entityFacts(db, userEnt, '2000-01-01T00:00:00.000Z', 20);
  check('时间点查(2000 年,早于所有事实)看不到姓名', atPast.filter(f => f.predicate === '姓名').length === 0, JSON.stringify(atPast.map(f => `${f.predicate}=${f.object}`)));
  const vf = db.prepare("SELECT valid_from, valid_to FROM facts WHERE object='李四'").get();
  check('新事实 valid_from 默认为写入时间(不是 NULL)', !!vf.valid_from && vf.valid_from > '2020-01-01', JSON.stringify(vf));
  const backfilledVf = db.prepare("SELECT COUNT(*) c FROM facts WHERE valid_from IS NULL OR valid_from = ''").get().c;
  check('没有 valid_from 为空的事实', backfilledVf === 0, `null_valid_from=${backfilledVf}`);

  // 显式时间窗的事实:2020-01-01 ~ 2021-01-01 有效
  await storeMod.saveFacts([{ subject: 'user', predicate: '工作在', object: '北京', confidence: 0.8, validFrom: '2020-01-01T00:00:00.000Z', validTo: '2021-01-01T00:00:00.000Z' }], mem.id, CHAR, PROJECT);
  const at2020 = entMod.entityFacts(db, userEnt, '2020-06-01T00:00:00.000Z', 20);
  const nowFacts = entMod.entityFacts(db, userEnt, undefined, 20);
  check('显式时间窗:2020 年能看到「工作在=北京」', at2020.some(f => f.object === '北京'), JSON.stringify(at2020.map(f => `${f.predicate}=${f.object}`)));
  check('显式时间窗:现在看不到「工作在=北京」', !nowFacts.some(f => f.object === '北京'), JSON.stringify(nowFacts.map(f => `${f.predicate}=${f.object}`)));

  // ── 4. 实体分类:路径/URL/端口这类"顺手记下的字符串"不算知识实体 ──
  await storeMod.saveFacts([
    { subject: 'agent', predicate: '服务地址', object: 'http://localhost:11434', confidence: 0.6 },
    { subject: 'agent', predicate: '记忆目录', object: 'C:\\memory-banks', confidence: 0.6 },
    { subject: 'agent', predicate: '端口', object: '11434', confidence: 0.5 },
  ], mem.id, CHAR, PROJECT);
  const kindStats = entMod.entityStats(db).byKind;
  check('实体分类:URL → url', (kindStats.url ?? 0) >= 1, JSON.stringify(kindStats));
  check('实体分类:Windows 路径 → path', (kindStats.path ?? 0) >= 1, JSON.stringify(kindStats));
  check('实体分类:纯数字 → number', (kindStats.number ?? 0) >= 1, JSON.stringify(kindStats));
  check('实体分类:user/agent → role', (kindStats.role ?? 0) >= 2, JSON.stringify(kindStats));
  check('实体分类:知识实体 → topic(张三/乌龙茶)', (kindStats.topic ?? 0) >= 2, JSON.stringify(kindStats));
  const pathHit = entMod.findEntities(db, 'C:\\memory-banks');
  check('findEntities 能按路径原样命中(不被归一化拆碎)', pathHit.length > 0 && pathHit[0].kind === 'path', JSON.stringify(pathHit).slice(0, 200));

  // ── 5. 实体图扩散 ───────────────────────────────────────────
  const graph = entMod.expandEntityGraph(db, db.prepare("SELECT id FROM entities WHERE key='张三'").get().id, 2, 50);
  check('expandEntityGraph 从 张三 走到 user/depth=1', graph.entities.some(e => e.key === 'user' && e.depth === 1), JSON.stringify(graph.entities.map(e => `${e.key}@${e.depth}`)));
  check('expandEntityGraph 能回到记忆', graph.memories.length > 0, `memories=${graph.memories.length}`);

  // ── 5. 回填自愈 ─────────────────────────────────────────────
  db.prepare('DELETE FROM fact_entities').run();
  db.prepare('DELETE FROM memory_entities').run();
  check('清空后 fact_entities=0', db.prepare('SELECT COUNT(*) c FROM fact_entities').get().c === 0);
  const allFacts = db.prepare('SELECT COUNT(*) c FROM facts WHERE is_active = 1').get().c;
  const refill = entMod.backfillEntities(db, 1000);
  check('backfillEntities 重建关联(每事实 2 行)', db.prepare('SELECT COUNT(*) c FROM fact_entities').get().c === allFacts * 2, `factsLinked=${refill.factsLinked} / facts=${allFacts}`);
  check('backfillEntities 同时重建 memory_entities', db.prepare('SELECT COUNT(*) c FROM memory_entities').get().c > 0);

  // ── 5.5 反思产物:摘要记忆自动挂实体(跨分类库,靠 memory_entities 无 FK) ──
  const reflectMod = await import(distUrl('reflect.js'));
  const applied = await reflectMod.applyReflectResult({
    summary: '用户最近在研究知识图谱引擎选型,偏好嵌入式方案',
    facts: [{ subject: 'user', predicate: '偏好', object: '嵌入式图引擎', confidence: 0.9 }],
    insights: [],
    actions: [],
    highlights: ['选型'],
  }, CHAR, PROJECT);
  check('applyReflectResult 落 summary 并返回 id', !!applied.summaryId, JSON.stringify(applied.warnings));
  check('applyReflectResult 把摘要记忆挂到事实实体上', applied.entitiesLinked > 0, `entitiesLinked=${applied.entitiesLinked} warnings=${JSON.stringify(applied.warnings)}`);
  const linkedRows = db.prepare('SELECT COUNT(*) c FROM memory_entities WHERE memory_id = ?').get(applied.summaryId).c;
  check('摘要记忆在 memory_entities 里可查', linkedRows > 0, `rows=${linkedRows}`);

  // ── 6. MCP 面:三个工具 ──────────────────────────────────────
  const { client, call } = await connect();
  const tools = (await client.listTools()).tools.map(t => t.name);
  check('MCP 暴露 entity_lookup', tools.includes('entity_lookup'), tools.join(','));
  check('MCP 暴露 facts_conflicts_report', tools.includes('facts_conflicts_report'));

  const lookup = await call('entity_lookup', { name: 'user' });
  check('entity_lookup(user) 命中并给事实', lookup.found === true && lookup.counts?.facts >= 2, JSON.stringify(lookup).slice(0, 240));
  check('entity_lookup(user) 包含跨 memType 源记忆', lookup.memories?.some(m => m.id === crossMem.id), JSON.stringify(lookup.memories).slice(0, 240));
  check('entity_lookup 带上其他候选', Array.isArray(lookup.otherCandidates));

  const lookup2 = await call('entity_lookup', { name: '张三', includeGraph: true });
  check('entity_lookup(张三) 返回邻居实体', lookup2.found === true && Array.isArray(lookup2.neighborEntities) && lookup2.neighborEntities.length > 0, JSON.stringify(lookup2).slice(0, 240));

  const conf = await call('facts_conflicts_report', {});
  check('facts_conflicts_report 看到失效事实', conf.invalidatedCount >= 1, JSON.stringify(conf).slice(0, 200));
  check('facts_conflicts_report 带实体统计', conf.entityStats?.entities >= 5, JSON.stringify(conf.entityStats));

  const mg = await call('memory_graph', { via: 'both', depth: 2, limit: 50 });
  check('memory_graph 带出实体节点', mg.entityCount > 0 && mg.nodes.some(n => n.type === 'entity'), JSON.stringify({ count: mg.count, entityCount: mg.entityCount }));
  check('memory_graph 不把路径/URL 画成知识节点', !mg.nodes.some(n => n.type === 'entity' && ['path', 'url', 'config', 'number'].includes(n.kind)), JSON.stringify(mg.nodes.filter(n => n.type === 'entity').map(n => `${n.label}:${n.kind}`)));
  check('memory_graph 有 memory-entity 边', mg.edges.some(e => e.kind === 'memory-entity'), JSON.stringify(mg.edges.slice(0, 3)));
  const mg2 = await call('memory_graph', { via: 'memory', limit: 50 });
  check('memory_graph via=memory 是旧行为(无实体节点)', mg2.entityCount === 0 && !mg2.nodes.some(n => n.type === 'entity'));

  await client.close();

  // ── 7. 老库自动回填(新进程打开即有实体) ────────────────────
  db.prepare('DELETE FROM fact_entities').run();
  db.close();
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['-e', `
    process.env.MEMORY_DB_DIR = ${JSON.stringify(tmp)};
    process.env.MEMORY_CONFIG = ${JSON.stringify(path.join(tmp, 'missing-config.json'))};
    process.env.EMBED_MODE = 'none';
    const { DatabaseManager } = await import(${JSON.stringify(distUrl('db.js'))});
    const db = DatabaseManager.getInstance(${JSON.stringify(PROJECT)});
    const c = db.prepare('SELECT COUNT(*) c FROM fact_entities').get().c;
    if (c === 0) { console.error('backfill did not run'); process.exit(3); }
    console.log('backfilled=' + c);
  `], { stdio: 'inherit' });
  pass++;
  console.log('  ok  打开老库时自动回填实体(新进程)');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 文件锁:留给系统清理 */ } }
  else console.log(`临时目录保留:${tmp}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('regression crashed:', e); process.exit(2); });
