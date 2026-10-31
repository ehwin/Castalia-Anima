/**
 * 检索基准的度量口径（纯函数，无 IO）。
 *
 * 口径与众数是 2026-10-31 那轮实验定下来的，进仓库是为了让**下一次改 search.ts
 * 的人能在仓库内回答「检索变好还是变差」**，而不是重跑一遍论文脚本：
 *
 *   · 命中 = 该查询的 gold id 集合与 top-k 的交集非空（多 gold 任一对即算对）
 *   · MRR  = 1 / 第一个 gold 的排名（无命中记 0）
 *   · 配对 = 精确 McNemar（只有一方命中才算不一致对，双侧二项）
 *
 * 三条纪律（写在这里，因为读数的人最先看到的是代码）：
 *   1) 每个臂必须用**独立库副本**：检索会写 memory_access_log 与 last_accessed_at，
 *      共用副本会污染后续臂（实测作废过一整轮）。
 *   2) 任何条件化改动都要同时报「常数基线」（永远返回同一个答案），否则会把常数
 *      先验读成机制收益。
 *   3) 二元符号输出不能与三分类参考直接比；不同口径的数字不许混在一条结论里。
 */

/** 排名列表里第一个 gold 的位置（1-based），没有命中返回 null。 */
export function firstGoldRank(ids, gold) {
  const g = gold instanceof Set ? gold : new Set(gold);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] != null && g.has(String(ids[i]))) return i + 1;
  }
  return null;
}

/**
 * 一组查询的汇总。
 * @param perQ [{ q, ids: string[] }]  ids 必须按分数降序（即检索返回顺序）
 * @param goldOf Map<string, Set<string>>|{get:Function}
 */
export function summarize(perQ, goldOf) {
  const n = perQ.length;
  const rec = { 1: 0, 5: 0, 10: 0 };
  let mrr = 0;
  const perQuery = [];
  for (const item of perQ) {
    const gold = goldOf.get(item.q);
    const rank = gold && gold.size ? firstGoldRank(item.ids, gold) : null;
    if (rank) {
      mrr += 1 / rank;
      for (const k of [1, 5, 10]) if (rank <= k) rec[k]++;
    }
    perQuery.push({ q: item.q, rank });
  }
  return {
    n,
    hit1: n ? +(rec[1] / n).toFixed(3) : 0,
    hit5: n ? +(rec[5] / n).toFixed(3) : 0,
    hit10: n ? +(rec[10] / n).toFixed(3) : 0,
    mrr: n ? +(mrr / n).toFixed(3) : 0,
    misses: perQuery.filter(x => !x.rank).length,
    perQuery,
  };
}

/** 精确 McNemar：a 命中而 b 未命中 vs 反之，双侧二项。 */
export function mcnemarExact(aPerQuery, bPerQuery, k = 1) {
  const hit = (r) => Boolean(r.rank && r.rank <= k);
  let onlyA = 0, onlyB = 0;
  for (let i = 0; i < aPerQuery.length; i++) {
    const ha = hit(aPerQuery[i]), hb = hit(bPerQuery[i]);
    if (ha && !hb) onlyA++; else if (!ha && hb) onlyB++;
  }
  const n = onlyA + onlyB;
  if (!n) return { onlyA, onlyB, p: 1 };
  const C = (nn, kk) => { let r = 1; for (let i = 1; i <= kk; i++) r = r * (nn - i + 1) / i; return r; };
  let p = 0;
  for (let i = 0; i <= Math.min(onlyA, onlyB); i++) p += C(n, i) * Math.pow(0.5, n);
  return { onlyA, onlyB, p: +Math.min(1, 2 * p).toFixed(4) };
}
