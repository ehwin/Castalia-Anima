
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = 'D:/AI/hermes-home/cache/scratch/bank-p2'
process.env.MEMORY_DB_DIR = dir
process.env.MEMORY_CONFIG = `${dir}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { searchMemory } = await import(dist('search.js'))
for (const q of ['团子怎么了', '团子最近怎么样', '我昨天在忙什么', '下周三有什么安排']) {
  const hits = await searchMemory({ query: q, project: 'airi', characterId: 'airi', topK: 4, minScore: 0, profile: 'deep', includeGeneral: true })
  console.log(`\nQ "${q}"`)
  for (const h of hits.slice(0, 4)) console.log('   ', Number(h.similarity).toFixed(3), h.source ?? '-', String(h.text || '').replace(/\n/g, ' ').slice(0, 46))
}
