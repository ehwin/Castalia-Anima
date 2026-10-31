# Castalia Anima — Memory Body（记忆体）

一个可独立运行的 MCP 记忆服务器：**情感记忆体，没有情感状态机**。

记忆的写入、检索、反思、事实、实体、图谱、跨库联邦检索全部保留；情感只体现在
**记忆本身**（每条记忆的 `vad_valence / vad_arousal / vad_dominance / emotional_impact`
+ 情感加权检索 + 时间衰减 + 显著性重排）。本构建**不含**任何运行时情绪状态：
没有心境变量、没有 agent 状态快照、没有自循环（self-cycle）、没有 psyche 状态表。
跨库「总反思」也不再是内置工具，而是作为一个**可选插件**（`dist/plugins/fullPipeline`）挂在外面。

> 一句话区分：**记忆会记得那件事有多重；服务器自己不"有情绪"。**

---

## 1. 它是什么 / 不是什么

| 有 | 没有 |
|---|---|
| 对话落库 → VAD（效价/唤醒/支配）分析 → 情感加权检索 | 自回归情感状态机（psyche_state / psyche_events） |
| 时间衰减、显著性重排、锚点（pinned）永不衰减 | agent 心境 / 精力 / 当前想法（agent state 快照） |
| 反思（单库：`reflect_auto` / `reflect_deep` / 手工 `reflect_analyze`+`reflect_apply`） | 自循环日记（self-cycle diary）与 `mood_journal` |
| 事实三元组（含双时态 `fact_as_of`）、实体层、冲突报告 | 3D 星图 / Web 控制台（属另一个仓的 GUI 侧） |
| 跨库检索（本实例多库 + `FEDERATION_*` 成员），只读拼装 | 跨库总反思（`reflect_all`）：已剥离为插件，见 §6 |
| 前端存储桥（`memory_store_*` / `memory_recall`），可当持久层 | 任何 API key 或供应商凭据（配置见 `.example`，自行填） |

## 2. 快速开始

```bash
# 需要 Node ≥ 20（开发/验证于 24.x）
npm install                                          # 包内已带 node_modules，可跳过
cp memory/config.example.json memory/config.json      # 填自己的嵌入/反思后端
node dist/index.js                                    # stdio MCP server
```

宿主（任意支持 MCP stdio 的客户端）：

```json
{
  "mcpServers": {
    "castalia": {
      "command": "node",
      "args": ["C:/path/to/this/package/dist/index.js"],
      "env": {
        "MEMORY_DB_DIR": "C:/path/to/this/package/memory",
        "CASTALIA_PROJECT": "default",
        "MCP_TOOLS": "all"
      }
    }
  }
}
```

首次启动会在 `MEMORY_DB_DIR` 下建库与表结构（空库自建，无迁移脚本）。
`node scripts/mcp_probe.py` 不在本包内；探活可设 `HEALTH_PORT=8787` 后 `GET /health`。

## 3. 工具（按组注册，`MCP_TOOLS` 控制）

默认 `all`；也可写组名（`agent,admin`）或单个工具名。

| 组 | 用途 | 工具 |
|---|---|---|
| `agent` | 只读检索（给主 Agent） | `memory_search` `memory_get` `memory_recent` `memory_index` `fact_search` `fact_as_of` `memory_graph` `entity_lookup` |
| `harness` | 写入与管线（给宿主内部） | `auto_process` `conversation_save` `tavern_sync` `digest_run` `reflect_auto` `reflect_deep` `reflect_batch_embed` `memory_save` `memory_update` `memory_delete` `memory_log` `instruction_save` `user_observe` |
| `admin` | 管理与上下文组装 | `context_get` `memory_context` `memory_list` `stats_get` `recent_conversations` `daily_summary_data` `reflect_analyze` `reflect_apply` `consolidate_deep` `project_list` `project_create` `memory_search_all` `instruction_list` `instruction_delete` `facts_windows_plan` `facts_windows_apply` |
| `store` | 前端持久层桥 | `memory_store_list` `memory_store_save` `memory_store_forget` `memory_recall` |
| `entity` | 实体层 | `entity_lookup` `facts_conflicts_report` |

**相对「带情感状态机」的版本，工具面少了三个**：`mood_journal`、`self_cycle`、`reflect_all`。
`context_get` / `memory_context` 不再返回 `psyche` 块；`auto_process` / `conversation_save`
不再接受 `moodValue` / `moodReason`（多传会被忽略，老宿主不会报错，只是心境不再被记录）。

## 4. 记忆模型（简版）

- **存储分层**：每个 project 一个目录，按 `mem_type`（general / user / feedback / project / reference）分库，
  每库一个 SQLite（`memory.sqlite`，WAL）。软删 = `is_active = 0`（行还在，可恢复）。
- **来源隔离**：`source` 区分 `conversation_log`（原始对话证据）/ `manual` / `agent_diary`（派生观察）/
  `session_memory` 等；默认检索与反思排除派生观察，只有显式 `includeDiary` 才进。
- **情感列**：`vad_*`（−1..1）与 `emotional_impact`（0..10）。两条写入路径：模型（Ollama 或兼容接口）
  判 VAD；模型不可用时退回**本地情感词表**（`src/affectLexicon.ts`），没词就 `abstain`，不凭空造情绪。
- **检索打分**：一致性 + 情感强度（主锚）+ 时间衰减 + 语料偏离加成，再乘 bias / importance / tier / 访问强化；
  纯函数在 `src/emotionalRanking.ts`，可单测。
- **事实**：三元组 + 双时态（`valid_from` / `valid_to`），`fact_as_of` 可按时刻回看；被推翻的旧事实不删。

## 5. 配置

`config.json` 位置优先级：`MEMORY_CONFIG` > `<MEMORY_DB_DIR>/config.json` > `./memory/config.json`。
字段示例见 `memory/config.example.json`：

```json
{
  "embedding": { "mode": "ollama", "ollama_url": "http://127.0.0.1:11434", "model": "bge-m3", "dim": 1024 },
  "reflect": { "llm_url": "https://api.example.com/v1/chat/completions", "api_key": "PUT-YOUR-KEY-HERE", "model": "your-model" },
  "triage": { "llm_url": "", "api_key": "", "model": "" },
  "personas": { "default": { "name": "Anima", "persona": "角色设定写这里" } }
}
```

嵌入两条路：`embedding.mode = "ollama"`（本地）或 `"api"`（OpenAI 兼容 `/v1/embeddings`，
配 `api_url` / `api_model` / `api_key`）。**换嵌入模型等于换向量空间**：引擎检测到维度或模型变化会
要求重嵌（`reflect_batch_embed` 或 `scripts/backfill_reflect_vectors.mjs`），不会静默清库。

常用环境变量：`MEMORY_DB_DIR`、`MEMORY_CONFIG`、`CHAR_ID`（角色分区，默认 `default`）、
`CASTALIA_PROJECT`、`MCP_TOOLS`、`EMBED_MODE`、`OLLAMA_URL`、`EMBEDDING_MODEL`、
`EMBEDDING_API_KEY`、`REFLECT_LLM_URL`、`REFLECT_LLM_MODEL`、`REFLECT_LLM_API_KEY`、
`PERSONAS_JSON`、`FEDERATION_DIRS` / `FEDERATION_MEMBERS`（跨库成员）、`HEALTH_PORT`（可选探活端口）。

## 6. 插件：跨库总反思（`plugins/fullPipeline`）

总反思（多库活跃记忆一起看 → 去重合并 → 提炼高价值洞察 → 写进专用 `project=reflect` 库）
已从 MCP 工具面剥离，作为**可选插件**存在：记忆体不注册它，也不在请求路径里跑它。

```bash
# 只分析不写库（先看它想写什么）
node dist/plugins/fullPipeline/cli.js --projects=default,shared --dry-run

# 真写：结果进 project=reflect 库；源库只读打开
node dist/plugins/fullPipeline/cli.js --projects=default,shared

# 全量重跑（忽略增量账本），并纳入 FEDERATION_* 里的外部库
node dist/plugins/fullPipeline/cli.js --all
```

参数：`--max-total=N`（默认 300）、`--max-per-lib=N`（默认 100）、`--projects=a,b`、
`--dry-run`、`--all`、`--json`。需要 `config.json` 的 `reflect` 通道可用。
每个独立记忆体想要「总反思」，就把这个 CLI 挂到它自己的调度器上 —— 一库一套，不设中心越权。

## 7. 面板对接（`tuning-support.json`）

这个变体保留「记忆 + 面板」：宿主（如 AIRI 的「心智参数」面板）不需要认识引擎内部，只要读
`tuning-support.json` 就能生成**真实生效**的表单：

```json
{
  "spec_version": 1,
  "engine": "castalia-anima",
  "variant": "memory-panel",
  "groups": {
    "search": [ { "key": "WEIGHT_CONSISTENCY", "kind": "number", "default": 1.0, "min": 0, "max": 3, "step": 0.01, "restart": true, "label": {…} }, … ],
    "inject": [ { "key": "MEMORY_INJECT_MIN_SIM", "default": 0.5, … }, … ]
  },
  "presets": {}
}
```

三条约定：

1. **只画清单里的键**。本变体没有情感状态机，所以清单里没有 `PSYCHE_*` / `ANIMA_*`——
   面板应把 band / halfLife / mood / gain / trait / evidence 六组整组隐藏，而不是给一排死开关。
2. **默认值取清单里的 `default`**，不要用宿主自己那份（不同变体的权重默认值不同：
   本变体是 1.00 / 0.12 / 0.03 / 0.10）。
3. `restart: true` 的键是模块级常量，改完必须重启后端进程。

契约测试（断言每个键真的被引擎读、默认值与代码一致、清单里没有 psyche 键）：

```bash
node scripts/test_tuning_surface.mjs   # 19 断言
```

## 8. 测试

```bash
npm run build
node scripts/regression_cjk_recall.mjs
node scripts/regression_memory_injection.mjs
node scripts/regression_facts.mjs
node scripts/regression_restart_recovery.mjs
node scripts/test_emotional_ranking.mjs
# 跑全部：
for f in scripts/regression_*.mjs scripts/test_*.mjs; do echo "== $f"; node "$f" || break; done
```

测试全部用临时库（`mkdtemp`），不读写 `MEMORY_DB_DIR` 之外的东西；不需要真实 LLM
（自带 mock 通道）也不需要网络。

## 9. 与「完整 Anima」的差异（本包是子集）

| 模块 | 状态 |
|---|---|
| `psycheState.ts`（878 行，VAD 状态机 + 半衰期 + 事件账本） | 已移除 |
| `selfCycle.ts` / `selfCycleCursor.ts`（自循环 + 游标/claim） | 已移除 |
| `agentState.ts`（心境/精力/想法快照，写 `agent_state` 源） | 已移除 |
| `reflectAll.ts`（跨库总反思 + reflect 总库写入） | 移入 `src/plugins/fullPipeline/`，改为 CLI 插件 |
| `mood_journal` / `self_cycle` / `reflect_all` 三个 MCP 工具 | 已移除 |
| `psyche_state` / `psyche_events` 表、`psyche_*` 迁移 | 已移除（旧库若带这些表，引擎不会读也不会写，可手工 DROP） |
| VAD 分析、情感列、情感加权检索、衰减与显著性 | **保留**（这是"情感记忆体"的本体） |

## 10. 目录

```
dist/            编译产物（含 dist/plugins/fullPipeline/cli.js）
src/             源码（TypeScript）
scripts/         回归与运维脚本（测试、审计、回填、备份）
docs/            设计文档
integrations/    SillyTavern 桥（可选）
memory/          运行时库目录（默认空 + config.example.json）
```

## 11. 许可证

MIT，见 `LICENSE`。
