/**
 * Anima Bias Layer — topic weight accumulation
 * Inspired by the emotional-variant design: letting memory shape personality over time
 *
 * As conversations accumulate, the agent develops topic preferences.
 * High-weight topics surface relevant memories more readily
 * and subtly tilt the injection context toward familiar ground.
 *
 * This is NOT the same as preferences (which are explicit choices).
 * Bias weights are EMERGENT — they accumulate from conversation patterns.
 */
import { DatabaseManager } from './db.js';
import { normalizeProject } from './env.js';
import { parseTagsSafe } from './tags.js';
import { publicMemorySourceSql } from './memoryProvenance.js';
// In-memory topic weights per (project, character) — v1.23.2 审计第 3 组：
// 只按 characterId 做键会让不同项目的兴趣权重互相污染。
const biasMaps = new Map();
/** 偏差层键：project 前缀 + charId；project 缺省走 normalizeProject。 */
function biasKey(characterId, project) {
    return `${normalizeProject(project)}|${characterId || ''}`;
}
function biasMapFor(characterId, project) {
    const key = biasKey(characterId, project);
    let map = biasMaps.get(key);
    if (!map) {
        map = new Map();
        biasMaps.set(key, map);
    }
    return map;
}
// Decay: topics not mentioned for 30 days lose half their weight
const BIAS_DECAY_HALF_LIFE_DAYS = 30;
const BIAS_DECAY_RATE = Math.LN2 / (BIAS_DECAY_HALF_LIFE_DAYS * 24);
/**
 * Record topic mentions from a conversation.
 * Call this after each conversation turn.
 *
 * `at`（2026-10-31）：这次提及对应的**真实发生时间**。冷启动从库里回填时必须传
 * 记忆的 created_at —— 否则每次重启都会把三个月前的话题按"刚刚又提了一次"记入，
 * 旧兴趣被重启刷成新兴趣（审计报告 §5 第 3 项）。缺省仍取当前时间。
 */
export function recordTopics(characterId, topics, project, at) {
    const map = biasMapFor(characterId, project);
    const now = Number.isFinite(at) && at > 0 ? at : Date.now();
    for (const topic of topics) {
        const key = topic.toLowerCase().trim();
        if (!key)
            continue;
        const existing = map.get(key);
        if (existing) {
            existing.weight = Math.min(10, existing.weight + 0.5);
            existing.lastSeen = now;
            existing.mentionCount++;
        }
        else {
            map.set(key, {
                topic: key,
                weight: 1,
                lastSeen: now,
                mentionCount: 1,
            });
        }
    }
}
/**
 * Get current topic biases with time decay applied.
 */
export function getBiases(characterId, limit = 10, project) {
    const map = biasMaps.get(biasKey(characterId, project));
    if (!map)
        return [];
    const now = Date.now();
    const results = [];
    for (const [key, tw] of map) {
        const hoursSince = (now - tw.lastSeen) / (1000 * 60 * 60);
        const decayedWeight = tw.weight * Math.exp(-BIAS_DECAY_RATE * hoursSince);
        if (decayedWeight > 0.1) {
            results.push({ ...tw, weight: Math.round(decayedWeight * 100) / 100 });
        }
        else {
            map.delete(key); // Prune dead topics
        }
    }
    results.sort((a, b) => b.weight - a.weight);
    return results.slice(0, limit);
}
/**
 * Get top topics as a simple string for prompt injection.
 */
export function getBiasPrompt(characterId, project) {
    const biases = getBiases(characterId, 5, project);
    if (biases.length === 0)
        return '';
    const topicStr = biases.map(b => `${b.topic}(${b.weight.toFixed(1)})`).join('、');
    return `[兴趣倾向] ${topicStr}`;
}
/**
 * Adjust memory search scores based on topic biases.
 * Memories matching high-bias topics get a score boost.
 */
export function computeBiasBoost(characterId, memoryTags, project) {
    const map = biasMaps.get(biasKey(characterId, project));
    if (!map || memoryTags.length === 0)
        return 1.0;
    const now = Date.now();
    let maxBoost = 0;
    for (const tag of memoryTags) {
        const key = tag.toLowerCase().trim();
        const tw = map.get(key);
        if (tw) {
            const hoursSince = (now - tw.lastSeen) / (1000 * 60 * 60);
            const decayedWeight = tw.weight * Math.exp(-BIAS_DECAY_RATE * hoursSince);
            maxBoost = Math.max(maxBoost, decayedWeight);
        }
    }
    // Convert weight (0-10) to boost multiplier (1.0-1.5)
    return 1 + Math.min(0.5, maxBoost * 0.05);
}
/**
 * Load topic biases from existing memory tags on startup.
 */
const _biasesLoaded = new Set();
export function loadBiasesFromDb(characterId, project) {
    const proj = normalizeProject(project);
    const key = biasKey(characterId, proj);
    if (_biasesLoaded.has(key))
        return; // v5.3: prevent double-load from AgentState (now per project)
    _biasesLoaded.add(key);
    try {
        const staged = [];
        for (const mt of DatabaseManager.existingMemTypes(proj)) {
            try {
                const db = DatabaseManager.getInstance(proj, mt);
                const rows = db.prepare(`
          SELECT tags, created_at, updated_at FROM memory WHERE project = ? AND character_id = ? AND is_active = 1
            AND ${publicMemorySourceSql()}
        `).all(proj, characterId);
                for (const row of rows) {
                    try {
                        // v1.28-fix: 走唯一共享解码入口 —— 非字符串元素不再下传给 recordTopics/tag.toLowerCase()
                        const tags = parseTagsSafe(row.tags);
                        if (tags.length === 0)
                            continue;
                        const at = Date.parse(String(row.created_at || row.updated_at || '')) || 0;
                        staged.push({ tags, at });
                    }
                    catch { /* 脏 tags 忽略 */ }
                }
            }
            catch { /* 单库失败不影响其它库 */ }
        }
        // 时间升序：同一 tag 多次出现时，最后一次写入决定 lastSeen（= 最新那次真实提及）
        staged.sort((a, b) => a.at - b.at);
        // 缺时间戳的行（旧库没有 created_at）用已知最早时间兜底，绝不退回 Date.now()
        const known = staged.filter(s => s.at > 0).map(s => s.at);
        const fallbackAt = known.length ? Math.min(...known) : 0;
        for (const item of staged) {
            const at = item.at > 0 ? item.at : fallbackAt;
            recordTopics(characterId, item.tags, proj, at > 0 ? at : undefined);
        }
    }
    catch (e) {
        // DB not ready yet
    }
}
//# sourceMappingURL=bias.js.map