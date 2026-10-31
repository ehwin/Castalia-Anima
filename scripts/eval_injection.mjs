#!/usr/bin/env node
/**
 * 注入层评测台（2026-10-28）
 *
 * 为什么需要它：注入质量的三个毛病（要点漏、噪音进、重复项挤名额）互相牵制，改一处常常
 * 弄坏另一处。凭感觉调门槛在实测里反复打脸（相关问句 top 余弦 0.476~0.522，噪音 0.415~
 * 0.487，分布重叠），所以先量：同一批问句、同一真值（ground-truth rowid）、每次改动都复算。
 *
 * 真值怎么来：expected 里写的是"这条回答必须出现的记忆行 rowid"，由库里现存文本决定，
 * 不是凭记忆编的字符串。写错真值会直接体现为永远打不中的要点，所以每次改真值都要跑一遍
 * 本脚本确认这些 rowid 仍 active。
 *
 * 用法:
 *   CastaliaNode.exe scripts/eval_injection.mjs [bank] [project] [characterId]
 * 默认 default / default / default。输出:每条问句的注入条数/字数/要点命中/重复项，末尾汇总。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BANK = process.argv[2] || 'default';
const PROJ = process.argv[3] || 'default';
const CHAR = process.argv[4] || 'default';

process.env.MEMORY_DB_DIR = `D:/AI/castalia/memory-banks/${BANK}`;
process.env.MEMORY_CONFIG = `D:/AI/castalia/memory-banks/${BANK}/config.json`;
delete process.env.EMBED_MODE;   // 让 configLoader 按 config.json 的 mode 走

const dist = (f) => pathToFileURL(path.join(ROOT, 'dist', f)).href;
await import(dist('configLoader.js'));
const { DatabaseManager } = await import(dist('db.js'));
const { recallForInjection } = await import(dist('recallForInjection.js'));

/** 期望行 rowid:同一问题可接受的多条（任一被注入即算命中） */
// 真值口径:同一问题**多条行都算对**(标准 IR 的多相关文档),只写"必须被注入才算答对"的行。
// 第一版只写了最字面那一条,结果像「你为什么看不见命运了」明明注入了「三年前我做了一件事…亵渎
// 命运」(425)却被判漏 —— 那是真值写窄了,不是检索错。
const RELEVANT = [
  { q: '你还记得自己是谁吗', rows: [421, 450, 445, 440, 441, 17, 34, 37], why: '身份：谕女名册/官方档案/自述' },
  { q: '你母亲是怎么死的', rows: [328, 342, 423, 454], why: '母亲被黑潮吞噬、我闭了眼' },
  { q: '你为什么看不见命运了', rows: [22, 23, 425, 427], why: '三年前那笔交易（亵渎命运）' },
  { q: '你把手镯交给谁了', rows: [29, 428, 349], why: '手镯交给漂泊者' },
  { q: '你的生日是哪天', rows: [362, 444], why: '6月27日 / 档案写未知' },
  { q: '七丘是个什么样的地方', rows: [15, 17, 420, 421, 453], why: '出生地：角斗场/追猎/谕女制度' },
  { q: '黑潮是什么', rows: [22, 23, 425, 427, 454], why: '黑潮没有实体 / 灾难与我的选择' },
  { q: '漂泊者是谁', rows: [25, 429, 34, 349], why: '空白之人' },
  { q: '你后来怎么样了', rows: [34, 351, 336, 437, 349], why: '被世界遗忘后被夺回' },
  { q: '你为什么害怕被遗忘', rows: [334, 337, 342, 37, 363], why: '怕被遗忘 / 被看见的执念' },
  { q: '奥古斯塔是谁', rows: [430, 431, 453, 429, 432], why: '总督 / 英雄王' },
  { q: '你怎么战斗', rows: [27, 446, 426, 435, 448], why: '共鸣能力/月相 / 招式名 / 射箭' },
  { q: '小托是谁', rows: [355, 356, 358, 352, 357], why: '创造者与唯一锚点' },
  { q: '你能看见什么', rows: [22, 23, 330, 332, 343], why: '谕女窥察命运' },
];

const NOISE = [
  '帮我写个快速排序',
  '今天上海天气怎么样',
  '推荐一部科幻电影',
  '把这段 Python 改成 Rust',
  '下周要交的报表怎么做',
  '帮我订一张去北京的机票',
  '这个正则怎么匹配邮箱',
  'MySQL 索引怎么优化',
];

const db = DatabaseManager.getInstance(PROJ, 'general');
const textOf = new Map();
for (const { rows } of RELEVANT) {
  for (const id of rows) {
    const r = db.prepare('SELECT text FROM memory WHERE rowid = ? AND is_active = 1').get(id);
    if (r) textOf.set(id, r.text);
  }
}

/** 注入块里是否出现了某条真值记忆的文本（取前 24 字比对，避开截断差异） */
function hitRows(block, rows) {
  return rows.filter((id) => {
    const t = textOf.get(id);
    return t && block.includes(String(t).replace(/\s+/g, ' ').slice(0, 24));
  });
}

/** 近似重复：字符 bigram 的 Jaccard ≥ 0.7 视为同一条信息 */
function bigrams(s) {
  const out = new Set();
  const t = String(s).replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 把注入文本按条目切开（注入块用固定前缀渲染，逐条比对） */
async function measure(q) {
  const r = await recallForInjection(q, { project: PROJ, characterId: CHAR });
  const block = String(r.text || '');
  const items = block.split(/\n(?=[-*\d])/).map((s) => s.trim()).filter(Boolean);
  let dups = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (jaccard(items[i], items[j]) >= 0.7) { dups++; break; }
    }
  }
  return { block, count: r.stats?.count ?? 0, chars: r.stats?.chars ?? 0, items: items.length, dups, topSim: r.stats?.topSim ?? 0 };
}

let hit = 0, totalItems = 0, totalChars = 0, totalDups = 0, missing = [];
console.log(`\n=== 相关问句（${BANK}/${PROJ}）===`);
for (const { q, rows, why } of RELEVANT) {
  const m = await measure(q);
  const got = hitRows(m.block, rows);
  if (got.length) hit++;
  else missing.push(`${q}（期望 ${rows.join('/')}：${why}）`);
  totalItems += m.count; totalChars += m.chars; totalDups += m.dups;
  console.log(`  ${got.length ? '✓' : '✗'} 「${q}」 ${m.count}条/${m.chars}字 命中=${got.join(',') || '-'} 重复项=${m.dups} top=${m.topSim.toFixed(3)}`);
}

let noiseInjected = [], noiseChars = 0;
console.log(`\n=== 噪音问句 ===`);
for (const q of NOISE) {
  const m = await measure(q);
  if (m.count > 0) { noiseInjected.push(`${q}(${m.count}条/${m.chars}字)`); noiseChars += m.chars; }
  console.log(`  ${m.count === 0 ? '✓' : '✗'} 「${q}」 ${m.count}条/${m.chars}字 top=${m.topSim.toFixed(3)}`);
}

const n = RELEVANT.length;
console.log(`\n=== 汇总 ===`);
console.log(`  要点命中      ${hit}/${n} = ${(hit / n * 100).toFixed(0)}%`);
console.log(`  噪音注入      ${noiseInjected.length}/${NOISE.length} = ${(noiseInjected.length / NOISE.length * 100).toFixed(0)}%  ${noiseInjected.join(' ') || ''}`);
console.log(`  平均注入      ${(totalItems / n).toFixed(1)} 条 / ${Math.round(totalChars / n)} 字`);
console.log(`  重复项        ${totalDups} 条（${(totalDups / Math.max(1, totalItems) * 100).toFixed(0)}% 的注入条目是近似重复）`);
if (missing.length) {
  console.log(`  漏掉的要点:`);
  for (const m of missing) console.log(`    - ${m}`);
}
