# Castalia Anima — 情感记忆变体（MCP 服务）

**一句话**：给陪伴型 / 人格型 agent 用的本地记忆后端 —— Castalia 引擎核心 + 情绪层 + 人物层 + 实体层，SQLite 落盘、按角色隔离、存储零 API 成本。

它要解决的不是"问什么能不能查到"，而是**"该想起的时候想起、不该提的时候不提、重要的不会淡、次要的会淡"**。这条口径被拆成三条互不越界的链路：证据链、派生链、隔离面。

- `VERSION` = **1.28.8**（`package.json` 的 `version` 仍写 1.23.2，已落后，以 `VERSION` 为准；构建时 `scripts/gen_version.mjs` 生成 `src/version.ts`）
- `src/` **49** 个 TypeScript 文件（约 17.9k 行）· **45** 个去重 MCP tool（分组挂载 46 次，`entity_lookup` 同属两组）· `scripts/` **59** 个 `.mjs` · **80** 个去重的 `process.env` 读取点
- **没有 Web 控制台**：UI 由宿主应用提供，本仓只提供 stdio MCP 服务
- 首次安装（含 npm 12 屏蔽原生模块编译的坑）见 [INSTALL.md](INSTALL.md)

> **2026-11-01 的两处状态变化**（先读这两条，再读别的）：
> 1. **情感层默认关闭估计器**：词表不再写 VAD、不再驱动 psyche，`affect_status` 落到 `abstain`。理由是实测，见下节。
> 2. **注入层不再把同一句话说四遍**：按共用的引号片段判重，实测 4 条同义记忆 1208 → 349 字符。

---

## 情感层当前状态（2026-11-01，实测口径）

这一节是本仓唯一一处"设计让位于测量"的地方。它记录的是**为什么默认值是现在这样**，不是"以后也不做"。

| 问题 | 实测 | 结论 |
|---|---|---|
| 从文本读 VAD 准不准（中文陪伴语料，CPED n=300） | 三分类 **κ=0.145**（强 LLM）、**0.015**（本仓词表）；三类随机 κ≈0；可用线 κ≥0.4 | **两个估计器都不过线** |
| 换更强的模型能不能救 | 同一模型在同一批 CPED 上 κ 0.145；英/西/法/意事件语料上 valence r=0.856，但对照的是上游按理论手工赋值的标签（上游自述 "not human-eval corpora"） | 任务与标签口径不同，不能混用 |
| 状态注进去会不会改变生成 | 三模型、n=100/格：只有"负性状态→回复略更负"同号，**均值 −0.041**；机制（类别词 vs 数值）换模型就反向 | 效应小且不可推广 |
| 连续数值本身有用吗 | 端点说明 −（词+数值）**+0.027 不可判定**；锚定−描述 **−0.001**；arousal 单独操纵三档 Δa 全部不可判定 | **数值不传导；arousal 维度惰性** |
| 那还留着 VAD 干什么 | 线上覆盖 17/225 = 7.6%（2026-11-01 airi/general），且新写入不再产生 | 冻结 72h 后回落到人格基线 |

据此定下的默认值：

- `tagWithLocalAffect` **只写 `affect_status='abstain'`**，不写 `vad_*`、不写 `emotional_impact`、不置 `pending_psyche`；
- `finalizeAffectPsyche` / `applyPsycheAppraisal` **默认不由 VAD 估计触发**，要接得显式 `PSYCHE_FROM_VAD=on`；
- 没有新证据时，`psyche_state` 的证据在 `PSYCHE_EVIDENCE_TTL_HOURS`（默认 72h）后过期，`band` 回落到人格基线。

**重开条件（两条同时满足，缺一条都只是把不兑现的指标做漂亮）**：

1. 目标语言的独立标注集上估计器 **κ ≥ 0.4**（现在 0.145）；
2. 同一个端到端效应在 **≥2 个家族**的模型上同号且区间不含 0（现在只有 −0.041 一条）。

报告同时指出：真要恢复情感层，入口不是"更贵的文本 VAD"，而是**非文本通道**（说话人 / 言语行为 / 延迟 / 长度骤变 / 撤回）——同一批数据上 META 特征 AUC 0.6344 vs 文本 0.5578。

**位置在哪一层**（[docs/affect-placement-2026-11-01.md](docs/affect-placement-2026-11-01.md)）：

- 检索打分（现状）：`WEIGHT_EMOTION 0` vs `0.12` 在 69 条金标上 p=1（只多中 1 条），**零效应**；加到 `1.0` 则 17:0 显著变差；
- 注入决策：`0.12` 与 `0` 在 300 条外部中文闲聊上的误注入率**逐位相同**（24.3%），因为门槛判在 similarity 上，排序项改不了"过不过门"；
- 所以情感项现在被放在唯一不产生可测效果的位置：**只重排、不决策**。

---

## 三条链路与硬边界

```text
① 证据链（只存事实，不存解释）
用户/角色对话
  -> conversation_log（general 库，affect_status=pending）
  -> VAD 队列（只接受 conversation_log 且 active）
  -> 模型分析成功(analyzed) / 无可靠证据(abstain) / 失败(保留重试)
  -> 词表兜底只写 abstain（2026-11-01 起不写 VAD，见上节）
  -> psyche_state（确定性状态转移，不是 memory；默认不由 VAD 驱动）
  -> currentMood / context_get / 注入与检索的重排
  -> 回复

② 派生链（只读证据，只写派生物）
conversation_log + psyche_state + AgentState(energy/desire)
  -> self_cycle（持久游标 + claim + 幂等）
  -> agent_diary（memType=project，带 provenance，不 embed，不进 VAD）

③ 隔离面（默认不可见）
search / recall / 注入 / 反思 / 整合 / 冷存 / 事实来源 / 实体图
  - 默认排除 agent_diary 与 agent_state
  - 只有显式 includeDiary=true 才能翻到日记
```

七条不变量，改任何一条都要先改审计文档：

1. **先存证据，再入队**。不能先改 mood 再补记忆。
2. 只有 VAD 写回**和** psyche 持久化都成功，队列项才提交为 `analyzed`；格式错、写失败、状态写失败一律保留可重试。
3. **无可靠证据写 `abstain`，不写 `neutral`**，也不推进状态。`neutral` 只代表"有证据且接近零"。
4. psyche 的读—转移—写在 SQLite `BEGIN IMMEDIATE` 内完成，避免并发版本互相覆盖。
5. 重放同一 `eventId` 不重复累加（幂等消费，最多记 128 个）。
6. `agent_diary` 不重新进入 VAD、事实提取、实体来源、普通检索、上下文注入、反思、整合。日记是派生记录，不是用户事实，也不是下一轮自循环的输入。
7. **原料行（`conversation_log` / `daily_event` / `agent_state` / `agent_diary`）不被任何自动路径标死**：反思 merge/split/delete、冷存、衰减、孤儿清扫都只写 `metadata` / `status` / `affect_status`，不改 `is_active`。一条对话被标死，`emotion.ts` 的 VAD 出队校验（要求 `is_active=1 AND source='conversation_log'`）就把它丢掉且永不重入队；`reflectionSources` 也不再把它当抽取来源。排除名单统一走 `memoryProvenance.excludeRawMaterialSql()`，不要在各文件里各写一份。人工遗忘（`memory_forget`）不受此限，但仍可 `restoreMemory` 取回。

## 模块地图

| 文件 | 职责 |
|---|---|
| `psycheState.ts` | 短期 psyche 状态机：纯函数 `transition` + 事务化持久化 + 事件去重 + 证据有效期 |
| `emotion.ts` | VAD 队列（去重入队 / 批次分析 / 失败回队 / abstain）、VAD 通道（Ollama）、词表兜底（2026-11-01 起只落 abstain） |
| `selfCycle.ts` | 自循环：读证据 → claim → 写日记 → 完成 claim；单飞、过期 claim 回收 |
| `selfCycleCursor.ts` | `(created_at,rowid)` 游标比较（兼容 ISO 与 SQLite 两种时间格式） |
| `memoryProvenance.ts` | 派生来源常量与 SQL 谓词（`publicMemorySourceSql` / `memorySourceWithoutStateSql`）；原料行口径 `RAW_MATERIAL_SOURCES` / `excludeRawMaterialSql` |
| `store.ts` | `saveMemory` / `saveSelfDiary` / `saveFacts`（来源硬校验）/ 存储桥 |
| `db.ts` | schema v5：`psyche_state`、`self_cycle_runs`、日记 evidence 唯一索引、facts 来源列迁移 |
| `search.ts` / `recallForInjection.ts` | 两段排序、门槛、注入、填充词门、同一句话去重 |
| `temporalRecall.ts` | 「按日期直取」事件行；2026-11-01 起接受 `excludeIds`，不重讲主块给过的条目 |
| `entities.ts` / `bitemporal.ts` | 实体图与双时态事实；派生来源过滤 |
| `index.ts` | 45 个工具注册、`currentMood`（psyche 优先）、`context_get` 状态块、自循环定时器 |

## 情感层与人物层（Anima-only）

| 能力 | 实现 | 说明 |
|---|---|---|
| **VAD 情感标注** | `emotion.ts` + `affectLexicon.ts` | 写入时给记忆打 `vad_valence/arousal/dominance`。词表兜底已降级为**只写 `abstain`**（κ=0.015，不参与任何评分）；模型通道不可用时不再写默认值 |
| **情绪加权检索** | `search.ts` | 情绪是"同等相关时的偏好"（`0.12 × intensity`）。**已知方向为负**：情感强度对检索相关性的 AUC 0.419、与相似度 ρ=−0.205。保留是因为有界（≤20% 分量），不是为了收益 |
| **情感显著性排序** | `emotionalRanking.ts` + `search.ts` | ACT-R 基础激活 + 情绪一致性 + 扩散激活 + 锚点（`0.30 强度 + 0.20 重要度 + 0.20 激活 + 0.15 一致性 + 0.15 共振`，锚点直接 1.0），已在检索主链上；作用范围是 ±10% 的有界乘数。数学归 `test_emotional_ranking.mjs`，接线归 `test_emotion_wiring.mjs` |
| **情感锚点** | `memory.pinned` + `memory_update {pinned:true}` + `recallForInjection` | 钉住「告白 / 转折 / 那句改变一切的话」：注入时**无条件在场**、不参与相似度门槛，仍服从项目与角色隔离；`recentIds` 去重照旧；注入返回 `stats.pinned` |
| **短期 psyche 状态** | `psycheState.ts` + `psyche_state` 表 | 见下一节。有证据时它是**唯一 affect owner**；无证据才回退到 AgentState 的 `moodValue`。证据 72h 过期 |
| **情绪自状态** | `agentState.ts` | mood / desire / energy，指数衰减聚合，绝对值 ≥ 7 自动落库；`mood_journal` 读写 |
| **偏差层** | `bias.ts` | 话题权重按 `(project, character)` 累积，影响检索优先级（`1 + min(0.5, weight×0.05)`）；是涌现偏好，不是显式设置 |
| **用户学习** | `userLearning.ts` | `user_observe` 观察用户表达方式与关注点，进 `user` 类记忆与画像 |
| **人物层** | `env.ts` + `PERSONAS_JSON` | 人设按 `CHAR_ID` 取 `name/persona`；注入块带"当前状态 + 用户画像 + 兴趣趋势"，并声明"与人设冲突时以人设为准" |
| **角色隔离** | `CHAR_ID` + `character_id` 列 / `project` 分库 | 见「角色隔离」 |

### 两段排序与锚点

第一段（候选与召回）是 `computeScore`：谁进候选、谁过门槛，由相似度和元数据决定。
第二段（在场顺序）是 `rankBySalience`：

```text
final = score × (0.9 + 0.2 × salience)            # salience ∈ [0,1]，锚点恒 1
```

- **为什么只有 ±10%**：显著度是"同样近时谁先"，不是新的主锚。早先版本把情绪 / tier / 访问次数当主乘数，实测让 6 个字的垃圾行在每个查询里排第一（score 4.3）；这次刻意把作用范围钉死在 0.9~1.1，相关性差一个档次时它翻不了盘。`SALIENCE_BLEND` 与 `salienceBlendFactor()` 都导出，测试直接断言这个上界。
- **强度取存储强度**（`computeBaseIntensity`），不是衰减后的 retrieval：新鲜度已由 ACT-R 的 activation 项表达，"这件事本身刻得多深"不该被同一根时间轴重复惩罚。
- **ACT-R 需要多次访问的时间戳**：`memory_access_log(memory_id, project, accessed_at, channel)` 由检索路径写，注入路径不写（注入不算回忆）；没有日志表时退回 `last_accessed_at`。
- **锚点**：`memory_update {id, pinned: true}` 钉住、`pinned: false` 取消。注入时锚点排在最前、不参与相似度门槛（`recallForInjection` 默认自动取 2 条，`maxAnchors` 可调），但仍受 `project` / `character_id` 隔离约束——钉住不等于跨角色泄漏。
- **难过的当下不翻旧账**：调用方把当前心情（`-10..+10`）传进 `memory_search` / `memory_recall` 时，中显著且与心情同调的记忆降为背景、不进注入块（`stats.moodSuppressed`），锚点不受影响。心情值现在优先取 psyche（有证据时）。
- **老库退化**：缺 `pinned` 列或日志表时，重排与锚点自动退化为"不重排、不注入锚点"，检索结果不会变成 0 条。

## 短期 psyche 状态机

状态不是记忆，是**可回放的短期动力学**。模型只提 appraisal 候选，代码负责剩下的全部：

```text
next = transition(previous, appraisal, now, options)
```

| 维度 | 取值 |
|---|---|
| 存储 | `psyche_state(project, character_id, version, has_evidence, baseline_*, vad_*, band, updated_at, processed_event_ids)`，主键 `(project, character_id)` |
| 基线 | `v=0.40 a=0.30 d=0.60`（人格基线不算互动证据，初始 `band=neutral`） |
| 衰减 | 相对基线指数回归，半衰期 `v=24h / a=4h / d=36h` |
| 增益 | `target` 0.55（有界误差步，不累加到轨道）/ `event` 0.35（有符号增量） |
| 滞回 | 进入 ±0.25，维持 ±0.10——边界来回抖不会每轮换标签 |
| 事件去重 | `processed_event_ids` 保留最近 128 个；重复 `eventId` 不改版本、不改 VAD |
| 证据有效期 | `PSYCHE_EVIDENCE_TTL_HOURS`（默认 72）：超过就当作没有证据，`band` 回基线 |
| 输入源 | 默认**不由 VAD 估计驱动**；`PSYCHE_FROM_VAD=on` 才把 VAD 写回接进状态机 |
| 并发 | `BEGIN IMMEDIATE` 内读—转移—写；跨进程只认库里的行 |
| 读路径 | 只做衰减、**不写库**（context_get/search/reply 一轮可能读多次）；`updated_at` 只在有事件时前进，旧时间戳不能回拨 |
| 失败 | 持久化失败时保留进程内状态继续服务并 `console.warn`；`requirePersistence` 时抛错，让调用方把队列项留在可重试状态 |

`unknown` / `invalid` / `abstain` / `no_event` 不新增证据、不消费事件 ID。真正的 `neutral` 才是已标注的近零事件：首个 neutral 会记版本，重复 neutral 不会把后来的正负状态重置。

`context_get` 同时返回 JSON 的 `psyche` 块和给人读的状态块（`unifiedStatePrompt`）：有传感器证据时，AgentState 那条独立 mood 行被省略，避免提示词里出现两个互相矛盾的 affect 值；能量 / 倾向 / 近期经历仍由 AgentState 提供。

> **提示词形态**：`agentState.toPromptString()` 的一行是 `互动状态：{band}（v= a= d=）`——即"类别词 + 三个裸数值"。实测这一形态有系统性代价：裸 band+数值在 deepseek 上 −0.072 可判定；改成**具体处境描写**相对等长中性 +0.100（单模型）。在第二个模型上补到 n=100 后归零（+0.018 不可判定），所以**没改成默认**。改法保留在实验记录里，等条件满足再动。

### VAD 队列的三态

| affect_status | 含义 | 会不会推进 psyche |
|---|---|---|
| `pending` / `pending_psyche` | 已入队；模型调用进行中（`pending_psyche` = VAD 已写、psyche 未落盘） | 否 |
| `analyzed` | VAD 写回 + psyche 持久化都成功 | 仅当 `PSYCHE_FROM_VAD=on` |
| `abstain` | 有分析但**无可靠 VAD**（格式错、越界、数量不匹配、低置信、或走了词表兜底） | 否，且不会被后来的重放改成 `analyzed` |

队列参数：`MAX_SIZE=15`、`MIN_BATCH=5`、`MAX_AGE=10min`、单条正文截断 2400 字符；按 durable memory id 去重，所以底层保存器和上层适配器重复入队不会分析两遍。flush 前重新校验来源、`is_active`、项目与角色：指针失效丢弃，数据库预检异常保留重试。

### VAD 通道现状

| 来源 | 位置 | 状态 |
|---|---|---|
| 仓内 Ollama | `emotion.ts` → `OLLAMA_URL/api/chat`，`VAD_MODEL` 默认 `qwen3.5:2b`，`temperature 0.1`、`num_predict 256`、超时 15s | 唯一在代码里的通道；不可用/低置信 → 词表兜底 → **只写 abstain** |
| NPU 传感器（仓外进程） | `D:\castalia\run\Castalia\scripts\psyche_npu.mjs`，HTTP `3352`，`POST /appraise` | 能跑，但**本仓没有调用它的代码**（见「已知缺口」） |

两条都必须走 `targetAppraisalFromVAD()` → `applyPsycheAppraisal()`，不能各写一套 mood。

## 自循环与日记

自循环是**独立的读取与生成过程**，不在回复路径上：

- 只查 `source=conversation_log`，加上当前 `psyche_state` 与 AgentState 的 energy/desire；不搜索 `agent_diary`。
- 首轮取时间窗口内最早一页；之后用持久游标 `(created_at, rowid)` 升序排空，积压超过 `limit` 分轮消化，停机超过 `hoursBack` 也不会跳过旧证据。
- `self_cycle_runs(project, character_id, evidence_key, watermark_*, diary_id, claimed_at)` 做 claim：`INSERT OR IGNORE` 抢锁、写完日记再 `complete`；claim 后崩溃，一小时后的运行可回收过期 claim；日记已落库但 claim 未完成的，下次运行按 `evidence_key` 直接补完，不会重复生成。
- 证据集用排序去重后的 id 拼成 `evidence_key`；不同 evidence 集合即使文案相同也按两条派生记录处理，避免错误去重；软删日记后 completed claim 仍是游标，不会把同一批对话再吃一遍。
- **定时器默认关**：`SELF_CYCLE_INTERVAL_MINUTES=0` 或未设置不启动，只有显式配正数才自动跑（最小粒度 1 分钟）；MCP 的 `self_cycle` 仍可按需跑一次（`limit` 6 / `hoursBack` 48 / `minIntervalHours` 6）。
- 单向结构：读证据 → 生成派生文本 → 一次写入。日记不改 psyche，也不触发下一次 self-cycle。

日记的写入契约（`saveSelfDiary`）：`memType=project`、`type=semantic`、`category=emotional`、`importance=0.45`、`source=agent_diary`、`subject=self`、`skipEmbed=true`，metadata 至少带 `generated_by=self_cycle`、`evidence_ids`（≤20）、`state_version`，以及 `evidence_key` / `evidence_watermark_*`。`saveMemory` 对 `source=agent_diary` 有硬校验：metadata 里没有 `generated_by=self_cycle` 直接抛错；`agent_state` 同理只能由 AgentState 写。

`forgetMemory` / `restoreMemory` 拒绝派生记录：日记与状态快照是 append-only，通用删除会让写入方的游标/状态和库不一致。

## 记忆体：隔离与来源

### 角色隔离

**角色 = 进程级 `CHAR_ID`**（一个实例一个角色），`project` 只是记忆库维度，不再由库名推导角色。

| 维度 | 含义 | 隔离方式 |
|---|---|---|
| `CHAR_ID` | 角色 / 实例 | `memory.character_id` / `facts.character_id` 列过滤 |
| `CASTALIA_PROJECT` / `project` 参数 | 记忆库 | `memory/<project>/<memType>/memory.sqlite` 物理分库 + `project` 列 |

- 多角色 = 多实例（各自 `CHAR_ID` + 各自库目录）；共用一个库目录时靠 `character_id` 列做全路径过滤（检索、索引、图谱、上下文包、统计、事实、反思、会话滚动快照、冷存）。
- 按 id 的操作有归属校验：`memory_get` / `memory_update` / `memory_delete` 遇到别的角色的 id 一律当不存在。
- 写入永不落 NULL；历史 NULL 行只在"该库仅一个非空角色"时自动补齐，多角色库不猜。
- 需要跨角色扫描的维护接口显式传 `characterId: "any"`。
- 回归：`node scripts/regression_role_isolation.mjs`

### 事实与实体的来源安全

- `facts` 不再假设跨 `memType` 的本地外键（事实在 `general`，源记忆可能在 `project`），额外保留 `source_memory_source` 与 `source_memory_mem_type`。
- `saveFacts` 对显式来源做**写入前硬校验**：来源必须存在、`is_active`、同 project、同 character；未知、失活、跨角色、跨项目、派生日记一律拒绝（`null` 仍是"无来源"的兼容模式）。
- 公开查询按 project / character / active / derived-source 四重过滤；`memory_entities` 是跨物理库的逻辑关系表，没有跨 SQLite 外键，允许悬挂 link，但查询不会把派生记录或别的角色泄漏出来。
- 老库里已存在、没有 `source_memory_source` 的跨 memType facts 无法仅凭 `general` 判断来源是否为旧日记——新写入已阻断，彻底清理需要离线回填。

## 打分与排序

第一段：候选与门槛（`computeScore`）。

```text
score = (1.00 × consistency + 0.12 × emotion + 0.03 × time_decay + 0.10 × deviation)
        × source × density × importance × bias × tier × access
```

| 项 | 取值 |
|---|---|
| `consistency` | `min(similarity, 0.95)`——上限 0.95（0.7 → 0.95 时金标 R@1 53.6% → 68.1%，10:0，p=1.95e-3） |
| `emotion` | VAD 三维衰减后的强度（无 VAD 回落 `abs(emotional_impact)/10`）。**已知方向为负**（AUC 0.419、ρ=−0.205），保留在 ≤20% 的有界分量里 |
| `time_decay` | `computeRecency(last_accessed_at ?? created_at)`——**回忆一次刷新时钟**；权重 0.15 → 0.03（金标 R@1 68.1% → 76.8%，6:0，p=0.031） |
| `deviation` | `similarity < 0.3` 且 `baseIntensity ≥ 0.7` 时 +0.8——"不像她的珍贵瞬间" |
| `source` | `reflect_summary` / `reflect_reasoning` ×0.85，其它 `reflect_*` ×0.93 |
| `density` | `clamp(len/24, 0.75, 1)`，6 字残片轻微降权 |
| `importance` | `0.85 + 0.3 × importance` → 0.85~1.15 |
| `bias` | `1 + min(0.5, topicWeight × 0.05)` |
| `tier` | `critical` ×1.10，`temporary` ×0.95 |
| `access` | `1 + min(0.08, log2(1 + accessedCount) × 0.02)` |

权重可用 `WEIGHT_CONSISTENCY` / `WEIGHT_EMOTION` / `WEIGHT_TIME` / `WEIGHT_DEVIATION` 覆盖。元数据只做**有界加成 / 弱乘数**：早先版本把情绪、tier、访问次数当主乘数，实测导致 6 字垃圾行在每个查询里排第一，且"被注入 → 访问数 +1 → 下次更容易被注入"形成正反馈——这就是注入路径不再计数的由来。

> **两个常量的证据边界**：0.95 与 0.03 都是在同一批 69 条金标查询上得到的，**这批查询参与了调参**，没有冻结验证集。换语料/换库时要重测，不能当普适最优。

检索档位：`quick` 3 / 0.6、`balanced` 5 / `SEARCH_MIN_SCORE`（默认 0.15）、`deep` 10 / 0.1。标签命中足够时直接返回，不进向量路。

## 记忆类目

两个正交维度：`type`（性质）与 `memType`（用途）。

```text
├ episodic       — 事件记忆
│ ├ conversation  — 有意义的对话片段
│ └ milestone     — 第一次 / 重要决定 [critical]
├ semantic       — 事实记忆
│ ├ identity      — 身份信息 [critical]
│ └ knowledge     — 知识事实
├ preference     — 用户偏好与习惯
└ entity         — 实体记忆（人物 / 地点 / 物品）
  └ relationship  — 关系记忆 [critical]
```

`memType` 是存储分区：`user`（对用户的画像）、`feedback`（行为纠正，正负都记）、`project`（**情感记忆分区**：情绪快照、情感事件、自循环日记）、`reference`（只存链接指针）、`general`（默认，**conversation_log 固定落这里**）。落盘布局：`memory/<project>/<memType>/memory.sqlite`。

## 实体层与双时态 facts

| 表 / 视图 | 作用 |
|---|---|
| `entities(id, key, name, kind, mention_count, first_seen, last_seen)` | `id = sha1(归一化键)`，跨进程 / 跨库稳定；`kind` 分 `role` / `topic` / `url` / `path` / `config` / `number` |
| `fact_entities(fact_id, entity_id, role)` | 事实 ↔ 实体（`role` = subject / object） |
| `memory_entities(memory_id, entity_id, role)` | 记忆 ↔ 实体 |
| `facts_current`（视图） | 当前有效事实的唯一口径（`is_active = 1` 且 `valid_to` 为空） |

- **写入即建联**：`saveFacts` 落库后立刻登记实体与两张关联表，不需要 LLM；老库打开时若"有 facts 但无实体关联"会自动回填（幂等、有上限）。
- **双时间轴**：`valid_from/valid_to` 是世界何时为真，`created_at/expired_at` 是我们当时相信什么。`fact_as_of(at, axis)` 可分别按两条轴问"那个时刻"。所有比较走 `julianday()`，不做字符串比较。
- **失效不删除**：`volatility.ts` 先按语义先验判，再用证据补（≥3 条记录、≥2 个不同 object、换值间隔中位数 ≥7 天才算慢变单值；3 天内快速翻转视为高易变，只并存），失效写 `valid_to + expired_at + superseded_by`。
- **工具**：`entity_lookup`、`facts_conflicts_report`、`memory_graph`、`facts_windows_plan` / `facts_windows_apply`。
- 路径、URL、配置和数字归为噪声类型，默认不画进知识图谱。

## 回忆与注入是两件事

- **注入不算回忆**：`recallForInjection` 一律 `countAccess: false`——否则就是上面那个正反馈。
- **锚点无条件在场**：`pinned=1` 的记忆不参与相似度门槛，注入块最前面就是它。
- **填充词直接不检索**：`isFillerQuery` 拦"没有实指"的 ≤8 字纯语气词（`嗯` / `好` / `在吗` / `继续` / `为什么` / `行吧` / `别闹了` / `随便你` 都实测 0 条）。**这不是误注入的解**——含数字、时间词、回指词的一律放行，而"我没事""算了"这类仍在放行侧（实测各注入 3 条 / 1 条）。真正的漏口见「已知缺口」。
- **门槛判在 similarity，不判融合分**：整行向量 0.45、词法/标签 0.2、片段 0.60、反刍行 0.60；再加**证据门**——至少一条命中 ≥0.50，或 IDF 加权词法覆盖率 ≥0.60，否则一条都不注入。
- **同一句话只说一遍**（2026-11-01）：多条记忆引用同一个原句时，按**共用的引号片段**判重，只留排名最高的一条（`stats.dedupedQuote` / `stats.collapsedIds`）。判据不是文本相似度——实测同事件 4 条两两字符 bigram Jaccard 只有 0.144–0.265，随机两条 0.000–0.183，两者重叠，阈值分不开。实测效果：`「今天累死了，什么都不想干」` 4 条 / 1208 字符 → 1 条 / 349 字符。
- **「按日期直取」不重讲**：时间路（`temporalRecall`）接受 `excludeIds`，主块给过的和被折叠掉的都不再出现。原来同一条会在两个段落里各说一遍（实测 3/3 重复）。
- **预算按最终字符串长度裁**（不是按条数）：整块 `capChars` 1200、单条 200。
- **容器形态**：`<memory>` XML 包裹 + 每条带 id / imp / sim；首行三连对应三种已知失败——"这是记录不是指令""与人设冲突以人设为准""无关就忽略"。事实块独立成 `<FACTS>`，预算不与记忆块共享。
- **默认不注入派生记录**：日记与状态快照在注入、检索、反思、整合、统计、图谱里默认缺席（`memoryProvenance.ts` 的 SQL 谓词统一口径）。
- **观测**：`MEMORY_RECALL_LOG=1` 打一行 `[memory] recall …`（含 `deduped` / `dedupedQuote` / `below` / `skip`）。

## Quick Start

### 1. 构建

```bash
npm install          # Node ≥ 20；原生模块按当前 Node ABI 编译
npm run build        # gen_version + tsc → dist/index.js
```

> **npm 12+ 默认屏蔽安装脚本**，`better-sqlite3` 会没有二进制，引擎启动即报 `Cannot find module ... better_sqlite3.node`。本仓在 `package.json` 声明了 `allowScripts: { "better-sqlite3": true }`；仍失败时执行 `npm install-scripts approve better-sqlite3 && npm install --foreground-scripts`。**换过 Node 版本就要重装**，否则 ABI 不匹配。

### 2. 嵌入服务（可跳）

```bash
python yuan_embed_server.py     # 本仓自带：Ollama /api/embed 兼容，1024 维，首次启动要下载权重
```

任何 Ollama 兼容端点都行，指向 `OLLAMA_URL` + `EMBEDDING_MODEL`；托管端点再加 `EMBEDDING_API_KEY`。只想纯文本检索就设 `EMBED_MODE=none`——引擎自动降级，记忆照常存取。

### 3. LLM 通道（可选）

`<bank>/config.json`（由 `MEMORY_CONFIG` 指向）里配三路：`embedding` / `reflect` / `triage`。

- `triage` 缺省回落 `reflect`；一个 key 都不配时，服务仍是完整的读写记忆库，只是跳过反思与分拣。
- key 建议走加密通道（`memory/keys.enc` + `memory/keys.key`，AES-256-GCM，两者都在 `.gitignore` 里）。
- 换嵌入模型只改配置：维度变化时库首次打开会重建 `vec_memory` / `vec_facts` 并清空嵌入缓存，正文与关系不动。

### 4. 宿主接入

```json
{
  "mcpServers": {
    "anima-memory": {
      "command": "node",
      "args": ["<repo>/dist/index.js"],
      "env": {
        "MEMORY_DB_DIR": "<repo>/memory",
        "CHAR_ID": "<role-id>",
        "EMBED_MODE": "none",
        "SELF_CYCLE_INTERVAL_MINUTES": "0"
      }
    }
  }
}
```

前端可直接把本引擎当持久层：`memory_store_list` / `memory_store_save` / `memory_store_forget` / `memory_recall`。只想暴露这几个工具就设 `MCP_TOOLS=store`：启动快，也不会顺带跑启动反思/整合。宿主侧的 Node 必须与原生模块 ABI 对齐（Electron 的 `process.execPath` 往往不行）。

### 5. 上线：整目录替换，不要逐文件覆盖

```bash
# 停宿主 → 备份旧 dist → 整目录替换 → 启动 smoke
node dist/index.js   # 起来后依次探 context_get / self_cycle / auto_process
```

新增的 `psycheState.js`、`selfCycle.js`、`selfCycleCursor.js`、`memoryProvenance.js` 都是新文件，逐文件覆盖一定会漏。

## 环境变量

共 **80** 个去重读取点，按用途分组（默认值以代码为准）：

| 组 | 变量 |
|---|---|
| 实例与库 | `CHAR_ID`、`CASTALIA_PROJECT`、`SHARED_PROJECT`、`MEMORY_DB_DIR`、`MEMORY_CONFIG`、`MEMORY_DB_PATH`（旧版单文件，已弃用）、`PERSONAS_JSON`、`CASTALIA_ASSISTANT_NAME` |
| 嵌入 | `EMBED_MODE`（`none` / `ollama` / `api`）、`OLLAMA_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIM`（默认 1024）、`EMBEDDING_API_KEY`、`EMBED_TIMEOUT_MS`、`VEC_DIM` |
| 打分权重 | `WEIGHT_CONSISTENCY` 1.00、`WEIGHT_EMOTION` 0.12、`WEIGHT_TIME` **0.03**、`WEIGHT_DEVIATION` 0.10、`SEARCH_MIN_SCORE` 0.15 |
| 情绪 / VAD | `VAD_MODEL`、`VAD_TIMEOUT_MS`（默认 15000）、`VAD_APPRAISAL_CHUNK`、`PSYCHE_FROM_VAD`（默认关）、`PSYCHE_EVIDENCE_TTL_HOURS`（默认 72）、`SKIP_WRITE_AFFECT=1` |
| 自循环 | `SELF_CYCLE_INTERVAL_MINUTES`（默认 `0` = 关；正数才自动跑，最小粒度 1 分钟） |
| 注入门槛 | `MEMORY_INJECT_MIN_SIM` 0.5、`MEMORY_INJECT_MIN_SIM_VECTOR` 0.45、`MEMORY_INJECT_MIN_SIM_LEXICAL` 0.2、`MEMORY_INJECT_MIN_SIM_CHUNK` 0.6、`MEMORY_INJECT_MIN_SIM_REFLECT` 0.6、`MEMORY_INJECT_STRONG` 0.5、`MEMORY_INJECT_STRONG_LEXICAL` 0.6、`MEMORY_INJECT_MARGIN`、`MEMORY_RECALL_LOG` |
| 会话缓冲 | `BUFFER_SIZE`、`BUFFER_TOKENS`、`SESSION_MEMORY_TTL_DAYS` |
| 反思 / 分拣 | `REFLECT_LLM_URL` / `REFLECT_LLM_MODEL` / `REFLECT_LLM_API_KEY`、`REFLECT_INTERVAL_HOURS`、`REFLECT_MIN_GAP_HOURS`、`REFLECT_MIN_UNANALYZED`、`REFLECT_DEEP_*`、`REFLECT_FACT_EXTRACTION`、`REFLECT_MAX_FACTS`、`REFLECT_PROMPT_FILE`、`REFLECT_LEDGER_FILE`、`REFLECT_RECEIPT_DIR`、`REFLECT_FAIL_BACKOFF_HOURS`、`REFLECT_DIR`、`TRIAGE_LLM_*` |
| 整合 / 冷存 | `CONSOLIDATE_*`、`COLD_AFTER_DAYS`、`COLD_MAX_IMPORTANCE`、`HEAT_PROMOTE_THRESHOLD` |
| 联邦 | `FEDERATION_MEMBERS`（JSON 数组）、`FEDERATION_DIRS`（旧版逗号分隔） |
| 服务 | `MCP_TOOLS`（`all` / `agent` / `harness` / `admin` / `store` / `entity` 或工具名）、`MCP_LOG_TOOLS`、`MCP_SERVER_NAME`、`MCP_SERVER_VERSION`、`HEALTH_PORT`、`CASTALIA_KEY_FILE` / `CASTALIA_KEYS_FILE` |

`MCP_TOOLS` 的分组就是注册表本身（`TOOL_GROUPS`）：`agent` 8 个只读工具，`harness` 14 个写入与管线工具（含 `self_cycle`），`admin` 18 个管理与跨库工具，`store` 4 个前端存储桥工具，`entity` 2 个实体层工具（`entity_lookup` 同属 `agent` 与 `entity`）——**46 次挂载 / 45 个去重**。本仓不设 `MCP_TOOLS` 时**全部注册**（宿主代理依赖 harness/admin 组），要最小暴露面得显式写 `MCP_TOOLS=agent`。

## 与 Castalia、Castalia-Full 的关系

| 仓库 | 定位 | 工具数 | 版本 |
|---|---|---|---|
| [Castalia](https://github.com/ehwin/Castalia) | 引擎核心，中立单实例 | 30 | 1.25.4（版本锚） |
| [Castalia-Full](https://github.com/ehwin/Castalia-Full) | 总线接口：跨库总反思 + 联邦检索 + 聚合星图；核心由 Lite 同步（`sync_core.py`），不独立演进 | 34 + 独立总线进程 | 与 Lite 对齐 |
| **Castalia-Anima（本仓）** | **情感变体**：核心 + 情绪层 + 人物层 + 实体层 + psyche 状态机 + 自循环 | **45** | **1.28.8（自带引擎线）** |

- **Anima 不依赖另两个仓**，运行时也不读写它们的库。它自带一条引擎线与自己的版本号，情感特性向上游反哺；Lite 只保证中立核心稳定。
- `memory_search` 只返回本实例的记录。宿主若想同时看到本仓与 Full 的聚合结果，在宿主侧各接一个 MCP 服务、由宿主合并，而不是在 Anima 里加跨仓依赖。Full 读源库、不回写。
- 本仓另带一条**轻量联邦**（`src/federation/`）：`FEDERATION_MEMBERS` 声明成员（同机目录 `local-dir` 或远端 MCP `mcp-http`），`memory_search_all` 跨成员只读检索、`federation_members` 列成员能力与规模；`npm run fed-server` 起独立总线（`dist/fedServer.js`）。不可达成员进 `errors[]`，不会让整次查询失败。

## SillyTavern 接入

适配器在 [integrations/sillytavern](integrations/sillytavern/README.md)：酒馆扩展（输入框左侧开关 + 设置面板）+ 服务端插件（MCP 客户端），前后端分离。

1. 先 `npm run build`；2. `./integrations/sillytavern/install.ps1 -TavernRoot '<SillyTavern 目录>'`；3. 酒馆 `config.yaml` 开 `enableServerPlugins: true` 并重启；4. 扩展面板"检查连接"，再点输入框左侧的记忆按钮开启当前聊天。

- **项目即隔离**：`project = st_ + SHA1([用户, 聊天身份])`（单聊含角色卡文件名，群聊含组 ID），用户身份取自服务端 `req.user.profile.handle`。
- **按消息稳定 ID 事务同步**：编辑 / 续写 / 切换 swipe 替换旧版，删除停用原记录并移除旧向量；空快照直接拒绝，窗口化子集必须显式 `replace: true` 才允许收缩。
- **生成前** await 同步与检索，按 tokenizer 的 token 预算注入；静默生成 / 代写用户跳过；最近四条消息从召回里排除。
- **不跑情绪 / 画像 / 反思管线**，也不注入引擎的编程指令种子。
- 默认 `embedMode: "none"`；单次同步上限 5000 条消息。
- 测试：`node --test integrations/sillytavern/tests/*.test.mjs`

## 维护、回归与本次复核

`scripts/memory_maintenance.mjs` 是给菜单 / 计划任务用的单一入口，最后一行固定 `RESULT: …`：

```bash
node scripts/memory_maintenance.mjs health          [bank] [project]   # 库健康：行数、待嵌、孤儿
node scripts/memory_maintenance.mjs probe-embed     [bank] [project]   # 嵌入端点连通与维度
node scripts/memory_maintenance.mjs rebuild-chunks  [bank] [project]   # 重建片段索引
node scripts/memory_maintenance.mjs repair          [bank] [project]   # 只重建派生索引（向量/片段/缓存）
node scripts/memory_maintenance.mjs eval            [bank] [project]   # 小样本检索自测
```

| 类别 | 数量 | 例子 |
|---|---|---|
| `regression_*.mjs` | 23 | `role_isolation`、`entities`、`facts_provenance`、`facts_migration`、`diary_isolation`、`raw_conversation_immutable`、`self_cycle_process`、`psyche_parse`、`emotion_failure`、`emotion_status_source`、`duplicate_enqueue`、`restart_recovery`、`anima_audit`、`memory_injection`、`store_bridge`、`loop_closure` |
| `test_*.mjs` | 17 | `psyche_state`（状态机数学）、`self_cycle_cursor`（游标序）、`emotional_ranking`、`emotion_wiring`、`affect_lexicon`、**`filler_query`**、**`injection_dedup`**（同一句话只注入一次） |
| `audit_*.mjs` | 3 | `scale`（只读盘点所有 bank 并给结论）、`orphans`、`vector_space` |
| `bench_*.mjs` + `eval_*.mjs` | 8 | `reflect_quality`、`insight_gates`、`insight_semantics`、`anima_idf`、`anima_redundancy`、`injection` |

回归脚本贴着实现写断言（不是抽样）。**动 psyche / VAD / 日记 / 事实来源 / 原料行软删路径时**至少跑：`test_psyche_state`、`regression_psyche_parse`、`test_self_cycle_cursor`、`regression_self_cycle_process`、`regression_diary_isolation`、`regression_raw_conversation_immutable`、`regression_emotion_failure`、`regression_emotion_status_source`、`regression_duplicate_enqueue`、`regression_restart_recovery`、`regression_facts_provenance`、`regression_entities`、`regression_anima_audit`。**动注入路径时**跑 `regression_memory_injection`、`test_injection_enrich`、`test_filler_query`、`test_injection_dedup`。

### 2026-11-01 实跑记录

```text
npx tsc -p tsconfig.build.json          → 0 error
test_injection_dedup                    → 14 / 0（新增）
test_filler_query                       → 52 / 0
regression_memory_injection             → 44 checks, ok, liveLlmCalls=0, liveEmbedCalls=0, productionWrites=0
test_injection_enrich                   → 13 / 0
regression_anima_audit                  → 51 checks, ok, productionWrites=0
regression_loop_closure                 → 11 checks, ok
test_reflect_ledger_anima               → 19 / 0
test_derived_evidence                   → PASS
regression_raw_conversation_immutable   → 27 checks PASS
regression_emotion_failure              → 14 / 0
```

整合链在库副本上的复现（真模型，一次调用）：

```text
修前：scanned 67 candidates 8 merged 0  → 全部 merge 失败 "raw-material"（候选是 daily_event）
修后：scanned 67 candidates 0 merged 13 applied 13 errors 0 → ok
库副本变化：general 活跃 225 → 136、project 30 → 19（合并结果落库后软删源，内容可回查）
```

注入去重在真实库副本（airi/general，268 活跃行）上的实测：

```text
查询「今天累死了，什么都不想干」
  改前 count=4 chars=1208 temporal=3   （同事件 3 条 daily_event + 1 条 reflect_extract，且时间路再复读一遍）
  改后 count=1 chars=349  temporal=0   dedupedQuote=4
未受影响的查询（回归）：「我没事」3 条 /「算了」1 条 /「你今天怎么了」5 条 /「像素小人」5 条
```

全部使用临时库或库副本，`productionWrites=0` / `liveLlmCalls=0`，不启动常驻服务。

### 部署状态（别把构建当上线）

仓库 `dist/` 与运行时 `D:\castalia\run\Castalia-Anima\dist` 在 2026-11-01 重新编译对齐（`npx tsc -p tsconfig.build.json`）。两份都应是同一份源码的产物；差异只应出现在"源码改了但没重建"时。

上线仍然要停宿主、整目录替换、校验 hash、启动后 smoke `context_get` / `self_cycle` / `auto_process`，并保留旧 dist 回滚。**改完 dist 必须重启常驻桥进程**：已建立的 MCP 桥不会热加载新代码，重启前它们是旧行为。

> **宿主内嵌镜像**：有的宿主把引擎源码 copy 进自己的仓（`vendor/engine/`）并在进程内跑，不 spawn 本仓 `dist`。那种场景下**改这里不会自动生效**，要跑宿主的 `sync-engine` 再重建。这是本仓被踩过最多次的一个坑。

## 已知缺口（写在这里，避免被当成已完成）

- **情感层没有可用传感器**：词表已降级为 abstain（κ=0.015），Ollama 通道要求本机跑 `11434`，NPU 传感器（3352）没有仓内消费者。**当前默认是"不产生情感证据"**，不是"情感层在工作"。
- **VAD 数值不传导**：类别词 / 数值 / 端点的拆解显示数值无独立作用、arousal 完全不传导。任何"精确 VAD 数值"的工程在没有新证据前都不该开工。
- **注入的漏口仍在开放侧**：填充词门只覆盖 ≤8 字纯语气词。"我没事""算了""随便你"这类**无实指但不是语气词**的短句仍会注入（实测 3 / 1 / 0 条）。这类是开放集，加词表解决不了；正确方向是查询侧"有没有实指"的判据，不是继续抬阈值。
- **同一事件仍可能多渠道并存**：按引号片段判重只能处理"引用了同一原句"的情况；同一件事被抽成措辞完全不同、又不带引号的多条记忆时，仍会各占一条预算。
- **反思产出仍多于原料**：清理探针残留后某真实库活跃 207 行里 `reflect_*` **86** 行、`conversation_log` **43** 行、`daily_event` 7 行（**2.0×**，残留清掉后比例反而更差，因为删的全是原料）。合并链此前**每轮都失败**：整合窗口只排除了 `agent_diary`/`agent_state`，而 `applyReflectActions` 拒绝动全部原料行，于是模型对 `daily_event` 提的每一条合成都返回 `raw-material`、`merged` 恒 0（2026-11-01 已修：窗口改用 `excludeRawMaterialSql()`，副本上 13 条合并成功）。仍有一条**未修**：LLM 偶发给出不在输入集里的 id，整批因此 `ok=false`（已把越界 id 写进错误串，便于定位）。
- **`/appraise` 没有 Anima 侧消费者**：NPU 传感器（3352）能跑，但仓内没有代码调用它。
- **样本量不足**：36 条探针拟合不了阈值、衰减半衰期、API 路由或 conformal 错误率。正式校准要按用户 / 会话分组、按时间留出，防止同一对话与同义改写泄漏。
- **情感衰减仍按 `created_at` 算**（`search.ts` 的 `hoursSinceCreated`）：高唤醒记忆 3 天后情感维度归零，而时间项已改按 `last_accessed_at` 刷新，两者不一致。
- **idle unload 未做真实环境 smoke**：传感器卸模型的路径目前只有语法与回归验证，没在部署环境实测。
- **老 facts 的来源无法回填判断**：没有 `source_memory_source` 的历史行只能离线扫描各 memType 后补。

## 规模与选型结论

`node scripts/audit_scale.mjs` 只读盘点所有 bank（复制到临时目录再统计，不碰线上库），输出行数与延迟并直接给结论。**换嵌入式图 / 时序引擎的阈值**（超过任一条再评估）：单库 `edges` > 200,000 或 `facts` > 500,000；2 跳遍历 > 20ms，或需要 3 跳以上的变长路径；需要社区发现 / PageRank 这类真图算法。在此之前递归 CTE + 规范化实体表就够。向量侧：超过 5 万条且暴力 KNN > 50ms 时先上量化 / 分区，而不是先换引擎。

反思质量有独立的确定性口径（[docs/reflection-quality.md](docs/reflection-quality.md)，`src/insightQuality.ts` 接在 `src/reflectAll.ts` 的写入路径）：洞察必须带逐字可查的 `evidence`；新颖度 < 0.3 且没有"新增成分"判复述；3-gram Jaccard ≥ 0.7 或包含度 ≥ 0.8 判近重复，只给已有那条累加 `reference_count`；重要度改由验证器算（`0.5 来源 + 0.2 跨源 + 0.3 新颖度`）。回测历史 1,532 条写入，约 43% 会被这四道闸拦住——反思的主要失败模式是"复述"，不是"编造"。

## Credits & Upstream

- [Castalia](https://github.com/ehwin/Castalia) — 中立单实例引擎核心
- [Castalia-Full](https://github.com/ehwin/Castalia-Full) — 总线 / 总反思 / 联邦检索
- **cognitive-memory**（Apache-2.0）— schema 与向量 KNN 概念（代码大量重写）
- **Claude Code**（Anthropic）— 封闭记忆类型、MEMORY.md 索引、渐进式会话维护模式（在 SQLite 上重新实现）
- 情感记忆路线的方法来源（MemoryBank、Affective Field Theory、ACT-R 基础激活、Bjork 新失用理论、Memobase、Character.AI Story Memory 等）逐条列在 [docs/emotional-memory.md](docs/emotional-memory.md)
- License: MIT，见 [LICENSE](LICENSE)
