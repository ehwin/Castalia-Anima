// Facts provenance migration regression. Run after `pnpm run build`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'db.js')) ? root : path.join(root, 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-facts-migration-'));
const project = 'facts-migration';
const dbPath = path.join(temp, project, 'general', 'memory.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: project,
  CHAR_ID: 'airi',
});
const { DatabaseManager } = await import(pathToFileURL(path.join(distRoot, 'db.js')).href);

// First create a complete current-schema database, then turn only facts back
// into the legacy shape. This avoids a fake fixture with missing memory
// columns that would fail unrelated early schema triggers.
let db = DatabaseManager.getInstance(project, 'general');
db.exec('DROP VIEW IF EXISTS facts_current');
for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'facts' AND name NOT LIKE 'sqlite_autoindex_%'").all()) {
  db.exec(`DROP INDEX IF EXISTS "${String(row.name).replaceAll('"', '""')}"`);
}
db.exec('DROP TABLE facts');
db.exec(`
  CREATE TABLE facts (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    project TEXT DEFAULT 'default',
    confidence REAL DEFAULT 0.5,
    source_memory_id TEXT,
    source_memory_source TEXT,
    source_memory_mem_type TEXT,
    character_id TEXT,
    is_active INTEGER DEFAULT 1,
    accessed_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    valid_from DATETIME,
    valid_to DATETIME,
    superseded_by TEXT,
    expired_at DATETIME,
    evidence TEXT,
    FOREIGN KEY(source_memory_id) REFERENCES memory(id)
  );
  INSERT INTO memory (id, text, project, character_id) VALUES ('legacy-source', 'legacy source', ?, 'airi');
  INSERT INTO facts (id, subject, predicate, object, project, source_memory_id, character_id)
    VALUES ('legacy-fact', 'user', 'likes', 'tea', ?, 'legacy-source', 'airi');
`, project, project);
DatabaseManager.close();

db = DatabaseManager.getInstance(project, 'general');
assert.equal(db.prepare("SELECT COUNT(*) AS c FROM pragma_foreign_key_list('facts') WHERE \"from\" = 'source_memory_id'").get().c, 0, 'first open removes local facts FK');
assert.equal(db.prepare("SELECT subject, object, source_memory_id FROM facts WHERE id = 'legacy-fact'").get().source_memory_id, 'legacy-source', 'legacy facts row survives rebuild');
assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('facts') WHERE name = 'source_memory_source'").get(), 'provenance source column exists');
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_facts_source_memory_source'").get(), 'provenance index exists');

// A cross-partition source id must now be legal metadata, even when no local
// memory row exists in the general database.
db.prepare(`INSERT INTO facts (id, subject, predicate, object, project, source_memory_id, source_memory_source, source_memory_mem_type, character_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'cross-fact', 'user', 'likes', 'coffee', project, 'project-only-id', 'conversation_log', 'project', 'airi',
);
assert.equal(db.prepare("SELECT COUNT(*) AS c FROM facts WHERE id IN ('legacy-fact', 'cross-fact')").get().c, 2, 'cross-partition provenance inserts');
DatabaseManager.close();

// Reopening must be idempotent: no second rebuild, no data loss, no FK return.
db = DatabaseManager.getInstance(project, 'general');
assert.equal(db.prepare("SELECT COUNT(*) AS c FROM pragma_foreign_key_list('facts') WHERE \"from\" = 'source_memory_id'").get().c, 0, 'second open remains without local facts FK');
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM facts').get().c, 2, 'second open preserves all facts');

DatabaseManager.close();
console.log('PASS facts migration regression (8 checks)');
