/**
 * 记忆体框架环境变量配置 — 可配项集中管理
 *
 * 所有通过环境变量可覆盖的配置在这里定义,
 * 避免散落在各模块里硬编码。
 */
import { VERSION } from './version.js';

/**
 * 角色/实例 ID:用于数据分区。默认 'default'(Anima 血统,与旧版行为一致)。
 *
 * v1.24: 角色身份 = 进程级 CHAR_ID(与 Castalia 普通版一致:一个实例一个角色),
 * 不再按 project 推导角色。project 只做记忆库维度(库/项目分区)。
 * 多角色 = 多实例(各自 CHAR_ID + 各自库目录),同一库里不同角色靠 character_id 列隔离。
 */
export const CHAR_ID: string = String(process.env.CHAR_ID || 'default').trim() || 'default';

/** 当前项目 ID(对齐 Host Project 概念):记忆按项目隔离。默认 'default' 保持向后兼容 */
export const PROJECT_ID: string = process.env.CASTALIA_PROJECT || 'default';
/**
 * 共享层项目名(约定,2026-08-16):存进该库的记忆为"所有库共知"候选。
 * 引擎不做隐式合并 —— 互通语义由上层/调用方显式决定(接口先行,规则待定)。
 */
export const SHARED_PROJECT: string = process.env.SHARED_PROJECT || 'shared';


/**
 * 规范化项目名:trim 前后空白;空字符串/纯空白回退到默认项目。
 * 防止 '' / ' ' / ' alpha ' 这类脏值产生孤立项目命名空间。
 */
export function normalizeProject(p?: string): string {
  const t = (p ?? '').trim();
  return t.length > 0 ? t : PROJECT_ID;
}

/** Canonical character partition key used by memory, state and queues. */
export function normalizeCharacterId(id?: string): string {
  const value = String(id ?? '').trim();
  return value || CHAR_ID;
}

/**
 * 角色身份解析 — 与 Castalia 普通版对齐:角色只由进程级 CHAR_ID 决定。
 *
 * v1.24 起不再有 project→角色的推导(旧行为:project 名即角色名、personas 按 project 映射)。
 * 保留该函数只为兼容既有调用点,参数被忽略,恒返回 CHAR_ID。
 * @deprecated 直接用 CHAR_ID(工具层已全部改为 CHAR_ID)。
 */
export function charFor(_project?: string): string {
  return CHAR_ID;
}

/**
 * 获取当前实例(角色)的人格声明:name/persona 取自 PERSONAS_JSON 中以 CHAR_ID 为键的条目;
 * 无映射时 name=charId、persona 为空。
 * 注:v1.24 前 personas 以 project 名为键,若旧配置仍按 project 键书写,请改成 CHAR_ID 键。
 */
export function getPersona(_project?: string): { charId: string; name: string; persona: string } {
  const charId = CHAR_ID;
  let entry: any = null;
  try {
    const personas = JSON.parse(process.env.PERSONAS_JSON || '{}');
    entry = personas[charId] || null;
  } catch { /* PERSONAS_JSON 非 JSON 时忽略 */ }
  return { charId, name: (entry && entry.name) || charId, persona: (entry && entry.persona) || '' };
}

/**
 * 嵌入模式三档可选:
 *   none   → 纯本地:标签/正则 + 文本回退检索,零外部服务(不调 Ollama/API)
 *   ollama → 本地嵌入服务(OLLAMA_URL,默认,零 API 成本)
 *   api    → OpenAI 兼容 API(需 EMBEDDING_API_KEY)
 * 嵌入服务不可用时向量检索自动回退文本,记忆照常存取。
 */
export const EMBED_MODE: string = (process.env.EMBED_MODE || 'ollama').toLowerCase();

export function isEmbedEnabled(): boolean {
  return EMBED_MODE !== 'none';
}

/** MCP server 自描述名称 */
export const SERVER_NAME: string = process.env.MCP_SERVER_NAME || 'castalia';

/** 服务器版本号(单一来源:仓库根 VERSION → src/version.ts) */
export const SERVER_VERSION: string = process.env.MCP_SERVER_VERSION || VERSION;
