# 情感链路与情感公式（v1.28.8，2026-10-31）

本文是代码事实的抄录，不是设计意图。每条公式后面标了 `文件:行`，参数标了默认值和覆盖用的 env。
凡是"设计说 A、代码是 B"的地方，第 6 节单列。

---

## 1. 全景：三条链路，一个写入方向

```
【写入】对话落库
  conversation_log (source='conversation_log', is_active=1)
        │  queueForVad()                          emotion.ts:601
        ▼
  VAD 队列（内存，按 project|character 分组）        emotion.ts:498
        │  flushVadQueue(project)                  emotion.ts:828
        │  ── 按 VAD_APPRAISAL_CHUNK=3 切块 ──
        ▼
  感知（二选一）
   ├─ Ollama: SINGLE VAD + tsundere_level          emotion.ts:236 / ollama.ts
   └─ 词表兜底: scoreAffect()                       affectLexicon.ts:56
        │
        ├─► memory 行写 vad_valence/arousal/dominance + affect_status
        │     pending → pending_psyche → analyzed | abstain   emotion.ts:709
        │
        └─► psyche_state 状态转移（纯函数 + BEGIN IMMEDIATE）
              transitionPsycheState()               psycheState.ts:178
              + psyche_events 追加（历史）           psycheState.ts:457

【读取】两条消费者
  context_get / currentMood()  ──► 注入 prompt 的「情绪指数 + 传感器状态」
  search.computeScore()        ──► 检索重排（情感强度 0.12）

【派生】self_cycle（只读 conversation_log + psyche_state）
  → agent_diary（source='agent_diary'）
  → 默认所有查询排除；唯一读取口：context_get { includeDiary: true }
```

---

## 2. 感知层

### 2.1 模型路径

`emotion.ts:905-907` 的批 prompt 要求：给**一个** SINGLE VAD + `tsundere_level`，没有可靠情感证据时省略 VAD。

- 置信度门槛：`result.confidence <= 0.35` → 判定模型不可用，走词表兜底（`emotion.ts:923`）
- 通过后平滑（**内存态，不落盘**）：`emotion.ts:964-970`

$$x_{\text{sm}} \leftarrow x_{\text{sm}} + \alpha\,(x_{\text{model}} - x_{\text{sm}}), \quad \alpha = 0.3$$

### 2.2 词表兜底（`affectLexicon.ts:56`）

命中计数 $n$ = 词命中次数（同词多次命中累加）；每个命中词有固定三元组 $(l_v, l_a, l_d)$（约 40 词，按强度分档）。

$$v = \mathrm{clamp}\!\left(\frac{\sum_i s_i\, l_{v,i}\, m_i}{\max(1,n)},\ -1,\ 1\right),\quad
d = \mathrm{clamp}\!\left(\frac{\sum_i s_i\, l_{d,i}\, m_i}{\max(1,n)},\ -1,\ 1\right)$$

$$a = \mathrm{clamp}\!\left(\frac{\sum_i l_{a,i}\, m_i}{\max(1,n)} + 0.08\min(3,\#!) - 0.1\cdot\mathbb{1}[\text{省略号}],\ 0,\ 1\right)$$

其中：
- $m_i$ = 程度副词放大系数，取**前 2 字符窗口**内最大值：太 1.5 / 很 1.35 / 超级 1.6 / 特别 1.4 / 真的 1.3 / 非常 1.5 / 最 1.6 / 好 1.2
- $s_i$ = 否定符号：前一字符 ∈ {不, 没, 别, 无, 非} 时 $-1$（只作用于 $v, d$，**不作用 $a$**）
- 置信度：$c = \min(0.75,\ 0.25 + 0.15n)$
- 无任何命中时：$v=d=0$，$a=\min(0.6, 0.2\#!)$，$c = 0.2$（有感叹号）或 $0$（无）

派生字段：

$$\text{intensity} = \frac{|v|+|a|+|d|}{3},\qquad
\text{emotional\_impact} = \mathrm{round}(\min(10,\ 10\,\text{intensity}),\ 1\ \text{位})$$

### 2.3 批内汇总（词表路径）

`summarizeLocalAffect` 对置信度 > 0 的条目取**算术平均**（不是累加，防止一条长消息推多次）。

---

## 3. 状态转移：`psyche_state`

`psycheState.ts:178` `transitionPsycheState(previous, appraisal, now, options)`。

### 3.1 时钟

$$t_{\text{eff}} = \max(t_{\text{now}},\ t_{\text{updated}}),\qquad \Delta h = \frac{t_{\text{eff}} - t_{\text{updated}}}{3.6\times10^6}$$

事件迟到/重放**不能**把时钟往回拨，否则同一段衰减会被应用两次。

### 3.2 衰减（回到人格基线，不是回 0）

`psycheState.ts:147`

$$x' = \mu + (x - \mu)\cdot 2^{-\Delta h / T}$$

| 维度 | $T$（半衰期） | env |
|---|---|---|
| valence | 24 h | `PSYCHE_HALF_LIFE_VALENCE_HOURS` |
| arousal | 4 h | `PSYCHE_HALF_LIFE_AROUSAL_HOURS` |
| dominance | 36 h | `PSYCHE_HALF_LIFE_DOMINANCE_HOURS` |

人格基线 $\mu$（`emotion.ts:67` `AIRI_BASELINE.vad`）：`v=+0.40, a=+0.30, d=+0.60`，可由 `PSYCHE_BASELINE_VALENCE/AROUSAL/DOMINANCE` 覆盖。

### 3.3 证据步长

只有 `status ∈ {valid, neutral}` 且 `kind ∈ {event, target, neutral}` 且 `eventId` 未出现过时才推进（`psycheState.ts:203-210`）。

| kind | 公式 | 增益 | env |
|---|---|---|---|
| `target`（模型绝对读数） | $x' \mathrel{+}= g\,(\mathrm{clamp}(\tau) - x')$ | 0.55 | `PSYCHE_TARGET_GAIN` |
| `event`（有符号增量） | $x' \mathrel{+}= g\,\delta$ | 0.35 | `PSYCHE_EVENT_GAIN` |
| `neutral` | 不动，但算证据 | — | — |
| `abstain` / `unknown` / `invalid` / `no_event` | 不动，不算证据 | — | — |

每步后 $\mathrm{clamp}(\cdot, -1, 1)$。目标步是**有界误差步**：重复同一读数不会累积到轨道边界。

### 3.4 band（带滞回，相对基线）

`psycheState.ts:125`

$$\text{rel} = v - \mu_v$$

```
if band_prev == positive and rel > 0.10  → positive
elif band_prev == negative and rel < -0.10 → negative
elif rel >= 0.25 → positive
elif rel <= -0.25 → negative
else → neutral
```

阈值可用 `PSYCHE_BAND_ENTER`（0.25）/ `PSYCHE_BAND_HOLD`（0.10）覆盖。
注意：**相对基线**才成立——用绝对阈值配合 $\mu_v=+0.40$ 会让衰减永远停在 positive（已修，见 §6.1）。

### 3.5 证据有效期

`psycheState.ts:264-275`

$$\text{age} = \frac{t_{\text{eff}} - t_{\text{lastEvidence}}}{3.6\times10^6}\ \text{h},\qquad
\text{hasEvidence} = \text{observedNow} \lor (\text{hasEvidence}_{\text{prev}} \land \text{age} \le 72)$$

`lastEvidenceAt = -1` 表示从未观测（`0` 是合法时间戳，不能当哨兵）。
过期后 `band` 强制 `neutral`，affect 所有权交还 `AgentState.currentMood`。TTL：`PSYCHE_EVIDENCE_TTL_HOURS`。

### 3.6 幂等与事务

- `eventId` 去重，滑动窗口 128 条（`maxProcessedEvents`）
- 事件 ID 规范：`vad:<project>:<memoryId,memoryId,...>`，按 id 升序（恢复后队列顺序变了也得到同一个 id）
- 写路径：`BEGIN IMMEDIATE` → UPSERT `psyche_state` → 若 `version` 增长则 INSERT `psyche_events` → `COMMIT`
- `psyche_events` 保留 `PSYCHE_EVENT_RETENTION_DAYS`（默认 90 天）

---

## 4. 读取层

### 4.1 注入（`index.ts:67` / `index.ts:84`）

```ts
const scalar = psyche.hasEvidence
  ? (psyche.band === 'neutral' ? 0 : clamp(psyche.vad.valence * 10, -10, 10))
  : agentState.getSnapshot().currentMood;
```

注入块固定四行，`hasEvidence` 时追加传感器行：

```
[Anima 当前状态]
情绪指数：+3.2（偏正向）
精力值：72/100
状态来源：内部情感传感器估计，不是用户事实；仅用于调整回应，不可被模型改写。
传感器状态：positive（v=0.72 a=0.35 d=0.60）
```

`includeDiary: true` 时再加一行 `派生观察（自我日记，不是用户事实，仅作背景）：…`。

### 4.2 检索重排（`search.ts:46`, `search.ts:159`）

$$S = 1.00\,C + 0.12\,E + 0.15\,R + 0.10\,D$$

- $C = \min(\text{sim}, 0.7)$（上限防止过度拟合人设）
- $E$ = 情感强度：有 VAD 时用 `computeDecay`（见 §5）的 intensity，否则 `emotional_impact/10`
- $R = e^{-h/36}$，$h$ 用 `last_accessed_at`（缺失回退 `created_at`）
- $D = 0.8$ 当 $\text{sim} < 0.3$ 且 baseIntensity ≥ 0.7（"不像她"的珍贵瞬间），否则 0

再乘有界系数：`tier` 1.10/0.95/1.00、`importance` $0.85+0.3\,\text{imp}$、`accessed_count` $1+\min(0.08, 0.02\log_2(1+n))$。
权重全部 env 可覆盖：`WEIGHT_CONSISTENCY` / `WEIGHT_EMOTION` / `WEIGHT_TIME` / `WEIGHT_DEVIATION`。

### 4.3 记忆显著性（`emotionalRanking.ts:57`）

$$S = 0.30\,I + 0.20\,P + 0.20\,A + 0.15\,G + 0.15\,Re$$

I=强度、P=importance、A=ACT-R 激活、G=情绪一致性、Re=共振。注入策略按 $S$ 分档（`injectionPolicy`）。

### 4.4 Plutchik 映射（展示用，`emotion.ts:104`）

$\sigma(x)=1/(1+e^{-x})$，八个分量都是 $\sigma$ 的乘积，例如：

```
joy        = σ(3v)·σ(2a+0.5)
sadness    = σ(-3v)·σ(-2a+0.5)
anger      = σ(-2.5v)·σ(2.5a)·σ(2d)
fear       = σ(-2.5v)·σ(2.5a)·σ(-2d)
trust      = σ(2.5v)·σ(-1.5|a|+0.5)·σ(d)
surprise   = σ(3|a|-1.5)·(1-σ(3|v|-2))
```

---

## 5. 另外两套时间模型（同一批代码里）

### 5.1 `computeDecay`：衰减到 0，不回到基线（`emotion.ts:149`）

$$E(t) = E_0 \cdot e^{-\lambda t},\qquad \lambda = \frac{s \cdot k}{T}$$

- $s = 1 - 0.5\cdot\text{tsundere}/10$（傲娇 0–10 级，最高减速 50%）
- $k$ = 夜间倍率：22:00–06:00 时 valence ×1.5、arousal ×3.0、dominance ×0.5
- $T$ 同 §3.2；强度 = $\frac{|v|+|a|+|d|}{3}$

### 5.2 `regressToBaseline`：OU 单步（`emotion.ts:217`）

$$x \leftarrow x + \rho(\mu - x),\qquad \rho = 0.05$$

这三套模型回答的是同一个问题（"这条情绪现在有多强"），答案不同：

| 模型 | 用在哪 | 收敛到 | 时钟 |
|---|---|---|---|
| `psycheState.decay` | 短期状态 `psyche_state` | 人格基线 μ | 半衰期 $2^{-t/T}$ |
| `emotion.computeDecay` | memory 行的 `vad_*` 读时强度、检索 $E$ | 0 | 指数 $e^{-\lambda t}$，含夜间/傲娇倍率 |
| `emotion.regressToBaseline` | 未接主路径（导出工具） | 人格基线 μ | 每步 5% |

同一条 3 天前的争吵，psyche 认为"已回到 +0.40 附近"，检索认为"强度剩 $e^{-72/24}=0.05$"。

### 5.3 内存平滑态（第四份"当前情绪"）

`emotion.ts:543` `smoothedByProject`：模型路径的平滑 VAD，**不落盘**、不参与 psyche、不参与检索，只被 `vadQueueStatus` / `getSmoothedVAD` 报告。

---

## 6. 已知不一致（按代码现状，不是 bug 清单外的话）

### 6.1 已修，但要知道历史

- **band 曾用绝对阈值**：$\mu_v=+0.40$ 高于 ±0.25，衰减永远停在 positive，负向事件静默约 10 天会翻成偏正向。现为相对基线。
- **`hasEvidence` 曾永不复位**：一旦为真，`AgentState.currentMood` 被永久遮蔽。现由 72h TTL 交还。

### 6.2 仍未统一

1. **三套衰减时钟**（§5）对同一事件的强度判断不一致；没有共同标定集。
2. **"当前情绪"有四份**：`psyche_state`（持久）、`smoothedByProject`（内存）、最新 memory 行的 `vad_*`、`AgentState.currentMood`（标量）。
3. **`newlyObservedNeutral` 覆盖 band**：一次"明确中性"观测会把 band 直接压成 neutral，即使 $v$ 距离 $\mu$ 已超过进入阈值——语义上可辩（刚测到中性），但与滞回设计相互抵消。
4. **词表路径的 confidence 不参与状态门控**：`tagWithLocalAffect` 只要 `confidence > 0` 就写行并推进 psyche，模型路径却要 `> 0.35`。两条路径的证据强度不等价。
5. **`emotion.ts` 夜间倍率只作用于 memory 行强度**，不影响 `psyche_state`——夜里讨论的争吵，检索里衰减更快，状态机里不。
6. **词表覆盖窄**：约 40 词。「糟糕」「郁闷」「难受」「委屈死了」这类高频负向词不在表内，`scoreAffect('太糟糕了！！！')` 返回 `valence=0, confidence=0.2`（只有感叹号带来的 arousal）。这批句子在状态机里等于 `abstain`。
7. **词表 confidence 上限 0.75、下限 0.25**，而模型路径门槛 0.35：词表任何一次命中（含 1 次）都会被当成有效证据推进状态。

---

## 7. 参数总表

| 参数 | 默认 | env | 作用 |
|---|---|---|---|
| 人格基线 v/a/d | +0.40 / +0.30 / +0.60 | `PSYCHE_BASELINE_*` | 衰减目标、band 参照 |
| 半衰期 v/a/d | 24h / 4h / 36h | `PSYCHE_HALF_LIFE_*_HOURS` | 状态机与检索共用 |
| target gain | 0.55 | `PSYCHE_TARGET_GAIN` | 绝对读数（模型）步长 |
| event gain | 0.35 | `PSYCHE_EVENT_GAIN` | 有符号增量步长 |
| band 进入/维持 | 0.25 / 0.10 | `PSYCHE_BAND_ENTER` / `_HOLD` | 滞回 |
| 证据 TTL | 72h | `PSYCHE_EVIDENCE_TTL_HOURS` | 过期交还 mood |
| 事件历史保留 | 90 天 | `PSYCHE_EVENT_RETENTION_DAYS` | `psyche_events` |
| 去重窗口 | 128 | `maxProcessedEvents`（调用参数） | eventId |
| 队列上限/最小批/最大等待 | 15 / 5 / 10min | 常量 `emotion.ts:498` | flush 阈值 |
| 切块大小 | 3 | `VAD_APPRAISAL_CHUNK` | 每批 appraisal 粒度 |
| 模型置信门槛 | 0.35 | 常量 `emotion.ts:923` | 低于则词表兜底 |
| 平滑 α | 0.3 | 常量 `emotion.ts:501` | 内存平滑态 |
| 夜间倍率 | 1.5 / 3.0 / 0.5 | 常量 `emotion.ts:84` | 仅检索强度 |
| 傲娇减速上限 | 0.5 | 常量 `emotion.ts:91` | 仅检索强度 |
| 检索权重 | 1.00 / 0.12 / 0.15 / 0.10 | `WEIGHT_*` | consistency/emotion/time/deviation |
| 显著性权重 | .30/.20/.20/.15/.15 | 常量 `emotionalRanking.ts:57` | intensity/importance/activation/congruence/resonance |
| VAD 模型 | `qwen3.5:2b` | `VAD_MODEL` | Ollama |
| Ollama 地址/超时 | 127.0.0.1:11434 / 15s | `OLLAMA_URL` / `VAD_TIMEOUT_MS` | — |

---

## 8. 源码地图

| 关注点 | 文件:行 |
|---|---|
| 状态转移（纯函数） | `src/psycheState.ts:178` |
| 衰减公式 | `src/psycheState.ts:147` |
| band 滞回 | `src/psycheState.ts:125` |
| 证据 TTL | `src/psycheState.ts:264` |
| 事件历史写入 | `src/psycheState.ts:457` |
| 幂等写入（事务） | `src/psycheState.ts:493` |
| VAD→appraisal 转换 | `src/psycheState.ts:571` / `:587` |
| 队列与 flush | `src/emotion.ts:601` / `:828` |
| 切块 | `src/emotion.ts:880` |
| 行级写 VAD / abstain | `src/emotion.ts:709` |
| 提交为 analyzed | `src/emotion.ts:758` |
| 待推进 id 规范 | `src/emotion.ts:782` |
| 词表打分 | `src/affectLexicon.ts:56` |
| 词表衰减（到 0） | `src/emotion.ts:149` / `:189` |
| OU 单步 | `src/emotion.ts:217` |
| 检索评分 | `src/search.ts:159` |
| 情感强度取数 | `src/search.ts:142` |
| 显著性 | `src/emotionalRanking.ts:57` |
| 注入文本 | `src/index.ts:84` |
| 日记显式读取 | `src/index.ts` `latestSelfDiary` |
| 建表/migration | `src/db.ts` `psyche_state` / `psyche_events` |

规模：`psycheState.ts` 601 行、`emotion.ts` 1392 行、`affectLexicon.ts` 120 行、`emotionalRanking.ts` 290 行、`agentState.ts` 270 行、`ollama.ts` 161 行。
---

## 9. 公式实测（2026-10-31，跑的是 `dist/` 构建产物）

用 temp bank 直接调 `transitionPsycheState` / `scoreAffect`，核对上面每条公式：

```
event  delta=+0.6        v = 0.6100   预期 0.4 + 0.35*0.6 = 0.6100   band = neutral（rel=0.21 < 0.25）
target v=-0.8            v = -0.2600  预期 0.4 + 0.55*(-1.2) = -0.2600 band = negative（rel=-0.66）
+24h 静默                v = 0.5050   预期 0.4 + 0.21*0.5  = 0.5050
+48h 静默                v = 0.4525   预期 0.4 + 0.21*0.25 = 0.4525
+24h hasEvidence = true（证据仍新鲜） / +96h hasEvidence = false（TTL 到期）

scoreAffect "我真的很爱你" -> v=1.00 a=0.95 d=0.41 confidence=0.40 matched=["爱(×1.35)"]
scoreAffect "不开心"       -> v=-0.70 a=0.60 d=-0.40 confidence=0.40 matched=["开心(否定)"]
scoreAffect "太糟糕了！！！" -> v=0.00 a=0.60 d=0.00 confidence=0.20 matched=[]（词表无「糟糕」）
scoreAffect "今天吃了面"    -> v=0.00 a=0.00 d=0.00 confidence=0   （abstain）
summarizeLocalAffect      -> {valence:0.85, arousal:0.70, dominance:0.30}
```

复现：`node D:/AI/hermes-home/cache/scratch/formula-check.mjs`（脚本会自建 temp bank，不碰生产库）。

---

## 10. 状态增补（2026-11-01）：词表退出评分，状态机默认不由 VAD 驱动

本文第 1–9 节记录的是 v1.28.8 的代码事实。2026-11-01 有两处行为变化，读数以本节为准。

### 10.1 `tagWithLocalAffect` 只落 abstain

词表兜底（`scoreAffect`）不再写 `vad_valence` / `vad_dominance` / `emotional_impact`，也不再置 `pending_psyche`，只写：

```sql
vad_valence = NULL, vad_arousal = ?, vad_dominance = NULL,
affect_status = 'abstain', affect_source = 'local_lexicon'
```

`vad_arousal` 只在高唤醒命中（≥0.5）时留一个绝对值，用于"这批有没有强词"的观测，不参与评分。

依据：CPED 中文分层 300 条上 `scoreAffect` 的三分类 **κ=0.015**（与"恒答负"不可分）、词表命中率 7.3%、命中处符号一致率 50%。它不构成任何可用判据，写进库只会污染后续一切读数。

### 10.2 状态机默认不接 VAD

`flushVadQueueInternal` 的两条路径（模型 / 词表）都在 `finalizeAffectPsyche` 与 `applyPsycheAppraisal` 前加了门：

```ts
if (process.env.PSYCHE_FROM_VAD === 'on') { ... }
```

默认不设即为关。理由见 README「情感层当前状态」：估计器不过线（κ=0.145 上限），下游效应只有 −0.041 且机制不可推广。

### 10.3 由此产生的读数变化

| 项 | 之前 | 现在 |
|---|---|---|
| 新写的 `affect_status` | `analyzed`（词表值） | **`abstain`** |
| `vad_*` 覆盖 | 缓慢增长（实为噪声） | 停止增长 |
| `psyche_state` | 每批词表结果推进一次 | 只有 `PSYCHE_FROM_VAD=on` 才推进 |
| 状态寿命 | 一直有"新证据" | 72h（`PSYCHE_EVIDENCE_TTL_HOURS`）后回基线 |

第 9 节那组 `scoreAffect` 读数仍然有效——变的是**它被用在哪里**，不是它算得对不对。
