
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = 'D:/AI/hermes-home/cache/scratch/bank-p2b'
process.env.MEMORY_DB_DIR = dir
process.env.MEMORY_CONFIG = `${dir}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { DatabaseManager } = await import(dist('db.js'))
const db = DatabaseManager.getInstance('airi', 'general')
console.log('vec_memory =', db.prepare('SELECT COUNT(*) c FROM vec_memory').get().c, '| vec_chunk =', db.prepare('SELECT COUNT(*) c FROM vec_chunk').get().c)
const rows = db.prepare("SELECT rowid, substr(text,1,24) t FROM memory WHERE source='daily_event'").all()
for (const r of rows) {
  const v = db.prepare('SELECT COUNT(*) c FROM vec_memory WHERE rowid = ?').get(r.rowid)
  const ch = db.prepare('SELECT COUNT(*) c FROM vec_chunk WHERE rowid = ?').get(r.rowid * 1000)
  console.log('  rowid', r.rowid, 'vec=', v.c, 'chunkStart=', ch.c, '|', String(r.t).replace(/\n/g, ' '))
}
