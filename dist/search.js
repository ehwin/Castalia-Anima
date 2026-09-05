/**
 * AIRI Memory Search — v5.2 情感锚定评分(融合通用版分库检索)
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
import { normalizeProject, isEmbedEnabled } from './env.js';
import { normalizeMemType } from './memType.js';
import { computeBiasBoost } from './bias.js';
import { computeDecay, computeBaseIntensity, computeRecency, isNightTime } from './emotion.js';
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
    const baseIntensity = storedVAD ? computeBaseIntensity(storedVAD) : Math.abs(row.emotional_impact || 0) / 10;
    const emotionalIntensity = storedVAD ? decayed.intensity : baseIntensity;
    return { emotionalIntensity, baseIntensity, isHighEmotion: baseIntensity >= 0.7 };
}
/** 统一评分:一致性 + 情感强度(主锚) + 时间衰减 + 偏离加成,乘 bias/importance/tier/access */
function computeScore(row, similarity) {
    const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
    const { emotionalIntensity, isHighEmotion } = computeEmotionalIntensity(row);
    const consistency = Math.min(Math.max(similarity, 0), 0.7); // 上限 0.7,避免过度拟合人设
    // critical 定案/画像锚点:不受 36h 情感半衰期压制(权威结论 ban 时间,永葆可检索)
    const timeDecay = row.tier === 'critical' ? 1 : computeRecency(hoursSinceCreated);
    const deviationBonus = (similarity < 0.3 && isHighEmotion) ? 0.8 : 0; // 低一致性+高情绪=珍贵"不像她"瞬间
    const tierBoost = row.tier === 'critical' ? 3.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
    const importanceMult = 0.5 + (row.importance || 0.5);
    const accessBoost = 1 + Math.min(0.5, Math.log2(1 + (row.accessed_count || 0)) * 0.1);
    const memTags = Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || '[]');
    const biasBoost = computeBiasBoost(row.character_id || '', memTags);
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
    // ═══ Phase 1: 标签搜索(0 次向量调用) ═══
    const tagResults = tagSearch(db, options);
    // 标签结果足够好 → 直接返回
    if (tagResults.length >= topK && tagResults[0].score >= 0.5) {
        updateAccessed(db, tagResults.slice(0, topK));
        return tagResults.slice(0, topK);
    }
    // ═══ Phase 2: 标签不够 → 向量 KNN 补充(EMBED_MODE=none 时跳过,纯文本回退) ═══
    const existingIds = new Set(tagResults.map(r => r.id));
    let vectorResults = [];
    if (isEmbedEnabled()) {
        try {
            const queryVector = await embed(options.query, options.project);
            const floatQuery = new Float32Array(queryVector);
            vectorResults = vectorKnnSearch(db, options, floatQuery, existingIds, topK, minScore);
        }
        catch {
            // 向量搜索失败 → 文本回退
            vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
        }
    }
    else {
        // 纯本地模式:标签结果不足时直接文本回退
        vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
    }
    // 合并 + 去重 + 排序
    const merged = [...tagResults, ...vectorResults];
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
/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query) {
    const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '吗', '呢', '吧', '啊',
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
        '有', '在', '不', '要', '会', '能', '就', '都', '也', '还', '和', '与', '这', '那', '什么', '怎么']);
    const tokens = query.split(/[\s,，。！？、；：""''（）()\[\]【】\-\/\\|]+/);
    return [...new Set(tokens.filter(t => t.length >= 2 && !stopWords.has(t.toLowerCase())))];
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
    const conditions = ['m.is_active = 1', 'm.project = ?'];
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
        conditions.push('m.character_id = ?');
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
      m.created_at, m.last_accessed_at, m.accessed_count,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${options.sort === 'priority'
        ? 'COALESCE(m.score_priority, 0) DESC, m.importance DESC, m.created_at DESC'
        : options.sort === 'urgency'
            ? 'COALESCE(m.score_urgency, 0) DESC, m.importance DESC, m.created_at DESC'
            : 'm.importance DESC, m.created_at DESC'}
    LIMIT ?
  `).all(...params, topK * 3);
    return rows.map(row => {
        const memTags = JSON.parse(row.tags || '[]');
        const matchedTags = keywords.filter(k => memTags.some((t) => t.toLowerCase().includes(k.toLowerCase()))).length;
        const tagScore = Math.min(1.0, matchedTags / Math.max(1, keywords.length));
        const { score, biasBoost } = computeScore(row, tagScore);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: memTags,
            emotionalImpact: row.emotional_impact ?? 0,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
            tier: row.tier || 'standard',
            score, similarity: Math.round(tagScore * 1000) / 1000,
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
    const conditions = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1', 'm.project = ?'];
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
        conditions.push('m.character_id = ?');
        params.push(options.characterId);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.rowid,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m WHERE ${conditions.join(' AND ')}
  `).all(...params);
    const results = [];
    for (const row of rows) {
        if (excludeIds.has(row.id))
            continue;
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = Math.max(0, 1.0 - dist);
        const { score, biasBoost } = computeScore(row, similarity);
        if (score >= minScore) {
            results.push({
                id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
                subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
                emotionalImpact: row.emotional_impact ?? 0,
                importance: row.importance,
                characterId: row.character_id, source: row.source,
                subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
                tier: row.tier || 'standard',
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
    const terms = options.query.split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0)
        return [];
    const project = normalizeProject(options.project);
    const likeConditions = terms.map(() => 'm.text LIKE ?').join(' OR ');
    const likeParams = terms.map(t => `%${t}%`);
    const conds = [`m.is_active = 1`, `m.project = ?`, `(${likeConditions})`];
    const params = [project, ...likeParams];
    if (options.memType) {
        conds.push('m.mem_type = ?');
        params.push(options.memType);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m
    WHERE ${conds.join(' AND ')}
    ORDER BY m.created_at DESC LIMIT ?
  `).all(...params, topK * 2);
    return rows
        .filter(row => !excludeIds.has(row.id))
        .map(row => {
        const { score, biasBoost } = computeScore(row, 0.3);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
            emotionalImpact: row.emotional_impact ?? 0,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
            tier: row.tier || 'standard',
            score, similarity: 0.3,
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
        };
    });
}
/** 更新记忆访问计数 */
function updateAccessed(db, results) {
    if (results.length === 0)
        return;
    try {
        const stmt = db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?');
        const now = new Date().toISOString();
        const tx = db.transaction((ids) => { for (const id of ids)
            stmt.run(now, id); });
        tx(results.map(r => r.id));
    }
    catch { }
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
            const conds = ['is_active = 1', 'character_id = ?', 'project = ?', 'created_at > ?'];
            const params = [characterId, proj, since];
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
                subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
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
    const conditions = ['f.is_active = 1', 'f.project = ?', `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
    const params = [proj, ...knnRows.map(r => Number(r.rowid))];
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
