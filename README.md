# Castalia Anima — Emotional Memory MCP Server

**Castalia Anima** is the personality-driven companion of [**Castalia**](https://github.com/ehwin/Castalia): a standalone MCP memory server that remembers *how things felt*, not just what happened. SQLite + sqlite-vec, no external database, runs entirely on your machine.

Forked from [**Castalia**](https://github.com/ehwin/Castalia), extended with a full emotional personality layer. SQLite + sqlite-vec for storage, an OpenAI-compatible or Ollama embedding service for recall, and optional LLM channels for triage / reflection.

> **Relationship to Castalia**: Castalia is the neutral, general-purpose component (no personality). Castalia Anima is the emotional variant — it tracks the same architecture, and every engine fix lands upstream first, then gets ported here with the personality layer kept intact.

以上参数也可写进 `memory/config.json` 的 `consolidate` 段(与 `minMemories`/`similarity` 同处),例如 `"decayMidpointDays": 180`、`"decayMemTypes": ["general"]`。

## Feature Highlights

- **Emotion engine** (`emotion.ts`)
  - VAD 3D vectors (valence / arousal / dominance) analyzed by a local Ollama model
  - Surface-vs-true emotion detection — **tsundere level** 0–10 (surface words contradicting true feelings)
  - Differential half-life decay (Verduyn & Lavrijsen 2014): valence 24h / arousal 4h / dominance 36h
  - Night-time regulation (22:00–06:00) + tsundere decay slowdown + personality-baseline regression (OU process)
- **Emotion-anchored retrieval** — search scoring is emotion-first:
  `0.30·consistency + 0.45·emotion + 0.15·recency + 0.10·deviation` × importance × tier × bias × access boost
  "Unlike her" high-emotion moments get a deviation bonus — personality over fit.
- **Persona per project** — each project namespace is an AI persona:
  - `charFor(project)`: persona map (config.json `personas`) → project name → built-in default `CHAR_ID`
  - `[Role Declaration]` injected by `context_get` / `memory_context`; `persona` field in responses
  - Agent state (mood/energy/desire), topic biases and user profile are partitioned per persona
- **Full Castalia architecture (v1.11 base, continuously re-synced)**
  - **Per-project × per-type DB files** (`memory/global.sqlite` + `memory/<project>/<memType>/memory.sqlite`), lazy-created; legacy `MEMORY_DB_PATH` single-file mode still supported
  - 3-channel LLM pipeline: LLM1 triage (inbound memType classification + incremental session reflection), vector model (embeddings), LLM2 reflection
  - Three-layer instructions (global / user / project + reusable rule groups, glob path filtering)
  - Closed memory types: user / feedback / project / reference (Markdown-normalized) + general fallback
  - Progressive session reflection: rolling session memory + promote-to-project (promote-and-delete) + TTL sweep; extraction-agent styling
  - Memory consolidation: vector pre-screen similar pairs → LLM dedup / conflict resolution (never invent facts)
  - Per-action reflection receipts, persisted to `memory/receipts/` for audit
  - Snapshot warnings with exact dates for memories older than 24h
  - `locked = 1` memories are permanently protected by a **code-level guard** (merge / split / soft-delete paths refuse to touch them, so a hallucinating LLM cannot destroy them)
- **34 MCP tools**, profile-gated (`MCP_TOOLS`): `agent` (read-only recall) / `harness` (writes + pipeline) / `admin` (management), or `all`

## Quick Start

### 1. Build + verify

```bash
npm install
npm run build          # tsc, exit 0
python scripts/smoke_test.py   # 34 tools + CRUD + per-project isolation
```

### 2. Start the embedding service (first load ~30-60s)

```bash
scripts\start-embed.bat        # Ollama-compatible /api/embed on :11436, 1024-dim
```

Any Ollama-compatible `/api/embed` service outputting **1024-dim** vectors works — point `OLLAMA_URL` / `EMBEDDING_MODEL` at it, or use a hosted OpenAI-compatible `/embeddings` endpoint via `EMBED_MODE=api` (see `EMBEDDING_API_KEY`).

### 3. Configure LLM channels (optional but recommended)

**API keys 请用加密存储(优先),不要再明文写进 `memory/config.json`:**

```bash
node scripts/keygen.js                                       # 交互式(回车 = 跳过保持原值)
node scripts/keygen.js --reflect-api-key sk-xxx \
                       --triage-api-key sk-xxx \
                       --embedding-api-key sk-xxx            # 命令行传入,未传的参数保持 keys.enc 原值
```

- 生成 `memory/keys.key`(32 字节随机密钥)+ `memory/keys.enc`(AES-256-GCM 加密负载),均与代码分离、已被 `.gitignore` 排除
- 启动时 `configLoader` 自动解密 `keys.enc` 注入环境变量(`REFLECT_LLM_API_KEY` / `TRIAGE_LLM_API_KEY` / `EMBEDDING_API_KEY`);优先级:显式环境变量 > keys.enc > 配置文件
- `memory/config.json` 仍可存非密钥配置(URL / model / personas 等);`api_key` 字段保留兼容但不再建议使用

非密钥配置放 `memory/config.json`(启动时加载):

```json
{
  "personas": {
    "work":  { "charId": "work-agent", "name": "Work Agent", "persona": "professional, concise, direct" }
  },
  "reflect": { "api_url": "https://api.deepseek.com/v1", "model": "deepseek-chat" },
  "triage":  { "api_url": "https://api.deepseek.com/v1", "model": "deepseek-chat" }
}
```

- `REFLECT_LLM_*` — daily reflection / deep calibration / consolidation
- `TRIAGE_LLM_*` — inbound classification + incremental session reflection (falls back to `REFLECT_*`)

### 4. Connect from your MCP client

```json
{
  "mcpServers": {
    "castalia-anima": {
      "command": "node",
      "args": ["/absolute/path/to/castalia-anima/dist/index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_DIR": "/absolute/path/to/memory-banks/anima",
        "CHAR_ID": "my-char",
        "MCP_TOOLS": "all"
      }
    }
  }
}
```

## Tools (34, profile-gated)

Exactly one of `agent` (read-only recall) / `harness` (writes + pipeline) / `admin` (management) is granted per tool; `MCP_TOOLS` takes a profile name, a comma list, individual tool names, or `all`.

| Profile | Representative tools | Purpose |
|---|---|---|
| **agent** | `memory_search` / `fact_search` / `memory_get` / `memory_recent` / `memory_index` / `memory_graph` | Read-only recall for the LLM |
| **harness** | `auto_process` / `conversation_save` / `digest_run` / `reflect_auto` / `reflect_deep` / `reflect_batch_embed` / `memory_save` / `memory_update` / `memory_log` / `mood_journal` / `user_observe` | Writes, session pipeline, emotion capture |
| **admin** | `memory_list` / `stats_get` / `recent_conversations` / `daily_summary_data` / `reflect_analyze` / `reflect_apply` / `memory_context` / `context_get` / `consolidate_deep` / `instruction_*` | Management, reflection control, context assembly |

## Environment Variables (key ones)

| Variable | Default | Meaning |
|---|---|---|
| `CHAR_ID` | build default (`src/env.ts`) | Default persona/character ID (used when no persona map entry matches) |
| `CASTALIA_PROJECT` | `default` | Default project namespace |
| `MEMORY_DB_DIR` | `<cwd>/memory` | Per-project × per-type DB directory (`global.sqlite` + `<project>/<memType>/memory.sqlite`); `MEMORY_DB_PATH` → legacy single-file mode |
| `OLLAMA_URL` / `EMBEDDING_MODEL` | `:11434` / `yuan-embedding-2.0-zh` | Embedding service (1024-dim) |
| `EMBED_MODE` | `ollama` | `ollama` / `api` (needs `EMBEDDING_API_KEY`) / `none` |
| `CONSOLIDATE_DECAY_MEMTYPES` | `general` | 哪些分类库参与衰减+升华(逗号列表或 `all`);user/feedback/project/reference 默认永不衰减 |
| `CONSOLIDATE_DECAY_STEEPNESS` | `0.04` | sigmoid 衰减陡度(越大衰减越快) |
| `CONSOLIDATE_DECAY_MIDPOINT_DAYS` | `90` | sigmoid 中点(天),调大 = 衰减更慢 |
| `CONSOLIDATE_DECAY_MIN_IMPORTANCE` | `0.15` | 衰减后低于此重要度才允许剪枝 |
| `CONSOLIDATE_DECAY_MIN_AGE_DAYS` | `60` | 年龄不足此天数的记忆绝不剪枝 |
| `CONSOLIDATE_PROMOTE_REF_COUNT` | `2` | 引用次数超过它触发升华 |
| `CONSOLIDATE_PROMOTE_BOOST` | `0.1` | 每次升华的重要性增量 |
| `CONSOLIDATE_PROMOTE_CAP` | `0.95` | 升华后的重要性上限 |
| `EMBED_TIMEOUT_MS` | `30000` | Embedding request timeout — prevents a hung embed service from blocking `memory_save` / `memory_search` forever |
| `REFLECT_LLM_*` | — | Reflection LLM (URL / API key / model) |
| `TRIAGE_LLM_*` | → `REFLECT_*` | Triage LLM channel (falls back to reflect) |
| `MCP_TOOLS` | `all` | `agent` / `harness` / `admin` / comma list / `all` |
| `WEIGHT_*` | 0.30/0.45/0.15/0.10 | Emotion-anchored search weights |
| `SEARCH_MIN_SCORE` | `0.15` | Vector search threshold |
| `VAD_MODEL` | `qwen3.5:2b` | Ollama model for VAD emotion analysis |
| `BUFFER_SIZE` / `SESSION_MEMORY_TTL_DAYS` | `5` / `7` | Session reflection buffer / TTL |

## Architecture Overview

```
┌─ Exposure    MCP stdio · 34 tools · agent/harness/admin gating (MCP_TOOLS)
├─ Cognition   reflect (LLM2) · triage (LLM1) · consolidate_deep
├─ Emotion     VAD engine · agentState · bias · userLearning      ← Anima
├─ Pipeline    auto_process → digest → session buffer → incremental reflection
├─ Storage     DatabaseManager · per-project × per-memType DBs · vec0 1024-dim · embedding_cache
└─ Base        SQLite (WAL) · sqlite-vec · periodic tasks
```

- **Emotion-anchored scoring**: `rawScore = 0.30·consistency (cap 0.7) + 0.45·emotion + 0.15·recency + 0.10·deviationBonus`; multiplied by importance × tier × bias × access boost
- **Memory lifecycle**: save (dedup exact + vector) → VAD queue (async batch) → digest (classify/tag/cleanup) → reflection (merge/extract/reclassify via receipts) → consolidate (decay + reference boost)
- **Per-persona partitioning**: agent state / topic biases / user profile are keyed by resolved charId — switching project switches persona. Memory recall itself is partitioned by **project** (+ memType folder), so a persona change never hides its own history.

## Credits & Upstream

Castalia Anima is an independent, emotion-focused evolution of Castalia. Design and storage patterns informed by:

- **[Castalia](https://github.com/ehwin/Castalia)** — the neutral general-purpose variant; Anima inherits its full engine architecture (and re-syncs it as it evolves)
- **Claude Code** (Anthropic) — closed memory types (user/feedback/project/reference), MEMORY.md index, progressive session maintenance
- **engram** — profile-gated tool exposure, setup script
- **memory-os / cognitive-memory** — local vector storage patterns
- **SynaBun** — hierarchical categories and smart-relevance weighting ideas
- **千问 (Qwen) architecture suggestions** — agent self-state (mood/desire/energy) design inspiration

License: MIT, see `LICENSE`.

## Troubleshooting

- Embedding service down → `memory_save` reports embed failure; check `curl http://127.0.0.1:11436/health`. Requests now time out after `EMBED_TIMEOUT_MS` (30s) instead of hanging forever
- Empty search results → lower `SEARCH_MIN_SCORE`, or verify `CHAR_ID`/memType match the writer (recall filters on project + memType, not on persona)
- Persona not switching → check `memory/config.json` `personas` section (restart server after edit)
- MCP tools not appearing → restart the client; ensure `command` is an absolute path to `node.exe` on Windows
