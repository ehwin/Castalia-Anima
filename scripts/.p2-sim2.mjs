
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = 'D:/AI/hermes-home/cache/scratch/bank-p2b'
process.env.MEMORY_DB_DIR = dir
process.env.MEMORY_CONFIG = `${dir}/config.json`
process.env.CASTALIA_PROJECT='airi'; process.env.CHAR_ID='airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { searchMemory } = await import(dist('search.js'))
for (const q of ['团子怎么了', '下周要交的报表怎么做', '下周三有什么安排', '我妈下周来住我该准备什么']) {
  const hits = await searchMemory({ query: q, project: 'airi', characterId: 'airi', topK: 15, minScore: 0, profile: 'deep', includeGeneral: true })
  const ev = hits.filter(h => h.source === 'daily_event').slice(0, 3)
  console.log(`Q "${q}"`)
  for (const h of ev) console.log('   event', Number(h.similarity).toFixed(3), String(h.text).replace(/\n/g,' ').slice(0, 40))
  if (!ev.length) console.log('   (无事件行命中)  top1=', Number(hits[0]?.similarity).toFixed(3), hits[0]?.source ?? '-')
}
