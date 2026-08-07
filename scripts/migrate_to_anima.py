#!/usr/bin/env python3
"""migrate_to_anima.py — 主系统单库 → anima 标准分库迁移

迁移内容(仅数据,向量由 reflect_batch_embed 重建):
  - memory 260 行(project='default' 统一)
  - edges 148 行
  - facts 18 行
"""
import sqlite3
import sys

OLD = r"D:\system\AIRI\memory\memory-fused\memory.sqlite"
NEW = r"/path\anima-run\memory\project-default.sqlite"

old = sqlite3.connect(OLD)
new = sqlite3.connect(NEW)
old.execute("PRAGMA busy_timeout = 10000")
new.execute("PRAGMA busy_timeout = 10000")

# 1. memory(29 列对齐)
old_cols = [r[1] for r in old.execute("PRAGMA table_info(memory)")]
new_cols = [r[1] for r in new.execute("PRAGMA table_info(memory)")]
assert set(old_cols) == set(new_cols), f"列不一致: {set(old_cols) ^ set(new_cols)}"
col_sql = ", ".join(new_cols)
rows = old.execute(f"SELECT {col_sql} FROM memory").fetchall()
new.executemany(f"INSERT INTO memory ({col_sql}) VALUES ({','.join(['?']*len(new_cols))})", rows)
print(f"memory: {len(rows)} 行 ✓")

# 2. edges(列一致)
old_edges = [r[1] for r in old.execute("PRAGMA table_info(edges)")]
new_edges = [r[1] for r in new.execute("PRAGMA table_info(edges)")]
assert old_edges == new_edges
esql = ", ".join(old_edges)
erows = old.execute(f"SELECT {esql} FROM edges").fetchall()
new.executemany(f"INSERT INTO edges ({esql}) VALUES ({','.join(['?']*len(old_edges))})", erows)
print(f"edges: {len(erows)} 行 ✓")

# 3. facts(列对齐,顺序不同)
of = [r[1] for r in old.execute("PRAGMA table_info(facts)")]
nf = [r[1] for r in new.execute("PRAGMA table_info(facts)")]
assert set(of) == set(nf), f"facts 列不一致: {set(of) ^ set(nf)}"
fsql = ", ".join(nf)
frows = old.execute(f"SELECT {fsql} FROM facts").fetchall()
new.executemany(f"INSERT INTO facts ({fsql}) VALUES ({','.join(['?']*len(nf))})", frows)
print(f"facts: {len(frows)} 行 ✓")

new.commit()
new.close()
old.close()

# 验证
v = sqlite3.connect(NEW)
for t in ["memory", "edges", "facts"]:
    print(f"验证 {t}: {v.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]} 行")
v.close()
print("\n迁移完成(向量待 reflect_batch_embed 重建)")
