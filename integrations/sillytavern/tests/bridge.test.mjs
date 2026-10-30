import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('real MCP bridge routes preserve user isolation and selected message versions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-bridge-test-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  fs.copyFileSync(new URL('../server/index.mjs', import.meta.url), path.join(directory, 'index.mjs'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ engineRoot: root, bankDir: path.join(directory, 'bank'), embedMode: 'none' }));
  const plugin = await import(pathToFileURL(path.join(directory, 'index.mjs')).href);
  const handlers = new Map();
  await plugin.init({ get: (url, handler) => handlers.set(url, handler), post: (url, handler) => handlers.set(url, handler) });
  const invoke = async (url, user, body) => {
    let code = 200;
    let result;
    await handlers.get(url)({ user: user ? { profile: { handle: user } } : undefined, body }, {
      status(value) { code = value; return this; }, json(value) { result = value; },
    });
    return { code, result };
  };
  try {
    assert.equal((await invoke('/status', 'alice')).result.connected, true);
    const message = { id: 'stable-message', role: 'assistant', name: '莉莉', text: '红色贝壳 old-zinnia' };
    const saved = await invoke('/sync', 'alice', { chatKey: 'story', messages: [message] });
    assert.equal(saved.code, 200); assert.equal(saved.result.count, 1);
    assert.equal((await invoke('/sync', 'alice', { chatKey: 'story', messages: [message] })).result.changed, 0);
    assert.equal((await invoke('/recall', 'alice', { chatKey: 'story', query: '还记得红色贝壳吗？' })).result.results.length, 1);
    assert.equal((await invoke('/recall', 'alice', { chatKey: 'story', query: '红色贝壳', excludeIds: ['stable-message'] })).result.results.length, 0);
    assert.equal((await invoke('/recall', 'bob', { chatKey: 'story', query: '红色贝壳' })).result.results.length, 0);
    const updated = await invoke('/sync', 'alice', { chatKey: 'story', messages: [{ ...message, text: '蓝色项链 selected-quartz' }] });
    assert.equal(updated.result.changed, 1);
    assert.equal((await invoke('/recall', 'alice', { chatKey: 'story', query: 'old-zinnia' })).result.results.length, 0);
    assert.equal((await invoke('/recall', 'alice', { chatKey: 'story', query: 'selected-quartz' })).result.results.length, 1);
    // 空快照不是“清空”而是可疑输入（防窗口化子集误删整段历史）：显式拒绝，历史保持
    const cleared = await invoke('/sync', 'alice', { chatKey: 'story', messages: [] });
    assert.equal(cleared.code, 400);
    assert.equal((await invoke('/recall', 'alice', { chatKey: 'story', query: 'selected-quartz' })).result.results.length, 1);
    assert.equal((await invoke('/sync', 'alice', { chatKey: 'story', messages: [{ ...message, role: 'system' }] })).code, 400);
    assert.equal((await invoke('/status', null)).code, 400);
    assert.equal((await invoke('/sync', 'alice', { chatKey: '', messages: [] })).code, 400);
  } finally {
    await plugin.exit();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
