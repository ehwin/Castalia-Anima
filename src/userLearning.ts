/**
 * User Learning — observe and remember user communication patterns
 *
 * Inspired by SynaBun Directive 5: autonomously observes user communication
 * patterns, preferences, and behavioral singularity across sessions.
 *
 * Extracts after each conversation:
 * - Communication style (concise/verbose/formal/casual)
 * - Common expressions and tone
 * - Reply length preference
 * - Interest domains
 * - Language preference (zh/en/mixed)
 */
import { DatabaseManager } from './db.js';

interface UserProfile {
  characterId: string;
  userId: string;
  communicationStyle: string;
  avgReplyLength: number;
  languagePreference: string;
  commonExpressions: string[];
  interests: Map<string, number>; // topic -> weight
  interactionCount: number;
  lastUpdated: number;
}

const profiles = new Map<string, UserProfile>();

function profileKey(characterId: string, userId: string): string {
  return `${characterId}:${userId}`;
}

/**
 * Observe a user message and update profile.
 */
export function observeUserMessage(
  characterId: string,
  userId: string,
  message: string
): void {
  const key = profileKey(characterId, userId);
  if (!profiles.has(key)) {
    profiles.set(key, {
      characterId,
      userId,
      communicationStyle: 'unknown',
      avgReplyLength: 0,
      languagePreference: 'zh',
      commonExpressions: [],
      interests: new Map(),
      interactionCount: 0,
      lastUpdated: Date.now(),
    });
  }

  const profile = profiles.get(key)!;
  profile.interactionCount++;
  profile.lastUpdated = Date.now();

  // Update average reply length (exponential moving average)
  const alpha = 0.1;
  profile.avgReplyLength = Math.round(
    profile.avgReplyLength * (1 - alpha) + message.length * alpha
  );

  // Detect language
  const chineseChars = (message.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = message.length;
  if (totalChars > 0) {
    const chineseRatio = chineseChars / totalChars;
    if (chineseRatio > 0.5) profile.languagePreference = 'zh';
    else if (chineseRatio < 0.1) profile.languagePreference = 'en';
    else profile.languagePreference = 'mixed';
  }

  // Detect communication style
  if (message.length < 10) {
    profile.communicationStyle = 'concise';
  } else if (message.length > 200) {
    profile.communicationStyle = 'verbose';
  } else {
    profile.communicationStyle = 'normal';
  }

  // Extract common expressions (simple: collect short phrases)
  const expressions = message.match(/[\u4e00-\u9fff]{2,6}|[a-zA-Z]{3,}/g) || [];
  for (const expr of expressions.slice(0, 3)) {
    const existing = profile.interests.get(expr);
    profile.interests.set(expr, (existing || 0) + 1);
  }
}

/**
 * Get user profile summary for prompt injection.
 */
export function getUserProfilePrompt(characterId: string, userId: string): string {
  const key = profileKey(characterId, userId);
  const profile = profiles.get(key);
  if (!profile || profile.interactionCount < 3) return '';

  const styleDesc = {
    concise: '喜欢简短回复',
    verbose: '喜欢详细回复',
    normal: '正常交流',
    unknown: '风格待观察',
  }[profile.communicationStyle] || '正常交流';

  const langDesc = {
    zh: '主要用中文',
    en: '主要用英文',
    mixed: '中英混合',
  }[profile.languagePreference] || '主要用中文';

  // Get top interests
  const topInterests = [...profile.interests.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => `${topic}(${count})`)
    .join('、');

  const lines = [
    `[用户画像]`,
    `交流风格：${styleDesc}`,
    `平均回复长度：${profile.avgReplyLength}字`,
    `语言偏好：${langDesc}`,
    `交互次数：${profile.interactionCount}`,
  ];

  if (topInterests) {
    lines.push(`常聊话题：${topInterests}`);
  }

  return lines.join('\n');
}

/**
 * Get raw profile data.
 */
export function getUserProfile(characterId: string, userId: string): UserProfile | null {
  return profiles.get(profileKey(characterId, userId)) || null;
}

/**
 * Load user profiles from memory on startup.
 */
export function loadUserProfilesFromDb(characterId: string): void {
  try {
    const db = DatabaseManager.getInstance();
    const rows = db.prepare(`
      SELECT text, tags, emotional_impact, created_at
      FROM memory
      WHERE subject = 'user' AND type = 'preference' AND character_id = ? AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 50
    `).all(characterId) as any[];

    for (const row of rows) {
      try {
        const tags = JSON.parse(row.tags || '[]');
        const key = profileKey(characterId, 'default');
        if (!profiles.has(key)) {
          profiles.set(key, {
            characterId,
            userId: 'default',
            communicationStyle: 'unknown',
            avgReplyLength: 0,
            languagePreference: 'zh',
            commonExpressions: [],
            interests: new Map(),
            interactionCount: 0,
            lastUpdated: Date.now(),
          });
        }
        const profile = profiles.get(key)!;
        profile.interactionCount++;
        for (const tag of tags) {
          const existing = profile.interests.get(tag);
          profile.interests.set(tag, (existing || 0) + 1);
        }
      } catch {}
    }
  } catch {}
}
