#!/usr/bin/env python3
"""verify_emotion_placement.py — 验证情感样本是否正确落到"情感分区"(memType=project)

链路:conversation_save(情感样本)→ reflect_auto(真实 LLM 提取)→ 检查落库位置
检查项:
  1. 提取出的情感记忆 memType 是否 = project(情感分区)
  2. category 是否 = emotional
  3. 文本是否带 "# 情感记忆:" 标题(normalizeMarkdown 包装)
  4. 能否在情感区检索到(memory_search)
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

RC = os.path.join(os.path.dirname(ROOT), "unified-proxy", "reflect-config.json")
api_key = ""
try:
    with open(RC, encoding="utf-8") as f:
        api_key = (json.load(f).get("api_key") or "").strip()
except Exception as e:
    print(f"[warn] 读 reflect-config.json 失败: {e}")

WORK = tempfile.mkdtemp(prefix="verify_emo_", dir=ROOT)
DB = os.path.join(WORK, "verify.sqlite")

env = {**os.environ, **{
    "MCP_TOOLS": "all",
    "OLLAMA_URL": "http://127.0.0.1:11435",
    "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
    "MEMORY_DB_PATH": DB,
    "CHAR_ID": "airi",
    "REFLECT_LLM_URL": "https://api.deepseek.com/v1",
    "REFLECT_LLM_API_KEY": api_key,
    "REFLECT_LLM_MODEL": "deepseek-chat",
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

try:
    if not api_key:
        print("=== REFLECT KEY 缺失,无法真实反思 ===")
        sys.exit(2)

    call_rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "verify", "version": "1.0"}})

    # 1. 灌一条情感样本
    r = unwrap(call_tool("conversation_save", {
        "userMessage": "今天又加班到十点,好累,但看到你发的消息心情好了一点",
        "assistantMessage": "加班辛苦了,记得喝点水",
    }))
    print(f"[1] 情感样本已入对话日志 saved={r.get('ok')}")

    # 2. 跑真实反思
    print("[2] reflect_auto(真实 DeepSeek)...")
    t0 = time.time()
    r = unwrap(call_tool("reflect_auto", {"limit": 30}))
    print(f"    耗时 {time.time()-t0:.1f}s | ok={r.get('ok')} actions={r.get('actions')} applied={r.get('applied')}")

    # 3. 找出提取出的情感记忆(memType=project 或 category=emotional)
    st = unwrap(call_tool("stats_get", {}))
    print(f"[3] 落库统计 total={st.get('total')} byMemType={st.get('byMemType')} byCategory={st.get('byCategory')}")

    emo = unwrap(call_tool("memory_list", {"category": "emotional"}))
    print(f"[4] category=emotional 的记忆数: {emo.get('count')}")
    for m in emo.get("results", []):
        print(f"    - id={m.get('id')[:8]} memType={m.get('memType')} category={m.get('category')} text={m.get('text','')[:50]}")

    # 5. memory_get 逐字段验证"安装位置"
    for m in emo.get("results", []):
        g = unwrap(call_tool("memory_get", {"id": m.get("id")}))
        res = g.get("result", {})
        print(f"\n[5] memory_get 逐字段检查:")
        print(f"    memType = {res.get('memType')}   (期望 project)")
        print(f"    category = {res.get('category')}   (期望 emotional)")
        print(f"    tier = {res.get('tier')}")
        print(f"    text 首行 = {res.get('text','').splitlines()[0] if res.get('text') else ''}   (期望 # 情感记忆:)")
        ok = res.get("memType") == "project" and res.get("category") == "emotional"
        print(f"    >>> 情感样本安装位置 {'✅ 正确(情感分区)' if ok else '❌ 不正确'}")

    # 6. 检索验证:在情感区能搜到
    s = unwrap(call_tool("memory_search", {"query": "加班 心情", "topK": 3}))
    print(f"\n[6] memory_search('加班 心情') count={s.get('count')}")
    for x in s.get("results", []):
        print(f"    - [{x.get('memType')}/{x.get('category')}] {x.get('text','')[:40]} score={x.get('score')}")

    print("\n=== VERIFY EMOTION PLACEMENT DONE ===")
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
