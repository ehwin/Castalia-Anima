# AIRI Memory Fused

融合版记忆系统 — cognitive-memory 底座 + Alaya 评分 + SynaBun 优点 + User Learning + Bias Layer + Agent State

## 核心能力

| 能力 | 来源 | 说明 |
|------|------|------|
| SQLite + sqlite-vec 存储 | cognitive-memory | 本地向量存储，零 API 成本 |
| Alaya 评分公式 | AIRI Alaya | 1.2×similarity + 0.3×time_decay + 0.1×emotion |
| 情感权重 | AIRI Alaya | -10 到 +10，影响搜索排名 |
| 时间衰减 | AIRI Alaya | 艾宾浩斯遗忘曲线，30天半衰期 |
| 访问频率加权 | SynaBun Smart Relevance | 常访问的记忆排名更高 |
| 偏见层 | AIRI #2005 | 话题权重累积，影响检索优先级 |
| 角色 ID | AIRI 设计 | 多角色支持 |
| 层级分类 | SynaBun Categories | 11 个预设分类，可自定义 |
| 图关系 | cognitive-memory | 记忆之间建立关联 |
| 记忆整合 | cognitive-memory + SynaBun | 去重、时间衰减淘汰、每 50 次自动触发 |
| Agent 自我状态 | 千问建议 | 情绪/欲望/精力，指数衰减聚合 |
| User Learning | SynaBun Directive 5 | 自动观察用户沟通模式和兴趣 |
| 嵌入模型 | qwen3-embedding:8b | 4096维，中文 MTEB 71.58 |
| 权重可调 | 本次改进 | 环境变量控制评分权重 |

## 快速开始

```bash
cd D:\system\AIRI\memory\memory-fused
npm install
cd node_modules\better-sqlite3 && npx --yes node-gyp rebuild && cd ..\..
npx tsc
node dist/index.js
```

## MCP 配置

```json
{
  "mcpServers": {
    "airi-memory": {
      "command": "node",
      "args": ["D:\\system\\AIRI\\memory\\memory-fused\\dist\\index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11434",
        "EMBEDDING_MODEL": "qwen3-embedding:8b",
        "MEMORY_DB_PATH": "D:\\system\\AIRI\\memory\\memory-fused\\memory.sqlite",
        "WEIGHT_SIMILARITY": "1.2",
        "WEIGHT_TIME_DECAY": "0.3",
        "WEIGHT_EMOTION": "0.1",
        "HALF_LIFE_DAYS": "30"
      }
    }
  }
}
```

## MCP 工具列表（32 个）

### 记忆 CRUD（8 个）
| 工具 | 说明 |
|------|------|
| `memory_save` | 存储记忆（情感权重、角色ID、分类、subject、agentMood） |
| `memory_search` | 搜索记忆（Alaya 评分 + 访问频率 + 偏见加权 + profile 预设） |
| `memory_update` | 更新记忆（内容变化自动重新嵌入） |
| `memory_forget` | 软删除记忆 |
| `memory_restore` | 恢复已删除记忆 |
| `memory_relate` | 建立记忆之间的图关系 |
| `memory_list` | 列出记忆（支持 subject/type/category 过滤） |
| `memory_digest` | 记忆系统统计 |

### 记忆管理（4 个）
| 工具 | 说明 |
|------|------|
| `memory_consolidate` | 记忆整合（去重、衰减、淘汰，每 50 次 save 自动触发 + 6 小时定时） |
| `category_list` | 列出分类（树形结构） |
| `category_create` | 创建新分类 |
| `category_delete` | 删除分类（自动迁移关联记忆） |

### 记忆高级操作（2 个）
| 工具 | 说明 |
|------|------|
| `memory_brainstorm` | 多轮 recall（直接/相邻/情感/里程碑/广域 5 轮） |
| `memory_session_digest` | 会话摘要存储 |

### Agent 自我状态（4 个）
| 工具 | 说明 |
|------|------|
| `agent_mood` | 报告/更新情绪（\|值\|>=7 自动持久化） |
| `agent_desire` | 设置当前想做的事 |
| `agent_status` | 获取完整状态 + prompt 注入字符串 |
| `agent_energy` | 补充精力值 |

### 偏见层（2 个）
| 工具 | 说明 |
|------|------|
| `bias_record` | 记录话题提及，累积权重 |
| `bias_status` | 查看话题偏见 |

### User Learning（2 个）
| 工具 | 说明 |
|------|------|
| `user_observe` | 观察用户消息，学习沟通模式 |
| `user_profile` | 获取用户画像 |

### 上下文构建（1 个）
| 工具 | 说明 |
|------|------|
| `context_build` | 一键构建完整上下文 |

### Hook 系统（7 个）⭐
| 工具 | 时机 | 替代 SynaBun |
|------|------|-------------|
| `hook_session_start` | 对话开始 | SessionStart |
| `hook_prompt_submit` | 每条用户消息 | UserPromptSubmit |
| `hook_pre_compact` | 压缩前 | PreCompact |
| `hook_stop` | 对话结束 | Stop |
| `hook_pre_tool_use` | 工具调用前 | PreToolUse |
| `hook_post_tool_use` | 工具调用后 | PostToolUse |
| `hook_post_plan` | 退出计划模式 | PostToolUse Plan |

## 评分公式

```
最终得分 = (1.2 × 语义相似度 + 0.3 × 时间衰减 + 0.1 × 情感权重) × 重要性系数 × 访问频率加权 × 偏见加权

其中：
- 语义相似度：qwen3-embedding:8b cosine similarity (4096维)
- 时间衰减：e^(-t/S)，S = HALF_LIFE_DAYS / ln(2)
- 情感权重：|emotionalImpact| / 10
- 重要性系数：0.5 + importance（范围 0.5 ~ 1.5）
- 访问频率加权：1 + min(0.5, log2(1 + accessCount) × 0.1)
- 偏见加权：1 + min(0.5, topicWeight × 0.05)
```

## 预设分类

```
├ entity       — 实体记忆（人物、地点、物品）
│ └ relationship — 关系记忆
├ episodic     — 事件记忆（发生了什么）
│ ├ conversation — 对话记忆
│ ├ emotional    — 情感经历 ⭐
│ └ milestone    — 成长里程碑 ⭐
├ preference   — 偏好记忆（用户喜好和习惯）
└ semantic     — 事实记忆（知识和关系）
  ├ identity     — 身份信息
  └ knowledge    — 知识事实
```

## Prompt 注入输出示例

```
[AIRI 当前状态]
情绪指数：+4.5（心情不错）
精力值：100/100
当前想法：想研究一下新的嵌入模型
最近经历：被夸奖了、有趣的问题、有点无聊

[用户画像]
交流风格：喜欢简短回复
平均回复长度：45字
语言偏好：主要用中文
交互次数：12
常聊话题：AI(8)、记忆系统(5)、模型(3)

[兴趣倾向] ai(8.5)、记忆(5.2)、模型(3.1)
```

## 文件结构

```
memory/memory-fused/
├ src/
│   index.ts         — MCP 服务器入口（22 个工具）
│   db.ts            — SQLite 数据库管理
│   ollama.ts        — Ollama embedding 客户端
│   store.ts         — 记忆存储 + 自动话题记录 + 自动整合
│   search.ts        — Alaya 评分搜索 + 偏见加权
│   category.ts      — 层级分类管理
│   consolidate.ts   — 记忆整合
│   agentState.ts    — Agent 自我状态（情绪/欲望/精力）
│   bias.ts          — 偏见层（话题权重累积）
│   userLearning.ts  — 用户学习（沟通模式观察）
├ dist/              — 编译输出
├ memory.sqlite      — SQLite 数据库
├ package.json
├ tsconfig.json
└ README.md
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OLLAMA_URL` | http://127.0.0.1:11434 | Ollama API 地址 |
| `EMBEDDING_MODEL` | qwen3-embedding:8b | 嵌入模型名 |
| `MEMORY_DB_PATH` | ./memory.sqlite | 数据库路径 |
| `WEIGHT_SIMILARITY` | 1.2 | 语义相似度权重 |
| `WEIGHT_TIME_DECAY` | 0.3 | 时间衰减权重 |
| `WEIGHT_EMOTION` | 0.1 | 情感权重 |
| `HALF_LIFE_DAYS` | 30 | 时间衰减半衰期（天） |

## 搜索预设 (Search Profiles)

| 预设 | topK | minScore | 用途 |
|------|------|----------|------|
| `quick` | 3 | 0.6 | 快速回忆，只返回高相关结果 |
| `balanced` | 5 | 0.3 | 默认，平衡精度和覆盖面 |
| `deep` | 10 | 0.1 | 深度回忆，找更多关联记忆 |

使用方式：`memory_search({ query: "...", profile: "deep" })`

## Hook 系统迁移策略

当前记忆系统的工具层（25 个 MCP 工具）是**标准 MCP 协议**，与宿主松耦合。
Hook 触发机制建议分阶段实现：

| 阶段 | 方案 | 迁移成本 |
|------|------|---------|
| **当前** | 角色卡系统提示写绑定指令（LLM 自己调用工具） | 零（纯提示词） |
| **短期** | 独立 Node.js 服务监听 AIRI 事件（WebSocket/IPC） | 低（工具层不变） |
| **长期** | 等 AIRI 官方 Alaya 框架出来后集成 | 低（只改触发层，工具不变） |

**关键原则**：业务逻辑（memory_save/search/brainstorm 等）在 MCP 工具层，
触发机制（什么时候调用）在宿主层。迁移时只改触发层，不改工具层。

## 依赖

- Node.js 22+
- Ollama（本地运行 qwen3-embedding:8b）
- better-sqlite3（native 编译）
- sqlite-vec
