/**
 * 事件摘要层（P2）：把一天的对话压成"发生了什么"，但**只摘录、不改写**。
 *
 * 外部依据（2026-10-29 调研）：
 * - Anthropic memory tool：记忆是客户端文件目录 + 按需取回；压缩后原文从磁盘重新加载
 *   —— 原文是本体，摘要只是视图。
 * - ACE (arXiv 2510.04618)：迭代摘要的两个病是 brevity bias（丢领域细节）与 context collapse
 *   （反复改写侵蚀细节），解法是结构化**增量**更新，不是整段重写。
 * - transparent-compact (arXiv 2610.20116)：保证用户/助手原话不被模型或算法改写，并显式标出
 *   压缩掉了什么。
 * - Compaction as Epistemic Failure (arXiv 2607.13071)：摘要会把"观察到的"写成"已确认的"，
 *   于是一次误读被后续所有会话当成事实 —— 所以推测必须与引述分栏。
 *
 * 因此本模块的硬规则：
 * 1. 每条事件必须带**逐字摘录**（用户/她各一段，用「」）；摘录在系统侧做子串校验，编造的丢弃。
 * 2. 只有一个"一句话事件"是模型的表述，明确标为概述，且必须由摘录支撑。
 * 3. 带 `来源: rowid` —— 任何一条都能回到原文；原文永不删除、永不被本模块改写。
 * 4. 未被摘要的对话计数（skipped）要如实返回，不允许"悄悄忘掉"。
 * 5. 不重写历史事件条目：同一天重复跑按 (day, title) 更新，而不是新增一条平行版本。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { saveMemory } from './store.js';
import { CHAR_ID, normalizeProject } from './env.js';
import { callLlm, makeLlmChannel, parseJsonRobust } from './reflectionLlm.js';
import { localDayOf } from './dayKey.js';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_digest_progress (
  conversation_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  day TEXT NOT NULL,
  digested_at DATETIME NOT NULL
)`;
const SYSTEM_PROMPT = `你是记忆整理员。任务：把某一天的对话流水整理成"那天发生了什么"。

【硬规则，违反即作废】
1. 每个事件必须给两段**逐字摘录**：userQuote 与 assistantQuote，直接从流水里照抄（不要改写、不要补字、不要合并两句）。
   流水格式为 "用户: ..." / "助手: ..."，用「」包住你要引用的原句。
2. 只记录**用户自己说出的事实/计划/情绪**，以及**她明确答应过的事**。她回忆或复述的内容不算新事实。
3. 不确定的内容不许写进 events；把"用户提到但没说清"的放进 looseEnds。
4. 寒暄("早上好"/"收到"/"嗯")、寒暄式关心、纯任务性操作不产生事件。
5. 一天最多 ${'{maxEvents}'} 条事件；没有值得记的就返回空数组，不要凑数。

输出严格 JSON（不要代码块）：
{"events":[{"title":"≤16字事件标题","summary":"一句话：谁做了什么、结果如何","userQuote":"从用户原话逐字摘录","assistantQuote":"从她原话逐字摘录","people":["用户"],"looseEnds":["未说完/待跟进的事"],"confidence":0.0-1.0}],"skipped":0}
`;
function ensure(db) {
    try {
        db.exec(SCHEMA);
    }
    catch { /* 已存在 */ }
}
function dayOf(iso) {
    // 必须按本地日历日分桶：created_at 是 UTC ISO，切前 10 位在 UTC+8 会把本地
    // 00:00–08:00 的对话算进前一天（2026-10-29T17:03Z = 本地 10-30 01:03），
    // 而「今天/昨天」问句走的是本地日 —— 两套口径错开就查不到（见 dayKey.ts）。
    return localDayOf(iso);
}
/** 摘录必须真的出现在原文里（子串校验，去掉「」与空白后比对） */
function quoteIsReal(quote, haystack) {
    const q = String(quote || '').replace(/[「」"\s]/g, '');
    if (q.length < 4)
        return false;
    return haystack.replace(/\s/g, '').includes(q);
}
/**
 * progress 该记哪些对话（纯函数，便于钉死）。
 * - 这一天没出错：整天都算整理过（模型说"没什么可记"也是有效结论）。
 * - 出了错且有对话被覆盖：只记被覆盖的，其余留待下一轮重试。
 * - 出了错但一条都没覆盖：仍记整天 —— 空集会让同一批原料每轮重烧 token，而错误已在日志里。
 */
export function progressIdsToMark(dayRows, dayFailed, covered) {
    if (!dayFailed || covered.size === 0)
        return dayRows;
    return dayRows.filter(r => covered.has(r.id));
}
export async function runEventDigest(options = {}) {
    const proj = normalizeProject(options.project);
    const cid = options.characterId || CHAR_ID;
    const days = Math.max(1, Math.min(options.days ?? 2, 14));
    const limit = Math.max(1, Math.min(options.limit ?? 80, 300));
    const maxEventsPerDay = Math.max(1, Math.min(options.maxEventsPerDay ?? 4, 8));
    const empty = {
        ok: false, days, conversations: 0, events: 0, inserted: 0, updated: 0, skipped: 0, errors: [],
    };
    const channel = makeLlmChannel('triage');
    if (!channel.apiKey)
        return { ...empty, skippedReason: '未配置 triage/reflect LLM' };
    const db = DatabaseManager.getInstance(proj);
    ensure(db);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const rows = [];
    for (const mt of listMemTypeDirs(proj)) {
        let dbi;
        try {
            dbi = DatabaseManager.getInstance(proj, mt);
        }
        catch {
            continue;
        }
        // 进度表要建在**每个**分类库里：JOIN 一张不存在的表会抛 no such table，
        // 而下面的 catch 为"该库没有这些表"准备 —— 结果是那个库里的对话被静默跳过、永远不整理。
        ensure(dbi);
        try {
            const found = dbi.prepare(`
        SELECT m.id, m.text, m.created_at
        FROM memory m
        LEFT JOIN event_digest_progress p ON p.conversation_id = m.id
        WHERE m.source = 'conversation_log' AND m.is_active = 1 AND m.project = ?
          AND m.character_id = ? AND m.created_at >= ? AND p.conversation_id IS NULL
        ORDER BY m.created_at ASC
        LIMIT ?
      `).all(proj, cid, cutoff, limit);
            rows.push(...found);
        }
        catch { /* 该库没有这些表:跳过 */ }
    }
    if (rows.length === 0)
        return { ...empty, ok: true, skippedReason: '没有待整理的对话' };
    // 按天分桶
    const byDay = new Map();
    for (const row of rows) {
        const day = dayOf(row.created_at);
        if (!byDay.has(day))
            byDay.set(day, []);
        byDay.get(day).push(row);
    }
    const result = { ...empty, ok: true, conversations: rows.length };
    let inserted = 0, updated = 0, events = 0, skippedTotal = 0;
    // 必须给比较器：默认 sort 会把 [day, rows] 转字符串，行里含对象直接抛
    // "Cannot convert object to primitive value"（实测踩过）。
    for (const [day, dayRows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const transcript = dayRows.map(r => `[${r.id.slice(0, 8)}] ${r.text}`).join('\n\n');
        const system = SYSTEM_PROMPT.replace('${maxEvents}', String(maxEventsPerDay));
        const user = `【日期】${day}\n【对话流水】\n${transcript.slice(0, 12000)}`;
        const llm = await callLlm(system, user, channel, 4096).catch(() => null);
        if (!llm) {
            result.errors.push(`${day}: LLM 调用失败`);
            continue;
        }
        const parsed = parseJsonRobust(llm.content);
        if (!parsed || !Array.isArray(parsed.events)) {
            result.errors.push(`${day}: 输出解析失败`);
            continue;
        }
        const haystack = dayRows.map(r => r.text).join('\n');
        /** 来源只取真正包含这条摘录的流水行 —— 全天所有 id 都挂上去等于没来源。
         *  写的是 **conversation id 的前 8 位**（UUID 前缀足够唯一），回查用 `id LIKE 'xxxxxxxx%'`；
         *  不是 rowid：rowid 在每个 memType 库里各自从 1 开始，跨库不唯一。 */
        const sourcesFor = (quote) => {
            const q = String(quote || '').replace(/[「」"\s]/g, '');
            if (q.length < 4)
                return [];
            return dayRows.filter(r => r.text.replace(/\s/g, '').includes(q)).map(r => r.id.slice(0, 8));
        };
        /** 真正被事件覆盖到的对话 id：progress 只该记这些，不该把整天一股脑标成已整理 */
        const consumedIds = new Set();
        const covers = (quote) => {
            const q = String(quote || '').replace(/[「」"\s]/g, '');
            if (q.length < 4)
                return;
            for (const r of dayRows)
                if (r.text.replace(/\s/g, '').includes(q))
                    consumedIds.add(r.id);
        };
        let kept = 0;
        for (const ev of parsed.events.slice(0, maxEventsPerDay)) {
            const title = String(ev?.title || '').trim();
            const summary = String(ev?.summary || '').trim();
            const userQuote = String(ev?.userQuote || '').trim();
            const assistantQuote = String(ev?.assistantQuote || '').trim();
            // 摘录校验：编造的直接丢（和 extract 的 quotes 校验同一原则）
            if (!title || !summary) {
                result.errors.push(`${day}: 事件缺标题/概述`);
                continue;
            }
            if (!quoteIsReal(userQuote, haystack)) {
                result.errors.push(`${day}: 用户摘录与原文不符「${userQuote.slice(0, 20)}」`);
                continue;
            }
            const loose = Array.isArray(ev?.looseEnds) ? ev.looseEnds.map((x) => String(x).trim()).filter(Boolean) : [];
            const people = Array.isArray(ev?.people) ? ev.people.map((x) => String(x).trim()).filter(Boolean) : [];
            const confidence = Math.max(0, Math.min(Number(ev?.confidence) || 0.6, 1));
            const text = [
                `# ${day} · ${title}`,
                summary,
                userQuote ? `摘录（用户）：「${userQuote}」` : '',
                quoteIsReal(assistantQuote, haystack) ? `摘录（她）：「${assistantQuote}」` : '',
                people.length ? `人物: ${people.join(' / ')}` : '',
                loose.length ? `未完: ${loose.join('；')}` : '',
                `来源: ${[...new Set([...sourcesFor(userQuote), ...sourcesFor(assistantQuote)])].join(',')}`,
            ].filter(Boolean).join('\n');
            const existing = db.prepare(`
        SELECT id FROM memory WHERE project = ? AND source = 'daily_event' AND is_active = 1
          AND character_id = ? AND text LIKE ?
        LIMIT 1
      `).get(proj, cid, `# ${day} · ${title}%`);
            if (options.dryRun) {
                kept++;
                continue;
            }
            // 必须走引擎的写入路径：只有它会算向量与片段索引。
            // 第一版直接 INSERT，结果事件行「查不到」—— 没有向量就等于不存在。
            if (existing) {
                // 内容变了就软删旧行再写新的（旧的向量相对于新文本已经失效）
                db.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?')
                    .run(new Date().toISOString(), existing.id);
                updated++;
            }
            else {
                inserted++;
            }
            await saveMemory({
                text,
                project: proj,
                memType: 'general',
                type: 'episodic',
                category: 'event',
                tags: [`day:${day}`],
                importance: confidence,
                characterId: cid,
                source: 'daily_event',
                subject: 'user',
                tier: 'standard',
            });
            covers(userQuote);
            covers(assistantQuote);
            kept++;
        }
        events += kept;
        const modelSkipped = Number(parsed.skipped) || 0;
        skippedTotal += modelSkipped;
        if (!options.dryRun) {
            const now = new Date().toISOString();
            const mark = db.prepare('INSERT OR REPLACE INTO event_digest_progress (conversation_id, project, day, digested_at) VALUES (?, ?, ?, ?)');
            // progress 的记账粒度 = "真正被事件覆盖到的对话"，不是整天的行。
            // 事件因摘录校验/写入失败被丢时（errors 里有这天的记录）：只标记已被接受事件覆盖的那些对话，
            // 其余留到下一轮重试 —— 否则一次模型打偏就把那批原料永久标成"已整理"、再也回不来。
            // 全天一条都没保住（covered 为空）时不收缩：空集标记等于每轮重烧同一批 token，而日志已记下错误。
            const dayFailed = result.errors.some(e => e.startsWith(`${day}:`));
            const toMark = progressIdsToMark(dayRows, dayFailed, consumedIds);
            if (dayFailed && toMark.length < dayRows.length) {
                result.errors.push(`${day}: 仅 ${toMark.length}/${dayRows.length} 条对话被事件覆盖，其余留待重试`);
            }
            for (const row of toMark)
                mark.run(row.id, proj, day, now);
        }
    }
    result.events = events;
    result.inserted = inserted;
    result.updated = updated;
    result.skipped = skippedTotal;
    return result;
}
//# sourceMappingURL=eventDigest.js.map