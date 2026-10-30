
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
for (const q of ['我喜欢什么样的汇报方式', '我最近在做什么工作', '尤诺答应过我什么']) {
  const r = await recallForInjection(q, { project: 'airi', characterId: 'airi' })
  console.log('='.repeat(70)); console.log(q, '->', JSON.stringify({ count: r.stats.count, facts: r.stats.facts, chars: r.stats.chars }))
  console.log(r.text.slice(0, 700))
}
