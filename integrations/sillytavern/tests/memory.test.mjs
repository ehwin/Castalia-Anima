import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFor, textQuery } from '../server/index.mjs';
import { chatState, snapshot, memoryPrompt } from '../extension/model.js';

const temporaryBank = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-tavern-test-'));
process.env.MEMORY_DB_DIR = temporaryBank;
process.env.EMBED_MODE = 'none';
const { syncTavernChat } = await import('../../../dist/tavern.js');
const { CHAR_ID } = await import('../../../dist/env.js');
const { DatabaseManager } = await import('../../../dist/db.js');
const { searchMemory } = await import('../../../dist/search.js');
after(() => { DatabaseManager.close(); fs.rmSync(temporaryBank, { recursive: true, force: true }); });

test('same chat in different users/characters is physically isolated', async () => {
  const a = projectFor('alice', '["character","a.png","chat"]');
  const b = projectFor('bob', '["character","a.png","chat"]');
  const c = projectFor('alice', '["character","b.png","chat"]');
  assert.notEqual(a, b); assert.notEqual(a, c);
  syncTavernChat(a, [{ id: '1', role: 'assistant', name: 'CharacterA', text: 'secret-seashell 约定去海边' }]);
  for (const project of [b, c]) {
    assert.equal((await searchMemory({ query: 'secret-seashell', project })).length, 0);
  }
  const found = await searchMemory({ query: 'secret-seashell', project: a });
  assert.equal(found.length, 1); assert.match(found[0].text, /CharacterA/); assert.doesNotMatch(found[0].text, /助手/);
  // v1.24: 角色 = 进程级 CHAR_ID(不再等于 project);别的角色 id 逻辑上也看不到
  assert.equal(found[0].characterId, CHAR_ID);
  assert.equal((await searchMemory({ query: 'secret-seashell', project: a, characterId: 'another-role' })).length, 0);
  assert.ok(fs.existsSync(path.join(temporaryBank, a, 'general/memory.sqlite')));
});

test('swipe/edit/delete/retry synchronize only the currently selected version', async () => {
  const project = projectFor('alice', 'versions');
  // Tokens must not share a word stem: the lexical path matches per token, so
  // `abandoned-answer` vs `selected-answer` would both hit on "answer" and the
  // assertion below would fail even when the old version is really gone.
  const message = { id: 'stable', role: 'assistant', name: '角色甲', text: 'abandoned-zinnia' };
  const keep = { id: 'kept', role: 'assistant', name: '角色甲', text: 'kept-basalt' };
  assert.equal(syncTavernChat(project, [message]).changed, 1);
  assert.equal(syncTavernChat(project, [message]).changed, 0);
  assert.equal(syncTavernChat(project, [{ ...message, text: 'selected-quartz' }]).changed, 1);
  assert.equal((await searchMemory({ query: 'abandoned-zinnia', project })).length, 0);
  assert.equal((await searchMemory({ query: 'selected-quartz', project })).length, 1);
  // 删除：空快照被显式拒绝（防窗口化误清库），收缩必须走 replace:true 的更小快照
  assert.throws(() => syncTavernChat(project, []), /empty/);
  syncTavernChat(project, [message, keep]);
  assert.equal(syncTavernChat(project, [keep], { replace: true }).deleted, 1);
  assert.equal((await searchMemory({ query: 'selected-quartz', project })).length, 0);
  assert.equal((await searchMemory({ query: 'kept-basalt', project })).length, 1);
  // retry：同一条消息重新出现（replace:true 确认窗口收缩；keep 未变所以 changed=1）
  assert.equal(syncTavernChat(project, [keep, { ...message, text: 'selected-quartz' }], { replace: true }).changed, 1);
  assert.equal((await searchMemory({ query: 'selected-quartz', project })).length, 1);
});

test('invalid snapshot cannot erase a previously saved chat', () => {
  const project = projectFor('alice', 'atomic');
  const row = { id: 'a', role: 'user', name: '玩家', text: 'kept' };
  syncTavernChat(project, [row]);
  assert.throws(() => syncTavernChat(project, [row, row]), /Duplicate/);
  const db = DatabaseManager.getInstance(project);
  assert.equal(db.prepare('SELECT count(*) n FROM memory WHERE is_active=1').get().n, 1);
  assert.throws(() => syncTavernChat('../default', []), /isolated/);
});

function fakeChat() {
  return { chatId: 'story', characterId: 0, characters: [{ avatar: 'card.png' }], chatMetadata: {}, name1: '玩家', name2: '角色', chat: [{ is_user: true, name: '玩家', mes: 'old-before-enabled' }] };
}

test('default off, re-enable skips messages written while disabled, import includes history', () => {
  const ctx = fakeChat();
  const state = chatState(ctx);
  assert.equal(state.enabled, false);
  state.enabled = true;
  ctx.chat.push({ is_user: false, mes: 'new-after-enabled' });
  chatState(ctx);
  assert.deepEqual(snapshot(ctx, state).map(row => row.text), ['new-after-enabled']);
  state.enabled = false;
  ctx.chat.push({ is_user: true, mes: 'written-while-disabled' });
  chatState(ctx);
  state.enabled = true;
  assert.deepEqual(snapshot(ctx, state).map(row => row.text), ['new-after-enabled']);
  // Deleting earlier history must not shift an index boundary and lose new messages.
  ctx.chat.shift();
  assert.deepEqual(snapshot(ctx, state).map(row => row.text), ['new-after-enabled']);
  state.ignoredIds = [];
  assert.equal(snapshot(ctx, state).length, 2);
});

test('a copied branch starts off and does not inherit its parent project', () => {
  const ctx = fakeChat();
  chatState(ctx).enabled = true;
  const original = ctx.chatMetadata.castaliaAnima.origin;
  ctx.chatId = 'branch';
  assert.equal(chatState(ctx).enabled, false);
  assert.notEqual(ctx.chatMetadata.castaliaAnima.origin, original);
});

test('prompt uses a real token budget and Chinese text mode segments sentences', async () => {
  const rows = [{ text: 'x'.repeat(900) }, { text: '记得海边的约定。' }];
  const result = await memoryPrompt(rows, 200, async text => text.length);
  assert.match(result, /海边/); assert.doesNotMatch(result, /xxx/); assert.ok(result.length <= 200);
  assert.equal(await memoryPrompt(rows, 2, async text => text.length), '');
  assert.ok(textQuery('还记得我们在海边的约定吗？').split(' ').includes('海边'));
});
