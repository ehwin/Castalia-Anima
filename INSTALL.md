# 安装与运行（INSTALL）

本包是**可直接运行的部署包**：`dist/` 已编译，`node_modules/` 已随包（生产依赖）。
正常情况下不需要联网、不需要编译。

## 0. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（本包在 24.x 上验证；`node -v` 自检） |
| 平台 | Windows / macOS / Linux 均可（SQLite 原生模块随包） |
| 内存 | 常驻 < 200 MB（向量检索按库加载） |
| 网络 | 仅在你配置了远程嵌入 / 反思接口时需要 |

> ⚠️ 若你的 Node 与本包 `node_modules/better-sqlite3` 的 ABI 不匹配（启动报
> `NODE_MODULE_VERSION` 或 `was compiled against a different Node.js version`），
> 执行一次 `npm rebuild better-sqlite3`（需要本机有 C++ 构建工具），或改用与包一致的 Node 大版本。

## 1. 解压与建库

```bash
unzip castalia-anima-memory-*.zip
cd castalia-anima-memory-*

# 配置文件（复制后填自己的后端；不填则用内置默认：本地 Ollama）
cp memory/config.example.json memory/config.json
```

`memory/` 里没有任何记忆数据 —— 首次启动时按 project 自动建库建表。
库默认落在 `./memory/`；也可用 `MEMORY_DB_DIR` 指到别处（推荐，便于备份）。

## 2. 自检（不接宿主）

```bash
node -e "import('./dist/db.js').then(m=>{const db=m.DatabaseManager.getInstance('smoke','general');console.log('schema ok', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name).join(','))})"
```

应看到 `memory`、`facts`、`entities`、`instructions` 等表，没有 `psyche_state` / `psyche_events`
（本构建已去情感状态机）。

跑一组回归（用临时库，不碰你的库）：

```bash
node scripts/regression_cjk_recall.mjs
node scripts/regression_memory_injection.mjs
```

## 3. 接宿主（MCP stdio）

Claude Desktop / 任意 MCP 客户端：

```json
{
  "mcpServers": {
    "castalia": {
      "command": "node",
      "args": ["<绝对路径>/dist/index.js"],
      "env": {
        "MEMORY_DB_DIR": "<绝对路径>/memory",
        "CHAR_ID": "default",
        "CASTALIA_PROJECT": "default",
        "MCP_TOOLS": "all"
      }
    }
  }
}
```

- **一个角色 / 一套人格 = 一个实例 = 一个 `CHAR_ID` + 一个库目录**。多角色就多开几个实例，
  不要把多个角色塞进同一个 CHAR_ID。
- 只想给主 Agent 只读权限时，把 `MCP_TOOLS` 设成 `agent`；写入交给宿主一侧用 `harness` 组。

## 4. 嵌入后端（二选一）

**A. 本地 Ollama**（默认，零 API 成本）

```bash
ollama pull bge-m3          # 1024 维
ollama serve                # 默认 127.0.0.1:11434
```

`config.json`：

```json
{ "embedding": { "mode": "ollama", "ollama_url": "http://127.0.0.1:11434", "model": "bge-m3", "dim": 1024 } }
```

**B. OpenAI 兼容接口**

```json
{
  "embedding": {
    "mode": "api",
    "api_url": "https://api.example.com/v1/embeddings",
    "api_model": "your-embedding-model",
    "api_key": "PUT-YOUR-KEY-HERE",
    "dim": 1024
  }
}
```

`dim` 必须与模型实际输出维度一致；不确定就先跑一次 `node scripts/audit_vector_space.mjs`
（只读审计，会打印库内模型/维度与不一致行数）。

## 5. 反思 / 分拣 LLM（可选但推荐）

没有它，记忆仍可写入与检索，但不会自动提炼、去重、抽取事实。

```json
{
  "reflect": {
    "llm_url": "https://api.example.com/v1/chat/completions",
    "api_key": "PUT-YOUR-KEY-HERE",
    "model": "your-chat-model",
    "maxTokens": 4096,
    "minGapHours": 6,
    "minUnanalyzed": 8
  },
  "triage": { "llm_url": "", "api_key": "", "model": "" }
}
```

`reflect` 用于反思/整合；`triage` 用于入站分拣（留空则用启发式）。

## 6. 可选：跨库总反思插件

本包不带内置的总反思工具。需要时按库/按调度器自己挂：

```bash
node dist/plugins/fullPipeline/cli.js --projects=default,shared --dry-run   # 先看
node dist/plugins/fullPipeline/cli.js --projects=default,shared             # 再写
```

它会只读打开源库，把洞察写进同一实例的 `project=reflect` 库。建议每天/每几天一次，
放在宿主或系统计划任务里，而不是塞进每轮对话。

## 7. 升级 / 备份

- **备份**：整个 `memory/` 目录（或 `MEMORY_DB_DIR`）打包即可；SQLite WAL 模式下最好先停服务，
  或者用 `node scripts/memory_maintenance.mjs`（会做 checkpoint）后再打包。
- **升级**：替换 `dist/`、`scripts/`、`src/`、`package.json`，保留 `memory/` 与 `config.json`。
  启动时会做前向 schema 迁移（只加列/加表，不删数据）。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `Tool not found`（MCP 调用） | 引擎启动时 `MCP_TOOLS` 没放开该组；改 `all` 或加上对应组 |
| 检索全空、无向量 | 嵌入后端不可达；看 stderr 的 `[emotion]`/`[embed]` 日志，设好 Ollama 或用 `EMBED_MODE=none` 走纯文本检索 |
| `[config] load failed` | `config.json` JSON 语法错误；用 `node -e "JSON.parse(require('fs').readFileSync('memory/config.json'))"` 自检 |
| 启动即退出、无输出 | 多半是 Node ABI 与 `better-sqlite3` 不匹配，见 §0 的 `npm rebuild` |
| 想彻底清空重来 | 停服务 → 删除对应 `memory/<project>/` 子目录（或整个 `memory/`）→ 重启自动重建 |
