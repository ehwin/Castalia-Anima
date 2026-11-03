/**
 * 时间字段归一化 —— 记忆体层（无情感概念），自 AIRI 侧 `bank/time.ts` 移植。
 *
 * 背景：SQLite 的 `created_at` / `updated_at` 在真实库里既有 INTEGER（秒或毫秒 epoch）
 * 也有 TEXT（`YYYY-MM-DD HH:MM:SS` / ISO）。调用方只要默认“一定是字符串”，第一行整数
 * 就会抛 `value.includes is not a function`，整次列表失败、客户端退回旧缓存 ——
 * 表现为“库里有数据、页面/模型读不到”，而用 mock 的测试全绿。
 *
 * 口径：
 *   · `parseBankTime`  —— 返回 epoch ms；无法解析时回退 now（排序/比较用）。
 *   · `toIsoOrNull`    —— 可解析返回 ISO 字符串，空值/不可解析返回 null（对外的字段契约，
 *                         永远不把 number 直接交给客户端）。
 */

/** SQLite `YYYY-MM-DD HH:MM:SS`(UTC)、ISO、秒/毫秒 epoch 都转成 epoch ms；无法解析返回 null。 */
export function parseBankTimeStrict(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '')
    return null
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    return n > 1e11 ? Math.round(n) : Math.round(n * 1000)
  }
  const text = String(value).trim()
  if (text === '') return null
  const numeric = Number(text)
  if (Number.isFinite(numeric))
    return numeric > 1e11 ? Math.round(numeric) : Math.round(numeric * 1000)
  // `2026-11-03 10:00:00` 是 UTC（与库内其它时间一致），补 T/Z 再解析
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/** 排序/比较用：无法解析时回退 now（保持历史行为）。 */
export function parseBankTime(value: string | number | null | undefined, now = Date.now()): number {
  return parseBankTimeStrict(value) ?? now
}

/** 对外字段用：可解析 → ISO；空值/不可解析 → null（绝不把 number 漏给客户端）。 */
export function toIsoOrNull(value: string | number | null | undefined): string | null {
  const ms = parseBankTimeStrict(value)
  return ms === null ? null : new Date(ms).toISOString()
}
