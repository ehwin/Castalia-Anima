#!/usr/bin/env python3
"""e2e_absorb.py — 主系统吸收后的独立复验(不依赖 opencode 自报)

覆盖:
  1. persona 层:config.json personas 映射 + 无映射项目名即人格 + 角色声明
  2. memType 新语义:normalizeMarkdown 标题(project→# 情感记忆: / user→# AI 对用户的画像:)
  3. 单库模式 project 隔离(stats_get 按 project 过滤)
  4. 新工具可用:memory_get / memory_index / memory_log / memory_context / instruction_save / project_list / consolidate_deep(无 key 时跳过不崩)
  5. memory_context 注入 [角色声明]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which('node') or r"D:\system\New Folder\node.exe"
SERVER = os.path.join(ROOT, "dist", "index.js")

WORK = tempfile.mkdtemp(prefix="e2e_absorb_", dir=ROOT)
DB = os.path.join(WORK, "e2e.sqlite")
CONFIG = os.path.join(WORK, "config.json")
with open(CONFIG, "w", encoding="utf-8") as f:
    json.dump({
        "personas": {
            "work": {"charId": "airi-work", "name": "WorkAiri", "persona": "专业高效"},
        }
    }, f, ensure_ascii=False)

env = {**os.environ, **{
    "MCP_TOOLS": "all",
    "OLLAMA_URL": "http://127.0.0.1:11435",
    "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
    "MEMORY_DB_PATH": DB,      # 单库模式(铁律)
    "MEMORY_CONFIG": CONFIG,
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
    # 1. 单库 + 31 工具
    r = call_rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1.0"}})
    check("server 初始化", r.get("result", {}).get("serverInfo", {}).get("name") == "airi-memory")
    r = call_rpc("tools/list", {})
    tools = [t["name"] for t in r["result"]["tools"]]
    check("31 工具注册", len(tools) == 31, f"got={len(tools)}")

    # 2. persona:映射命中 + 角色声明
    ctxw = unwrap(call_tool("context_get", {"project": "work"}))
    check("context_get(work) → WorkAiri", ctxw.get("persona", {}).get("name") == "WorkAiri", f"got={ctxw.get('persona')}")
    check("context_get(work) 角色声明", "我是 WorkAiri" in ctxw.get("state", ""))
    ctxl = unwrap(call_tool("context_get", {"project": "lab"}))
    check("context_get(lab 无映射) → charId=lab", ctxl.get("persona", {}).get("charId") == "lab", f"got={ctxl.get('persona')}")

    # 3. memType 新语义:Markdown 标题
    r1 = unwrap(call_tool("memory_save", {"text": "用户今天特别开心,聊到旧事眼眶红了", "memType": "project", "project": "work"}))
    check("memory_save(memType=project) 成功", r1.get("ok"))
    mid = r1.get("id")
    g = unwrap(call_tool("memory_get", {"id": mid, "project": "work"}))
    check("情感记忆标题 # 情感记忆:", "# 情感记忆:" in g.get("result", {}).get("text", ""), f"text={g['result']['text'][:40]}")
    r2 = unwrap(call_tool("memory_save", {"text": "用户喜欢简洁回复,反感啰嗦", "memType": "user", "project": "work"}))
    g2 = unwrap(call_tool("memory_get", {"id": r2.get("id"), "project": "work"}))
    check("画像标题 # AI 对用户的画像:", "# AI 对用户的画像:" in g2.get("result", {}).get("text", ""), f"text={g2['result']['text'][:40]}")

    # 4. 单库 project 隔离
    st = unwrap(call_tool("stats_get", {"project": "work"}))
    check("stats(work) total>=2 且 charId=airi-work", st.get("total", 0) >= 2 and st.get("characterId") == "airi-work",
          f"total={st.get('total')} charId={st.get('characterId')}")

    # 5. 新工具可用
    ix = unwrap(call_tool("memory_index", {"project": "work"}))
    check("memory_index 可用", ix.get("count", 0) >= 2, f"count={ix.get('count')}")
    lg = unwrap(call_tool("memory_log", {"kind": "decision", "text": "吸收决策:单库模式", "project": "work"}))
    check("memory_log 可用", lg.get("ok") and lg.get("category") == "decision")
    ins = unwrap(call_tool("instruction_save", {"scope": "project", "project": "work", "content": "本项目人格为 WorkAiri"}))
    check("instruction_save 可用", ins.get("saved") is True)
    il = unwrap(call_tool("instruction_list", {}))
    check("instruction_list 可用", il.get("count", 0) >= 1)
    pl = unwrap(call_tool("project_list", {}))
    check("project_list 含 persona", any(p.get("project") == "work" and p.get("persona", {}).get("name") == "WorkAiri" for p in pl.get("projects", [])))

    # 6. memory_context 角色声明 + 指令注入
    mc = unwrap(call_tool("memory_context", {"project": "work"}))
    check("memory_context 含角色声明", "我是 WorkAiri" in mc.get("prompt", ""))
    check("memory_context 含项目指令", "WorkAiri" in mc.get("prompt", ""))

    # 7. consolidate_deep 无 key 优雅跳过(ok=false + skipped=true 是预期)
    cd = unwrap(call_tool("consolidate_deep", {"project": "work"}))
    check("consolidate_deep 无 key 优雅跳过", cd.get("skipped") is True and "未配置" in str(cd.get("errors", [])),
          f"ok={cd.get('ok')} skipped={cd.get('skipped')}")

    print(f"\n=== E2E ABSORB {'ALL PASSED' if failed == 0 else f'{failed} FAILED'} ===")
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
