#!/usr/bin/env node
/**
 * Castalia 联邦服务 —— 把"跨记忆体收纳"做成一个可挂载的 MCP 端点 (v1.14, 2026-09-16)
 *
 * 为什么独立成服务
 *   联邦能力曾经是引擎的一个模块,于是"能不能联邦"变成了"跑的是哪个版本的引擎"。
 *   这不对:一个 Lite 实例(中立核、无联邦代码)同样应该能使用联邦记忆。
 *   所以这里把联邦抽成一个独立的 MCP 服务 —— 任何客户端(Lite 引擎、任意 Agent、
 *   其他记忆体实现)挂上它就获得联邦检索能力,而它自己不需要有联邦代码。
 *
 * 它做什么
 *   · 读 FEDERATION_MEMBERS(推荐)/ FEDERATION_DIRS(兼容),把每个成员包装成 provider
 *   · 成员可以是同机目录(local-dir)或任意 MCP 端点(mcp-http,对端零改动)
 *   · 只读:绝不写对端
 *
 * 暴露的工具
 *   memory_search_all    联邦检索(与引擎内同名工具兼容);可用 members 限定成员
 *   federation_members   成员清单 + 变体/能力/规模(能力协商与排障)
 *
 * 传输
 *   stdio(本进程标准协议)→ 想给容器/远程用,交给 mcp-proxy 包成 HTTP 即可(与记忆桥同构)。
 *
 * 环境变量
 *   FEDERATION_MEMBERS / FEDERATION_DIRS   成员配置(必填,否则只有本机 ownDir)
 *   MEMORY_DB_DIR                          可选:本服务自身的库目录(加入联邦作为 local 成员)
 *   CASTALIA_INSTANCE_ID / _LABEL          可选:本服务在结果里的标识
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fedSearchAll, describeAll } from './federation/index.js';
// stdout 归 MCP 协议独占,任何日志必须走 stderr
console.log = console.error;
const SERVER_NAME = 'castalia-federation';
const SERVER_VERSION = '1.14.0';
const OWN_DIR = process.env.MEMORY_DB_DIR || '';
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}
function err(msg, code = 'ERROR') {
    return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: msg } }, null, 2) }],
        isError: true,
    };
}
server.tool('memory_search_all', 'Federation search (read-only): search across every configured member — same-machine library dirs (local-dir) and remote MCP endpoints (mcp-http). Members are declared by FEDERATION_MEMBERS or legacy FEDERATION_DIRS. Explicit semantics: results are not merged with any local engine logic; the caller decides interop policy. Each hit carries instance/member/project. Per-member failures are reported in `errors` instead of being silently dropped.', {
    query: z.string().describe('Query text'),
    topK: z.number().optional().describe('Max results per member (default 5)'),
    members: z.array(z.string()).optional().describe('Restrict to these member ids (default: all)'),
}, async (args) => {
    try {
        const topK = args.topK ?? 5;
        const { hits, members, errors } = await fedSearchAll(OWN_DIR, args.query, topK, process.env, args.members);
        return ok({
            op: 'memory_search_all',
            query: args.query,
            members,
            count: hits.length,
            results: hits.map(h => ({
                instance: h.instance,
                member: h.member,
                project: h.project,
                memType: h.memType,
                id: h.id,
                text: h.text,
                score: h.score,
                createdAt: h.createdAt,
            })),
            errors: errors.length ? errors : undefined,
        });
    }
    catch (e) {
        return err(e?.message ?? String(e), 'FEDERATION_FAILED');
    }
});
server.tool('federation_members', 'List federation members with their transport, variant, declared capabilities and size (libraries / memories). Use it to see who can be collected and what each member offers (e.g. capabilities: ["emotion"]).', {}, async () => {
    try {
        const infos = await describeAll(OWN_DIR, process.env);
        const total = infos.reduce((n, i) => n + (i.counts?.memories ?? 0), 0);
        return ok({
            op: 'federation_members',
            count: infos.length,
            totalMemories: total,
            members: infos,
        });
    }
    catch (e) {
        return err(e?.message ?? String(e), 'FEDERATION_MEMBERS_FAILED');
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${SERVER_NAME}] ready — own=${OWN_DIR || '(none)'} members=${(process.env.FEDERATION_MEMBERS || process.env.FEDERATION_DIRS) ? 'configured' : 'none'}`);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
}
main().catch((e) => {
    console.error(`[${SERVER_NAME}] fatal:`, e);
    process.exit(1);
});
