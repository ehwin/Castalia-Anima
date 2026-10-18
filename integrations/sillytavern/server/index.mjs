import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const info = { id: 'castalia-anima', name: 'Castalia Anima', description: 'Per-chat Anima memory bridge' };
const directory = path.dirname(fileURLToPath(import.meta.url));
let client;
let connecting;
let configuration;
const locks = new Map();

export function projectFor(user, chatKey) {
  if (typeof user !== 'string' || !user || typeof chatKey !== 'string' || !chatKey || chatKey.length > 2000) throw new Error('Invalid user/chat identity');
  return `st_${crypto.createHash('sha1').update(JSON.stringify([user, chatKey])).digest('hex')}`;
}

export function textQuery(query) {
  const compounds = query.match(/[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)+/g) || [];
  const remaining = query.replace(/[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)+/g, ' ');
  const segments = new Intl.Segmenter('zh', { granularity: 'word' }).segment(remaining);
  const stopwords = new Set(['什么', '怎么', '这个', '那个', '我们', '你们', '他们', '自己', '一个', '已经', '可以', '还是', '没有', '不是']);
  const words = [...new Set([...compounds, ...[...segments].filter(part => part.isWordLike && part.segment.length > 1 && !stopwords.has(part.segment)).map(part => part.segment)])];
  return words.slice(-64).join(' ') || query;
}

async function engine() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    configuration ??= JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    const root = path.resolve(configuration.engineRoot);
    const sdk = path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
    const { Client } = await import(pathToFileURL(path.join(sdk, 'client/index.js')).href);
    const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, 'client/stdio.js')).href);
    const bank = path.resolve(configuration.bankDir);
    const candidate = new Client({ name: 'sillytavern-anima', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: configuration.node || process.execPath,
      args: [path.join(root, 'dist/index.js')], cwd: directory, stderr: 'pipe',
      env: {
        PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '',
        MEMORY_DB_DIR: bank, MEMORY_CONFIG: path.join(bank, 'config.json'),
        CASTALIA_KEYS_FILE: path.join(bank, 'keys.enc'), CASTALIA_KEY_FILE: path.join(bank, 'keys.key'),
        CASTALIA_PROJECT: 'sillytavern', CHAR_ID: 'sillytavern',
        EMBED_MODE: configuration.embedMode || 'none',
        OLLAMA_URL: configuration.ollamaUrl || 'http://127.0.0.1:11436',
        EMBEDDING_MODEL: configuration.embeddingModel || 'yuan-embedding-2.0-zh',
        MCP_TOOLS: 'tavern_sync,memory_search,reflect_batch_embed',
        CONSOLIDATE_AUTO_ON_START: '0', REFLECT_INTERVAL_HOURS: '0',
      },
    });
    transport.stderr?.on('data', data => console.debug('[Anima]', data.toString().trim()));
    candidate.onclose = () => { if (client === candidate) client = undefined; };
    try {
      await candidate.connect(transport);
      const tools = await candidate.listTools();
      if (!tools.tools.some(tool => tool.name === 'tavern_sync')) throw new Error('Anima 尚未构建 tavern_sync，请先 npm run build');
      client = candidate;
      return candidate;
    } catch (error) {
      await candidate.close().catch(() => {});
      throw error;
    }
  })();
  try { return await connecting; } finally { connecting = undefined; }
}

async function call(name, args) {
  const connection = await engine();
  const result = await connection.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const value = result.structuredContent ?? JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join(''));
  if (result.isError || value.ok === false) throw new Error(value.error?.message || 'Anima tool failed');
  return value;
}

async function serialized(project, operation) {
  const previous = locks.get(project) || Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  locks.set(project, pending);
  try { return await pending; } finally { if (locks.get(project) === pending) locks.delete(project); }
}

function owner(req) {
  // SillyTavern sets this even when user accounts are disabled; never accept a browser-supplied user.
  const handle = req.user?.profile?.handle;
  if (!handle) throw new Error('Missing SillyTavern user');
  return handle;
}

function route(handler) {
  return async (req, res) => {
    try { res.json({ ok: true, ...await handler(req) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message || String(error) }); }
  };
}

export async function init(router) {
  router.get('/status', route(async req => { owner(req); await engine(); return { connected: true, embedMode: configuration.embedMode || 'none' }; }));
  router.post('/sync', route(async req => {
    const project = projectFor(owner(req), req.body?.chatKey);
    if (!Array.isArray(req.body?.messages)) throw new Error('Missing chat snapshot');
    return serialized(project, async () => {
      const result = await call('tavern_sync', { project, messages: req.body.messages });
      // Optional embedding remains inside the same project. Do not run auto_process/digest/profile pipelines.
      if (configuration.embedMode && configuration.embedMode !== 'none') {
        const embedded = await call('reflect_batch_embed', { project });
        if (embedded.errors?.length) console.warn('[Anima] 部分记忆嵌入失败，检索将尝试文本回退');
      }
      return result;
    });
  }));
  router.post('/recall', route(async req => {
    const project = projectFor(owner(req), req.body?.chatKey);
    const query = req.body?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 12000) throw new Error('Invalid query');
    return serialized(project, async () => {
      // Segmentation gives Chinese text mode useful keywords instead of searching whole sentences.
      await engine();
      const searchQuery = (configuration.embedMode || 'none') === 'none' ? textQuery(query) : query;
      const result = await call('memory_search', { query: searchQuery, project, topK: 24, fullText: true });
      if (req.body.excludeIds != null && (!Array.isArray(req.body.excludeIds) || req.body.excludeIds.length > 100 || !req.body.excludeIds.every(id => typeof id === 'string'))) throw new Error('Invalid excluded messages');
      const exclude = new Set((req.body.excludeIds || []).map(id => `st_${crypto.createHash('sha256').update(`${project}:${id}`).digest('hex')}`));
      return { project, results: result.results.filter(row => !exclude.has(row.id)).slice(0, 8) };
    });
  }));
}

export async function exit() {
  await Promise.allSettled([...locks.values()]);
  if (connecting) await connecting.catch(() => {});
  if (client) await client.close();
  client = undefined;
}
