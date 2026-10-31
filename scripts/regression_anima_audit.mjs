// v1.23.2 Anima 审计修复回归（4 组）：
//   1) VAD 队列带 project / memoryId，跨项目不混批、按 id 精确回写
//   2) tavern_sync 快照契约：空数组拒绝、窗口化子集拒绝、replace:true 才允许收缩
//   3) bias / userLearning 按 (project, charId) 分区，互不串味
//   4) batchClassifyAndTag 拒绝越界 VAD，并使用批次级合法 appraisal 兜底
// 纯离线：临时库 + mock Ollama（EMBED_MODE=none），不触网、不写 memory-banks。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-audit-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({}));
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: config,
  EMBED_MODE: 'none',              // 零网络：不调 Ollama / embedding API
  CASTALIA_PROJECT: 'anima-audit',
  OLLAMA_URL: 'https://fixture.invalid',
  VAD_MODEL: 'fixture',
});

const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager, generateId } = await load('db');
const { saveConversationTurn, saveMemory } = await load('store');
const { queueForVad, flushVadQueue, vadQueueStatus, getSmoothedVAD } = await load('emotion');
const { autoProcess } = await load('autoProcessor');
const { syncTavernChat } = await load('tavern');
const { recordTopics, getBiases, getBiasPrompt, computeBiasBoost, loadBiasesFromDb } = await load('bias');
const { observeUserMessage, getUserProfilePrompt, getUserProfile } = await load('userLearning');

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

const insertConversation = (project, text) => {
  const db = DatabaseManager.getInstance(project, 'general');
  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO memory
    (id, text, project, type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, affect_status, affect_source)
    VALUES (?, ?, ?, 'episodic', 'conversation', '[]', 0.5, 'default', 'conversation_log', 'user', 'standard', 1, ?, ?, ?, 0, 0, 'pending', 'vad_queue')`)
    .run(id, text, project, now, now, now);
  return { id, db };
};

const ok = content => new Response(JSON.stringify({ message: { content } }), { status: 200 });
let classifyReply = () => '[]';
const vadPrompts = [];
const classifyPrompts = [];

// mock Ollama：系统提示词区分 VAD 检测（emotion）与批量分类（batchClassifyAndTag）
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || '{}');
  const system = body?.messages?.[0]?.content || '';
  const user = body?.messages?.[1]?.content || '';
  if (system.includes('interaction-appraisal sensor')) {
    vadPrompts.push(user);
    const valence = user.includes('手冲咖啡') ? 1 : -1;
    return ok(JSON.stringify({
      surface_vad: { valence, arousal: 0.2, dominance: 0 },
      true_vad: { valence, arousal: 0.2, dominance: 0 },
      tsundere_level: 0, confidence: 0.9, tags: ['测试'],
    }));
  }
  if (system.includes('Classify each numbered message')) {
    classifyPrompts.push(user);
    return ok(classifyReply(user));
  }
  throw new Error('unexpected LLM call: ' + String(_url));
};

// ══════════════════════════════════════════════════════════════════
// 1) VAD 队列：project 分区 + memoryId 精确回写（第 1 组）
// ══════════════════════════════════════════════════════════════════
const P1 = 'audit-p1';
const P2 = 'audit-p2';
const p1Turn = await saveConversationTurn('P1 用户消息：我喜欢手冲咖啡', 'P1 助手回复', 'default', P1);
const p2Turn = await saveConversationTurn('P2 用户消息：我在研究航海模型', 'P2 助手回复', 'default', P2);

classifyReply = user => user.includes('手冲咖啡')
  ? JSON.stringify([{ importance: 0.85, category: 'identity', tags: ['audit-p1'], vad: { valence: 5, arousal: -3, dominance: 0.5 } }])
  : JSON.stringify([{ importance: 0.2, category: 'general', tags: ['audit-p2'] }]);

queueForVad('P1 用户消息：我喜欢手冲咖啡', P1, p1Turn.id);
queueForVad('P2 用户消息：我在研究航海模型', P2, p2Turn.id);
check(vadQueueStatus().size === 2, 'two projects are queued separately');

await flushVadQueue(); // 不传 project = 全量 flush；内部按 project 分组
check(vadQueueStatus().size === 0, 'flush drains the whole queue');
check(vadPrompts.length === 2, 'one VAD prompt per project (got ' + vadPrompts.length + ')');
check(!vadPrompts.some(p => p.includes('手冲咖啡') && p.includes('航海模型')), 'different projects never share one VAD prompt');
check(classifyPrompts.length === 2, 'one classification prompt per project (got ' + classifyPrompts.length + ')');
check(!classifyPrompts.some(p => p.includes('手冲咖啡') && p.includes('航海模型')), 'different projects never share one classification prompt');

const db1 = DatabaseManager.getInstance(P1);
const db2 = DatabaseManager.getInstance(P2);
const p1Row = db1.prepare('SELECT * FROM memory WHERE id = ?').get(p1Turn.id);
const p2Row = db2.prepare('SELECT * FROM memory WHERE id = ?').get(p2Turn.id);
check(!!p1Row && !!p2Row, 'both project rows exist');
check(p1Row.category === 'identity' && p2Row.category === 'general', 'each project row got its own classification');
check(p1Row.importance === 0.85 && p2Row.importance === 0.2, 'each project row got its own importance');
check(JSON.parse(p1Row.tags)[0] === 'audit-p1' && JSON.parse(p2Row.tags)[0] === 'audit-p2', 'tags stay in their own project');
check(!db1.prepare('SELECT id FROM memory WHERE id = ?').get(p2Turn.id), 'P2 row is not written into P1 library');
check(!db2.prepare('SELECT id FROM memory WHERE id = ?').get(p1Turn.id), 'P1 row is not written into P2 library');
check(getSmoothedVAD(P1).vad.valence > getSmoothedVAD(P2).vad.valence, 'smoothed VAD is partitioned per project');

// 同文本两条不同 id：必须按 id 更新，而不是按 created_at DESC 猜最近一条
const P3 = 'audit-p3';
const older = insertConversation(P3, '用户: 同文本消息：重复内容\n助手: 第一次回复');
const newer = insertConversation(P3, '用户: 同文本消息：重复内容\n助手: 第二次回复');
classifyReply = () => JSON.stringify([{ importance: 0.6, category: 'knowledge', tags: ['id-based'] }]);
queueForVad('同文本消息：重复内容', P3, older.id);
await flushVadQueue(P3, { force: true });
const db3 = DatabaseManager.getInstance(P3);
const olderRow = db3.prepare('SELECT * FROM memory WHERE id = ?').get(older.id);
const newerRow = db3.prepare('SELECT * FROM memory WHERE id = ?').get(newer.id);
check(olderRow.category === 'knowledge' && JSON.parse(olderRow.tags)[0] === 'id-based', 'entry with memoryId updates that exact row');
check(newerRow.category === 'conversation' && newerRow.tags === '[]' && Number(newerRow.importance) === 0.5, 'same-text newer row is untouched (no positional guess)');

// 没有 memoryId 的旧式条目：拒绝入队，避免重启/并发时把情绪写回错误行
const P4 = 'audit-p4';
const P5 = 'audit-p5';
const p4Turn = insertConversation(P4, '用户: P4 无 id 回退测试\n助手: 回复');
const p5Turn = insertConversation(P5, '用户: P5 干扰行，保持原样\n助手: 回复');
classifyReply = () => JSON.stringify([{ importance: 0.4, category: 'preference', tags: ['fallback'] }]);
queueForVad('P4 无 id 回退测试', P4); // 不传 memoryId，必须被拒绝
await flushVadQueue(P4, { force: true });
const p4Row = DatabaseManager.getInstance(P4).prepare('SELECT * FROM memory WHERE id = ?').get(p4Turn.id);
const p5Row = DatabaseManager.getInstance(P5).prepare('SELECT * FROM memory WHERE id = ?').get(p5Turn.id);
check(p4Row.category === 'conversation' && p4Row.tags === '[]' && Number(p4Row.importance) === 0.5, 'id-less entry is rejected before classification');
check(p5Row.category === 'conversation' && Number(p5Row.importance) === 0.5, 'id-less rejection never touches another project');

// autoProcess 端到端：先落库再入队，flush 后本轮对话行被正确回写
const P7 = 'audit-auto';
const autoRes = await autoProcess({ userMessage: 'P7 用户消息：自动处理', assistantMessage: 'P7 回复', project: P7 });
check(autoRes.conversationSaved === true, 'autoProcess saves the conversation before queueing VAD');
classifyReply = () => JSON.stringify([{ importance: 0.75, category: 'milestone', tags: ['auto'], vad: { valence: 0.2, arousal: 0, dominance: 0 } }]);
await flushVadQueue(P7); // 显式项目 flush 默认立即处理
const autoRow = DatabaseManager.getInstance(P7).prepare(
  "SELECT * FROM memory WHERE project=? AND source='conversation_log' ORDER BY rowid DESC LIMIT 1"
).get(P7);
check(autoRow.category === 'milestone' && JSON.parse(autoRow.tags)[0] === 'auto', 'autoProcess turn is tagged after flush');
check(autoRow.vad_valence === 0.2, 'autoProcess turn receives VAD columns');

// ══════════════════════════════════════════════════════════════════
// 2) tavern_sync 快照契约（第 2 组）
// ══════════════════════════════════════════════════════════════════
const stProject = 'st_0123456789abcdef0123456789abcdef01234567'; // st_ + 40 hex
const m1 = { id: 'm1', role: 'user', name: 'A', text: '第一句话' };
const m2 = { id: 'm2', role: 'assistant', name: 'B', text: '第二句话' };
const stDb = DatabaseManager.getInstance(stProject);
const activeCount = () => Number(stDb.prepare(
  "SELECT COUNT(*) AS c FROM memory WHERE project=? AND source='sillytavern_chat' AND is_active=1"
).get(stProject)?.c || 0);

const initial = syncTavernChat(stProject, [m1, m2]);
check(initial.count === 2 && activeCount() === 2, 'full snapshot is stored');
assert.throws(() => syncTavernChat(stProject, []), /empty/i);
check(activeCount() === 2, 'empty snapshot is rejected and deletes nothing');
assert.throws(() => syncTavernChat(stProject, [m1]), /windowed subset/i);
check(activeCount() === 2, 'windowed subset is rejected without replace');
assert.throws(() => syncTavernChat('not-a-project', [m1]), /isolated/i);
check(activeCount() === 2, 'invalid project is still rejected');
const replaced = syncTavernChat(stProject, [m1], { replace: true });
check(replaced.deleted === 1 && activeCount() === 1, 'replace:true allows shrinking the snapshot');
const inactive = Number(stDb.prepare(
  "SELECT COUNT(*) AS c FROM memory WHERE project=? AND source='sillytavern_chat' AND is_active=0"
).get(stProject)?.c || 0);
check(inactive === 1, 'shrunk-away message is soft-deleted (row kept)');
const regrown = syncTavernChat(stProject, [m1, m2]);
check(regrown.count === 2 && activeCount() === 2, 'equal/growing snapshot is accepted without replace');

// ══════════════════════════════════════════════════════════════════
// 3) bias / userLearning 按 (project, charId) 分区（第 3 组）
// ══════════════════════════════════════════════════════════════════
const B1 = 'audit-bias-1';
const B2 = 'audit-bias-2';
recordTopics('default', ['咖啡', '手冲'], B1);
recordTopics('default', ['航海', '模型'], B2);
check(getBiases('default', 10, B1).every(b => ['咖啡', '手冲'].includes(b.topic)), 'bias B1 only contains its own topics');
check(!getBiases('default', 10, B1).some(b => ['航海', '模型'].includes(b.topic)), 'bias B1 does not see B2 topics');
check(getBiases('default', 10, B2).every(b => ['航海', '模型'].includes(b.topic)), 'bias B2 only contains its own topics');
check(computeBiasBoost('default', ['咖啡'], B1) > 1, 'bias boost applies inside its own project');
check(computeBiasBoost('default', ['咖啡'], B2) === 1, 'bias boost does not leak to another project');
check(computeBiasBoost('default', ['航海'], B2) > 1, 'bias boost applies in B2');
check(getBiasPrompt('default', B1).includes('咖啡') && !getBiasPrompt('default', B1).includes('航海'), 'bias prompt is project-scoped');

// 一次性加载标志按 project 缓存：先加载 C1 不应阻止 C2 从 DB 加载
const C1 = 'audit-load-1';
const C2 = 'audit-load-2';
const c1mem = await saveMemory({ project: C1, text: '加载偏好一', tags: ['db-tag-1'] });
const c2mem = await saveMemory({ project: C2, text: '加载偏好二', tags: ['db-tag-2'] });
DatabaseManager.getInstance(C1).prepare("UPDATE memory SET character_id='loader' WHERE id=?").run(c1mem.id);
DatabaseManager.getInstance(C2).prepare("UPDATE memory SET character_id='loader' WHERE id=?").run(c2mem.id);
loadBiasesFromDb('loader', C1);
loadBiasesFromDb('loader', C2);
check(getBiases('loader', 10, C1).some(b => b.topic === 'db-tag-1'), 'loadBiasesFromDb loads C1 from its own DB');
check(!getBiases('loader', 10, C1).some(b => b.topic === 'db-tag-2'), 'C1 load does not pull C2 tags');
check(getBiases('loader', 10, C2).some(b => b.topic === 'db-tag-2'), 'C2 still loads after C1 (per-project load flag)');
check(!getBiases('loader', 10, C2).some(b => b.topic === 'db-tag-1'), 'C2 load does not pull C1 tags');

// userLearning：同一 charId 在不同 project 下画像互不串
const U1 = 'audit-user-1';
const U2 = 'audit-user-2';
const verbose = '这是一条很长的中文消息，用来验证用户画像不会跨项目串味。'.repeat(20);
for (let i = 0; i < 3; i++) observeUserMessage('default', 'default', verbose, U1);
for (let i = 0; i < 3; i++) observeUserMessage('default', 'default', '好', U2);
const u1Prompt = getUserProfilePrompt('default', 'default', U1);
const u2Prompt = getUserProfilePrompt('default', 'default', U2);
check(u1Prompt.includes('喜欢详细回复'), 'U1 learned the verbose style');
check(u2Prompt.includes('喜欢简短回复'), 'U2 learned the concise style');
check(!u1Prompt.includes('喜欢简短回复'), 'U1 profile is not polluted by U2 messages');
check(u1Prompt !== u2Prompt, 'profiles differ per project');
check(getUserProfile('default', 'default', U1).interactionCount === 3, 'U1 interaction count is its own');
check(getUserProfile('default', 'default', U2).interactionCount === 3, 'U2 interaction count is its own');
check(getUserProfile('default', 'default', 'audit-user-none') === null, 'unseen project has no profile');

// ══════════════════════════════════════════════════════════════════
// 4) VAD 维度落库 + 越界拒绝（第 4 组）
// ══════════════════════════════════════════════════════════════════
// P1 的分类结果带越界 VAD（valence=5, arousal=-3, dominance=0.5）。
// 它必须被视为无效，并使用同批次的合法 appraisal，而不是逐维 clamp。
check(p1Row.vad_valence === 1, 'invalid row VAD uses batch valence fallback (got ' + p1Row.vad_valence + ')');
check(p1Row.vad_arousal === 0.2, 'invalid row VAD uses batch arousal fallback (got ' + p1Row.vad_arousal + ')');
check(p1Row.vad_dominance === 0, 'invalid row VAD uses batch dominance fallback (got ' + p1Row.vad_dominance + ')');
check(p1Row.vad_valence != null && p1Row.vad_arousal != null && p1Row.vad_dominance != null, 'all three VAD columns are non-null');
check(p2Row.vad_valence === -1 && p2Row.vad_arousal === 0.2 && p2Row.vad_dominance === 0, 'missing per-row VAD uses the batch appraisal fallback');

check(vadQueueStatus().size === 0, 'queue is empty at the end');

DatabaseManager.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ checks, ok: true, groups: 4, liveLlmCalls: 0, embedCalls: 0, productionWrites: 0 }));
