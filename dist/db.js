/**
 * AIRI Memory Database Manager
 * SQLite + sqlite-vec with Alaya-compatible schema
 *
 * v5.0: 1024-dim vectors (Yuan-EB 2.0-zh), auto-migration from 4096
 * v4.0: 4096-dim vectors (qwen3-embedding:8b)
 */
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
const DB_PATH = process.env.MEMORY_DB_PATH || path.join(process.cwd(), 'memory.sqlite');
const VEC_DIM = 1024; // Yuan-EB 2.0-zh
export function generateId() {
    return crypto.randomUUID();
}
export class DatabaseManager {
    static instance = null;
    static getInstance() {
        if (!DatabaseManager.instance) {
            const db = new Database(DB_PATH);
            sqliteVec.load(db);
            db.pragma('journal_mode = WAL');
            DatabaseManager.initSchema(db);
            DatabaseManager.instance = db;
        }
        return DatabaseManager.instance;
    }
    static initSchema(db) {
        db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        type TEXT DEFAULT 'episodic',
        category TEXT DEFAULT 'general',
        subcategory TEXT,
        tags TEXT DEFAULT '[]',
        emotional_impact REAL DEFAULT 0,
        importance REAL DEFAULT 0.5,
        character_id TEXT,
        source TEXT,
        subject TEXT DEFAULT 'user',
        agent_mood REAL,
        agent_desire TEXT,
        tier TEXT DEFAULT 'standard',
        expires_at DATETIME,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        accessed_count INTEGER DEFAULT 0,
        reference_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(source_id) REFERENCES memory(id),
        FOREIGN KEY(target_id) REFERENCES memory(id)
      );

      CREATE TABLE IF NOT EXISTS categories (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        parent TEXT,
        color TEXT,
        is_parent INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text_hash TEXT UNIQUE NOT NULL,
        embedding BLOB NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        source_memory_id TEXT,
        character_id TEXT,
        is_active INTEGER DEFAULT 1,
        accessed_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(source_memory_id) REFERENCES memory(id)
      );
    `);
        // Safe column migrations (may already exist)
        const migrations = [
            `ALTER TABLE memory ADD COLUMN tier TEXT DEFAULT 'standard'`,
            `ALTER TABLE memory ADD COLUMN expires_at DATETIME`,
        ];
        for (const sql of migrations) {
            try {
                db.exec(sql);
            }
            catch (_e) { /* already exists */ }
        }
        // v5.3: locked column for permanent memory protection
        try {
            db.exec(`ALTER TABLE memory ADD COLUMN locked INTEGER DEFAULT 0`);
        }
        catch (_e) { /* already exists */ }
        try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, is_active)`);
        }
        catch (_e) { }
        // Unique index for fact dedup
        try {
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_spo ON facts(subject, predicate, object)`);
        }
        catch (_e) { }
        try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, is_active)`);
        }
        catch (_e) { }
        // ═══ v5.0 迁移：4096-dim → 1024-dim (Yuan-EB) ═══
        const SCHEMA_VERSION = 5;
        try {
            db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER)`);
        }
        catch (_e) { }
        const currentVersion = db.prepare('SELECT MAX(version) as v FROM _schema_version').get()?.v || 0;
        if (currentVersion < SCHEMA_VERSION) {
            console.log(`[db] migrating schema v${currentVersion} → v${SCHEMA_VERSION}`);
            try {
                db.exec(`DROP TABLE IF EXISTS vec_memory`);
            }
            catch (_e) { }
            try {
                db.exec(`DROP TABLE IF EXISTS vec_facts`);
            }
            catch (_e) { }
            try {
                db.exec(`DELETE FROM embedding_cache`);
            }
            catch (_e) { }
            db.prepare('INSERT OR REPLACE INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
            console.log(`[db] migration complete: vec tables recreated with ${VEC_DIM}-dim`);
        }
        // Create vec tables with current dimension
        try {
            db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${VEC_DIM}])`);
        }
        catch (_e) { }
        try {
            db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[${VEC_DIM}])`);
        }
        catch (_e) { }
        // v6.0: VAD emotion columns
        try {
            db.exec('ALTER TABLE memory ADD COLUMN vad_valence REAL DEFAULT NULL');
        }
        catch (_e) { }
        try {
            db.exec('ALTER TABLE memory ADD COLUMN vad_arousal REAL DEFAULT NULL');
        }
        catch (_e) { }
        try {
            db.exec('ALTER TABLE memory ADD COLUMN vad_dominance REAL DEFAULT NULL');
        }
        catch (_e) { }
        try {
            db.exec('ALTER TABLE memory ADD COLUMN tsundere_level REAL DEFAULT 0');
        }
        catch (_e) { }
        try {
            db.exec('CREATE INDEX IF NOT EXISTS idx_memory_vad_valence ON memory(vad_valence)');
        }
        catch (_e) { }
        try {
            db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tsundere ON memory(tsundere_level)');
        }
        catch (_e) { }
        // Seed default categories (SynaBun-style hierarchical)
        const defaultCategories = [
            { name: 'episodic', description: '事件记忆 — 发生了什么', is_parent: 1 },
            { name: 'emotional', description: '情感经历 — 感动、开心、难过的重要时刻', parent: 'episodic' },
            { name: 'milestone', description: '成长里程碑 — 第一次、重要决定 [critical]', parent: 'episodic' },
            { name: 'conversation', description: '对话记忆 — 有意义的对话片段', parent: 'episodic' },
            { name: 'semantic', description: '事实记忆 — 知识和关系', is_parent: 1 },
            { name: 'identity', description: '身份信息 — 人物、角色、身份 [critical]', parent: 'semantic' },
            { name: 'knowledge', description: '知识事实 — 学到的东西', parent: 'semantic' },
            { name: 'preference', description: '偏好记忆 — 用户喜好和习惯', is_parent: 1 },
            { name: 'entity', description: '实体记忆 — 人物、地点、物品', is_parent: 1 },
            { name: 'relationship', description: '关系记忆 — 人与人之间的关系 [critical]', parent: 'entity' },
            { name: 'mood_snapshot', description: '情绪快照 — 情绪/精力/愿望，3天自动清理 [temporary]', parent: 'episodic' },
        ];
        const insertCat = db.prepare(`
      INSERT OR IGNORE INTO categories (name, description, parent, is_parent)
      VALUES (?, ?, ?, ?)
    `);
        for (const cat of defaultCategories) {
            insertCat.run(cat.name, cat.description, cat.parent || null, cat.is_parent || 0);
        }
    }
    /** v5.3: WAL checkpoint to prevent WAL file bloat */
    static checkpoint() {
        const db = DatabaseManager.instance;
        if (!db)
            return { walSize: 0, pages: 0 };
        const before = db.pragma('wal_checkpoint(TRUNCATE)');
        return {
            walSize: before?.wal_size ?? 0,
            pages: before?.checkpointed ?? 0,
        };
    }
    static close() {
        // Run final checkpoint before close
        DatabaseManager.checkpoint();
        if (DatabaseManager.instance) {
            DatabaseManager.instance.close();
            DatabaseManager.instance = null;
        }
    }
}
