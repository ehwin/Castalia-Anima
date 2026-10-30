#!/usr/bin/env node
/**
 * 事件层日期回归：按天分桶必须用**本地日历日**，与 temporalDaysOf 同一口径。
 *
 * 为什么（2026-10-30 实测样本）：conversation_log.created_at 存的是 UTC ISO（…Z），
 * 而事件行标题/tag 里的日期是用户理解的本地日历日（他问"今天/昨天"问的是本地时间）。
 * 两者混用有 8 小时错位：本地 00:00–08:00 的对话被算进前一天。
 * 真实行：2026-10-29T17:03Z = 本地 2026-10-30 01:03 —— 那是"今天凌晨"，不是"昨天上午"。
 *
 * 覆盖两条：
 *   A 边界对话（本地 00:30）的事件行日期 = 本地日，且"今天"的时间路能直取到它。
 *   B 落在其它分类库（project）里的 conversation_log 也能被整理；进度表建在**每个**库里。
 *
 * 离线：TRIAGE LLM 用桩 fetch（回显当天流水的原句，保证摘录校验能过），嵌入关掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dist = (f) => new URL(`../dist/${f}`, import.meta.url).href

let failed = 0
const ok = (cond, msg) => {
  if (cond) { console.log(`  ok   ${msg}`); return }
  failed++
  console.log(`  FAIL ${msg}`)
}

// ── 临时 bank ────────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'evdigest-'))
const realCfg = 'D:/castalia/memory-banks/airi/config.json'
const cfg = fs.existsSync(realCfg) ? JSON.parse(fs.readFileSync(realCfg, 'utf8')) : {}
cfg.embedding = { ...(cfg.embedding || {}), mode: 'none' }
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2))

process.env.MEMORY_DB_DIR = root
process.env.MEMORY_CONFIG = path.join(root, 'config.json')
process.env.CASTALIA_PROJECT = 'airi'
process.env.CHAR_ID = 'airi'
process.env.EMBED_MODE = 'none'
delete process.env.REFLECT_LLM_API_KEY
process.env.TRIAGE_LLM_API_KEY = 'test-key'
process.env.TRIAGE_LLM_URL = 'http://llm.stub/v1'

// ── 桩 LLM：从当天流水里**原样回显**用户/助手的句子 ───────────────────────────
let llmCalls = 0
globalThis.fetch = async (url, init = {}) => {
  const urlStr = String(url)
  if (!urlStr.includes('/chat/completions')) throw new Error(`unexpected fetch ${urlStr}`)
  llmCalls++
  const body = JSON.parse(init.body)
  const userPrompt = String(body?.messages?.[1]?.content || '')
  const transcript = userPrompt.split('【对话流水】')[1] || ''
  // 一条对话一轮：`[id8] 用户: …\n助手: …`；每轮事件都回显该轮原句，保证摘录能溯源到那一行
  const pairs = transcript.split(/\n\n+/).map((row) => row.replace(/^\[[0-9a-f]{8}\]\s*/, ''))
  const events = []
  for (const row of pairs) {
    const u = row.match(/用户: ([^\n]+)/)
    const a = row.match(/助手: ([^\n]+)/)
    if (!u) continue
    events.push({
      title: events.length === 0 ? '测试事件' : `测试事件${events.length + 1}`,
      summary: '一条用于回归的测试事件',
      userQuote: u[1].trim(),
      assistantQuote: a ? a[1].trim() : '',
      people: ['用户'],
      looseEnds: [],
      confidence: 0.9,
    })
  }
  const content = JSON.stringify({ events, skipped: 0 })
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }),
    text: async () => '',
  }
}

// ── 找引擎 ───────────────────────────────────────────────────────────────────
const { DatabaseManager } = await import(dist('db.js'))
const { saveConversationTurn } = await import(dist('store.js'))
const { runEventDigest } = await import(dist('eventDigest.js'))
const { recallTemporalForQuery } = await import(dist('temporalRecall.js'))

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

console.log(`bank: ${root}`)

// ── 种子 A：本地今天 00:30 的对话（UTC 是昨天 16:30）────────────────────────
const boundary = new Date()
boundary.setHours(0, 30, 0, 0)
const general = DatabaseManager.getInstance('airi', 'general')
const turn = await saveConversationTurn('凌晨一点还在改向量索引，困得不行', '那我陪你把最后一版跑完。', 'airi')
general.prepare('UPDATE memory SET created_at = ?, updated_at = ?, last_accessed_at = ? WHERE id = ?')
  .run(boundary.toISOString(), boundary.toISOString(), boundary.toISOString(), turn.id)
console.log(`A 边界对话 created_at=${boundary.toISOString()} 本地日=${localDay(boundary)} id=${turn.id.slice(0, 8)}`)

// ── 种子 B：一条落在 project 分类库里的对话（引擎自称会扫所有分类库）──────────
const projDb = DatabaseManager.getInstance('airi', 'project')
const projId = 'proj0000-1111-2222-3333-444455556666'
const nowIso = new Date().toISOString()
projDb.prepare(`
  INSERT INTO memory (id, text, project, type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
  VALUES (?, ?, 'airi', 'episodic', 'conversation', '[]', 0.5, 'airi', 'conversation_log', 'user', 'standard', 1, ?, ?, ?, 0, 0)
`).run(projId, '用户: 项目库里的一条记录，用来验证跨库扫描\n助手: 记下了。', nowIso, nowIso, nowIso)

// ── 跑整理 ───────────────────────────────────────────────────────────────────
const res = await runEventDigest({ project: 'airi', characterId: 'airi', days: 2 })
console.log('digest:', JSON.stringify(res))

const events = general.prepare("SELECT text, tags FROM memory WHERE source = 'daily_event' AND is_active = 1").all()
console.log(`事件行 ${events.length} 条，LLM 调用 ${llmCalls} 次`)

// A：日期口径
const evA = events.find(e => String(e.text).includes(`来源: ${turn.id.slice(0, 8)}`))
ok(Boolean(evA), 'A 边界对话产出了事件行')
if (evA) {
  const head = String(evA.text).split('\n')[0]
  ok(head === `# ${localDay(boundary)} · 测试事件`, `A 事件行按本地日分桶（实际「${head}」，应为 # ${localDay(boundary)} · 测试事件）`)
  ok(String(evA.tags).includes(`day:${localDay(boundary)}`), `A tag 带 day:${localDay(boundary)}`)
}

// A：时间路直取
const today = recallTemporalForQuery('今天在忙什么', { project: 'airi', characterId: 'airi' })
ok(today.hits.length > 0 && today.text.includes('测试事件'), `A "今天" 时间路直取到事件（命中 ${today.hits.length} 条）`)

// B：跨分类库
const evB = events.find(e => String(e.text).includes(`来源: ${projId.slice(0, 8)}`))
ok(Boolean(evB), 'B project 分类库里的对话也被整理（不再被静默跳过）')

const hasProgress = (db) => Boolean(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = 'event_digest_progress'").get().n)
ok(hasProgress(general), "B 进度表建在 general 库")
ok(hasProgress(projDb), 'B 进度表也建在 project 库')

// 已整理的不重复整理：第二遍不应再产出
const before = events.length
await runEventDigest({ project: 'airi', characterId: 'airi', days: 2 })
const after = general.prepare("SELECT count(*) n FROM memory WHERE source = 'daily_event' AND is_active = 1").get().n
ok(after === before, `重复运行不新增事件行（${before} → ${after}）`)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
