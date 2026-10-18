import { chatKey, chatState, snapshot, memoryPrompt } from './model.js';

const PROMPT = 'castalia_anima';
const API = '/api/plugins/castalia-anima';
let timer;
let queue = Promise.resolve();
let initialized = false;
let generationActive = false;
const context = () => SillyTavern.getContext();
const status = text => { const element = document.querySelector('#anima_status'); if (element) element.textContent = text; };
const clearPrompt = () => context().setExtensionPrompt(PROMPT, '', 1, 2, false, 0);

async function request(endpoint, body) {
  const response = await fetch(`${API}/${endpoint}`, {
    method: body ? 'POST' : 'GET', headers: context().getRequestHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000),
  });
  if (!response.ok && response.status === 404) throw new Error('后端插件未加载，请安装后重启酒馆');
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || '连接失败');
  return result;
}

function render() {
  const ctx = context();
  const state = chatState(ctx);
  const toggle = document.querySelector('#castalia_anima_toggle');
  if (toggle) {
    toggle.disabled = !state;
    toggle.classList.toggle('enabled', state?.enabled === true);
    toggle.setAttribute('aria-pressed', String(state?.enabled === true));
    toggle.title = state?.enabled ? '关闭当前聊天记忆' : '开启当前聊天记忆';
  }
  const checkbox = document.querySelector('#anima_enabled');
  if (!checkbox) return;
  checkbox.disabled = !state;
  checkbox.checked = state?.enabled === true;
  document.querySelector('#anima_import').disabled = !state?.enabled;
  document.querySelector('#anima_budget').value = state?.budget || 700;
  status(state ? (state.enabled ? '当前聊天已开启 · 独立剧情记忆' : '当前聊天已关闭') : '打开一个聊天后设置');
}

async function syncCurrent() {
  const ctx = context();
  const state = chatState(ctx);
  if (!state?.enabled) return;
  const key = chatKey(ctx);
  const messages = snapshot(ctx, state);
  if (messages.length > 5000) throw new Error('聊天超过 5000 条，请选择较新的起点');
  // IDs must be persisted before the network call; they survive reloads and edits.
  await ctx.saveChat();
  if (chatKey(context()) !== key || !chatState(context())?.enabled) return;
  const result = await request('sync', { chatKey: key, messages });
  if (chatKey(context()) === key && chatState(context())?.enabled) status(`已同步 ${result.count} 条消息`);
}

function synchronize() {
  const pending = queue.catch(() => {}).then(syncCurrent);
  queue = pending;
  return pending;
}

function schedule() {
  clearTimeout(timer);
  clearPrompt();
  if (generationActive || !chatState(context())?.enabled) return;
  timer = setTimeout(() => synchronize().catch(error => status(`同步失败：${error.message}`)), 700);
}

globalThis.castaliaAnimaRecall = async (_chat, contextSize, _abort, type) => {
  clearTimeout(timer);
  clearPrompt();
  const ctx = context();
  const state = chatState(ctx);
  if (!state?.enabled || ['quiet', 'impersonate'].includes(type)) return;
  const key = chatKey(ctx);
  try {
    await synchronize();
    if (chatKey(context()) !== key || !chatState(context())?.enabled) return;
    const recent = ctx.chat.filter(message => !message.is_system && message.mes).slice(-4);
    const query = recent.map(message => message.mes).join('\n').slice(-10000);
    if (!query.trim()) return;
    const result = await request('recall', { chatKey: key, query, excludeIds: recent.map(message => message.extra?.castaliaAnimaId).filter(Boolean) });
    if (chatKey(context()) !== key || !chatState(context())?.enabled) return;
    const budget = Math.min(state.budget || 700, Math.floor((contextSize || 8192) / 5));
    const prompt = await memoryPrompt(result.results, budget, text => ctx.getTokenCountAsync(text));
    if (chatKey(context()) !== key || !chatState(context())?.enabled) return;
    ctx.setExtensionPrompt(PROMPT, prompt, 1, 2, false, 0);
    status(prompt ? '已召回当前剧情记忆' : '没有需要补充的历史记忆');
  } catch (error) { clearPrompt(); status(`记忆暂不可用：${error.message}`); }
};

export async function init() {
  if (initialized) return;
  initialized = true;
  const parent = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
  if (!parent) { initialized = false; throw new Error('找不到酒馆扩展设置面板'); }
  const panel = document.createElement('div');
  panel.id = 'castalia_anima_settings';
  panel.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>Castalia Anima · 聊天记忆</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="anima_enabled"><span>开启当前聊天的记忆</span></label>
      <p class="anima_hint">默认关闭。每个聊天独立保存；新剧情单独开始。开启后从新消息开始记录。</p>
      <label>记忆最多占用的 tokens <input id="anima_budget" type="number" min="100" max="3000" step="100" class="text_pole"></label>
      <div class="anima_actions"><button id="anima_import" class="menu_button">导入当前聊天</button><button id="anima_connect" class="menu_button">检查连接</button></div>
      <div id="anima_status" role="status"></div>
    </div></div>`;
  parent.append(panel);
  const sendForm = document.querySelector('#leftSendForm');
  if (sendForm && !document.querySelector('#castalia_anima_toggle')) {
    const toggle = document.createElement('button');
    toggle.id = 'castalia_anima_toggle';
    toggle.className = 'anima_toggle interactable fa-solid fa-brain';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '开启当前聊天记忆');
    toggle.setAttribute('aria-pressed', 'false');
    sendForm.append(toggle);
    toggle.addEventListener('click', () => {
      const state = chatState(context());
      if (!state) return;
      state.enabled = !state.enabled;
      clearTimeout(timer); clearPrompt();
      context().saveMetadataDebounced(); render();
      if (state.enabled) schedule();
    });
  }
  panel.querySelector('#anima_enabled').addEventListener('change', event => {
    const state = chatState(context());
    if (!state) return;
    state.enabled = event.target.checked;
    clearTimeout(timer); clearPrompt();
    context().saveMetadataDebounced(); render();
    if (state.enabled) schedule();
  });
  panel.querySelector('#anima_budget').addEventListener('change', event => {
    const state = chatState(context());
    if (!state) return;
    state.budget = Math.max(100, Math.min(3000, Number(event.target.value) || 700));
    context().saveMetadataDebounced(); render(); clearPrompt();
  });
  panel.querySelector('#anima_import').addEventListener('click', () => {
    const state = chatState(context());
    if (!state?.enabled) return;
    state.ignoredIds = [];
    context().saveMetadataDebounced();
    synchronize().catch(error => status(`导入失败：${error.message}`));
  });
  panel.querySelector('#anima_connect').addEventListener('click', async () => {
    status('检查连接中…');
    try { const result = await request('status'); status(`Anima 已连接 · ${result.embedMode === 'none' ? '文本检索' : '向量检索'}`); }
    catch (error) { status(`连接失败：${error.message}`); }
  });
  const { eventSource, eventTypes } = context();
  eventSource.on(eventTypes.CHAT_CHANGED, () => { clearTimeout(timer); generationActive = false; clearPrompt(); render(); if (chatState(context())?.enabled) schedule(); });
  eventSource.on(eventTypes.GENERATION_STARTED, () => { generationActive = true; clearTimeout(timer); });
  eventSource.on(eventTypes.GENERATION_ENDED, () => { generationActive = false; schedule(); });
  if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, () => { generationActive = false; schedule(); });
  for (const event of ['MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED']) {
    if (eventTypes[event]) eventSource.on(eventTypes[event], schedule);
  }
  render();
}
