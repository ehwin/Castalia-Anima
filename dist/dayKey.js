/**
 * 日历日口径（唯一来源）。
 *
 * created_at 一律存 UTC ISO（`2026-10-29T17:03:14.425Z`），但用户问的"今天/昨天"是**本地**日期。
 * 直接切 ISO 前 10 位在 UTC+8 会把本地 00:00–08:00 的对话算进前一天：
 *   2026-10-29T17:03Z = 本地 2026-10-30 01:03 —— 那是"今天凌晨"，不是"昨天上午"。
 * 事件层分桶（eventDigest）与时间路取几天（temporalDaysOf）必须走同一个函数，
 * 否则「今天在忙什么」查不到自己凌晨那段对话（2026-10-30 回归实测）。
 */
export function localDayOf(when) {
    const d = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(d.getTime()))
        return String(when).slice(0, 10); // 已损坏的时间串：按原样截，别让它变成 1970
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 本地日历日的偏移（0=今天，1=昨天）；"今天"跨零点而不是跨 24 小时。 */
export function localDayOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return localDayOf(d);
}
//# sourceMappingURL=dayKey.js.map