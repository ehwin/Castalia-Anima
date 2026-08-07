/**
 * Triage Driver — LLM1(入站分拣)通道基础设施
 *
 * v1.11 三通道架构的第一部分:
 *   ① LLM1(triage)  = 入站分拣 + 临时反思(轻量,新配置 TRIAGE_LLM_*)
 *   ② 向量模型       = 记忆库改动后嵌入(已有 embedding.* 配置,不动)
 *   ③ LLM2(reflect) = 每日反思(v1.9 启动反思,已有 REFLECT_* 配置,不动)
 *
 * 通道配置:
 *   TRIAGE_LLM_URL      默认回退 REFLECT_LLM_URL,再回退 https://api.deepseek.com/v1
 *   TRIAGE_LLM_API_KEY  默认回退 REFLECT_LLM_API_KEY;两者都无 → 未配置
 *   TRIAGE_LLM_MODEL    默认回退 REFLECT_LLM_MODEL,再回退 deepseek-chat
 *
 * 回退逻辑:isTriageConfigured() = 有 TRIAGE key 或 REFLECT key。
 */
import { callLlm, makeLlmChannel } from './reflectDriver.js';
import { isMemType, isClosedMemType, normalizeMarkdown } from './memType.js';
import { getSessionMemory, upsertSessionMemory, promoteToProject, deleteSessionFragments } from './store.js';
import { normalizeProject } from './env.js';
/** triage 通道:未配置时回退 REFLECT_* 值(由 makeLlmChannel 统一处理) */
export function triageChannel() {
    return makeLlmChannel('triage');
}
/** triage 是否可用:有 triage key 或 reflect key 都算(回退通道可用) */
export function isTriageConfigured() {
    return !!triageChannel().apiKey;
}
/**
 * triage 极简分类 prompt(中文,Claude 原厂封闭类型语义)
 * 输出严格 JSON:{"memType":"user"} — user/feedback/project/reference/general 之一
 */
export const TRIAGE_SYSTEM_PROMPT = `你是记忆类型分拣引擎。你只做一件事:把一段输入文本分拣到最合适的一种记忆类型。

【记忆类型定义】
- user — 用户画像:用户偏好/技术栈/风格/人物关系洞察(关于"用户是什么样的人")
- feedback — 行为纠正:用户对 agent 行为的纠正或肯定(正面和负面都算)
- project — 项目上下文:当前项目的约定/截止时间/环境信息(非代码可推导的信息)
- reference — 外部指针:URL/链接/文档/ID 等外部引用,只存指针不存内容
- general — 以上都不匹配时的兜底
- 提示:输入文本若含相对时间(昨天/几天前/下周三),分类时注意该信息有时效性,分拣结果不受影响但后续处理须转绝对日期

【输出】只返回严格 JSON 对象,不要任何其他文字,不要代码围栏:
{"memType":"user"}`;
/** 从 LLM 原始输出中提取合法 memType(解析失败/不在白名单 → null → general) */
function parseMemType(raw) {
    let s = (raw || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence)
        s = fence[1].trim();
    const objMatch = s.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try {
            const obj = JSON.parse(objMatch[0]);
            const mt = obj?.memType;
            if (typeof mt === 'string' && isMemType(mt.trim().toLowerCase())) {
                return mt.trim().toLowerCase();
            }
            return null; // 有 memType 但不在白名单 → 非法,归 general
        }
        catch {
            // JSON 解析失败 → 落到裸词尝试
        }
    }
    // 裸词兜底:模型只返回了一个词(如 user)
    const idMatch = s.match(/[A-Za-z]+/);
    if (idMatch) {
        const t = idMatch[0].toLowerCase();
        if (isMemType(t))
            return t;
    }
    return null;
}
/**
 * 入站分拣:输入文本 → memType 白名单之一。
 * 失败/无 key → { memType: 'general', skipped: true }(不阻塞入站)。
 */
export async function classifyMemTypeLLM(text, project) {
    const channel = triageChannel();
    if (!channel.apiKey) {
        return { memType: 'general', skipped: true, raw: '' };
    }
    const userPrompt = `【输入文本】\n${(text || '').slice(0, 4000)}\n\n请返回记忆类型 JSON。`;
    const llm = await callLlm(TRIAGE_SYSTEM_PROMPT, userPrompt, channel);
    if (!llm) {
        return { memType: 'general', skipped: true, raw: '' };
    }
    const raw = llm.content || llm.reasoning || '';
    const parsed = parseMemType(raw);
    return {
        memType: parsed ?? 'general',
        skipped: false,
        raw,
    };
}
// ═══════════════════════════════════════════════════════════════════
// v1.11 Part2: 渐进式临时反思 — 增量反思(吸收 Claude Code
// session/prompts.ts INCREMENTAL_REFLECT_PROMPT + reflectDriver.runIncrementalReflection)
//   LLM1(triage 通道)增量反思:最近对话增量 + 会话旧滚动快照
//   → sessionMemory(会话滚动状态,滚动覆盖) + promoted(长效干货晋升项目级,晋升即删)
// ═══════════════════════════════════════════════════════════════════
/**
 * 会话记忆维护子代理 prompt(中文,Claude 原厂渐进式反思精神):
 * ①更新会话滚动状态(当前目标/活跃问题/本会话决策)
 * ②发现长效干货(user/feedback/project/reference)→ promoted
 * ③不重复、简洁(会话记忆 < 1000 字)
 * ④只关注当前任务上下文,用户长期偏好归长效
 */
export const INCREMENTAL_REFLECT_PROMPT = `你是会话记忆维护子代理。输入是最近对话增量 + 该会话已有的滚动记忆快照。你要维护两件事:

【任务1:更新会话滚动状态(sessionMemory)】
- 维护本会话:当前目标 / 活跃问题 / 本会话已做出的决策
- 用简洁的滚动要点式自然语言,控制在 1000 字以内
- 已完成或已解决的事项从状态中移除;仍相关/进行中的保留
- 只保留依赖本会话上下文的信息(如"正在做 X,下一步 Y")

【任务2:发现长效干货(promoted)】
- 从对话增量中提炼具有跨会话长期价值的信息,分类到 4 种封闭类型之一:
  - user — 用户画像:偏好/技术栈/风格/人物关系洞察(关于"用户是什么样的人")
  - feedback — 行为纠正:用户对 agent 行为的纠正或肯定(正负双向都记)
  - project — 项目上下文:截止时间/环境约定/非代码可推导信息;相对时间(如下周三)必须转成绝对日期(如 2026-08-12)
  - reference — 外部指针:URL/ID/文档链接,只存指针不存内容副本
- 记忆内容中的相对时间(昨天/上周/几天前/下周三)必须转成绝对日期(如 2026-08-12),否则视为模糊信息不采纳
- 只关注当前任务上下文;用户长期偏好等不依赖单次会话的内容 → 归 promoted 长效
- 不存:临时调试日志/错误栈/代码片段/文件路径/git hash/单次会话临时状态

【任务3:不重复】
- 旧快照已包含的信息不要重复写入 sessionMemory,也不要重复 promote
- 简洁为上:sessionMemory 必须 < 1000 字

【输出】只返回严格 JSON 对象,不要代码围栏,不要任何其他文字:
{
  "sessionMemory": "更新后的滚动状态(无变化可省略此字段)",
  "promoted": [
    {"memType": "user", "text": "长效记忆内容"}
  ]
}
- promoted 允许空数组 [];memType 必须属于 user/feedback/project/reference
- sessionMemory 字段可选,省略则不更新会话状态`;
/** 从 LLM 原始输出中解析增量反思 JSON(容忍代码围栏/尾逗号/控制字符) */
function parseIncrementalReflection(raw) {
    let s = (raw || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence)
        s = fence[1].trim();
    const obj = s.match(/\{[\s\S]*\}/);
    if (!obj)
        return null;
    const strategies = [
        (x) => JSON.parse(x),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]+/g, ' ')),
    ];
    for (const fn of strategies) {
        try {
            const r = fn(obj[0]);
            if (r && typeof r === 'object')
                return r;
        }
        catch { /* try next */ }
    }
    return null;
}
/**
 * 增量反思(渐进式临时反思)主流程:
 * 取最近 delta(最多 10 条)→ triage 通道调 LLM → 解析 → 晋升(promote+即删)→ 滚动覆盖。
 * 无 key / 解析失败 → 静默跳过(console.error),绝不影响主流程。
 * characterId 可选:默认 env CHAR_ID(与 MCP 流程的 auto_process 一致)。
 */
export async function runIncrementalReflection(project, sessionId, recentMessages, characterId) {
    const base = { ok: false, promoted: 0, errors: [] };
    const channel = triageChannel();
    if (!channel.apiKey) {
        const reason = '增量反思跳过:TRIAGE/REFLECT LLM key 未配置';
        console.error(`[reflect-incremental] ${reason}`);
        return { ...base, skipped: true, reason };
    }
    try {
        const recent = (recentMessages || []).slice(-10);
        if (recent.length === 0) {
            return { ...base, ok: true, skipped: true, reason: '无最近消息' };
        }
        const proj = normalizeProject(project);
        const oldSnapshot = getSessionMemory(proj, sessionId);
        const lines = recent.map(m => {
            const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : String(m.role);
            return `${who}: ${(m.content || '').slice(0, 2000)}`;
        }).join('\n');
        const userPrompt = `【会话 ID】${sessionId}
【该会话旧滚动快照】${oldSnapshot ? `\n${oldSnapshot}` : '\n(无)'}

【最近对话增量】
${lines}`;
        const llm = await callLlm(INCREMENTAL_REFLECT_PROMPT, userPrompt, channel);
        if (!llm)
            return { ...base, errors: ['LLM 调用失败'] };
        const parsed = parseIncrementalReflection(llm.content || llm.reasoning);
        if (!parsed)
            return { ...base, errors: ['增量反思输出解析失败'] };
        // sessionMemory:滚动状态(可省略)
        const sessionMemory = typeof parsed.sessionMemory === 'string' ? parsed.sessionMemory.trim() : '';
        // promoted:校验 memType 白名单(4 种封闭类型,非法丢弃)+ normalizeMarkdown 包装(4 类强制 Markdown)
        const promoted = [];
        if (Array.isArray(parsed.promoted)) {
            for (const item of parsed.promoted) {
                if (!item || typeof item !== 'object')
                    continue;
                const raw = item;
                const mtRaw = typeof raw.memType === 'string' ? raw.memType.trim().toLowerCase() : '';
                const text = typeof raw.text === 'string' ? raw.text.trim() : '';
                if (!mtRaw || !isClosedMemType(mtRaw) || !text)
                    continue;
                promoted.push({ memType: mtRaw, text: normalizeMarkdown(text, mtRaw) });
            }
        }
        // ① 晋升 → 项目级;晋升成功才清会话碎片(晋升即删)
        let promotedCount = 0;
        if (promoted.length > 0) {
            try {
                const ids = promoteToProject(proj, promoted, characterId);
                promotedCount = ids.length;
                if (ids.length > 0) {
                    try {
                        deleteSessionFragments(proj, sessionId);
                    }
                    catch (e) {
                        console.error('[reflect-incremental] 晋升即删失败:', e.message);
                    }
                }
            }
            catch (e) {
                console.error('[reflect-incremental] 晋升失败:', e.message);
            }
        }
        // ② sessionMemory 滚动覆盖(upsert 同 session_id)
        let sessionMemoryUpdated = false;
        if (sessionMemory) {
            try {
                upsertSessionMemory(proj, sessionId, sessionMemory);
                sessionMemoryUpdated = true;
            }
            catch (e) {
                console.error('[reflect-incremental] 会话滚动覆盖失败:', e.message);
            }
        }
        return { ok: true, sessionMemoryUpdated, promoted: promotedCount, errors: [] };
    }
    catch (e) {
        return { ...base, errors: [e.message] };
    }
}
