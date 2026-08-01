# AIRI 记忆系统 · v5.0 完整技术文档

> 更新：2026-07-05 凌晨  
> 代码路径：`D:\system\AIRI\memory\memory-fused` + `D:\system\AIRI\memory\unified-proxy`

---

## 一、v5.0 核心改动

| # | 改动 | 效果 |
|---|------|------|
| 1 | **标签优先搜索** | memory_search 先走 tag LIKE 匹配，不足才回退向量 KNN（大幅减少向量调用） |
| 2 | **延迟向量化** | digest 分拣后不 embed（skipEmbed=true），reflect 确认后统一向量化 |
| 3 | **向量模型换 Yuan + fp16** | 内存 6GB → ~2GB，1024 维，空闲 10min 自动卸载 |
| 4 | **LLM 生成标签** | reflect 阶段 DeepSeek V4 Pro 提取 1-3 个中文标签 |
| 5 | **0.6B 只做分拣** | 仅识别 speaker + tier + emotionalImpact，不打标签 |
| 6 | **事件驱动 digest** | 有新对话才跑，≥1min 间隔，不空转 |
| 7 | **维度自动迁移** | db.ts 启动时检测旧 4096 维表，自动 DROP 重建 1024 维 |
| 8 | **锁定机制** | `locked=1` 的记忆（manual_lore + critical）reflect 永不修改 |
| 9 | **extract 动作** | 从对话中提取有效记忆（身份/偏好/情感/知识），不删除源 |
| 10 | **长时校准** | 全量记忆深度分析：去重、用户画像、知识图谱、降噪 |

---

## 二、系统架构

```
AIRI (Electron) → proxy.py :5050 → DeepSeek API (LLM)
                    ├─ MemoryEngine (Node 子进程)
                    │    ├─ SQLite + sqlite-vec (1024 维)
                    │    ├─ Yuan-EB :11435 (嵌入, fp16, ~2GB)
                    │    └─ Lemonade :13305 (0.6B 分拣器)
                    └─ reflect.py → DeepSeek V4 Pro (日常整理 + 长时校准)
```

| 组件 | 端口 | 模型 | 内存 | 职责 |
|------|------|------|------|------|
| proxy.py | 5050 | — | ~40MB | HTTP 代理：LLM 转发 + 对话拦截 + 记忆触发 |
| MemoryEngine | stdio | — | ~100MB | 记忆引擎核心：存储、搜索、分类、清理 |
| Yuan-EB | 11435 | Yuan-embedding-2.0-zh (fp16) | ~2GB | 文本→1024 维向量 |
| Lemonade | 13305 | qwen3.5-0.6b | ~500MB | speaker + tier 分拣 |
| reflect.py | — | DeepSeek V4 Pro | — | 日记整理 + 标签提取 + 深度校准 |
| SQLite | 文件 | better-sqlite3 + sqlite-vec | — | 记忆存储 + KNN |

---

## 三、数据流

### 3.1 对话写入（每轮自动触发）

```
autoProcess() → saveConversationTurn() → SQLite (conversation_log, 永不 embed)
              → 触发 maybeDigest()（≥1min 间隔，事件驱动）
```

### 3.2 分拣（事件驱动，≥1min）

```
maybeDigest() → 扫描未分析 conversation_log
              → 0.6B classifyConversation() → speaker + tier + emotionalImpact
              → saveMemory(skipEmbed=true) → 暂不向量化
              → 标记原文已分析
```

### 3.3 搜索（标签优先 + 向量回退）

```
memory_search(query)
  → Phase 1: extractKeywords() → tagSearch() (SQL LIKE, 0 次向量调用)
     → 结果足够（≥topK 且首条 score≥0.5）→ 直接返回 ✅
  → Phase 2: embed(query) → vectorKnnSearch() → 合并去重
```

### 3.4 反思 — 日常整理（手动触发）

```
reflect.py → listAllMemories() → DeepSeek V4 Pro
           → LLM 输出：merge/split/reclassify/extract + 1-3 个 newTags
           → applyReflectActions()
              ├─ merge: 删旧向量 + 新记忆 embed
              ├─ extract: 创建独立记忆（不删源）
              ├─ reclassify: 更新 type/category/tags
              └─ batchEmbedPending() → 补全 digest 跳过的向量
```

### 3.5 反思 — 长时校准（手动触发）

```
run_deep_reflect() → listAllMemories(含 locked 记忆供上下文)
                   → DeepSeek V4 Pro 深度分析
                   → 去重合并 + 用户画像 + 知识图谱 + 降噪
                   → applyReflectActions()
```

---

## 四、记忆分类体系

| category | 含义 | tier | 锁定 |
|----------|------|------|------|
| identity | 身份/生日/别名/背景故事 | critical | 🔒 |
| milestone | 里程碑事件（第一次、入职、重要决定） | critical | 🔒 |
| relationship | 核心关系与约定 | critical | 🔒 |
| preference | 用户偏好/习惯 | standard | — |
| emotional | 深层情感模式/性格洞察 | standard | — |
| knowledge | 学到的知识点 | standard | — |
| conversation | 日记浓缩 | standard | — |
| mood_snapshot | 当天临时情绪 | temporary (3天TTL) | — |

---

## 五、数据库

### 向量表（1024 维）

```sql
CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[1024]);
CREATE VIRTUAL TABLE vec_facts USING vec0(embedding float[1024]);
```

### 版本迁移

`db.ts` 启动时检测 `_schema_version`，版本 < 5 时自动：
- `DROP TABLE vec_memory` / `vec_facts`
- 清空 `embedding_cache`
- 重建 1024 维表

### 锁定字段

```sql
ALTER TABLE memory ADD COLUMN locked INTEGER DEFAULT 0;
-- 锁定所有 manual_lore
UPDATE memory SET locked = 1 WHERE source = 'manual_lore';
-- 锁定所有 critical
UPDATE memory SET locked = 1 WHERE tier = 'critical';
```

---

## 六、文件职责速查

| 文件 | 语言 | v5.0 关键改动 |
|------|------|--------------|
| `yuan_embed_server.py` | Python | fp16 加载 + 空闲自动卸载 |
| `db.ts` | TS | vec 维度 1024 + v5 自动迁移 + locked 字段 |
| `ollama.ts` | TS | 默认 URL→11435, 模型→yuan-embedding-2.0-zh |
| `store.ts` | TS | skipEmbed + reEmbedMemory + batchEmbedPending |
| `autoProcessor.ts` | TS | 0.6B prompt 精简：只做 speaker+tier |
| `digest.ts` | TS | 事件驱动 maybeDigest + skipEmbed=true |
| `search.ts` | TS | 标签优先搜索 → 不足回退向量 KNN |
| `reflect.py` | Python | 日常整理 + 长时校准 + 5 层 JSON 自动修复 |
| `reflect.ts` | TS | merge/delete/extract/reclassify + LIKE 短 ID 匹配 |
| `memory_engine.py` | Python | digest 事件驱动 + autoProcess 后触发 |
| `proxy.py` | Python | + /memory/delete + /memory/reflect-deep 路由 |
| `reflect-admin.html` | HTML | 记忆管理面板 + 日常整理/长时校准按钮 |

---

## 七、配置

```python
# config.py
OLLAMA_URL = "http://127.0.0.1:11435"      # Yuan-EB embed server
EMBEDDING_MODEL = "yuan-embedding-2.0-zh"   # 1024 维 fp16
LEMONADE_URL = "http://127.0.0.1:13305/v1"
ANALYZER_MODEL = "qwen3.5-0.6b"             # 仅分拣
```

### 定时任务

| 任务 | 间隔 | 触发 |
|------|------|------|
| digest 分拣 | 事件驱动 (≥1min) | autoProcess 后触发 maybeDigest |
| TTL 清理 | digest 每次执行 | cleanupExpiredMemories() |
| consolidate | 6h + 每 50 次 saveMemory | MemoryEngine |
| Yuan 模型卸载 | 空闲 10min | yuan_embed_server.py 后台线程 |

---

## 八、端口速查

| 端口 | 服务 | 启动命令 |
|------|------|----------|
| 5050 | proxy.py | `python proxy.py` |
| 11435 | yuan_embed_server.py | `python yuan_embed_server.py 11435` |
| 13305 | Lemonade 分拣 | 独立启动 |
| 3344 | 记忆星图 viz | 管理面板点"记忆星图" |

---

## 九、版本演进

| 日期 | 版本 | 里程碑 |
|------|------|--------|
| 07-01 | — | AIRI 0.10.2 环境确认 |
| 07-02 | v1.0 | 25 工具 + 7 Hook |
| 07-03 | v2.0-4.0 | Hook→代理拦截 + 三层体系 |
| 07-04 | **v5.0** | 标签优先搜索 + 延迟向量化 + fp16 Yuan + LLM 标签 + 锁定机制 + 长时校准 |
