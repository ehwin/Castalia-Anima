
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = 'D:/AI/hermes-home/cache/scratch/bank-selfref'
process.env.MEMORY_DB_DIR = dir
process.env.MEMORY_CONFIG = `${dir}/config.json`
process.env.CASTALIA_PROJECT = 'airi'; process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { DatabaseManager } = await import(dist('db.js'))
const db = DatabaseManager.getInstance('airi', 'general')

// 造一条既有事实：用户喜欢月下漫步（注入时会带进上下文）
const now = new Date().toISOString()
db.prepare(`INSERT OR IGNORE INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active, created_at, updated_at, valid_from)
            VALUES ('selfref-fact', 'user', '喜好', '月下漫步', 'airi', 0.95, 'airi', 1, ?, ?, ?)`).run(now, now, now)

const { saveConversationTurn } = await import(dist('store.js'))
// 这一轮里：她说"我记得你喜欢月下漫步"（复述注入） + 用户给出新信息（想去海边）
await saveConversationTurn('你还记得我喜欢什么吗', '我记得你喜欢月下漫步。对了，你之前提过喜欢熬夜折腾技术。', 'airi', undefined, undefined, 'airi')
await saveConversationTurn('我下周想去海边住两天', '海边好，那我把时间记下来。', 'airi', undefined, undefined, 'airi')

const driver = await import(dist('reflectDriver.js'))
const r = await driver.runAutoReflect('airi', 10, 'airi')
console.log('reflect', JSON.stringify({ ok: r.ok, conversations: r.conversationCount, facts: r.factsInserted, applied: r.applied }))

const rows = db.prepare("SELECT subject, predicate, substr(object,1,60) o, confidence FROM facts ORDER BY rowid DESC LIMIT 10").all()
for (const row of rows) console.log('  ·', row.subject, '|', row.predicate, '|', row.o, '|', row.confidence)
const selfref = db.prepare("SELECT COUNT(*) c FROM facts WHERE object LIKE '%助手回忆%' OR object LIKE '%未确认%'").get()
console.log('自引用事实（含"助手回忆/未确认"）:', selfref.c)
const beach = db.prepare("SELECT COUNT(*) c FROM facts WHERE object LIKE '%海边%'").get()
console.log('用户新信息（海边）是否入库:', beach.c)
