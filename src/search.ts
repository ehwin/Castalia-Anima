/**
 * AIRI Memory Search — v5.2 情感锚定评分
 *
 * 哲学：情绪是记忆的锚，一致性是参考。
 * "像她"不是目标，"是她"才是——包括不像她的瞬间。
 *
 * 策略：
 *   1. 标签搜索（0 向量调用）→ 不够回退向量 KNN
 *   2. 评分：情绪强度为主（45%），一致性为辅（30%），时间衰减（15%），偏离加成（10%）
 *   3. 高情绪记忆（|ei|≥7）自动升级候选 + 衰减减半
 */
import { DatabaseManager } from './db.js';
import { embed } from './ollama.js';
import { computeBiasBoost } from './bias.js';
import { computeDecay, computeBaseIntensity, computeRecency, isNightTime } from './emotion.js';

// v5.2: 情绪锚定权重
const WEIGHT_CONSISTENCY = parseFloat(process.env.WEIGHT_CONSISTENCY || '0.30');  // 标签/语义匹配
const WEIGHT_EMOTION     = parseFloat(process.env.WEIGHT_EMOTION || '0.45');      // 情感强度 — 主锚
const WEIGHT_TIME        = parseFloat(process.env.WEIGHT_TIME || '0.15');         // 自适应时间衰减
const WEIGHT_DEVIATION   = parseFloat(process.env.WEIGHT_DEVIATION || '0.10');    // "不像她"的珍贵瞬间

export interface SearchOptions {
  query: string;
  type?: string;
  category?: string;
  tags?: string[];
  characterId?: string;
  subject?: string;
  topK?: number;
  minScore?: number;
  profile?: 'quick' | 'balanced' | 'deep';
}

const SEARCH_PROFILES: Record<string, { topK: number; minScore: number }> = {
  quick: { topK: 3, minScore: 0.6 },
  balanced: { topK: 5, minScore: 0.3 },
  deep: { topK: 10, minScore: 0.1 },
};

export interface SearchResult {
  id: string;
  text: string;
  type: string;
  category: string;
  subcategory: string | null;
  tags: string[];
  emotionalImpact: number;
  importance: number;
  characterId: string | null;
  source: string | null;
  subject: string;
  agentMood: number | null;
  agentDesire: string | null;
  tier: string;
  score: number;
  similarity: number;
  createdAt: string;
  lastAccessedAt: string;
  accessedCount: number;
  biasBoost: number;
}

/**
 * v5.0: 标签优先搜索 → 不足时回退向量 KNN
 */
export async function searchMemory(options: SearchOptions): Promise<SearchResult[]> {
  const db = DatabaseManager.getInstance();
  const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
  const topK = options.topK ?? profile?.topK ?? 10;
  const minScore = options.minScore ?? profile?.minScore ?? 0;

  // ═══ Phase 1: 标签搜索（0 次向量调用） ═══
  const tagResults = tagSearch(db, options);

  // 标签结果足够好 → 直接返回，不调向量模型
  if (tagResults.length >= topK && tagResults[0].score >= 0.5) {
    updateAccessed(db, tagResults.slice(0, topK));
    return tagResults.slice(0, topK);
  }

  // ═══ Phase 2: 标签不够 → 向量 KNN 补充 ═══
  const existingIds = new Set(tagResults.map(r => r.id));
  let vectorResults: SearchResult[] = [];

  try {
    const queryVector = await embed(options.query);
    const floatQuery = new Float32Array(queryVector);
    vectorResults = vectorKnnSearch(db, options, floatQuery, existingIds, topK, minScore);
  } catch {
    // 向量搜索失败，尝试文本回退
    vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
  }

  // 合并 + 去重 + 排序
  const merged = [...tagResults, ...vectorResults];
  merged.sort((a, b) => b.score - a.score);

  // 去重（保留高分）
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of merged) {
    if (!seen.has(r.id)) { seen.add(r.id); unique.push(r); }
    if (unique.length >= topK) break;
  }

  updateAccessed(db, unique.slice(0, topK));
  return unique.slice(0, topK);
}

// ═══════════════════════════════════════════════════════════════════
// v5.0 标签搜索 — 从 query 提取关键词，SQL tag LIKE 匹配
// ═══════════════════════════════════════════════════════════════════

/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query: string): string[] {
  // 按空格、标点切分，过滤短词和停用词
  const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '吗', '呢', '吧', '啊',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
    '有', '在', '不', '要', '会', '能', '就', '都', '也', '还', '和', '与', '这', '那', '什么', '怎么']);
  const tokens = query.split(/[\s,，。！？、；：""''（）\(\)\[\]【】\-\/\\|]+/);
  return [...new Set(tokens.filter(t => t.length >= 2 && !stopWords.has(t.toLowerCase())))];
}

/** SQL 标签搜索：匹配 memory.tags JSON 数组 */
function tagSearch(db: any, options: SearchOptions): SearchResult[] {
  const keywords = extractKeywords(options.query);
  if (keywords.length === 0) return [];

  const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
  const topK = options.topK ?? profile?.topK ?? 10;

  // 构建 LIKE 条件：每个关键词匹配 tags 列
  const likeConditions = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]); // 需要与 conditions 数量匹配; 简化: 一个 condition 一个 param

  // 修正: 每个 condition 带一个 param
  const tagCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const tagParams = keywords.map(k => `%"${k}"%`); // 精确匹配 JSON 数组中的字符串

  // 同时做宽松匹配（不带引号）
  const looseCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const looseParams = keywords.map(k => `%${k}%`);

  const conditions: string[] = ['m.is_active = 1'];
  const params: any[] = [];

  // 标签条件
  conditions.push(`((${tagCond}) OR (${looseCond}))`);
  params.push(...tagParams, ...looseParams);

  if (options.type) { conditions.push('m.type = ?'); params.push(options.type); }
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) { conditions.push('m.character_id = ?'); params.push(options.characterId); }
  if (options.subject) { conditions.push('m.subject = ?'); params.push(options.subject); }

  const rows = db.prepare(`
    SELECT m.id, m.text, m.type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT ?
  `).all(...params, topK * 3) as any[];

  return rows.map(row => {
    const memTags = JSON.parse(row.tags || '[]');
    // 标签匹配数越多分数越高
    const matchedTags = keywords.filter(k =>
      memTags.some((t: string) => t.toLowerCase().includes(k.toLowerCase()))
    ).length;
    const tagScore = Math.min(1.0, matchedTags / Math.max(1, keywords.length));

    // v6.1: 拆三维 — baseIntensity / decayedIntensity / recency 各司其职
    const hasVAD = row.vad_valence != null;
    const storedVAD = hasVAD
      ? { valence: row.vad_valence, arousal: row.vad_arousal, dominance: row.vad_dominance }
      : null;
    const tsundereLvl = row.tsundere_level || 0;
    // recency 用 created_at（事件发生时间），访问频率用 accessBoost
    const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
    const decayed = computeDecay(storedVAD, hoursSinceCreated, tsundereLvl, isNightTime());
    // baseIntensity: 事件本身的情绪烈度（永不变）
    const baseIntensity = storedVAD ? computeBaseIntensity(storedVAD) : Math.abs(row.emotional_impact || 0) / 10;
    // decayedIntensity: 现在还记得多强烈
    const emotionalIntensity = storedVAD ? decayed.intensity : baseIntensity;
    // recency: 纯时间新鲜度
    const recency = computeRecency(hoursSinceCreated);
    const timeDecay = recency;
    const isHighEmotion = baseIntensity >= 0.7;
    // accessBoost: 被检索越多次越靠前
    const accessBoost = 1 + Math.min(0.5, Math.log2(1 + (row.accessed_count || 0)) * 0.1);
    // 一致性有上限：超过 0.7 不再加分（避免过度拟合人设）
    const consistency = Math.min(tagScore, 0.7);
    // 偏离加成：低一致性 + 高情绪 = 可能是珍贵的"不像她"瞬间
    const deviationBonus = (tagScore < 0.3 && isHighEmotion) ? 0.8 : 0;
    const tierBoost = row.tier === 'critical' ? 3.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
    const importanceMult = 0.5 + (row.importance || 0.5);
    const biasBoost = computeBiasBoost(row.character_id || '', memTags);

    const rawScore = WEIGHT_CONSISTENCY * consistency
                   + WEIGHT_EMOTION * emotionalIntensity
                   + WEIGHT_TIME * timeDecay
                   + WEIGHT_DEVIATION * deviationBonus;
    const finalScore = Math.round(rawScore * importanceMult * biasBoost * tierBoost * accessBoost * 1000) / 1000;

    return {
      id: row.id, text: row.text, type: row.type, category: row.category,
      subcategory: row.subcategory, tags: memTags,
      emotionalImpact: row.emotional_impact, importance: row.importance,
      characterId: row.character_id, source: row.source,
      subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
      score: finalScore, similarity: tagScore, tier: row.tier || 'standard',
      createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
      accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
    };
  });
}

/** 向量 KNN 搜索（原有逻辑，抽取为独立函数） */
function vectorKnnSearch(
  db: any, options: SearchOptions, floatQuery: Float32Array,
  excludeIds: Set<string>, topK: number, minScore: number
): SearchResult[] {
  const knnLimit = Math.min(topK * 3, 30);
  let knnRows: any[];

  try {
    knnRows = db.prepare(`
      SELECT rowid, distance FROM vec_memory
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(floatQuery, knnLimit) as any[];
  } catch {
    return [];
  }

  if (knnRows.length === 0) return [];

  const rowidMap = new Map<number, number>();
  for (const r of knnRows) rowidMap.set(Number(r.rowid), r.distance);

  const rowidPlaceholders = knnRows.map(() => '?').join(',');
  const rowidParams = knnRows.map(r => Number(r.rowid));
  const conditions: string[] = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1'];
  const params: any[] = [...rowidParams];

  if (options.type) { conditions.push('m.type = ?'); params.push(options.type); }
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) { conditions.push('m.character_id = ?'); params.push(options.characterId); }

  const rows = db.prepare(`
    SELECT m.id, m.text, m.type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.rowid,
      m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
    FROM memory m WHERE ${conditions.join(' AND ')}
  `).all(...params) as any[];

  const results: SearchResult[] = [];
  for (const row of rows) {
    if (excludeIds.has(row.id)) continue;
    const dist = rowidMap.get(row.rowid) ?? 1.0;
    const similarity = Math.max(0, 1.0 - dist);
    // v6.1: 拆三维
    const hasVAD = row.vad_valence != null;
    const storedVAD = hasVAD
      ? { valence: row.vad_valence, arousal: row.vad_arousal, dominance: row.vad_dominance }
      : null;
    const tsundereLvl = row.tsundere_level || 0;
    const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
    const decayed = computeDecay(storedVAD, hoursSinceCreated, tsundereLvl, isNightTime());
    const baseIntensity = storedVAD ? computeBaseIntensity(storedVAD) : Math.abs(row.emotional_impact || 0) / 10;
    const emotionalIntensity = storedVAD ? decayed.intensity : baseIntensity;
    const recency = computeRecency(hoursSinceCreated);
    const timeDecay = recency;
    const isHighEmotion = baseIntensity >= 0.7;
    const daysSince = hoursSinceCreated / 24;
    const consistency = Math.min(similarity, 0.7);
    const deviationBonus = (similarity < 0.3 && isHighEmotion) ? 0.8 : 0;
    const tierBoost = row.tier === 'critical' ? 3.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
    const importanceMult = 0.5 + row.importance;
    const accessBoost = 1 + Math.min(0.5, Math.log2(1 + row.accessed_count) * 0.1);
    const memTags = JSON.parse(row.tags || '[]');
    const biasBoost = computeBiasBoost(row.character_id || '', memTags);
    const rawScore = WEIGHT_CONSISTENCY * consistency
                   + WEIGHT_EMOTION * emotionalIntensity
                   + WEIGHT_TIME * timeDecay
                   + WEIGHT_DEVIATION * deviationBonus;
    const finalScore = Math.round(rawScore * importanceMult * accessBoost * biasBoost * tierBoost * 1000) / 1000;

    if (finalScore >= minScore) {
      results.push({
        id: row.id, text: row.text, type: row.type, category: row.category,
        subcategory: row.subcategory, tags: memTags,
        emotionalImpact: row.emotional_impact, importance: row.importance,
        characterId: row.character_id, source: row.source,
        subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
        score: finalScore, similarity: Math.round(similarity * 1000) / 1000,
        tier: row.tier || 'standard', createdAt: row.created_at,
        lastAccessedAt: row.last_accessed_at, accessedCount: row.accessed_count,
        biasBoost: Math.round(biasBoost * 1000) / 1000,
      });
    }
  }
  return results;
}

/** 文本回退搜索（向量不可用时） */
function textFallbackSearch(
  db: any, options: SearchOptions, excludeIds: Set<string>,
  topK: number, minScore: number
): SearchResult[] {
  const terms = options.query.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  const likeConditions = terms.map(() => 'm.text LIKE ?').join(' OR ');
  const likeParams = terms.map(t => `%${t}%`);

  const rows = db.prepare(`
    SELECT m.id, m.text, m.type, m.category, m.subcategory, m.tags,
      m.emotional_impact, m.importance, m.character_id, m.source,
      m.subject, m.agent_mood, m.agent_desire, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE m.is_active = 1 AND (${likeConditions})
    ORDER BY m.created_at DESC LIMIT ?
  `).all(...likeParams, topK * 2) as any[];

  return rows
    .filter(row => !excludeIds.has(row.id))
    .map(row => {
      const memTags = JSON.parse(row.tags || '[]');
      const emotionalIntensity = Math.abs(row.emotional_impact || 0) / 10;
      const isHighEmotion = Math.abs(row.emotional_impact || 0) >= 7;
      const emotionHalfLife = isHighEmotion ? 180 : 90;
      const daysSince = (Date.now() - new Date(row.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24);
      const timeDecay = 1.0 / (1.0 + Math.exp(0.04 * (daysSince - emotionHalfLife)));
      const tierBoost = row.tier === 'critical' ? 3.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
      const rawScore = WEIGHT_EMOTION * emotionalIntensity + WEIGHT_TIME * timeDecay;
      const finalScore = Math.round(rawScore * (0.5 + row.importance) * tierBoost * 1000) / 1000;
      return {
        id: row.id, text: row.text, type: row.type, category: row.category,
        subcategory: row.subcategory, tags: memTags,
        emotionalImpact: row.emotional_impact, importance: row.importance,
        characterId: row.character_id, source: row.source,
        subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
        score: finalScore, similarity: 0.3, tier: row.tier || 'standard',
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count, biasBoost: 1.0,
      };
    });
}

/** 更新记忆访问计数 */
function updateAccessed(db: any, results: SearchResult[]) {
  if (results.length === 0) return;
  try {
    const stmt = db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    const tx = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(now, id); });
    tx(results.map(r => r.id));
  } catch {}
}

/**
 * 快速获取近期重要记忆（用于请求前注入，<5ms）
 * 不做向量搜索，直接按时间+importance 捞
 */
export function getRecentMemories(characterId: string, limit: number = 5, hoursBack: number = 24): SearchResult[] {
  const db = DatabaseManager.getInstance();
  const since = new Date(Date.now() - hoursBack * 3600000).toISOString();

  const rows = db.prepare(`
    SELECT id, text, type, category, subcategory, tags,
           emotional_impact, importance, character_id, source, subject, tier,
           agent_mood, agent_desire, created_at, last_accessed_at, accessed_count
    FROM memory
    WHERE is_active = 1 AND character_id = ? AND created_at > ?
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(characterId, since, limit) as any[];

  return rows.map(row => ({
    id: row.id, text: row.text, type: row.type, category: row.category,
    subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
    emotionalImpact: row.emotional_impact, importance: row.importance,
    characterId: row.character_id, source: row.source, subject: row.subject || 'user',
    agentMood: row.agent_mood, agentDesire: row.agent_desire,
    tier: row.tier || 'standard',
    score: row.importance, similarity: 0,
    createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
    accessedCount: row.accessed_count, biasBoost: 1.0,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Fact Search — 语义搜索三元组事实
// ═══════════════════════════════════════════════════════════════════

export interface FactSearchResult {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  similarity: number;
  sourceMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 语义搜索事实
 *
 * 将查询文本做 embedding，在 vec_facts 中 KNN 搜索。
 * 返回最相关的事实三元组，按 similarity × confidence 排序。
 */
export async function searchFacts(
  query: string,
  options: {
    subject?: string;
    topK?: number;
    minConfidence?: number;
  } = {},
): Promise<FactSearchResult[]> {
  const db = DatabaseManager.getInstance();
  const topK = options.topK ?? 10;
  const minConfidence = options.minConfidence ?? 0.3;

  const queryVector = await embed(query);
  const floatQuery = new Float32Array(queryVector);

  const knnLimit = Math.min(topK * 3, 50);

  let knnRows: any[];
  try {
    knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_facts
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(floatQuery, knnLimit) as any[];
  } catch {
    return []; // vec_facts 不可用
  }

  if (knnRows.length === 0) return [];

  const rowidMap = new Map<number, number>();
  for (const r of knnRows) {
    rowidMap.set(Number(r.rowid), r.distance);
  }

  const conditions = ['f.is_active = 1', `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
  const params: any[] = knnRows.map(r => Number(r.rowid));
  if (options.subject) { conditions.push('f.subject = ?'); params.push(options.subject); }

  const rows = db.prepare(`
    SELECT f.rowid, f.id, f.subject, f.predicate, f.object, f.confidence,
           f.source_memory_id, f.created_at, f.updated_at
    FROM facts f
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.confidence DESC
  `).all(...params) as any[];

  const results: FactSearchResult[] = [];

  for (const row of rows) {
    const dist = rowidMap.get(row.rowid) ?? 1.0;
    const similarity = Math.max(0, 1.0 - dist);
    const confidence = row.confidence;

    if (confidence < minConfidence) continue;

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
      db.transaction(() => {
        for (const r of results.slice(0, topK)) update.run(now, r.id);
      })();
    } catch {}
  }

  return results.slice(0, topK);
}
