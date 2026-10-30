export function parseEvidenceTime(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return Number.NaN;
    const sqliteUtc = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(raw);
    const normalized = sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}Z` : raw;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}
export function compareEvidenceCursor(a, b) {
    const aTime = parseEvidenceTime(a.createdAt);
    const bTime = parseEvidenceTime(b.createdAt);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime)
        return aTime - bTime;
    if (Number.isFinite(aTime) !== Number.isFinite(bTime))
        return Number.isFinite(aTime) ? 1 : -1;
    const byText = String(a.createdAt).localeCompare(String(b.createdAt));
    if (byText !== 0)
        return byText;
    return Number(a.rowid) - Number(b.rowid);
}
export function isAfterEvidenceCursor(row, cursor) {
    return cursor === null || compareEvidenceCursor(row, cursor) > 0;
}
export function maxEvidenceCursor(rows) {
    let best = null;
    for (const row of rows) {
        if (!row.createdAt || !Number.isFinite(Number(row.rowid)))
            continue;
        if (!best || compareEvidenceCursor(row, best) > 0)
            best = {
                createdAt: String(row.createdAt),
                rowid: Math.trunc(Number(row.rowid)),
            };
    }
    return best;
}
//# sourceMappingURL=selfCycleCursor.js.map