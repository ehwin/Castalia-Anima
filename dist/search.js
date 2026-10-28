/**
 * Memory Search — v5.2 情感锚定评分(融合通用版分库检索)
 *
 * 哲学:情绪是记忆的锚,一致性是参考。
 * "像她"不是目标,"是她"才是——包括不像她的瞬间。
 *
 * 策略:
 *   1. 标签搜索(0 向量调用)→ 不够回退向量 KNN
 *   2. 评分:情绪强度为主(45%),一致性为辅(30%),时间衰减(15%),偏离加成(10%)
 *   3. 高情绪记忆(baseIntensity≥0.7)自动升级候选 + 衰减减半
 *
 * 保留通用版能力:按项目分库隔离(project 过滤)、memType 用途过滤、向量/文本回退。
 */
import { DatabaseManager, listProjectNames, listMemTypeDirs } from './db.js';
import { embed } from './ollama.js';
import { normalizeProject, isEmbedEnabled, CHAR_ID } from './env.js';
import { normalizeMemType } from './memType.js';
import { computeBiasBoost } from './bias.js';
import { computeDecay, computeBaseIntensity, computeRecency, isNightTime } from './emotion.js';
import { parseTagsSafe } from './tags.js';
// v1.28: tags 解码收敛到纯模块 src/tags.ts（零副作用、可被验收脚本单独加载）。
// 这里保留 re-export，历史 import { parseTagsSafe } from './search.js' 不会断。
export { parseTagsSafe };
// v5.2: 情绪锚定权重(可经环境变量调整)
const WEIGHT_CONSISTENCY = parseFloat(process.env.WEIGHT_CONSISTENCY || '0.30'); // 标签/语义匹配
const WEIGHT_EMOTION = parseFloat(process.env.WEIGHT_EMOTION || '0.45'); // 情感强度 — 主锚
const WEIGHT_TIME = parseFloat(process.env.WEIGHT_TIME || '0.15'); // 时间衰减
const WEIGHT_DEVIATION = parseFloat(process.env.WEIGHT_DEVIATION || '0.10'); // "不像她"的珍贵瞬间
// minScore 阈值可配;harness 可用 SEARCH_MIN_SCORE 覆盖
const SEARCH_PROFILES = {
    quick: { topK: 3, minScore: 0.6 },
    balanced: { topK: 5, minScore: parseFloat(process.env.SEARCH_MIN_SCORE || '0.15') },
    deep: { topK: 10, minScore: 0.1 },
};
/**
 * 情感强度 — 用 vad_valence/emotional_impact 计算
 * 优先 VAD 三维(经 computeDecay 衰减后的综合强度),无 VAD 回退 emotional_impact 标量。
 * baseIntensity 是事件本身的情绪烈度(永不变),isHighEmotion 判定"不像她"珍贵瞬间。
 */
function computeEmotionalIntensity(row) {
    const hasVAD = row.vad_valence != null;
    const storedVAD = hasVAD
        ? { valence: row.vad_valence, arousal: row.vad_arousal, dominance: row.vad_dominance }
        : null;
    const tsundereLvl = row.tsundere_level || 0;
    const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
    const decayed = computeDecay(storedVAD, hoursSinceCreated, tsundereLvl, isNightTime());
    const baseIntensity = storedVAD ? computeBaseIntensity(storedVAD) : Math.min(1, Math.abs(Number(row.emotional_impact) || 0) / 10);
    const emotionalIntensity = storedVAD ? decayed.intensity : baseIntensity;
    return { emotionalIntensity, baseIntensity, isHighEmotion: baseIntensity >= 0.7 };
}
/** 统一评分:一致性 + 情感强度(主锚) + 时间衰减 + 偏离加成,乘 bias/importance/tier/access */
function computeScore(row, similarity, project) {
    // v1.28: 时间衰减锚点用 last_accessed_at（缺失才回退 created_at）—— 回忆一次就刷新时钟。
    // 原来只认 created_at：半年前写下、昨天刚被反复用到的记忆，时间衰减分接近 0。
    const touchedAt = row.last_accessed_at || row.created_at;
    const hoursSinceTouched = (Date.now() - new Date(touchedAt).getTime()) / (1000 * 60 * 60);
    const { emotionalIntensity, isHighEmotion } = computeEmotionalIntensity(row);
    const consistency = Math.min(Math.max(similarity, 0), 0.7); // 上限 0.7,避免过度拟合人设
    const timeDecay = computeRecency(hoursSinceTouched);
    const deviationBonus = (similarity < 0.3 && isHighEmotion) ? 0.8 : 0; // 低一致性+高情绪=珍贵"不像她"瞬间
    const tierBoost = row.tier === 'critical' ? 3.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
    const importanceMult = 0.5 + (row.importance || 0.5);
    const accessBoost = 1 + Math.min(0.5, Math.log2(1 + (row.accessed_count || 0)) * 0.1);
    const memTags = parseTagsSafe(row.tags);
    const biasBoost = computeBiasBoost(row.character_id || '', memTags, project);
    const rawScore = WEIGHT_CONSISTENCY * consistency
        + WEIGHT_EMOTION * emotionalIntensity
        + WEIGHT_TIME * timeDecay
        + WEIGHT_DEVIATION * deviationBonus;
    const score = Math.round(rawScore * importanceMult * biasBoost * tierBoost * accessBoost * 1000) / 1000;
    return { score, biasBoost };
}
/**
 * 标签优先搜索 → 不足时回退向量 KNN
 */
/** 单库搜索主体(标签 → 向量 KNN → 文本回退),按分类库调用 */
async function searchInDb(db, options) {
    const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
    const topK = options.topK ?? profile?.topK ?? 10;
    const minScore = options.minScore ?? profile?.minScore ?? 0;
    // v1.24: 角色隔离 — 未显式指定 characterId 时按进程级 CHAR_ID 过滤(传 'any' 才关闭过滤)。
    // 三条检索路径(标签/向量/文本回退)共用这里的 scoped,避免只堵住一条路。
    const cid = options.characterId ?? CHAR_ID;
    const scoped = cid === 'any' ? { ...options, characterId: undefined } : { ...options, characterId: cid };
    // ═══ Phase 1: 标签搜索(0 次向量调用) ═══
    const tagResults = tagSearch(db, scoped);
    // 标签结果足够好 → 直接返回
    if (tagResults.length >= topK && tagResults[0].score >= 0.5) {
        updateAccessed(db, tagResults.slice(0, topK));
        return tagResults.slice(0, topK);
    }
    // ═══ Phase 2: 标签不够 → 向量 KNN 补充(EMBED_MODE=none 时跳过,纯文本回退) ═══
    const existingIds = new Set(tagResults.map(r => r.id));
    let vectorResults = [];
    if (isEmbedEnabled()) {
        let vecOk = false;
        try {
            const queryVector = await embed(scoped.query, scoped.project);
            const floatQuery = new Float32Array(queryVector);
            vectorResults = vectorKnnSearch(db, scoped, floatQuery, existingIds, topK, minScore);
            vecOk = true;
        }
        catch {
            vecOk = false;
        }
        // v1.28-fix(移植自 Lite 修 E6a):原来只在 embed/KNN **抛错**时回退。vec_memory 为空
        // (换模型清空后尚未补齐、维度刚重建、批量嵌入没跑)时 KNN 会"成功返回 0 行",
        // 于是嵌入服务明明健康却静默 0 命中。零命中同样要回退到文本检索。
        if (!vecOk || vectorResults.length === 0) {
            vectorResults = textFallbackSearch(db, scoped, existingIds, topK, minScore);
        }
    }
    else {
        // 纯本地模式:标签结果不足时直接文本回退
        vectorResults = textFallbackSearch(db, scoped, existingIds, topK, minScore);
    }
    // 合并 + 去重 + 排序
    const merged = [...tagResults, ...vectorResults];
    // v1.28 回指召回：查询在问"以前/之前/原来/上次说过什么"时，把被接管的旧记忆带
    // superseded 标记 + 降权加进候选池，参与同一次排序。非回指查询行为不变。
    if (isBackReferenceQuery(scoped.query)) {
        merged.push(...supersededRecall(db, scoped, new Set(merged.map(r => r.id)), Math.min(3, topK)));
    }
    merged.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of merged) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            unique.push(r);
        }
        if (unique.length >= topK)
            break;
    }
    updateAccessed(db, unique.slice(0, topK));
    return unique.slice(0, topK);
}
export async function searchMemory(options) {
    const proj = normalizeProject(options.project);
    const topK = options.topK ?? 10;
    // memdir:memType 指定 → 单分类库;未指定 → 聚合项目全部分类库
    const mtFilter = options.memType ? normalizeMemType(options.memType) : null;
    const dirs = mtFilter ? [mtFilter] : listMemTypeDirs(proj);
    const all = [];
    for (const mt of dirs) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            const r = await searchInDb(db, { ...options, project: proj });
            all.push(...r);
        }
        catch { /* 单分类库失败不影响其他 */ }
    }
    all.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of all) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            unique.push(r);
        }
        if (unique.length >= topK)
            break;
    }
    return unique.slice(0, topK);
}
/**
 * 跨库搜索(多项目合并,2026-08-16) — 显式语义:
 * 调用方明确指定要搜哪些库(projects),引擎不做隐式合并/共享魔法;
 * 互通规则由上层决定(接口先行)。结果按 score 降序,每行 project 标注来源库。
 * projects=['*'] 或 ['all'] → 本实例全部库(扫描 memory 目录)。
 */
export async function searchMemoryAcross(options) {
    const raw = (options.projects ?? []).map(x => (x ?? '').trim()).filter(Boolean);
    const targetProjects = raw.length === 0
        ? [normalizeProject(options.project)]
        : raw.some(x => x === '*' || x === 'all')
            ? listProjectNames()
            : raw.map(normalizeProject);
    const perProject = Math.max(3, Math.ceil((options.topK ?? 10) * 1.5));
    const all = [];
    for (const proj of targetProjects) {
        try {
            const r = await searchMemory({ ...options, project: proj, topK: perProject });
            all.push(...r);
        }
        catch {
            // 单个库失败不影响其他库
        }
    }
    all.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of all) {
        if (seen.has(r.id))
            continue;
        seen.add(r.id);
        unique.push(r);
    }
    return unique.slice(0, options.topK ?? 10);
}
// ═══════════════════════════════════════════════════════════════════
// 标签搜索 — 从 query 提取关键词，SQL tag LIKE 匹配
// ═══════════════════════════════════════════════════════════════════
const QUERY_STOP_WORDS = new Set(['的', '了', '是', '我', '你', '他', '她', '吗', '呢', '吧', '啊',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
    '有', '在', '不', '要', '会', '能', '就', '都', '也', '还', '和', '与', '这', '那', '什么', '怎么']);
/**
 * 检索词切分(2026-10-28):中文没有空格,整句会被切成一个超长 token,`text LIKE`/`tags LIKE`
 * 就永远匹配不到 —— 实测「你还记得自己是谁吗」召回 0 条,而「谕女 月食 127」召回 5 条。
 * 所以 CJK 连续段按 **bigram** 切分,其它语言仍按空白/标点切;词数封顶,避免 SQL 条件爆炸。
 */
export function queryTerms(query, max = 16) {
    const out = new Set();
    for (const raw of String(query ?? '').split(/[\s,，。！？、；：""''（）()\[\]【】\-\/\\|]+/)) {
        const seg = raw.trim();
        if (seg.length < 2)
            continue;
        if (!/[\u4e00-\u9fff]/.test(seg))
            out.add(seg);
        else
            for (let i = 0; i + 2 <= seg.length; i++)
                out.add(seg.slice(i, i + 2));
        if (out.size >= max)
            break;
    }
    return [...out].slice(0, max);
}
/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query) {
    return queryTerms(query).filter(t => !QUERY_STOP_WORDS.has(t.toLowerCase()));
}
/** SQL 标签搜索：匹配 memory.tags JSON 数组 */
function tagSearch(db, options) {
    const keywords = extractKeywords(options.query);
    if (keywords.length === 0)
        return [];
    const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
    const topK = options.topK ?? profile?.topK ?? 10;
    const project = normalizeProject(options.project);
    const tagCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
    const tagParams = keywords.map(k => `%"${k}"%`);
    const looseCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
    const looseParams = keywords.map(k => `%${k}%`);
    // v1.23-fix: superseded 在三条检索路径上一致排除（被接管的旧记忆不该再被检索命中）
    const conditions = ['m.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') <> 'superseded'"];
    const params = [project];
    conditions.push(`((${tagCond}) OR (${looseCond}))`);
    params.push(...tagParams, ...looseParams);
    if (options.type) {
        conditions.push('m.type = ?');
        params.push(options.type);
    }
    if (options.memType) {
        conditions.push('m.mem_type = ?');
        params.push(options.memType);
    }
    if (options.category) {
        conditions.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        // includeGeneral: 读取路径(提示里的索引 + read 工具)给角色看的是"自己的 + owner 共享的"，
        // 任何按相关性取内容的调用方都要开它才跟读取路径一致。默认关：维护类调用严格按角色隔离。
        conditions.push(options.includeGeneral
            ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
            : 'm.character_id = ?');
        params.push(options.characterId);
    }
    if (options.subject) {
        conditions.push('m.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.parent_id,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT ?
  `).all(...params, topK * 3);
    return rows.map(row => {
        const memTags = parseTagsSafe(row.tags);
        const matchedTags = keywords.filter(k => memTags.some((t) => t.toLowerCase().includes(k.toLowerCase()))).length;
        // 标签是人工挑的词:命中 1 个就已经是强信号,不能拿问句词数当分母(自然问句会被切成
        // 6~8 个 bigram,1/6=0.167 反而被判成"不够像")。分母封顶 3(2026-10-28)。
        const tagScore = Math.min(1.0, matchedTags / Math.max(1, Math.min(keywords.length, 3)));
        const { score, biasBoost } = computeScore(row, tagScore, project);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: memTags,
            emotionalImpact: row.emotional_impact ?? 0,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
            tier: row.tier || 'standard',
            parentId: row.parent_id || null,
            score, similarity: Math.round(tagScore * 1000) / 1000, basis: 'tag',
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
        };
    });
}
/** 向量 KNN 搜索 */
function vectorKnnSearch(db, options, floatQuery, excludeIds, topK, minScore) {
    // v1.5: vec0 虚拟表禁止 JOIN(KNN 必须在 vec0 上 LIMIT),项目过滤放在第二段 memory 查询
    // 候选集放大(全库 KNN)保证单项目召回;隔离语义由 memory 查询的 project=? 保证
    const knnLimit = Math.min(topK * 8, 60);
    const project = normalizeProject(options.project);
    let knnRows;
    try {
        knnRows = db.prepare(`
      SELECT rowid, distance FROM vec_memory
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(floatQuery, knnLimit);
    }
    catch {
        return [];
    }
    if (knnRows.length === 0)
        return [];
    const rowidMap = new Map();
    for (const r of knnRows)
        rowidMap.set(Number(r.rowid), r.distance);
    const rowidPlaceholders = knnRows.map(() => '?').join(',');
    const rowidParams = knnRows.map(r => Number(r.rowid));
    const conditions = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') <> 'superseded'"];
    const params = [...rowidParams, project];
    if (options.type) {
        conditions.push('m.type = ?');
        params.push(options.type);
    }
    if (options.memType) {
        conditions.push('m.mem_type = ?');
        params.push(options.memType);
    }
    if (options.category) {
        conditions.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        // includeGeneral: 读取路径(提示里的索引 + read 工具)给角色看的是"自己的 + owner 共享的"，
        // 任何按相关性取内容的调用方都要开它才跟读取路径一致。默认关：维护类调用严格按角色隔离。
        conditions.push(options.includeGeneral
            ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
            : 'm.character_id = ?');
        params.push(options.characterId);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.rowid, m.parent_id,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m WHERE ${conditions.join(' AND ')}
  `).all(...params);
    const results = [];
    for (const row of rows) {
        if (excludeIds.has(row.id))
            continue;
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = Math.max(0, 1.0 - dist);
        const { score, biasBoost } = computeScore(row, similarity, project);
        if (score >= minScore) {
            results.push({
                id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
                subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
                emotionalImpact: row.emotional_impact ?? 0,
                importance: row.importance,
                characterId: row.character_id, source: row.source,
                subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
                tier: row.tier || 'standard',
                parentId: row.parent_id || null,
                score, similarity: Math.round(similarity * 1000) / 1000,
                createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
                accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
            });
        }
    }
    return results;
}
/** 文本回退搜索(向量不可用时) */
function textFallbackSearch(db, options, excludeIds, topK, minScore) {
    const terms = queryTerms(options.query);
    if (terms.length === 0)
        return [];
    const project = normalizeProject(options.project);
    // bigram 会带出「记得」「自己」这类高频词,却也正因为如此,短问句往往只共享 1 个 bigram
    // ("你母亲是怎么死的" 与行文只共享「母亲」)。所以这里**召回优先**:命中 ≥1 词就进候选,
    // 精度交给排序 —— 命中词多的排前面(ORDER BY 命中数 DESC),而不是把候选直接丢掉。
    // 之前试过 need=2,结果自然问句又变成 0 条,等于没修(2026-10-28)。
    // 标题也参与匹配(2026-10-28):标题短而具体("三年前那笔交易:我换掉了看见命运的能力"),
    // 把正文里的长句意涵提到了命中的第一线。只匹配正文时,问"你为什么看不见命运了"要命的那条
    // 排不进 top5 —— 同分全靠 created_at 决,等于随机。
    const haystack = `(COALESCE(m.title, '') || ' ' || m.text)`;
    const matchExpr = `(${terms.map(() => `CASE WHEN ${haystack} LIKE ? THEN 1 ELSE 0 END`).join(' + ')})`;
    const likeParams = terms.map(t => `%${t}%`);
    const conds = [`m.is_active = 1`, `m.project = ?`, "COALESCE(m.status, '') <> 'superseded'", `${matchExpr} >= 1`];
    const params = [project, ...likeParams];
    if (options.memType) {
        conds.push('m.mem_type = ?');
        params.push(options.memType);
    }
    if (options.type) {
        conds.push('m.type = ?');
        params.push(options.type);
    }
    if (options.category) {
        conds.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        conds.push(options.includeGeneral
            ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
            : 'm.character_id = ?');
        params.push(options.characterId);
    }
    if (options.subject) {
        conds.push('m.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.parent_id,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m
    WHERE ${conds.join(' AND ')}
    ORDER BY (${terms.map(() => `CASE WHEN ${haystack} LIKE ? THEN 1 ELSE 0 END`).join(' + ')}) DESC, m.created_at DESC
    LIMIT ?
  `).all(...params, ...likeParams, topK * 2);
    return rows
        .filter(row => !excludeIds.has(row.id))
        .map(row => {
        // 2026-10-28: 原来这里硬写 similarity: 0.3,而注入门槛是 0.5(向量余弦量纲) ——
        // 于是没向量时**每一条文本命中都被当成"不够像"丢掉**,她的记忆一条也进不了提示词。
        // 改成真实词法覆盖率:命中词数 / min(词数, 4)(分母封顶 4,长问句的 bigram 数会虚高,
        // 否则「你母亲是怎么死的」这种只共享一个词的问句永远过不了线)。
        const lower = `${String(row.title || '')} ${String(row.text || '')}`.toLowerCase();
        const matched = terms.reduce((n, t) => n + (lower.includes(t.toLowerCase()) ? 1 : 0), 0);
        const lexSim = Math.min(1, matched / Math.min(terms.length, 4));
        const { score, biasBoost } = computeScore(row, lexSim, project);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
            emotionalImpact: row.emotional_impact ?? 0,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
            tier: row.tier || 'standard',
            parentId: row.parent_id || null,
            score, similarity: Math.round(lexSim * 1000) / 1000, basis: 'lexical',
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
        };
    });
}
/**
 * v1.28 回指查询：用户在问"以前/之前/原来/当时/上次说过什么"。
 *
 * 这条判据是 v1.23-fix「被接管的旧记忆不该再被检索命中」与 RoMem「不删除只降权」
 * 之间那个语义矛盾的裁决点：默认不返回（接管的旧记忆与接管它的新记忆内容重复，
 * 同一条历史讲两遍会污染上下文）；用户明确回指时相反 —— 那时"当时的说法"就是答案本身。
 */
const BACK_REFERENCE_PATTERN = /以前|之前|原来|当时|上次|上回|早先|曾经|说过|提过|讲过|不是说过|previously|earlier|used to|back then|you said|i said|last time/i;
export function isBackReferenceQuery(query) {
    return BACK_REFERENCE_PATTERN.test(String(query ?? ''));
}
/** 被接管旧记忆的降权系数：低于任何正常命中，但不为零（可见、可解释，不与新记忆同权竞争） */
export const SUPERSEDED_PENALTY = 0.6;
/** metadata.supersededBy 可能是字符串或数组；解析失败返回 undefined（不是空数组）。 */
function readSupersededBy(metadata) {
    if (typeof metadata !== 'string' || metadata.length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(metadata);
        const raw = parsed?.supersededBy;
        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
        const ids = list.map(String).filter(Boolean);
        return ids.length > 0 ? ids : undefined;
    }
    catch {
        return undefined;
    }
}
/** 回指召回：带 superseded 标记 + 降权返回被接管的旧记忆。 */
function supersededRecall(db, options, excludeIds, limit) {
    if (limit <= 0)
        return [];
    const terms = String(options.query || '').split(/[\s,，。！？、；：]+/).filter(t => t.length >= 2);
    if (terms.length === 0)
        return [];
    const project = normalizeProject(options.project);
    const likeCond = terms.map(() => 'm.text LIKE ?').join(' OR ');
    const conds = ['m.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') = 'superseded'", `(${likeCond})`];
    const params = [project, ...terms.map(t => `%${t}%`)];
    if (options.characterId) {
        conds.push(options.includeGeneral
            ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
            : 'm.character_id = ?');
        params.push(options.characterId);
    }
    if (options.memType) {
        conds.push('m.mem_type = ?');
        params.push(options.memType);
    }
    let rows = [];
    try {
        rows = db.prepare(`
      SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
        m.emotional_impact, m.importance, m.character_id, m.source,
        m.subject, m.agent_mood, m.agent_desire, m.tier, m.metadata,
        m.created_at, m.last_accessed_at, m.accessed_count, m.parent_id,
        m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
      FROM memory m
      WHERE ${conds.join(' AND ')}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(...params, limit);
    }
    catch {
        return [];
    }
    return rows
        .filter(row => !excludeIds.has(row.id))
        .map((row) => {
        const { score, biasBoost } = computeScore(row, 0.3, project);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
            emotionalImpact: row.emotional_impact ?? 0,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
            tier: row.tier || 'standard',
            parentId: row.parent_id || null,
            score: Math.round(score * SUPERSEDED_PENALTY * 1000) / 1000,
            similarity: 0.3, basis: 'lexical',
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
            superseded: true,
            supersededBy: readSupersededBy(row.metadata),
        };
    });
}
/** 更新记忆访问计数 */
function updateAccessed(db, results) {
    if (results.length === 0)
        return;
    try {
        // v1.23 冷存回温：被检索命中即回到工作集（清掉 status='cold'）。
        // 否则"冷"会变成永久标记 —— 经常被用的记忆反而永远被排除在新沉淀之外。
        const stmt = db.prepare("UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ?, status = CASE WHEN status = 'cold' THEN NULL ELSE status END WHERE id = ?");
        const now = new Date().toISOString();
        const tx = db.transaction((ids) => { for (const id of ids)
            stmt.run(now, id); });
        tx(results.map(r => r.id));
    }
    catch { }
}
/**
 * v1.23 Parent-Child 原文回捞 —— 命中的是提炼记忆(leaf)，按 parent_id 取对话原文。
 * 合并策略照 llama_index AutoMergingRetriever：同父命中比例 > 50% 或 parent 本来就短 → 整段；
 * 否则只给命中片段。总预算 3000 字符 / 最多 3 个 parent，避免把上下文吃满。
 *
 * 与 Full 现网实现的差异（修其"永远从 0 截断"缺陷）：excerpt 先用该 leaf 的 text 前 40 字符
 * 在 parent 里 indexOf 定位锚点，窗口取锚点前 400 后 800；定位失败才退回开头并标 mode='head'。
 */
export function hydrateParentExcerpts(project, related, opts = {}) {
    const proj = normalizeProject(project);
    const cid = opts.characterId ?? CHAR_ID;
    if (!related || related.length === 0)
        return [];
    let budget = opts.budget ?? 3000;
    const maxParents = opts.maxParents ?? 3;
    const out = [];
    try {
        // 每个 parent 收集命中次数 + 可用于定位的样本（leaf 正文）
        const hitsByParent = new Map();
        for (const m of related) {
            if (!m.parentId)
                continue;
            const entry = hitsByParent.get(m.parentId) || { hits: 0, samples: [] };
            entry.hits++;
            if (entry.samples.length < 3 && m.text)
                entry.samples.push(String(m.text));
            hitsByParent.set(m.parentId, entry);
        }
        for (const [pid, hit] of [...hitsByParent.entries()].slice(0, maxParents)) {
            if (budget <= 0)
                break;
            const row = DatabaseManager.queryAll(proj, 'SELECT id, text FROM memory WHERE id = ? AND project = ? AND character_id = ?', [pid, proj, cid])[0];
            if (!row || !row.text)
                continue;
            const parentText = String(row.text);
            // 分母只算活跃 leaf：已停用/被接管的 leaf 不该把"同父命中比"拉低
            const totalLeaves = DatabaseManager.queryAll(proj, 'SELECT COUNT(*) AS c FROM memory WHERE parent_id = ? AND project = ? AND is_active = 1 AND character_id = ?', [pid, proj, cid])
                .reduce((n, r) => n + (Number(r.c) || 0), 0) || 1;
            const ratio = hit.hits / totalLeaves;
            const full = ratio > 0.5 || parentText.length <= 1800;
            let excerpt;
            let mode;
            if (full) {
                excerpt = parentText.slice(0, Math.min(2500, budget));
                mode = 'full';
            }
            else {
                let anchor = -1;
                for (const sample of hit.samples) {
                    const probe = String(sample || '').replace(/\s+/g, ' ').trim().slice(0, 40);
                    if (probe.length < 8)
                        continue;
                    anchor = parentText.indexOf(probe);
                    if (anchor >= 0)
                        break;
                }
                if (anchor < 0) {
                    excerpt = parentText.slice(0, Math.min(1600, budget));
                    mode = 'head';
                }
                else {
                    const start = Math.max(0, anchor - 400);
                    const end = Math.min(parentText.length, anchor + 800, start + Math.max(0, budget));
                    excerpt = parentText.slice(start, Math.max(start, end));
                    mode = 'excerpt';
                }
            }
            out.push({ parentId: pid, excerpt, mode, ratio: Math.round(ratio * 100) / 100 });
            budget -= excerpt.length;
        }
    }
    catch { /* 回捞失败不影响主流程 */ }
    return out;
}
/**
 * 快速获取近期重要记忆(用于请求前注入，<5ms)
 * 不做向量搜索，直接按时间+importance 捞
 */
export function getRecentMemories(characterId, limit = 5, hoursBack = 24, project, memType) {
    const proj = normalizeProject(project);
    // memdir:memType 指定 → 单分类库;未指定 → 聚合项目全部分类库
    const dirs = memType ? [normalizeMemType(memType)] : listMemTypeDirs(proj);
    const all = [];
    const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
    for (const mt of dirs) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            // v1.24: 角色隔离 — characterId='any' 才关闭过滤(默认由调用方传 CHAR_ID)
            const conds = ['is_active = 1', 'project = ?', 'created_at > ?', "COALESCE(status, '') <> 'superseded'"];
            const params = [proj, since];
            if (characterId && characterId !== 'any') {
                conds.push('character_id = ?');
                params.push(characterId);
            }
            if (memType) {
                conds.push('mem_type = ?');
                params.push(memType);
            }
            params.push(limit);
            const rows = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, emotional_impact, character_id, source, subject, tier,
               created_at, last_accessed_at, accessed_count
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(...params);
            all.push(...rows.map(row => ({
                id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
                subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
                importance: row.importance,
                emotionalImpact: row.emotional_impact ?? 0,
                agentMood: null, agentDesire: null, biasBoost: 0,
                characterId: row.character_id, source: row.source, subject: row.subject || 'user',
                tier: row.tier || 'standard',
                score: row.importance, similarity: 0,
                createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
                accessedCount: row.accessed_count,
            })));
        }
        catch { /* 单分类库失败不影响其他 */ }
    }
    all.sort((a, b) => (b.importance - a.importance) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return all.slice(0, limit);
}
/**
 * 语义搜索事实
 * 将查询文本做 embedding，在 vec_facts 中 KNN 搜索。
 */
export async function searchFacts(query, options = {}) {
    const db = DatabaseManager.getInstance(options.project);
    const topK = options.topK ?? 10;
    const minConfidence = options.minConfidence ?? 0.3;
    const proj = normalizeProject(options.project);
    const cid = options.characterId ?? CHAR_ID;
    if (!isEmbedEnabled()) {
        return []; // 纯本地模式:facts 无向量可查
    }
    const queryVector = await embed(query, options.project);
    const floatQuery = new Float32Array(queryVector);
    const knnLimit = Math.min(topK * 8, 60);
    let knnRows;
    try {
        knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_facts
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(floatQuery, knnLimit);
    }
    catch {
        return [];
    }
    if (knnRows.length === 0)
        return [];
    const rowidMap = new Map();
    for (const r of knnRows) {
        rowidMap.set(Number(r.rowid), r.distance);
    }
    // v1.23.1: 已失效（valid_to 有值）的旧事实不进检索结果
    const conditions = ['f.is_active = 1', 'f.project = ?', "(f.valid_to IS NULL OR f.valid_to = '')", `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
    const params = [proj, ...knnRows.map(r => Number(r.rowid))];
    if (cid !== 'any') {
        conditions.push('f.character_id = ?');
        params.push(cid);
    }
    if (options.subject) {
        conditions.push('f.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT f.rowid, f.id, f.subject, f.predicate, f.object, f.confidence,
           f.source_memory_id, f.created_at, f.updated_at
    FROM facts f
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.confidence DESC
  `).all(...params);
    const results = [];
    for (const row of rows) {
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = Math.max(0, 1.0 - dist);
        const confidence = row.confidence;
        if (confidence < minConfidence)
            continue;
        results.push({
            id: row.id,
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence,
            similarity: Math.round(similarity * 1000) / 1000,
            sourceMemoryId: row.source_memory_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
    // 按 similarity × confidence 排序
    results.sort((a, b) => (b.similarity * b.confidence) - (a.similarity * a.confidence));
    // 更新 accessed_count
    if (results.length > 0) {
        try {
            const now = new Date().toISOString();
            const update = db.prepare('UPDATE facts SET accessed_count = accessed_count + 1, updated_at = ? WHERE id = ?');
            const tx = db.transaction((ids) => { for (const id of ids)
                update.run(now, id); });
            tx(results.map(r => r.id));
        }
        catch { }
    }
    return results;
}
//# sourceMappingURL=search.js.map