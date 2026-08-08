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
import crypto from 'node:crypto';
import { callLlm, makeLlmChannel, LlmChannel } from './reflectDriver.js';
import { isMemType, isClosedMemType, normalizeMarkdown, MemType } from './memType.js';
import { getSessionMemory, upsertSessionMemory, promoteToProject, deleteSessionFragments } from './store.js';
import { DatabaseManager } from './db.js';
import { normalizeProject, CHAR_ID } from './env.js';
import { embed, cosineSimilarity } from './ollama.js';

/** triage 通道:未配置时回退 REFLECT_* 值(由 makeLlmChannel 统一处理) */
export function triageChannel(): LlmChannel {
  return makeLlmChannel('triage');
}

/** triage 是否可用:有 triage key 或 reflect key 都算(回退通道可用) */
export function isTriageConfigured(): boolean {
  return !!triageChannel().apiKey;
}

export interface MemTypeClassification {
  memType: MemType;
  skipped: boolean;
  raw: string;
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
function parseMemType(raw: string): MemType | null {
  let s = (raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      const mt = (obj as any)?.memType;
      if (typeof mt === 'string' && isMemType(mt.trim().toLowerCase())) {
        return mt.trim().toLowerCase() as MemType;
      }
      return null; // 有 memType 但不在白名单 → 非法,归 general
    } catch {
      // JSON 解析失败 → 落到裸词尝试
    }
  }
  // 裸词兜底:模型只返回了一个词(如 user)
  const idMatch = s.match(/[A-Za-z]+/);
  if (idMatch) {
    const t = idMatch[0].toLowerCase();
    if (isMemType(t)) return t as MemType;
  }
  return null;
}

/**
 * 入站分拣:输入文本 → memType 白名单之一。
 * 失败/无 key → { memType: 'general', skipped: true }(不阻塞入站)。
 */
export async function classifyMemTypeLLM(text: string, project?: string): Promise<MemTypeClassification> {
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
 * 会话记忆提取子代理 prompt(原厂化,吸收 Claude Code extract_memories
 * sub-agent 定位 + 四类封闭类型 + 绝对禁止项;保留我们的 JSON 输出协议)。
 * 任务:①更新会话滚动状态(sessionMemory) ②发现长效干货(promoted)。
 */
export const INCREMENTAL_REFLECT_PROMPT = `You are a memory extraction sub-agent. Your sole responsibility is to extract long-term information from the recent conversation and update the memory system.

You receive a recent conversation transcript plus the existing rolling memory snapshot for this session. Maintain two things:
① the session rolling state (sessionMemory) and ② long-term memories worth keeping (promoted).

【ALLOWED MEMORY TYPES】(4 closed types, memType 必须属于其一)
- user — User profile, developer preferences, skill level, or response style.(用户画像:偏好/技术栈/技能水平/回复风格,关于"用户是什么样的人")
- feedback — Behavioral corrections or affirmations (negative & positive).(行为纠正或肯定,正负双向都记)
- project — Non-code-derivable project context (deadlines, env vars, architecture rules).(项目上下文:截止时间/环境变量/架构约定等非代码可推导信息)相对时间(如下周三)必须转成绝对日期(如 2026-08-12)
- reference — External links, Jira IDs, Swagger/API doc pointers.(外部指针:URL/Jira ID/Swagger 或 API 文档位置,只存指针不存内容副本)

【ABSOLUTE PROHIBITIONS】(绝对禁止)
- NEVER save code snippets, function definitions, file paths, or git hashes. The codebase/database itself is the Single Source of Truth.
- NEVER save temporary debugging logs, error stack traces, or single-session task states.

【任务 1:更新会话滚动状态(sessionMemory,可选)】
- 维护本会话:当前目标 / 活跃问题 / 本会话已做出的决策
- 用简洁的滚动要点式自然语言,控制在 1000 字以内
- 已完成或已解决的事项从状态中移除;仍相关/进行中的保留
- 只保留依赖本会话上下文的信息(如"正在做 X,下一步 Y")

【任务 2:发现长效干货(promoted)】
- 从对话增量中提炼具有跨会话长期价值的信息,归入上方 4 种类型之一
- 记忆内容中的相对时间(昨天/上周/几天前/下周三)必须转成绝对日期(如 2026-08-12),否则视为模糊信息不采纳
- 不重复:旧快照或已有记忆已包含的信息不要重复写入 sessionMemory,也不要重复 promote
- 只关注当前任务上下文;用户长期偏好等不依赖单次会话的内容 → 归 promoted 长效

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
function parseIncrementalReflection(raw: string): { sessionMemory?: string; promoted?: any[] } | null {
  let s = (raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const obj = s.match(/\{[\s\S]*\}/);
  if (!obj) return null;

  const strategies = [
    (x: string) => JSON.parse(x),
    (x: string) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
    (x: string) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]+/g, ' ')),
  ];
  for (const fn of strategies) {
    try {
      const r = fn(obj[0]);
      if (r && typeof r === 'object') return r;
    } catch { /* try next */ }
  }
  return null;
}

export interface IncrementalReflectionResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  sessionMemoryUpdated?: boolean;
  promoted: number;
  errors: string[];
}

/**
 * 文本归一化:去空白/换行 + 常见标点 + 统一小写。
 * 用于 promote 前查重(精确/包含判定)。
 */
export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：""''（）【】《》〈〉？！…—·,.!?;:'"()\[\]{}<>|/\\\-_*#~`+=\u3000]+/g, '')
    .trim();
}

/**
 * promote 前查重:同项目同 memType 的已有项目级记忆是否与候选重复。
 * 三层判定(命中即 true):
 *   ① 文本精确:归一化后相等
 *   ② 文本包含:归一化后一方含另一方,minLen>10 且 minLen/maxLen>0.7
 *   ③ 向量增强:候选文本读 embedding_cache 缓存向量,与 embed() 出的
 *      promoted 向量算 cosine > 0.92 → 重复;嵌入失败/无缓存静默跳过
 * 已有记忆排除自身来源(session_memory/auto_process/conversation_log)。
 * 任何异常静默降级为不重复(查重失败不阻断 promote)。
 */
export async function isDuplicate(
  proj: string,
  text: string,
  memType: MemType,
  characterId?: string,
): Promise<boolean> {
  try {
    const project = normalizeProject(proj);
    const db = DatabaseManager.getInstance(project);
    const target = normalizeText(text);
    if (!target) return false;
    const cid = characterId || CHAR_ID;

    const rows = db.prepare(`
      SELECT text FROM memory
      WHERE project = ? AND mem_type = ? AND is_active = 1
        AND character_id = ?
        AND COALESCE(source, '') NOT IN ('session_memory', 'auto_process', 'conversation_log')
    `).all(project, memType, cid) as { text: string }[];
    if (rows.length === 0) return false;

    // ① 精确 ② 包含
    for (const row of rows) {
      const cand = normalizeText(row.text);
      if (!cand) continue;
      if (cand === target) return true;
      const minLen = Math.min(cand.length, target.length);
      const maxLen = Math.max(cand.length, target.length);
      if (minLen > 10 && (cand.includes(target) || target.includes(cand)) && minLen / maxLen > 0.7) return true;
    }

    // ③ 向量增强:候选走 embedding_cache 缓存向量,promoted 用 embed()
    try {
      const targetVec = await embed(text, project);
      for (const row of rows) {
        try {
          const hash = crypto.createHash('sha256').update(row.text).digest('hex');
          const cached = db.prepare('SELECT embedding FROM embedding_cache WHERE text_hash = ?').get(hash) as any;
          if (!cached) continue;
          const vec = Array.from(new Float32Array(
            cached.embedding.buffer,
            cached.embedding.byteOffset,
            cached.embedding.byteLength / 4,
          ));
          if (cosineSimilarity(targetVec, vec) > 0.92) return true;
        } catch { /* 单条向量读取失败,静默跳过 */ }
      }
    } catch { /* embed 失败/嵌入禁用,静默跳过(文本查重兜底) */ }

    return false;
  } catch (e: any) {
    console.error('[reflect-incremental] isDuplicate 失败(静默降级):', e.message);
    return false;
  }
}

/**
 * 增量反思(渐进式临时反思)主流程:
 * 取最近 delta(最多 10 条)→ triage 通道调 LLM → 解析 → 晋升(promote+即删)→ 滚动覆盖。
 * 无 key / 解析失败 → 静默跳过(console.error),绝不影响主流程。
 * characterId 可选:默认 env CHAR_ID(与 MCP 流程的 auto_process 一致)。
 */
export async function runIncrementalReflection(
  project: string,
  sessionId: string,
  recentMessages: { role: string; content: string }[],
  characterId?: string,
): Promise<IncrementalReflectionResult> {
  const base: IncrementalReflectionResult = { ok: false, promoted: 0, errors: [] };
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
      const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : String(m.role).toUpperCase();
      return `${who}: ${(m.content || '').slice(0, 2000)}`;
    }).join('\n');
    const userPrompt = `[Session ID] ${sessionId}
[Existing session snapshot] ${oldSnapshot ? `\n${oldSnapshot}` : '\n(none)'}

[Conversation transcript]
<transcript>
${lines}
</transcript>`;

    const llm = await callLlm(INCREMENTAL_REFLECT_PROMPT, userPrompt, channel);
    if (!llm) return { ...base, errors: ['LLM 调用失败'] };
    const parsed = parseIncrementalReflection(llm.content || llm.reasoning);
    if (!parsed) return { ...base, errors: ['增量反思输出解析失败'] };

    // sessionMemory:滚动状态(可省略)
    const sessionMemory = typeof parsed.sessionMemory === 'string' ? parsed.sessionMemory.trim() : '';

    // promoted:校验 memType 白名单(4 种封闭类型,非法丢弃)+ normalizeMarkdown 包装(4 类强制 Markdown)
    const promoted: { memType: MemType; text: string }[] = [];
    if (Array.isArray(parsed.promoted)) {
      for (const item of parsed.promoted) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as any;
        const mtRaw = typeof raw.memType === 'string' ? raw.memType.trim().toLowerCase() : '';
        const text = typeof raw.text === 'string' ? raw.text.trim() : '';
        if (!mtRaw || !isClosedMemType(mtRaw) || !text) continue;
        try {
          if (await isDuplicate(proj, text, mtRaw, characterId)) continue;
        } catch { /* 查重失败不阻断,静默跳过 */ }
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
          try { deleteSessionFragments(proj, sessionId); }
          catch (e: any) { console.error('[reflect-incremental] 晋升即删失败:', e.message); }
        }
      } catch (e: any) {
        console.error('[reflect-incremental] 晋升失败:', e.message);
      }
    }

    // ② sessionMemory 滚动覆盖(upsert 同 session_id)
    let sessionMemoryUpdated = false;
    if (sessionMemory) {
      try {
        upsertSessionMemory(proj, sessionId, sessionMemory);
        sessionMemoryUpdated = true;
      } catch (e: any) {
        console.error('[reflect-incremental] 会话滚动覆盖失败:', e.message);
      }
    }

    return { ok: true, sessionMemoryUpdated, promoted: promotedCount, errors: [] };
  } catch (e: any) {
    return { ...base, errors: [e.message] };
  }
}
