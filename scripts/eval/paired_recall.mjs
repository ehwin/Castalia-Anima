#!/usr/bin/env node
/**
 * Paired comparison of two retrieval runs, item by item.
 *
 * It does **not** infer discordant counts from totals: two runs can both hit
 * 50/69 while ten items were lost and ten others gained, and a totals-only
 * reading would call that "no loss". Input must be per-query results, as written
 * by `run_arms.mjs --out` (each arm carries `逐条: [{ q, rank }]`).
 *
 * Usage:
 *   node paired_recall.mjs --before before.json --after after.json [--k 1] [--arm default]
 *   node paired_recall.mjs --pairs pairs.json      # [{ id, before: 0|1, after: 0|1 }]
 *   node paired_recall.mjs --self-check
 *   node paired_recall.mjs                         # resolution + flip budget only
 *
 * Exit codes: 0 pass · 1 fail (significant regression) · 3 inconclusive (needs
 * more items) · 2 bad or missing input. CI must treat 3 as "not pass".
 *
 * The verdict is a **case-level regression budget** for a frozen item set, not a
 * statistical proof of non-inferiority. A 2pp equivalence claim is not available
 * at n=69 under either design; see the resolution lines.
 */
import fs from 'node:fs'

const P0 = 0.725 // exclusion-adjusted Hit@1 on the 69-item set
const ALPHA = 0.05
const POWER = 0.8

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}

function z(p) {
  // Inverse normal CDF (Acklam).
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Single-proportion approximation. Reference only, not a paired guarantee. */
function singleProportionN(p, margin, alpha = ALPHA, power = POWER) {
  return Math.ceil(((z(1 - alpha) + z(power)) ** 2) * p * (1 - p) / (margin ** 2))
}

/**
 * Paired (McNemar) approximation for a margin, given the expected share of
 * items that flip either way. Still approximate: the exact n also depends on
 * the expected difference.
 */
function pairedN(discordance, margin, alpha = ALPHA, power = POWER) {
  return Math.ceil(((z(1 - alpha / 2) + z(power)) ** 2) * discordance / (margin ** 2))
}

function choose(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = r * (n - i + 1) / i
  return r
}

function binomPmf(n, k, p) {
  return choose(n, k) * p ** k * (1 - p) ** (n - k)
}

/** Exact McNemar p for observed b against a hypothesized difference d. */
function mcnemarP(b, c, d = 0) {
  const k = b + c
  if (k === 0) return 1
  const p = (1 + d) / 2
  let lower = 0
  for (let i = 0; i <= b; i++) lower += binomPmf(k, i, p)
  let upper = 0
  for (let i = b; i <= k; i++) upper += binomPmf(k, i, p)
  return Math.min(1, 2 * Math.min(lower, upper))
}

/**
 * Exact interval for the paired difference (b-c)/n, by inverting the McNemar
 * test (Tango-style). The Wald interval is [0,0] at zero flips, which claims a
 * certainty the data does not carry; this returns [-1,1] there.
 */
function exactDiffCI(b, c, alpha = ALPHA) {
  if (b + c === 0) return [-1, 1]
  const accepted = d => mcnemarP(b, c, d) >= alpha
  let lo = 1
  let hi = -1
  for (let d = -1; d <= 1 + 1e-9; d += 0.001) {
    if (accepted(d)) { lo = d; break }
  }
  for (let d = 1; d >= -1 - 1e-9; d -= 0.001) {
    if (accepted(d)) { hi = d; break }
  }
  return [Math.max(-1, +lo.toFixed(3)), Math.min(1, +hi.toFixed(3))]
}

function verdict(b, c, p) {
  // Pre-registered case-level budget. Equivalence is not claimed at 2pp.
  if (b === 0) return 'pass'
  if (b <= 1 && b - c <= 0) return 'pass'
  if (p < ALPHA && b > c) return 'fail'
  return 'inconclusive'
}

function readRun(file, armName) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const arms = data.各臂 || data.arms || []
  const arm = armName ? arms.find(a => a.arm === armName) : arms[0]
  if (!arm) throw new Error(`no arm ${armName ?? ''} in ${file}`)
  const rows = arm.逐条 || arm.perQuery || []
  if (!rows.length) throw new Error(`no per-query rows in ${file}; rerun with --out`)
  return new Map(rows.map(r => [String(r.q ?? r.id), r.rank ?? null]))
}

function pairsFromRuns(beforeFile, afterFile, k, armName) {
  const a = readRun(beforeFile, armName)
  const b = readRun(afterFile, armName)
  const ids = [...a.keys()].filter(id => b.has(id))
  if (ids.length !== a.size || ids.length !== b.size) {
    throw new Error(`query sets differ: ${a.size} vs ${b.size}, common ${ids.length}; only paired runs are comparable`)
  }
  return ids.map(id => ({
    id,
    before: a.get(id) != null && a.get(id) <= k ? 1 : 0,
    after: b.get(id) != null && b.get(id) <= k ? 1 : 0,
  }))
}

function counts(pairs) {
  let before = 0
  let after = 0
  let lost = 0
  let gained = 0
  for (const p of pairs) {
    before += p.before
    after += p.after
    if (p.before && !p.after) lost++
    if (!p.before && p.after) gained++
  }
  return { n: pairs.length, before, after, lost, gained }
}

function printBudget(n) {
  console.log('resolution (single proportion, reference only)')
  const se = Math.sqrt(P0 * (1 - P0) / n)
  console.log(`  n=${n}, p=${P0}: SE=${(se * 100).toFixed(2)}pp, 95% CI ±${(1.96 * se * 100).toFixed(1)}pp`)
  console.log(`  n for 2pp / 5pp / 10pp (independence assumption): ${singleProportionN(P0, 0.02)} / ${singleProportionN(P0, 0.05)} / ${singleProportionN(P0, 0.10)}`)
  for (const psi of [0.05, 0.1, 0.2])
    console.log(`  paired n at ${(psi * 100).toFixed(0)}% discordance, 5pp margin: ${pairedN(psi, 0.05)}`)
  console.log('\nflip budget at this n (b = lost, c = gained)')
  console.log('  b  c   diff      exact 95% CI       p')
  for (const [b, c] of [[0, 0], [1, 0], [2, 0], [3, 0], [5, 0], [6, 0], [10, 10]]) {
    const ci = exactDiffCI(b, c)
    console.log(`  ${String(b).padStart(2)} ${String(c).padStart(2)}  ${((b - c) / n * 100).toFixed(1).padStart(6)}pp  [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]pp`.padEnd(46) + `  ${mcnemarP(b, c).toFixed(3)}`)
  }
}

function selfCheck() {
  const assert = (ok, name) => { if (!ok) { console.error(`self-check failed: ${name}`); process.exit(1) } }
  const eq = counts([
    ...Array.from({ length: 40 }, () => ({ before: 1, after: 1 })),
    ...Array.from({ length: 10 }, () => ({ before: 1, after: 0 })),
    ...Array.from({ length: 10 }, () => ({ before: 0, after: 1 })),
    ...Array.from({ length: 9 }, () => ({ before: 0, after: 0 })),
  ])
  assert(eq.before === 50 && eq.after === 50, 'equal totals')
  assert(eq.lost === 10 && eq.gained === 10, 'equal totals hide flips')
  assert(verdict(10, 10, mcnemarP(10, 10)) === 'inconclusive', '10/10 is inconclusive')
  assert(verdict(6, 0, mcnemarP(6, 0)) === 'fail', '6 clean losses fail')
  assert(verdict(2, 0, mcnemarP(2, 0)) === 'inconclusive', '2 losses inconclusive')
  assert(verdict(1, 0, mcnemarP(1, 0)) === 'inconclusive', 'a single net loss is inconclusive')
  assert(verdict(1, 1, mcnemarP(1, 1)) === 'pass', 'one flip each way passes')
  const ci0 = exactDiffCI(0, 0)
  assert(ci0[0] === -1 && ci0[1] === 1, 'zero flips are uninformative')
  assert(exactDiffCI(6, 0)[0] > 0, 'six losses exclude zero')
  assert(verdict(0, 3, mcnemarP(0, 3)) === 'pass', 'only gains is a pass')
  console.log('self-check ok')
}

if (process.argv.includes('--self-check')) {
  selfCheck()
  process.exit(0)
}

const k = Number(arg('k', 1))
const nArg = Number(arg('n', 69))

let pairs = null
if (arg('pairs')) {
  const raw = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8'))
  pairs = raw.map(p => ({ id: String(p.id), before: Number(p.before) ? 1 : 0, after: Number(p.after) ? 1 : 0 }))
}
else if (arg('before') && arg('after')) {
  try {
    pairs = pairsFromRuns(arg('before'), arg('after'), k, arg('arm'))
  }
  catch (e) {
    console.error(`cannot pair runs: ${e.message}`)
    process.exit(2)
  }
}
else if (arg('hits-before') !== undefined || arg('hits-after') !== undefined) {
  console.error('hit totals are not enough: equal totals can hide equal losses and gains.')
  console.error('pass per-query runs (--before/--after from run_arms --out) or --pairs.')
  process.exit(2)
}

if (!pairs) {
  printBudget(nArg)
  console.log('\nNo per-item pairs given, so no verdict. Exit 2.')
  process.exit(2)
}

const { n, before, after, lost, gained } = counts(pairs)
if (n === 0) {
  console.error('empty pair set')
  process.exit(2)
}
const diff = (lost - gained) / n
const ci = exactDiffCI(lost, gained)
const p = mcnemarP(lost, gained)
const v = verdict(lost, gained, p)

console.log(`paired on ${n} items, hit@${k}`)
console.log(`  before ${before}/${n} · after ${after}/${n}`)
console.log(`  b (lost)=${lost} · c (gained)=${gained}`)
console.log(`  diff ${(diff * 100).toFixed(2)}pp, exact 95% CI [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]pp, McNemar p=${p.toFixed(3)}`)
console.log(`  verdict: ${v}`)
console.log(`  note: case-level budget at n=${n}; 2pp equivalence would need ${singleProportionN(P0, 0.02)} independent items or ≈${pairedN(Math.max(0.05, (lost + gained) / n), 0.02)} paired ones at this discordance`)

process.exit(v === 'pass' ? 0 : v === 'fail' ? 1 : 3)
