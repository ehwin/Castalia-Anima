/**
 * 成员注册表:环境配置 → provider 列表 (v1.14)
 *
 * 配置来源(按优先级):
 *   FEDERATION_MEMBERS = [{"id","label","variant","capabilities","transport","target"}...]
 *   FEDERATION_DIRS    = [{"name","dir"}...]        ← 老写法,继续支持(local-dir)
 *
 * 未配置任何成员时,联邦退化为"只有本实例"—— 与历史行为一致。
 * transport 缺省自动推断:http(s) → mcp-http,其余 → local-dir。
 */
import path from 'node:path';
import { LocalDirProvider } from './localDir.js';
import { McpHttpProvider } from './mcpHttp.js';
import type { FedMemberConfig, FedProvider } from './types.js';

function parseJsonArray(raw?: string): any[] | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;   // 配置非法 → 当作没有成员(绝不因此让引擎起不来)
  }
}

/** 把一条配置规整成 FedMemberConfig;无法识别的返回 null */
export function normalizeMember(m: any): FedMemberConfig | null {
  if (!m || typeof m !== 'object') return null;
  const target = String(m.target ?? m.dir ?? m.url ?? '').trim();
  if (!target) return null;
  const isHttp = /^https?:\/\//i.test(target);
  const transport = String(m.transport ?? (isHttp ? 'mcp-http' : 'local-dir'));
  const id = String(m.id ?? m.name ?? path.basename(target.replace(/[/\\]+$/, '')) ?? 'member');
  return {
    id,
    label: m.label ? String(m.label) : undefined,
    variant: m.variant ? String(m.variant) : undefined,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
    transport,
    target,
    tool: m.tool ? String(m.tool) : undefined,
    timeoutMs: Number.isFinite(Number(m.timeoutMs)) ? Number(m.timeoutMs) : undefined,
  };
}

/** 解析配置里的成员(不含本实例) */
export function parseMemberConfigs(env: NodeJS.ProcessEnv = process.env): FedMemberConfig[] {
  const modern = parseJsonArray(env.FEDERATION_MEMBERS);
  const raw = modern ?? parseJsonArray(env.FEDERATION_DIRS) ?? [];
  const out: FedMemberConfig[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    const norm = normalizeMember(m);
    if (!norm) continue;
    const key = norm.transport === 'local-dir'
      ? `dir:${path.resolve(norm.target!).toLowerCase()}`
      : `url:${norm.target}`;
    if (seen.has(key)) continue;      // 同一目标只登记一次
    seen.add(key);
    out.push(norm);
  }
  return out;
}

/**
 * 组装 provider 列表:第一个永远是本实例(ownDir),其后是配置里的成员。
 * 与 ownDir 指向同一目录的成员会被跳过(历史行为:去重,避免重复命中)。
 */
export function buildProviders(ownDir: string, env: NodeJS.ProcessEnv = process.env): FedProvider[] {
  const providers: FedProvider[] = [];
  const ownKey = ownDir ? `dir:${path.resolve(ownDir).toLowerCase()}` : '';
  const seen = new Set<string>(ownKey ? [ownKey] : []);

  // ownDir 为空 = 纯聚合服务(自身没有库,只收纳别人)—— 联邦服务就是这样跑的
  if (ownDir) {
    providers.push(new LocalDirProvider({
      id: env.CASTALIA_INSTANCE_ID || 'local',
      dir: ownDir,
      label: env.CASTALIA_INSTANCE_LABEL || '本实例',
      capabilities: ['federation'],
    }));
  }

  for (const m of parseMemberConfigs(env)) {
    const key = m.transport === 'local-dir'
      ? `dir:${path.resolve(m.target!).toLowerCase()}`
      : `url:${m.target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (m.transport === 'mcp-http') {
      providers.push(new McpHttpProvider({
        id: m.id,
        endpoint: m.target!,
        label: m.label,
        variant: m.variant,
        capabilities: m.capabilities,
        tool: m.tool,
        timeoutMs: m.timeoutMs,
      }));
    } else {
      providers.push(new LocalDirProvider({
        id: m.id,
        dir: m.target!,
        label: m.label,
        variant: m.variant,
        capabilities: m.capabilities,
      }));
    }
  }
  return providers;
}
