# Castalia Anima — Emotional Memory Server (MCP)

**The emotional variant of [Castalia](https://github.com/ehwin/Castalia).** Same architecture (SQLite + sqlite-vec local memory, zero API cost), with a personality layer on top: agent self-state (mood/desire/energy), bias layer, user learning, and emotion-weighted search.

Neutral core stays in Castalia; Anima feeds emotional features back upstream — the two repos cross-pollinate.

> **Emotional edition (this repo).** For the neutral single-instance edition see **[Castalia](https://github.com/ehwin/Castalia)**; for the neutral full edition with cross-library federation (`reflect_all` / `memory_search_all` over `FEDERATION_DIRS`) see **[Castalia-Full](https://github.com/ehwin/Castalia-Full)**.

> 📖 详细技术设计见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

---

## Quick Start

### 1. Build + verify

```bash
npm install
npm run build                  # tsc → dist/index.js
```

### 2. Start the embedding service (first load ~30-60s)

Any Ollama-compatible embed service works — point `OLLAMA_URL` + `EMBEDDING_MODEL` at it.

```bat
scripts\start-embed.bat
```

### 3. Configure LLM channels (optional but recommended)

Copy `memory/config.json` from the template (or create it) to wire the two LLM channels:

```json
{
  "triage":   { "llm_url": "https://api.deepseek.com/v1", "api_key": "sk-...", "model": "deepseek-chat" },
  "reflect":  { "llm_url": "https://api.deepseek.com/v1", "api_key": "sk-...", "model": "deepseek-chat" },
  "embedding": { "mode": "ollama", "ollama_url": "http://127.0.0.1:11436", "model": "yuan-embedding-2.0-zh" }
}
```

`triage` is optional — unset values fall back to `reflect`. Without any LLM key, the server still works fully as a read/write memory store; only reflection/triage are skipped.

> 🔐 **Recommended: encrypt API keys** (not plaintext in config.json) — three-channel keys via `scripts/keygen.js` into `memory/keys.enc` (AES-256-GCM, key in `memory/keys.key`, both git-ignored).

### 4. Connect from your MCP client

```json
{
  "mcpServers": {
    "anima-memory": {
      "command": "node",
      "args": ["<path>/dist/index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_DIR": "<path>/memory",
        "CHAR_ID": "anima"
      }
    }
  }
}
```

---

## Features

### Personality layer (Anima-only)

| Capability | Description |
|-----------|-------------|
| **Agent self-state** | mood / desire / energy with exponential-decay aggregation; `|value|>=7` auto-persisted |
| **Emotion-weighted search** | Alaya scoring: 1.2×similarity + 0.3×time_decay + 0.1×emotion |
| **Time decay** | Ebbinghaus forgetting curve, 30-day half-life |
| **Bias layer** | topic weight accumulation, affects retrieval priority |
| **User Learning** | observes user communication patterns & interests |
| **Character ID** | multi-character support |
| **Agent prompt injection** | `[Anima current state]` + `[user profile]` + `[interest trends]` bundle |

### Core memory (shared with Castalia)

- **memdir storage**: `memory/<project>/<memType>/memory.sqlite` — per-project, user/feedback/project/reference/general folders
- 29+ MCP tools: memory CRUD, search (profiles: quick/balanced/deep), instructions (3 layers), reflection (auto/deep/analyze/apply), consolidation, conversation automation (auto_process/digest)
- **Injection-ready context**: `memory_context` → 三层指令 + recent + related + facts + session rolling state, with Memory Snapshot Warning
- **Progressive reflection**: session buffer (5 turns / 4000 tokens dual threshold) + digest cycle
- **3D Star Map**: three-layer galaxy layout (project → memType → fixed-orbit nodes), semantic clusters, directional bridges, starfield background

## Scoring formula

```
score = (1.2 × similarity + 0.3 × time_decay + 0.1 × emotion) × importance × access_freq × bias
```

where:
- similarity — embedding cosine (any Ollama-compatible /api/embed)
- time_decay — e^(-t/S), S = HALF_LIFE_DAYS / ln(2)
- emotion — |emotionalImpact| / 10
- importance — 0.5 + importance (0.5 ~ 1.5)
- access_freq — 1 + min(0.5, log2(1 + accessCount) × 0.1)
- bias — 1 + min(0.5, topicWeight × 0.05)

## Preset categories

```
├ entity       — entity memories (people, places, things)
│ └ relationship — relationship memories
├ episodic     — event memories
│ ├ conversation — dialog memories
│ ├ emotional    — emotional experiences ⭐
│ └ milestone    — growth milestones ⭐
├ preference   — user preferences and habits
└ semantic     — factual knowledge
  ├ identity     — identity info
  └ knowledge    — knowledge facts
```

## File structure

```
├ src/
│   index.ts         — MCP server entry (29+ tools)
│   db.ts            — SQLite + memdir database manager
│   ollama.ts        — embedding client (per-project isolation)
│   store.ts         — memory store + dedup + auto consolidation
│   search.ts        — Alaya scoring search + bias weighting
│   category.ts      — hierarchical category management
│   consolidate.ts   — memory consolidation
│   agentState.ts    — agent self-state (mood/desire/energy)  [Anima]
│   bias.ts          — bias layer (topic weight accumulation) [Anima]
│   emotion.ts       — emotion extraction                      [Anima]
│   userLearning.ts  — user communication pattern learning     [Anima]
├ dist/              — compiled output
├ memory/            — DB files (memdir layout)
├ package.json
├ tsconfig.json
└ README.md
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | http://127.0.0.1:11436 | embedding API endpoint |
| `EMBEDDING_MODEL` | yuan-embedding-2.0-zh | embedding model name |
| `MEMORY_DB_DIR` | ./memory | memdir root for per-project/per-type DBs |
| `CHAR_ID` | default | character/agent identity for multi-char support |
| `WEIGHT_SIMILARITY` | 1.2 | similarity weight |
| `WEIGHT_TIME_DECAY` | 0.3 | time-decay weight |
| `WEIGHT_EMOTION` | 0.1 | emotion weight |
| `HALF_LIFE_DAYS` | 30 | time-decay half-life (days) |

## Search profiles

| Profile | topK | minScore | Use |
|---------|------|----------|-----|
| `quick` | 3 | 0.6 | fast recall, high precision |
| `balanced` | 5 | 0.3 | default, balanced |
| `deep` | 10 | 0.1 | deep recall, more related |

## Credits & Upstream

- **[Castalia](https://github.com/ehwin/Castalia)** — the neutral single-instance core this project builds on
- **[Castalia-Full](https://github.com/ehwin/Castalia-Full)** — the neutral full edition with cross-library federation
- The three repos cross-pollinate (Anima feeds emotional features upstream, Castalia keeps the neutral core stable)
- **cognitive-memory** (Apache-2.0) — schema & vector KNN concepts (code heavily rewritten)
- **Claude Code** (Anthropic) — closed memory types, MEMORY.md index, progressive session maintenance patterns (re-implemented in SQLite)

License: MIT, see `LICENSE`.
