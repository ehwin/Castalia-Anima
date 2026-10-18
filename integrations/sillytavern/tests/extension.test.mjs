import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatState } from '../extension/model.js';

test('browser interceptor respects off/quiet, token budget and a changed chat during recall', async () => {
  const requests = [];
  const injected = [];
  let ctx = {
    chatId: 'story', characterId: 0, characters: [{ avatar: 'card.png' }], chatMetadata: {},
    name1: '玩家', name2: '角色', chat: [{ name: '玩家', is_user: true, mes: '海边约定' }],
    setExtensionPrompt: (...args) => injected.push(args),
    saveChat: async () => {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    getTokenCountAsync: async text => text.length,
  };
  globalThis.SillyTavern = { getContext: () => ctx };
  globalThis.document = { querySelector: () => null };
  let recall;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/recall') && recall) await recall();
    return { ok: true, json: async () => ({ ok: true, count: 1, results: [{ text: '我们约定去海边。' }] }) };
  };
  await import('../extension/index.js');
  await globalThis.castaliaAnimaRecall([], 4096, () => {}, 'normal');
  assert.equal(requests.length, 0);
  chatState(ctx).enabled = true;
  await globalThis.castaliaAnimaRecall([], 4096, () => {}, 'quiet');
  assert.equal(requests.length, 0);
  await globalThis.castaliaAnimaRecall([], 4096, () => {}, 'normal');
  assert.equal(requests.length, 2);
  assert.match(injected.at(-1)[1], /海边/);
  assert.equal(injected.at(-1)[4], false); // do not activate world-info scanning
  recall = async () => { ctx = { ...ctx, chatId: 'other', chatMetadata: {} }; };
  await globalThis.castaliaAnimaRecall([], 4096, () => {}, 'normal');
  assert.equal(injected.at(-1)[1], '');
});
