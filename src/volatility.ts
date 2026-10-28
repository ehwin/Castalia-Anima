/**
 * v1.28 谓词易变性 —— 决定"同一主体、同一关系出现新值时，旧值是否失效"。
 *
 * v1.23 只认一张硬编码的功能性谓词表：表内失效、表外一律并存。
 * 表外一律并存会把"当前主题"这类慢变单值关系变成越积越多的矛盾；
 * 而"喜欢猫 / 猫毛过敏"这类本来就该并存的，又不能被误杀。
 *
 * 这里改成两步判断：
 *   1. 语义先验：
 *      - 可多值关系（喜欢/兴趣/朋友/计划…）永不自动失效；
 *      - 计划/意向类单独一张表 —— 计划变更不是"旧计划为假"，只并存；
 *      - 单值关系种子表（姓名/居住地/职业…）保持 v1.23 行为。
 *   2. 证据补充（表外谓词看历史）：
 *      - ≥3 条记录、≥2 个不同 object、换值间隔中位数 ≥7 天 → 慢变单值关系，允许失效；
 *      - 出现 3 天内的快速翻转（心情/状态）→ 高易变，只并存；
 *      - 证据不足 → 不失效（保守优先）。
 *
 * 失效写双时间轴，不删除：
 *   valid_to      = 新值的 valid_from（"这个说法何时起不再成立"，不是"我们何时知道"）
 *   expired_at    = 判定时刻（事务时间，可复现"按当时已知重放"）
 *   superseded_by = 推翻它的新事实 id
 *
 * 参考：RoMem（arXiv 2604.11544）的 volatility gate + "不删除只降权"；
 *       Graphiti `edge_operations._apply_temporal_invalidation` 的双时间轴与区间守卫。
 *
 * 注意：RoMem 代码里的 `_is_one_to_many_slot()`（n_unique/n_obs > 0.5）是**预训练数据过滤器**，
 * 用来剔除标签有歧义的 slot，不是"多值谓词"的运行时判据。别把它当成"比率高就不失效"——
 * "当前项目"这类槽位每次换值同样会让比率升高，那样会把它误判成多值，正好废掉本模块。
 */

export interface VolatilityEvidence {
  /** 该 (subject,predicate) 的历史记录条数（含已打 valid_to 的） */
  samples: number
  /** 出现过的不同 object 数 */
  distinctObjects: number
  /** 相邻两次"换值"的最小间隔（天）；样本不足时为 null */
  minIntervalDays: number | null
  /** 相邻两次"换值"的间隔中位数（天）；样本不足时为 null */
  medianIntervalDays: number | null
  /**
   * 变更风险率 α：换值次数 / 观测跨度天数（RoMem Semantic Speed Gate 输出的那个量，
   * 这里是它的闭式估计）。0 = 从没变过。
   */
  alphaPerDay: number
  /** 7 天内换一次的概率 = 1 - exp(-α·7)。对外说的 volatility 就是它 */
  pChange7d: number
  /** 与 pChange7d 同值，保留旧名。0 = 稳定，1 = 每天翻 */
  volatility: number
}

export type SupersedeReason =
  | 'open-predicate'
  | 'functional-predicate'
  | 'plan-predicate'
  | 'slow-observed'
  | 'churny-observed'
  | 'insufficient-evidence'

export interface SupersedeDecision {
  supersede: boolean
  reason: SupersedeReason
  volatility?: number
}

/** 单值关系种子表：一个主体只能有一个值，新值直接接管（旧值打 valid_to）。与 v1.23 一致。 */
export const FUNCTIONAL_PREDICATES = new Set([
  '姓名', '名字', '年龄', '职业', '居住地', '工作单位', '生日', '称呼', '昵称',
  'name', 'age', 'job', 'occupation', 'residence', 'birthday',
]);

/** 可多值关系：多条同时成立，永不自动失效。 */
export const OPEN_PREDICATES = new Set([
  '喜欢', '讨厌', '爱吃', '爱好', '兴趣', '朋友', '同事', '家人', '宠物',
  '擅长', '会', '拥有', '习惯', '口头禅', '经历',
  'likes', 'dislikes', 'loves', 'hobbies', 'interests', 'friends', 'family',
  'pets', 'skills', 'habits',
]);

/**
 * 计划/意向类：计划变了不等于"旧计划为假"。
 * 依据 Graphiti `normalize_future_temporal_bounds`：意向类陈述的 valid_at 取陈述时刻，
 * 而"by Friday"这类软截止不构成 invalid_at。
 */
export const PLAN_PREDICATES = new Set([
  '计划', '打算', '想要', '想', '准备', '目标', '安排', '意图',
  'plan', 'plans', 'intend', 'intends', 'will', 'wants', 'goal', 'goals',
]);

/** 中位变更间隔 ≥7 天（pChange7d ≤0.5）才认为"慢变" —— 0.5 ≈ 7 天半衰期 */
export const SUPERSEDE_VOLATILITY_MAX = 0.5;
export const MIN_SUPERSEDE_SAMPLES = 3;
/** 间隔短于 3 天算快速翻转：属于状态/心情，不做失效 */
export const CHURN_INTERVAL_DAYS = 3;

const DAY_MS = 86_400_000;

export function normalizePredicate(predicate: unknown): string {
  return String(predicate ?? '').trim().toLowerCase();
}

/** 表外谓词才需要查历史证据；表内谓词直接由先验决定，省一次查询。 */
export function needsEvidence(predicate: unknown): boolean {
  const key = normalizePredicate(predicate);
  return !OPEN_PREDICATES.has(key)
    && !FUNCTIONAL_PREDICATES.has(key)
    && !PLAN_PREDICATES.has(key);
}

/**
 * 从历史记录里估计谓词易变性。读全部记录（含已打 valid_to 的），因为"变化过几次"本身就是证据。
 * 列未迁移 / 表不存在时返回空证据，调用方退化成"不失效"。
 */
export function estimatePredicateVolatility(
  db: any,
  project: string,
  subject: string,
  predicate: string,
  characterId?: string,
): VolatilityEvidence {
  const empty: VolatilityEvidence = {
    samples: 0, distinctObjects: 0, minIntervalDays: null, medianIntervalDays: null,
    alphaPerDay: 0, pChange7d: 0, volatility: 0,
  };
  let rows: { object: string; at: string }[] = [];
  try {
    // 用事件时间（valid_from 优先，否则入库时间）：同一事实"什么时候成立"才是变化间隔。
    rows = db.prepare(`
      SELECT object, COALESCE(valid_from, created_at) AS at FROM facts
      WHERE project = ? AND COALESCE(character_id, '') = ? AND subject = ? AND predicate = ?
      ORDER BY julianday(COALESCE(valid_from, created_at))
    `).all(project, characterId ?? '', subject, predicate) as any[];
  } catch {
    return empty;
  }
  if (rows.length === 0) return empty;

  const distinct = new Set(rows.map(r => String(r.object ?? '')));
  const changeTimes: number[] = [];
  let seen: string | null = null;
  let firstTime: number | null = null;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    if (firstTime === null) firstTime = at;
    const object = String(row.object ?? '');
    if (seen === null) { seen = object; continue; }
    if (object !== seen) {
      seen = object;
      changeTimes.push(at);
    }
  }

  const intervals: number[] = [];
  let cursor = firstTime;
  for (const at of changeTimes) {
    if (cursor === null) break;
    intervals.push(Math.max(0, (at - cursor) / DAY_MS));
    cursor = at;
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? null
    : (sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  // 变更风险率 α（RoMem 的 Semantic Speed Gate 输出的那个量）：
  // 每次"换值"算一次事件，观测窗口 = 首末观测之间的天数，α = 事件数 / 天数。
  // 这就是 p_change(Δt) = 1 - exp(-α·Δt) 这个常数风险率模型的闭式极大似然估计 ——
  // 不需要训练、不需要 embedding，与论文里 2 层 MLP + sigmoid 出的 α 是同一个量
  // （Tencent/RoMem · romem/kge/model/romem_chronor.py）。预训练版的意义在于零样本泛化到
  // 没见过的关系；已有历史观测时，直接用观测更能反映这个谓词在这个人身上的实际易变性。
  const lastAt = rows.length > 0 ? Date.parse(rows[rows.length - 1].at) : Number.NaN;
  const spanDays = (firstTime !== null && Number.isFinite(lastAt)) ? (lastAt - firstTime) / DAY_MS : 0;
  const alphaPerDay = spanDays > 0 ? changeTimes.length / spanDays : 0;
  // 对外说的 volatility = "7 天内换一次"的概率：0.5 ≈ 7 天半衰期，与旧阈值同义。
  const pChange7d = 1 - Math.exp(-alphaPerDay * 7);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;

  return {
    samples: rows.length,
    distinctObjects: distinct.size,
    minIntervalDays: sorted.length === 0 ? null : sorted[0],
    medianIntervalDays: median,
    alphaPerDay: round3(alphaPerDay),
    pChange7d: round3(pChange7d),
    volatility: round3(pChange7d),
  };
}

/** 判断某个 (subject,predicate) 的新值是否应该让旧值失效 */
export function shouldSupersede(input: { predicate: unknown; evidence?: VolatilityEvidence }): SupersedeDecision {
  const key = normalizePredicate(input.predicate);
  if (OPEN_PREDICATES.has(key)) return { supersede: false, reason: 'open-predicate' };
  if (PLAN_PREDICATES.has(key)) return { supersede: false, reason: 'plan-predicate' };
  if (FUNCTIONAL_PREDICATES.has(key)) return { supersede: true, reason: 'functional-predicate' };

  const evidence = input.evidence;
  if (!evidence || evidence.samples < MIN_SUPERSEDE_SAMPLES || evidence.distinctObjects < 2 || evidence.medianIntervalDays === null) {
    return { supersede: false, reason: 'insufficient-evidence', volatility: evidence?.volatility };
  }
  if (evidence.minIntervalDays !== null && evidence.minIntervalDays < CHURN_INTERVAL_DAYS) {
    return { supersede: false, reason: 'churny-observed', volatility: evidence.volatility };
  }
  if (evidence.volatility > SUPERSEDE_VOLATILITY_MAX) {
    return { supersede: false, reason: 'churny-observed', volatility: evidence.volatility };
  }
  return { supersede: true, reason: 'slow-observed', volatility: evidence.volatility };
}

/**
 * 区间语义（实现在 store.ts 的时间线重算里，这里只记录规则）：
 * 失效不是"把当前值之前的所有行都打成 now"，而是重算整条链 —— 每行的 valid_to 取链上
 * 下一个值的 valid_from。同一时刻的两个值无法排序，按 Graphiti 的"区间不相交就不算推翻"
 * 保持并存（v1.23-fix 的"同批不互相打 valid_to"由此自然成立）。于是回溯补录的旧事实会被
 * 正确的值闭合，而不是与新值互相打掉。
 */
