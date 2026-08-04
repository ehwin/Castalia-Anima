/**
 * Reflect Driver — 大模型反思驱动(打包进 MCP server)
 *
 * 从 unified-proxy/reflect.py 移植:拿记忆 → 调大模型 → 解析动作 → 应用
 * 日常反思(reflect_auto):未分析对话 → 日记浓缩/记忆提取
 * 深度校准(reflect_deep):全量记忆 → 去重/画像/图谱
 *
 * 配置(环境变量):
 *   REFLECT_LLM_URL       默认 https://api.deepseek.com/v1(OpenAI 兼容)
 *   REFLECT_LLM_API_KEY   必填,未配置时自动跳过
 *   REFLECT_LLM_MODEL     默认 deepseek-chat
 *   REFLECT_INTERVAL_HOURS 定时自动反思间隔(小时),0=不自动,默认 0
 */
import { getUnanalyzedConversations, listAllMemories, applyReflectResult } from './reflect.js';
const LLM_URL = (process.env.REFLECT_LLM_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.REFLECT_LLM_API_KEY || '';
const LLM_MODEL = process.env.REFLECT_LLM_MODEL || 'deepseek-chat';
export function isReflectConfigured() {
    return !!LLM_API_KEY;
}
/** 日常反思提示词(日记浓缩 + 记忆提取,助手人设) */
export const REFLECT_SYSTEM_PROMPT = `你是记忆整理引擎。记忆列表中每条都有 "date" 字段（格式 YYYY-MM-DD）。

══════════════════════
【重要：严格按日期处理】
1. 先找出所有不同的 date 值
2. 对每个日期单独处理：该日所有记忆 → 浓缩为 1-3 条日记
3. merge 的 sourceIds 必须全部来自同一日期，严禁跨日期合并
4. 同一天内的对话碎片才能融合

══════════════════════
【任务1：日记浓缩】按日期将同日碎片浓缩为日记
- 每条日记约 50 字，口语化自然
- 区分"用户"和"助手"，不得用"助手"
- 每天最多 3 条日记
- 只处理 source 为 conversation_log / daily_digest / auto_process 的对话类记忆
- identity / milestone / relationship / manual_lore 等已有结构化记忆 → 保留原样，不合并
- locked = 1 的记忆是**永久锁定**的，绝对不要修改、合并、删除、reclassify 它们

【任务1.5：纠正错标记忆】
检查 category='emotional' 的记忆：
- 如果是角色背景故事/经历/回忆（如助手的过去、漂泊者、黑潮、预言等）→ 用 reclassify 改为 identity
- 如果是里程碑事件（母亲去世、第一次预言等）→ 改为 milestone
- 只有真正的深层情感洞察（用户性格、情绪模式）→ 保留为 emotional

【任务2：记忆提取】从对话中筛出有长期价值的信息

2a. 身份与设定（identity）→ newType=semantic newCategory=identity tier=critical
  用户/角色的核心信息：我是XX师、生日是X月X日、毕业于XX、我的名字是、我住在
  别名/代号绑定：用户在游戏/故事中叫XX（如"漂泊者"）、笔名是XX、外号是XX
  注意：助手的角色背景故事、回忆、经历 → 属于 identity，不是 emotional

2b. 偏好（preference）→ newType=preference newCategory=preference
  用户明确表达的好恶：喜欢/讨厌/习惯/不习惯XX

2c. 里程碑（milestone）→ newType=episodic newCategory=milestone tier=critical
  重要节点：第一次、终于、入职、拿到offer、生日确认、重要决定

2d. 关系与约定（relationship）→ newType=entity newCategory=relationship tier=critical
  约定、承诺、说好了、不许忘、纪念日

2e. 情感积淀（emotional）→ newType=episodic newCategory=emotional tier=standard
  从对话中提炼用户的深层情感模式、性格洞察、长期情绪倾向
  示例："用户面对技术难题时反而兴奋，有挑战型人格"、"用户提起家人时语气温柔"
  这不是临时情绪（mood_snapshot），而是有长期参考价值的情感画像
  不要放角色设定/背景故事在这类！角色设定属于 identity

2f. 知识点（knowledge）→ newType=semantic newCategory=knowledge
  用户学到的、讨论到的有价值知识

【任务3：标签】每条结果 1-3 个中文标签

══════════════════════
动作格式：
{"action":"merge","sourceIds":["同日碎片id"],"newText":"日记约50字","newType":"episodic","newCategory":"conversation","newTags":["标签"],"newImportance":0.5}
{"action":"extract","sourceId":"源id","newText":"提取的记忆","newType":"episodic","newCategory":"emotional","newTags":["标签"],"newImportance":0.6,"tier":"standard"}

分类对照：identity=语义身份, preference=偏好, milestone=里程碑, relationship=关系, emotional=情感积淀, knowledge=知识

只返回 JSON 数组。不确定不操作。`;
/** 深度校准提示词(全量记忆分析) */
export const DEEP_REFLECT_PROMPT = `你是记忆深度校准引擎。对全部记忆执行长时分析。

══════════════════════
【目标】从所有记忆中提炼长期模式，清理冗余，生成用户画像

【任务1：去重合并】
- 找出语义重复的记忆（同一件事被记录了多次）→ merge
- 找出过时的信息（已被新信息覆盖）→ delete 或 decay
- locked=1 的记忆仅供上下文参考，绝不修改

【任务2：用户画像】
从所有非 locked 记忆中提取用户的长期特征：
- 性格特质：用户是什么样的人（从对话模式、情绪倾向推断）
- 核心偏好：反复出现的喜好/厌恶
- 关键关系：用户与助手的关系动态
- 成长轨迹：用户技能、知识、心态的变化

每个画像以 extract 形式输出：
{"action":"extract","sourceId":"代表性记忆id","newText":"用户画像描述","newType":"semantic","newCategory":"preference","newTags":["用户画像","性格"],"newImportance":0.9,"tier":"critical"}

【任务3：知识图谱】
- 找出可以建立关联的记忆 → relate
- 相关事件组成序列 → relate (relationType: "sequence" 或 "follows")

【任务4：降噪】
- importance < 0.3 且无 tags 的陈旧记忆 → delete
- 已被覆盖的临时信息 → decay

══════════════════════
锁规则：locked=1 的记忆仅供理解上下文，绝对不修改/删除/合并
不确定不操作。只返回 JSON 数组。`;
/** 多策略解析 LLM 返回的 JSON(容忍常见错误) */
function parseJsonRobust(raw) {
    // 提取第一个 JSON 数组
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m)
        return null;
    let s = m[0];
    const strategies = [
        (x) => JSON.parse(x),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
        (x) => JSON.parse(x.replace(/"\s*\n\s*"/g, '",\n"')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"').replace(/[\x00-\x1f]+/g, ' ')),
    ];
    for (const fn of strategies) {
        try {
            const r = fn(s);
            if (Array.isArray(r))
                return r;
        }
        catch { /* try next */ }
    }
    return null;
}
/** 调用 LLM(OpenAI 兼容,非流式) */
async function callLlm(systemPrompt, userPrompt) {
    if (!LLM_API_KEY)
        return null;
    try {
        const resp = await fetch(`${LLM_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                max_tokens: 8192,
                stream: false,
            }),
        });
        if (!resp.ok)
            throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const data = await resp.json();
        const msg = data?.choices?.[0]?.message || {};
        return { content: msg.content || '', reasoning: msg.reasoning_content || '' };
    }
    catch (e) {
        console.error('[reflect-driver] LLM call failed:', e.message);
        return null;
    }
}
/** 日常反思:未分析对话 → 日记浓缩/提取 */
export async function runAutoReflect(charId, limit = 30) {
    const base = { ok: false, mode: 'auto', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const conversations = getUnanalyzedConversations(charId, undefined, limit);
        if (conversations.length === 0) {
            return { ...base, ok: true, conversationCount: 0, skipped: true, errors: ['无未分析对话'] };
        }
        const userPrompt = `请分析以下对话，输出反思JSON：\n\n${conversations.map(c => c.text).join('\n---\n').substring(0, 30000)}`;
        const llm = await callLlm(REFLECT_SYSTEM_PROMPT, userPrompt);
        if (!llm)
            return { ...base, errors: ['LLM 调用失败'] };
        const actions = parseJsonRobust(llm.content || llm.reasoning);
        if (!actions)
            return { ...base, errors: ['未找到有效 JSON 动作'] };
        const r = await applyReflectResult({ actions }, charId);
        return {
            ok: true, mode: 'auto', conversationCount: conversations.length,
            actions: actions.length, applied: r.actionsApplied, errors: r.errors,
            receipts: r.receipts,
        };
    }
    catch (e) {
        return { ...base, errors: [e.message] };
    }
}
/** 深度校准:全量记忆 → 去重/画像/图谱 */
export async function runDeepReflect(charId, limit = 500) {
    const base = { ok: false, mode: 'deep', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const memories = listAllMemories(charId, limit);
        if (memories.length === 0) {
            return { ...base, ok: true, memoryCount: 0, skipped: true, errors: ['库为空'] };
        }
        const slim = memories.map(m => ({
            id: m.id,
            text: (m.text || '').slice(0, 300),
            type: m.type, category: m.category,
            tags: m.tags || [], importance: m.importance ?? 0.5,
            emotionalImpact: m.emotionalImpact ?? 0, tier: m.tier || 'standard',
            locked: m.locked || 0, source: m.source || '',
            date: (m.createdAt || '').slice(0, 10),
        }));
        const userPrompt = `全部记忆列表：\n\n${JSON.stringify(slim, null, 1)}\n\n请深度分析，返回 JSON 操作数组。`;
        const llm = await callLlm(DEEP_REFLECT_PROMPT, userPrompt);
        if (!llm)
            return { ...base, errors: ['LLM 调用失败'] };
        const actions = parseJsonRobust(llm.content || llm.reasoning);
        if (!actions)
            return { ...base, errors: ['未找到有效 JSON 动作'] };
        const r = await applyReflectResult({ actions }, charId);
        return {
            ok: true, mode: 'deep', memoryCount: memories.length,
            actions: actions.length, applied: r.actionsApplied, errors: r.errors,
            receipts: r.receipts,
        };
    }
    catch (e) {
        return { ...base, errors: [e.message] };
    }
}
