# Castalia Anima — Emotional Memory Server (MCP)

**The emotional variant of [Castalia](https://github.com/ehwin/Castalia).** Same architecture (SQLite + sqlite-vec local memory, zero API cost), with a personality layer on top: agent self-state (mood/desire/energy), bias layer, user learning, and emotion-weighted search.

Neutral core stays in Castalia; Anima feeds emotional features back upstream — the two repos cross-pollinate.

> **Emotional edition (this repo).** For the neutral single-instance edition see **[Castalia](https://github.com/ehwin/Castalia)**; for the neutral full edition with cross-library federation (`reflect_all` / `memory_search_all` over `FEDERATION_DIRS`) see **[Castalia-Full](https://github.com/ehwin/Castalia-Full)**.

Anima owns its bank, emotional state, and reflection pipeline. Its `memory_search` only returns Anima records and has no Full dependency. A consumer such as AIRI may independently read both Anima and Full's aggregate output; configure that integration in the consumer, not inside Anima. Full reads source banks without writing back to them.

> 📖 详细技术设计见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

---

> 📦 **New here? Read [INSTALL.md](INSTALL.md)** — full setup steps, including the npm 12 native-module pitfall that makes the engine fail to start.

## Quick Start

### 1. Build + verify

```bash
npm install
npm run build                  # tsc → dist/index.js
```

### 2. Start the embedding service (first load ~30-60s)

Any Ollama-compatible embed service works — point `OLLAMA_URL` + `EMBEDDING_MODEL` at it.

```bat
scripts\start-embed.bat
```

### 3. Configure LLM channels (optional but recommended)

Copy `memory/config.json` from the template (or create it) to wire the two LLM channels:

```json
{
  "triage":   { "llm_url": "https://api.deepseek.com/v1", "api_key": "sk-...", "model": "deepseek-chat" },
  "reflect":  { "llm_url": "https://api.deepseek.com/v1", "api_key": "sk-...", "model": "deepseek-chat" },
  "embedding": { "mode": "ollama", "ollama_url": "http://127.0.0.1:11436", "model": "yuan-embedding-2.0-zh" }
}
```

`triage` is optional — unset values fall back to `reflect`. Without any LLM key, the server still works fully as a read/write memory store; only reflection/triage are skipped.

> 🔐 **Recommended: encrypt API keys** (not plaintext in config.json) — three-channel keys via `scripts/keygen.js` into `memory/keys.enc` (AES-256-GCM, key in `memory/keys.key`, both git-ignored).

### 4. Connect from your MCP client

```json
{
  "mcpServers": {
    "anima-memory": {
      "command": "node",
      "args": ["<path>/dist/index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_DIR": "<path>/memory",
        "CHAR_ID": "anima"
      }
    }
  }
}
```

---

## Features

### SillyTavern integration

The optional [SillyTavern adapter](integrations/sillytavern/README.md) adds a default-off switch for each chat, isolated user/chat projects, selected-message synchronization (including edits, swipes and deletions), and generation-time recall with a token budget. It uses a separate bank and does not enable the emotion/profile/reflection pipelines. Build Anima first, then install the adapter's frontend extension and server plugin.

### Personality layer (Anima-only)

| Capability | Description |
|-----------|-------------|
| **Agent self-state** | mood / desire / energy with exponential-decay aggregation; `|value|>=7` auto-persisted |
| **Emotion-weighted search** | Alaya scoring: 1.2×similarity + 0.3×time_decay + 0.1×emotion |
| **Time decay** | Ebbinghaus forgetting curve, 30-day half-life |
| **Bias layer** | topic weight accumulation, affects retrieval priority |
| **User Learning** | observes user communication patterns & interests |
| **Character ID** | multi-character support |
| **Agent prompt injection** | `[Anima current state]` + `[user profile]` + `[interest trends]` bundle |

### Core memory (shared with Castalia)

- **memdir storage**: `memory/<project>/<memType>/memory.sqlite` — per-project, user/feedback/project/reference/general folders
- 29+ MCP tools: memory CRUD, search (profiles: quick/balanced/deep), instructions (3 layers), reflection (auto/deep/analyze/apply), consolidation, conversation automation (auto_process/digest)
- **Injection-ready context**: `memory_context` → 三层指令 + recent + related + facts + session rolling state, with Memory Snapshot Warning
- **Progressive reflection**: session buffer (5 turns / 4000 tokens dual threshold) + digest cycle
- **3D Star Map**: three-layer galaxy layout (project → memType → fixed-orbit nodes), semantic clusters, directional bridges, starfield background

## Scoring formula

```
score = (1.2 × similarity + 0.3 × time_decay + 0.1 × emotion) × importance × access_freq × bias
```

where:
- similarity — embedding cosine (any Ollama-compatible /api/embed)
- time_decay — e^(-t/S), S = HALF_LIFE_DAYS / ln(2)
- emotion — |emotionalImpact| / 10
- importance — 0.5 + importance (0.5 ~ 1.5)
- access_freq — 1 + min(0.5, log2(1 + accessCount) × 0.1)
- bias — 1 + min(0.5, topicWeight × 0.05)

## Preset categories

```
├ entity       — entity memories (people, places, things)
│ └ relationship — relationship memories
├ episodic     — event memories
│ ├ conversation — dialog memories
│ ├ emotional    — emotional experiences ⭐
│ └ milestone    — growth milestones ⭐
├ preference   — user preferences and habits
└ semantic     — factual knowledge
  ├ identity     — identity info
  └ knowledge    — knowledge facts
```

## File structure

```
├ src/
│   index.ts         — MCP server entry (29+ tools)
│   db.ts            — SQLite + memdir database manager
│   ollama.ts        — embedding client (per-project isolation)
│   store.ts         — memory store + dedup + auto consolidation
│   search.ts        — Alaya scoring search + bias weighting
│   category.ts      — hierarchical category management
│   consolidate.ts   — memory consolidation
│   agentState.ts    — agent self-state (mood/desire/energy)  [Anima]
│   bias.ts          — bias layer (topic weight accumulation) [Anima]
│   emotion.ts       — emotion extraction                      [Anima]
│   userLearning.ts  — user communication pattern learning     [Anima]
├ dist/              — compiled output
├ memory/            — DB files (memdir layout)
├ package.json
├ tsconfig.json
└ README.md
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | http://127.0.0.1:11436 | embedding API endpoint |
| `EMBEDDING_MODEL` | yuan-embedding-2.0-zh | embedding model name |
| `EMBEDDING_DIM` | 1024 | 向量维度（与 `embedding.dim` 同义；换嵌入模型时必填，见下节） |
| `MEMORY_DB_DIR` | ./memory | memdir root for per-project/per-type DBs |
| `CHAR_ID` | `airi` | 角色/实例 ID。**唯一角色来源**（一个实例一个角色）；同库多角色靠 `character_id` 列隔离 |
| `WEIGHT_SIMILARITY` | 1.2 | similarity weight |
| `WEIGHT_TIME_DECAY` | 0.3 | time-decay weight |
| `WEIGHT_EMOTION` | 0.1 | emotion weight |
| `HALF_LIFE_DAYS` | 30 | time-decay half-life (days) |

## Role isolation (v1.24)

对齐 Castalia 普通版语义：**角色 = 进程级 `CHAR_ID`**，`project` 只是记忆库维度（库/项目分区），不再由库名推导角色。

| 维度 | 含义 | 隔离方式 |
|------|------|----------|
| `CHAR_ID` | 角色/实例（一个进程一个） | `memory.character_id` / `facts.character_id` 列过滤 |
| `CASTALIA_PROJECT` / `project` 参数 | 记忆库（库/项目） | `memory/<project>/<memType>/memory.sqlite` 物理分库 + `project` 列 |

- **多角色 = 多实例**：各自 `CHAR_ID` + 各自 `MEMORY_DB_DIR`；若多角色共用一个库目录，则靠 `character_id` 列隔离（读/写/维护全路径过滤：检索、索引、图谱、上下文包、统计、事实、反思/整合、会话滚动快照、冷存/清理）。
- **按 id 的操作有归属校验**：`memory_get` / `memory_update` / `memory_delete` 只认本角色的记忆，跨角色 id 一律当作不存在。
- **人格映射**：`PERSONAS_JSON` 以 `CHAR_ID` 为键（v1.24 前以 project 名为键，旧配置需改键）。`charFor(project)` 已废弃，恒返回 `CHAR_ID`。
- **写入永不落 NULL**：`saveMemory` / `saveConversationTurn` / `saveFacts` / 会话快照默认写 `CHAR_ID`。
- **历史 NULL 行自动补齐**：库首次打开时，若该库只有一个非空 `character_id`，就把 NULL 行归给它；库里有多个角色则不猜（保持 NULL）。
- **显式跨角色**：需要跨角色扫描的管理接口（如 `reflect_batch_embed`）传 `characterId: "any"` 关闭过滤；`reflect_all` / `memory_search_all` 的跨库联邦按设计不做单库角色过滤。
- **回归**：`node scripts/regression_role_isolation.mjs .`（39 项断言：检索/索引/图谱/会话/事实/归属校验/晋升去重/迁移补齐/冷存）。

## 模型与维度可配（v1.25）

每个记忆库（bank）自己一套模型配置，写在 `<bank>/config.json`（引擎启动时由 `MEMORY_CONFIG` 指向；托盘实例的 `bank` 决定路径，见 `castalia.config.json` 的 `instances` / `bridges`）：

```json
{
  "embedding": { "mode": "api", "api_url": "https://api.siliconflow.cn/v1", "api_model": "BAAI/bge-m3", "dim": 1024 },
  "reflect":   { "llm_url": "https://api.deepseek.com", "model": "deepseek-v4-flash", "maxFacts": 15 },
  "triage":    { "llm_url": "https://api.deepseek.com", "model": "deepseek-v4-flash" }
}
```

- **换嵌入模型只改配置，不改源码**：`embedding.dim`（或环境变量 `EMBEDDING_DIM`）告诉引擎 vec 表该多宽；不填则沿用 1024。
- **维度变化自动重建索引**：库首次打开时若发现 `vec_memory` / `vec_facts` 的维度与配置不一致，就重建这两个 vec 表并清空 `embedding_cache`。`memory` / `facts` 的正文与关系不动，缺向量的行由 `reflect_batch_embed`（或下次写入）重新嵌入；`EMBED_MODE=none` 时保持待嵌状态。
- **无显卡用户**：把 `embedding.mode` 设为 `api`，填 `api_url` / `api_model` / `api_key`（或用 `keys.enc`），`dim` 填该模型的输出维度即可，本地不需要 Ollama。
- **菜单入口**：托盘设置窗口（`run/Castalia/scripts/castalia_settings.py`）的「角色模型」页按库列出嵌入模式/模型/维度与反思、分拣模型，双击即改，保存后重启托盘生效；`python castalia_settings.py --check` 可无界面校验。
- **回归**：`node scripts/regression_embed_dim.mjs`（17 项：维度生效、config.json 端到端、自动重建、正文不丢、缓存清空、默认 1024）。

## 前端存储桥（v1.26）

给「每个角色一套记忆」的客户端（AIRI 这类桌宠/伴侣前端）当持久层用：前端不再自己存一份，而是把记忆写进同一个记忆库，引擎的检索、反思、图谱、看板立刻看到同一批数据。

| 工具 | 用途 |
|------|------|
| `memory_store_list` | 按角色列记忆（完整正文，不截断）；`allCharacters` + `source` 让前端一次重建自己的缓存 |
| `memory_store_save` | 按「索引名」在（库, 角色）范围内新增/覆盖一条；走 `memory_save` 流水线（嵌入、关系、衰减照常） |
| `memory_store_forget` | 按索引名软删一条（只删本角色的，共享条目不受影响） |

- **角色 = `character_id`**：工具接受显式 `characterId`，不传则回落本进程 `CHAR_ID`；`general: true` 写共享层（`character_id` 为空，所有角色可见）。
- **文本约定**：第一行 `# <name>` 是索引名，第二行是用途说明，空行之后是正文；写入方记在 `source`（AIRI 用 `airi`），前端据此只拉自己那份。
- **`MCP_TOOLS=store`** 只注册这三个工具：进程启动快，也不会顺带跑启动反思/整合。
- **接入位置**：AIRI 主进程 `apps/stage-tamagotchi/src/main/services/airi/castalia-engine.ts`（stdio 拉起引擎 + 这三个工具）；`<userData>/castalia-engine.json` 可改 `engineEntry` / `bankDir` / `project` / `nodeBinary`，或写 `{"enabled": false}` 退回本地 SQLite。
- **为什么必须指定 node**：引擎的 `better-sqlite3` 与托盘自带的 `run/Castalia/bin/CastaliaNode.exe` ABI 对齐；用 Electron 的 `process.execPath` 起会加载失败的 native 模块。该 Node 只对 `D:` 有写权限，记忆库要放在 `D:\AI\castalia\memory-banks\...` 下。
- **回归**：`node scripts/regression_store_bridge.mjs`（29 项：写入/读取/角色隔离/共享层/同名覆盖/软删/跨角色拉全/引擎侧可见）。

## 规模体检与「换图数据库」阈值（v1.26）

`node scripts/audit_scale.mjs` 只读盘点所有 bank（复制到临时目录再统计，不碰线上库），输出行数 + 三条延迟，并直接给结论。当前实测（2026-10-27，5 个 bank / 64 个库文件）：active memory **2162**、facts **1262**、edges **692**、向量 **3412**；2 跳图遍历 0.006–0.024 ms/次，按时刻取有效事实 0.005–0.022 ms/次。

换嵌入式图/时序引擎（Kùzu / Cozo 这类）的阈值，超过任一条再评估：

- 单库 `edges` > 200,000 或 `facts` > 500,000；
- 2 跳遍历 > 20ms，或需要 3 跳以上的变长路径；
- 需要社区发现 / PageRank 这类真正的图算法（不只是邻居列表）。

在此之前：递归 CTE + 规范化实体表就够。时序语义（`facts.valid_from/valid_to` + 互斥旧事实自动失效）已经在 SQLite 上实现，见 `store.ts` / `reflectDriver.ts` / `search.ts` 的 `valid_to` 判定。

`audit_scale.mjs` 同时会量一遍向量 KNN（库里现成向量当查询向量），向量超过 5 万条且暴力 KNN > 50ms 时提示先上量化/分区，而不是先换引擎。

### 实测结论（2026-10-27，5 个引擎同数据同机器）

`_engine_lab/` 里把这条阈值线跑成了实测：同一份真实数据（x1）+ 确定性放大（x10/x100），7 类查询，5 个候选引擎，连同安装体积、多进程、备份、受限 Node 兼容性一起量。完整报告见 `_engine_lab/VERDICT.md`，汇总表 `_engine_lab/COMPARISON.md`。

一句话：**不换。** SQLite 在点查（快 1–2 个数量级）、单行写入（快 100–380×）、发布体积（2.1MB）、受限运行时上全面领先；DuckDB 只在列式聚合上快 78×（37.9 万事实时），适合做只读分析旁路；Cozo 的规则式时间推理好用但包停更、非覆盖索引静默错数据；Kùzu 的 npm 包已废弃、解包 513MB，且**在托盘自带的受限 Node 下 `import('kuzu')` 直接 0xC0000005 崩溃**；SurrealDB 的 wasm 形态没有库文件（只有 `mem://`，备份靠导出 SQL 重放）、x100 导入 17 分钟才到 92%；Neo4j/Gel 要常驻服务和端口，塞不进 `run/*/dist`。真正让 `MATCH (e:Entity {name:'猫'})` 返回空的是数据里没有实体层，已按 v1.27 补上（见下节）。

## 实体层（v1.27）

原来的 facts 是纯文本三元组，`subject`/`object` 是自由字符串，所以「和某实体相关的事实/记忆」只能 LIKE 扫正文；用 Cypher 写的
`MATCH (e:Entity {name:'猫'})-[:MENTIONED_IN|RELATED_TO*1..2]-(m:Memory)` 在任何引擎上都返回空——因为**没有 Entity 节点、也没有 MENTIONED_IN 边**，跟选哪个数据库无关。v1.27 补的就是这一层，仍然在 SQLite 上：

| 表 / 视图 | 作用 |
|-----------|------|
| `entities(id, key, name, kind, mention_count, first_seen, last_seen)` | 实体表。`id = sha1(归一化键)`，跨进程/跨库稳定；`key` 唯一 |
| `fact_entities(fact_id, entity_id, role)` | 事实 ↔ 实体（`role` = subject/object） |
| `memory_entities(memory_id, entity_id, role)` | 记忆 ↔ 实体（`role` = fact，来自事实的 `source_memory_id`） |
| `facts_current`（视图） | `is_active = 1 AND (valid_to IS NULL OR valid_to = '')` —— 当前有效事实的口径收敛到一处 |

| 工具 | 用途 |
|------|------|
| `entity_lookup` | 名字 → 实体 + **某个时刻**有效的事实 + 相关记忆（1 跳）；`includeGraph` 附带共现邻居实体 |
| `memory_graph` | 新增 `depth`（1–3，递归 CTE 变长路径）与 `via`（`memory`/`entity`/`both`）：节点带 `type`，边带 `kind`（`memory` / `memory-entity` / `entity-entity`） |
| `facts_conflicts_report` | 被推翻的历史事实 + 同一主体同一谓词下的当前多值（潜在矛盾）+ 实体统计；用来确认「时间失效」路径真的在跑 |

- **写入即建联**：`saveFacts` 落库后立刻登记实体并写 `fact_entities` / `memory_entities`，不需要 LLM、不需要额外一轮反思。
- **老库自愈**：打开库时若发现「有 facts 但没有实体关联」，自动回填一批（有上限、幂等、无 flag）；`reclassifyEntities` 会重算历史行的 `kind`。不需要手工迁移，也不需要动源码。
- **`kind` 分类**：`role`（user/agent/environment/reference 这类角色位）、`topic`（知识实体）、以及 `url` / `path` / `config` / `number` 四类噪声。实测线上 hermes 库 651 条事实派生 634 个实体，其中 topic 450、path 35、number 33、url 4、config 4、role 4——**约 12% 是「顺手记下的字符串」**（`D:\AI\...`、`http://localhost:11434`、`¥0.07/M`）。噪声实体照常入库、照常可查（路径保留原始分隔符，不会被归一化拆碎），但 `memory_graph` 只画 `topic`/`role`。
- **`valid_from` 语义修正**：新事实的 `valid_from` 默认取写入时间，历史空值回填成 `created_at`。否则「按时刻 T 查有效事实」会把 2026 年写入的事实算成 2000 年就为真，时间层等于假的。
- **回归**：`node scripts/regression_entities.mjs`（39 项：建联、归一化、分类、路径可查、冲突失效、时间点查、图扩散、回填自愈、三个 MCP 工具）。

**还没解决的那一半**：实体层的上限由抽取质量决定。实测线上数据的 `object` 大量是整句（`高风险部署前开新档，避免长会话上下文不足`），最热的四个「实体」是 `user`/`environment`/`agent`/`reference` 四个角色位——这是 reflect 提示词里 `{"subject": "user", ...}` 的写法决定的，不是存储问题；记忆里有事实的只占 8.5%（见 `dataset_stats.mjs` 口径：82% 的记忆没有任何事实/边/实体提及）。要拿到真正的知识图谱，下一步是让反思输出显式的实体数组 + 归一化关系（句子进 `evidence`），而不是换数据库。

还有一个具体的断点：`applyReflectResult` 写 facts 时 `source_memory_id = null`（facts 在 `general` 库、摘要在 `project` 库，跨库引用会撞 FK），所以反思产出的那条「抽取记忆」和 facts 之间**没有** `memory_entities` 关联——这正是 8.5% 覆盖率的主因。补法是让抽取记忆与 facts 落在同一个库里再挂 id（或让 `memory_entities` 用「抽取记忆 id + 同一库」的语义),而不是把两套图各画各的。

## Search profiles

| Profile | topK | minScore | Use |
|---------|------|----------|-----|
| `quick` | 3 | 0.6 | fast recall, high precision |
| `balanced` | 5 | 0.3 | default, balanced |
| `deep` | 10 | 0.1 | deep recall, more related |

## Credits & Upstream

- **[Castalia](https://github.com/ehwin/Castalia)** — the neutral single-instance core this project builds on
- **[Castalia-Full](https://github.com/ehwin/Castalia-Full)** — the neutral full edition with cross-library federation
- The three repos cross-pollinate (Anima feeds emotional features upstream, Castalia keeps the neutral core stable)
- **cognitive-memory** (Apache-2.0) — schema & vector KNN concepts (code heavily rewritten)
- **Claude Code** (Anthropic) — closed memory types, MEMORY.md index, progressive session maintenance patterns (re-implemented in SQLite)

License: MIT, see `LICENSE`.
