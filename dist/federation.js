/**
 * 联邦搜索(多实例只读检索)— 接口先行版 (2026-08-16)
 *
 * 语义:显式、只读。调用方(memory_search_all / 总成页)指定覆盖哪些实例的哪些库,
 * 引擎不做跨库合并策略判断 —— 互通规则由上层决定(用户尚未定稿)。
 *
 * 环境变量 FEDERATION_DIRS: JSON 数组 [{"name":"Hermes","dir":"D:\\...\\memory"}, ...]
 * 未设置时仅搜索本实例的库。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
/** 解析参与联邦的库列表:本实例 + FEDERATION_DIRS 声明的外部实例 */
export function resolveFedLibraries(ownDir) {
    const libs = [];
    const seenDirs = new Set();
    const scan = (dir, instance) => {
        try {
            const norm = path.resolve(dir);
            if (seenDirs.has(norm))
                return; // ownDir 与 FEDERATION_DIRS 同目录时去重
            seenDirs.add(norm);
            for (const f of fs.readdirSync(dir)) {
                if (f.startsWith('project-') && f.endsWith('.sqlite')) {
                    libs.push({ instance, project: f.slice('project-'.length, -'.sqlite'.length), file: path.join(dir, f) });
                }
            }
        }
        catch {
            /* 目录不可读则跳过 */
        }
    };
    scan(ownDir, 'local');
    try {
        const raw = process.env.FEDERATION_DIRS;
        if (raw && raw.trim()) {
            const dirs = JSON.parse(raw);
            if (Array.isArray(dirs)) {
                for (const d of dirs) {
                    if (d && typeof d === 'object' && d.dir) {
                        scan(String(d.dir), String(d.name || path.basename(String(d.dir))));
                    }
                }
            }
        }
    }
    catch {
        /* 配置非法时仅本实例 */
    }
    return libs;
}
/**
 * 文本模式联邦搜索:LIKE 子串匹配 + 命中比例评分。
 * 中文长句整句子串匹配;空格/标点分隔多词时 OR 匹配、命中比例计分。
 * 只读打开库文件,逐库独立 try/catch,单库损坏不影响整体。
 */
export function fedTextSearch(libs, query, topK) {
    const terms = query.split(/[\s,，。！？、；：]+/).filter((t) => t.trim().length >= 2);
    const hits = [];
    for (const lib of libs) {
        let db = null;
        try {
            db = new Database(lib.file, { readonly: true, fileMustExist: true });
            let rows = [];
            if (terms.length === 0) {
                rows = db.prepare('SELECT id, text, created_at FROM memory WHERE is_active = 1 ORDER BY created_at DESC LIMIT ?').all(topK);
            }
            else {
                const conds = terms.map(() => 'm.text LIKE ?').join(' OR ');
                rows = db.prepare(`SELECT m.id, m.text, m.created_at FROM memory m WHERE m.is_active = 1 AND (${conds}) ORDER BY m.created_at DESC LIMIT ?`).all(...terms.map(t => `%${t}%`), topK);
            }
            for (const r of rows) {
                const hitCount = terms.filter(t => String(r.text).includes(t)).length;
                hits.push({
                    instance: lib.instance,
                    project: lib.project,
                    id: r.id,
                    text: String(r.text).length > 200 ? String(r.text).slice(0, 200) + '…' : String(r.text),
                    score: terms.length > 0 ? Math.round((hitCount / terms.length) * 1000) / 1000 : 0.1,
                    createdAt: r.created_at ?? null,
                });
            }
        }
        catch {
            /* 打不开的库跳过 */
        }
        finally {
            if (db)
                db.close();
        }
    }
    hits.sort((a, b) => (b.score - a.score) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return hits.slice(0, Math.max(10, topK * Math.max(1, libs.length)));
}
