# AI Memory — 纯记忆体框架(standalone MCP Server)

从 AIRI 记忆系统剥离的独立记忆体,标准 MCP stdio 协议,20 个工具。
SQLite + sqlite-vec 本地向量存储,零 API 成本;嵌入模型走本机 Ollama 兼容接口。

## 快速开始

### 1. 启动嵌入服务(首次约 30-60 秒加载模型)

```bat
scripts\start-embed.bat
```

嵌入服务监听 `http://127.0.0.1:11436`(Ollama 兼容 `/api/embed`,1024 维)。
模型 `IEITYuan/Yuan-embedding-2.0-zh` 已缓存在本机 `~/.cache/huggingface/`,无需重新下载。
> 若 harness 环境自带 Ollama/其他嵌入服务,只要输出 **1024 维** 且兼容 `/api/embed`,可直接指向它,
> 通过环境变量 `OLLAMA_URL` + `EMBEDDING_MODEL` 配置,不必启动本服务。

### 2. 在 MCP 客户端中接入

```json
{
  "mcpServers": {
    "ai-memory": {
      "command": "node",
      "args": ["D:\\AI\\AI memory\\dist\\index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_PATH": "D:\\AI\\AI memory\\memory.sqlite",
        "CHAR_ID": "default"
      }
    }
  }
}
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | 嵌入服务地址(本框架自带服务在 11436) |
| `EMBEDDING_MODEL` | `yuan-embedding-2.0-zh` | 嵌入模型名,输出必须 1024 维 |
| `MEMORY_DB_PATH` | `./memory.sqlite` | SQLite 数据库路径(首次启动自动建表) |
| `CHAR_ID` | `airi` | 角色/数据分区 ID。同一库可跑多个实例互不串扰 |
| `MCP_SERVER_NAME` | `airi-memory` | MCP server 自描述名 |
| `SEARCH_MIN_SCORE` | `0.15` | 向量搜索最低分阈值(默认已适配通用检索;调高可减少噪声) |
| `WEIGHT_CONSISTENCY` | `0.30` | 检索评分:语义一致性权重 |
| `WEIGHT_EMOTION` | `0.45` | 检索评分:情绪强度权重(无情绪记忆可调低) |
| `WEIGHT_TIME` | `0.15` | 检索评分:时间衰减权重 |
| `WEIGHT_DEVIATION` | `0.10` | 检索评分:偏离加成权重 |

## 工具列表(20 个)

**搜索**(LLM 直接调用)
- `memory_search` — 标签优先 → 向量 KNN 回退,按评分排序
- `fact_search` — 语义搜索事实三元组(subject-predicate-object)

**记忆 CRUD**
- `memory_save` — 存入记忆(可选 skipEmbed 跳过向量化)
- `memory_update` — 更新字段
- `memory_delete` — 软删除
- `memory_list` — 列出全部(可过滤 category/source)
- `memory_recent` — 近期重要记忆(时间+importance,零向量调用)
- `memory_graph` — 记忆关系图

**对话自动化**(可配合 harness 的每轮对话调用)
- `auto_process` — 处理一轮对话:存日志 + 观察用户 + 触发消化
- `conversation_save` — 只存原始对话轮次
- `digest_run` — 手动触发消化周期
- `daily_summary_data` — 取最近 N 小时对话/处理数据

**上下文/状态**
- `context_get` — agent 状态 + 偏见层 + 用户画像(提示词注入用)
- `stats_get` — 记忆统计
- `user_observe` — 观察用户消息(沟通模式学习)
- `mood_journal` — 情绪历史

**反思**(需要外部大模型配合)
- `reflect_analyze` — 取未分析对话 + 反思系统提示词
- `reflect_apply` — 应用反思结果(合并/拆分/提取/重分类/删除)
- `reflect_batch_embed` — 批量向量化未嵌入记忆

## 测试

```bash
python scripts/smoke_test.py   # 核心 CRUD 往返(不依赖嵌入服务)
python scripts/vec_test.py     # 嵌入 + 向量语义搜索完整链路(需嵌入服务在 11436)
```

## 数据与存储

- 首次启动自动建表:memory / edges / categories / facts / embedding_cache / vec_memory / vec_facts
- 向量固定 **1024 维**(schema 写死),换嵌入模型需同维或重建库
- WAL 模式;每 30 分钟自动 checkpoint;临时记忆 30 分钟清理;24 小时自动整合
- 数据库文件可整体拷贝迁移(停服状态下)

## 与 AIRI 的关系

这是从 `D:\system\AIRI\memory\memory-fused` 剥离的独立演进版本:
- 已改造:`CHAR_ID`/`MCP_SERVER_NAME` 环境变量化,多实例数据分区
- 已修复:`memory_search` 默认阈值适配通用检索(0.15),不再被情绪锚定评分误杀
- 未包含:unified-proxy(LLM 转发/TTS)、viz(星图)、AIRI 托盘与启动器

## 致谢与上游

本项目是独立演进的记忆系统,设计思路与部分存储层实现受以下项目启发/继承:

- **cognitive-memory**(Apache-2.0)— SQLite + sqlite-vec 本地向量存储的 schema 设计与向量 KNN 检索思路(概念继承,代码已大幅重写)
- **AIRI Alaya 评分设计** — 情感权重/时间衰减的评分公式思路
- **SynaBun** — 分层分类与 Smart Relevance 检索加权思路
- **千问架构建议** — agent 自我状态(情绪/欲望/精力)的设计启发

除 cognitive-memory 外均为设计思路参考,无代码复制。许可:Apache-2.0,见 `LICENSE`。

## 排障

- 嵌入服务没起:`memory_save` 会报 embed 失败;`curl http://127.0.0.1:11436/health`
- 搜索返回空:看 `SEARCH_MIN_SCORE`(调低)与 `CHAR_ID`(是否与写入时一致)
- 端口冲突:11436 被占时改 `start-embed.bat` 端口 + MCP 配置的 `OLLAMA_URL`
