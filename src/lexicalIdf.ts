/**
 * 词法检索的 IDF 加权(Anima 路线,2026-10-29)
 *
 * 为什么单独一个模块:Anima 没有 memory_fts(引擎不建 FTS5),所以 Lite 那套
 * 「预切 bigram 写 FTS5 表 + bm25()」不能照搬。但研究发现里真正起作用的那部分
 * —— **全局 IDF**:高频 bigram(「记得」「自己」「the」)必须降权 —— 与存储无关,
 * 可以在进程内直接算:语料只有几百条,open 时建一次倒排,内存几 MB。
 *
 * 这条是"同样的结论、另一条技术路线":Lite = FTS5 预切表;Anima = 内存倒排 + BM25。
 */

/** BM25 参数(与 Lucene/sqlite-vec 默认同档) */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface Bm25Doc { id: string; terms: string[] }

export interface Bm25Index {
  N: number;
  avgdl: number;
  df: Map<string, number>;
  postings: Map<string, Map<string, number>>; // term -> docId -> tf
  docLen: Map<string, number>;
  docIds: string[];
}

export function buildBm25Index(docs: { id: string; text: string }[], tokenize: (s: string) => string[]): Bm25Index {
  const df = new Map<string, number>();
  const postings = new Map<string, Map<string, number>>();
  const docLen = new Map<string, number>();
  let total = 0;
  for (const d of docs) {
    const terms = tokenize(d.text).filter(t => t.length > 0);
    docLen.set(d.id, terms.length);
    total += terms.length;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      df.set(t, (df.get(t) || 0) + 1);
      let p = postings.get(t);
      if (!p) { p = new Map(); postings.set(t, p); }
      p.set(d.id, c);
    }
  }
  return {
    N: docs.length,
    avgdl: docs.length ? total / docs.length : 0,
    df, postings, docLen,
    docIds: docs.map(d => d.id),
  };
}

/** BM25 的 IDF(Robertson/Sparck-Jones,恒正版):ln(1 + (N-df+0.5)/(df+0.5)) */
export function idf(idx: Bm25Index, term: string): number {
  const df = idx.df.get(term) || 0;
  return Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
}

/**
 * 给一个查询打分。返回 docId → 分数(只含至少命中一个词项的文档)。
 * 关键点:每个词项的贡献乘上它的 IDF,所以「记得」这种到处都有的 bigram 几乎不贡献,
 * 而只出现在一两条记忆里的实体词权重高 —— 这正是 Anima 现在缺的(它按命中词数/词数算覆盖率,
 * 高频 bigram 与实体词一视同仁,源码里 533-545 行的注释就是这个问题的自述)。
 */
export function bm25Scores(idx: Bm25Index, queryTerms: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const uniq = [...new Set(queryTerms)];
  for (const term of uniq) {
    const idfTerm = idf(idx, term);
    if (idfTerm <= 0) continue;
    const p = idx.postings.get(term);
    if (!p) continue;
    for (const [docId, tf] of p) {
      const dl = idx.docLen.get(docId) || 1;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (idx.avgdl || 1)));
      const s = idfTerm * (tf * (BM25_K1 + 1)) / (denom || 1);
      scores.set(docId, (scores.get(docId) || 0) + s);
    }
  }
  return scores;
}

/** 覆盖率打分(Anima 现有词法口径的等价物):命中词数 / min(词数, cap)。用来做对照。 */
export function coverageScores(idx: Bm25Index, queryTerms: string[], cap = 4): Map<string, number> {
  const scores = new Map<string, number>();
  const uniq = [...new Set(queryTerms)];
  const hits = new Map<string, number>();
  for (const term of uniq) {
    const p = idx.postings.get(term);
    if (!p) continue;
    for (const docId of p.keys()) hits.set(docId, (hits.get(docId) || 0) + 1);
  }
  const denom = Math.max(1, Math.min(uniq.length, cap));
  for (const [docId, c] of hits) scores.set(docId, c / denom);
  return scores;
}
