/**
 * 双时间轴查询与开窗守卫。
 *
 * 事实层现在有两条时间轴（v1.28 引入）：
 *   - **有效时间**：`valid_from` / `valid_to` —— 这条事实在世界里何时为真。
 *   - **事务时间**：`created_at` / `expired_at` —— 我们**当时**相信什么。
 *
 * 两者分开才有意义。举一个真实区别：今天补录一条"去年十月他住在杭州"，
 *   有效时间 = 去年十月（那时世界如此），事务时间 = 今天（我们昨天还不知道）。
 *   按有效时间问"去年十一月住哪"应命中杭州；按事务时间问"去年十一月的我们相信什么"
 *   则**不该**命中——那时这条还不知道。拿一条轴回答另一个问题，就是把"事后知道"
 *   当成"当时知道"。
 *
 * 所有比较一律走 `julianday()`，不做字符串比较：老行的 `valid_from` 为空会回落到
 * `created_at`（SQLite 的 `YYYY-MM-DD HH:MM:SS`），新行是 ISO（带 `T` 与 `Z`），
 * 混排时字典序会把 `... 10:00:00` 排在 `...T09:00:00.000Z` 前面（空格 0x20 < 'T'）。
 */
import { DatabaseManager as Db } from './db.js';
import { CHAR_ID, normalizeProject, PROJECT_ID } from './env.js';
import { normalizePredicate, OPEN_PREDICATES } from './volatility.js';
/** 只接受明确的日期或日期时间形状，避免把整段文本当日期喂给 SQLite。 */
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?$/;
/** 校验并回显一个时刻。形状不对或 SQLite 认不出来就抛错，绝不静默返回空结果。 */
export function assertInstant(value, field = 'at') {
    const text = String(value ?? '').trim();
    if (!INSTANT_SHAPE.test(text)) {
        throw new Error(`${field} 不是可识别的时刻：${JSON.stringify(value)}（要 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]）`);
    }
    const db = Db.getInstance();
    const probe = db.prepare('SELECT julianday(?) AS jd').get(text);
    if (!probe || probe.jd === null || !Number.isFinite(probe.jd)) {
        throw new Error(`${field} 无法被 SQLite 解析：${text}`);
    }
    return text;
}
/** 角色过滤与事实层其他调用保持一致（'any' 关闭过滤，'' 只看无主）。 */
function characterFilter(characterId) {
    const cid = characterId ?? CHAR_ID;
    if (cid === 'any')
        return { clause: '', params: [] };
    if (cid === '')
        return { clause: "(character_id IS NULL OR character_id = '')", params: [] };
    return { clause: 'character_id = ?', params: [cid] };
}
function toWindow(row) {
    return {
        id: String(row.id),
        subject: String(row.subject),
        predicate: String(row.predicate),
        object: String(row.object),
        confidence: Number(row.confidence ?? 0),
        validFrom: row.valid_from ?? null,
        validTo: row.valid_to ?? null,
        createdAt: String(row.created_at ?? ''),
        expiredAt: row.expired_at ?? null,
        supersededBy: row.superseded_by ?? null,
    };
}
/**
 * 按某一条时间轴回答"那一刻的事实是什么"。
 *
 * 有效时间：值在那个时刻为真（起点 ≤ at，且尚未被接管或终点在 at 之后）。
 * 事务时间：那个时刻我们已经写下、且当时还没被判失效的行。
 * 两条轴都包含已被接管的行——它们在**当时**确实是我们相信的东西；
 * 被排除的只有"那一刻之后才发生的事"。
 */
export function factsAsOf(options) {
    const project = normalizeProject(options.project ?? PROJECT_ID);
    const at = assertInstant(options.at, 'at');
    const axis = options.axis ?? 'valid';
    const db = Db.getInstance(project);
    const conditions = ['project = ?', 'is_active = 1'];
    const params = [project];
    if (axis === 'valid') {
        conditions.push('julianday(COALESCE(valid_from, created_at)) <= julianday(?)');
        params.push(at);
        conditions.push(`(valid_to IS NULL OR valid_to = '' OR julianday(valid_to) > julianday(?))`);
        params.push(at);
    }
    else {
        conditions.push('julianday(created_at) <= julianday(?)');
        params.push(at);
        conditions.push(`(expired_at IS NULL OR expired_at = '' OR julianday(expired_at) > julianday(?))`);
        params.push(at);
    }
    const scope = characterFilter(options.characterId);
    if (scope.clause) {
        conditions.push(scope.clause);
        params.push(...scope.params);
    }
    if (options.subject) {
        conditions.push('subject = ?');
        params.push(String(options.subject));
    }
    if (options.predicate) {
        conditions.push('predicate = ?');
        params.push(normalizePredicate(options.predicate));
    }
    const rows = db.prepare(`
    SELECT id, subject, predicate, object, confidence, valid_from, valid_to,
           created_at, expired_at, superseded_by
    FROM facts
    WHERE ${conditions.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM memory source_memory
        WHERE source_memory.id = facts.source_memory_id
          AND source_memory.source IN ('agent_diary', 'agent_state')
      )
      AND COALESCE(facts.source_memory_source, '') NOT IN ('agent_diary', 'agent_state')
    ORDER BY subject, predicate, julianday(COALESCE(valid_from, created_at)) DESC
  `).all(...params);
    return rows.map(toWindow);
}
/**
 * 找出同一 (subject, predicate) 上**同时开口**的单值事实。
 *
 * 单值谓词（居住地/职业/称呼…）同一时刻只能有一个值为真，两个开口窗口意味着
 * 时间线没重算干净。多值谓词（喜欢/兴趣/朋友…）本来就允许多条同时成立，所以不报。
 *
 * 这条检查是只读的：它报告冲突，不擅自改数据。修法在 store 的时间线重算里。
 */
export function findOpenWindowConflicts(options = {}) {
    const project = normalizeProject(options.project ?? PROJECT_ID);
    const db = Db.getInstance(project);
    const conditions = ['project = ?', 'is_active = 1', "(valid_to IS NULL OR valid_to = '')"];
    const params = [project];
    const scope = characterFilter(options.characterId);
    if (scope.clause) {
        conditions.push(scope.clause);
        params.push(...scope.params);
    }
    const rows = db.prepare(`
    SELECT id, subject, predicate, object, confidence, valid_from, valid_to,
           created_at, expired_at, superseded_by
    FROM facts
    WHERE ${conditions.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM memory source_memory
        WHERE source_memory.id = facts.source_memory_id
          AND source_memory.source IN ('agent_diary', 'agent_state')
      )
      AND COALESCE(facts.source_memory_source, '') NOT IN ('agent_diary', 'agent_state')
    ORDER BY subject, predicate, julianday(COALESCE(valid_from, created_at)) DESC
  `).all(...params);
    const groups = new Map();
    for (const row of rows) {
        const predicate = normalizePredicate(row.predicate);
        if (OPEN_PREDICATES.has(predicate))
            continue;
        const key = `${row.subject}\u0000${predicate}`;
        const list = groups.get(key) ?? [];
        list.push(toWindow(row));
        groups.set(key, list);
    }
    return [...groups.entries()]
        .filter(([, windows]) => windows.length > 1)
        .map(([key, windows]) => ({
        subject: key.split('\u0000')[0],
        predicate: key.split('\u0000')[1],
        windows,
    }));
}
//# sourceMappingURL=bitemporal.js.map