# AIRI 记忆系统 · Debug 速查手册

> 更新：2026-07-05 凌晨  
> 覆盖：proxy.py / MemoryEngine / reflect.py / yuan_embed_server.py

---

## 一、快速诊断三步

```bash
# 1. 代理活着吗？
curl -s http://127.0.0.1:5050/health
# 正常返回: {"status":"ok","memory_engine":"alive",...}

# 2. MemoryEngine 活着吗？
# 看 health 里的 memory_engine 字段，或查日志:
type D:\system\AIRI\airi-unified-proxy\unified-proxy.log | findstr "ERROR\|WARNING\|SyntaxError"

# 3. reflect.py 能导入吗？
cd D:\system\AIRI\airi-unified-proxy
python -c "import reflect; print('OK')"
```

---

## 二、常见 Bug & 修复

### Bug 1: `500 Internal Server Error` — reflect.py 导入失败

**现象**：管理面板加载配置提示 `Unexpected token '<'`

**根因**：reflect.py 有语法错误，proxy.py import 时报 500

**诊断**：
```bash
cd D:\system\AIRI\airi-unified-proxy
python -c "import reflect; print('OK')"
```

**常见原因**：
- **嵌套 f-string 中文编码炸**：`f"...{f'...中文...'}..."` 多层嵌套容易出问题
  - 修复：拆成变量 `msg = "..."` → `f"...{msg}..."`
- **残留代码**：编辑后有多余的 `})` / `except` / `.run()` 等未闭合

---

### Bug 2: MemoryEngine `Identifier has already been declared`

**现象**：日志疯狂刷 `getAgentState has already been declared`，MemoryEngine 反复重启

**根因**：dist/ 编译缓存损坏

**修复**：
```bash
cd D:\system\AIRI\airi-memory-fused
rmdir /s /q dist
npx tsc
```

---

### Bug 3: reflect merge 后旧记忆没被 deactivate（同一天出现多条重复日记）

**现象**：跑完 reflect，同一天有 7 条日记（4 条 digest + 3 条 merge）

**根因**：LLM 返回的 `sourceIds` 是 8 位短前缀（如 `"6c40363f"`），SQL `WHERE id = ?` 匹配不到完整 UUID

**修复**：所有 `WHERE id = ?` → `WHERE id LIKE ?`（参数加 `%` 后缀）

涉及文件：`src/reflect.ts` 中 merge/reclassify/delete/extract/boost/decay

---

### Bug 4: reclassify 全部失败 `need targetId`

**现象**：日志显示 8 条 `⚠️ reclassify: need targetId`

**根因**：LLM 用了 `sourceId`，代码只认 `targetId`（字段名不匹配）

**修复**：`src/reflect.ts` reclassify case 里：
```typescript
const tid = action.targetId || (action as any).sourceId;
```

---

### Bug 5: JSON 解析失败 `Expecting ',' delimiter`

**现象**：reflect 跑到最后报 JSON 解析错误

**根因**：LLM 返回的 JSON 有小毛病（尾部逗号、缺失逗号等）

**修复**：`reflect.py` 加 `_parse_json_robust()` 5 层自动修复策略

---

### Bug 6: 向量模型吃内存太大

**现象**：`python.exe` 占 4.3GB

**根因**：Yuan-EB 加载在 fp32 全精度

**修复**：`yuan_embed_server.py` 加 `torch_dtype=torch.float16` + 空闲 10min 自动卸载

---

### Bug 7: vec 维度不匹配

**现象**：embed 报错或搜索不到结果

**根因**：换了嵌入模型但 vec 表维度没变

**修复**：`db.ts` 加 `_schema_version` 自动迁移，首次启动检测旧维度并 DROP 重建

---

### Bug 8: 管理面板 SSE 日志不显示

**现象**：点"执行记忆整理"后日志区空白

**根因**：
1. reflect.py 返回 `data: {...}` SSE 格式，HTML 直接把整行当 JSON 解析（`data: ` 前缀导致失败）
2. 或者从 `file://` 打开 HTML，`API = ''` 请求发到了 `file:///admin/config`

**修复**：
1. HTML 解析前去掉 `data: ` 前缀
2. `const API = location.protocol === 'file:' ? 'http://127.0.0.1:5050' : ''`

---

## 三、重启流程

```bash
# 全杀
taskkill /F /IM python.exe

# 启动 Yuan 嵌入服务（等 10 秒模型加载）
cd D:\system\AIRI\airi-memory-fused
start /B python yuan_embed_server.py 11435

# 启动代理
cd D:\system\AIRI\airi-unified-proxy
start /B python proxy.py

# 验证
curl -s http://127.0.0.1:5050/health
```

---

## 四、手动修复数据库

```bash
cd D:\system\AIRI\airi-memory-fused
# 创建 .mjs 文件，内容：
import Database from 'better-sqlite3';
const db = new Database('./memory.sqlite');

# 查记忆
db.prepare("SELECT id,substr(text,1,80),category FROM memory WHERE ...").all()

# 改记忆
db.prepare("UPDATE memory SET text=? WHERE id LIKE ?").run('新文本', 'id前缀%')

# 删记忆
db.prepare("UPDATE memory SET is_active=0 WHERE id LIKE ?").run('id前缀%')
```

---

## 五、TypeScript 编译

```bash
cd D:\system\AIRI\airi-memory-fused
rmdir /s /q dist       # 出问题时先清
npx tsc                 # 编译
```

**编译后必须重启 proxy**（py 文件改动不需要编译）

---

## 六、锁定机制

| 字段 | 含义 |
|------|------|
| `locked=1` | LLM 绝对不碰（不 merge/reclassify/delete） |
| `tier=critical` | 搜索 3x 加权，不 merge 但可 reclassify |
| `is_active=0` | 软删除，搜索不可见 |

手动锁定：`UPDATE memory SET locked=1 WHERE source='manual_lore'`

---

## 七、端口速查

| 端口 | 服务 | 启动命令 |
|------|------|----------|
| 5050 | proxy.py | `python proxy.py` |
| 11435 | yuan_embed_server.py | `python yuan_embed_server.py 11435` |
| 13305 | Lemonade 0.6B 分拣 | 独立启动 |
| 3344 | 记忆星图 viz | 管理面板点"记忆星图" |
