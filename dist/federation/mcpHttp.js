const PROTOCOL_VERSION = '2024-11-05';
/** endpoint → session id(进程内共享,进程退出即失效) */
const sessions = new Map();
function parseBody(text) {
    const t = (text || '').trim();
    if (!t)
        return null;
    if (t.startsWith('{') || t.startsWith('[')) {
        try {
            return JSON.parse(t);
        }
        catch { /* 落空到 SSE 分支 */ }
    }
    // Streamable HTTP 的 SSE 帧:data: {...}
    for (const line of t.split(/\r?\n/)) {
        const m = line.match(/^data:\s*(.+)$/);
        if (m) {
            try {
                return JSON.parse(m[1]);
            }
            catch { /* next */ }
        }
    }
    return null;
}
export class McpHttpProvider {
    transport = 'mcp-http';
    id;
    label;
    variant;
    capabilities;
    endpoint;
    tool;
    timeoutMs;
    constructor(o) {
        this.id = o.id;
        this.endpoint = o.endpoint;
        this.label = o.label;
        this.variant = o.variant;
        this.capabilities = o.capabilities ?? [];
        this.tool = o.tool ?? 'memory_search';
        this.timeoutMs = o.timeoutMs ?? 4000;
    }
    get target() { return this.endpoint; }
    /** 一次 JSON-RPC 往返。返回响应头里的 session id(服务端可在任意响应里下发)。 */
    async rpc(body, sessionId, timeoutMs) {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (sessionId)
            headers['mcp-session-id'] = sessionId;
        const res = await fetch(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        });
        const text = await res.text();
        const sid = res.headers.get('mcp-session-id') ?? res.headers.get('MCP-Session-Id');
        return { ok: res.ok, status: res.status, sid, json: parseBody(text) };
    }
    /** 握手:拿 mcp-session-id(失败返回 null,调用方视为成员不可达) */
    async handshake() {
        const cached = sessions.get(this.endpoint);
        if (cached)
            return cached;
        const r = await this.rpc({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
                protocolVersion: PROTOCOL_VERSION, capabilities: {},
                clientInfo: { name: 'castalia-federation', version: '1.14' },
            },
        }, null);
        const sid = r.sid ?? r.json?.result?.sessionId ?? null;
        if (!sid)
            return null;
        sessions.set(this.endpoint, sid);
        // initialized 通知:规范上服务端不返回响应,等待会白等一个超时 → 给短超时并容忍失败
        try {
            await this.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid, Math.min(800, this.timeoutMs));
        }
        catch { /* ignore */ }
        return sid;
    }
    /** 调一个远端工具,返回 result 对象(失败返回 null) */
    async callTool(name, args, retry = true) {
        let sid = await this.handshake();
        if (!sid)
            return null;
        const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
        let r = await this.rpc(body, sid);
        const failed = !r.ok || r.json?.error;
        if (failed && retry) {
            // 会话可能已被对端丢弃(桥重启)→ 重新握手一次
            sessions.delete(this.endpoint);
            sid = await this.handshake();
            if (!sid)
                return null;
            r = await this.rpc(body, sid);
            if (!r.ok || r.json?.error)
                return null;
        }
        return r.json?.result ?? null;
    }
    /** 把 MCP tools/call 的返回映射成联邦命中 */
    mapHits(result) {
        if (!result)
            return [];
        let payload = result.structuredContent ?? null;
        if (!payload) {
            const text = Array.isArray(result.content)
                ? result.content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
                : '';
            if (!text)
                return [];
            try {
                payload = JSON.parse(text);
            }
            catch {
                return [];
            }
        }
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        return rows.map(r => ({
            instance: this.id,
            project: String(r.project ?? 'default'),
            memType: r.memType ?? r.mem_type,
            id: String(r.id ?? ''),
            text: String(r.text ?? ''),
            score: Number.isFinite(Number(r.score)) ? Number(r.score) : 0,
            createdAt: r.createdAt ?? r.created_at ?? null,
            member: this.id,
        }));
    }
    async available() {
        try {
            const sid = await this.handshake();
            return !!sid;
        }
        catch {
            return false;
        }
    }
    async describe() {
        const base = {
            id: this.id, label: this.label, variant: this.variant,
            capabilities: this.capabilities, transport: this.transport, target: this.endpoint, ok: false,
        };
        try {
            const stats = await this.callTool('stats_get', {});
            let counts;
            if (stats) {
                let payload = stats.structuredContent ?? null;
                if (!payload) {
                    const t = Array.isArray(stats.content) ? stats.content.map((c) => c.text).join('') : '';
                    try {
                        payload = t ? JSON.parse(t) : null;
                    }
                    catch {
                        payload = null;
                    }
                }
                if (payload) {
                    counts = {};
                    const total = Number(payload.total ?? payload.count ?? payload.stats?.total);
                    if (Number.isFinite(total))
                        counts.memories = total;
                    const byProject = payload.byProject ?? payload.by_project;
                    if (byProject && typeof byProject === 'object')
                        counts.projects = Object.keys(byProject).length;
                }
            }
            return { ...base, ok: true, counts };
        }
        catch (e) {
            return { ...base, error: e?.message ?? String(e) };
        }
    }
    async search(query, topK) {
        // 失败一律上报(由聚合层收集进 errors),不静默返回空 —— 静默失败会让
        // "某个成员掉线"看起来像"确实没有命中",这是运维上最坑的一种假象。
        const result = await this.callTool(this.tool, { query, topK });
        if (result === null) {
            throw new Error(`远端无响应或返回错误 (${this.endpoint}, tool=${this.tool})`);
        }
        return this.mapHits(result);
    }
}
