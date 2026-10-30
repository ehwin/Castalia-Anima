
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

const qs = [
  '我喜欢什么样的汇报方式',
  '尤诺答应过我什么',
  '我平时社交上是什么状态',
  '她是用什么语气跟我说话的',
  '我最近在做什么工作',
]
for (const q of qs) {
  const r = await recallForInjection(q, { project: 'airi', characterId: 'airi' })
  const first = (r.text.match(/^- \[[^\]]+\] # ([^\n（]+)/m) || [])[1] || '(无)'
  console.log(`${q}\n   -> ${r.stats.count} 条 / ${r.stats.chars} 字 / top ${r.stats.topSim} | 首条: ${first.trim().slice(0, 46)}`)
}
