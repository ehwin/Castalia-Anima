/**
 * tags 列的唯一解码/归一化入口 —— **纯模块，零 import**。
 *
 * 为什么要单独成模块（而不是放在 search.ts）：
 *   search.ts 会在 import 时打开/迁移记忆库（DatabaseManager），任何只想用
 *   parseTagsSafe 的调用方（验收脚本、工具、其它模块）都会被连带拉出一堆副作用：
 *   建库、打印 `[db] migrating schema`。tags 解析不该有这种代价。
 *   本文件禁止引入 db/env/store/search —— 保持"加载即零副作用"。
 *
 * 为什么必须收紧后置条件（历史事故）：
 *   memory.tags 是 TEXT 列，真实库里出现过 8 行脏数据：逗号串、ISO 时间戳，
 *   甚至列错位。裸 JSON.parse 会抛错；而"合法 JSON 但不是字符串数组"
 *   （如 `[1,null,true]`、`[["a"]]`）更阴险 —— JSON.parse 不抛，脏元素一路下传到
 *   `tag.toLowerCase()` / `tags.join(',')` / SQL 绑定才炸，崩溃点只是被挪了地方。
 *   所以这里的后置条件固定为 `string[]`：只保留字符串元素、嵌套数组拍平一层、
 *   其余（数字/布尔/null/对象）丢弃（不做 String() 强转，避免 'null' 垃圾标签）、
 *   元素 trim 且丢弃空串。
 */
/** 去掉非字符串元素；嵌套数组只拍平一层；trim 后丢弃空串。 */
function cleanTags(values) {
    const out = [];
    for (const value of values) {
        if (typeof value === 'string') {
            const tag = value.trim();
            if (tag)
                out.push(tag);
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item !== 'string')
                    continue;
                const tag = item.trim();
                if (tag)
                    out.push(tag);
            }
        }
    }
    return out;
}
/** JSON.parse 成功且是数组才返回，否则 null（用来区分"合法空数组"和"根本不是 JSON"）。 */
function parseArrayOrNull(text) {
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
/**
 * 读路径安全解析：永不抛错，后置条件恒为 `string[]`。
 * 非法 JSON / 非数组 / 非字符串输入 → []（保持"单行脏数据不炸整库"的既有行为）。
 */
export function parseTagsSafe(raw) {
    if (Array.isArray(raw))
        return cleanTags(raw);
    if (typeof raw !== 'string')
        return [];
    const text = raw.trim();
    if (!text)
        return [];
    const parsed = parseArrayOrNull(text);
    return parsed ? cleanTags(parsed) : [];
}
/**
 * 写路径归一化：保证落库的 tags 一定是 string[] 的 JSON 序列化结果。
 * 比读路径多一步容错：不是 JSON 的字符串按逗号串拆开（这正是历史脏数据的成因）。
 */
export function normalizeTagsForWrite(raw) {
    if (Array.isArray(raw))
        return cleanTags(raw);
    if (typeof raw !== 'string')
        return [];
    const text = raw.trim();
    if (!text)
        return [];
    const parsed = parseArrayOrNull(text);
    return parsed ? cleanTags(parsed) : cleanTags(text.split(','));
}
/**
 * 写 tags 列的唯一序列化入口：INSERT/UPDATE 绑定值一律用它，
 * 保证"合法 JSON 但元素非字符串"的脏行不可能再被写出来。
 */
export function serializeTags(raw) {
    return JSON.stringify(normalizeTagsForWrite(raw));
}
//# sourceMappingURL=tags.js.map