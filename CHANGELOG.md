# Changelog — Castalia Anima(情感版,公共库)

> 本文件记录每次功能/架构变更。**Castalia Anima = 保留 AIRI 情感血统的情感人格化版**,定位为推 GitHub 的公共库;AIRI 主系统(`D:\system\AIRI\memory`)自用,吸收架构但不分库。
> 与通用版(`/path\ai-memory`,无情感 Castalia)同源演进;本版 = 通用版 v1.11 架构 + Anima 情感层。

## [Unreleased] — 2026-08-07 项目库 = AI 人格(人格化改造)

> 用户需求:项目库对应 AI 人格(非用户人格),单用户场景,不过度设计(不建表/不加工具)。

### Added
- **项目库 = AI 人格**:`env.charFor(project)` 动态解析人格 charId,优先级:① config.json `personas` 段映射(project→{charId,name,persona})→ ② 项目名即人格名(零配置可用)→ ③ 缺省 CHAR_ID(向后兼容)
- **对外声称**:`context_get`/`memory_context` 注入 `[角色声明] 我是 <name>(charId=<charId>)。人格设定:<persona>`;`context_get`/`mood_journal` 返回 `persona` 字段;`project_list` 每项目附 persona
- **人格状态隔离**:agentState(情绪/精力/欲望)/ bias(兴趣偏差)/ userLearning(用户画像)按解析后 charId 分区——切项目即切换人格,情绪与画像各自独立(零改动复用既有分区)
- config.json 新增 `personas` 段:configLoader 解析 → `PERSONAS_JSON` env(启动时加载)

### Changed
- 16 个工具按项目解析人格 charId(memory_save/search/recent/index/log、stats_get、reflect_analyze/apply/auto/deep/batch_embed、consolidate_deep、conversation_save 等)——character_id 列随人格落库,查询按人格过滤
- `auto_process` 新增可选 `characterId` 参数(显式优先,缺省 charFor(project));`digest_run`/`user_observe` 补可选 project 参数
- smoke_test.py 增加 persona 断言:PERSONAS_JSON 映射命中、context_get 角色声明、project_list persona 字段

### 兼容性
- 未传 project 时 charFor 返回 CHAR_ID,行为不变;未配置 personas 时项目名即人格名,零配置即可用

## [v2.0] — 2026-08-07 通用版 v1.11 全架构吸收(保留全部情感层)

> 用户决策:Anima 作为情感版公共库,完整吸收通用版架构(含项目分库);AIRI 主系统后续同步(不分库)。

### Added(从通用版吸收)
- **项目分库**:`DatabaseManager.getInstance(project)`、`memory/global.sqlite`(指令+项目注册)+ `project-<name>.sqlite`(业务表)、`listProjectNames`、跨项目去重隔离
- **session_id 会话级记忆**(v6.0 列正式启用):`memory_save`/`auto_process` 加 sessionId 参数
- **渐进式临时反思**:`buffer.ts` SessionMemoryBuffer(N 轮攒批默认 5)+ `triage.ts` 增量反思 + 晋升链(`upsertSessionMemory`/`promoteToProject`/`deleteSessionFragments`)+ TTL 7 天孤儿清扫
- **triage 三通道**:`makeLlmChannel(prefix)` + `callLlm(system, user, channel?)`;`TRIAGE_LLM_*` 入站分拣,缺省回退 REFLECT_* 通道
- **memType 四封闭类型**(`memType.ts`):user/feedback/project/reference + Markdown 规范化包装
- **三层指令**(`instructions.ts`):global/user/project/rule + glob 路由 + `ensureSeedInstructions`
- **configLoader**(`configLoader.ts`):config.json 持久化嵌入/反思/triage/整合配置(必须 index.ts 第一个 import)
- **新工具 22→31**:memory_get / memory_index / memory_log / memory_context / consolidate_deep / project_list / instruction_save / instruction_list / instruction_delete
- **记忆整合**(`consolidate.ts` + `runConsolidate`):向量预筛相似对 + LLM 矛盾消解/去重/剪枝,`shouldAutoConsolidate` 启动检查
- **Memory Snapshot Warning**:≥24h 旧记忆注入时追加快照警告
- **启动自动反思**:`shouldAutoReflect`(≥24h 未反思 + 未分析对话 >5)下次启动自动执行
- **嵌入升级**:`embed(text, project?)` 按项目隔离缓存 + `EMBEDDING_API_KEY` OpenAI 兼容 /embeddings 模式 + `EMBED_MODE=none` 禁用
- **回执落盘**:`memory/receipts` 目录(v1.3 迁移)

### Changed
- MCP_TOOLS 默认 `all`(31 工具全注册;AIRI 主系统 proxy 依赖 harness/admin 组)
- `context_get` 融合为 agent 情感态(state/bias/profile)+ 记忆上下文
- server 名 `castalia-anima`;CHAR_ID 默认 `airi`
- smoke_test.py / vec_test.py 同步通用版(分库 + 动态路径)

### 保留(Anima 情感层,不裁剪)
- `emotion.ts`(VAD 情感分析 + 情绪锚定)/ `agentState.ts` / `bias.ts`(recordTopics/computeBiasBoost)/ `userLearning.ts` 全部保留
- 情感评分公式:**一致性 0.30 + 情感 0.45 + 时间 0.15 + 偏差 0.10**(情绪主锚 + "不像她"珍贵瞬间)
- memory 表情感列:`emotional_impact`/`vad_valence`/`vad_arousal`/`vad_dominance`/`tsundere_level`/`agent_mood`/`agent_desire`
- 工具 `mood_journal`(admin)+ `user_observe`(harness)
- 分类种子 `emotional`/`mood_snapshot`;`auto_process` 保留 VAD 队列/mood/observeUserMessage

### Verified(独立复验,非自报)
- npm run build EXIT=0(全文件零错误)
- smoke_test.py 全 PASS(31 工具、项目隔离、跨项目去重)
- 4 个融合轮次 smoke(数据层 27 项/嵌入+反思 19 项/reflect 层/工具注册)全 PASS
- tools/list 实测 31 工具,mood_journal/user_observe/memory_context/consolidate_deep/instruction_save 均在
- 禁改文件(emotion/agentState/bias/userLearning/memType/buffer/triage/instructions/configLoader/category)零改动

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
