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
import { normalizeCharacterId, normalizeProject } from './env.js';
import { loadBiasesFromDb } from './bias.js';
import { getPsycheState } from './psycheState.js';
import { publicMemorySourceSql } from './memoryProvenance.js';

export interface AgentStateSnapshot {
  characterId: string;
  currentMood: number;        // -10 to +10, aggregated from recent mood events
  currentDesire: string | null;
  energy: number;             // 0-100, decreases over time
  lastUpdated: string;
  moodHistory: MoodEvent[];
}

interface MoodEvent {
  value: number;              // signed event impact, -10 to +10
  reason: string;
  timestamp: number;
}

// In-memory state per character (not persisted)
const agentStates = new Map<string, AgentState>();

class AgentState {
  private characterId: string;
  private project: string;
  private moodHistory: MoodEvent[] = [];
  private currentDesire: string | null = null;
  private energy: number = 100;
  private lastUpdated: number = Date.now();
  /**
   * 精力有自己时钟（2026-10-31）。
   *
   * 原来 energy 与 mood/desire 共用 `lastUpdated`，而 `getCurrentEnergy()` 只在读取时
   * 衰减、从不写回：空闲 24h 显示 30，只要调一次 `setDesire`/`addMood` 把时间戳一按，
   * 显示立刻回到 100 —— 改一个想法凭空恢复了精力。现在精力单独记账，
   * 任何改变 energy 的操作先结算到当前时刻。
   */
  private energyUpdatedAt: number = Date.now();

  // Mood events are signed impacts around a neutral baseline (0). A seven
  // hour half-life makes an isolated event return to baseline over time.
  private static MOOD_HALF_LIFE_HOURS = 7;

  constructor(characterId: string, project?: string) {
    this.characterId = characterId;
    this.project = normalizeProject(project);
    this.loadFromDb();
    // Also load topic biases from existing memory tags (per project partition)
    loadBiasesFromDb(characterId, this.project);
  }

  /**
   * Load recent mood events from SQLite on startup.
   */
  private loadFromDb(): void {
    try {
      // Mood snapshots belong to Anima's project memory partition.  The
      // default (general) partition is metadata/shared state and must not
      // be used here, otherwise agent mood leaks across harnesses.
      const db = DatabaseManager.getInstance(this.project, 'project');
      const rows = db.prepare(`
        SELECT text, emotional_impact, created_at
        FROM memory
        WHERE subject = 'self' AND agent_mood IS NOT NULL AND character_id = ? AND is_active = 1
          AND ${publicMemorySourceSql()}
        ORDER BY created_at DESC
        LIMIT 20
      `).all(this.characterId) as any[];

      this.moodHistory = rows.reverse().map(r => ({
        value: Math.max(-10, Math.min(10, Number(r.emotional_impact) || 0)),
        reason: r.text.replace(/^\[情绪快照\] /, '').replace(/，情绪值：[+-]?\d+$/, ''),
        timestamp: new Date(r.created_at).getTime(),
      }));
    } catch (e) {
      // DB not ready yet, start empty
    }
  }

  /**
   * Add a signed mood-impact event. The current mood is the decayed sum of
   * recent impacts around the neutral baseline (0), clamped to [-10, 10].
   */
  addMood(value: number, reason: string): void {
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
  setDesire(desire: string): void {
    this.currentDesire = desire;
    this.lastUpdated = Date.now();
  }

  /**
   * Get current mood (aggregated with exponential decay).
   */
  getCurrentMood(): number {
    if (this.moodHistory.length === 0) return 0;

    const now = Date.now();
    let totalMood = 0;
    const halfLife = AgentState.MOOD_HALF_LIFE_HOURS;

    for (const event of this.moodHistory) {
      const elapsedMs = Math.max(0, now - event.timestamp);
      const hoursAgo = elapsedMs / (1000 * 60 * 60);
      const decay = Math.pow(0.5, hoursAgo / halfLife);
      totalMood += event.value * decay;
    }

    const clamped = Math.max(-10, Math.min(10, totalMood));
    return Math.round(clamped * 10) / 10;
  }

  /**
   * Get current energy (decreases over time; it does NOT reset on interaction).
   *
   * 恢复只来自显式的 boostEnergy（合意活动/休息）。修改 mood/desire 不再影响这个读数。
   */
  getCurrentEnergy(): number {
    const hoursSinceUpdate = (Date.now() - this.energyUpdatedAt) / (1000 * 60 * 60);
    const decayed = this.energy * Math.exp(-0.05 * hoursSinceUpdate);
    return Math.round(Math.max(0, Math.min(100, decayed)));
  }

  /** 把衰减结算进 this.energy，并把精力时钟拨到当前时刻。 */
  private settleEnergy(now: number = Date.now()): void {
    const hours = Math.max(0, now - this.energyUpdatedAt) / (1000 * 60 * 60);
    this.energy = Math.max(0, Math.min(100, this.energy * Math.exp(-0.05 * hours)));
    this.energyUpdatedAt = now;
  }

  /**
   * Boost energy (e.g., after a rest event or a welcome activity).
   */
  boostEnergy(amount: number): void {
    const now = Date.now();
    this.settleEnergy(now);            // 先结算旧的，再叠加，避免把陈旧值当当前值
    this.energy = Math.min(100, this.energy + amount);
    this.energyUpdatedAt = now;
    this.lastUpdated = now;
  }

  /**
   * Get full snapshot for prompt injection.
   */
  getSnapshot(): AgentStateSnapshot {
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
  toPromptString(): string {
    const psyche = getPsycheState(this.characterId, this.project);
    // Once the interaction sensor has evidence, it is the only affect source
    // shown to the model. The legacy scalar mood remains a compatibility
    // fallback for callers that have not produced sensor evidence yet.
    const mood = psyche.hasEvidence
      ? (psyche.band === 'neutral' ? 0 : Math.max(-10, Math.min(10, psyche.vad.valence * 10)))
      : this.getCurrentMood();
    const energy = this.getCurrentEnergy();
    const desire = this.currentDesire;

    let moodDesc: string;
    if (mood >= 6) moodDesc = '非常开心';
    else if (mood >= 3) moodDesc = '心情不错';
    else if (mood >= -2) moodDesc = '心情平静';
    else if (mood >= -5) moodDesc = '有点低落';
    else moodDesc = '心情不好';

    const lines = [
      `[Anima 当前状态]`,
      `情绪指数：${mood >= 0 ? '+' : ''}${mood.toFixed(1)}（${moodDesc}）`,
      `精力值：${energy}/100`,
    ];

    if (psyche.hasEvidence) {
      lines.splice(1, 1, `互动状态：${psyche.band}（v=${psyche.vad.valence.toFixed(2)} a=${psyche.vad.arousal.toFixed(2)} d=${psyche.vad.dominance.toFixed(2)}）`);
    }

    if (desire) {
      lines.push(`当前想法：${desire}`);
    }

    // Add recent mood context
    if (this.moodHistory.length > 0 && !psyche.hasEvidence) {
      const recent = this.moodHistory.slice(-3);
      const reasons = recent.map(e => e.reason).join('、');
      lines.push(`最近经历：${reasons}`);
    }

    return lines.join('\n');
  }

  /**
   * Persist significant mood events as long-term memory.
   */
  private persistMoodMemory(value: number, reason: string): void {
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
      `).run(
        id,
        `[情绪快照] ${reason}，情绪值：${value >= 0 ? '+' : ''}${value}`,
        this.project,
        'episodic',
        JSON.stringify(['mood', 'self-reflection', value > 0 ? 'positive' : 'negative']),
        value,
        0.4,  // Low importance — moods are transient
        this.characterId,
        'agent_state',
        'self',
        value,
        1,
        now, now, now, 0
      );
    } catch (e) {
      console.error('Failed to persist mood memory:', e);
    }
  }
}

/**
 * Get or create AgentState for a character.
 */
export function getAgentState(characterId: string, project?: string): AgentState {
  const canonicalCharacterId = normalizeCharacterId(characterId);
  const key = `${normalizeProject(project)}|${canonicalCharacterId}`;
  if (!agentStates.has(key)) {
    agentStates.set(key, new AgentState(canonicalCharacterId, project));
  }
  return agentStates.get(key)!;
}

/**
 * Get formatted prompt string for a character's current state.
 */
export function getAgentPrompt(characterId: string, project?: string): string {
  return getAgentState(characterId, project).toPromptString();
}
