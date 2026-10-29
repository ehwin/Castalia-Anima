/**
 * 情感词表 + 离线兜底回归(Anima)
 *
 * 起因:实测 airi bank 262 条活跃记忆 0 条有 vad_valence —— 唯一来源 Ollama 没在跑。
 * 这组测试锁两件事:
 *   1) 词表能把"争吵"和"吃了面"在情感维度上分开(不问精度,只问方向);
 *   2) Ollama 不可用时 flushVadQueue 会走词表兜底并把 VAD 写进库(而不是静默空转)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const lex = await import(pathToFileURL(path.join(DIST, 'affectLexicon.js')).href);

console.log('[affect-lexicon]');

console.log('\n1) 方向:正/负/中性分得开');
const fight = lex.scoreAffect('你昨天跟我吵架，我真的很生气，也很委屈');
const happy = lex.scoreAffect('今天和你聊天好开心，谢谢你还记得');
const noodle = lex.scoreAffect('中午吃了一碗面');
check('争吵 valence < 0', fight.valence < -0.2, `got ${fight.valence}`);
check('开心 valence > 0', happy.valence > 0.2, `got ${happy.valence}`);
check('吃面接近中性', Math.abs(noodle.valence) < 0.2, `got ${noodle.valence}`);
check('争吵 arousal > 吃面 arousal', fight.arousal > noodle.arousal, `${fight.arousal} vs ${noodle.arousal}`);
check('争吵强度 > 吃面强度', lex.affectIntensity(fight) > lex.affectIntensity(noodle));

console.log('\n2) 否定与程度');
const notHappy = lex.scoreAffect('我不开心');
check('"我不开心" valence < 0', notHappy.valence < 0, `got ${notHappy.valence}`);
const veryHappy = lex.scoreAffect('我开心');
const superHappy = lex.scoreAffect('我超级开心');
check('程度副词放大 arousal', superHappy.arousal > veryHappy.arousal, `${superHappy.arousal} vs ${veryHappy.arousal}`);

console.log('\n3) 没有情感词就不造情绪');
const plain = lex.scoreAffect('明天下午三点开会');
check('无情感词 confidence = 0', plain.confidence === 0, `got ${plain.confidence}`);
check('无情感词 valence = 0', plain.valence === 0);
const empty = lex.scoreAffect('   ');
check('空串全 0', empty.confidence === 0 && empty.valence === 0);

console.log('\n4) emotional_impact 标度 0..10');
for (const t of [fight, happy, noodle]) {
  const imp = lex.affectImpact(t);
  check(`impact 在 0..10(${imp})`, imp >= 0 && imp <= 10);
}

console.log('\n5) Ollama 不可用 → 词表兜底写库');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-affect-'));
process.env.MEMORY_DB_DIR = tmp;
process.env.CHAR_ID = 'airi';
process.env.EMBED_MODE = 'none';
process.env.OLLAMA_URL = 'http://127.0.0.1:1';   // 必然连不上
const emo = await import(pathToFileURL(path.join(DIST, 'emotion.js')).href);
const dbMod = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
const db = dbMod.DatabaseManager.getInstance('default', 'general');
const ids = [];
for (const text of ['她今天跟我说分手，我很难过', '我们下午去买了牛奶']) {
  const id = dbMod.generateId();
  db.prepare(`INSERT INTO memory (id, text, project, type, mem_type, character_id, source, is_active)
              VALUES (?,?,?,?,?,?,?,1)`).run(id, text, 'default', 'episodic', 'general', 'airi', 'conversation_log');
  ids.push(id);
}
for (const [i, id] of ids.entries()) emo.queueForVad(i === 0 ? '她今天跟我说分手，我很难过' : '我们下午去买了牛奶', 'default', id);
let flushed = null;
try { flushed = await emo.flushVadQueue('default', { force: true }); } catch (e) { console.log('  flush 抛错:', e.message); }
const rows = db.prepare('SELECT id, vad_valence, vad_arousal, emotional_impact FROM memory WHERE id IN (?,?)').all(...ids);
const sad = rows.find(r => r.id === ids[0]);
const milk = rows.find(r => r.id === ids[1]);
check('兜底后第一条有 VAD', sad && sad.vad_valence != null, JSON.stringify(sad));
check('分手那条 valence < 0', sad && sad.vad_valence < 0, `got ${sad && sad.vad_valence}`);
check('分手那条 emotional_impact > 0', sad && sad.emotional_impact > 0, `got ${sad && sad.emotional_impact}`);
check('买牛奶那条没被硬塞情绪(vad 仍 null)', milk && milk.vad_valence == null, JSON.stringify(milk));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
console.log(`\n[affect-lexicon] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
