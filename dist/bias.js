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
 */
export function recordTopics(characterId, topics, project) {
    const map = biasMapFor(characterId, project);
    const now = Date.now();
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
        const allTags = [];
        // v1.23.2-fix: 冷启动回填所有已存在的分类库（此前只看 general，user/project 里的 tags 丢了）
        for (const mt of DatabaseManager.existingMemTypes(proj)) {
            try {
                const db = DatabaseManager.getInstance(proj, mt);
                const rows = db.prepare(`
          SELECT tags FROM memory WHERE project = ? AND character_id = ? AND is_active = 1
        `).all(proj, characterId);
                for (const row of rows) {
                    try {
                        const tags = JSON.parse(row.tags || '[]');
                        if (Array.isArray(tags))
                            allTags.push(...tags);
                    }
                    catch { /* 脏 tags 忽略 */ }
                }
            }
            catch { /* 单库失败不影响其它库 */ }
        }
        if (allTags.length > 0) {
            recordTopics(characterId, allTags, proj);
        }
    }
    catch (e) {
        // DB not ready yet
    }
}
