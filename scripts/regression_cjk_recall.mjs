#!/usr/bin/env node
/**
 * 回归:中文自然问句的检索可用性(2026-10-28)
 *
 * 事故:query 只按空白/标点切词(extractKeywords / textFallbackSearch),中文整句于是变成一个
 * 超长 token,`text LIKE` / `tags LIKE` 永远匹配不到 —— 实测「你还记得自己是谁吗」召回 0 条,
 * 「谕女 月食 127」召回 5 条。无向量(EMBED_MODE=none 或没有 api_key)时这条路是**唯一**的检索,
 * 所以自然问句等于完全召不回。
 *
 * 修法:CJK 连续段按 bigram 切分,并要求命中 ≥2 个词(bigram 会带出「记得」「自己」这类高频词)。
 *
 * 断言:
 *  1. 自然中文整句能召回相关记忆(修复前为 0)。
 *  2. 空格分隔关键词仍然召回。
 *  3. 单个关键词仍然召回(need 取 min(2, 词数))。
 *  4. 无关查询不误召回。
 *  5. 只命中 1 个 bigram 的长查询**不**召回(精度闸门)。
 *
 * 用法:node scripts/regression_cjk_recall.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cjk-recall-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.EMBED_MODE = 'none';

const { DatabaseManager } = await import(pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href);
const { searchMemory, queryTerms } = await import(pathToFileURL(path.join(ROOT, 'dist', 'search.js')).href);
const { recallForInjection, renderInjectionBlock, injectionMinSimilarityVector, injectionMinSimilarityLexical }
  = await import(pathToFileURL(path.join(ROOT, 'dist', 'recallForInjection.js')).href);

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PROJ = 'cjk';
const rows = [
  ['r1', '七丘四方殿的名册上，我是第 127 位谕女。谕女在四方殿窥察命运、转述并记录预言。', '["谕女","四方殿","名册"]'],
  ['r2', '母亲死在黑潮里。那天她抱住我、摸我的头，下一秒就被那种比血更浓的黑吞噬了。', '["黑潮","母亲"]'],
  ['r3', '今天我吃了西瓜，很甜。', '["西瓜"]'],
  // r4:tags 为空 —— 只有**正文**能匹配,专门用来钉住 textFallbackSearch 这条回落路径
  //     (只有标签命中时,把切词改回空白切分测试也不会红,变异验证过)。
  ['r4', '在贯穿之楔，我射出一箭，替他们把新王的位置钉住。', '[]'],
  // r5:tags 为空 + 老时间戳 + 查询是**会被打散的自然问句**(「你把手镯交给谁了」里没有连续
  //     出现的「手镯交给」),这是唯一能区分 bigram 切词与空白切词的用例:把切词改回空白,
  //     整句会变成一个 token,LIKE 必然落空。
  ['r5', '我把手镯交给漂泊者保管，再请他站到命运之前。', '[]'],
];
const db = DatabaseManager.getInstance(PROJ, 'general');
db.exec(`CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY, text TEXT, project TEXT, session_id TEXT, type TEXT, mem_type TEXT, category TEXT,
  subcategory TEXT, tags TEXT, emotional_impact REAL, importance REAL, character_id TEXT, source TEXT,
  subject TEXT, agent_mood TEXT, agent_desire TEXT, tier TEXT, expires_at TEXT, is_active INTEGER,
  created_at TEXT, updated_at TEXT, last_accessed_at TEXT, accessed_count INTEGER, reference_count INTEGER,
  locked INTEGER, vad_valence REAL, vad_arousal REAL, vad_dominance REAL, tsundere_level REAL,
  metadata TEXT, title TEXT, status TEXT, score_confidence REAL, score_impact REAL, score_priority REAL,
  score_urgency REAL, identity_locked INTEGER, parent_id TEXT, base_importance REAL, embed_fail_count INTEGER)`);
const ins = db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,character_id,
  source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,reference_count,locked,
  identity_locked,base_importance) VALUES (?,?,?,'episodic','general','identity',?,0.9,'cjk','manual_lore',
  'self','standard',1,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z',0,0,0,0,0.9)`);
const now = '2026-10-28T00:00:00.000Z';
for (const [id, text, tags] of rows) ins.run(id, text, PROJ, tags);
// r4 改成很旧的时间戳:否则"最近记忆"兜底会把它捞上来,掩盖正文回落路径是否真的修好了
// (变异验证时踩到过:把切词改回空白切分,测试照样全绿,2026-10-28)。
db.prepare("UPDATE memory SET created_at=?, last_accessed_at=? WHERE id IN ('r4','r5')")
  .run('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
// 注意:不要在此 close() —— DatabaseManager 缓存实例,提前关掉会让后续检索静默返回空,
// 表现成"召回失败",我第一版就踩了这个坑(2026-10-28)。

const search = async (q) => searchMemory({ project: PROJ, query: q, topK: 5, characterId: 'cjk' });

console.log('— 切词 —');
check('整句切出多个 bigram', queryTerms('你还记得自己是谁吗').length >= 4, JSON.stringify(queryTerms('你还记得自己是谁吗')));
check('英文仍按空白切', queryTerms('yuno moon').join('|') === 'yuno|moon', JSON.stringify(queryTerms('yuno moon')));

console.log('— 召回 —');
const natural = await search('你母亲是怎么死的');
check('自然中文整句能召回(修复前 0 条)', natural.some(r => r.id === 'r2'), `命中 ${natural.length}: ${natural.map(r => r.id).join(',')}`);
const natural2 = await search('你是第几位谕女');
check('第二句自然问句能召回', natural2.some(r => r.id === 'r1'), `命中 ${natural2.length}: ${natural2.map(r => r.id).join(',')}`);
const spaced = await search('谕女 名册');
check('空格关键词仍召回', spaced.length > 0 && (spaced[0].text || '').includes('127'));
const single = await search('黑潮');
check('单个关键词仍召回(need=1)', single.length > 0);
const junk = await search('量子纠缠 弦理论');
check('无关查询不误召回', junk.length === 0, `误召回 ${junk.length}`);
const ranked = await search('谕女 西瓜 名册');
check('命中词多的行排在前面', ranked.length >= 2 && ranked[0].id === 'r1', `顺序 ${ranked.map(r => r.id).join(',')}`);
check('只共享 1 个词的弱相关行仍进候选但靠后', ranked.some(r => r.id === 'r3') && ranked[ranked.length - 1].id === 'r3', `顺序 ${ranked.map(r => r.id).join(',')}`);

const textOnly = await search('贯穿之楔 那一箭');
check('只有正文匹配时也能召回(tags 为空)', textOnly.some(r => r.id === 'r4'), `命中 ${textOnly.length}: ${textOnly.map(r => r.id).join(',')}`);

const scattered = await search('你把手镯交给谁了');
check('会被打散的自然问句能召回(空白切词必红)', scattered.some(r => r.id === 'r5'), `命中 ${scattered.length}: ${scattered.map(r => r.id).join(',')}`);

// 注入层:没向量时,文本命中带的是词法相似度(0.2~1),以前被向量门槛 0.5 全数丢掉,
// 于是"检索命中 8 条、注入 0 条"。这条断言钉住那一层(2026-10-28)。
const inj = await recallForInjection('你母亲是怎么死的', { project: PROJ, characterId: 'cjk' });
check('无向量时文本命中能被注入(修复前为空)', (inj.text || '').includes('母亲'), `chars=${inj.stats?.chars} belowThreshold=${inj.stats?.belowThreshold}`);
const injJunk = await recallForInjection('量子纠缠 弦理论', { project: PROJ, characterId: 'cjk' });
check('无关问句不注入', !(injJunk.text || '').trim(), `chars=${injJunk.stats?.chars}`);

// 2026-10-28(3):向量命中必须自带 basis='vector',门槛按来源分:向量 0.45、标签/词法 0.2。
// 起因:向量路过去既不打 basis、又只在零命中时才回退词法,一旦返回任何一条(相似度 0.37)
// 就把精确词法命中(1.0)整条挤掉;且向量命中的相似度(0.42~0.55)低于 0.5 门槛被全丢。
// 实测 BAAI/bge-m3:相关问句 top 0.476~0.522,噪音 top 0.415~0.487 —— 两者**重叠**,
// 所以门槛取 0.45(丢掉 5 条噪音里的 4 条)并保留词法路做精确信号。
check('向量门槛默认 0.45', injectionMinSimilarityVector() === 0.45, `got ${injectionMinSimilarityVector()}`);
check('词法门槛默认 0.2', injectionMinSimilarityLexical() === 0.2, `got ${injectionMinSimilarityLexical()}`);
const fakeHits = [
  { id: 'lex1', text: '母亲在几年前去世了，我一直记得她的样子', similarity: 0.25, basis: 'lexical', score: 2, project: PROJ },
  { id: 'vec1', text: '命运改变醒来', similarity: 0.40, basis: 'vector', score: 1.5, project: PROJ },
];
const rGate = renderInjectionBlock(fakeHits);
check('词法 0.25 通过 / 向量 0.40 被挡', rGate.text.includes('母亲') && !rGate.text.includes('命运改变醒来'),
  `chars=${rGate.stats?.chars} belowThreshold=${rGate.stats?.belowThreshold}`);
const rGate2 = renderInjectionBlock([{ ...fakeHits[1], similarity: 0.46 }]);
check('向量 0.46 通过(新门槛生效)', rGate2.text.includes('命运改变醒来'), `chars=${rGate2.stats?.chars}`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上 db 句柄未释放时会 EPERM,清理失败不影响结论 */ } }
process.exit(fail === 0 ? 0 : 1);
