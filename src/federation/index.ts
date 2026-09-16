/**
 * 联邦统一出口 (v1.14)
 *
 * 上层只用这里 4 个入口,不关心成员是本地目录还是远程端点:
 *   fedSearchAll(ownDir, query, topK)  并发检索所有成员(单成员失败不影响整体)
 *   describeAll(ownDir)                各成员自我描述(变体/能力/规模)
 *   resolveFedLibraries(ownDir)        可直读的库清单(跨库反思等逐库直读流程用)
 *   buildProviders(ownDir)             原始 provider 列表(需要精细控制时用)
 *
 * 兼容:resolveFedLibraries / fedTextSearch 保持历史签名,老调用点零改动。
 */
import { buildProviders } from './registry.js';
import { fedTextSearch, scanLibraries } from './localDir.js';
import type { FedHit, FedLibrary, FedMemberInfo, FedProvider } from './types.js';

export type { FedHit, FedLibrary, FedMemberInfo, FedProvider, FedMemberConfig } from './types.js';
export { buildProviders, parseMemberConfigs, normalizeMember } from './registry.js';
export { fedTextSearch, scanLibraries, LocalDirProvider } from './localDir.js';
export { McpHttpProvider } from './mcpHttp.js';

/**
 * 并发检索所有可达成员,合并去重排序。
 * 单成员失败(目录坏了 / 端点不通)只记录不抛出 —— 联邦永远"尽力而为"。
 */
export async function fedSearchAll(
  ownDir: string,
  query: string,
  topK: number,
  env: NodeJS.ProcessEnv = process.env,
  memberIds?: string[],
): Promise<{ hits: FedHit[]; members: number; errors: string[] }> {
  let providers = buildProviders(ownDir, env);
  if (memberIds && memberIds.length > 0) {
    const want = new Set(memberIds);
    providers = providers.filter(p => want.has(p.id));
  }
  const errors: string[] = [];
  const settled = await Promise.all(providers.map(async p => {
    try {
      return await p.search(query, topK);
    } catch (e: any) {
      errors.push(`[${p.id}] ${e?.message ?? String(e)}`);
      return [] as FedHit[];
    }
  }));
  const hits = settled.flat();
  hits.sort((a, b) => (b.score - a.score) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const seen = new Set<string>();
  const unique = hits.filter(h => {
    const k = `${h.member ?? h.instance}|${h.project}|${h.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    hits: unique.slice(0, Math.max(20, topK * Math.max(1, providers.length))),
    members: providers.length,
    errors,
  };
}

/** 各成员自我描述:变体、能力标签、库数/记忆数。用于能力协商与排障。 */
export async function describeAll(
  ownDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FedMemberInfo[]> {
  const providers = buildProviders(ownDir, env);
  return Promise.all(providers.map(async p => {
    try {
      return await p.describe();
    } catch (e: any) {
      return {
        id: p.id, label: p.label, variant: p.variant, capabilities: p.capabilities,
        transport: p.transport, target: p.target, ok: false, error: e?.message ?? String(e),
      } as FedMemberInfo;
    }
  }));
}

/**
 * 可直读的库清单(兼容历史 resolveFedLibraries 语义)。
 * 只包含能直接打开 sqlite 的成员(local-dir);远程成员自动跳过 ——
 * 需要逐库直读的流程(跨库反思的原文取样)因此天然只覆盖同机成员。
 */
export function resolveFedLibraries(
  ownDir: string,
  env: NodeJS.ProcessEnv = process.env,
): FedLibrary[] {
  const libs: FedLibrary[] = [];
  for (const p of buildProviders(ownDir, env)) {
    if (typeof p.libraries !== 'function') continue;
    try {
      libs.push(...p.libraries());
    } catch { /* 单个成员失败不影响其他 */ }
  }
  return libs;
}

/** 按成员过滤的便利方法(能力标签筛选,例如只要带 emotion 的成员) */
export function providersWith(
  ownDir: string,
  predicate: (p: FedProvider) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): FedProvider[] {
  return buildProviders(ownDir, env).filter(predicate);
}
