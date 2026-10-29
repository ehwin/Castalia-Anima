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

## 二、Anima 现状与缺口

Anima 已有的（不少）：`emotion.ts`（VAD + Plutchik8 + 人格基线 `AIRI_BASELINE` + `HALF_LIFE` + `computeDecay` + `regressToBaseline` + `computeBaseIntensity`）、`bias.ts`（话题偏好加权）、`recallForInjection.ts`（注入门槛）、`agentState.ts`（心情快照 → 提示词）。检索打分里已含情感强度、importance、recency、话题 bias。

缺的四块（本次调研直接指向）：

1. **情绪一致性检索**（AFT 第三层）：当前心情没有参与召回排序。难过时不该只想起开心的事，但同调的先浮上来。
2. **共振/共激活**（AFT 第五层、Hebb）：一起被想起过的记忆互不加强，每次都是独立打分。
3. **Bjork 双强度**：只有"最后访问 + 次数"，没有"存储强度不衰减"这一轴 → 最深刻的事会跟杂事一起沉底。
4. **锚点（pinned）与沉默策略**：没有"永不衰减、总是在场"的一类；也没有"中显著 + 强负心情 → 只作背景不主动提"的规则。

## 三、已实现（v1.29 第一块）

`src/emotionalRanking.ts`（纯函数，零 IO，28 项检查 `scripts/test_emotional_ranking.mjs` 全绿）：

- `baseLevelActivation(accessTimes, now, d=0.5)` — ACT-R；同一秒内重复不算新呈现。
- `moodCongruence(mood, memory)` — 效价同向加分、唤醒接近加分；无数据一律 0.5（不压死候选）。
- `resonanceBoost(id, seeds, resonance, max)` — Hebb 共激活，开方压长尾。
- `rankBySalience(cands, now, mood, seeds)` — 权重 `0.30 强度 + 0.20 重要度 + 0.20 激活 + 0.15 一致性 + 0.15 共振`；**锚点直接 1.0**（不被权重稀释）。
- `injectionPolicy(score, {pinned, mood})` — `always / inject / context-only / skip`；难过时中显著记忆只作背景。
- `bjorkDecay / bjorkUpdate / bjorkStrength` — S 不衰减、R 指数衰减且 τ 随 S 放大；费劲想起比轻松想起涨 S 更多；重读大幅提 R；`bjorkStrength` 用 S 做地板。

测试覆盖的是**行为**而不是指标：分散出现 > 集中出现、难过时悲伤记忆 > 快乐记忆、锚点 > 强情感 > 陈年杂事、中分 + 强负心情 → context-only、30 天后高存储强度衰减更慢。

## 四、接线计划（三步，每步可回滚）

1. **锚点表**：`memory.pinned`（或独立 `memory_anchor` 表）+ 注入时无条件下发。验收：钉住的告白在 30 天后仍出现在注入块里。
2. **共激活表**：召回成功后对"本轮所有被注入记忆"两两 +1（同轮只计一次）。验收：反复一起出现的两条记忆，其共振分随轮次上升。
3. **合并层重排**：`search.ts` 的候选合并阶段用 `rankBySalience` 重排（相似度作为候选项来源，不再是最终排序）。验收：83 项 `regression_v123_anima` 不退化 + 情感连续性场景探针通过。

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

- 统一索引 / 跨库 fan-out / BM25-IDF：实测在 255 条语料上无差别（见 `scripts/bench_anima_idf.mjs`），情感记忆也不需要"查得准"。
- Reranker / RRF：Lite 那边已证伪（Fusion Tax），Anima 语料更小，收益只会更差。
- 追求"全量记忆可检索"：Project Sue 的结论是身份连续性不要求完整记忆共享。
