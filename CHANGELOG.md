# Changelog — AI memory(AIRI 分支,自用版)

> 本文件记录每次功能/架构变更,供 AIRI 主系统(`D:\system\AIRI\memory`)吸收改进时快速对账。
> 与公共版(`/path\ai-memory`,CHANGELOG 见其仓库)同步演进,两边改动互相吸收。

## [v1.3] — 2026-08-04 热度升格 + reflect 回执(与公共版同步)

### Added
- **热度升格**:accessed_count ≥ `HEAT_PROMOTE_THRESHOLD`(默认 5)的 temporary 自动升 standard;清理前先升格
- **reflect 逐动作回执**:receipts[] {action, status, targetId, reason, rowsAffected};幻觉 id 不再静默算成功
- **回执落盘**:`reflect-receipts/reflect-receipt-<ts>.json`(动作原文 + 每条回执,可人工修正)

### Fixed
- reflect 幻觉 id 动作误计 applied 的问题

## [Unreleased] — 2026-08-04 工具分级与暴露面矫正

### Added
- **工具分级机制**(与公共版同步,借鉴 engram):环境变量 `MCP_TOOLS` 控制注册集。
  - `agent`(默认,4 个只读):memory_search / fact_search / memory_recent / memory_graph
  - `harness`(10 个):写入 + 对话管线 + user_observe + 反思
  - `admin`(8 个):管理 + context + 手动反思
  - `all`(22 个):全部注册,向后兼容
- `reflect_auto` 新增 `mode: daily|deep` 参数(deep=原 reflect_deep)

### Changed
- 默认暴露面:主 Agent 只见 4 个只读工具(之前 22 个全暴露)
- `context_get` 降级为 admin 组
- `memory_list` 硬上限 50 条(之前默认 200)
- `memory_graph` 默认返回邻域(节点上限 50),不再 dump 全图
- 统一信封 `{ok, op, count, results}` + 失败 `{ok:false, error:{code, message}}`(与公共版 v1.1 同步)

### Fixed
- `stats_get` 未按 CHAR_ID 分区(已加 `AND character_id=?`)

## [v1.1] — 2026-08-03 反思驱动打包 + 双分支确立

### Added
- `src/reflectDriver.ts`:反思驱动打包进 server(日常+深度,LLM 环境变量配置,无 key 优雅跳过)
- `src/env.ts`:CHAR_ID / MCP_SERVER_NAME / MCP_SERVER_VERSION 环境变量化
- `reflect_auto` / `reflect_deep` 工具(22 工具)

### Changed
- 主系统吸收回写(commit 25c9726):CHAR_ID 分区 + SEARCH_MIN_SCORE 可配
- viz 重构(主系统):3D 星图主界面 + 管理抽屉副界面(管理功能从 reflect-admin.html 移植)

## [v1.0] — 2026-08 独立分支建立

### Added
- 从 memory-fused 剥离为独立仓库,保留完整人格化特性(emotion/agentState/bias/userLearning)
- CHAR_ID 默认 'airi',SERVER_NAME 'airi-memory'
- SEARCH_MIN_SCORE 默认 0.15(修情绪锚定评分下空结果问题)

### Fixed
- 搜索阈值:balanced minScore 0.3 → 0.15(情绪权重 45% 导致无情绪记忆分数偏低)
