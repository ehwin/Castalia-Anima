/**
 * MemType — 记忆用途维度(与 type 性质维度正交共存)
 *
 * v1.8: 融合 Claude Code 的 4 种封闭记忆类型 + Markdown 内容格式。
 * v1.9(语义定制):单用户自用,重新定义 4 类 memType 用途:
 *   user      — AI 对用户的画像(AI 对用户的情感 + 用户画像:偏好/习惯/性格/技术栈/风格)
 *   feedback  — 行为纠正(用户对 agent 行为的纠正或肯定,正负双向都要记)
 *   project   — 情感分区(情绪/情感经历/情绪快照/情感事件,如傲娇瞬间/感动/生气)
 *   reference — 外部链接(URL/链接/文档/ID,只存指针不存内容副本)
 *   general   — 默认,现有记忆不受影响
 */

export type MemType = 'user' | 'feedback' | 'project' | 'reference' | 'general';

/** 4 种封闭类型 + general 默认值 */
export const MEM_TYPES: readonly MemType[] = ['user', 'feedback', 'project', 'reference', 'general'];

/** 仅 4 种封闭类型(写记忆时强制 Markdown 结构) */
export const CLOSED_MEM_TYPES: readonly MemType[] = ['user', 'feedback', 'project', 'reference'];

/** Markdown 标题前缀(对应各类型) */
export const MEM_TYPE_LABELS: Record<Exclude<MemType, 'general'>, string> = {
  user: 'AI 对用户的画像',
  feedback: 'Feedback',
  project: '情感记忆',
  reference: 'Reference',
};

export function isMemType(v: any): v is MemType {
  return typeof v === 'string' && (MEM_TYPES as readonly string[]).includes(v);
}

export function isClosedMemType(v: any): v is Exclude<MemType, 'general'> {
  return typeof v === 'string' && (CLOSED_MEM_TYPES as readonly string[]).includes(v);
}

export function normalizeMemType(v: any): MemType {
  return isMemType(v) ? v : 'general';
}

/**
 * Markdown 规范化包装 — 仅对 4 种封闭类型生效(general 不强制转换)。
 * 规则:
 *   1. 已是 Markdown 结构(含 # 标题行)→ 原样返回,不重复包装
 *   2. 标题行:`# <Label>: <标题>`,标题取首行(剥掉列表符号),超 40 字截断
 *   3. 每条非空原行转 `- ` 列表项(原本就是列表的保留)
 *   保持原文本内容不变,只加结构。
 */
export function normalizeMarkdown(text: string, memType?: string): string {
  if (!isClosedMemType(memType)) return text;
  const trimmed = (text ?? '').trim();
  if (!trimmed) return text;
  // 已有 Markdown 标题 → 视为已规范化
  if (/^#{1,6}\s/m.test(trimmed)) return text;

  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const label = MEM_TYPE_LABELS[memType as Exclude<MemType, 'general'>];

  let title = lines[0].replace(/^[-*+]\s+/, '').replace(/^\d+[.、)]\s*/, '').trim();
  if (title.length > 40) title = title.slice(0, 40) + '…';
  const header = title ? `# ${label}: ${title}` : `# ${label}`;

  const items = lines.map(l =>
    /^[-*+]\s/.test(l) || /^\d+[.、)]\s/.test(l) ? l : `- ${l}`
  );
  return [header, ...items].join('\n');
}

/** 索引摘要:截取 150 字(索引层不拉全文) */
export function summarizeForIndex(text: string, maxLen: number = 150): string {
  const t = (text ?? '').trim();
  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}
