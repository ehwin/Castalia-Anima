/**
 * 第三轮融合冒烟测试(临时文件,可删除)
 * 验证:reflect.ts 融合 — 通用版签名(getUnanalyzedConversations 4参 / listAllMemories 3参 /
 *       applyReflectResult 3参 / applyReflectActions 3参 / getAllMemories+getMemoryGraph 带 project /
 *       ReflectAction.newMemType)+ Anima 情感层(emotionalImpact / emotional+mood_snapshot 分类)。
 * 运行:node scripts/smoke_round3.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testMemDir = path.join(root, 'scripts', '.test-memory-r3');

process.env.MEMORY_DB_DIR = testMemDir;
process.env.EMBED_MODE = 'none';

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${detail ? ' :: ' + detail : ''}`);
}

try {
  fs.rmSync(testMemDir, { recursive: true, force: true });
  fs.mkdirSync(testMemDir, { recursive: true });

  const { listAllMemories, getUnanalyzedConversations, applyReflectResult, applyReflectActions,
          getAllMemories, getMemoryGraph, reflect } = await import('../dist/reflect.js');
  const { DatabaseManager } = await import('../dist/db.js');
  const { saveMemory } = await import('../dist/store.js');
  const db = DatabaseManager.getInstance('alpha');
  const proj = 'alpha';

  // 1. 签名:通用版 3/4 参 project 参数(JS .length 因默认参为 0/1,此处只验证导出 + 多参调用可用)
  check('listAllMemories 已导出', typeof listAllMemories === 'function');
  check('getUnanalyzedConversations 已导出', typeof getUnanalyzedConversations === 'function');
  check('applyReflectResult 已导出', typeof applyReflectResult === 'function');
  check('applyReflectActions 已导出', typeof applyReflectActions === 'function');
  check('getAllMemories 已导出', typeof getAllMemories === 'function');
  check('getMemoryGraph 已导出', typeof getMemoryGraph === 'function');

  // 2. 准备数据:带 emotional_impact 的记忆 + conversation_log 源
  const m1 = await saveMemory({ text: '用户面对技术难题时反而兴奋', type: 'episodic', category: 'emotional', emotionalImpact: 7.5, importance: 0.8, characterId: 'airi', project: proj, source: 'conversation_log', memType: 'general' });
  const m2 = await saveMemory({ text: '用户喜欢雨天写代码', type: 'preference', category: 'preference', emotionalImpact: 3, importance: 0.6, characterId: 'airi', project: proj, source: 'conversation_log' });
  await saveMemory({ text: '另一项目记忆', type: 'semantic', category: 'knowledge', importance: 0.9, characterId: 'airi', project: 'beta', source: 'conversation_log' });

  // 3. listAllMemories:含 emotionalImpact + 按项目过滤 + memType
  const all = listAllMemories('airi', 100, proj);
  check('listAllMemories 返回数=2(项目隔离)', all.length === 2, 'n=' + all.length);
  const emo = all.find(m => m.id === m1.id);
  check('listAllMemories 映射 emotionalImpact', emo && emo.emotionalImpact === 7.5, JSON.stringify(emo));
  check('listAllMemories 映射 memType', emo && emo.memType === 'general', emo?.memType);
  check('listAllMemories beta 项目互不可见', listAllMemories('airi', 100, 'beta').length === 1);

  // 4. getUnanalyzedConversations:project 过滤 conversation_log
  const convs = getUnanalyzedConversations('airi', undefined, 30, proj);
  check('getUnanalyzedConversations 项目过滤=2', convs.length === 2, 'n=' + convs.length);

  // 5. getAllMemories / getMemoryGraph:project + 节点情感字段
  const gm = getAllMemories('airi', 100, proj);
  check('getAllMemories 项目过滤', gm.length === 2);
  const graph = getMemoryGraph('airi', proj);
  check('getMemoryGraph 节点含 emotionalImpact', graph.nodes.length === 2 && graph.nodes[0].emotionalImpact !== undefined, JSON.stringify(graph.nodes[0]));
  check('getMemoryGraph 边为空(无 relate)', Array.isArray(graph.edges) && graph.edges.length === 0);

  // 6. reclassify 支持 emotional / mood_snapshot 分类(Anima 独有)
  const rc = await applyReflectActions(
    [{ action: 'reclassify', targetId: m2.id, newCategorySingle: 'mood_snapshot' }],
    'airi', proj,
  );
  // 注:refs 通用版 reclassify 的 UPDATE 参数顺序为 run(timestamp, ...values)(权威基线如此,不动)
  check('reclassify 3参调用 + mood_snapshot 分类名通过护栏', rc.applied === 1 && !rc.errors.some(e => e.includes('invalid category')), JSON.stringify(rc.errors));

  // 7. merge 支持 newMemType(v1.8)
  const mg = await applyReflectActions(
    [{ action: 'merge', sourceIds: [m1.id, m2.id], newText: '用户有挑战型人格且喜欢雨天写代码', newMemType: 'user' }],
    'airi', proj,
  );
  check('merge 3参 + newMemType 通过', mg.applied === 1, JSON.stringify(mg.errors));

  // 8. applyReflectResult 3参(project 透传)
  const rr = await applyReflectResult(
    { summary: '本轮对话总结', highlights: ['h1'], facts: [{ subject: 'user', predicate: '职业', object: '程序员', confidence: 0.9 }], insights: ['洞察'], actions: [] },
    'airi', proj,
  );
  check('applyReflectResult 3参调用成功', rr.summaryId !== null && rr.factsInserted === 1 && rr.insightsCount === 1, JSON.stringify(rr));

  // 9. reflect 编排入口:unanalyzed 带 project(merge 后 2 条 conversation_log 已软删除 → 0)
  const un = await reflect('unanalyzed', { characterId: 'airi', project: proj });
  check('reflect(unanalyzed) 项目过滤', un.conversationCount === 0, 'n=' + un.conversationCount);

  DatabaseManager.close();
  fs.rmSync(testMemDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('SMOKE TEST ERROR:', e);
  try { DatabaseManager.close(); } catch {}
  try { fs.rmSync(testMemDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
