/**
 * 记忆反思接口 — 供大模型（如 DeepSeek/GPT）调用
 *
 * 大模型拿到所有记忆，做反思式重构：
 *   - 合并重复记忆
 *   - 拆分过长的记忆
 *   - 建立关联（edges）
 *   - 降级/升级 importance
 *   - 重新分类
 *
 * HTTP 接口：
 *   GET  /memory/reflect/list    — 获取所有记忆（供大模型分析）
 *   POST /memory/reflect/apply   — 应用大模型的重构指令
 */

import { loadPromptOverride } from './promptFile.js';
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { getEmbeddingCached } from './ollama.js';
import { saveFacts, saveMemory, reEmbedMemory, batchEmbedPending, updateMemory, findDbByMemoryId } from './store.js';
import { normalizeProject, CHAR_ID } from './env.js';
import { MemType, isMemType, MEM_TYPES } from './memType.js';
import fs from 'node:fs';
import path from 'node:path';
import { currentMemDir } from './db.js';
import { emotionalReflectPrompt } from './reflectionFidelity.js';
import { getUnanalyzedConversations } from './reflectionSources.js';
import { parseTagsSafe, serializeTags } from './tags.js';
export { getUnanalyzedConversations, markConversationsReflected } from './reflectionSources.js';

export interface ReflectMemory {
  id: string;
  text: string;
  type: string;
  memType: string;
  category: string;
  tags: string[];
  importance: number;
  vad?: { valence: number | null; arousal: number | null; dominance: number | null };
  agentMood?: string | null;
  emotionalImpact?: number;  // Anima: 情感冲击标量(0-10)，可选兼容
  subject: string;
  source: string;
  tier: string;
  expiresAt: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessedCount: number;
  referenceCount: number;
}

export interface ReflectReceipt {
  action: string;
  status: 'applied' | 'failed' | 'skipped';
  targetId: string | null;
  reason: string;
  rowsAffected: number;
}

export interface ReflectAction {
  action: 'merge' | 'split' | 'relate' | 'reclassify' | 'delete' | 'boost' | 'decay' | 'extract';
  // merge: 把多个记忆合并成一个
  sourceIds?: string[];
  newText?: string;
  newType?: string;
  newCategory?: string;
  newTags?: string[];
  newImportance?: number;
  // split: 把一个记忆拆成多个
  targetId?: string;
  fragments?: { text: string; type?: string; category?: string; tags?: string[]; importance?: number }[];
  // relate: 建立关联
  sourceId?: string;
  targetIdRelate?: string;
  relationType?: string;
  // reclassify: 重新分类(可同时改 type/category/tags/memType)
  newTypeSingle?: string;
  newCategorySingle?: string;
  // extract: 从源记忆中提取新记忆（不删除源）
  // 使用 sourceId + newText/newType/newCategory/newTags/newImportance/tier/newMemType
  tier?: string;
  newSubject?: 'user' | 'self' | 'environment';
  newMemType?: string;  // v1.8: 提取/重分类时分类到 4 种封闭类型(user/feedback/project/reference)
  /** v1.23 原文逐字引用（子串校验，编造的丢弃） */
  quotes?: string[];
  /** v1.23 结构化三元组 + evidence，直接进 facts 表（不经过自然语言） */
  hardFacts?: { subject: string; predicate: string; object: string; confidence?: number; evidence?: string; validFrom?: string; validTo?: string }[];
  /** v1.23 与旧记忆同主题/接续时只挂链接（metadata.supersededBy + status=superseded），不覆盖旧记忆 */
  linkedMemoryIds?: string[];
  // delete: 软删除
  // boost/decay: 调整 importance
  delta?: number;
}

/**
 * 获取所有记忆（供大模型分析）
 * v1.24: 角色隔离 — 只返回本实例角色(charId='any' 关闭过滤)。
 */
export function listAllMemories(characterId: string = CHAR_ID, limit: number = 200, project?: string): ReflectMemory[] {
  const proj = normalizeProject(project);
  const cid = characterId || CHAR_ID;
  // memdir:聚合项目全部分类库
  const dirs = listMemTypeDirs(proj);
  const all: any[] = [];
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      const rows = db.prepare(`
        SELECT id, text, type, mem_type, category, tags, importance, emotional_impact, vad_valence, vad_arousal, vad_dominance, agent_mood,
               subject, source, tier, expires_at, created_at, last_accessed_at, accessed_count, reference_count, locked
        FROM memory
        WHERE is_active = 1 AND project = ?
          AND (? = 'any' OR character_id = ?)
          -- v1.23: 冷存与被接管的旧记忆不参加新一轮沉淀（否则深反思会反复处理同一批死记忆）
          AND COALESCE(status, '') NOT IN ('cold', 'superseded')
          -- 自循环日记是派生观察，不得进入普通反思/事实提取
          AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(proj, cid, cid, limit) as any[];
      all.push(...rows);
    } catch { /* 单分类库失败不影响其他 */ }
  }
  all.sort((a: any, b: any) => (b.importance - a.importance) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const rows = all.slice(0, limit);

  return rows.map(r => {
    const tags = parseTagsSafe(r.tags);

    return {
    id: r.id,
    text: r.text,
    type: r.type,
    memType: r.mem_type || 'general',
    category: r.category,
    tags,
    importance: r.importance,
    emotionalImpact: r.emotional_impact ?? 0,
    vad: { valence: r.vad_valence, arousal: r.vad_arousal, dominance: r.vad_dominance },
    agentMood: r.agent_mood,
    subject: r.subject,
    source: r.source,
    tier: r.tier || 'standard',
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    lastAccessedAt: r.last_accessed_at,
    accessedCount: r.accessed_count,
    referenceCount: r.reference_count || 0,
    locked: r.locked || 0,
  };
  });}
/**
 * 应用大模型的重构指令
 */
// ═════════════════════════════════════════════════
// 护栏：拒绝明显无效的值，防止大模型幻觉污染数据库
// ═════════════════════════════════════════════════
const VALID_TYPES = new Set(['episodic', 'semantic', 'entity', 'preference']);
const VALID_MEM_TYPES = new Set<string>(MEM_TYPES);  // v1.8: 4 种封闭类型 + general
const VALID_CATEGORIES = new Set(['conversation', 'emotional', 'milestone', 'identity', 'relationship', 'knowledge', 'preference', 'general', 'mood_snapshot']);
const VALID_RELATIONS = new Set(['caused_by', 'part_of', 'follows', 'related_to', 'same_subject', 'causes', 'leads_to', 'sequence']);

function safeTags(raw: any): string[] | null {
  if (!raw) return null;
  if (!Array.isArray(raw)) return null;
  const filtered = raw.filter(t => typeof t === 'string' && t.length > 0 && t.length < 50);
  return filtered.length > 0 ? filtered : null;
}

/**
 * v1.11.4 跨 memType 库解析目标记忆 —— **同族坑第三次**:applyReflectActions 旧实现把 merge/split/
 * delete/reclassify/relate/boost/decay 的语句全打在 `getInstance(project)`(= 只 general 一个 sqlite)上,
 * 于是 user/feedback/project 里的记忆一律 "not found or locked";更糟的是 merge 仍会**无条件插入**合并结果
 * → 源还在、又多一条 = 净增重复(2026-09-19 副本实测:9 个 merge 全失败,活跃 229→238)。
 * 顺序:精确 id(store 的 findDbByMemoryId,内部先扫活跃再兜底墓碑)→ 前缀 LIKE(LLM 会给短 ID),先活跃后兜底;
 * 找不到则回退 fallback(默认 general 库),让调用方原本的 "not found" 判断照常生效。
 */
function resolveReflectTarget(idPrefix: string, project?: string, allowInactiveConversation = false, characterId: string = CHAR_ID): { db: any; id: string } | null {
  if (!idPrefix || typeof idPrefix !== 'string') return null;
  // v1.24: 角色隔离 — 反思动作只允许命中本实例角色的记忆(防 LLM 幻觉 id 改到别人头上)
  const cid = characterId || CHAR_ID;
  const own = cid === 'any' ? '' : " AND character_id = ?";
  const ownArgs = cid === 'any' ? [] : [cid];
  const matches: { db: any; id: string }[] = [];
  for (const mt of listMemTypeDirs(normalizeProject(project))) {
    const db = DatabaseManager.getInstance(project, mt);
    const rows = db.prepare(`SELECT id FROM memory WHERE project = ? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state') AND (is_active = 1${allowInactiveConversation ? " OR source = 'conversation_log'" : ''})${own} AND substr(id, 1, length(?)) = ?`)
      .all(normalizeProject(project), ...ownArgs, idPrefix, idPrefix) as { id: string }[];
    for (const row of rows) matches.push({ db, id: row.id });
  }
  const exact = matches.filter(m => m.id === idPrefix);
  if (exact.length === 1) return exact[0];
  return matches.length === 1 ? matches[0] : null;
}

function memDbFor(id: string, project: string | undefined, fallback: any, characterId: string = CHAR_ID): any {
  return findDbByMemoryId(id, project, characterId === 'any' ? undefined : characterId)?.db ?? fallback;
}

// ═══ v1.23 证据附录：硬事实覆盖率闸门 ═══
// 背景：实测提取只保住 ~75% 的硬事实（路径/端口/版本/日期/数字）。这些是"复核所需"的锚点，
// 用程序算覆盖率比让模型自觉可靠；不够就把没覆盖到的原句**原样**补进去（纯字符串操作，零额外调用）。
const HARD_TOKEN_PATTERNS: RegExp[] = [
  /[A-Za-z]:\\[^\s，。；、）)】"'`]+/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\b\d{2,5}\s*(?:B|KB|MB|GB|文件|条|帧|事件|个|秒|分钟|小时)\b/g,
  /\b\d+\.\d+(?:\.\d+)?\b/g,
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g,
  /\b\d{1,5}\b/g,
  /[A-Z]{2,}-\d+/g,
];

/** 覆盖率闸门：低于该值就补证据附录。 */
const HARD_COVERAGE_MIN = 0.9;

function hardTokens(text: string): string[] {
  const out = new Set<string>();
  for (const re of HARD_TOKEN_PATTERNS) {
    for (const m of String(text || '').match(re) || []) {
      if (m.length > 3) out.add(m);
    }
  }
  return [...out];
}

function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[。！？!?；;\n])/)
    .map(s => s.replace(/^[\s>]+/, '').trim())
    .filter(s => s.length >= 8);
}

function hardCoverage(sourceText: string, outputText: string): { total: number; ratio: number; missing: string[] } {
  const tokens = hardTokens(sourceText);
  if (!tokens.length) return { total: 0, ratio: 1, missing: [] };
  const haystack = String(outputText || '');
  const missing = tokens.filter(t => !haystack.includes(t));
  return { total: tokens.length, ratio: (tokens.length - missing.length) / tokens.length, missing };
}

/**
 * 提取完成后按来源检查硬事实覆盖：不达标就把"含缺失 token 的原句"追加到该来源第一条 extract 上。
 * 多主题拆条时按来源汇总判断，避免每条都被误判为低覆盖而重复补。
 */
function attachEvidenceAppendix(result: any, project: string | undefined, warnings: string[]): void {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const bySource = new Map<string, any[]>();
  for (const a of actions) {
    if (!a || a.action !== 'extract' || typeof a.sourceId !== 'string') continue;
    const list = bySource.get(a.sourceId) || [];
    list.push(a);
    bySource.set(a.sourceId, list);
  }
  for (const [sourceId, list] of bySource) {
    const target = resolveReflectTarget(sourceId, project, true);
    if (!target) continue;
    let sourceText = '';
    try {
      sourceText = (target.db.prepare('SELECT text FROM memory WHERE id = ?').get(target.id) as any)?.text || '';
    } catch { continue; }
    if (!sourceText) continue;
    const merged = list.map((a: any) => String(a.newText || '')).join('\n');
    const { total, ratio, missing } = hardCoverage(sourceText, merged);
    if (!total || !missing.length || ratio >= HARD_COVERAGE_MIN) continue;
    const missingSet = new Set(missing);
    const sentences = [...new Set(splitSentences(sourceText).filter(s => hardTokens(s).some(t => missingSet.has(t))))].slice(0, 12);
    if (!sentences.length) continue;
    const appendix = `\n\n【证据附录·原文】\n${sentences.map(s => `> ${s}`).join('\n')}`;
    list[0].newText = String(list[0].newText || '') + appendix;
    warnings.push(`证据附录：来源 ${String(sourceId).slice(0, 8)} 硬事实覆盖 ${(ratio * 100).toFixed(0)}%，补 ${sentences.length} 句原文`);
  }
}

export interface ReflectApplyOptions {
  automatic?: boolean;
  allowedSourceIds?: Set<string>;
  /**
   * v1.23-fix: 整合(consolidate)模式。整合的任务就是"合并重复"：merge 先生成合并结果、
   * 再把源标 is_active=0（行仍在、可恢复），与反思阶段的"销毁证据"不同 —— 保真策略若一律
   * 禁 merge，整合就永远只能 extract，等于每次运行都在重复摘要（merged 恒 0）。
   * 这里只放行 merge，delete/split 仍然禁止；逐字库的 merge 拒绝保持不动。
   */
  consolidation?: boolean;
}

export async function applyReflectActions(actions: ReflectAction[], characterId: string = CHAR_ID, project?: string, options: ReflectApplyOptions = {}): Promise<{
  applied: number;
  errors: string[];
  details: string[];
  receipts: ReflectReceipt[];
}> {
  const db = DatabaseManager.getInstance(project);
  const result = { applied: 0, errors: [] as string[], details: [] as string[], receipts: [] as ReflectReceipt[] };

  for (let action of actions) {
    const receipt: ReflectReceipt = {
      action: action.action,
      status: 'applied',
      targetId: (action as any).targetId || (action as any).sourceId || null,
      reason: '',
      rowsAffected: 0,
    };
    try {
      action = { ...action };
      // v1.23-fix: 整合模式放行 merge（合并结果落库后再软删源，内容可回查）；其余破坏性动作照旧禁止。
      const mergeAllowedByConsolidation = options.consolidation === true && action.action === 'merge';
      if (options.automatic && !mergeAllowedByConsolidation && (['merge', 'delete', 'split'].includes(action.action) || (action.action === 'reclassify' && action.newText !== undefined))) throw new Error('emotional fidelity forbids destructive automatic reflection');
      if (action.action === 'reclassify') { action.newTypeSingle ??= action.newType; action.newCategorySingle ??= action.newCategory; }
      const ids = action.action === 'merge' ? action.sourceIds :
        [action.targetId, action.sourceId, action.targetIdRelate].filter((id): id is string => !!id);
      if (ids) {
        if (options.allowedSourceIds && ids.some(id => !options.allowedSourceIds!.has(id))) throw new Error('target is outside current reflection input');
        const resolved = ids.map(id => resolveReflectTarget(id, project, action.action === 'extract', characterId));
        if (resolved.some(target => !target)) throw new Error('target missing, inactive or ambiguous');
        if (action.action === 'merge') {
          action.sourceIds = resolved.map(target => target!.id);
          if (new Set(action.sourceIds).size !== action.sourceIds.length) throw new Error('duplicate merge sources');
        } else {
          let i = 0;
          if (action.targetId) action.targetId = resolved[i++]!.id;
          if (action.sourceId) action.sourceId = resolved[i++]!.id;
          if (action.targetIdRelate) action.targetIdRelate = resolved[i++]!.id;
        }
      }
      switch (action.action) {
        case 'merge': {
          // 合并多个记忆为一个
          if (!action.sourceIds || action.sourceIds.length < 2 || !action.newText) {
            result.errors.push('merge: need sourceIds and newText');
            receipt.status = 'failed'; receipt.reason = 'need sourceIds and newText';
            result.receipts.push(receipt);
            continue;
          }
          // 先完整校验所有源，再执行任何软删除；避免混合合法/非法 ID 造成部分破坏。
          const mergeSources: { db: any; id: string }[] = [];
          let mergeInvalid: string | null = null;
          for (const id of action.sourceIds!) {
            const sdb = memDbFor(id, project, db, characterId);
            // 原料行（对话流水 / 事件层 / 状态快照）不接受整合合并：它们是"原文与导航层"，
            // 不是可再生的摘要 —— 合并只留一份改写稿，原文就再也回不来了（2026-10-30）。
            const src = sdb.prepare("SELECT id FROM memory WHERE id = ? AND is_active = 1 AND (locked IS NULL OR locked = 0) AND COALESCE(tier, 'standard') <> 'critical' AND COALESCE(source, '') NOT IN ('conversation_log', 'daily_event', 'agent_state', 'agent_diary')").get(id) as any;
            if (!src) { mergeInvalid = `source not found, locked, critical, or raw-material: ${id}`; break; }
            mergeSources.push({ db: sdb, id: src.id });
          }
          if (mergeInvalid) {
            receipt.status = 'failed'; receipt.reason = mergeInvalid;
            result.errors.push(`merge: ${mergeInvalid}`);
            result.receipts.push(receipt);
            continue;
          }
          // 先成功写入合并结果，再删除源；若嵌入/数据库写入失败，源记忆保持完整。
          // saveMemory 是 async，跨 memType 删除无法使用单一 SQLite transaction。
          const { saveMemory } = await import('./store.js');
          const merged = await saveMemory({
            text: action.newText,
            type: (action.newType || 'semantic') as any,
            // v1.10: merge 支持 newMemType — 记忆整合输出保持 4 种封闭类型之一
            memType: isMemType(action.newMemType) ? action.newMemType as MemType : undefined,
            category: action.newCategory || 'general',
            tags: action.newTags || [],
            importance: action.newImportance ?? 0.7,
            characterId,
            project,
            source: 'reflect_merge',
          });
          receipt.rowsAffected = mergeSources.length;
          // 所有源均已确认 active 且合并结果已落库后，才软删除并清理向量。
          for (const src of mergeSources) {
            if (src.id === merged.id) continue;
            src.db.prepare("UPDATE memory SET is_active = 0 WHERE id = ? AND is_active = 1 AND (locked IS NULL OR locked = 0) AND COALESCE(tier, 'standard') <> 'critical' AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").run(src.id);
            try {
              const row = src.db.prepare('SELECT rowid FROM memory WHERE id = ?').get(src.id) as any;
              if (row) src.db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(row.rowid);
            } catch { /* 无向量时不阻断合并 */ }
          }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`merge: ${action.sourceIds.length} → 1`);
          break;
        }

        case 'split': {
          if (!action.targetId || !action.fragments?.length ||
              action.fragments.some(f => !f.text?.trim())) {
            throw new Error('split: need targetId and non-empty fragments');
          }
          const source = resolveReflectTarget(action.targetId, project, false, characterId)!;
          const row = source.db.prepare("SELECT * FROM memory WHERE id = ? AND is_active = 1 AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").get(source.id) as any;
          if (!row || row.locked || row.identity_locked) throw new Error('split: target locked or inactive');
          // 2026-10-30: 原料行不可拆分/替换 —— 拆分会把源软删，原文与事件引文就没了。
          if (['conversation_log', 'daily_event', 'agent_state', 'agent_diary'].includes(String(row.source || ''))) {
            throw new Error('split: raw-material row is immutable');
          }
          const children = [];
          for (const frag of action.fragments) {
            children.push(await saveMemory({
              text: frag.text, type: (frag.type as any) || 'episodic',
              memType: row.mem_type, category: frag.category || row.category || 'conversation',
              tags: frag.tags || [], importance: frag.importance ?? 0.5,
              characterId, project, source: 'reflect_split',
            }));
          }
          if (!children.some(child => child.id === source.id)) {
            source.db.prepare("UPDATE memory SET is_active = 0 WHERE id = ? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").run(source.id);
            try { source.db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(source.id); } catch { /* optional vectors */ }
          }
          receipt.rowsAffected = children.length;
          result.applied++;
          result.details.push(`split: 1 → ${children.length}`);
          break;
        }

        case 'relate': {
          if (!action.sourceId || !action.targetIdRelate || !action.relationType) {
            result.errors.push('relate: need sourceId, targetIdRelate, relationType');
            receipt.status = 'failed'; receipt.reason = 'need sourceId, targetIdRelate, relationType';
            result.receipts.push(receipt);
            continue;
          }
          // 护栏：规范化 relation type
          const relType = VALID_RELATIONS.has(action.relationType) ? action.relationType : 'related_to';
          const edgeId = `edge_reflect_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
          const _relR = memDbFor(action.sourceId, project, db, characterId).prepare('INSERT OR IGNORE INTO edges (id, source_id, target_id, relation_type) VALUES (?, ?, ?, ?)')
            .run(edgeId, action.sourceId, action.targetIdRelate, relType);
          receipt.rowsAffected = _relR.changes;
          if (_relR.changes === 0) { receipt.status = 'failed'; receipt.reason = `edge exists or node missing: ${action.sourceId}→${action.targetIdRelate}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`relate: ${action.sourceId} → ${action.targetIdRelate} (${relType})`);
          break;
        }

        case 'reclassify': {
          // v5.1: 兼容 LLM 可能用的 sourceId 或 targetId
          const tid = action.targetId || (action as any).sourceId;
          if (!tid) {
            result.errors.push('reclassify: need targetId or sourceId');
            receipt.status = 'failed'; receipt.reason = 'need targetId or sourceId';
            result.receipts.push(receipt);
            continue;
          }
          const updates: string[] = [];
          const values: any[] = [];
          // 护栏：拒绝无效 type/category
          if (action.newTypeSingle) {
            if (!VALID_TYPES.has(action.newTypeSingle)) {
              result.errors.push(`reclassify: invalid type "${action.newTypeSingle}", skipped`);
              receipt.status = 'failed'; receipt.reason = `invalid type "${action.newTypeSingle}"`;
              result.receipts.push(receipt);
            continue;
            }
            updates.push('type = ?'); values.push(action.newTypeSingle);
          }
          if (action.newCategorySingle) {
            if (!VALID_CATEGORIES.has(action.newCategorySingle)) {
              result.errors.push(`reclassify: invalid category "${action.newCategorySingle}", skipped`);
              receipt.status = 'failed'; receipt.reason = `invalid category "${action.newCategorySingle}"`;
              result.receipts.push(receipt);
            continue;
            }
            updates.push('category = ?'); values.push(action.newCategorySingle);
          }
          if (action.newMemType) {
            if (!isMemType(action.newMemType)) {
              result.errors.push(`reclassify: invalid memType "${action.newMemType}", skipped`);
              receipt.status = 'failed'; receipt.reason = `invalid memType "${action.newMemType}"`;
              result.receipts.push(receipt);
            continue;
            }
            updates.push('mem_type = ?'); values.push(action.newMemType as MemType);
          }
          if (action.newTags) {
            const valid = safeTags(action.newTags);
            if (!valid) {
              result.errors.push('reclassify: invalid tags (must be string array), skipped');
              receipt.status = 'failed'; receipt.reason = 'invalid tags';
              result.receipts.push(receipt);
            continue;
            }
            updates.push('tags = ?'); values.push(serializeTags(valid));
          }
          // v2.0: reclassify 支持 newText — 时间规范化检查把相对时间改写为绝对日期
          if (action.newText !== undefined && action.newText !== null) {
            if (typeof action.newText !== 'string' || action.newText.trim().length === 0) {
              result.errors.push('reclassify: newText must be a non-empty string, skipped');
              receipt.status = 'failed'; receipt.reason = 'invalid newText';
              result.receipts.push(receipt);
            continue;
            }
            updates.push('text = ?'); values.push(action.newText.trim());
          }
          if (updates.length > 0) {
            const _tdb = memDbFor(tid, project, db, characterId);
            const existing = _tdb.prepare("SELECT * FROM memory WHERE id = ? AND is_active = 1 AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").get(tid) as any;
            if (!existing || existing.locked || existing.identity_locked) throw new Error('target locked or inactive');
            const patch: any = { project };
            const names: Record<string, string> = { type: 'type', category: 'category', tags: 'tags', mem_type: 'memType', text: 'text' };
            updates.forEach((field, i) => {
              const key = field.split(' = ')[0];
              patch[names[key]] = key === 'tags' ? JSON.parse(values[i]) : values[i];
            });
            const updated = await updateMemory(tid, patch, characterId);
            const _recR = { changes: updated ? 1 : 0 };
            receipt.rowsAffected = _recR.changes;
            if (_recR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found: ${tid}`; }
            // 文本变更后旧向量失效:删向量,后续 reflect_batch_embed 重新向量化
            if (_recR.changes > 0 && updates.includes('text = ?')) {
              try {
                const info = _tdb.prepare('SELECT rowid FROM memory WHERE id = ? LIMIT 1').get(tid) as any;
                if (info) _tdb.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(info.rowid));
              } catch {}
            }
            if (receipt.status === 'applied') result.applied++;
            result.details.push(`reclassify: ${tid}`);
          }
          break;
        }

        case 'extract': {
          // v5.0: 从源记忆中提取有效信息为新记忆（不删除源）
          if (!action.sourceId || !action.newText) {
            result.errors.push('extract: need sourceId and newText');
            receipt.status = 'failed'; receipt.reason = 'need sourceId and newText';
            result.receipts.push(receipt);
            continue;
          }
          const validType = action.newType && VALID_TYPES.has(action.newType) ? action.newType : 'semantic';
          const validCat = action.newCategory && VALID_CATEGORIES.has(action.newCategory) ? action.newCategory : 'general';
          const validMemType = isMemType(action.newMemType) ? action.newMemType as MemType : undefined;
          const validTags = safeTags(action.newTags) || [];
          const importance = action.newImportance ?? 0.6;
          const tier = (action.tier && ['temporary','standard','critical'].includes(action.tier))
            ? action.tier as 'temporary'|'standard'|'critical' : 'standard';

          const { saveMemory } = await import('./store.js');
          const sourceTarget = resolveReflectTarget(action.sourceId, project, true, characterId)!;
          const sourceRow = sourceTarget.db.prepare("SELECT * FROM memory WHERE id = ? AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')").get(sourceTarget.id) as any;
          // v1.23: 引用校验 —— 只有能在原文子串命中的引用才保留（防编造原话）
          const sourceText = String(sourceRow?.text || '');
          const quoteClean = (q: string) => String(q).replace(/^[「『"']+|[」』"']+$/g, '').trim();
          const validQuotes = (Array.isArray(action.quotes) ? action.quotes : [])
            .map(quoteClean)
            .filter((q: string) => q.length >= 4 && (!sourceText || sourceText.includes(q)))
            .slice(0, 6);
          const textWithQuotes = validQuotes.length
            ? `${String(action.newText).trimEnd()}\n\n【原文引用】\n${validQuotes.map((q: string) => `> ${q}`).join('\n')}`
            : action.newText;
          const extracted = await saveMemory({
            text: textWithQuotes,
            type: validType as any,
            memType: validMemType,
            category: validCat,
            tags: validTags,
            importance,
            tier,
            characterId,
            project,
            source: 'reflect_extract',
            subject: ['user', 'self', 'environment'].includes(action.newSubject || '') ? action.newSubject : sourceRow.subject || 'user',
            emotionalImpact: validMemType === 'project' ? sourceRow.emotional_impact ?? 0 : 0,
          });

          const extractedDb = findDbByMemoryId(extracted.id, project)!.db;
          const oldMeta = extractedDb.prepare('SELECT metadata FROM memory WHERE id = ?').get(extracted.id) as any;
          let meta: any = {};
          try { meta = JSON.parse(oldMeta?.metadata || '{}'); } catch {}
          meta.reflection = { ...meta.reflection, project: normalizeProject(project), sourceIds: [...new Set([...(meta.reflection?.sourceIds || []), action.sourceId])] };
          extractedDb.prepare('UPDATE memory SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), extracted.id);
          // v1.23 Parent-Child：leaf 指回对话原文，检索时按 parent_id 回捞
          try { extractedDb.prepare('UPDATE memory SET parent_id = ? WHERE id = ?').run(action.sourceId, extracted.id); } catch { /* 旧库未迁移 */ }
          if (validMemType === 'project') {
            const fields = ['agent_mood', 'agent_desire', 'vad_valence', 'vad_arousal', 'vad_dominance', 'tsundere_level'];
            extractedDb.prepare(`UPDATE memory SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(f => sourceRow[f] ?? null), extracted.id);
          }

          // v1.23 hardFacts 直接进 facts 表（带证据与时间有效性）。这一步替代"把事实写进散文"。
          if (Array.isArray(action.hardFacts) && action.hardFacts.length) {
            try {
              const { saveFacts } = await import('./store.js');
              // Anima 的 facts 表恒在 general 库;extract 可能落到 project/user/feedback/reference 库,
              // 跨库挂 source_memory_id 会触发 FOREIGN KEY。故来源恒为 NULL —— 溯源由 extract 记忆承担。
              const facts = action.hardFacts
                .filter((f: any) => f && typeof f === 'object' && f.subject && f.predicate && f.object)
                .slice(0, 15)
                .map((f: any) => ({
                  subject: String(f.subject).trim(),
                  predicate: String(f.predicate).trim(),
                  object: String(f.object).trim(),
                  confidence: Number.isFinite(Number(f.confidence)) ? Math.min(1, Math.max(0, Number(f.confidence))) : 0.7,
                  evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
                  validFrom: typeof f.validFrom === 'string' ? f.validFrom : undefined,
                  validTo: typeof f.validTo === 'string' ? f.validTo : undefined,
                }));
              if (facts.length) await saveFacts(facts, null, characterId, project);
            } catch (e: any) {
              // 事实是"提取之外的富化"：失败只记在回执里，绝不能把整批打回重跑。
              console.error('[reflect] hardFacts skipped:', e.message);
              receipt.reason = `facts: ${e.message}`;
            }
          }

          // v1.23 同主题/接续：只建链接、不覆盖旧记忆（mem0 linked_memory_ids 思路）
          for (const linkedId of (Array.isArray(action.linkedMemoryIds) ? action.linkedMemoryIds : []).slice(0, 10)) {
            if (typeof linkedId !== 'string' || linkedId === action.sourceId) continue;
            const target = resolveReflectTarget(linkedId, project, false, characterId);
            if (!target) continue;
            try {
              const row = target.db.prepare('SELECT metadata, locked, tier FROM memory WHERE id = ?').get(target.id) as any;
              if (!row || row.locked || row.tier === 'critical') continue;
              let meta: any = {};
              try { meta = JSON.parse(row.metadata || '{}'); } catch { /* 自由格式 metadata 忽略 */ }
              meta.supersededBy = [...new Set([...(Array.isArray(meta.supersededBy) ? meta.supersededBy : []), extracted.id])];
              target.db.prepare("UPDATE memory SET metadata = ?, status = 'superseded' WHERE id = ?").run(JSON.stringify(meta), target.id);
            } catch { /* 链接失败不影响提取 */ }
          }

          receipt.rowsAffected = 1;
          // 给源记忆 +reference_count（v5.1: LIKE 匹配短ID）
          memDbFor(action.sourceId, project, db, characterId).prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(action.sourceId);

          if (receipt.status === 'applied') result.applied++;
          result.details.push(`extract: from ${action.sourceId} → ${validType}/${validCat} (${tier})`);
          break;
        }

        case 'delete': {
          if (!action.targetId) {
            result.errors.push('delete: need targetId');
            receipt.status = 'failed'; receipt.reason = 'need targetId';
            result.receipts.push(receipt);
            continue;
          }
          // v1.23: critical 核心记忆不得被自动反思删除
          // 2026-10-30: 原料行（对话流水/事件层/状态快照）同样不得被删除 —— 原文永不删除是这套记忆的地基，
          //   事件层则带着逐字引文与来源 rowid，重建需要重跑且 progress 表已经挡掉重跑。
          const _delR = memDbFor(action.targetId, project, db, characterId).prepare("UPDATE memory SET is_active = 0 WHERE id = ? AND (locked IS NULL OR locked = 0) AND COALESCE(identity_locked, 0) = 0 AND COALESCE(tier, 'standard') <> 'critical' AND COALESCE(source, '') NOT IN ('conversation_log', 'daily_event', 'agent_state', 'agent_diary')").run(action.targetId);
          receipt.rowsAffected = _delR.changes;
          if (_delR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found, locked, or raw-material: ${action.targetId}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`delete: ${action.targetId}`);
          break;
        }

        case 'boost': {
          if (!action.targetId || action.delta === undefined) {
            result.errors.push('boost: need targetId and delta');
            receipt.status = 'failed'; receipt.reason = 'need targetId and delta';
            result.receipts.push(receipt);
            continue;
          }
          const _boR = memDbFor(action.targetId, project, db, characterId).prepare("UPDATE memory SET importance = MIN(0.95, MAX(0.1, importance + ?)) WHERE id = ? AND (locked IS NULL OR locked = 0) AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')")
            .run(action.delta, action.targetId);
          receipt.rowsAffected = _boR.changes;
          if (_boR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found or locked: ${action.targetId}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`boost: ${action.targetId} += ${action.delta}`);
          break;
        }

        case 'decay': {
          if (!action.targetId || action.delta === undefined) {
            result.errors.push('decay: need targetId and delta');
            receipt.status = 'failed'; receipt.reason = 'need targetId and delta';
            result.receipts.push(receipt);
            continue;
          }
          const _deR = memDbFor(action.targetId, project, db, characterId).prepare("UPDATE memory SET importance = MIN(0.95, MAX(0.1, importance - ?)) WHERE id = ? AND (locked IS NULL OR locked = 0) AND COALESCE(source, '') NOT IN ('agent_diary', 'agent_state')")
            .run(action.delta, action.targetId);
          receipt.rowsAffected = _deR.changes;
          if (_deR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found or locked: ${action.targetId}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`decay: ${action.targetId} -= ${action.delta}`);
          break;
        }

        default:
          result.errors.push(`unknown action: ${action.action}`);
          receipt.status = 'skipped'; receipt.reason = `unknown action: ${action.action}`;
      }
    } catch (e: any) {
      result.errors.push(`${action.action}: ${e.message}`);
      receipt.status = 'failed'; receipt.reason = e.message;
    }
    if (receipt.status === 'failed' && receipt.reason && !result.errors.some(e => e.includes(receipt.reason))) {
      result.errors.push(`${receipt.action}: ${receipt.reason}`);
    }
    result.receipts.push(receipt);
  }

  // ═══ v5.0: 批量向量化 digest 阶段跳过的记忆(按项目隔离) ═══
  try {
    const batchResult = await batchEmbedPending(characterId, project);
    if (batchResult.embedded > 0) {
      result.details.push(`batch embedded ${batchResult.embedded} pending memories`);
    }
    // Embedding 是可选增强：离线/EMBED_MODE=none 时不能把已成功落库的反思判成失败
    // （否则新的失败退避会把整轮反思拦 1h，且游标看起来永远不前进）。
    if (batchResult.errors.length > 0 && batchResult.errors.some(e => !e.includes('embedding disabled'))) {
      console.error('[reflect] batch embed (optional):', batchResult.errors.join('; '));
      result.details.push('batch embed warnings: ' + batchResult.errors.join('; '));
    }
  } catch (e: any) {
    result.errors.push(`batch embed: ${e.message}`);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 导出别名 — 供 proxy.py / _memory_engine.mjs 调用
// ═══════════════════════════════════════════════════════════

/** 获取所有记忆（别名，供外部调用） */
export function getAllMemories(characterId: string = CHAR_ID, limit: number = 200, project?: string): ReflectMemory[] {
  return listAllMemories(characterId, limit, project);
}

/** 获取记忆关联图 */
export function getMemoryGraph(characterId: string = CHAR_ID, project?: string): { nodes: any[]; edges: any[] } {
  const proj = normalizeProject(project);
  const nodes = listAllMemories(characterId, 500, proj);
  const nodeIds = new Set(nodes.map((n: any) => n.id));
  let edgeRows: any[] = [];
  if (nodeIds.size > 0) {
    // v1.27-fix: 原来只过滤 source_id IN (...),目标节点在集合里的边会被漏掉(图看着比实际稀疏)。
    const ph = [...nodeIds].map(() => '?').join(',');
    // Edges are stored in the source memory's memType database. Query every
    // project partition, and bind the role/project on both endpoints; the
    // old general-only query could return a foreign-role endpoint or a stale
    // diary edge when an edge row was present in another partition.
    const cid = characterId || CHAR_ID;
    const diaryIds = new Set<string>();
    for (const mt of listMemTypeDirs(proj)) {
      const db = DatabaseManager.getInstance(proj, mt);
      try {
        for (const row of db.prepare("SELECT id FROM memory WHERE project = ? AND source = 'agent_diary'").all(proj) as any[]) {
          diaryIds.add(String(row.id));
        }
      } catch { /* legacy schema */ }
      try {
        edgeRows.push(...db.prepare(`
          SELECT e.id, e.source_id, e.target_id, e.relation_type,
                 m1.text as source_text, m2.text as target_text
          FROM edges e
          JOIN memory m1 ON e.source_id = m1.id
          JOIN memory m2 ON e.target_id = m2.id
          WHERE (e.source_id IN (${ph}) OR e.target_id IN (${ph}))
            AND m1.project = ? AND m1.is_active = 1
            AND COALESCE(m1.source, '') NOT IN ('agent_diary', 'agent_state')
            AND (? = 'any' OR m1.character_id = ?)
            AND m2.project = ? AND m2.is_active = 1
            AND COALESCE(m2.source, '') NOT IN ('agent_diary', 'agent_state')
            AND (? = 'any' OR m2.character_id = ?)
        `).all(...nodeIds, ...nodeIds, proj, cid, cid, proj, cid, cid) as any[]);
      } catch { /* one damaged partition must not hide the remaining graph */ }
    }
    edgeRows = edgeRows.filter((row) => !diaryIds.has(String(row.source_id)) && !diaryIds.has(String(row.target_id)));
  }

  const edges = edgeRows.map(r => ({
    id: r.id,
    sourceId: r.source_id,
    targetId: r.target_id,
    relationType: r.relation_type,
    sourceText: r.source_text?.substring(0, 60),
    targetText: r.target_text?.substring(0, 60),
  }));

  return { nodes, edges };
}

/** 编排函数 — 供 proxy.py 通过 _memory_engine.mjs 调用 */

// ═══════════════════════════════════════════════════════════════════
// 统一反思接口 — 大模型一次性输出 summary + facts + insights + actions
// ═══════════════════════════════════════════════════════════════════

const BUILTIN_REFLECT_SYSTEM_PROMPT = `你是记忆反思引擎。你的任务是对 AI 和用户的对话进行深度总结，提取结构化事实，并给出记忆整理建议。

输入：最近 N 轮未分析的对话原文
输出：严格JSON，格式如下：

{
  "summary": "自然语言总结（2-4句话）：概括这段时间用户做了什么、聊了什么、情绪状态如何",
  "highlights": ["关键事件1", "关键事件2"],
  "facts": [
    {"subject": "user", "predicate": "姓名", "object": "示例用户", "confidence": 0.95},
    {"subject": "user", "predicate": "职业", "object": "程序员", "confidence": 0.9}
  ],
  "insights": ["关于用户性格/沟通风格/潜在需求的深层观察"],
  "actions": [
    {"action": "boost", "targetId": "mem_xxx", "delta": 0.2},
    {"action": "merge", "sourceIds": ["id1","id2"], "newText": "合并后的内容", "newImportance": 0.8}
  ]
}

【facts 提取规则】
- subject: "user"（关于用户）/ "agent"（关于AI角色）/ "environment"（关于环境）
- predicate: 使用这些预定义关系或自定义短语：
  姓名 / 年龄 / 职业 / 喜好 / 厌恶 / 技能 / 居住地 / 工作单位 / 项目 / 技术栈 / 习惯 / 目标 / 关系
- object: 事实的值
- confidence: 0(推测)~1.0(明确陈述)
- 如果用户修正了之前提到的事实，标记 "action": "update"
- 不提取情绪/临时状态
- 最多15条

【actions 规则】
- 仅当确实需要整理已有记忆时才产生 actions
- "boost" 用于升级重要记忆
- "merge" 用于合并重复记忆
- 不需要操作时 actions 为空数组 []`;

export const REFLECT_SYSTEM_PROMPT: string = loadPromptOverride('REFLECT_PROMPT_FILE', '') + '\n' + emotionalReflectPrompt();

/**
 * 获取待反思的未分析对话
 */
export interface ReflectResult {
  summary: string;
  highlights: string[];
  facts: { subject: string; predicate: string; object: string; confidence: number }[];
  insights: string[];
  actions?: ReflectAction[];
  processedSourceIds?: string[];
  /** 形状不合规而被丢弃的 facts 条数（见 reflectDriver.normalizeReflectResult）。 */
  factsDropped?: number;
}

/**
 * 应用大模型反思结果
 *
 * 一次性处理：
 *   1. summary → 存入 memory（source='reflect_summary'）
 *   2. facts → 调用 saveFacts() 写入 facts 表（自动去重）
 *   3. insights → 存入 memory（source='reflect_insight'）
 *   4. actions → 调用 applyReflectActions()
 */
export async function applyReflectResult(
  result: ReflectResult,
  characterId: string = CHAR_ID,
  project?: string,
  options: ReflectApplyOptions = {},
): Promise<{
  summaryId: string | null;
  factsInserted: number;
  factsUpdated: number;
  entitiesLinked: number;
  insightsCount: number;
  actionsApplied: number;
  errors: string[];
  warnings: string[];
  receipts: ReflectReceipt[];
}> {
  const out = {
    summaryId: null as string | null,
    factsInserted: 0,
    factsUpdated: 0,
    entitiesLinked: 0,
    insightsCount: 0,
    actionsApplied: 0,
    applied: 0,
    errors: [] as string[],
    warnings: [] as string[],
    receipts: [] as ReflectReceipt[],
  };

  // v1.23: 落库前先按来源算硬事实覆盖，不达标就把缺失的原句补成"证据附录"。
  attachEvidenceAppendix(result, project, out.warnings);

  // 4. 应用记忆整理 actions + 逐动作回执落盘
  if (result.actions && result.actions.length > 0) {
    try {
      const ar = await applyReflectActions(result.actions, characterId, project, options);
      out.actionsApplied = ar.applied;
      out.errors.push(...ar.errors);
      out.receipts = ar.receipts;
      // ═══ v1.3: 回执落盘 — 失败动作原文存档,事后可人工修正 ═══
      try {
        const dir = process.env.REFLECT_RECEIPT_DIR || path.join(currentMemDir(), 'receipts');
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(dir, `reflect-receipt-${ts}.json`),
          JSON.stringify({
            ts: new Date().toISOString(),
            characterId,
            project: normalizeProject(project),
            inputIds: [...(options.allowedSourceIds || [])],
            actionCount: result.actions.length,
            applied: ar.applied,
            failed: ar.receipts.filter(r => r.status !== 'applied').length,
            actions: result.actions,
            receipts: ar.receipts,
            errors: ar.errors,
          }, null, 2),
          'utf-8',
        );
      } catch (e: any) {
        out.errors.push(`receipt write: ${e.message}`);
      }
    } catch (e: any) {
      out.errors.push(`actions: ${e.message}`);
    }
  }

  if (out.errors.length) return out;

  // 1. 存 summary
  // 注意：1~3 都是**提取成功之后的富化**。提取已落库并写了回执，富化失败若升级成 error，
  // 驱动会在 markConversationsReflected 之前 break，同一批来源永远重跑（2026-10-23 事故：
  // facts 形状不符 → NOT NULL → 无限重复提取）。所以富化失败只记 warning，不阻断游标。
  if (result.summary) {
    try {
      const mem = await saveMemory({
        text: result.summary,
        type: 'semantic',
        memType: 'project',
        category: 'emotional',
        tags: result.highlights || [],
        importance: 0.7,
        characterId,
        project,
        source: 'reflect_summary',
        subject: 'self',
      });
      out.summaryId = mem.id;
    } catch (e: any) {
      out.warnings.push(`summary: ${e.message}`);
    }
  }

  // 2. 存 facts（自动去重，confidence 取 MAX）
  // facts 表是 SPO 三元组；模型偶尔给字符串或 {sourceId,text}，saveFacts 不接受。
  const facts = (result.facts || []).filter(
    (f: any) => f && typeof f === 'object' && f.subject && f.predicate && f.object,
  );
  if (facts.length > 0) {
    try {
      // Anima 的 summary 落在 project 分类库，facts 落在 general 库；facts.source_memory_id
      // 有 FK 指向 memory(id)，跨库引用会 FOREIGN KEY 失败（历史上 facts 因此一直没写进去）。
      // 这里不挂 summary 做来源，facts 的溯源由 extract 记忆承担。
      const fr = await saveFacts(facts, null, characterId, project);
      out.factsInserted = fr.inserted;
      out.factsUpdated = fr.updated;
      // v1.27: 把摘要记忆挂到这批事实的实体上。
      // facts 落在 general 库、摘要在 project 库,所以不能写 facts.source_memory_id(撞 FK);
      // 但 memory_entities 没有 FK,用全局 UUID 关联即可 —— 否则"记忆里有实体"的覆盖率只有个位数。
      if (out.summaryId) {
        try {
          const { DatabaseManager } = await import('./db.js');
          const { entityIdsOfFacts, linkMemoryToEntityIds } = await import('./entities.js');
          const ids = entityIdsOfFacts(facts);
          if (ids.length) {
            const db = DatabaseManager.getInstance(project);
            out.entitiesLinked = linkMemoryToEntityIds(db, out.summaryId, ids, 'fact');
          }
        } catch (e: any) {
          out.warnings.push(`entity-link: ${e.message}`);
        }
      }
    } catch (e: any) {
      out.warnings.push(`facts: ${e.message}`);
    }
  }

  // 3. 存 insights
  if (result.insights && result.insights.length > 0) {
    for (const insight of result.insights) {
      try {
        await saveMemory({
          text: insight,
          type: 'semantic',
          category: 'knowledge',
          importance: 0.6,
          characterId,
          project,
          source: 'reflect_insight',
          subject: 'user',
        });
        out.insightsCount++;
      } catch (e: any) {
        out.warnings.push(`insight: ${e.message}`);
      }
    }
  }


  return out;
}

/** 编排函数 — 供 proxy.py 通过 _memory_engine.mjs 调用 */
export async function reflect(action: string, params: Record<string, any> = {}): Promise<any> {
  switch (action) {
    case 'list':
      return listAllMemories(params.characterId || CHAR_ID, params.limit || 200, params.project);

    case 'unanalyzed': {
      // 获取待反思的未分析对话 + prompt
      const conversations = getUnanalyzedConversations(
        params.characterId || CHAR_ID,
        params.since,
        params.limit || 30,
        params.project,
      );
      const prompt = JSON.stringify(conversations);
      return {
        conversationCount: conversations.length,
        systemPrompt: REFLECT_SYSTEM_PROMPT,
        userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt}`,
        conversationIds: conversations.map(c => c.id),
      };
    }

    case 'apply': {
      if (!params.actions || params.actions.length === 0) {
        return { applied: 0, errors: ['no actions to apply'] };
      }
      return applyReflectResult(params as ReflectResult, params.characterId || CHAR_ID, params.project);
    }

    case 'merge':
    case 'split':
    case 'relate':
    case 'reclassify':
    case 'delete':
    case 'boost':
    case 'decay':
      return applyReflectActions([{ action, ...params } as ReflectAction], params.characterId || CHAR_ID, params.project);

    case 'batch':
      if (!Array.isArray(params.actions)) {
        return { error: 'batch action requires "actions" array' };
      }
      return applyReflectActions(params.actions as ReflectAction[], params.characterId || CHAR_ID, params.project);

    case 'auto': {
      const allMemories = listAllMemories(params.characterId || CHAR_ID, params.limit || 200, params.project);
      const graph = getMemoryGraph(params.characterId || CHAR_ID, params.project);
      return {
        ready: true,
        memoryCount: allMemories.length,
        edgeCount: graph.edges.length,
        memories: allMemories,
        edges: graph.edges,
        hint: 'Use "batch" action with an "actions" array to apply changes',
      };
    }

    default:
      return { error: `unknown reflect action: "${action}". Valid: list, unanalyzed, apply, merge, split, relate, reclassify, delete, boost, decay, batch, auto` };
  }
}
