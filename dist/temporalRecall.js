/**
 * 时间路注入：问句里出现"昨天/今天/最近"时，直接取那几天的记录，不靠余弦。
 *
 * 为什么不能靠相似度（2026-10-30 实测）：事件行已经写了向量索引，但「我昨天在忙什么」这种问句
 * 与人设长文的相似度更高（lore 0.706 vs 事件行 ~0.5），事件行连 top-12 都进不去。
 * 人查"昨天做了什么"会直接翻昨天那一页，不会去算语义距离 —— 这一路也一样：按日期直取。
 *
 * 门槛：只有问句真的带时间词才触发；只取事件层（source='daily_event'），不翻原文，
 * 避免把一整天的对话流水灌进上下文。
 *
 * 2026-10-30 两处修正：
 *   1. 原来还查 `reflect_summary`，但摘要行的 text 不以 `# <日期>` 开头、tags 里也没有 `day:`，
 *      那条 LIKE 永远不命中 —— 声明了却不生效比不支持更糟，直接去掉（摘要没有日粒度）。
 *   2. 加了**未来问句**（明天/后天/下周/待办）：未来还没有事件，真正该取的是今天事件里
 *      的「未完」项。实测「明天有什么要做的」原来 0 条，而库里明明记着"明天三点复查膝盖"。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { CHAR_ID, normalizeProject } from './env.js';
import { localDayOf } from './dayKey.js';
import { temporalDaysOf } from './recallForInjection.js';
/** 未来/待办型问句：该取「未完」而不是按日期翻页 */
const FUTURE_RE = /明天|明日|明早|明晚|后天|大后天|下周|下个?星期|接下来|待办|todo|要做什么|有什么要(做|安排)|安排了吗/i;
export function isFutureIntent(query) {
    return FUTURE_RE.test(String(query || ''));
}
/** 事件行正文的第一行是 `# YYYY-MM-DD · 标题`，第二行是一句话概述，`未完:` 行是待跟进项 */
function parseEventText(text) {
    const lines = String(text).split('\n');
    const head = (lines[0] || '').replace(/^#\s*/, '');
    const looseLine = lines.find(l => l.trim().startsWith('未完')) || '';
    const loose = looseLine.replace(/^\s*未完\s*[:：]\s*/, '').trim();
    const m = head.match(/^(\d{4}-\d{2}-\d{2})\s*[·:：-]?\s*(.*)$/);
    if (m)
        return { day: m[1], title: (m[2] || '').trim(), summary: (lines[1] || '').trim(), loose };
    return { day: '', title: head.slice(0, 24), summary: (lines[1] || '').trim(), loose };
}
/** 最近 N 天事件里的「未完」项 —— 未来问句的答案来源 */
function recallLooseEnds(proj, cid, limit, maxChars, lookbackDays = 7) {
    const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
    const found = [];
    for (const mt of listMemTypeDirs(proj)) {
        let db;
        try {
            db = DatabaseManager.getInstance(proj, mt);
        }
        catch {
            continue;
        }
        try {
            const rows = db.prepare(`
        SELECT id, text, importance
        FROM memory
        WHERE is_active = 1 AND project = ? AND character_id = ?
          AND source = 'daily_event' AND text LIKE '%未完%' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 40
      `).all(proj, cid, since);
            for (const row of rows) {
                const parsed = parseEventText(row.text);
                if (!parsed.loose)
                    continue;
                found.push({
                    id: String(row.id),
                    day: parsed.day || localDayOf(row.created_at || new Date()),
                    title: parsed.title,
                    summary: parsed.loose,
                    importance: Number(row.importance) || 0,
                });
            }
        }
        catch { /* 该库没有这些表 */ }
    }
    if (found.length === 0)
        return { text: '', hits: [], days: [] };
    const seen = new Set();
    const picked = [];
    let chars = 0;
    for (const hit of found.sort((a, b) => b.day.localeCompare(a.day))) {
        const key = `${hit.day}\u0000${hit.summary}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const line = `- [${hit.day}] ${hit.summary}（来自：${hit.title}）`;
        if (chars + line.length > maxChars)
            continue;
        picked.push(hit);
        chars += line.length;
        if (picked.length >= limit)
            break;
    }
    if (picked.length === 0)
        return { text: '', hits: [], days: [] };
    const body = picked.map(h => `- [${h.day}] ${h.summary}（来自：${h.title}）`).join('\n');
    return {
        text: `以下是还没做完、待跟进的事（取最近 ${lookbackDays} 天事件里的「未完」项）：\n${body}`,
        hits: picked,
        days: [...new Set(picked.map(h => h.day))],
    };
}
export function recallTemporalForQuery(query, options = {}) {
    const days = [...temporalDaysOf(String(query || ''))];
    const future = isFutureIntent(String(query || ''));
    if (days.length === 0 && !future)
        return { text: '', hits: [], days };
    const proj = normalizeProject(options.project);
    const cid = options.characterId || CHAR_ID;
    const limit = Math.max(1, Math.min(options.limit ?? 4, 8));
    const maxChars = options.maxChars ?? 480;
    // 未来问句优先：库里还没有"明天"的事件，能回答的只有「未完」
    if (future) {
        const loose = recallLooseEnds(proj, cid, limit, maxChars);
        if (loose.hits.length > 0)
            return loose;
        if (days.length === 0)
            return { text: '', hits: [], days };
    }
    const found = [];
    for (const mt of listMemTypeDirs(proj)) {
        let db;
        try {
            db = DatabaseManager.getInstance(proj, mt);
        }
        catch {
            continue;
        }
        try {
            for (const day of days) {
                const rows = db.prepare(`
          SELECT id, text, importance
          FROM memory
          WHERE is_active = 1 AND project = ? AND character_id = ?
            AND source = 'daily_event'
            AND (text LIKE ? OR tags LIKE ?)
          ORDER BY importance DESC, updated_at DESC
          LIMIT 3
        `).all(proj, cid, `# ${day}%`, `%day:${day}%`);
                for (const row of rows) {
                    const parsed = parseEventText(row.text);
                    found.push({
                        id: String(row.id),
                        day: parsed.day || day,
                        title: parsed.title,
                        summary: parsed.summary,
                        importance: Number(row.importance) || 0,
                    });
                }
            }
        }
        catch { /* 该库没有这些表 */ }
    }
    if (found.length === 0)
        return { text: '', hits: [], days };
    // 同一天同一标题只留一条（事件行可能被重跑更新过）
    const seen = new Set();
    const exclude = new Set([...(options.excludeIds ?? [])].map(String));
    const picked = [];
    let chars = 0;
    for (const hit of found.sort((a, b) => b.importance - a.importance)) {
        // 主注入块已经给过这条，就不要在「按日期直取」段再念一遍（2026-11-01）。
        if (exclude.has(String(hit.id)))
            continue;
        const key = `${hit.day}\u0000${hit.title}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const line = `- [${hit.day}] ${hit.title}：${hit.summary}`;
        if (chars + line.length > maxChars)
            continue;
        picked.push(hit);
        chars += line.length;
        if (picked.length >= limit)
            break;
    }
    if (picked.length === 0)
        return { text: '', hits: [], days };
    const body = picked.map(h => `- [${h.day}] ${h.title}：${h.summary}`).join('\n');
    return {
        text: `以下是那几天记下的事（按日期直取，不是相似度匹配）：\n${body}`,
        hits: picked,
        days,
    };
}
//# sourceMappingURL=temporalRecall.js.map