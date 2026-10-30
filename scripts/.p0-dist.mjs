
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const BANK_DIR = 'D:/AI/hermes-home/cache/scratch/bank-p0'
process.env.MEMORY_DB_DIR = BANK_DIR
process.env.MEMORY_CONFIG = `${BANK_DIR}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { searchMemory } = await import(dist('search.js'))
const { DatabaseManager } = await import(dist('db.js'))
const db = DatabaseManager.getInstance('airi', 'general')

const POS = ['你为什么看不见命运了','你把手镯交给谁了','你的生日是哪天','七丘是个什么样的地方','黑潮是什么','漂泊者是谁','你为什么害怕被遗忘','奥古斯塔是谁','你怎么战斗','小托是谁','你能看见什么']
const NOISE = ['帮我写个快速排序','今天上海天气怎么样','推荐一部科幻电影','把这段 Python 改成 Rust','下周要交的报表怎么做','帮我订一张去北京的机票','这个正则怎么匹配邮箱','MySQL 索引怎么优化']

function sourceOf(id) {
  try { return db.prepare('SELECT COALESCE(source,\'(null)\') s, type FROM memory WHERE id=?').get(id) } catch { return null }
}

async function top(q, n = 3) {
  const hits = await searchMemory({ query: q, project: 'airi', characterId: 'airi', topK: n, minScore: 0 })
  return hits.slice(0, n).map(h => {
    const meta = h.id ? sourceOf(h.id) : null
    return { sim: Number(h.similarity || 0).toFixed(3), src: meta?.s ?? '?', type: meta?.type ?? '?' }
  })
}

console.log('=== 相关问句 top3（sim / source）===')
for (const q of POS) console.log(' ', q, JSON.stringify(await top(q)))
console.log('=== 噪音问句 top3 ===')
for (const q of NOISE) console.log(' ', q, JSON.stringify(await top(q)))
