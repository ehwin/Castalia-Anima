
/** P0 干跑：在库副本上跑 反射抽取 / 整合 / digest，量事实增量与代价。只读真实库不动。 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BANK_DIR = 'D:/AI/hermes-home/cache/scratch/bank-p0'
process.env.MEMORY_DB_DIR = BANK_DIR
process.env.MEMORY_CONFIG = `${BANK_DIR}/config.json`
process.env.CASTALIA_PROJECT = 'airi'
process.env.CHAR_ID = 'airi'
delete process.env.EMBED_MODE

const dist = f => pathToFileURL(path.join('D:/AI/castalia/Castalia-Anima/dist', f)).href
await import(dist('configLoader.js'))
const { DatabaseManager } = await import(dist('db.js'))
const MEM_TYPES = ['general', 'user', 'project', 'reference', 'feedback']

function counts() {
  const out = { memory: 0, active: 0, facts: 0, entities: 0, edges: 0, conversationLog: 0 }
  for (const mt of MEM_TYPES) {
    try {
      const db = DatabaseManager.getInstance('airi', mt)
      const one = sql => { try { return Number(db.prepare(sql).get()?.c ?? 0) } catch { return 0 } }
      out.memory += one('SELECT COUNT(*) c FROM memory')
      out.active += one('SELECT COUNT(*) c FROM memory WHERE is_active=1')
      out.facts += one('SELECT COUNT(*) c FROM facts')
      out.entities += one('SELECT COUNT(*) c FROM entities')
      out.edges += one('SELECT COUNT(*) c FROM edges')
      out.conversationLog += one("SELECT COUNT(*) c FROM memory WHERE source='conversation_log' AND is_active=1")
    }
    catch (e) { /* 该分类库不存在 */ }
  }
  return out
}

const db = DatabaseManager.getInstance('airi', 'general')
console.log('facts 列:', db.prepare('PRAGMA table_info(facts)').all().map(r => r.name).join(','))

const before = counts()
console.log('BEFORE', JSON.stringify(before))

const driver = await import(dist('reflectDriver.js'))
const { runDigest } = await import(dist('digest.js'))
console.log('reflect 已配置:', driver.isReflectConfigured(), '| 事实抽取启用:', driver.isFactExtractionEnabled())

const t0 = Date.now()
let auto
try { auto = await driver.runAutoReflect('airi', 30, 'airi') }
catch (e) { auto = { error: e.message } }
const tAuto = Date.now() - t0
console.log('runAutoReflect', JSON.stringify(auto).slice(0, 700), `(${(tAuto/1000).toFixed(1)}s)`)

const t1 = Date.now()
let cons
try { cons = await driver.runConsolidate('airi', 'airi', undefined, undefined, { force: true }) }
catch (e) { cons = { error: e.message } }
const tCons = Date.now() - t1
console.log('runConsolidate', JSON.stringify(cons).slice(0, 700), `(${(tCons/1000).toFixed(1)}s)`)

const t2 = Date.now()
let dig
try { dig = await runDigest('airi', 'airi') }
catch (e) { dig = { error: e.message } }
const tDig = Date.now() - t2
console.log('runDigest', JSON.stringify(dig).slice(0, 500), `(${(tDig/1000).toFixed(1)}s)`)

const after = counts()
console.log('AFTER ', JSON.stringify(after))
console.log('DELTA ', JSON.stringify(Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]]))))
console.log('耗时合计', ((tAuto + tCons + tDig)/1000).toFixed(1), 's')

// 抽样看新事实质量
try {
  const rows = db.prepare(`
    SELECT subject, predicate, object, confidence, valid_from, superseded_by
    FROM facts ORDER BY rowid DESC LIMIT 8
  `).all()
  console.log('最近 8 条事实:')
  for (const r of rows) console.log('  -', `${r.subject} | ${r.predicate} | ${String(r.object).slice(0, 70)} | conf=${r.confidence} | superseded=${r.superseded_by ?? '-'}`)
}
catch (e) { console.log('抽样失败', e.message) }
