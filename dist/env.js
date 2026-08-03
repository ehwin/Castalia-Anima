/**
 * 记忆体框架环境变量配置 — harness 可配项集中管理
 *
 * 所有通过环境变量可覆盖的配置在这里定义,
 * 避免散落在各模块里硬编码。
 */
/** 角色/实例 ID:用于数据分区。默认 'airi'(与旧版行为一致) */
export const CHAR_ID = process.env.CHAR_ID || 'airi';
/** MCP server 自描述名称 */
export const SERVER_NAME = process.env.MCP_SERVER_NAME || 'airi-memory';
/** 服务器版本号 */
export const SERVER_VERSION = process.env.MCP_SERVER_VERSION || '5.0.0';
