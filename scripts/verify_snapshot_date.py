#!/usr/bin/env python3
"""verify_snapshot_date.py — 验证 Snapshot Warning 含确切日期(用户要求:几天→确切日期)

行为:memory_save 一条 → UPDATE created_at 到 2 天前 → memory_context(hoursBack=72)
断言注入 prompt 含 "记录于 <YYYY-MM-DD>(约 2 天前)"。
"""
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which('node') or r"D:\system\New Folder\node.exe"
SERVER = os.path.join(ROOT, "dist", "index.js")

WORK = tempfile.mkdtemp(prefix="snap_date_", dir=ROOT)
DB = os.path.join(WORK, "snap.sqlite")

env = {**os.environ, **{
    "MCP_TOOLS": "all",
    "OLLAMA_URL": "http://127.0.0.1:11435",
    "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
    "MEMORY_DB_PATH": DB,
    "CHAR_ID": "airi",
}}
proc = subprocess.Popen(
    [NODE, SERVER],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    env=env, cwd=ROOT, text=True,
)
buf = {"id": 0}

def call_rpc(method, params=None):
    buf["id"] += 1
    req = {"jsonrpc": "2.0", "id": buf["id"], "method": method, "params": params or {}}
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("id") == buf["id"]:
            return msg

def call_tool(name, args=None):
    return call_rpc("tools/call", {"name": name, "arguments": args or {}})

def unwrap(msg):
    return json.loads(msg["result"]["content"][0]["text"])

failed = 0
def check(label, cond, extra=""):
    global failed
    if not cond:
        failed += 1
    print(f"[{'PASS' if cond else 'FAIL'}] {label} {extra}")

try:
    call_rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "snap", "version": "1.0"}})

    r = unwrap(call_tool("memory_save", {"text": "数据库端口是 5433,连接串用 localhost:5433", "importance": 0.8}))
    mid = r.get("id")
    check("memory_save 成功", r.get("ok") is True)

    # 把 created_at 改成 2 天前(直接 SQL,模拟旧记忆)
    two_days_ago = (datetime.datetime.utcnow() - datetime.timedelta(days=2)).isoformat() + "Z"
    db = sqlite3.connect(DB)
    db.execute("UPDATE memory SET created_at = ? WHERE id = ?", (two_days_ago, mid))
    db.commit()
    db.close()

    # memory_context 拉 72h 窗口,注入应带 Snapshot Warning(不传 project,用默认人格 airi)
    mc = unwrap(call_tool("memory_context", {"hoursBack": 72, "recentLimit": 5}))
    prompt = mc.get("prompt", "")
    expect_date = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()

    check("prompt 含 Snapshot Warning", "Memory Snapshot Warning" in prompt)
    check(f"prompt 含确切日期 {expect_date}", expect_date in prompt, f"prompt={[l for l in prompt.splitlines() if 'Warning' in l][:1]}")
    check("prompt 含 '约 2 天前'", "约 2 天前" in prompt)
    warn_line = [l for l in prompt.splitlines() if "Warning" in l]
    if warn_line:
        print(f"    实际警告行: {warn_line[0].strip()}")

    print(f"\n=== SNAPSHOT DATE {'ALL PASSED' if failed == 0 else f'{failed} FAILED'} ===")
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    shutil.rmtree(WORK, ignore_errors=True)

sys.exit(1 if failed else 0)
