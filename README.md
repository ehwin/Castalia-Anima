# Castalia Anima — Emotional Memory MCP Server

**Castalia Anima** is the personality-driven companion of [**Castalia**](https://github.com/ehwin/Castalia): a standalone MCP memory server with a full **emotion layer** on top of the neutral Castalia architecture. It inherits the entire Castalia v1.11 architecture (per-project DBs, 3-channel LLM pipeline, three-layer instructions, closed memory types, progressive session reflection, consolidation) and adds an emotional personality system — VAD 3D emotion analysis, tsundere detection, emotion-anchored retrieval, per-project personas.

Forked from [**Castalia**](https://github.com/ehwin/Castalia), extended with a full emotional personality layer. SQLite + sqlite-vec local vector storage, zero API cost for embeddings. Bring your own LLM for reflection/triage.

> **Relationship to Castalia**: Castalia is the neutral, general-purpose component (no personality). Castalia Anima is the emotional variant — same architecture, plus feelings. See [Credits & Upstream](#credits--upstream).

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
  - `charFor(project)`: persona map (config.json `personas`) → project name → default `CHAR_ID`
  - `[Role Declaration]` injected by `context_get` / `memory_context`; `persona` field in responses
  - Agent state (mood/energy/desire), topic biases and user profile are partitioned per persona
- **Full Castalia v1.11 architecture**
  - Per-project DB files (`memory/global.sqlite` + `project-<name>.sqlite`), lazy-created; legacy `MEMORY_DB_PATH` single-file mode supported
  - 3-channel LLM pipeline: LLM1 triage (inbound memType classification + incremental session reflection), vector model (embeddings), LLM2 reflect (daily reflection / deep calibration / consolidation)
  - Three-layer instructions (global / user / project + reusable rule groups, glob path filtering)
  - Closed memory types: user / feedback / project / reference (Markdown-normalized) + general fallback
  - Progressive session reflection: rolling session memory + promote-to-project (promote-and-delete) + TTL sweep; extraction-agent style prompts (Claude Code `extract_memories` lineage) with **output dedup** (text-normalized + vector-cosine pre-filter) so repeated insights never pile up
  - Memory consolidation: vector pre-screen similar pairs → LLM dedup / conflict resolution (never invent facts)
  - Per-action reflection receipts, persisted to `memory/receipts/` for audit
  - Snapshot warnings with exact dates for memories older than 24h
- **31 MCP tools**, profile-gated (`MCP_TOOLS`): agent 6 (read) / harness 12 (write+pipe) / admin 13 (manage)

## Quick Start

### 1. Build + verify

```bash
npm install
npm run build          # tsc, exit 0
python scripts/smoke_test.py   # 31 tools + CRUD + per-project isolation
```

### 2. Start the embedding service (first load ~30-60s)

```bash
scripts\start-embed.bat        # Ollama-compatible /api/embed on :11436, 1024-dim
```

Any Ollama-compatible `/api/embed` service outputting **1024-dim** vectors works — point `OLLAMA_URL` / `EMBEDDING_MODEL` at it, or use an OpenAI-compatible API with `EMBEDDING_API_KEY` (`EMBED_MODE=api`). `EMBED_MODE=none` disables embeddings entirely (tag/text fallback search).

### 3. Configure LLM channels (optional but recommended)

**API keys 请用加密存储(优先),不要再明文写进 `memory/config.json`:**

```bash
node scripts/keygen.js                                       # 交互式(回车 = 跳过保持原值)
node scripts/keygen.js --reflect-api-key sk-xxx \
                       --triage-api-key sk-xxx \
                       --embedding-api-key sk-xxx            # 命令行传入,未传的参数保持 keys.enc 原值
```

- 生成 `memory/keys.key`(32 字节随机密钥)+ `memory/keys.enc`(AES-256-GCM 加密负载),均与代码分离、已被 `.gitignore` 排除
- 启动时 `configLoader` 自动解密 `keys.enc` 注入环境变量(`REFLECT_LLM_API_KEY` / `TRIAGE_LLM_API_KEY` / `EMBEDDING_API_KEY`);优先级:显式环境变量 > keys.enc > config.json
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
      "args": ["D:\\AI\\AI memory\\dist\\index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_DIR": "D:\\AI\\AI memory\\memory",
        "CHAR_ID": "my-char",
        "MCP_TOOLS": "all"
      }
    }
  }
}
```

## Tools (31, profile-gated)

| Group | Tools |
|---|---|
| **agent** (6) | `memory_search` `memory_get` `memory_recent` `memory_index` `fact_search` `memory_graph` |
| **harness** (12) | `auto_process` `conversation_save` `digest_run` `reflect_auto` `reflect_deep` `reflect_batch_embed` `memory_save` `memory_update` `memory_delete` `memory_log` `instruction_save` `user_observe` |
| **admin** (13) | `memory_list` `stats_get` `recent_conversations` `daily_summary_data` `reflect_analyze` `reflect_apply` `memory_context` `context_get` `project_list` `instruction_list` `instruction_delete` `consolidate_deep` `mood_journal` |

## Environment Variables (key ones)

| Variable | Default | Meaning |
|---|---|---|
| `CHAR_ID` | `my-char` | Default persona/character ID (used when no persona map entry matches) |
| `CASTALIA_PROJECT` | `default` | Default project namespace |
| `MEMORY_DB_DIR` | `<cwd>/memory` | Per-project DB directory (`global.sqlite` + `project-*.sqlite`); `MEMORY_DB_PATH` → legacy single-file mode |
| `OLLAMA_URL` / `EMBEDDING_MODEL` | `:11434` / `yuan-embedding-2.0-zh` | Embedding service (1024-dim) |
| `EMBED_MODE` | `ollama` | `ollama` / `api` (needs `EMBEDDING_API_KEY`) / `none` |
| `REFLECT_LLM_*` | — | Reflection LLM (URL / API key / model) |
| `TRIAGE_LLM_*` | → `REFLECT_*` | Triage LLM channel (falls back to reflect) |
| `MCP_TOOLS` | `all` | `agent` / `harness` / `admin` / comma list / `all` |
| `WEIGHT_*` | 0.30/0.45/0.15/0.10 | Emotion-anchored search weights |
| `SEARCH_MIN_SCORE` | `0.15` | Vector search threshold |
| `VAD_MODEL` | `qwen3.5:2b` | Ollama model for VAD emotion analysis |
| `BUFFER_SIZE` / `SESSION_MEMORY_TTL_DAYS` | `5` / `7` | Session reflection buffer / TTL |

## Architecture Overview

```
┌─ Exposure    MCP stdio · 31 tools · agent/harness/admin gating (MCP_TOOLS)
├─ Cognition   reflect (LLM2) · triage (LLM1) · consolidate_deep
├─ Emotion     VAD engine · agentState · bias · userLearning      ← Anima
├─ Pipeline    auto_process → digest → session buffer → incremental reflection
├─ Storage     DatabaseManager · per-project DBs · vec0 1024-dim · embedding_cache
└─ Base        SQLite (WAL) · sqlite-vec · periodic tasks
```

- **Emotion-anchored scoring**: `rawScore = 0.30·consistency (cap 0.7) + 0.45·emotion + 0.15·recency + 0.10·deviationBonus`; multiplied by importance, tier (critical ×3), bias boost (1.0–1.5), access boost
- **Memory lifecycle**: save (dedup exact + vector) → VAD queue (async batch) → digest (classify/tag/cleanup) → reflection (merge/extract/reclassify/relate/delete with per-action receipts) → consolidation (similar-pair pre-screen → LLM)
- **Per-persona partitioning**: agent state / topic biases / user profile are keyed by resolved charId — switching project switches persona

## Credits & Upstream

Castalia Anima is an independent, emotion-focused evolution of Castalia. Design and storage patterns informed by:

- **[Castalia](https://github.com/ehwin/Castalia)** — the neutral general-purpose variant; Anima inherits its full v1.11 architecture (per-project DBs, 3-channel pipeline, three-layer instructions, closed memTypes, session reflection, consolidation). Architectures cross-pollinate between the two repos.
- **Claude Code** (Anthropic) — closed memory types (user/feedback/project/reference), MEMORY.md index, progressive session maintenance, consolidation sub-agent, snapshot warnings (patterns re-implemented in SQLite)
- **engram** — profile-gated tool exposure, setup script
- **memory-os / cognitive-memory** — local vector storage patterns
- **SynaBun** — hierarchical categories and smart-relevance weighting ideas
- **千问 (Qwen) architecture suggestions** — agent self-state (mood/desire/energy) design inspiration

License: MIT, see `LICENSE`.

## Troubleshooting

- Embedding service down → `memory_save` reports embed failure; check `curl http://127.0.0.1:11436/health`
- Empty search results → lower `SEARCH_MIN_SCORE`, or verify `CHAR_ID`/project match the writer
- Persona not switching → check `memory/config.json` `personas` section (restart server after edit)
- MCP tools not appearing → restart the client; ensure `command` is an absolute path to `node.exe` on Windows
