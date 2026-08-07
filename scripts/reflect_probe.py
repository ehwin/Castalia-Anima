#!/usr/bin/env python3
"""reflect_probe.py — 用户要求的反思验证:跑一轮真实 reflect_auto,看 memType 新语义分拣是否正确。

样本 4 轮对话(按新语义期望归类):
  1. 情感事件  → 期望 project(情感分区)
  2. 用户偏好  → 期望 user(AI 对用户的画像)
  3. 行为纠正  → 期望 feedback
  4. 外部链接  → 期望 reference
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

# 反思 key:从主系统 unified-proxy/reflect-config.json 读取(不打印)
RC = os.path.join(os.path.dirname(ROOT), "unified-proxy", "reflect-config.json")
api_key = ""
try:
    with open(RC, encoding="utf-8") as f:
        api_key = (json.load(f).get("api_key") or "").strip()
except Exception as e:
    print(f"[warn] 读 reflect-config.json 失败: {e}")

WORK = tempfile.mkdtemp(prefix="reflect_probe_", dir=ROOT)
DB = os.path.join(WORK, "probe.sqlite")

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
        print("=== REFLECT KEY 缺失,无法跑真实反思(跳过) ===")
        sys.exit(2)

    call_rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "probe", "version": "1.0"}})

    samples = [
        ("用户: 今天又加班到十点,好累,但看到你发的消息心情好了一点\n助手: 加班辛苦了,记得喝点水", "情感 → project"),
        ("用户: 我平时喜欢简洁直接的回复,不喜欢绕弯子\n助手: 明白,以后直接给结论", "画像 → user"),
        ("用户: 你刚才的解释太长了,以后先给结论再展开\n助手: 好,记住了", "纠正 → feedback"),
        ("用户: 这篇文档你记一下 https://example.com/ref123\n助手: 已记录", "链接 → reference"),
    ]
    for text, label in samples:
        r = unwrap(call_tool("conversation_save", {"userMessage": text.split("\n")[0].replace("用户: ", ""),
                                                   "assistantMessage": text.split("\n")[1].replace("助手: ", "")}))
        print(f"[样本] {label} -> saved={r.get('ok')}")

    print("\n[跑 reflect_auto(daily)] ...")
    t0 = time.time()
    r = unwrap(call_tool("reflect_auto", {"limit": 30}))
    print(f"[reflect] 耗时 {time.time()-t0:.1f}s")
    print(f"[reflect] ok={r.get('ok')} skipped={r.get('skipped')} conversationCount={r.get('conversationCount')}")
    print(f"[reflect] actions={r.get('actions')} applied={r.get('applied')} factsInserted={r.get('factsInserted')} factsUpdated={r.get('factsUpdated')}")
    print(f"[reflect] errors={r.get('errors')}")

    # 抽取 LLM 给出的动作清单,展示 newMemType 归类
    acts = r.get("receipts") or []
    if r.get("receipts"):
        print("\n[动作回执] (action / status / targetId / reason)")
        for a in acts:
            print(f"  - {a.get('action'):10s} {a.get('status'):8s} {str(a.get('targetId'))[:20]:22s} {a.get('reason','')[:40]}")

    # 看提取出的记忆怎么落库(memType 分布)
    st = unwrap(call_tool("stats_get", {}))
    print(f"\n[落库统计] total={st.get('total')} byMemType={st.get('byMemType')}")
    print(f"[落库统计] byCategory={[c for c in st.get('byCategory', [])]}")

    print("\n=== REFLECT PROBE DONE ===")
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
