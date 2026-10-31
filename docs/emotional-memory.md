# 情感记忆的设计口径（为什么这么排）

> 前提：**这是情感记忆体，不是工程记忆体。**
> 工程记忆的验收是"问什么能不能查到"（recall / MRR）；情感记忆的验收是
> "该想起的时候想起、不该提的时候不提、重要的不会淡、次要的会淡"。
> 这决定了哪些技术值得接（显著度、衰减、共振、锚点、沉默），哪些不值得（统一索引、IDF、rerank）。

## 1. 借鉴的范式

| 来源 | 结论 | 落到本引擎的方式 |
|---|---|---|
| MemoryBank（Zhong et al., arXiv 2305.10250） | 按**经过时间 + 相对重要度**遗忘，回忆时强化 | `computeDecay` + `accessed_count` 强化 |
| ACT-R（Human-Like Remembering and Forgetting, ACM） | 基础激活 `ln(Σ(now−t_k)^−d)` + 语义扩散 | `emotionalRanking.rankBySalience`（纯函数、可单测） |
| Bjork, New Theory of Disuse | 存储强度 S 与提取强度 R 两条轴 | 锚点（pinned）恒在场；低温记忆只降 R 不删行 |
| Significant Other AI（arXiv 2512.00418） | 长期关系的评估看身份连续性，不看问答准确率 | 记忆按角色（`character_id`）隔离；人格由 `PERSONAS_JSON` 提供 |
| Project Sue（Zenodo 22022948） | 身份连续性不要求完整记忆共享 | 不做"全量可检索"的执念，做"该在场的在场" |
| Character.AI Story Memory | 可钉住的锚点 + 自动抽取的事实 + 占用可视化 | `tier=critical` / 手工 pin；`facts` 三元组；`stats_get` |

## 2. 三条链路（本构建的实际边界）

```text
① 证据链（只存事实，不存解释）
对话 -> conversation_log(source='conversation_log', affect_status='pending')
     -> VAD 队列 -> 模型判 VAD / 词表兜底 / 无证据 abstain
     -> memory.vad_* + emotional_impact（分析完置 affect_status='analyzed'）
     -> 检索打分（情感强度为主锚） -> 注入

② 反思链（把证据提炼成可复用的语义记忆与事实）
未分析对话 -> reflect（LLM）-> memory(派生语义记忆) + facts(三元组, 双时态)
                           -> insights 质检闸（引用原句必须逐字出现）

③ 检索/注入链（只读）
memory_search（tag→向量回退） -> 显著性重排 -> recallForInjection（相似度闸 + 预算）
```

**本构建没有第四条链**（情感状态机）：没有 `psyche_state` 状态转移、没有 agent 心境快照、
没有自循环日记。所以"难过不翻旧账"这类基于**当前心境**的策略在这里不生效 ——
只有基于**记忆自身情绪强度**的策略（高情绪记忆更持久、低一致性高情绪记忆会被额外加权）生效。

## 3. 评测口径（不测 precision/recall）

| 场景 | 期望 |
|---|---|
| 隔 30 天提起旧争执 | 想起争执本身，而不是"用户喜欢猫"这类事实 |
| 用户说"还记得那天吗" | 能接住具体锚点内容，不泛泛而谈 |
| 连续三次聊同一话题 | 第三次注入里出现前两次的细节（共振） |
| 一年前的琐事 | 不再注入 |
| 关系里程碑（告白/约定） | 任何时刻都在场（pinned / tier=critical） |

## 4. 明确不做

- **统一索引 / 跨库 fan-out 默认开启**：跨库是显式接口（`memory_search_all` + `FEDERATION_*`），
  不是检索的默认行为。
- **BM25 / reranker / RRF**：情感记忆的候选集本来就小，重排收益低于显著度与衰减；
  实测 IDF 覆盖率与 BM25 无差别。
- **把相似度当排序主轴**：相似度负责"有哪些候选"，显著性负责"谁在场"。
- **凭空造情绪**：词表没有情感词就 `abstain`，不写 0.5 这种"中间值"冒充证据。
