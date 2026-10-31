/** 量化 P1:高情绪记忆在"按创建时间衰减"下还剩多少情感强度 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = 'D:/AI/castalia/Castalia-Anima/dist';
const BANK = process.argv[2] || 'D:/castalia/memory-banks/default';
const emo = await import(pathToFileURL(path.join(DIST, 'emotion.js')).href);
const D = (await import('better-sqlite3')).default;

const rows = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'memory.sqlite') {
      try {
        const db = new D(p, { readonly: true, fileMustExist: true });
        const rs = db.prepare(`SELECT id, text, vad_valence, vad_arousal, vad_dominance, tsundere_level,
          emotional_impact, created_at, last_accessed_at, accessed_count, importance
          FROM memory WHERE is_active = 1 AND vad_valence IS NOT NULL`).all();
        for (const r of rs) rows.push({ ...r, lib: p });
        db.close();
      } catch (_e) {}
    }
  }
}
walk(BANK);

const now = Date.now();
const hours = (iso) => Math.max(0, (now - new Date(iso || 0).getTime()) / 3600000);
let high = 0, deadNow = 0, revived = 0;
const samples = [];
for (const r of rows) {
  const vad = { valence: r.vad_valence, arousal: r.vad_arousal, dominance: r.vad_dominance };
  const base = emo.computeBaseIntensity(vad);
  const byCreate = emo.computeDecay(vad, hours(r.created_at), r.tsundere_level || 0, emo.isNightTime());
  const byTouch = emo.computeDecay(vad, hours(r.last_accessed_at || r.created_at), r.tsundere_level || 0, emo.isNightTime());
  if (base >= 0.7) {
    high++;
    if (byCreate.intensity < 0.1) {
      deadNow++;
      if (byTouch.intensity >= 0.3) revived++;
      if (samples.length < 5) {
        samples.push({
          text: String(r.text).slice(0, 34),
          days: Math.round(hours(r.created_at) / 24),
          base: +base.toFixed(2),
          now: +byCreate.intensity.toFixed(3),
          ifTouch: +byTouch.intensity.toFixed(3),
          hits: r.accessed_count,
        });
      }
    }
  }
}
console.log(`库内带 VAD 的活跃记忆 ${rows.length} 条;baseIntensity ≥ 0.7 的"高情绪"${high} 条`);
console.log(`其中按创建时间衰减后 intensity < 0.1(情感维度已失效):${deadNow} 条 (${(100 * deadNow / Math.max(1, high)).toFixed(0)}%)`);
console.log(`若改按 last_accessed 衰减,其中 ${revived} 条会回到 ≥ 0.3`);
console.log('\n样例:');
for (const s of samples) console.log(`  ${s.text}… | ${s.days}天前 | base ${s.base} → 今 ${s.now} → 按最近访问 ${s.ifTouch} | 命中 ${s.hits} 次`);
