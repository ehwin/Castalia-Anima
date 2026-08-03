/**
 * Ollama embedding — SQLite 持久化缓存
 *
 * 改动：
 * - 内存 Map → SQLite embedding_cache 表
 * - 重启不丢失，重复文本 0ms 返回
 * - 暴露 getEmbeddingCached() 供 store.ts 使用
 */
import { DatabaseManager } from './db.js';
import crypto from 'node:crypto';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';  // Ollama embed server (standard port)
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'yuan-embedding-2.0-zh';  // 1024 dim

// 内存级 LRU 缓存（热数据，<1ms）
const memCache = new Map<string, number[]>();
const MEM_CACHE_MAX = 200;

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function embed(text: string): Promise<number[]> {
  // 1. 内存缓存
  const memCached = memCache.get(text);
  if (memCached) return memCached;

  // 2. SQLite 缓存
  const db = DatabaseManager.getInstance();
  const hash = hashText(text);
  try {
    const row = db.prepare('SELECT embedding FROM embedding_cache WHERE text_hash = ?').get(hash) as any;
    if (row) {
      const vec = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
      setMemCache(text, vec);
      return vec;
    }
  } catch {}

  // 3. 调 Ollama
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  const vector = data.embeddings[0];

  // 写入缓存
  setMemCache(text, vector);
  try {
    const floatArr = new Float32Array(vector);
    db.prepare('INSERT OR IGNORE INTO embedding_cache (text_hash, embedding) VALUES (?, ?)').run(hash, floatArr);
  } catch {}

  return vector;
}

/** 带缓存的 embed 别名 */
export async function getEmbeddingCached(text: string): Promise<number[]> {
  return embed(text);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function setMemCache(text: string, vec: number[]) {
  if (memCache.size >= MEM_CACHE_MAX) {
    // 删第一个（简易 LRU）
    const firstKey = memCache.keys().next().value;
    if (firstKey) memCache.delete(firstKey);
  }
  memCache.set(text, vec);
}
