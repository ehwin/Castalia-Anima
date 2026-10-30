# Anima 情感记忆的技术路线（2026-10-29）

> 前提：**Anima 是情感记忆体，不是工程记忆体。** 工程记忆的验收是"问什么能不能查到"（recall/MRR）；
> 情感记忆的验收是"该想起的时候想起、不该提的时候不提、重要的不会淡、次要的会淡"。
> 这决定了哪些技术值得接（显著度、衰减、共振、锚点、沉默），哪些不值得（统一索引、IDF、rerank）。

## 一、调研（论文 / 产品 / 实现项目）

### 论文

| 来源 | 结论 | 对 Anima 的意义 |
|---|---|---|
| **MemoryBank**（Zhong et al., arXiv 2305.10250，中山大学+CMU） | 用艾宾浩斯遗忘曲线做记忆更新：按**经过时间 + 相对重要度**遗忘，并在回忆时强化；配套 SiliconFriend 陪聊机器人 | 情感记忆的第一个可行范式：忘了什么由"时间×重要度"决定，而不是由容量决定 |
| **Affective Field Theory / emotional-memory**（Mazza, Zenodo 22724258, MIT, v0.18.1） | 五层：Russell 效价-唤醒、Spinoza 情感动量、Heidegger 心情场、Scherer 评价向量、Collins & Loftus 扩散激活 + Hebb 强化。**明确指出 MemoryBank 缺 valence-arousal 与 mood-congruent retrieval** | 直接给出了 Anima 缺的那两块：情绪一致性检索 + 共振活化 |
| **Human-Like Remembering and Forgetting in LLM Agents**（ACM, ACT-R 启发） | 用 ACT-R 的 base-level activation `ln(Σ(now−t_k)^−d)` + 语义扩散激活做检索 | 比"最后访问时间+次数"更贴人脑：间隔效应、频次、近因三项合一 |
| **Bjork, New Theory of Disuse**（经 alaya-memory 等实现验证） | 存储强度 S 与提取强度 R 是两条独立轴：S 只增不减；R 越低时重新取回对 S 的提升越大；重读大幅提 R | 解释"很久没提、一提就全回来了"；也是"共同回忆"的机制底座 |
| **Significant Other AI**（arXiv 2512.00418 / IEEE 11644990） | 长期关系智能三支柱：身份稳定、记忆、情绪调节；评估看**身份稳定性与纵向连续性**，不是问答准确率 | 给评测口径：应测"人格是否连贯"，不是"答案对不对" |
| **Project Sue**（Zenodo 22022948，中文） | 伴侣是持续运行闭环：人格土壤 + 感知种子 + Heartbeat；五原则含"**身份连续性不要求完整记忆共享**" | 反过来说明：不必追求全量记忆可检索，只需"关系与身份"连续 |
| **From simulated empathy to structural attunement**（DOAJ） | 情感落地的关键在"结构调谐"（记忆拓扑可实时编辑），不在共情措辞 | 支持"锚点可被用户/角色钉住"这种可编辑结构 |

### 产品

| 产品 | 做法 | 可借鉴 |
|---|---|---|
| **Character.AI**（2026-05-21 Memory 改版） | 三类记忆：**Story Memory（可长按 Pin 钉住"告白/转折/那句改变一切的话"，永不衰减）**、Facts（自动抽取的人物/世界事实）、Memory Usage（可视化占用，后台把"重要的留下"） | 锚点必须是一等公民；用户可手工钉住 |
| **Memobase** | 用户画像（profile）+ 事件（events），`context()` 直出可注入文本，支持按 token 上限裁剪；**默认提示"除非用户相关提问，不要主动提这些记忆"** | 注入策略本身是产品行为：说 vs 不说要分开设计 |
| **Fawn（社交机器人）** | 明确 precision/recall 的取舍："precision 太高等于什么都想不起来，recall 太高等于灌一堆无关记忆"；检索用**基于最近几条消息生成的上下文查询**，不是关键词 | 情感记忆里"想起来"应由情境触发，不是关键词匹配 |

### 实现项目

| 项目 | 特点 |
|---|---|
| `zhongwanjun/MemoryBank-SiliconFriend` | 论文官方实现（艾宾浩斯 + 显著度） |
| `gianlucamazza/emotional-memory`（PyPI） | AFT 五层的可运行库，带 14 组 mood-adaptive 测试 |
| `SecurityRonin/alaya` | Bjork 双强度 + retrieval-induced suppression + Hebbian 共激活 |
| `hakua-memory` / `neuram` / `cognitive-memory` | SQLite + 艾宾浩斯 + 语义图，工程实现可直接对照 |
| `bal-spec/sillytavern-character-memory` | 从聊天里抽"结构化角色记忆"再走向量检索；文档明确"大部分召回失败是因为开关没开" |
| `NVIDIA-NeMo/labs-OO-Agents`（nooa-memory） | 生产级 `base_level_activation(access_log, now, d)` 实现 |

## 二、逐行核对:现状与缺口(2026-10-29,对着 1.28.8 源码)

| # | 声称 | 证据 | 判决 |
|---|---|---|---|
| 1 | 检索里已有情感项 | `search.ts` L39-42 权重:`CONSISTENCY 1.00 / EMOTION 0.12 / TIME 0.15 / DEVIATION 0.10`;L143 用 `last_accessed_at` 刷新时间时钟 | **成立**:有,但情感只是陪衬(0.12) |
| 2 | 情感强度会随时间衰减 | L119 `hoursSinceCreated` → `computeDecay`;`emotion.ts` `HALF_LIFE = {valence 24h, arousal 4h, dominance 36h}` | **成立,但方式有问题**:按**创建时间**衰减,回忆**不刷新** —— 三天前的高唤醒事件,情感权重已归零;而同一条记忆的时间项却按 last_accessed 刷新。两者不一致 |
| 3 | 缺情绪一致性 | `search.ts` 全文无 mood/congruence;`agent_mood` 只被 SELECT 出来当字段(L382 等),不参与打分;当前心情在 `agentState.ts` L21 是 −10..+10 标量 | **成立**(真缺) |
| 4 | 缺共振/扩散激活 | `entities.ts` L214 `entityMemories`、L234 `expandEntityGraph`(1–3 跳递归 CTE)已实现;`db.ts` L441 `edges` 表存记忆间关系;但 `search.ts` **没有任何调用** | **部分成立**:能力已有,只是没接进检索 —— 我原说"需要新建共激活表"是**错的** |
| 5 | 缺锚点 | 全文无 pinned/anchor;最接近的是 L137 `deviationBonus`:`similarity < 0.3 && baseIntensity ≥ 0.7 → +0.8`("不像她的珍贵瞬间") | **成立**:但那是个自动近似,且只在低相关时生效 |
| 6 | 缺"沉默策略" | `recallForInjection.ts` L120-135 已有**证据门**:没有任何一条 ≥0.50 的强命中、也没有 ≥0.60 的词法重合 → 一条都不注入(实测挡住 8/8 噪音问句) | **不成立**:证据维度的沉默已有;真正缺的是**情感合宜性**(难过时别翻旧账) |
| 7 | Anima 没有 IDF | `search.ts` L544-560 早已按 IDF 加权(L555 `const idf = terms.map(...)`),L594-595 用 `Σidf(命中)/Σidf(查询)` | **不成立**:我上一轮把"覆盖率"当现状是**稻草人**;生产里跑的就是 IDF 加权 |
| 8 | 标签命中会绕过向量 | L176-180:`tagResults.length >= topK && top[0].score >= 0.5` → 直接 return,连向量都不走 | **成立**:任何显著性重排必须放在这个早退**之前** |
| 9 | 有访问历史可用 | `updateAccessed` 只写 `accessed_count + 1` 与 `last_accessed_at`;库里**没有访问日志表** | **不成立**:ACT-R 需要多次访问的时间戳 → 需要新增 access log(或先用 count+last 近似) |

### 由此修正的三处结论

1. **"共振要新建共激活表"→ 不需要。** 共享实体就是天然联想边,`entityMemories` / `expandEntityGraph` 现成。
2. **"没有沉默策略"→ 有(证据门),缺的是情感合宜性。** 两者正交,应叠加而不是替代。
3. **"IDF/BM25 不值得移植"→ 结论依旧,但理由要改。** Anima 早已内置 IDF;重跑对照后三种词法口径(纯覆盖率 / IDF 覆盖率 / BM25)在 255 条语料上完全相同(87% / .714 vs 87% / .714 vs 90% / .700),说明**这个语料上排序口径根本不是瓶颈**,而不是"IDF 没用"。

### 一个 P1 级发现(尚未修)

`computeEmotionalIntensity` 用 `hoursSinceCreated` 算衰减:高唤醒记忆(arousal 半衰 4 小时、dominance 36 小时)在 3 天后 `intensity ≈ 0`,于是"那次告白""那场争吵"在情感维度上跟杂事没有区别 —— 而 MemoryBank 的结论恰好相反(重要度决定遗忘速度,回忆会强化)。修法有两种:

- 最小改动:改用 `last_accessed_at` 作为衰减起点(与时间项一致),并让锚点走 baseIntensity 而不是衰减后的 intensity;
- 彻底一点:引入 Bjork 双强度(本模块已有 `bjorkDecay/bjorkUpdate`),让"被情绪刻深"的事保留存储强度地板。

## 三、已实现（v1.29 第一块）

`src/emotionalRanking.ts`（纯函数，零 IO，28 项检查 `scripts/test_emotional_ranking.mjs` 全绿）：

- `baseLevelActivation(accessTimes, now, d=0.5)` — ACT-R；同一秒内重复不算新呈现。
- `moodCongruence(mood, memory)` — 效价同向加分、唤醒接近加分；无数据一律 0.5（不压死候选）。
- `resonanceBoost(id, seeds, resonance, max)` — Hebb 共激活，开方压长尾。
- `rankBySalience(cands, now, mood, seeds)` — 权重 `0.30 强度 + 0.20 重要度 + 0.20 激活 + 0.15 一致性 + 0.15 共振`；**锚点直接 1.0**（不被权重稀释）。
- `injectionPolicy(score, {pinned, mood})` — `always / inject / context-only / skip`；难过时中显著记忆只作背景。
- `bjorkDecay / bjorkUpdate / bjorkStrength` — S 不衰减、R 指数衰减且 τ 随 S 放大；费劲想起比轻松想起涨 S 更多；重读大幅提 R；`bjorkStrength` 用 S 做地板。

测试覆盖的是**行为**而不是指标：分散出现 > 集中出现、难过时悲伤记忆 > 快乐记忆、锚点 > 强情感 > 陈年杂事、中分 + 强负心情 → context-only、30 天后高存储强度衰减更慢。

## 四、接线状态（2026-10-30：第 1、3 步已接，第 2 步改用现成的 `edges`）

1. **锚点表 —— 已接**。`memory.pinned` 列（`db.ts` 迁移，带索引）+ `memory_update {pinned:true}` 钉住 +
   `search.ts` 的 `pinnedAnchors()` + `recallForInjection` 里**不参与相似度门槛**、排在最前。
   去重口径与普通命中一致（`recentIds` 里的锚点同样跳过），项目/角色隔离照旧。注入返回 `stats.pinned`。
   验收：`scripts/test_emotion_wiring.mjs` 里"只有锚点时也注入 / 证据门很弱的问句仍注入锚点 / 取消钉住后取不到"。
2. **共激活表 —— 不新建**。`edges` 已经是"哪两条记忆被绑在一起"的现成记录，直接当共振边用
   （`applySalienceRerank` 里一条 IN 查询取回来，按双方计数）。真需要"同轮共现计数"再加表，
   在那之前多一张表只会多一处要维护的真相。
3. **合并层重排 —— 已接，但有界**。`search.ts` 在 `bestById` 去重之后、`slice(topK)` 之前调
   `applySalienceRerank`：显著度只作 `salienceBlendFactor(s) = 0.9 + 0.2s`（±10%）的乘数。
   **不是**把相似度替换成显著度 —— 2026-10-28 那次 tier×3.0 / importance×1.x / access×1.5
   已经把"元数据乘在总分上"这条路的代价演示过一遍（6 个字的垃圾行 score 4.3 排第一）。
   强度取 `computeBaseIntensity`（存储强度），新鲜度交给 ACT-R 的 activation —— 这样这一层与
   §七 那条"衰减该按哪个时钟算"的争论正交，不会互相牵制。
   验收：`regression_v123_anima` 83 项 + `regression_memory_injection` 44 项 + 新增 `test_emotion_wiring` 35 项全绿。

## 五、评测台（不测 precision/recall）

6 个脚本化场景，判断"像不像有记忆的人"：

| 场景 | 期望 |
|---|---|
| 用户隔 30 天提起旧争执 | 想起争执本身，而不是"用户喜欢猫"这类事实 |
| 心情强负时对话 | 不主动翻旧账（context-only）；锚点仍可用 |
| 用户说"还记得那天吗" | 能接住具体的锚点内容（不泛泛而谈） |
| 连续三次聊同一话题 | 第三次的注入里出现第一、二次的细节（共振） |
| 一年前的琐事 | 不再注入 |
| 关系里程碑（告白/约定） | 任何时候都在场 |

## 六、明确不做

- 统一索引 / 跨库 fan-out:情感记忆只有 airi 一个 bank,不需要跨库拼语料。
- BM25 / reranker / RRF:实测与现役 IDF 覆盖率在 255 条语料上无差别(`scripts/bench_anima_idf.mjs`);
  Lite 那边 RRF 也已证伪(Fusion Tax)。
- 追求"全量记忆可检索":Project Sue 的结论是身份连续性不要求完整记忆共享。
- 把相似度当成排序主轴:候选来源仍用 `computeScore`(相似度负责"有哪些"),显著性负责"谁在场"。

## 七、P0 发现:情感数据根本没进库(2026-10-29 实测)

用 `scripts/probe_intensity_decay.mjs` 扫 airi bank:

```
库内带 VAD 的活跃记忆 0 条(baseIntensity ≥ 0.7 的"高情绪记忆" 0 条)
按 project 明细:general 140 行 vad=0 / project 8 行 vad=0 / user 9 行 vad=0 / reference 2 行 vad=0
emotional_impact > 0 的只有 6 行;importance ≥ 0.7 的有 103 行(说明 importance 在写,VAD 没写)
```

也就是说:**这个"情感记忆体"目前一条情感数据都没有**。`search.ts` 的
`computeEmotionalIntensity` 走 `emotional_impact/10` 回退,262 条里 256 条是 0 →
`WEIGHT_EMOTION(0.12) × 0 = 0`,`deviationBonus` 也永远不触发(baseIntensity≥0.7 为 0 条)。
所有情感排序逻辑在线上是空转的。

### 根因链(逐行)

1. VAD 唯一来源是 `ollamaDetectVAD`(`emotion.ts`),本机 **Ollama 没跑**(11434 无监听)。
2. 它失败时**不抛错**,返回 `fallbackVAD(text)`,而 `fallbackVAD` 的 `confidence` **正好是 0.3**。
3. `flushVadQueue` 里写的是 `if (result.confidence < 0.3) continue;` —— 0.3 不满足,于是继续。
4. 继续就会调 `batchClassifyAndTag`(第二次 Ollama 调用),同样失败 → 返回 0 条。
5. 结果:整批静默丢弃,日志只有两行 `fetch failed`,没有任何"没写成"的提示。

### 已修

- `src/affectLexicon.ts`:中英文情感词表(正/负/高唤醒、程度副词、简单否定),输出 VAD + confidence(0.25~0.75);
  没有情感词时**返回 0**(不凭空造情绪)。
- `emotion.ts`:Ollama 抛错**或** `confidence ≤ 0.35` 时,走 `tagWithLocalAffect()` 按词表逐条写 VAD,
  只写 `vad_*` + `emotional_impact`(+ 空 tags),不动其它字段;只告警一次。
- `scripts/test_affect_lexicon.mjs` 17 检查:方向可分(争吵 vs 吃面)、否定、程度、无词不造情绪、
  以及"Ollama 不可用 → 兜底写库"的端到端。

### 历史数据回填(工具已就绪,默认 dry-run)

```
node scripts/backfill_affect.mjs            # 只统计
node scripts/backfill_affect.mjs --apply    # 真写(只写 vad_valence IS NULL 的行)
```

airi bank 实测(排除 _backup):活跃 159 条、缺 VAD 159 条,词表能判出情绪 **49 条(31%)**,
其中正 27 / 负 18。注意词表会把 lore 里的「死/牺牲/爱」判成强情绪 —— 对角色扮演叙事不一定合适,
所以**默认不写**,由人决定。

### 这改变了优先级

原计划第一步是"锚点表",现在应改为:**先让情感有数据(P0)→ 再看排序(P1)**。
没有 VAD 时,任何显著度权重都是乘在 0 上的。
