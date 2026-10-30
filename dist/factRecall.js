/**
 * 事实路注入：把 facts 表里"已经确认过的稳定事实"带进本轮上下文。
 *
 * 为什么需要这一路（2026-10-29）：
 * 反刍抽出来的事实落在 `facts` 表里（subject=user/agent，predicate=习惯/喜好/关系/姓名/目标/承诺…），
 * 但注入路径只读 memory 表 —— 事实只有被改写成摘要行之后才可能被召回。实测库里 76 条事实、
 * 76 个实体完全没有参与注入（对应 Zep 的 +18.5%、HippoRAG 的多跳：图/事实路由是独立一路）。
 *
 * 为什么不按实体名匹配：实测本库 `entities.name` 是一整句话（"会主动寻求情感联系，常询问想念"），
 * 用户问句里几乎不可能出现。真正稳定的是"谓词"，所以这里是**谓词触发 + 人称触发**，
 * 而不是硬套别的系统的实体链接。
 *
 * 门槛（宁缺勿滥）：问句必须同时(a)提到我/你, (b)命中谓词词表；然后只取
 * valid_to IS NULL 且未被推翻(superseded_by IS NULL) 的事实，按 confidence 取前 N 条。
 * 8 条噪音问句因此一条都进不来（它们不含这类谓词），实测见 eval_injection。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { CHAR_ID, normalizeProject } from './env.js';
/** 问句 -> 谓词族。命中任一即认为"在问关于人/关系的稳定事实" */
const PREDICATE_TRIGGERS = [
    { family: ['习惯', '作息', '规律'], hit: /习惯|作息|规律|一般几点|每天都/ },
    { family: ['喜好', '偏好', '喜欢'], hit: /喜欢|偏好|爱好|爱吃|讨厌|不喜欢/ },
    { family: ['关系', '感情'], hit: /关系|我们|感情|对我|亲近|疏远/ },
    { family: ['姓名', '名字', '称呼'], hit: /名字|叫什么|怎么称呼|生日|是谁/ },
    { family: ['职业', '工作', '技能'], hit: /工作|职业|做什么的|会什么|擅长|技能/ },
    { family: ['目标', '计划'], hit: /目标|计划|打算|想要什么|愿望/ },
    { family: ['承诺', '约定'], hit: /答应|承诺|约定|说好|保证/ },
    { family: ['健康', '身体'], hit: /身体|健康|病|疼|牙|睡|失眠/ },
    { family: ['身份'], hit: /身份|你是谁|你是什么/ },
];
/** 问句必须指向"人"，否则不触发（避免"帮我写个快速排序"这类任务句） */
const PERSON_HINT = /我|你|咱|自己/;
function familiesFor(query) {
    const q = String(query || '');
    if (!PERSON_HINT.test(q))
        return [];
    const out = new Set();
    for (const t of PREDICATE_TRIGGERS)
        if (t.hit.test(q))
            out.add(t.family[0]);
    return [...out];
}
/**
 * 取本轮要注入的事实。纯本地查询，不调 LLM、不算向量，所以它可以在 300ms 的注入预算里跑。
 */
export function recallFactsForQuery(query, options = {}) {
    const empty = { text: '', facts: [], chars: 0, families: [] };
    const families = familiesFor(query);
    if (families.length === 0)
        return empty;
    const proj = normalizeProject(options.project);
    const cid = options.characterId || CHAR_ID;
    const limit = Math.max(1, Math.min(options.limit ?? 4, 8));
    const maxChars = options.maxChars ?? 420;
    const collected = [];
    const placeholders = families.map(() => '?').join(',');
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
        SELECT id, subject, predicate, object, confidence, COALESCE(updated_at, created_at) AS updated_at
        FROM facts
        WHERE is_active = 1
          AND valid_to IS NULL
          AND (superseded_by IS NULL OR superseded_by = '')
          AND project = ?
          AND (character_id = ? OR character_id IS NULL)
          AND predicate IN (${placeholders})
        ORDER BY confidence DESC, updated_at DESC
        LIMIT ?
      `).all(proj, cid, ...families, limit * 3);
            for (const row of rows) {
                const text = String(row.object || '').trim();
                if (!text)
                    continue;
                collected.push({
                    id: String(row.id),
                    subject: String(row.subject || ''),
                    predicate: String(row.predicate || ''),
                    object: text,
                    confidence: Number(row.confidence) || 0,
                    updatedAt: String(row.updated_at || ''),
                });
            }
        }
        catch { /* 该分类库没有 facts 表:跳过 */ }
    }
    if (collected.length === 0)
        return { ...empty, families };
    // 去重（同一 subject+predicate+object 只会出现一次），再按置信度取前 N，最后守字数预算。
    const seen = new Set();
    const picked = [];
    let chars = 0;
    for (const fact of collected.sort((a, b) => b.confidence - a.confidence)) {
        const key = `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const line = renderLine(fact);
        if (chars + line.length > maxChars)
            continue;
        picked.push(fact);
        chars += line.length;
        if (picked.length >= limit)
            break;
    }
    if (picked.length === 0)
        return { ...empty, families };
    const body = picked.map(renderLine).join('\n');
    const text = `以下是已经确认过的稳定事实（不是本轮对话内容，与你的人设冲突时以人设为准）：\n${body}`;
    return { text, facts: picked, chars: text.length, families };
}
function renderLine(fact) {
    const who = fact.subject === 'agent' ? '她' : fact.subject === 'user' ? '用户' : fact.subject;
    return `- ${who}·${fact.predicate}：${fact.object}（conf ${fact.confidence.toFixed(2)}）`;
}
//# sourceMappingURL=factRecall.js.map