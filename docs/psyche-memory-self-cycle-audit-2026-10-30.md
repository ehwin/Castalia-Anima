# Psyche、记忆体与自循环审计

日期：2026-10-31（收尾复核）

这次复核覆盖：对话保存、VAD 队列、情感分析、短期 psyche、AgentState、检索注入、自循环、日记写入、普通记忆检索、反思和整合。

## 结论

记忆体和自循环应当分开。记忆体保存证据和可检索内容；自循环读取对话证据与短期状态，生成带 provenance 的日记，再把日记作为派生记录写回记忆体。日记不能成为用户事实、情感证据、普通召回结果或下一次自循环的输入。

状态机应保留，但只能做确定性动力学层。模型只能提出 interaction appraisal 或 VAD target，不能直接写 mood。状态机负责 baseline、衰减、bounded target update、clamp、hysteresis、event-id 去重和持久化。`unknown`、`invalid`、`abstain`、`no_event` 不应被当成 neutral；neutral 只代表有证据但接近零的观察。

## 链路

```text
对话回合
  -> conversation_log (general, affect_status=pending)
  -> VAD queue (project + character + memory id)
  -> Ollama / 本地词表兜底
  -> memory VAD 回写 (analyzed/abstain)
  -> psyche_state (短期、非 memory)
  -> currentMood/context_get/retrieval rerank
  -> reply

conversation_log + psyche_state
  -> self_cycle
  -> agent_diary (derived, evidence_ids, state_version, no embed, no VAD)

ordinary memory/search/recall/reflect/consolidate
  - 默认排除 agent_diary
```

## 记忆与情感边界

- `conversation_log` 是原始证据，固定存于 `general` 库。所有入口都写 `pending/vad_queue`，避免 `saveMemory()` 的词典快捷路径绕过状态机。
- VAD 分析成功后写 `analyzed` 和 `affect_source`；模型没有可靠 VAD 时写 `abstain`，这和尚未分析的 `pending` 分开。
- 混合分类批次中，缺少可靠 VAD 的单行始终写 `abstain`，不会因为批次延迟 finalize 而被误标为 `analyzed`，也不会推动 psyche 状态。
- 日记通过 `saveSelfDiary()` 写入 `project` 库，`source=agent_diary`、`subject=self`、`generated_by=self_cycle`，不 embed，不调用 affect lexicon，不进入 VAD 队列。
- `searchMemory`、向量/词法检索、pinned anchors、recent memory、事实注入、反思、整合、统计默认排除日记。只有显式 `includeDiary=true` 才可查看。
- 反思动作对日记 ID 也拒绝解析；对话流水、事件层、状态快照同样不能被 merge/split/delete 破坏。

## 自循环规则

自循环只查询 `source=conversation_log`，加上当前 `psyche_state` 和 AgentState 的能量/倾向。每篇日记记录 `evidence_ids` 和 `state_version`。运行间隔和证据高水位由代码控制；历次日记的证据 ID 会合并，避免同一对话被重复写入日记。首轮在最近时间窗口内按最早一页读取，后续周期使用 `(created_at,rowid)` 的持久游标按升序排空，不能因为一轮新增超过 `limit` 或停机超过 `hoursBack` 而跳过旧证据；游标建立后不再用 `hoursBack` 截断积压。日记文本中的对话摘录是派生观察，不是用户事实，且不会反向触发情感分析或自循环。

## 状态机审查

`psyche_state` 与 AgentState 的显式 mood 是两个来源。psyche 有真实分析证据时，context 和检索只使用 psyche 的 valence/band；没有证据时才回退到 AgentState 的 `moodValue`。人格 baseline 不算互动证据，初始可见 band 为 neutral。

状态更新使用相对 baseline 的指数衰减。模型的绝对 VAD 采用 bounded error step，不会因为重复批次持续累加到边界；本地词表的结果作为 event impact。事件 ID 防止重试重复推进；neutral 首次事件也会记录版本和 ID，重复 neutral 不会把后来 positive/negative 状态重置。旧时间戳不能回拨 `updatedAt`。

这符合 PAD/VAD 连续空间和 appraisal 理论的工程分工：模型估计“这轮互动意味着什么”，代码维护连续状态、时间衰减与不确定性。心理学上，短时情绪和人格基线不应混成一个永久记忆；反思/日记更接近 Generative Agents 的 reflection artifact，而不是新事件。

## 小模型工程判断

已有报告的留出集显示：0.8B/2B 方向准确率约 0.60，API 为 0.90；0.8B 的判据偏向报冷，2B 则偏向不报冷。换模型买到的主要是校准和稳定性，不是一个可以替代状态机的连续动力学。显式注入“当前状态事实”比塞原始历史更能改变判断，因此状态必须以结构化、明确受其影响的事实传入。

工程上保留短提示、严格解析、低温、模型失败可重试；不要在 sub-1B 上依赖 CoT 或把 certainty 当闸门。边界样本再升级到更大模型/API，并保留调用延迟、成本和隐私的指标。

## 逐段复核结果

### 对话与 VAD

- `saveConversationTurn()` 把原始回合固定写入 `general` 的 `conversation_log`，并设置 `affect_status=pending`、`affect_source=vad_queue`。
- 队列项带 `project`、`characterId`、`memoryId`；按 durable memory id 去重，底层保存器和上层适配器重复入队不会重复分析。
- flush 前重新验证来源、active、项目和角色。失效指针丢弃；数据库预检异常保留重试，不会误删队列。
- 本地词表、Ollama、API 失败都走可重试路径；批次中途失败会把当前及后续项回队。只有 VAD 写回和 psyche 持久化都成功才完成状态推进。
- malformed、数量不匹配、越界 VAD 不会伪造成功，也不会被写成 neutral。

### 短期 psyche 状态机

`psyche_state` 是短期状态表，不是记忆。它保存版本、证据标记、VAD、band、更新时间和已处理事件 ID。

- `unknown`、`invalid`、`abstain`、`no_event` 不推进状态，也不消费事件 ID。
- `neutral` 只在传感器明确给出有证据的中性观察时成立，不会覆盖已有正负状态。
- 更新使用 baseline 回归、时间衰减、bounded target step、clamp 和 band hysteresis；重复 event id 幂等，旧时间戳不能回拨 `updatedAt`。
- 有真实 psyche 证据时，context 和检索使用 psyche；无证据时才回退到 AgentState mood。

状态机应保留。它负责连续状态的动力学、衰减、去重和故障恢复，模型只负责 appraisal/VAD 观测。删掉状态机并把每轮模型输出直接当 mood，会重新引入小模型偏差、重复累加和重试漂移。

### self-cycle 与日记

- self-cycle 只读取 `conversation_log` 与当前 psyche/AgentState，不搜索 `agent_diary`。
- 首轮取时间窗口内最早的一页；后续使用 `(created_at,rowid)` durable cursor，积压超过 `limit` 时分轮排空，长时间停机不会跳过旧证据。
- `self_cycle_runs` 对 project、character、evidence key 做 claim/complete/recovery；并发调用 single-flight，进程崩溃后可修复 claim 与日记只写一半的两种状态。
- `saveSelfDiary()` 写入 `agent_diary`，附带 `evidence_ids`、`evidence_key`、`state_version` 和 watermark；日记不向量化、不入 VAD、不触发普通记忆去重和情感词典。
- 日记软删除后 completed claim 仍保留游标，不会再次消费同一批对话。

### 普通记忆、事实和实体

普通搜索、跨库搜索、recent/pinned、recall injection、context、stats、mood journal、memory list/get、reflect/reflectAll/reflectDriver、consolidate、volatility、userLearning、chunkIndex、embedding，以及实体图和事实图默认过滤 `agent_diary` 与 `agent_state`。`includeDiary=true` 只用于明确诊断查看。

facts 增加 `source_memory_source`、`source_memory_mem_type`，并移除不适用于跨物理 memType 的本地外键。`saveFacts()` 对显式来源执行硬校验：来源必须存在、active、属于同一 project 和 character；未知、失活、跨角色、跨项目及派生日记来源全部拒绝，`null` 仍表示无来源的兼容模式。

实体层使用 `entities`、`fact_entities`、`memory_entities`。事实落库时登记 subject/object；跨 memType 查询显式遍历候选库，再按 project、character、active 和 derived source 二次过滤。路径、URL、配置和数字归为噪声类型，默认不画进知识图谱。

## 本轮新增修复

收尾修复位于 `src/store.ts` 的 `saveFacts()`：来源查找从 best-effort 改为写入前硬拒绝，并统一使用规范化的 project/character。新增 `scripts/regression_facts_provenance.mjs`，实体回归增加未知来源和跨角色来源断言。未覆盖生产副本 `D:\\castalia\\run\\Castalia-Anima\\dist`。

### 2026-10-31 复核后修复：band 相对基线与证据有效期

复核发现两处会让状态机持续出错的实现偏差，已修并补断言（`src/psycheState.ts`、`src/db.ts`、`scripts/test_psyche_state.mjs`）：

1. **band 判定从绝对阈值改为相对人格基线**。基线 valence 是 `+0.40`，而进入阈值是 `±0.25`：衰减永远收敛到基线，于是"任何一次事件之后 band 必然 positive"，负向事件静默约 10 天后会翻成 `positive`（实跑：`-0.315 → 静默 240h → v=0.399 → positive`）。现在 `rel = valence - baseline.valence`，进入 `±0.25`、维持 `±0.10`，负向衰减落回 `neutral`。
2. **`hasEvidence` 有了有效期**。原先一旦观测到证据就永不复位，AgentState 的 `moodValue` 会被永久遮蔽。新增 `psyche_state.last_evidence_at`（`-1` = 从未观测，`0` 是合法时间戳）与 `DEFAULT_EVIDENCE_TTL_HOURS = 72`（3×valence 半衰期），过期后 `hasEvidence=false`、band 回 `neutral`，mood 回退到 AgentState。TTL 可用 `transitionPsycheState(..., { evidenceTtlHours })` 覆盖。
3. 测试补齐 3 条：衰减后基线必须是 `neutral`、负向事件不能衰减成 `positive`、TTL 过期交还 band。hysteresis 用例改为相对基线表述（原用例把绝对 0.14 当"仍在正区"，在新语义下它低于基线 0.26，属负区）。

未改的部分：批次粒度（一次 flush 最多 15 条只推进一次 psyche）、`self_cycle` 的模板化输出、日记没有自动读取方——这三条属于设计取舍，见 `psyche-full-chain-upgrade-report-2026-10-31.md` §7。

## 验证

已通过：

```text
tsc -p tsconfig.build.json --pretty false --noEmit
tsc -p tsconfig.build.json
scripts/test_psyche_state.mjs
scripts/regression_psyche_parse.mjs
scripts/test_self_cycle_cursor.mjs
scripts/regression_emotion_status_source.mjs
scripts/regression_diary_isolation.mjs
scripts/regression_emotion_failure.mjs
scripts/regression_anima_audit.mjs
scripts/regression_self_cycle_process.mjs
scripts/regression_duplicate_enqueue.mjs
scripts/regression_facts_migration.mjs
scripts/regression_facts_provenance.mjs
scripts/regression_entities.mjs
scripts/regression_restart_recovery.mjs
```

最终收尾实跑结果：`pnpm run build` 通过；psyche 状态/解析通过；self-cycle cursor/process/restart/duplicate enqueue 通过；日记隔离通过；`regression_emotion_failure.mjs` 为 13/13；`regression_anima_audit.mjs` 为 51 checks，且 `productionWrites=0`、`liveLlmCalls=0`、`embedCalls=0`；facts migration 为 8 checks；facts provenance 为 10 checks；entities 为 48 passed、0 failed，覆盖跨 memType、未知来源、跨角色来源、实体图和老库回填。所有回归使用临时数据库，未启动常驻服务。

## 部署状态与剩余风险

源码 `dist` 已构建。`D:\castalia\run\Castalia-Anima\dist` 仍可能是旧副本，不能把它当成已部署；当前 SillyTavern 进程核到的是源码工作区 `D:\AI\castalia\Castalia-Anima\dist\index.js`。生产副本应停宿主后整体替换 dist、校验 hash、启动并 smoke `context_get`、`self_cycle`、`auto_process`，保留旧 dist 回滚。不要逐文件增量覆盖，因为新增的 `psycheState.js` 与 `selfCycle.js` 会漏掉。

剩余风险是：

1. VAD 仍受本地词表和小模型系统偏差影响。应建立独立 calibration set 估计 bias、阈值和 abstain 区间；neutral 继续由高精度确定性条件产生，不要让 0.8B 为填字段强猜。
2. 旧库中已经存在、但没有 `source_memory_source` 的跨 memType facts，无法仅凭 general 库判断其来源是否为旧日记。新写入路径已阻断此问题；彻底清理需要离线扫描各 memType 回填 provenance。
3. `memory_entities` 是跨物理库的逻辑关系表，没有跨 SQLite 外键。公开查询已做 ownership/active/derived 过滤，但维护脚本仍可定期清理 dangling link。
4. 生产部署仍需停宿主后整体替换 dist、校验 hash、启动并 smoke `context_get`、`self_cycle`、`auto_process`；当前源码构建不等于已部署。
