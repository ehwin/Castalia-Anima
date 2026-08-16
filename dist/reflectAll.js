/**
 * Reflect All — 跨库记忆反思整合 → reflect 总库 (v1.12)
 *
 * 末端反思模块:从全机所有记忆库(本实例 + FEDERATION_DIRS 外部实例)取活跃记忆,
 * 做跨库 LLM 反思整合(去重合并/提炼高价值洞察),把结果写入专用总库 project=reflect。
 *
 * 原则:
 *  - 只从记忆库取记忆,不碰对话日志(conversation_log 不在检索范围之外特判,
 *    但本模块只扫 memory 表的活跃记忆,不做对话分析)
 *  - 非破坏性:源库一律只读打开,绝不修改
 *  - 单库失败不影响整体(逐库 try/catch)
 *  - 系统提示仿写 reflectDriver.ts 的 REFLECT_SYSTEM_PROMPT 严格 JSON 输出风格
 */
import Database from 'better-sqlite3';
import { resolveFedLibraries } from './federation.js';
import { currentMemDir, DatabaseManager, generateId } from './db.js';
import { makeLlmChannel, callLlm } from './reflectDriver.js';
import { normalizeMemType } from './memType.js';
const DEFAULT_MAX_TOTAL = 300;
const DEFAULT_MAX_PER_LIB = 100;
const TEXT_CUT = 300; // 单条记忆喂给 LLM 的截断长度
const USER_PROMPT_CUT = 30000; // 用户提示上限(与 runAutoReflect 同量级)
const MAX_INSIGHTS = 50; // 洞察条数上限
const INSIGHTS_PER_LIB = 3; // 洞察条数 ≤ 输入库数 × 3
/** 逐库只读取活跃记忆(参照 federation.ts 的只读模式);单库失败不影响整体 */
function scanLibrary(lib, limit) {
    let db = null;
    try {
        db = new Database(lib.file, { readonly: true, fileMustExist: true });
        const rows = db.prepare(`
      SELECT id, text, mem_type, importance, created_at
      FROM memory
      WHERE is_active = 1
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
        return { rows };
    }
    catch (e) {
        return { rows: [], error: `[${lib.instance}/${lib.project}] 读取失败: ${e.message}` };
    }
    finally {
        if (db)
            db.close();
    }
}
/** 系统提示 — 仿写 REFLECT_SYSTEM_PROMPT 的严格 JSON 输出风格,但面向跨库整合 */
export function buildReflectAllSystemPrompt() {
    return `你是跨库记忆反思整合引擎(Cross-Library Memory Reflector)。你的任务是把来自多个记忆库的记忆做跨库整合:
1. 去重合并:语义重复的记忆只保留一条整合后的洞察,sources 列出所有来源库
2. 提炼洞察:从零散记忆中提炼有长期价值的高层洞察(用户画像/偏好/项目约定/行为纠正/外部指针)
3. 数量控制:洞察条数不超过输入库数的 3 倍,最多 50 条;宁缺毋滥

【记忆类型(mem_type)】每条洞察归入 5 种封闭类型之一:
- user — 用户画像:偏好/技术栈/风格/人物关系洞察
- feedback — 行为纠正:正负双向的行为纠正
- project — 项目上下文:截止时间/环境约定/非代码可推导信息
- reference — 外部指针:URL/ID/文档链接,只存指针不存内容副本
- general — 默认,无法归入上述四类时使用

【硬性禁止】
- 绝不虚构输入中不存在的事实;用户偏好原文保留
- 不存代码片段/函数定义/文件路径/git hash
- 不存临时调试日志/错误栈/单次会话状态
- 输入中的相对时间(昨天/上周/几天前)必须转成绝对日期(如 2026-08-12)

【输出格式】只返回严格 JSON 对象,不要任何其他文字(代码围栏也不要有):
{
  "insights": [
    {
      "text": "跨库整合后的洞察/合并后的记忆",
      "memType": "user|feedback|project|reference|general",
      "importance": 0.0-1.0,
      "tags": ["标签1", "标签2"],
      "sources": [{"instance": "库所在实例名", "project": "库名"}]
    }
  ]
}
- sources 必须只引用输入中实际出现的 [instance/project] 库
- 不需要整合时 insights 为空数组 []`;
}
/** 用户提示 — 按 [instance/project] 前缀分组列出各库记忆 */
export function buildReflectAllUserPrompt(groups) {
    const today = new Date().toISOString().slice(0, 10);
    const body = groups.map(g => `【${g.lib}】共 ${g.items.length} 条\n${g.items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`).join('\n\n');
    return `今天是 ${today}(相对日期转绝对日期时以此为准)。
请对以下来自 ${groups.length} 个记忆库的记忆做跨库反思整合,输出严格 JSON。

${body}`;
}
/** 鲁棒 JSON 解析(容忍 markdown 围栏/多余逗号;老风格直接数组也接受) */
function parseInsightsJson(raw) {
    let s = (raw || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence)
        s = fence[1].trim();
    if (!s.startsWith('{')) {
        const obj = s.match(/\{[\s\S]*\}/);
        if (obj)
            s = obj[0];
        else
            return null;
    }
    const attempts = [
        (x) => JSON.parse(x),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
    ];
    for (const fn of attempts) {
        try {
            const r = fn(s);
            if (r && typeof r === 'object' && Array.isArray(r.insights))
                return r;
            if (Array.isArray(r))
                return { insights: r };
            if (r && typeof r === 'object')
                return r;
        }
        catch { /* try next */ }
    }
    return null;
}
/** 规范化单条 insight(类型/重要性/标签/来源全部兜底) */
function normalizeInsight(raw, cap) {
    if (!raw || typeof raw !== 'object')
        return null;
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text)
        return null;
    const importance = Number(raw.importance);
    const tags = Array.isArray(raw.tags)
        ? raw.tags.filter((t) => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
        : [];
    const sources = Array.isArray(raw.sources)
        ? raw.sources
            .filter((s) => s && typeof s === 'object')
            .map((s) => ({
            instance: typeof s.instance === 'string' ? s.instance : 'local',
            project: typeof s.project === 'string' ? s.project : 'default',
        }))
        : [];
    const tagsDedup = [...new Set(tags)].slice(0, 20);
    return {
        text,
        memType: normalizeMemType(raw.memType),
        importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
        tags: tagsDedup,
        sources,
    };
}
/**
 * 跨库反思整合主流程:
 * 1. resolveFedLibraries 拿全部库清单(跳过 project=reflect 自身)
 * 2. 逐库只读取活跃记忆(截断 300 字符,单库失败不影响整体)
 * 3. 按 [instance/project] 分组组装 LLM 输入
 * 4. callLlm 跨库反思(未配置 LLM 返回错误说明,不崩)
 * 5. dryRun 只分析不写入
 * 6. 非 dryRun:逐条写入 project=reflect,查重跳过已存在
 */
export async function runReflectAll(opts) {
    const maxTotal = Number.isFinite(opts?.maxTotal) && (opts.maxTotal > 0) ? opts.maxTotal : DEFAULT_MAX_TOTAL;
    const maxPerLib = Number.isFinite(opts?.maxPerLib) && (opts.maxPerLib > 0) ? opts.maxPerLib : DEFAULT_MAX_PER_LIB;
    const dryRun = opts?.dryRun === true;
    const base = {
        ok: false, op: 'reflect_all', dryRun,
        scanned: { libraries: 0, memories: 0 },
        llm: { insights: 0, skipped: 0, saved: 0 },
        errors: [],
        insightList: [],
    };
    // 1. 库清单(跳过 reflect 自身;projects 指定时只保留匹配库)
    let libs;
    try {
        libs = resolveFedLibraries(currentMemDir()).filter(l => l.project !== 'reflect');
        if (opts?.projects && opts.projects.length > 0) {
            const want = new Set(opts.projects);
            libs = libs.filter(l => want.has(l.project));
        }
    }
    catch (e) {
        return { ...base, errors: [`解析联邦库清单失败: ${e.message}`] };
    }
    if (libs.length === 0) {
        return { ...base, ok: true, errors: ['未发现可扫描的记忆库(跳过 project=reflect 后为空)'] };
    }
    // 2. 逐库只读取活跃记忆(受 maxTotal / maxPerLib 预算约束)
    const groups = [];
    let memories = 0;
    let scannedLibs = 0;
    for (const lib of libs) {
        if (memories >= maxTotal)
            break;
        const limit = Math.min(maxPerLib, maxTotal - memories);
        const { rows, error } = scanLibrary(lib, limit);
        if (error) {
            base.errors.push(error);
            continue;
        }
        scannedLibs++;
        const items = rows.map(r => {
            const text = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_CUT);
            const mt = r.mem_type || 'general';
            const imp = Number.isFinite(Number(r.importance)) ? Number(r.importance) : 0.5;
            return `[mem_type=${mt}, importance=${imp}] ${text}`;
        });
        if (items.length > 0) {
            memories += items.length;
            groups.push({ lib: `[${lib.instance}/${lib.project}]`, items });
        }
    }
    base.scanned = { libraries: scannedLibs, memories };
    if (groups.length === 0) {
        return { ...base, ok: true, errors: ['各库均无活跃记忆或全部读取失败,无可反思内容'] };
    }
    // 3+4. LLM 跨库反思
    const channel = makeLlmChannel('REFLECT');
    if (!channel.apiKey) {
        return { ...base, errors: ['REFLECT LLM 未配置(REFLECT_LLM_API_KEY 缺失),无法执行跨库反思'] };
    }
    const userPrompt = buildReflectAllUserPrompt(groups).slice(0, USER_PROMPT_CUT);
    const llm = await callLlm(buildReflectAllSystemPrompt(), userPrompt, channel);
    if (!llm) {
        return { ...base, errors: ['LLM 调用失败(通道 REFLECT)'] };
    }
    const parsed = parseInsightsJson(llm.content || llm.reasoning);
    if (!parsed) {
        return { ...base, errors: ['LLM 未返回有效 JSON 结果'] };
    }
    // 洞察条数上限:≤ 输入库数 × 3,最多 50
    const cap = Math.min(MAX_INSIGHTS, Math.max(1, scannedLibs) * INSIGHTS_PER_LIB);
    const rawList = Array.isArray(parsed.insights) ? parsed.insights.slice(0, cap) : [];
    const insightList = rawList
        .map(r => normalizeInsight(r, cap))
        .filter((x) => x !== null);
    base.llm.insights = insightList.length;
    base.insightList = insightList;
    // 5. dryRun:返回分析结果不写入
    if (dryRun) {
        return { ...base, ok: true };
    }
    // 6. 写入 project=reflect(查重跳过)
    let saved = 0;
    let skipped = 0;
    try {
        const db = DatabaseManager.getInstance('reflect');
        const existsStmt = db.prepare('SELECT 1 FROM memory WHERE is_active = 1 AND text = ?');
        const insertStmt = db.prepare(`
      INSERT INTO memory (id, text, project, type, mem_type, category, tags, importance, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, 'reflect', 'semantic', ?, 'general', ?, ?, 'reflect-all', 'user', 'standard', 1, ?, ?, ?, 0, 0)
    `);
        const now = new Date().toISOString();
        for (const ins of insightList) {
            try {
                if (existsStmt.get(ins.text)) {
                    skipped++;
                    continue;
                }
                // tags 附上每个来源的 instance:project 标记
                const markers = ins.sources.map(s => `${s.instance}:${s.project}`);
                const tags = [...new Set([...ins.tags, ...markers])];
                insertStmt.run(generateId(), ins.text, ins.memType, JSON.stringify(tags), ins.importance, now, now, now);
                saved++;
            }
            catch (e) {
                base.errors.push(`写入洞察失败: ${e.message}`);
            }
        }
    }
    catch (e) {
        base.errors.push(`打开/写入 reflect 总库失败: ${e.message}`);
    }
    base.llm.skipped = skipped;
    base.llm.saved = saved;
    base.ok = true;
    return base;
}
