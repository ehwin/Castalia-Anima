/**
 * Config Loader — 启动时读取 config.json 覆盖环境变量
 *
 * 供 web 管理界面持久化配置:嵌入模型(Ollama/API 两种模式)+ 反思 LLM。
 * 配置文件路径:环境变量 MEMORY_CONFIG 或 ./memory/config.json(与 web/server.mjs 共享)
 *
 * v1.13 API key 加密独立存储:memory/keys.enc(AES-256-GCM)启动时自动解密注入环境变量,
 * 密钥为 memory/keys.key(32 字节 hex)。解析优先级:显式环境变量 > keys.enc > config.json。
 * 生成/更新工具:node scripts/keygen.js
 *
 * 必须在 index.ts 的 import 中放在最前面(确保在 ollama.ts/reflectDriver.ts 读取 env 之前生效)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_PATH = process.env.MEMORY_CONFIG
  || path.join(process.cwd(), 'memory', 'config.json');

// 加密 key 存储(与代码分离:更新代码/删除仓库不影响已加密的 key)
const KEYS_FILE = process.env.CASTALIA_KEYS_FILE
  || path.join(process.cwd(), 'memory', 'keys.enc');
const KEY_FILE = process.env.CASTALIA_KEY_FILE
  || path.join(process.cwd(), 'memory', 'keys.key');

/**
 * 解密 keys.enc(JSON {iv, tag, data},aes-256-gcm)。
 * 返回 {reflect:{api_key}, triage:{api_key}, embedding:{api_key}} 结构;
 * 文件不存在 → 静默返回 null;解密失败 → console.warn 一次并返回 null(不影响启动)。
 */
function loadEncryptedKeys(): { [channel: string]: { api_key?: string } } | null {
  if (!fs.existsSync(KEYS_FILE)) return null;
  if (!fs.existsSync(KEY_FILE)) {
    console.warn(`[config] 找到 ${KEYS_FILE} 但缺少密钥文件 ${KEY_FILE},跳过加密 API key(可用 node scripts/keygen.js 生成)`);
    return null;
  }
  try {
    const keyHex = fs.readFileSync(KEY_FILE, 'utf-8').trim();
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw new Error(`keys.key 不是 32 字节 hex(实际 ${key.length} 字节)`);
    const { iv, tag, data } = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    if (!iv || !tag || !data) throw new Error('keys.enc 结构不完整(缺 iv/tag/data)');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf-8');
    return JSON.parse(plain);
  } catch (e: any) {
    console.warn(`[config] ${KEYS_FILE} 解密失败,跳过加密 API key:${e.message}`);
    return null;
  }
}

/**
 * API key 解析优先级:显式环境变量 > keys.enc > config.json。
 * 环境变量已有值时不覆盖;keys.enc 解密出的值优先于 config.json 的同名字段。
 */
function applyApiKey(envName: string, fromKeys: string | undefined, fromCfg: string | undefined) {
  if (process.env[envName]) return;
  const k = (fromKeys ?? '').trim();
  if (k) { process.env[envName] = k; return; }
  const c = (fromCfg ?? '').trim();
  if (c) process.env[envName] = c;
}

try {
  const encryptedKeys = loadEncryptedKeys();

  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

    // 记忆库目录配置:config.json 的 db_dir 字段(若有)覆盖环境变量
    if (cfg.db_dir && typeof cfg.db_dir === 'string' && cfg.db_dir.trim()) {
      process.env.MEMORY_DB_DIR = cfg.db_dir.trim();
    }

    // 嵌入模型配置
    const emb = cfg.embedding || {};
    if (emb.mode) process.env.EMBED_MODE = String(emb.mode).toLowerCase();
    if (emb.mode === 'api') {
      if (emb.api_url) process.env.OLLAMA_URL = emb.api_url.replace(/\/+$/, '');
      if (emb.api_model) process.env.EMBEDDING_MODEL = emb.api_model;
      applyApiKey('EMBEDDING_API_KEY', encryptedKeys?.embedding?.api_key, emb.api_key);
    } else if (emb.mode !== 'none') {
      if (emb.ollama_url) process.env.OLLAMA_URL = emb.ollama_url.replace(/\/+$/, '');
      if (emb.model) process.env.EMBEDDING_MODEL = emb.model;
    }

    // 反思 LLM 配置
    const ref = cfg.reflect || {};
    if (ref.llm_url) process.env.REFLECT_LLM_URL = ref.llm_url.replace(/\/+$/, '');
    applyApiKey('REFLECT_LLM_API_KEY', encryptedKeys?.reflect?.api_key, ref.api_key);
    if (ref.model) process.env.REFLECT_LLM_MODEL = ref.model;
    if (ref.factExtraction) process.env.REFLECT_FACT_EXTRACTION = String(ref.factExtraction);
    if (ref.maxFacts != null) process.env.REFLECT_MAX_FACTS = String(ref.maxFacts);
    // v1.9: 启动自动反思阈值(可选,给 admin 界面留路;没有则用 env/默认值)
    if (ref.minGapHours != null) process.env.REFLECT_MIN_GAP_HOURS = String(ref.minGapHours);
    if (ref.minUnanalyzed != null) process.env.REFLECT_MIN_UNANALYZED = String(ref.minUnanalyzed);
    if (ref.intervalHours != null) process.env.REFLECT_INTERVAL_HOURS = String(ref.intervalHours);

    // v1.11: triage(LLM1 入站分拣)配置 — admin 第三个通道
    const tri = cfg.triage || {};
    if (tri.llm_url) process.env.TRIAGE_LLM_URL = tri.llm_url.replace(/\/+$/, '');
    applyApiKey('TRIAGE_LLM_API_KEY', encryptedKeys?.triage?.api_key, tri.api_key);
    if (tri.model) process.env.TRIAGE_LLM_MODEL = tri.model;

    // v1.11 Part2: 渐进式临时反思配置(admin 留路;缺省用 env/默认值)
    if (tri.bufferSize != null) process.env.BUFFER_SIZE = String(tri.bufferSize);
    if (tri.bufferTokens != null) process.env.BUFFER_TOKENS = String(tri.bufferTokens);
    if (tri.sessionTtlDays != null) process.env.SESSION_MEMORY_TTL_DAYS = String(tri.sessionTtlDays);

    // v1.10: 记忆整合配置(可选,给 admin 界面留路;没有则用 env/默认值)
    const cons = cfg.consolidate || {};
    if (cons.minMemories != null) process.env.CONSOLIDATE_MIN_MEMORIES = String(cons.minMemories);
    if (cons.similarity != null) process.env.CONSOLIDATE_SIMILARITY = String(cons.similarity);
    if (cons.autoOnStart != null) process.env.CONSOLIDATE_AUTO_ON_START = (cons.autoOnStart === false || cons.autoOnStart === 0 || cons.autoOnStart === '0') ? '0' : '1';
  // 衰减范围(哪些分类库参与衰减/升华):默认只 general,四个语义分类库永不衰减
  if ((cons as any).decayMemTypes != null) {
    const dm = (cons as any).decayMemTypes;
    process.env.CONSOLIDATE_DECAY_MEMTYPES = Array.isArray(dm) ? dm.join(',') : String(dm);
  }

    // v1.12: 人格配置(项目库 = AI 人格):{"项目名": {"charId","name","persona"}}
    // 解析后写入 process.env.PERSONAS_JSON(供 env.charFor / getPersona 按项目解析人格)
    const personas = (cfg.personas && typeof cfg.personas === 'object') ? cfg.personas : {};
    if (Object.keys(personas).length > 0) {
      process.env.PERSONAS_JSON = JSON.stringify(personas);
    }

    console.error(`[config] loaded ${CONFIG_PATH} (embed=${emb.mode || 'ollama'}, reflect=${ref.model || 'unset'}, facts=${process.env.REFLECT_FACT_EXTRACTION || 'auto'}, consolidate=${process.env.CONSOLIDATE_MIN_MEMORIES || '15'}/${process.env.CONSOLIDATE_SIMILARITY || '0.88'}, triage=${tri.model || 'unset'}, buffer=${process.env.BUFFER_SIZE || '5'}, sessionTtl=${process.env.SESSION_MEMORY_TTL_DAYS || '7'}d, personas=${Object.keys(personas).length})`);
  }

  // 无 config.json 时,keys.enc 仍可独立注入(与上方 applyApiKey 调用幂等)
  if (encryptedKeys) {
    applyApiKey('EMBEDDING_API_KEY', encryptedKeys.embedding?.api_key, undefined);
    applyApiKey('REFLECT_LLM_API_KEY', encryptedKeys.reflect?.api_key, undefined);
    applyApiKey('TRIAGE_LLM_API_KEY', encryptedKeys.triage?.api_key, undefined);
  }
} catch (e: any) {
  console.error('[config] load failed:', e.message);
}
