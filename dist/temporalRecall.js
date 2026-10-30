/**
 * 时间路注入：问句里出现"昨天/今天/最近"时，直接取那几天的记录，不靠余弦。
 *
 * 为什么不能靠相似度（2026-10-30 实测）：事件行已经写了向量索引，但「我昨天在忙什么」这种问句
 * 与人设长文的相似度更高（lore 0.706 vs 事件行 ~0.5），事件行连 top-12 都进不去。
 * 人查"昨天做了什么"会直接翻昨天那一页，不会去算语义距离 —— 这一路也一样：按日期直取。
 *
 * 门槛：只有问句真的带时间词才触发；只取事件层（source='daily_event'）与当天摘要，不翻原文，
 * 避免把一整天的对话流水灌进上下文。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { CHAR_ID, normalizeProject } from './env.js';
import { temporalDaysOf } from './recallForInjection.js';
/** 事件行正文的第一行是 `# YYYY-MM-DD · 标题`，第二行是一句话概述 */
function parseEventText(text) {
    const lines = String(text).split('\n');
    const head = (lines[0] || '').replace(/^#\s*/, '');
    const m = head.match(/^(\d{4}-\d{2}-\d{2})\s*[·:：-]?\s*(.*)$/);
    if (m)
        return { day: m[1], title: (m[2] || '').trim(), summary: (lines[1] || '').trim() };
    return { day: '', title: head.slice(0, 24), summary: (lines[1] || '').trim() };
}
export function recallTemporalForQuery(query, options = {}) {
    const days = [...temporalDaysOf(String(query || ''))];
    if (days.length === 0)
        return { text: '', hits: [], days };
    const proj = normalizeProject(options.project);
    const cid = options.characterId || CHAR_ID;
    const limit = Math.max(1, Math.min(options.limit ?? 4, 8));
    const maxChars = options.maxChars ?? 480;
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
            AND source IN ('daily_event', 'reflect_summary')
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
    const picked = [];
    let chars = 0;
    for (const hit of found.sort((a, b) => b.importance - a.importance)) {
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