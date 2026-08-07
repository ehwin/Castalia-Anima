#!/usr/bin/env python3
"""import_corpus_real.py — 语料最终落库(真实库)+ 全库深度校准

1. 语料 3 条 memory_save 落真实库(不带 memType,全权交 LLM)
2. reflect_deep 全库深度校准(真实 LLM):让 LLM 自动归类
3. 展示语料最终位置 + 全库归类统计
"""
import json
import os
import shutil
import subprocess
import sys
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

env = {**os.environ, **{
    "MCP_TOOLS": "all",
    "OLLAMA_URL": "http://127.0.0.1:11435",
    "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
    "MEMORY_DB_PATH": os.path.join(ROOT, "memory.sqlite"),
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
        print("=== REFLECT KEY 缺失 ===")
        sys.exit(2)
    call_rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "import", "version": "1.0"}})

    # 1. 灌入语料
    with open(os.path.join(ROOT, "scripts", "corpus_legacy.json"), encoding="utf-8") as f:
        corpus = json.load(f)["memories"]
    print(f"[1] 语料 {len(corpus)} 条落真实库(不带 memType)...")
    for m in corpus:
        r = unwrap(call_tool("memory_save", {"text": m["text"], "tags": m["tags"], "source": "legacy_import"}))
        print(f"    saved id={r.get('id','')[:8]}")

    st0 = unwrap(call_tool("stats_get", {}))
    print(f"[2] 灌入后 total={st0.get('total')} byMemType={st0.get('byMemType')}")

    # 2. 全库深度校准
    print("[3] reflect_deep(全库深度校准,真实 LLM)... 这会对全部记忆做去重/画像/归类")
    t0 = time.time()
    r = unwrap(call_tool("reflect_auto", {"mode": "deep", "limit": 500}))
    print(f"    耗时 {time.time()-t0:.1f}s | ok={r.get('ok')} actions={r.get('actions')} applied={r.get('applied')}")
    print(f"    factsInserted={r.get('factsInserted')} factsUpdated={r.get('factsUpdated')} errors={len(r.get('errors') or [])}")
    if r.get("receipts"):
        from collections import Counter
        c = Counter(a.get("action") for a in r["receipts"])
        print(f"    动作分布: {dict(c)}")
        for a in r["receipts"][:8]:
            print(f"      {a.get('action')} {a.get('status')} target={str(a.get('targetId'))[:14]} {str(a.get('reason'))[:36]}")

    # 3. 语料 3 条的最终位置(按 source=legacy_import 或文本查)
    lst = unwrap(call_tool("memory_list", {"limit": 50}))
    print("\n[4] 语料 3 条的最终位置:")
    for m in lst.get("results", []):
        if m.get("source") == "legacy_import" or "第一次" in m.get("text", "") or "语音模块" in m.get("text", ""):
            print(f"    - [{m.get('memType')}/{m.get('category')}] {m.get('text','')[:42]}... source={m.get('source')}")

    st = unwrap(call_tool("stats_get", {}))
    print(f"\n[5] 全库最终: total={st.get('total')} byMemType={st.get('byMemType')}")
    print(f"    byCategory={st.get('byCategory')}")

    print("\n=== IMPORT + CALIBRATE DONE ===")
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
