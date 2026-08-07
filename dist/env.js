/**
 * 记忆体框架环境变量配置 — 可配项集中管理
 *
 * 所有通过环境变量可覆盖的配置在这里定义,
 * 避免散落在各模块里硬编码。
 */
/** 角色/实例 ID:用于数据分区。默认 'airi'(Anima 血统,与旧版行为一致) */
export const CHAR_ID = process.env.CHAR_ID || 'airi';
/** 当前项目 ID(对齐 Hermes Project 概念):记忆按项目隔离。默认 'default' 保持向后兼容 */
export const PROJECT_ID = process.env.CASTALIA_PROJECT || 'default';
/**
 * 规范化项目名:trim 前后空白;空字符串/纯空白回退到默认项目。
 * 防止 '' / ' ' / ' alpha ' 这类脏值产生孤立项目命名空间。
 */
export function normalizeProject(p) {
    const t = (p ?? '').trim();
    return t.length > 0 ? t : PROJECT_ID;
}
/**
 * 按项目解析 AI 人格 ID(项目库 = AI 人格:切换项目即切换人格)。
 * 解析优先级:
 *   ① PERSONAS_JSON(configLoader 从 config.json 的 personas 段写入)中 project 命中 → 取 {charId};
 *   ② project 非空 → 项目名即人格名,规范化后返回(项目库天然按人格分区);
 *   ③ 其余(未传/空 project)→ 默认 CHAR_ID(向后兼容)。
 * charId 允许中文。
 */
export function charFor(project) {
    const raw = (project ?? '').trim();
    if (raw) {
        try {
            const personas = JSON.parse(process.env.PERSONAS_JSON || '{}');
            const entry = personas[raw];
            if (entry && entry.charId)
                return entry.charId;
        }
        catch { /* PERSONAS_JSON 非 JSON 时忽略,回退项目名 */ }
        return raw;
    }
    return CHAR_ID;
}
/**
 * 获取项目对应的人格声明(name/persona 取自 PERSONAS_JSON;
 * 无映射时 name=charId、persona 为空)。
 */
export function getPersona(project) {
    const charId = charFor(project);
    const raw = (project ?? '').trim();
    let entry = null;
    if (raw) {
        try {
            const personas = JSON.parse(process.env.PERSONAS_JSON || '{}');
            entry = personas[raw] || null;
        }
        catch { /* PERSONAS_JSON 非 JSON 时忽略 */ }
    }
    return { charId, name: (entry && entry.name) || charId, persona: (entry && entry.persona) || '' };
}
/**
 * 嵌入模式三档可选:
 *   none   → 纯本地:标签/正则 + 文本回退检索,零外部服务(不调 Ollama/API)
 *   ollama → 本地嵌入服务(OLLAMA_URL,默认,零 API 成本)
 *   api    → OpenAI 兼容 API(需 EMBEDDING_API_KEY)
 * 嵌入服务不可用时向量检索自动回退文本,记忆照常存取。
 */
export const EMBED_MODE = (process.env.EMBED_MODE || 'ollama').toLowerCase();
export function isEmbedEnabled() {
    return EMBED_MODE !== 'none';
}
/** MCP server 自描述名称 */
export const SERVER_NAME = process.env.MCP_SERVER_NAME || 'castalia-anima';
/** 服务器版本号 */
export const SERVER_VERSION = process.env.MCP_SERVER_VERSION || '1.0.0';
