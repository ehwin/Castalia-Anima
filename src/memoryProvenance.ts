/** Sources produced by the runtime itself rather than by an external or user interaction. */
export const DERIVED_MEMORY_SOURCES = ['agent_diary', 'agent_state'] as const;

export type DerivedMemorySource = typeof DERIVED_MEMORY_SOURCES[number];

export function isDerivedMemorySource(source: unknown): boolean {
  return DERIVED_MEMORY_SOURCES.includes(String(source || '') as DerivedMemorySource);
}

/** SQL predicate for public memory paths. NULL/empty sources remain ordinary legacy evidence. */
export function publicMemorySourceSql(alias = ''): string {
  const column = alias ? `${alias}.source` : 'source';
  return `COALESCE(${column}, '') NOT IN ('agent_diary', 'agent_state')`;
}

/** SQL predicate for paths that may explicitly browse diary rows but never state snapshots. */
export function memorySourceWithoutStateSql(alias = ''): string {
  const column = alias ? `${alias}.source` : 'source';
  return `COALESCE(${column}, '') <> 'agent_state'`;
}

/**
 * 生成型来源（2026-10-31）：系统自己产出的记录 —— 日记、状态快照，以及反思链
 * （reflect_merge / reflect_split / reflect_extract / reflect_summary / reflect_insight）。
 *
 * 用途：判断一次"重复写入"是否构成**独立证据**。派生记录复述同一段原文时，它的
 * 依据仍是那条原文，不能当成第二次外部提及去抬 reference_count（审计 §5 第 4 项）。
 * 注意这比 `isDerivedMemorySource` 宽：那个只覆盖日记/状态，是注入与检索的可见性口径。
 */
export function isGeneratedSource(source: unknown): boolean {
  const s = String(source ?? '').trim().toLowerCase();
  if (!s) return false;
  return isDerivedMemorySource(s) || s.startsWith('reflect_');
}

/**
 * 原料行（2026-10-31）：对话流水、事件层、状态快照、日记。
 *
 * 它们是**证据原件与导航层**，不是可再生的摘要。任何自动路径都不得把它们软删
 * (`is_active=0`) 后继续跑：
 *   - `emotion.ts` 的 VAD 队列在出队时校验 `is_active=1 AND source='conversation_log'`，
 *     标死的行直接丢弃，且不会重新入队 —— 情感证据从此永久缺一条；
 *   - `reflectionSources.ts` 只把 `is_active=1` 的对话当抽取来源，标死即退出反思视野；
 *   - 检索/注入只读 `is_active=1`，标死等于原文消失（行还在，但没人看得见）。
 * 需要记录"处理过"就写 `metadata` / `affect_status`，**不要动 `is_active`**。
 */
export const RAW_MATERIAL_SOURCES = ['conversation_log', 'daily_event', 'agent_state', 'agent_diary'] as const;

export type RawMaterialSource = typeof RAW_MATERIAL_SOURCES[number];

export function isRawMaterialSource(source: unknown): boolean {
  return RAW_MATERIAL_SOURCES.includes(String(source || '') as RawMaterialSource);
}

/**
 * SQL 谓词：只命中非原料行。所有会写 `is_active=0` 的语句都应该带上它，
 * 免得"排除名单"散落在五个文件里各写一份、改一处漏一处（2026-10-31 交接单的事故形状）。
 */
export function excludeRawMaterialSql(alias = ''): string {
  const column = alias ? `${alias}.source` : 'source';
  // 从 RAW_MATERIAL_SOURCES 生成，不要再手抄一份列表 —— 手抄正是它想消灭的漂移
  // （评审 P3-7：改数组忘改 SQL，两处口径就会分叉）。
  const list = RAW_MATERIAL_SOURCES.map(s => `'${s}'`).join(', ');
  return `COALESCE(${column}, '') NOT IN (${list})`;
}
