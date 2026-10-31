#!/usr/bin/env node
/**
 * 循环路径回归：progress 记账粒度 + 未来问句（「未完」）取法。
 * 纯本地：不调 LLM、不算向量 —— 只钉死两条判定。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BANK = 'C:/bank/cache/scratch/bank-loop-test'
fs.rmSync(BANK, { recursive: true, force: true })
fs.mkdirSync(BANK + '/default', { recursive: true })
process.env.MEMORY_DB_DIR = BANK
process.env.CASTALIA_PROJECT = 'default'
process.env.CHAR_ID = 'default'
delete process.env.EMBED_MODE

const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { DatabaseManager } = await import(dist('db.js'))
const { progressIdsToMark } = await import(dist('eventDigest.js'))
const { recallTemporalForQuery, isFutureIntent } = await import(dist('temporalRecall.js'))
const { localDayOffset } = await import(dist('dayKey.js'))

let pass = 0
const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fails.push(label); console.log(`  FAIL ${label} ${extra}`) }
}

// ── 1) progressIdsToMark 三态 ──────────────────────────────────────────
const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
ok(progressIdsToMark(rows, false, new Set()).length === 3, '没出错 → 整天标记')
ok(progressIdsToMark(rows, true, new Set()).length === 3, '出错但零覆盖 → 仍整天（不空转重烧）')
const partial = progressIdsToMark(rows, true, new Set(['a', 'c']))
ok(partial.length === 2 && partial.map(r => r.id).join('') === 'ac', '出错且部分覆盖 → 只标记被覆盖的')

// ── 2) 造数据：今天一条带「未完」、昨天一条不带 ────────────────────────
const db = DatabaseManager.getInstance('default', 'general')
const ins = db.prepare(`INSERT OR REPLACE INTO memory
 (id,text,project,type,mem_type,category,tags,importance,base_importance,character_id,source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,reference_count)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,0,0)`)
const now = new Date()
const today = localDayOffset(0)
const yday = localDayOffset(1)
const iso = ms => new Date(ms).toISOString()
ins.run('ev-today', `# ${today} · 约好明天三点复查膝盖\n用户约好明天下午三点去医院复查膝盖。\n摘录（用户）：「明天下午三点要去医院复查膝盖」\n未完: 复查后把医生说的话告诉助手；膝盖还疼不疼待观察\n来源: aaaaaaa1`,
  'default', 'episodic', 'general', 'event', `["day:${today}"]`, 0.8, 0.8, 'default', 'daily_event', 'user', 'standard',
  iso(now.getTime() - 60000), iso(now.getTime() - 60000), iso(now.getTime() - 60000))
ins.run('ev-yday', `# ${yday} · 多肉搬到南窗台\n用户把阳台的多肉搬到南窗台晒了一下午。\n摘录（用户）：「我把阳台的多肉全搬到南边窗台了」\n来源: aaaaaaa2`,
  'default', 'episodic', 'general', 'event', `["day:${yday}"]`, 0.6, 0.6, 'default', 'daily_event', 'user', 'standard',
  iso(now.getTime() - 86400000), iso(now.getTime() - 86400000), iso(now.getTime() - 86400000))

// ── 3) 未来问句取「未完」 ─────────────────────────────────────────────
ok(isFutureIntent('明天有什么要做的'), '「明天有什么要做的」识别为未来问句')
const fut = recallTemporalForQuery('明天有什么要做的', { project: 'default', characterId: 'default' })
ok(fut.hits.length === 1, '未来问句命中 1 条未完', JSON.stringify(fut.hits))
ok(/待跟进/.test(fut.text) && /复查后把医生说的话/.test(fut.text), '输出取的是「未完」正文而不是事件概述')
ok(!/多肉/.test(fut.text), '没有「未完」的事件不混进未来问句')

const tod = recallTemporalForQuery('我今天在忙什么', { project: 'default', characterId: 'default' })
ok(tod.hits.length === 1 && /复查膝盖/.test(tod.text), '「我今天在忙什么」按日期直取今天的事件')

const none = recallTemporalForQuery('帮我写个快速排序', { project: 'default', characterId: 'default' })
ok(none.hits.length === 0 && none.text === '', '无时间词不触发时间路')

const week = recallTemporalForQuery('最近都发生了什么', { project: 'default', characterId: 'default' })
ok(week.hits.length === 2, '「最近」取到多天事件', JSON.stringify(week.hits.map(h => h.day)))

// ── 4) 注入层：时间路与向量路解耦（向量路挂了也要出内容）────────────
const { recallForInjection } = await import(dist('recallForInjection.js'))
const inj = await recallForInjection('明天有什么要做的', { project: 'default', characterId: 'default', query: '明天有什么要做的' })
ok(inj.stats.temporal === 1, '注入层：未来问句的情绪/向量路之外仍带出 1 条未完', JSON.stringify(inj.stats))
ok(/待跟进/.test(inj.text), '注入层：整块里能看到「未完」块')
ok(inj.stats.skipped !== 'no-hits', '有内容时不再报 no-hits')

console.log(fails.length === 0 ? `\n全部通过（${pass} 项）` : `\n${fails.length} 项失败：${fails.join('；')}`)
process.exit(fails.length === 0 ? 0 : 1)
