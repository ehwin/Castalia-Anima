
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const BANK_DIR = 'D:/AI/hermes-home/cache/scratch/bank-p0'
process.env.MEMORY_DB_DIR = BANK_DIR
process.env.MEMORY_CONFIG = `${BANK_DIR}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { recallForInjection } = await import(dist('recallForInjection.js'))
const { DatabaseManager } = await import(dist('db.js'))

const r = await recallForInjection('下周要交的报表怎么做', { project: 'airi', characterId: 'airi' })
console.log('--- 注入正文 ---')
console.log(r.text.slice(0, 900))
console.log('stats', JSON.stringify(r.stats))

const db = DatabaseManager.getInstance('airi', 'general')
console.log('\n--- 最近新增行的来源分布 ---')
for (const row of db.prepare(`
  SELECT COALESCE(source,'(null)') s, type, COUNT(*) c FROM memory
  WHERE rowid > (SELECT MAX(rowid)-40 FROM memory) GROUP BY s, type ORDER BY c DESC
`).all()) console.log(' ', row.s, '|', row.type, '|', row.c)
