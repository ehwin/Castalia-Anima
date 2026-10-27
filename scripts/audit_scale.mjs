#!/usr/bin/env node
/**
 * 规模体检 —— 决定「要不要换图/时序数据库」的数据依据
 *
 * 只读:把每个 bank 的 sqlite 复制到系统临时目录再统计,绝不碰线上库。
 * 输出三样东西:
 *   1. 各 bank/project 的 memory / facts / edges / 向量 行数(量级)
 *   2. 最重库上的三条延迟:2 跳图遍历、按时刻取有效事实、LIKE 全表兜底
 *   3. 换引擎阈值判定(见下)
 *
 * 换引擎阈值(超过任一条才值得考虑 Kùzu / Cozo 这类嵌入式图/时序引擎):
 *   - 单库 edges > 200,000 或 facts > 500,000
 *   - 2 跳遍历 > 20ms,或需要 3 跳以上的变长路径
 *   - 需要社区发现 / PageRank 这类真正的图算法(不只是邻居列表)
 * 在此之前:SQLite 递归 CTE + 规范化实体表就够,且保住「一个 bank 一组自包含 sqlite 文件」
 * 的运维优势(复制即备份、无 daemon、离线、托盘随起随停)。
 *
 * 用法:node scripts/audit_scale.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
let vecPath = ''
try { vecPath = require('sqlite-vec').getLoadablePath() } catch { /* 可选 */ }

const BANKS = process.env.CASTALIA_BANKS_DIR || path.resolve(process.cwd(), '..', 'memory-banks')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-scale-'))

const files = []
if (fs.existsSync(BANKS)) {
  for (const bank of fs.readdirSync(BANKS)) {
    const bankDir = path.join(BANKS, bank)
    if (!fs.statSync(bankDir).isDirectory()) continue
    for (const project of fs.readdirSync(bankDir)) {
      const projDir = path.join(bankDir, project)
      if (!fs.statSync(projDir).isDirectory()) continue
      for (const memType of fs.readdirSync(projDir)) {
        const file = path.join(projDir, memType, 'memory.sqlite')
        if (fs.existsSync(file)) files.push({ bank, project, memType, file })
      }
    }
  }
}

function openCopy(entry, name) {
  const copy = path.join(TMP, name)
  fs.copyFileSync(entry.file, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(entry.file + suffix)) fs.copyFileSync(entry.file + suffix, copy + suffix)
  }
  const db = new Database(copy)
  if (vecPath) { try { db.loadExtension(vecPath) } catch { /* 无 vec0 也能统计正文 */ } }
  return db
}

const count = (db, sql) => { try { return db.prepare(sql).get().c } catch { return -1 } }
const rows = []
for (const [index, entry] of files.entries()) {
  const db = openCopy(entry, `s${index}.sqlite`)
  rows.push({
    ...entry,
    memory: count(db, 'SELECT COUNT(*) c FROM memory WHERE is_active = 1'),
    facts: count(db, 'SELECT COUNT(*) c FROM facts WHERE is_active = 1'),
    factsHistoric: count(db, "SELECT COUNT(*) c FROM facts WHERE is_active = 1 AND valid_to IS NOT NULL AND valid_to != ''"),
    edges: count(db, 'SELECT COUNT(*) c FROM edges'),
    vecMemory: count(db, 'SELECT COUNT(*) c FROM vec_memory'),
    vecFacts: count(db, 'SELECT COUNT(*) c FROM vec_facts'),
  })
  db.close()
}

const sum = key => rows.reduce((acc, r) => acc + Math.max(0, r[key]), 0)
rows.sort((a, b) => (b.memory + b.facts) - (a.memory + a.facts))

console.log(`bank/project/memType                  memory  facts  hist  edges  vec_m  vec_f`)
for (const r of rows.slice(0, 15)) {
  const label = `${r.bank}/${r.project}/${r.memType}`.padEnd(36)
  console.log(`${label}${String(r.memory).padStart(6)} ${String(r.facts).padStart(6)} ${String(r.factsHistoric).padStart(5)} ${String(r.edges).padStart(6)} ${String(r.vecMemory).padStart(6)} ${String(r.vecFacts).padStart(6)}`)
}
console.log(`\n库文件 ${files.length} 个;合计 active memory=${sum('memory')} facts=${sum('facts')} edges=${sum('edges')} 向量=${sum('vecMemory') + sum('vecFacts')} 被推翻的历史事实=${sum('factsHistoric')}`)

const heaviest = rows[0]
const mostEdges = [...rows].sort((a, b) => b.edges - a.edges)[0]

function probe(entry, label) {
  if (!entry || entry.memory <= 0) return
  const db = openCopy(entry, `probe-${label}.sqlite`)
  const seeds = db.prepare('SELECT id FROM memory WHERE is_active = 1 LIMIT 200').all().map(r => r.id)
  const twoHop = db.prepare(`
    WITH RECURSIVE hop(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN e.source_id = hop.id THEN e.target_id ELSE e.source_id END, hop.depth + 1
      FROM edges e JOIN hop ON (e.source_id = hop.id OR e.target_id = hop.id)
      WHERE hop.depth < 2
    )
    SELECT DISTINCT m.id FROM hop JOIN memory m ON m.id = hop.id WHERE hop.depth > 0
  `)
  const effectiveFacts = db.prepare("SELECT COUNT(*) c FROM facts WHERE subject = ? AND is_active = 1 AND (valid_to IS NULL OR valid_to = '')")
  const like = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active = 1 AND text LIKE ?')
  const time = (fn, n = 200) => {
    const t0 = performance.now()
    for (let i = 0; i < n; i++) fn(i)
    return (performance.now() - t0) / n
  }
  const ms2hop = time(i => twoHop.all(seeds[i % Math.max(1, seeds.length)]))
  const msTemporal = time(() => effectiveFacts.get('user'))
  const msLike = time(() => like.get('%的%'))

  // 向量 KNN:拿库里现成的一条向量当查询向量,量一下暴力 KNN 的绝对值
  let msKnn = null
  let vectorRows = null
  try {
    const probeVec = db.prepare('SELECT embedding FROM vec_memory LIMIT 1').get()
    vectorRows = db.prepare('SELECT COUNT(*) c FROM vec_memory').get().c
    if (probeVec) {
      const knn = db.prepare('SELECT rowid FROM vec_memory WHERE embedding MATCH ? ORDER BY distance LIMIT 10')
      msKnn = time(() => knn.all(probeVec.embedding), 20)
    }
  } catch { /* 没加载 vec0 或没有向量表 */ }

  // 实体层(v1.27):有多少事实/记忆真的连上了实体,以及实体里有多少是噪声
  // 老库(还没被 v1.27 引擎打开过)没有实体表 —— 如实报 n/a,不猜数。
  let entityInfo = null
  let entityMissing = false
  try {
    const byKind = {}
    for (const r of db.prepare('SELECT kind, COUNT(*) c FROM entities GROUP BY kind').all()) byKind[r.kind || 'unknown'] = r.c
    const noise = (byKind.path || 0) + (byKind.url || 0) + (byKind.config || 0) + (byKind.number || 0)
    entityInfo = {
      entities: count(db, 'SELECT COUNT(*) c FROM entities'),
      factsCovered: count(db, 'SELECT COUNT(DISTINCT fact_id) c FROM fact_entities'),
      memoriesCovered: count(db, 'SELECT COUNT(DISTINCT memory_id) c FROM memory_entities'),
      noise,
      byKind,
    }
  } catch (e) {
    entityMissing = /no such table|no such column/i.test(String(e && e.message))
  }
  db.close()

  console.log(`\n${label} ${entry.bank}/${entry.project}/${entry.memType}(memory=${entry.memory}, facts=${entry.facts}, edges=${entry.edges}, vectors=${vectorRows ?? 'n/a'})`)
  console.log(`  2 跳图遍历        ${ms2hop.toFixed(3)} ms/次   (阈值 20ms)`)
  console.log(`  按时刻取有效事实  ${msTemporal.toFixed(3)} ms/次   (阈值 20ms)`)
  console.log(`  LIKE 全表兜底     ${msLike.toFixed(3)} ms/次   (阈值 50ms)`)
  if (msKnn !== null) console.log(`  向量 KNN top10    ${msKnn.toFixed(2)} ms/次   (阈值 50ms;>50k 条向量时先上量化/分区)`)
  if (entityInfo) {
    const fp = entry.facts > 0 ? (entityInfo.factsCovered / entry.facts * 100) : 0
    const mp = entry.memory > 0 ? (entityInfo.memoriesCovered / entry.memory * 100) : 0
    console.log(`  实体层            ${entityInfo.entities} 个实体(噪声 ${entityInfo.noise});事实覆盖 ${entityInfo.factsCovered}/${entry.facts} (${fp.toFixed(1)}%),记忆覆盖 ${entityInfo.memoriesCovered}/${entry.memory} (${mp.toFixed(1)}%)`)
  } else if (entityMissing) {
    console.log('  实体层            n/a(该库还没被 v1.27 引擎打开过;引擎第一次打开时会自动建表并回填)')
  }
  return { ms2hop, msTemporal, msKnn, vectorRows, entityInfo }
}

if (heaviest && heaviest.memory > 0) {
  const a = probe(heaviest, '规模最大库')
  if (mostEdges && mostEdges !== heaviest) probe(mostEdges, '边最多库')

  const reasons = []
  const scale = [heaviest, mostEdges].filter(Boolean)
  if (scale.some(r => r.edges > 200000 || r.facts > 500000)) reasons.push('单库规模超过阈值')
  if (a && a.ms2hop > 20) reasons.push('2 跳遍历超过 20ms')
  if (a && a.vectorRows > 50000 && a.msKnn > 50) reasons.push(`向量 ${a.vectorRows} 条、暴力 KNN 超过 50ms`)
  console.log(reasons.length
    ? `\n结论:值得评估嵌入式图引擎 / 向量索引 —— ${reasons.join(';')}`
    : '\n结论:不需要换底层。规模与延迟都远在 SQLite 舒适区内;实体层已在 v1.27 落地(entities/fact_entities/memory_entities),现在真正的短板是**关系抽取覆盖率**(见上面「实体层」一行),不是存储引擎。')
}
else {
  console.log('\n没有可统计的库(检查 CASTALIA_BANKS_DIR)。')
}

fs.rmSync(TMP, { recursive: true, force: true })
