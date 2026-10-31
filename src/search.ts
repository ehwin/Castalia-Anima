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
import { MemType, normalizeMemType } from './memType.js';
import type Database from 'better-sqlite3';
import { computeBiasBoost } from './bias.js';
import { computeDecay, computeBaseIntensity, computeRecency, isNightTime } from './emotion.js';
import { parseTagsSafe } from './tags.js';
import { chunkKnnSearch } from './chunkIndex.js';
import { rankBySalience, moodFromScalar, shouldCountAccess } from './emotionalRanking.js';
import { memorySourceWithoutStateSql, publicMemorySourceSql } from './memoryProvenance.js';

function visibleMemorySourceSql(alias: string, includeDiary?: boolean): string {
  return includeDiary === true ? memorySourceWithoutStateSql(alias) : publicMemorySourceSql(alias);
}

// v1.28: tags 解码收敛到纯模块 src/tags.ts（零副作用、可被验收脚本单独加载）。
// 这里保留 re-export，历史 import { parseTagsSafe } from './search.js' 不会断。
export { parseTagsSafe };

// v5.2: 情绪锚定权重(可经环境变量调整)
// v5.2 原本是 WEIGHT_CONSISTENCY=0.30 / EMOTION=0.45 —— 情感是主锚,相关性只占三成。
// 2026-10-28 重新配平:情绪/时间/偏差的作用是"**同样相关时**偏好哪一段",不能盖过相关性本身。
// 起因(实测):6 个字的垃圾行「命运改变醒来」(tier=critical, 被反复注入 → accessed_count 滚雪球)
// 在每个查询里都以 score 4.3 排第一,而真正回答了问题的长设定(sim 0.53)只有 1.88 —— 注入的
// 永远不是要点。改后相关性占六成,元数据降为有界乘数(见 computeScore),仍可用同名 env 覆盖。
// 第二轮实测(2026-10-28):0.60/0.22 还不够 —— 「你母亲是怎么死的」要点行的片段余弦 0.659(全场
// 最高),却因为 tier=standard、emotional_impact=0 而排到 #32(score 0.625 < 相似度只有 0.50 的
// 那些行 0.72)。相似度差 0.16 只值 0.6×0.16=0.096,而情绪一项就能加 0.22、tier 再乘 1.35 —— 
// 相关性在任何情况下都可能被元数据翻盘。改成相似度占 ~1.0、情绪 0.12、时间 0.06(情绪/偏差只做
// "同样相关时"的偏好,不再是主锚);偏差保留 0.10 让它那个"不像她的瞬间"特性仍然有效。
const WEIGHT_CONSISTENCY = parseFloat(process.env.WEIGHT_CONSISTENCY || '1.00');  // 标签/语义匹配 — 主轴
const WEIGHT_EMOTION     = parseFloat(process.env.WEIGHT_EMOTION || '0.12');      // 情感强度(同等相关时)
const WEIGHT_TIME        = parseFloat(process.env.WEIGHT_TIME || '0.03'); // 时间衰减：0.15→0.03（R38：金标 R@1 68.1%→76.8%；回忆一次刷新时钟）
const WEIGHT_DEVIATION   = parseFloat(process.env.WEIGHT_DEVIATION || '0.10');    // "不像她"的珍贵瞬间

/**
 * 向量路降级的可见性（2026-10-31）。
 *
 * 这两处原来是空 `catch`：embed 失败、vec_chunk 表不存在、vec_memory 为空，
 * 在引擎侧全都表现为「检索正常返回，只是没有向量结果」。结果是一个部署可以
 * 跑几个月都不知道自己的向量路是死的（论文 §3.3 只能靠库外探端口反推）。
 *
 * 只加日志与计数，不改控制流：向量故障仍按设计降级到词法通道（返回结果比返回
 * 500 好），60s 内同类只报一条，避免刷屏。
 */
const _vectorWarnAt = new Map<string, number>();
let vectorDegradedCount = 0;
function warnVectorDegraded(kind: 'embed_or_knn' | 'chunk_knn', e: unknown): void {
  vectorDegradedCount++;
  const now = Date.now();
  if (now - (_vectorWarnAt.get(kind) ?? 0) < 60_000) return;
  _vectorWarnAt.set(kind, now);
  const msg = (e as any)?.message ?? String(e);
  console.warn(`[search] 向量路降级(${kind}): ${msg} —— 本次检索按词法继续；同类告警 60s 内静默`);
}

/** 向量路降级计数（自检口径，供 /health 与回归脚本断言）。 */
export function getVectorDegradedCount(): number {
  return vectorDegradedCount;
}


export interface SearchOptions {
  query: string;
  project?: string;  // v1.5: 项目隔离 — 默认 PROJECT_ID
  type?: string;
  memType?: MemType;  // v1.8: 用途维度过滤(user/feedback/project/reference/general)
  category?: string;
  tags?: string[];
  characterId?: string;
  /**
   * 一并返回"无主"记忆(character_id 为空 / NULL)。
   *
   * 读取路径给角色看的是"自己的 + owner 共享的"，按相关性取内容的调用方要开它才一致。
   * 默认关 —— 冷存/清理/维护类调用必须严格按角色隔离。
   */
  includeGeneral?: boolean;
  /**
   * 是否允许召回自循环生成的 agent_diary。
   * 默认关闭：日记是派生观察，不是用户证据；显式开启只用于日记浏览/调试。
   */
  includeDiary?: boolean;
  subject?: string;
  topK?: number;
  minScore?: number;
  profile?: 'quick' | 'balanced' | 'deep';
  /**
   * 是否把本次命中记成"回忆"（accessed_count+1、刷新 last_accessed_at）。
   *
   * 系统注入不算强化（nooa-memory 的口径，也是 emotionalRanking 里那条原则）：
   * 注入是"提示词里出现了这段"，不是"她想起来了"。原来注入路径照样刷新时钟与访问数，
   * 于是 被注入 → 排名更高 → 更容易再被注入，形成正反馈（实测 lore 行滚到 200~306 次）。
   * 注入路径（recallForInjection）一律传 false；用户主动检索保持默认 true。
   */
  countAccess?: boolean;
  /**
   * 当前心情(-10..+10,agentState 的口径)。给了才参与「情绪一致性」重排与注入时的
   * 「难过别翻旧账」策略;不给就按中性处理(行为与接线前一致)。
   */
  mood?: number;
  /** 写访问日志时标渠道(默认 'search');只影响 ACT-R 统计,不影响打分 */
  accessChannel?: string;
}

// minScore 阈值可配;harness 可用 SEARCH_MIN_SCORE 覆盖
const SEARCH_PROFILES: Record<string, { topK: number; minScore: number }> = {
  quick: { topK: 3, minScore: 0.6 },
  balanced: { topK: 5, minScore: parseFloat(process.env.SEARCH_MIN_SCORE || '0.15') },
  deep: { topK: 10, minScore: 0.1 },
};

export interface SearchResult {
  id: string;
  text: string;
  project: string;
  type: string;
  memType: string;
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
  /** v1.23 Parent-Child：leaf 记忆指回的父对话 id（无则 null） */
  parentId?: string | null;
  score: number;
  similarity: number;
  /** 命中来源:向量 / 标签 / 文本词法 / 最近 —— 注入门槛必须按来源换量纲(2026-10-28) */
  basis?: 'vector' | 'chunk' | 'tag' | 'lexical' | 'recency' | 'entity';
  createdAt: string;
  lastAccessedAt: string;
  accessedCount: number;
  biasBoost: number;
  /** v1.28：这条记忆已被更新的记忆接管（只在回指查询里返回，且已降权） */
  superseded?: boolean;
  /** v1.28：接管它的记忆 id，来自 memory.metadata.supersededBy */
  supersededBy?: string[];
  /** 情感锚点：钉住的那条无条件在场（Character.AI Story Memory） */
  pinned?: boolean;
  /** 情感显著度 0..1（emotionalRanking.rankBySalience 的输出，锚点恒 1） */
  salience?: number;
}

/**
 * 情感强度 — 用 vad_valence/emotional_impact 计算
 * 优先 VAD 三维(经 computeDecay 衰减后的综合强度),无 VAD 回退 emotional_impact 标量。
 * baseIntensity 是事件本身的情绪烈度(永不变),isHighEmotion 判定"不像她"珍贵瞬间。
 */
function computeEmotionalIntensity(row: any): { emotionalIntensity: number; baseIntensity: number; isHighEmotion: boolean } {
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
/**
 * 单行打分。导出是为了让回归脚本能**直接**验「时间项还有多少分量」这类性质 ——
 * 端到端比较会被相似度差异干扰（两条不同文本的相似度差 0.008 就能盖过时间项），
 * 见 scripts/regression_superseded_recall.mjs §4。
 */
export function computeScore(row: any, similarity: number, project?: string): { score: number; biasBoost: number } {
  // v1.28: 时间衰减锚点用 last_accessed_at（缺失才回退 created_at）—— 回忆一次就刷新时钟。
  // 原来只认 created_at：半年前写下、昨天刚被反复用到的记忆，时间衰减分接近 0。
  const touchedAt = row.last_accessed_at || row.created_at;
  const hoursSinceTouched = (Date.now() - new Date(touchedAt).getTime()) / (1000 * 60 * 60);
  const { emotionalIntensity, isHighEmotion } = computeEmotionalIntensity(row);
  const consistency = Math.min(Math.max(similarity, 0), 0.95);  // 上限 0.95（R35：0.7→0.95，金标 R@1 52.3%→63.6%）
  const timeDecay = computeRecency(hoursSinceTouched);
  const deviationBonus = (similarity < 0.3 && isHighEmotion) ? 0.8 : 0;  // 低一致性+高情绪=珍贵"不像她"瞬间
  // 2026-10-28:这三个原来是**乘在总分上的**乘数(critical ×3.0、importance ×(0.5+imp)、
  // 访问次数 ×(1~1.5)),于是结构性元数据可以完全压过相关性 —— 而且"被注入→last_accessed/
  // accessed_count 被刷新→下次更容易被注入"形成正反馈,垃圾行越滚越强。改成有界加成/弱乘数。
  const tierBoost = row.tier === 'critical' ? 1.10 : (row.tier === 'temporary' ? 0.95 : 1.0);
  const importanceMult = 0.85 + 0.3 * (row.importance || 0.5);          // 0.85~1.15
  const accessBoost = 1 + Math.min(0.08, Math.log2(1 + (row.accessed_count || 0)) * 0.02);
  const memTags = parseTagsSafe(row.tags);
  const biasBoost = computeBiasBoost(row.character_id || '', memTags, project);

  // 信息密度:极短行(如 6 字的残片)即使余弦不低也几乎不含内容,轻微降权而不直接排除
  const lenOfText = String(row.text || '').length;
  const densityFactor = Math.max(0.75, Math.min(1, lenOfText / 24));
  const rawScore = WEIGHT_CONSISTENCY * consistency
                 + WEIGHT_EMOTION * emotionalIntensity
                 + WEIGHT_TIME * timeDecay
                 + WEIGHT_DEVIATION * deviationBonus;
  // 2026-10-28:派生摘要行(reflect_summary / reflect_reasoning 是"这段时间用户与角色…""这批记忆
  // 全部…"这类第三人称概括)在语义上离任何问题都很近,会把第一人称正典挤出前几名 —— 实测
  // 「你还记得自己是谁吗」的第一条注入就是这类第三人称概括。它们对索引有用、对台词没用,
  // 给个**有界**降权(不动可检索性)。
  const src = String(row.source || '');
  const sourceFactor = (src === 'reflect_summary' || src === 'reflect_reasoning') ? 0.85
    : (src.startsWith('reflect_') ? 0.93 : 1.0);
  const score = Math.round(rawScore * sourceFactor * densityFactor * importanceMult * biasBoost * tierBoost * accessBoost * 1000) / 1000;
  return { score, biasBoost };
}

/**
 * 情感显著度重排(v1.29 接线,2026-10-30)
 *
 * `emotionalRanking.ts` 里的东西(ACT-R 激活、情绪一致性、共振、锚点)一直是**纯函数 + 测试**,
 * 主链仍然是 computeScore —— 也就是说这套情感机制在线上从来没参与过排序。这里把它接上:
 * 候选来源、召回门槛、相似度仍归 computeScore;显著度只在**最终排序**里发言。
 *
 * 三个刻意的决定(每个都有踩过的坑作依据,不是照抄论文):
 * 1. **有界混合,不替换**。2026-10-28 已经踩过一次「结构性元数据乘在总分上会把相关性压死」
 *    (tier×3.0 / importance×(0.5+imp) / access×1.5 → 6 个字的垃圾行 score 4.3 排第一)。
 *    所以显著度只做 ±10% 的乘数(`1 - blend/2 + blend*s`,blend = 0.2):同量级候选之间的
 *    先后由它决定,相关性差一个档次时它翻不了盘。
 * 2. **强度用存储强度 `computeBaseIntensity`,不用衰减后的 retrieval**。新鲜度已经由 ACT-R
 *    的 activation 项表达;这里要的是「这件事本身刻得多深」。"被反复想起"靠 activation 涨,
 *    不靠把情绪值改大 —— 所以这一层与「情感衰减该按哪个时钟算」是正交的。
 * 3. **一次查询取齐输入**。候选 id 通常 ≤40:一条 IN 查询 + 一条访问日志查询,不按条 N+1。
 *    老库没有 pinned 列或日志表时**静默退化为不重排**(行为与接线前完全一致),绝不抛错
 *    —— 引擎里任何排序增强都不该让检索变成 0 条。
 */
export const SALIENCE_BLEND = 0.2;

/**
 * 显著度 → 分数乘数。s=0 → 0.9、s=0.5 → 1.0、s=1 → 1.1。
 * 单独抽出来是为了能被断言钉死("显著度只能动 ±10%"),而不是埋在排序里没法验。
 */
export function salienceBlendFactor(s: number): number {
  const v = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5;
  return 1 - SALIENCE_BLEND / 2 + SALIENCE_BLEND * v;
}

function applySalienceRerank(db: any, results: SearchResult[], mood?: number): void {
  if (results.length === 0) return;
  const ids = results.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  let rows: any[];
  try {
    rows = db.prepare(`SELECT id, importance, vad_valence, vad_arousal, vad_dominance,
        last_accessed_at, created_at, pinned
      FROM memory WHERE id IN (${ph})`).all(...ids) as any[];
  } catch {
    return; // 老库没有 pinned 列 → 不接线,也不报错
  }
  const byId = new Map<string, any>(rows.map((r: any) => [String(r.id), r]));

  // ACT-R 的输入:多次访问的**时间戳**。一次取最近 400 条(每条封顶 32 次呈现),
  // 没有日志表时退回 last_accessed_at —— 单次呈现,间隔效应表达不出来,但不会算错。
  const times = new Map<string, number[]>();
  try {
    const logs = db.prepare(`SELECT memory_id, accessed_at FROM memory_access_log
      WHERE memory_id IN (${ph}) ORDER BY accessed_at DESC LIMIT 400`).all(...ids) as any[];
    for (const l of logs) {
      const t = Date.parse(String(l.accessed_at));
      if (!Number.isFinite(t)) continue;
      const key = String(l.memory_id);
      const list = times.get(key) || [];
      if (list.length < 32) { list.push(t); times.set(key, list); }
    }
  } catch { /* 无日志表 */ }

  // 共振:库里没有共激活表,直接用 edges 当联想边(构造时就绑在一起的两条记忆)。
  const resonance = new Map<string, Record<string, number>>();
  try {
    const edges = db.prepare(`SELECT source_id, target_id FROM edges
      WHERE source_id IN (${ph}) AND target_id IN (${ph})`).all(...ids, ...ids) as any[];
    for (const e of edges) {
      const a = String(e.source_id), b = String(e.target_id);
      if (a === b) continue;
      const ra = resonance.get(a) || {}; ra[b] = (ra[b] || 0) + 1; resonance.set(a, ra);
      const rb = resonance.get(b) || {}; rb[a] = (rb[a] || 0) + 1; resonance.set(b, rb);
    }
  } catch { /* 无 edges 表 */ }

  const inputs = results.map(r => {
    const row = byId.get(r.id) || {};
    const hasVad = row.vad_valence != null;
    const vad = hasVad
      ? { valence: Number(row.vad_valence), arousal: Number(row.vad_arousal), dominance: Number(row.vad_dominance) }
      : null;
    const intensity = hasVad
      ? computeBaseIntensity(vad)
      : Math.min(1, Math.abs(Number(r.emotionalImpact) || 0) / 10);
    const list = times.get(r.id) || [];
    if (list.length === 0) {
      const t = Date.parse(String(row.last_accessed_at || row.created_at || r.lastAccessedAt || r.createdAt || ''));
      if (Number.isFinite(t)) list.push(t);
    }
    return {
      id: r.id,
      intensity,
      importance: Number(row.importance ?? r.importance ?? 0.5),
      accessTimes: list,
      vad,
      pinned: !!row.pinned,
      resonance: resonance.get(r.id) || null,
    };
  });

  // 共振种子 = 相关性最高的三条(「已经决定在场的」),不外求。
  const seeds = [...results].sort((a, b) => b.score - a.score).slice(0, 3).map(r => r.id);
  const ranked = rankBySalience(inputs, Date.now(), mood == null ? null : moodFromScalar(mood), seeds);
  const salById = new Map(ranked.map(x => [x.id, x.score]));
  const pinnedById = new Map(inputs.map(i => [i.id, i.pinned]));

  for (const r of results) {
    const s = salById.get(r.id);
    if (s == null) continue;
    r.salience = Math.round(s * 1000) / 1000;
    if (pinnedById.get(r.id)) r.pinned = true;
    r.score = Math.round(r.score * salienceBlendFactor(s) * 1000) / 1000;
  }
  results.sort((a, b) => b.score - a.score);
}

/**
 * 情感锚点:被钉住的记忆(memory.pinned=1)。注入时**无条件在场**,不参与相似度门槛。
 *
 * Character.AI 的 Story Memory 口径:用户能长按钉住「告白 / 转折 / 那句改变一切的话」,
 * 那条永不衰减。所以它不能靠相似度进门 —— 问句跟它无关时也该在。
 * 但仍然服从项目隔离与角色隔离(钉住 ≠ 跨角色泄漏)。
 */
export function pinnedAnchors(options: {
  project?: string;
  characterId?: string;
  includeGeneral?: boolean;
  includeDiary?: boolean;
  memType?: MemType;
  limit?: number;
} = {}): SearchResult[] {
  const project = normalizeProject(options.project);
  const limit = Math.max(0, options.limit ?? 2);
  if (limit === 0) return [];
  const dirs = options.memType ? [normalizeMemType(options.memType)] : listMemTypeDirs(project);
  const found = new Map<string, SearchResult>();
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(project, mt);
      const conds = ['m.is_active = 1', 'm.project = ?', 'm.pinned = 1', "COALESCE(m.status, '') <> 'superseded'"];
      const params: any[] = [project];
      conds.push(visibleMemorySourceSql('m', options.includeDiary));
      if (options.characterId) {
        conds.push(options.includeGeneral
          ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
          : 'm.character_id = ?');
        params.push(options.characterId);
      }
      const rows = db.prepare(`
        SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
          m.emotional_impact, m.importance, m.character_id, m.source,
          m.subject, m.agent_mood, m.agent_desire, m.tier,
          m.created_at, m.last_accessed_at, m.accessed_count, m.parent_id, m.pinned
        FROM memory m
        WHERE ${conds.join(' AND ')}
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT ?
      `).all(...params, limit) as any[];
      for (const row of rows) {
        if (found.has(row.id)) continue;
        found.set(row.id, {
          id: row.id, text: row.text, project: row.project || 'default', type: row.type,
          memType: row.mem_type || 'general', category: row.category, subcategory: row.subcategory,
          tags: parseTagsSafe(row.tags),
          emotionalImpact: row.emotional_impact ?? 0,
          importance: Number(row.importance ?? 0.5),
          characterId: row.character_id, source: row.source,
          subject: row.subject || 'user', agentMood: row.agent_mood, agentDesire: row.agent_desire,
          tier: row.tier || 'standard',
          parentId: row.parent_id || null,
          // score/similarity 给 0:锚点不参与检索排序,注入层直接取(别让它被当成召回命中)
          score: 0, similarity: 0, basis: 'tag' as const,
          createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
          accessedCount: row.accessed_count, biasBoost: 0,
          pinned: true, salience: 1,
        } as SearchResult);
      }
    } catch { /* 单分类库失败不影响其他 */ }
  }
  return [...found.values()]
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, limit);
}

/**
 * 标签优先搜索 → 不足时回退向量 KNN
 */
/** 单库搜索主体(标签 → 向量 KNN → 文本回退),按分类库调用 */
/**
 * 实体扩散召回(v1.29,2026-10-29)—— 联想,不是相似度
 *
 * 情感记忆里"想起一件事"常常是因为它和当前话题共享人物/地点/事件,而不是措辞相近。
 * 引擎早就有 memory_entities + entities.expandEntityGraph(entities.ts L214/L234),
 * 但 search.ts 一处都没用 —— 这里把它接进候选池。
 *
 * 量纲:structural similarity = 0.3 + 0.1×(共享实体数-1),封顶 0.7,并标 basis:'entity',
 * 这样 recallForInjection 的 gateOf() 会按词法门槛(0.2)判它 —— 结构命中天然比余弦弱,
 * 不该用 0.45 的余弦门槛去卡它,也不该独自构成"强证据"。
 */
function entityExpandedSearch(
  db: Database.Database,
  options: SearchOptions,
  seedIds: string[],
  excludeIds: Set<string>,
  limit: number,
  memoryDbs: Database.Database[] = [db],
): SearchResult[] {
  if (seedIds.length === 0 || limit <= 0) return [];
  const project = options.project;
  const cid = options.characterId;
  try {
    const ph = seedIds.map(() => '?').join(',');
    // Relations are normally stored in general, while the source memory may
    // live in another memType partition. Read relations from every partition
    // and resolve the actual memory rows separately below.
    const seedEnts: any[] = [];
    const relationDbs = [...new Set([db, ...memoryDbs])];
    for (const relationDb of relationDbs) {
      try {
        seedEnts.push(...relationDb.prepare(`SELECT DISTINCT entity_id FROM memory_entities WHERE memory_id IN (${ph})`)
          .all(...seedIds) as any[]);
      } catch { /* legacy partition without entity tables */ }
    }
    const entIds = seedEnts.map(r => String(r.entity_id)).slice(0, 32);
    if (entIds.length < 2) return [];

    const ph2 = entIds.map(() => '?').join(',');
    // Count shared entities across all relation partitions before loading
    // memory rows. This preserves entity expansion for cross-memType sources.
    const sharedByMemory = new Map<string, Set<string>>();
    for (const relationDb of relationDbs) {
      try {
        const rows = relationDb.prepare(`SELECT memory_id, entity_id FROM memory_entities WHERE entity_id IN (${ph2})`)
          .all(...entIds) as any[];
        for (const row of rows) {
          const id = String(row.memory_id || '');
          const entityId = String(row.entity_id || '');
          if (!id || !entityId) continue;
          const set = sharedByMemory.get(id) || new Set<string>();
          set.add(entityId);
          sharedByMemory.set(id, set);
        }
      } catch { /* legacy partition without entity tables */ }
    }
    const candidateIds = [...sharedByMemory.entries()]
      .filter(([id, entities]) => entities.size >= 2 && !excludeIds.has(id))
      .map(([id]) => id);
    if (candidateIds.length === 0) return [];

    const rows: any[] = [];
    const idPh = candidateIds.map(() => '?').join(',');
    for (const memoryDb of memoryDbs) {
      const params: any[] = [...candidateIds];
      const conditions = [`m.id IN (${idPh})`, 'm.is_active = 1'];
      if (project) { conditions.push('m.project = ?'); params.push(project); }
      conditions.push(visibleMemorySourceSql('m', options.includeDiary));
      if (options.memType) { conditions.push('m.mem_type = ?'); params.push(options.memType); }
      const charCond = cid && cid !== 'any'
        ? (options.includeGeneral
          ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
          : 'm.character_id = ?')
        : '';
      if (charCond) { conditions.push(charCond); params.push(cid); }
      try {
        rows.push(...memoryDb.prepare(`
          SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
            m.emotional_impact, m.importance, m.character_id, m.source,
            m.subject, m.agent_mood, m.agent_desire, m.tier,
            m.created_at, m.last_accessed_at, m.accessed_count, m.parent_id,
            m.vad_valence, m.vad_arousal, m.vad_dominance, m.tsundere_level
          FROM memory m WHERE ${conditions.join(' AND ')}
        `).all(...params) as any[]);
      } catch { /* legacy partition without newer memory columns */ }
    }
    const dedup = new Map<string, any>();
    for (const row of rows) {
      const id = String(row.id);
      if (!dedup.has(id)) dedup.set(id, { ...row, shared: sharedByMemory.get(id)?.size || 0 });
    }

    return [...dedup.values()]
      .sort((a, b) => Number(b.shared) - Number(a.shared) || Number(b.importance || 0) - Number(a.importance || 0))
      .slice(0, limit)
      .map(row => {
      const shared = Number(row.shared) || 0;
      const structural = Math.min(0.7, 0.3 + 0.1 * (shared - 1));
      const { score, biasBoost } = computeScore(row, structural, project);
      return {
        id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type,
        category: row.category, subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
        emotionalImpact: row.emotional_impact ?? 0, importance: row.importance,
        characterId: row.character_id, source: row.source, subject: row.subject || 'user',
        agentMood: row.agent_mood, agentDesire: row.agent_desire, tier: row.tier || 'standard',
        parentId: row.parent_id || null,
        score, similarity: Math.round(structural * 1000) / 1000, basis: 'entity' as const,
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
      } as SearchResult;
      });
  } catch {
    return [];   // 没有 memory_entities 表(旧库)/查询失败:扩散是增益,不是前置条件
  }
}

async function searchInDb(db: Database.Database, options: SearchOptions, memoryDbs: Database.Database[] = [db]): Promise<SearchResult[]> {
  const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
  const topK = options.topK ?? profile?.topK ?? 10;
  const minScore = options.minScore ?? profile?.minScore ?? 0;

  // v1.24: 角色隔离 — 未显式指定 characterId 时按进程级 CHAR_ID 过滤(传 'any' 才关闭过滤)。
  // 三条检索路径(标签/向量/文本回退)共用这里的 scoped,避免只堵住一条路。
  const cid = options.characterId ?? CHAR_ID;
  const scoped: SearchOptions = cid === 'any' ? { ...options, characterId: undefined } : { ...options, characterId: cid };

  // ═══ Phase 1: 标签搜索(0 次向量调用) ═══
  const tagResults = tagSearch(db, scoped);

  // 标签结果足够好 → 直接返回
  // 2026-10-31: 这条快速路径原来绕过 guard，既丢了 accessChannel（请求 explicit_recall
  // 却记成 'search'），也不受渠道契约约束。改走同一个入口。
  if (tagResults.length >= topK && tagResults[0].score >= 0.5) {
    updateAccessedGuard(db, tagResults.slice(0, topK), scoped.countAccess, scoped.accessChannel, memoryDbs);
    return tagResults.slice(0, topK);
  }

  // ═══ Phase 2: 标签不够 → 向量 KNN 补充(EMBED_MODE=none 时跳过,纯文本回退) ═══
  const existingIds = new Set(tagResults.map(r => r.id));
  let vectorResults: SearchResult[] = [];

  if (isEmbedEnabled()) {
    let vecOk = false;
    try {
      const queryVector = await embed(scoped.query, scoped.project);
      const floatQuery = new Float32Array(queryVector);
      // 2026-10-28:片段级 KNN(整行向量在长记忆上被稀释,见 chunkIndex.ts 里的实测数字)
      let chunkSims: Map<number, number> | undefined;
      try { chunkSims = chunkKnnSearch(db, floatQuery, topK); }
      catch (e) { chunkSims = undefined; warnVectorDegraded('chunk_knn', e); }
      vectorResults = vectorKnnSearch(db, scoped, floatQuery, existingIds, topK, minScore, chunkSims);
      vecOk = true;
    } catch (e) {
      vecOk = false;
      warnVectorDegraded('embed_or_knn', e);
    }
    // v1.28-fix(移植自 Lite 修 E6a):原来只在 embed/KNN **抛错**时回退。vec_memory 为空
    // (换模型清空后尚未补齐、维度刚重建、批量嵌入没跑)时 KNN 会"成功返回 0 行",
    // 于是嵌入服务明明健康却静默 0 命中。零命中同样要回退到文本检索。
    // 2026-10-28(2):有向量时也**始终**算一遍词法结果并合并。原来只在 KNN 抛错/零命中时
    // 才回退,而向量一旦返回任何一条(哪怕相似度只有 0.37),精确词法命中(0.5~1.0)就整条
    // 被挤掉 —— 实测 airi 库:只用向量路时注入要点覆盖 70% → 30%(「你的生日是哪天」的
    // 「未知」、用户问身份时命中的原始叙事全丢)。合并后去重取 similarity 高者(下方 bestById)。
    vectorResults = [...vectorResults, ...textFallbackSearch(db, scoped, new Set(), topK, minScore)];
    if (vectorResults.length === 0 && !vecOk) vectorResults = textFallbackSearch(db, scoped, new Set(), topK, minScore);
  } else {
    // 纯本地模式:标签结果不足时直接文本回退。
    // 2026-10-28:这里**不再**把标签已命中的 id 排除掉 —— 一条记忆先被标签弱命中(0.333)、
    // 正文其实强命中(0.5)时,排除掉等于把它的高分永不上报:实测「你为什么看不见命运了」
    // 要命的那条(三年前那笔交易)就被压在候选第 6 名、进不了 top5。合并时按 score 去重,
    // 同一 id 只会留下分高的那个版本。
    vectorResults = textFallbackSearch(db, scoped, new Set(), topK, minScore);
  }

  // 合并 + 去重 + 排序
  const merged = [...tagResults, ...vectorResults];
  // v1.28 回指召回：查询在问"以前/之前/原来/上次说过什么"时，把被接管的旧记忆带
  // superseded 标记 + 降权加进候选池，参与同一次排序。非回指查询行为不变。
  if (isBackReferenceQuery(scoped.query)) {
    merged.push(...supersededRecall(db, scoped, new Set(merged.map(r => r.id)), Math.min(3, topK)));
  }
  // v1.29:实体扩散 —— 用已召回的头部当种子,把共享 ≥2 个实体的记忆带进来。
  // 放在排序前,让它们与其它来源同场竞争(它们分数天然偏低,不会挤掉强命中)。
  if (!(options as any).noEntityExpand && merged.length > 0) {
    const seedIds = merged.slice(0, 5).map(r => r.id);
    merged.push(...entityExpandedSearch(db, scoped, seedIds, new Set(merged.map(r => r.id)), Math.min(3, topK), memoryDbs));
  }

  merged.sort((a, b) => b.score - a.score);

  // 2026-10-28:接管关系要有硬保证。降权系数是乘法(0.6),而相关性权重提到 1.0 之后,被接管的旧记忆
  // 靠更高的相似度就能翻盘(实测 0.176 > 0.137,「以前的居住地」那条旧记录排到了现行记录前面)。
  // 语义上"以新的为准":同一结果里接替者也在时,把旧的压到它下面(仍然保留、仍带 superseded 标记,
  // 这样"我以前说过…"依然可解释)。
  {
    const scoreById = new Map(merged.map(r => [r.id, r.score]));
    for (const r of merged) {
      if (!r.superseded || !Array.isArray(r.supersededBy)) continue;
      const succScores = r.supersededBy.map(id => scoreById.get(id)).filter((v): v is number => typeof v === 'number');
      if (succScores.length === 0) continue;
      const cap = Math.min(...succScores) * 0.95;
      if (r.score > cap) r.score = Math.round(cap * 1000) / 1000;
    }
    merged.sort((a, b) => b.score - a.score);
  }

  // 2026-10-28: 同一条记忆会被多条路径命中(标签给 0.333、正文给 1.0),以前"先到先留"
  // 让低分的标签版本赢,把最相关的那条挤到 top5 之外。现在同 id 保留 similarity 更高的那份。
  const bestById = new Map<string, SearchResult>();
  for (const r of merged) {
    const prev = bestById.get(r.id);
    if (!prev || (Number(r.similarity) || 0) > (Number(prev.similarity) || 0)) bestById.set(r.id, r);
  }
  const unique = [...bestById.values()].sort((a, b) => b.score - a.score);
  // v1.29(2026-10-30):情感显著度在这里发言 —— 相关性定"有哪些",显著度定"同样近时谁先"。
  // 三条设计决定见 applySalienceRerank;老库缺列时它自己退化为不重排。
  applySalienceRerank(db, unique, scoped.mood);
  const top = unique.slice(0, topK);

  updateAccessedGuard(db, top, scoped.countAccess, scoped.accessChannel, memoryDbs);
  return top;
}

/** countAccess=false 时不记访问（注入路径），见 SearchOptions.countAccess */
function updateAccessedGuard(db: any, results: SearchResult[], countAccess: boolean | undefined, channel?: string, memoryDbs: any[] = [db]): void {
  if (countAccess === false) return;
  // Entity expansion can return rows owned by another memType database.
  // Update each partition so access accounting never targets the wrong DB.
  for (const ownerDb of [...new Set([db, ...memoryDbs])]) updateAccessed(ownerDb, results, channel);
}

export async function searchMemory(options: SearchOptions): Promise<SearchResult[]> {
  const proj = normalizeProject(options.project);
  const topK = options.topK ?? 10;
  // memdir:memType 指定 → 单分类库;未指定 → 聚合项目全部分类库
  const mtFilter = options.memType ? normalizeMemType(options.memType) : null;
  const dirs = mtFilter ? [mtFilter] : listMemTypeDirs(proj);
  const memoryDbs: Database.Database[] = [];
  for (const mt of listMemTypeDirs(proj)) {
    try { memoryDbs.push(DatabaseManager.getInstance(proj, mt)); } catch { /* partition unavailable */ }
  }
  const all: SearchResult[] = [];
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      const r = await searchInDb(db, { ...options, project: proj }, memoryDbs.length ? memoryDbs : [db]);
      all.push(...r);
    } catch { /* 单分类库失败不影响其他 */ }
  }
  // 同上:跨分类库聚合时,同 id 保留 similarity 更高的那份再排序
  const bestAcross = new Map<string, SearchResult>();
  for (const r of all) {
    const prev = bestAcross.get(r.id);
    if (!prev || (Number(r.similarity) || 0) > (Number(prev.similarity) || 0)) bestAcross.set(r.id, r);
  }
  return [...bestAcross.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}
/**
 * 跨库搜索(多项目合并,2026-08-16) — 显式语义:
 * 调用方明确指定要搜哪些库(projects),引擎不做隐式合并/共享魔法;
 * 互通规则由上层决定(接口先行)。结果按 score 降序,每行 project 标注来源库。
 * projects=['*'] 或 ['all'] → 本实例全部库(扫描 memory 目录)。
 */
export async function searchMemoryAcross(options: SearchOptions & { projects?: string[] }): Promise<SearchResult[]> {
  const raw = (options.projects ?? []).map(x => (x ?? '').trim()).filter(Boolean);
  const targetProjects = raw.length === 0
    ? [normalizeProject(options.project)]
    : raw.some(x => x === '*' || x === 'all')
      ? listProjectNames()
      : raw.map(normalizeProject);

  const perProject = Math.max(3, Math.ceil((options.topK ?? 10) * 1.5));
  const all: SearchResult[] = [];
  for (const proj of targetProjects) {
    try {
      const r = await searchMemory({ ...options, project: proj, topK: perProject });
      all.push(...r);
    } catch {
      // 单个库失败不影响其他库
    }
  }
  all.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of all) {
    if (seen.has(r.id)) continue;
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
export function queryTerms(query: string, max = 16): string[] {
  const out = new Set<string>();
  for (const raw of String(query ?? '').split(/[\s,，。！？、；：""''（）()\[\]【】\-\/\\|]+/)) {
    const seg = raw.trim();
    if (seg.length < 2) continue;
    if (!/[\u4e00-\u9fff]/.test(seg)) out.add(seg);
    else for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
    if (out.size >= max) break;
  }
  return [...out].slice(0, max);
}

/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query: string): string[] {
  return queryTerms(query).filter(t => !QUERY_STOP_WORDS.has(t.toLowerCase()));
}

/** SQL 标签搜索：匹配 memory.tags JSON 数组 */
function tagSearch(db: any, options: SearchOptions): SearchResult[] {
  const keywords = extractKeywords(options.query);
  if (keywords.length === 0) return [];

  const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
  const topK = options.topK ?? profile?.topK ?? 10;
  const project = normalizeProject(options.project);

  const tagCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const tagParams = keywords.map(k => `%"${k}"%`);
  const looseCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const looseParams = keywords.map(k => `%${k}%`);

  // v1.23-fix: superseded 在三条检索路径上一致排除（被接管的旧记忆不该再被检索命中）
  const conditions: string[] = ['m.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') <> 'superseded'"];
  const params: any[] = [project];
  conditions.push(visibleMemorySourceSql('m', options.includeDiary));

  conditions.push(`((${tagCond}) OR (${looseCond}))`);
  params.push(...tagParams, ...looseParams);

  if (options.type) { conditions.push('m.type = ?'); params.push(options.type); }
  if (options.memType) { conditions.push('m.mem_type = ?'); params.push(options.memType); }
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) {
    // includeGeneral: 读取路径(提示里的索引 + read 工具)给角色看的是"自己的 + owner 共享的"，
    // 任何按相关性取内容的调用方都要开它才跟读取路径一致。默认关：维护类调用严格按角色隔离。
    conditions.push(options.includeGeneral
      ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
      : 'm.character_id = ?');
    params.push(options.characterId);
  }
  if (options.subject) { conditions.push('m.subject = ?'); params.push(options.subject); }

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
  `).all(...params, topK * 3) as any[];

  return rows.map(row => {
    const memTags = parseTagsSafe(row.tags);
    const matchedTags = keywords.filter(k =>
      memTags.some((t: string) => t.toLowerCase().includes(k.toLowerCase()))
    ).length;
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
      score, similarity: Math.round(tagScore * 1000) / 1000, basis: 'tag' as const,
      createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
      accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
    };
  });
}

/** 向量 KNN 搜索 */
/**
 * sqlite-vec 的 vec0 默认是 **L2** 距离(建表时没写 distance_metric,见 db.ts),
 * 而这里一直按 `1 - 距离` 当作余弦相似度 —— 单位向量下正确换算是 `1 - d²/2`
 * (d² = 2 - 2cos)。实测:「第 127 位谕女」那句查自己的行,distance=0.6683 而真实
 * 余弦=0.7767,按旧算法得 0.33 → 低于注入门槛 0.5,于是**所有真实语义命中都被丢掉**,
 * 向量召回形同虚设。排序本来就没错(单位向量下 L2 序 = 余弦序),错的只是喂给门槛的值。
 */
export function l2ToCosine(dist: number): number {
  if (!Number.isFinite(dist)) return 0;
  return Math.max(0, Math.min(1, 1 - (dist * dist) / 2));
}

function vectorKnnSearch(
  db: any, options: SearchOptions, floatQuery: Float32Array,
  excludeIds: Set<string>, topK: number, minScore: number,
  // 2026-10-28:片段级 KNN 的"每行最大余弦"。长记忆整行向量被稀释(实测整行 0.40~0.52,
  // 最佳句 0.51~0.69),把片段命中的行也纳入候选、相似度取两者的最大值。
  chunkSims?: Map<number, number>,
): SearchResult[] {
  // v1.5: vec0 虚拟表禁止 JOIN(KNN 必须在 vec0 上 LIMIT),项目过滤放在第二段 memory 查询
  // 候选集放大(全库 KNN)保证单项目召回;隔离语义由 memory 查询的 project=? 保证
  const knnLimit = Math.min(topK * 8, 60);
  const project = normalizeProject(options.project);
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

  // 相似度表(不再是距离表):行级 L2→余弦,再用片段级余弦取大
  const simMap = new Map<number, number>();
  for (const r of knnRows) simMap.set(Number(r.rowid), l2ToCosine(Number(r.distance)));
  const fromChunk = new Set<number>();
  if (chunkSims) {
    for (const [rid, s] of chunkSims) {
      if (s > (simMap.get(rid) ?? 0)) fromChunk.add(rid);
      simMap.set(rid, Math.max(simMap.get(rid) ?? 0, s));
    }
  }
  // SQL 的 IN 列表要覆盖"片段命中但整行没进 KNN"的行
  const candidateRowids = [...simMap.keys()];

  const rowidPlaceholders = candidateRowids.map(() => '?').join(',');
  const rowidParams = candidateRowids;
  const conditions: string[] = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') <> 'superseded'"];
  const params: any[] = [...rowidParams, project];
  conditions.push(visibleMemorySourceSql('m', options.includeDiary));

  if (options.type) { conditions.push('m.type = ?'); params.push(options.type); }
  if (options.memType) { conditions.push('m.mem_type = ?'); params.push(options.memType); }
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }
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
  `).all(...params) as any[];

  const results: SearchResult[] = [];
  for (const row of rows) {
    // 2026-10-28:这里原本 `if (excludeIds.has(row.id)) continue;` —— 把"标签路弱命中(0.33)"的行
    // 从向量/片段路里整条跳掉,于是它的强相似度(片段 0.66)永远上报不了。「你母亲是怎么死的」
    // 要点的行就是这样消失的:标签路给了个低分把它锁在外面,注入里根本见不到。
    // 和词法路同一个修法:不排除,合并后由 bestById 保留 similarity 更高的那份。
    const similarity = simMap.get(row.rowid) ?? 0;   // 行级/片段级取大(2026-10-28)
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
        // 2026-10-28:向量/片段各自标 basis —— 两者量纲不同(短片段之间余弦天然偏高约 0.1),
        // 注入层必须按来源取不同门槛,否则分块会把噪音也抬过线(实测噪音 top 从 0.41~0.49
        // 抬到 0.50~0.57,原来那道 0.50 的证据门当场失效)。
        basis: fromChunk.has(row.rowid) ? ('chunk' as const) : ('vector' as const),
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
      });
    }
  }
  return results;
}

/** 文本回退搜索(向量不可用时) */
function textFallbackSearch(
  db: any, options: SearchOptions, excludeIds: Set<string>,
  topK: number, minScore: number
): SearchResult[] {
  const terms = queryTerms(options.query);
  if (terms.length === 0) return [];
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

  // 2026-10-28:IDF 加权。原来 lexSim = 命中个数 / min(词数,4),把「母亲」「黑潮」这种**罕见**
  // 词和「自己」「记得」这种高频 bigram 一视同仁 —— 于是实体问句(黑潮是什么 / 你的生日是哪天)
  // 只共享 1 个实体词时只有 0.25,被高频词拼出来的行反而更高,要点的行排到 15~39 名。
  // 权重取 log(1 + N/(1+df)):df 小(罕见)权重高,df 大(高频)权重接近 0。
  const dfSql = `SELECT COUNT(*) c FROM memory m WHERE m.is_active = 1 AND m.project = ?`
    + ` AND COALESCE(m.status, '') <> 'superseded'`
    + ` AND ${visibleMemorySourceSql('m', options.includeDiary)}`
    + (options.memType ? ' AND m.mem_type = ?' : '')
    + (options.characterId
      ? (options.includeGeneral
        ? " AND (m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
        : ' AND m.character_id = ?')
      : '');
  const dfBase: any[] = [project, ...(options.memType ? [String(options.memType)] : [])];
  if (options.characterId) dfBase.push(options.characterId);
  let corpusN = 1;
  try { corpusN = Number((db.prepare(dfSql).get(...dfBase) as any)?.c) || 1; } catch { corpusN = 1; }
  const idf = terms.map((t) => {
    let df = 0;
    try { df = Number((db.prepare(`${dfSql} AND ${haystack} LIKE ?`).get(...dfBase, `%${t}%`) as any)?.c) || 0; } catch { df = 0; }
    return Math.log(1 + corpusN / (1 + df));
  });

  const conds: string[] = [`m.is_active = 1`, `m.project = ?`, "COALESCE(m.status, '') <> 'superseded'", `${matchExpr} >= 1`];
  const params: any[] = [project, ...likeParams];
  conds.push(visibleMemorySourceSql('m', options.includeDiary));
  if (options.memType) { conds.push('m.mem_type = ?'); params.push(options.memType); }
  if (options.type) { conds.push('m.type = ?'); params.push(options.type); }
  if (options.category) { conds.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) {
    conds.push(options.includeGeneral
      ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
      : 'm.character_id = ?');
    params.push(options.characterId);
  }
  if (options.subject) { conds.push('m.subject = ?'); params.push(options.subject); }

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
  `).all(...params, ...likeParams, topK * 2) as any[];

  return rows
    .filter(row => !excludeIds.has(row.id))
    .map(row => {
      // 2026-10-28: 原来这里硬写 similarity: 0.3,而注入门槛是 0.5(向量余弦量纲) ——
      // 于是没向量时**每一条文本命中都被当成"不够像"丢掉**,她的记忆一条也进不了提示词。
      // 改成真实词法覆盖率:命中词数 / min(词数, 4)(分母封顶 4,长问句的 bigram 数会虚高,
      // 否则「你母亲是怎么死的」这种只共享一个词的问句永远过不了线)。
      const lower = `${String(row.title || '')} ${String(row.text || '')}`.toLowerCase();
      const matchedWeight = terms.reduce((n, t, i) => n + (lower.includes(t.toLowerCase()) ? idf[i] : 0), 0);
      const totalWeight = idf.reduce((a, b) => a + b, 0) || 1;
      const lexSim = Math.min(1, matchedWeight / totalWeight);
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
        score, similarity: Math.round(lexSim * 1000) / 1000, basis: 'lexical' as const,
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

export function isBackReferenceQuery(query: string): boolean {
  return BACK_REFERENCE_PATTERN.test(String(query ?? ''));
}

/** 被接管旧记忆的降权系数：低于任何正常命中，但不为零（可见、可解释，不与新记忆同权竞争） */
export const SUPERSEDED_PENALTY = 0.6;

/** metadata.supersededBy 可能是字符串或数组；解析失败返回 undefined（不是空数组）。 */
function readSupersededBy(metadata: unknown): string[] | undefined {
  if (typeof metadata !== 'string' || metadata.length === 0) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { supersededBy?: unknown };
    const raw = parsed?.supersededBy;
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    const ids = list.map(String).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** 回指召回：带 superseded 标记 + 降权返回被接管的旧记忆。 */
function supersededRecall(db: any, options: SearchOptions, excludeIds: Set<string>, limit: number): SearchResult[] {
  if (limit <= 0) return [];
  const terms = String(options.query || '').split(/[\s,，。！？、；：]+/).filter(t => t.length >= 2);
  if (terms.length === 0) return [];
  const project = normalizeProject(options.project);
  const likeCond = terms.map(() => 'm.text LIKE ?').join(' OR ');
  const conds: string[] = ['m.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') = 'superseded'", `(${likeCond})`];
  const params: any[] = [project, ...terms.map(t => `%${t}%`)];
  conds.push(visibleMemorySourceSql('m', options.includeDiary));
  if (options.characterId) {
    conds.push(options.includeGeneral
      ? "(m.character_id = ? OR m.character_id IS NULL OR m.character_id = '')"
      : 'm.character_id = ?');
    params.push(options.characterId);
  }
  if (options.memType) { conds.push('m.mem_type = ?'); params.push(options.memType); }

  let rows: any[] = [];
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
    `).all(...params, limit) as any[];
  } catch {
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
        similarity: 0.3, basis: 'lexical' as const,
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count, biasBoost: Math.round(biasBoost * 1000) / 1000,
        superseded: true,
        supersededBy: readSupersededBy(row.metadata),
      } as SearchResult;
    });
}

/** 更新记忆访问计数 + 写访问日志(v1.29:ACT-R 需要多次呈现的时间戳,不是只有一个 last) */
function updateAccessed(db: any, results: SearchResult[], channel?: string) {
  if (results.length === 0) return;
  const ch = String(channel || 'search').slice(0, 32);
  // 2026-10-31: 渠道契约在这里执行。此前 shouldReinforce('diagnostic') 返回 false,
  // 但没有任何写路径读它 —— 诊断读取照样把 accessed_count 和 last_accessed_at 改掉。
  if (!shouldCountAccess(ch)) { accessSuppressed++; return; }
  try {
    // v1.23 冷存回温：被检索命中即回到工作集（清掉 status='cold'）。
    // 否则"冷"会变成永久标记 —— 经常被用的记忆反而永远被排除在新沉淀之外。
    const stmt = db.prepare("UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ?, status = CASE WHEN status = 'cold' THEN NULL ELSE status END WHERE id = ?");
    const now = new Date().toISOString();
    // 日志表可能不存在(老库没迁移/迁移失败) —— 那就不记,不影响计数这条主路径。
    // 但失败必须可见：审计里 memory_access_log 全库 0 行、accessed_count 却有 565，
    // 就是因为这里静默吞掉了错误，ACT-R 的间隔效应悄悄失效（2026-10-31）。
    let logStmt: any = null;
    try { logStmt = db.prepare('INSERT INTO memory_access_log (memory_id, project, accessed_at, channel) VALUES (?, ?, ?, ?)'); }
    catch (e: any) {
      logStmt = null; accessLogFailures++;
      if (accessLogFailures === 1) console.warn(`[search] memory_access_log 不可写，ACT-R 访问间隔将丢失: ${e?.message || e}`);
    }
    const tx = db.transaction((rows: SearchResult[]) => {
      for (const r of rows) {
        stmt.run(now, r.id);
        if (logStmt) logStmt.run(r.id, r.project || 'default', now, ch);
      }
    });
    tx(results);
    // 日志是无界增长表:每 200 次写入清一次 180 天前的记录(足够表达间隔效应,又不会撑爆库)。
    accessWrites++;
    if (logStmt && accessWrites % 200 === 0) {
      try { db.prepare("DELETE FROM memory_access_log WHERE accessed_at < datetime('now', '-180 day')").run(); } catch {}
    }
  } catch {}
}

let accessWrites = 0;
let accessSuppressed = 0;
let accessLogFailures = 0;

/** 访问记账的自检口径：写入次数 / 被渠道契约拦下的次数 / 日志写失败次数。 */
export function getAccessStats(): { writes: number, suppressed: number, logFailures: number } {
  return { writes: accessWrites, suppressed: accessSuppressed, logFailures: accessLogFailures };
}

/** v1.23 Parent-Child 回捞结果 */
export interface HydratedParent {
  parentId: string;
  excerpt: string;
  /** full=整段 / excerpt=锚点窗口 / head=锚点未命中取开头 */
  mode: 'full' | 'excerpt' | 'head';
  /** 同父命中比例（hits / 活跃 leaf 数） */
  ratio: number;
}

/**
 * v1.23 Parent-Child 原文回捞 —— 命中的是提炼记忆(leaf)，按 parent_id 取对话原文。
 * 合并策略照 llama_index AutoMergingRetriever：同父命中比例 > 50% 或 parent 本来就短 → 整段；
 * 否则只给命中片段。总预算 3000 字符 / 最多 3 个 parent，避免把上下文吃满。
 *
 * 与 Full 现网实现的差异（修其"永远从 0 截断"缺陷）：excerpt 先用该 leaf 的 text 前 40 字符
 * 在 parent 里 indexOf 定位锚点，窗口取锚点前 400 后 800；定位失败才退回开头并标 mode='head'。
 */
export function hydrateParentExcerpts(
  project: string | undefined,
  related: { id?: string; text?: string; parentId?: string | null }[],
  opts: { budget?: number; maxParents?: number; characterId?: string } = {},
): HydratedParent[] {
  const proj = normalizeProject(project);
  const cid = opts.characterId ?? CHAR_ID;
  if (!related || related.length === 0) return [];
  let budget = opts.budget ?? 3000;
  const maxParents = opts.maxParents ?? 3;
  const out: HydratedParent[] = [];
  try {
    // 每个 parent 收集命中次数 + 可用于定位的样本（leaf 正文）
    const hitsByParent = new Map<string, { hits: number; samples: string[] }>();
    for (const m of related) {
      if (!m.parentId) continue;
      const entry = hitsByParent.get(m.parentId) || { hits: 0, samples: [] };
      entry.hits++;
      if (entry.samples.length < 3 && m.text) entry.samples.push(String(m.text));
      hitsByParent.set(m.parentId, entry);
    }
    for (const [pid, hit] of [...hitsByParent.entries()].slice(0, maxParents)) {
      if (budget <= 0) break;
      // Parent hydration is still a memory read. Keep derived self-cycle
      // entries out even when a caller supplies a diary leaf/parent id.
      const row = DatabaseManager.queryAll<any>(proj,
        `SELECT id, text FROM memory WHERE id = ? AND project = ? AND character_id = ? AND is_active = 1 AND ${publicMemorySourceSql()}`,
        [pid, proj, cid])[0];
      if (!row || !row.text) continue;
      const parentText = String(row.text);
      // 分母只算活跃 leaf：已停用/被接管的 leaf 不该把"同父命中比"拉低
      const totalLeaves = DatabaseManager.queryAll<any>(proj,
        `SELECT COUNT(*) AS c FROM memory WHERE parent_id = ? AND project = ? AND is_active = 1 AND character_id = ? AND ${publicMemorySourceSql()}`, [pid, proj, cid])
        .reduce((n, r) => n + (Number(r.c) || 0), 0) || 1;
      const ratio = hit.hits / totalLeaves;
      const full = ratio > 0.5 || parentText.length <= 1800;
      let excerpt: string;
      let mode: HydratedParent['mode'];
      if (full) {
        excerpt = parentText.slice(0, Math.min(2500, budget));
        mode = 'full';
      } else {
        let anchor = -1;
        for (const sample of hit.samples) {
          const probe = String(sample || '').replace(/\s+/g, ' ').trim().slice(0, 40);
          if (probe.length < 8) continue;
          anchor = parentText.indexOf(probe);
          if (anchor >= 0) break;
        }
        if (anchor < 0) {
          excerpt = parentText.slice(0, Math.min(1600, budget));
          mode = 'head';
        } else {
          const start = Math.max(0, anchor - 400);
          const end = Math.min(parentText.length, anchor + 800, start + Math.max(0, budget));
          excerpt = parentText.slice(start, Math.max(start, end));
          mode = 'excerpt';
        }
      }
      out.push({ parentId: pid, excerpt, mode, ratio: Math.round(ratio * 100) / 100 });
      budget -= excerpt.length;
    }
  } catch { /* 回捞失败不影响主流程 */ }
  return out;
}

/**
 * 快速获取近期重要记忆(用于请求前注入，<5ms)
 * 不做向量搜索，直接按时间+importance 捞
 */
export function getRecentMemories(characterId: string, limit: number = 5, hoursBack: number = 24, project?: string, memType?: MemType): SearchResult[] {
  const proj = normalizeProject(project);
  // memdir:memType 指定 → 单分类库;未指定 → 聚合项目全部分类库
  const dirs = memType ? [normalizeMemType(memType)] : listMemTypeDirs(proj);
  const all: SearchResult[] = [];
  const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      // v1.24: 角色隔离 — characterId='any' 才关闭过滤(默认由调用方传 CHAR_ID)
      const conds: string[] = ['is_active = 1', 'project = ?', 'created_at > ?', "COALESCE(status, '') <> 'superseded'"];
      const params: any[] = [proj, since];
      conds.push(publicMemorySourceSql());
      if (characterId && characterId !== 'any') { conds.push('character_id = ?'); params.push(characterId); }
      if (memType) { conds.push('mem_type = ?'); params.push(memType); }
      params.push(limit);
      const rows = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, emotional_impact, character_id, source, subject, tier,
               created_at, last_accessed_at, accessed_count
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(...params) as any[];
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
    } catch { /* 单分类库失败不影响其他 */ }
  }
  all.sort((a, b) => (b.importance - a.importance) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return all.slice(0, limit);
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
 * 将查询文本做 embedding，在 vec_facts 中 KNN 搜索。
 */
export async function searchFacts(
  query: string,
  options: {
    project?: string;
    subject?: string;
    topK?: number;
    minConfidence?: number;
    /** v1.24: 角色隔离 — 默认当前实例 CHAR_ID;传 'any' 关闭角色过滤(跨库管理场景) */
    characterId?: string;
  } = {},
): Promise<FactSearchResult[]> {
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
    return [];
  }

  if (knnRows.length === 0) return [];

  const rowidMap = new Map<number, number>();
  for (const r of knnRows) {
    rowidMap.set(Number(r.rowid), r.distance);
  }

  // v1.23.1: 已失效（valid_to 有值）的旧事实不进检索结果
  const conditions = ['f.is_active = 1', 'f.project = ?', "(f.valid_to IS NULL OR f.valid_to = '')", `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
  const params: any[] = [proj, ...knnRows.map(r => Number(r.rowid))];
  if (cid !== 'any') { conditions.push('f.character_id = ?'); params.push(cid); }
  if (options.subject) { conditions.push('f.subject = ?'); params.push(options.subject); }

  const rows = db.prepare(`
    SELECT f.rowid, f.id, f.subject, f.predicate, f.object, f.confidence,
           f.source_memory_id, f.created_at, f.updated_at
    FROM facts f
    LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
    WHERE ${conditions.join(' AND ')}
      AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
    ORDER BY f.confidence DESC
  `).all(...params) as any[];

  const results: FactSearchResult[] = [];

  for (const row of rows) {
    const dist = rowidMap.get(row.rowid) ?? 1.0;
    const similarity = l2ToCosine(dist);   // L2 → 余弦(2026-10-28)
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
      const tx = db.transaction((ids: string[]) => { for (const id of ids) update.run(now, id); });
      tx(results.map(r => r.id));
    } catch {}
  }

  return results;
}
