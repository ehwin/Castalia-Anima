
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = 'D:/AI/hermes-home/cache/scratch/bank-p2b'
process.env.MEMORY_DB_DIR = dir
process.env.MEMORY_CONFIG = `${dir}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { recallForInjection } = await import(dist('recallForInjection.js'))
for (const q of ['我昨天在忙什么', '今天有什么要做的', '团子怎么了', '帮我写个快速排序']) {
  const r = await recallForInjection(q, { project: 'airi', characterId: 'airi' })
  console.log(`\nQ "${q}" count=${r.stats.count} temporal=${r.stats.temporal ?? 0} facts=${r.stats.facts ?? 0} chars=${r.stats.chars}`)
  const tail = r.text.split('</memory>').pop()?.trim() ?? ''
  if (tail) console.log(tail.slice(0, 420))
}
