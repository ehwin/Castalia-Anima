# 情感链路（本构建的实际代码路径）

本文只写**现在这份代码真正在做什么**，不写设计意图。每条都标了实现位置，
参数标了默认值和可覆盖的环境变量。

## 1. 全景

```text
【写入】对话落库
  conversation_log (source='conversation_log', is_active=1, affect_status='pending')
        │  queueForVad()                               src/emotion.ts
        ▼
  VAD 队列（进程内存，按 project|character 分组，上限 15 条，满则丢弃最旧并告警）
        │  flushVadQueue(project)                       src/emotion.ts
        │  ── 按 VAD_APPRAISAL_CHUNK=3 切块 ──
        ▼
  感知（二选一）
   ├─ 模型：Ollama / 兼容接口，单次 VAD + tsundere_level
   └─ 兜底：本地情感词表 scoreAffect()              src/affectLexicon.ts
        │
        ▼
  memory 行写 vad_valence / vad_arousal / vad_dominance + emotional_impact
  affect_status: pending ──► analyzed   （模型路直接写 analyzed；词表路写 pending 再由
                                          markAffectAnalyzed 提交；无证据写 abstain）
        │
        ▼
【读取】检索打分                                   src/search.ts
  score = WEIGHT_CONSISTENCY*相似度 + WEIGHT_EMOTION*情感强度 + WEIGHT_TIME*时间项
        + 偏离加成(低相似 + 高情绪) × bias × importance × tier × 访问强化
        ▼
  recallForInjection：相似度闸(默认 0.5) → 显著性重排 → 字符预算裁剪 → 注入块
```

**没有 psyche 状态转移，也没有 agent 心境变量**：`emotional_impact`/`vad_*` 是**每条记忆的属性**，
不是服务器的当前情绪。因此「心情 → 情绪一致性重排」这条依赖外部 `mood` 入参的可选能力虽然还在
（`searchMemory({mood})` / `recallForInjection({mood})`），但本构建没有任何东西会去填它；
不传即按中性处理。

## 2. 默认参数

| 参数 | 默认 | 位置 / 覆盖 |
|---|---|---|
| VAD 队列上限 | 15 | `emotion.ts` `VAD_QUEUE_MAX_SIZE` |
| 切块大小 | 3 | env `VAD_APPRAISAL_CHUNK` |
| 词表置信度下限 | ≤ 0.35 时走词表兜底 | `emotion.ts` |
| 衰减常数 τ（小时） | valence 24 / arousal 4 / dominance 36 | `DECAY_TAU` |
| 夜间倍率 / 傲娇减速 | 关闭 | env `ANIMA_NIGHT_DECAY=1` / `ANIMA_TSUNDERE_DECAY=1` |
| 打分权重 | 一致性 1.00 / 情感 0.12 / 时间 0.03 / 偏离 0.10 | env `WEIGHT_*` |
| 注入相似度闸 | 0.5 | `MEMORY_INJECT_MIN_SIM` / 调用参数 |
| 高情绪阈值 | baseIntensity ≥ 0.7 | `search.ts` `isHighEmotion` |

时间项与情感项的作用是「**同样相关时**偏好哪一段」，不是主锚 —— 历史上把情感当主锚
（0.45 vs 相似度 0.30）曾让短垃圾行霸榜，已配平。

## 3. 不造情绪的规则

- 词表没有命中任何情感词 → `confidence = 0` → 写 `affect_status='abstain'`，**不写** VAD。
- 模型失败（不可达 / 置信度低）→ 只影响 VAD，不改 category/importance/tags 之外的东西；
  失败批次会回队列重试，不会静默丢证据。
- 同一段对话重复写入：精确重复只加 `reference_count`，不重新入队。

## 4. 与「带情感状态机」版本的差异

| 环节 | 完整版 | 本构建 |
|---|---|---|
| VAD 分析结果落到哪 | 记忆列 + `psyche_state`（状态转移） | 只落记忆列 |
| 心境来源 | `psyche_state`（传感器证据）或 agent state 显式 mood | 无 |
| 注入时的「难过不翻旧账」 | 由当前心境抑制负向记忆 | 不支持（没有当前心境） |
| 反思输入 | 记忆 + 状态 + 日记 | 只有记忆 |
| 总反思（跨库） | 内置 MCP 工具 `reflect_all` | 外部插件 `dist/plugins/fullPipeline/cli.js` |

检查点：本构建的库里不会出现 `psyche_state` / `psyche_events` 表；`affect_status` 只会有
`pending` / `analyzed` / `abstain` 三个值（不再有 `pending_psyche`）。
