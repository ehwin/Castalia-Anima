// 循环闭环回归（2026-10-30）：两条"设计决定"必须被钉住，改坏了立刻红。
//
// 1. 本地日历日口径（dayKey）：created_at 存 UTC ISO，但"今天/昨天"是本地日。
//    2026-10-29T17:03Z = 本地 10-30 01:03 —— 切 ISO 前 10 位会算成 10-29，
//    事件层分桶与时间路取几天就会错开一天，问"今天在忙什么"查不到自己凌晨那段。
// 2. 注入不算回忆：注入路径（recallForInjection）不得刷新 accessed_count/last_accessed_at，
//    否则 被注入 → 排名更高 → 更常被注入 的正反馈会把垃圾行滚起来（实测 lore 行 200~306 次）。
//    用户主动检索（searchMemory）必须照旧记账。
//
// 纯离线：临时库 + EMBED_MODE=none，不打网络、不碰真实 bank。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-loop-'))
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({}))
Object.assign(process.env, {
  MEMORY_DB_DIR: temp,
  MEMORY_CONFIG: path.join(temp, 'config.json'),
  CHAR_ID: 'airi',
  CASTALIA_PROJECT: 'looptest',
  EMBED_MODE: 'none',
})

let checks = 0
const check = (v, m) => { assert.ok(v, m); checks++ }
const eq = (a, b, m) => { assert.equal(a, b, `${m} (期望 ${b}，实际 ${a})`); checks++ }

const dist = f => pathToFileURL(path.join(root, 'dist', f)).href
await import(dist('configLoader.js'))
const { DatabaseManager } = await import(dist('db.js'))
const { saveMemory } = await import(dist('store.js'))
const { searchMemory } = await import(dist('search.js'))
const { recallForInjection } = await import(dist('recallForInjection.js'))
const { localDayOf, localDayOffset } = await import(dist('dayKey.js'))

// ── 1. 日历日口径 ────────────────────────────────────────────────
eq(localDayOf('2026-10-29T17:03:14.425Z'), '2026-10-30', 'UTC 17:03 在 UTC+8 属于次日')
eq(localDayOf('2026-10-29T15:59:00.000Z'), '2026-10-29', 'UTC 15:59 仍是当日')
eq(localDayOf('2026-10-29 12:00:00'), '2026-10-29', 'SQLite 无时区串按本地解释')
eq(localDayOf('not-a-date'), 'not-a-date', '坏时间串原样截取，不变 1970')
const today = new Date()
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
eq(localDayOffset(0), fmt(today), '偏移 0 = 本地今天')
const y = new Date(today); y.setDate(y.getDate() - 1)
eq(localDayOffset(1), fmt(y), '偏移 1 = 本地昨天（跨零点，不是 -24h）')

// ── 2. 注入不算回忆 ──────────────────────────────────────────────
const db = DatabaseManager.getInstance('looptest', 'general')
const rows = [
  { text: '用户说过喜欢安安静静的月下散步，月亮出来的时候最好', tags: ['偏好'] },
  { text: '用户熬夜折腾技术到凌晨三点，第二天照样上班', tags: ['习惯'] },
  { text: '下周三要去医院复查，记得提前一天提醒', tags: ['日程'] },
]
for (const r of rows) await saveMemory({ ...r, type: 'semantic', memType: 'general', importance: 0.8, characterId: 'airi', project: 'looptest' })

const sumAccessed = () => Number(db.prepare('SELECT COALESCE(SUM(accessed_count),0) s FROM memory').get().s)
// 词法覆盖率要过 0.2 的门（'我喜欢什么样的散步' 只有 0.163，会被门槛挡掉，不能拿它做断言）
const q = '用户喜欢散步'

const before = sumAccessed()
const inj = await recallForInjection(q, { project: 'looptest', characterId: 'airi' })
const afterInj = sumAccessed()
eq(afterInj, before, '注入路径不得刷新 accessed_count')
check(inj.stats.count > 0, '注入本身要能命中（否则上面的断言是空转）')
check(inj.text.includes('<memory'), '注入块仍带容器')

await searchMemory({ query: q, project: 'looptest', characterId: 'airi', topK: 3, minScore: 0, profile: 'deep', includeGeneral: true })
const afterSearch = sumAccessed()
check(afterSearch > afterInj, '用户主动检索必须照常记账')

// 注入两次也不能把计数带起来（同话题连续两轮是常态）
await recallForInjection(q, { project: 'looptest', characterId: 'airi' })
eq(sumAccessed(), afterSearch, '第二次注入同样不记账')

DatabaseManager.close()
console.log(JSON.stringify({ checks, ok: true, injected: inj.stats.count, accessedDelta: afterSearch - before }))
