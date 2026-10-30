
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
const { DatabaseManager } = await import(dist('db.js'))
const { saveConversationTurn } = await import(dist('store.js'))
const db = DatabaseManager.getInstance('airi', 'general')
const now = new Date(); const yest = new Date(Date.now() - 86400000)
const setTime = (id, when) => db.prepare('UPDATE memory SET created_at = ?, updated_at = ?, last_accessed_at = ? WHERE id = ?').run(when, when, when, id)
const today = [
  ['下周三我要去做复查，别忘了提醒我', '记下了，下周三复查，我头一天问你。'],
  ['团子最近总掉毛，我有点担心', '换季掉毛很常见，先多梳一梳；要是秃了一块再去看医生。'],
  ['今天加班到十点，好累', '辛苦了，先去洗个热水澡吧。'],
]
const yesterday = [
  ['我妈下周来住三天，我在想怎么安排', '那我把这三天记下来，到时候提醒你收拾客房。'],
  ['我最近在学 Rust，有点卡在所有权那章', '所有权那章确实绕，慢慢来。'],
]
for (const [u, a] of today) { const r = await saveConversationTurn(u, a, 'airi', undefined, undefined, 'airi'); setTime(r.id, now.toISOString()) }
for (const [u, a] of yesterday) { const r = await saveConversationTurn(u, a, 'airi', undefined, undefined, 'airi'); setTime(r.id, yest.toISOString()) }
console.log('seeded', today.length + yesterday.length, 'turns')
