
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = 'D:/AI/hermes-home/cache/scratch/bank-p2b'
process.env.MEMORY_DB_DIR = dir
process.env.MEMORY_CONFIG = `${dir}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { temporalDaysOf, recallForInjection } = await import(dist('recallForInjection.js'))
const { searchMemory } = await import(dist('search.js'))
console.log('temporalDaysOf("我昨天在忙什么") =', [...temporalDaysOf('我昨天在忙什么')])
const hits = await searchMemory({ query: '我昨天在忙什么', project: 'airi', characterId: 'airi', topK: 12, minScore: 0, profile: 'deep', includeGeneral: true })
for (const h of hits.slice(0, 8)) console.log('  ', Number(h.similarity).toFixed(3), h.source ?? '-', String(h.text || '').replace(/\n/g,' ').slice(0, 40))
const r = await recallForInjection('我昨天在忙什么', { project: 'airi', characterId: 'airi' })
console.log('\n注入 ids:', JSON.stringify(r.stats.ids))
console.log(r.text.slice(0, 400).replace(/\n/g,' | '))
