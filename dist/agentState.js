/**
 * Anima Agent State — real-time self-state management
 *
 * Inspired by 千问's architecture suggestion:
 * - Short-term state in memory (not persisted to long-term memory)
 * - Mood aggregation with exponential decay (half-life ~7 hours)
 * - Desire lifecycle management
 *
 * Usage:
 *   const state = getAgentState('airi');
 *   state.addMood(8, '被夸奖了');
 *   state.setDesire('想听更多故事');
 *   const snapshot = state.getSnapshot();
 */
import { DatabaseManager } from './db.js';
import { normalizeProject } from './env.js';
import { loadBiasesFromDb } from './bias.js';
// In-memory state per character (not persisted)
const agentStates = new Map();
class AgentState {
    characterId;
    project;
    moodHistory = [];
    currentDesire = null;
    energy = 100;
    lastUpdated = Date.now();
    // Mood decay: half-life ~7 hours
    static MOOD_DECAY_RATE = 0.1;
    static MOOD_HALF_LIFE_HOURS = 7;
    constructor(characterId, project) {
        this.characterId = characterId;
        this.project = normalizeProject(project);
        this.loadFromDb();
        // Also load topic biases from existing memory tags (per project partition)
        loadBiasesFromDb(characterId, this.project);
    }
    /**
     * Load recent mood events from SQLite on startup.
     */
    loadFromDb() {
        try {
            // Mood snapshots belong to Anima's project memory partition.  The
            // default (general) partition is metadata/shared state and must not
            // be used here, otherwise agent mood leaks across harnesses.
            const db = DatabaseManager.getInstance(this.project, 'project');
            const rows = db.prepare(`
        SELECT text, emotional_impact, created_at
        FROM memory
        WHERE subject = 'self' AND agent_mood IS NOT NULL AND character_id = ? AND is_active = 1
        ORDER BY created_at DESC
        LIMIT 20
      `).all(this.characterId);
            this.moodHistory = rows.reverse().map(r => ({
                value: Math.max(-10, Math.min(10, Number(r.emotional_impact) || 0)),
                reason: r.text.replace(/^\[情绪快照\] /, '').replace(/，情绪值：[+-]?\d+$/, ''),
                timestamp: new Date(r.created_at).getTime(),
            }));
        }
        catch (e) {
            // DB not ready yet, start empty
        }
    }
    /**
     * Add a mood event. Automatically aggregates with decay.
     */
    addMood(value, reason) {
        const clamped = Math.max(-10, Math.min(10, Number.isFinite(Number(value)) ? Number(value) : 0));
        this.moodHistory.push({
            value: clamped,
            reason,
            timestamp: Date.now(),
        });
        // Keep only last 50 mood events
        if (this.moodHistory.length > 50) {
            this.moodHistory = this.moodHistory.slice(-50);
        }
        this.lastUpdated = Date.now();
        // Persist significant mood events as long-term memory
        if (Math.abs(clamped) >= 7) {
            this.persistMoodMemory(clamped, reason);
        }
    }
    /**
     * Set current desire. Overwrites previous desire.
     */
    setDesire(desire) {
        this.currentDesire = desire;
        this.lastUpdated = Date.now();
    }
    /**
     * Get current mood (aggregated with exponential decay).
     */
    getCurrentMood() {
        if (this.moodHistory.length === 0)
            return 0;
        const now = Date.now();
        let totalWeight = 0;
        let totalMood = 0;
        for (const event of this.moodHistory) {
            const hoursAgo = (now - event.timestamp) / (1000 * 60 * 60);
            const decay = Math.exp(-AgentState.MOOD_DECAY_RATE * hoursAgo);
            totalMood += event.value * decay;
            totalWeight += decay;
        }
        return totalWeight > 0 ? Math.round((totalMood / totalWeight) * 10) / 10 : 0;
    }
    /**
     * Get current energy (decreases over time, resets on interaction).
     */
    getCurrentEnergy() {
        const hoursSinceUpdate = (Date.now() - this.lastUpdated) / (1000 * 60 * 60);
        const decayed = this.energy * Math.exp(-0.05 * hoursSinceUpdate);
        return Math.round(Math.max(0, Math.min(100, decayed)));
    }
    /**
     * Boost energy (e.g., after positive interaction).
     */
    boostEnergy(amount) {
        this.energy = Math.min(100, this.energy + amount);
        this.lastUpdated = Date.now();
    }
    /**
     * Get full snapshot for prompt injection.
     */
    getSnapshot() {
        return {
            characterId: this.characterId,
            currentMood: this.getCurrentMood(),
            currentDesire: this.currentDesire,
            energy: this.getCurrentEnergy(),
            lastUpdated: new Date(this.lastUpdated).toISOString(),
            moodHistory: this.moodHistory.slice(-10), // Last 10 events
        };
    }
    /**
     * Format state for prompt injection.
     */
    toPromptString() {
        const mood = this.getCurrentMood();
        const energy = this.getCurrentEnergy();
        const desire = this.currentDesire;
        let moodDesc;
        if (mood >= 6)
            moodDesc = '非常开心';
        else if (mood >= 3)
            moodDesc = '心情不错';
        else if (mood >= -2)
            moodDesc = '心情平静';
        else if (mood >= -5)
            moodDesc = '有点低落';
        else
            moodDesc = '心情不好';
        let lines = [
            `[Anima 当前状态]`,
            `情绪指数：${mood >= 0 ? '+' : ''}${mood.toFixed(1)}（${moodDesc}）`,
            `精力值：${energy}/100`,
        ];
        if (desire) {
            lines.push(`当前想法：${desire}`);
        }
        // Add recent mood context
        if (this.moodHistory.length > 0) {
            const recent = this.moodHistory.slice(-3);
            const reasons = recent.map(e => e.reason).join('、');
            lines.push(`最近经历：${reasons}`);
        }
        return lines.join('\n');
    }
    /**
     * Persist significant mood events as long-term memory.
     */
    persistMoodMemory(value, reason) {
        try {
            value = Math.max(-10, Math.min(10, Number.isFinite(Number(value)) ? Number(value) : 0));
            // Keep the in-memory state and its persisted snapshots in the same
            // project partition so Hermes/DSH/general memories stay isolated.
            const db = DatabaseManager.getInstance(this.project, 'project');
            const id = `mood_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
            const now = new Date().toISOString();
            db.prepare(`
        INSERT INTO memory (id, text, project, type, mem_type, category, subcategory, tags, emotional_impact, importance, character_id, source, subject, agent_mood, is_active, created_at, updated_at, last_accessed_at, accessed_count)
        VALUES (?, ?, ?, ?, 'project', 'mood_snapshot', 'mood_event', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, `[情绪快照] ${reason}，情绪值：${value >= 0 ? '+' : ''}${value}`, this.project, 'episodic', JSON.stringify(['mood', 'self-reflection', value > 0 ? 'positive' : 'negative']), value, 0.4, // Low importance — moods are transient
            this.characterId, 'agent_state', 'self', value, 1, now, now, now, 0);
        }
        catch (e) {
            console.error('Failed to persist mood memory:', e);
        }
    }
}
/**
 * Get or create AgentState for a character.
 */
export function getAgentState(characterId, project) {
    const key = `${normalizeProject(project)}|${characterId}`;
    if (!agentStates.has(key)) {
        agentStates.set(key, new AgentState(characterId, project));
    }
    return agentStates.get(key);
}
/**
 * Get formatted prompt string for a character's current state.
 */
export function getAgentPrompt(characterId, project) {
    return getAgentState(characterId, project).toPromptString();
}
//# sourceMappingURL=agentState.js.map