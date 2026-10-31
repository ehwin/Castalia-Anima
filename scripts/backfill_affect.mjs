/**
 * 回填情感(VAD)到已有记忆 —— 用本地词表,只填空缺,不覆盖模型结果。
 *
 * 背景:default bank 262 条活跃记忆 0 条有 vad_valence,原因是唯一来源 Ollama 没跑,
 * 而失败路径把整批静默丢弃(见 emotion.ts 里的注释)。新写入已修;历史数据需要这次回填。
 *
 * 用法:
 *   node scripts/backfill_affect.mjs                       # 默认 dry-run,只统计
 *   node scripts/backfill_affect.mjs --apply               # 真写(只写 vad_valence IS NULL 的行)
 *   node scripts/backfill_affect.mjs --bank D:/castalia/memory-banks/default --apply
 *
 * 安全:只更新 VAD 三列 + emotional_impact(=0 时)+ 空 tags;
 * 不碰 text/importance/tags 已有的值;--apply 前建议先在副本上跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIST = path.resolve(HERE, '..', 'dist');
const lex = await import(pathToFileURL(path.join(DIST, 'affectLexicon.js')).href);
const D = (await import('better-sqlite3')).default;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const bankIdx = argv.indexOf('--bank');
const BANK = bankIdx >= 0 ? argv[bankIdx + 1] : (process.env.CASTALIA_BANK_ROOT ? path.join(process.env.CASTALIA_BANK_ROOT, 'default') : 'D:/castalia/memory-banks/default');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('_backup')) walk(p); }
    else if (e.name === 'memory.sqlite') files.push(p);
  }
})(BANK);

let total = 0, missing = 0, scored = 0, pos = 0, neg = 0, written = 0;
const samples = [];
for (const f of files) {
  const db = new D(f);
  try {
    const rows = db.prepare(`SELECT id, text, project, emotional_impact, tags FROM memory
      WHERE is_active = 1 AND vad_valence IS NULL AND length(trim(text)) > 4`).all();
    total += db.prepare('SELECT COUNT(*) n FROM memory WHERE is_active = 1').get().n;
    missing += rows.length;
    const upd = db.prepare(`UPDATE memory SET vad_valence = ?, vad_arousal = ?, vad_dominance = ?,
        emotional_impact = CASE WHEN COALESCE(emotional_impact,0) = 0 THEN ? ELSE emotional_impact END,
        tags = CASE WHEN tags IS NULL OR tags = '[]' THEN ? ELSE tags END
        WHERE id = ?`);
    const tx = db.transaction((list) => {
      for (const r of list) {
        const s = lex.scoreAffect(String(r.text));
        if (s.confidence <= 0) continue;
        scored++;
        if (s.valence > 0.15) pos++; else if (s.valence < -0.15) neg++;
        if (samples.length < 6) samples.push({ text: String(r.text).slice(0, 40), v: s.valence, a: s.arousal, hit: s.matched.join(',') });
        if (APPLY) { upd.run(s.valence, s.arousal, s.dominance, lex.affectImpact(s), JSON.stringify(s.matched.slice(0, 3)), r.id); written++; }
      }
    });
    tx(rows);
  } finally { db.close(); }
}

console.log(`bank: ${BANK}  文件 ${files.length} 个`);
console.log(`活跃记忆 ${total} 条,缺 VAD ${missing} 条`);
console.log(`词表能判出情绪的 ${scored} 条(正 ${pos} / 负 ${neg}),占缺口的 ${(100 * scored / Math.max(1, missing)).toFixed(0)}%`);
console.log(APPLY ? `已写入 ${written} 条` : 'dry-run:未写入(加 --apply 落地)');
console.log('\n样例:');
for (const s of samples) console.log(`  v=${s.v} a=${s.a} 「${s.text}」 [${s.hit}]`);
