#!/usr/bin/env python3
"""
smoke_absorb.py — Anima 吸收改造冒烟测试

以 MCP stdio 方式启动 dist/index.js(强制单库 legacy 模式):
  env: MEMORY_DB_PATH=<repo>/test_absorb.sqlite, MCP_TOOLS=all, CHAR_ID=harness-absorb, EMBED_MODE=none
步骤:
  1. initialize + notifications/initialized
  2. tools/list → 断言 31 工具
  3. memory_save(project=alpha) → 断言 ok
  4. memory_save(memType=project) → 断言返回 memType=project
  5. memory_save(memType=user) → 断言返回 memType=user
  6. stats_get(project=alpha) → 断言 total >= 1
  7. context_get(project=alpha) → 断言 persona.charId 非空
退出码:0 全过,1 失败。脚本保留。
"""
import json
import os
import shutil
import subprocess
import sys
import time

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DIST = os.path.join(REPO, 'dist', 'index.js')
DB_PATH = os.path.join(REPO, 'test_absorb.sqlite')

# node:shutil.which 优先,回退绝对路径
NODE = shutil.which('node') or r'D:\system\New Folder\node.exe'

ENV = dict(os.environ)
ENV.update({
    'MEMORY_DB_PATH': DB_PATH,
    'MCP_TOOLS': 'all',
    'CHAR_ID': 'harness-absorb',
    'EMBED_MODE': 'none',
})


def main() -> int:
    if not os.path.exists(DIST):
        print(f'[smoke] FATAL: {DIST} 不存在,先 npm run build', file=sys.stderr)
        return 1

    proc = subprocess.Popen(
        [NODE, DIST],
        cwd=REPO,
        env=ENV,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    pending = {}
    results = {}

    def send(msg: dict):
        proc.stdin.write(json.dumps(msg) + '\n')
        proc.stdin.flush()

    def wait_response(req_id: int, timeout: float = 30.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                print('[smoke] FATAL: server 提前退出', file=sys.stderr)
                dump_stderr(proc)
                sys.exit(1)
            line = proc.stdout.readline()
            if not line:
                time.sleep(0.05)
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get('id') == req_id:
                return msg
            pending[msg.get('id')] = msg
        print(f'[smoke] FATAL: 等待响应 id={req_id} 超时', file=sys.stderr)
        dump_stderr(proc)
        sys.exit(1)

    def rpc(req_id: int, method: str, params: dict):
        send({'jsonrpc': '2.0', 'id': req_id, 'method': method, 'params': params})
        return wait_response(req_id)

    try:
        # 1. initialize + initialized
        r = rpc(1, 'initialize', {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'smoke_absorb', 'version': '1.0'},
        })
        assert 'result' in r, f'initialize 失败: {r}'
        server_info = r['result']
        print(f"[smoke] 1/7 initialize OK -> server={server_info.get('serverInfo', {}).get('name')} "
              f"v{server_info.get('serverInfo', {}).get('version')} "
              f"protocol={server_info.get('protocolVersion')}")
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

        # 2. tools/list → 31
        r = rpc(2, 'tools/list', {})
        tools = r['result']['tools']
        names = sorted(t['name'] for t in tools)
        assert len(tools) == 31, f'工具数 {len(tools)} != 31,实际: {names}'
        required = ['memory_search', 'fact_search', 'memory_save', 'auto_process',
                    'context_get', 'stats_get', 'memory_context', 'project_list',
                    'instruction_save', 'instruction_list', 'instruction_delete',
                    'memory_log', 'mood_journal', 'user_observe', 'consolidate_deep',
                    'reflect_auto', 'reflect_deep', 'reflect_batch_embed',
                    'memory_index', 'memory_get', 'memory_recent', 'memory_graph']
        missing = [t for t in required if t not in names]
        assert not missing, f'缺少工具: {missing}'
        print(f'[smoke] 2/7 tools/list OK -> {len(tools)} 工具 (all 组注册)')

        # 3. memory_save(project=alpha)
        r = rpc(3, 'tools/call', {
            'name': 'memory_save',
            'arguments': {'text': '吸收冒烟测试记忆:Anima 架构 alpha 项目',
                          'project': 'alpha', 'category': 'general',
                          'tags': ['anima', 'absorb']},
        })
        content = r['result']['content'][0]['text']
        data = json.loads(content)
        assert data.get('ok') is True and data.get('id'), f'memory_save 未返回 ok/id: {data}'
        saved_id = data['id']
        print(f'[smoke] 3/7 memory_save(project=alpha) OK -> id={saved_id[:8]}... memType={data.get("memType")}')

        # 4. memory_save(memType=project) → 断言返回 memType=project(情感分区链路)
        r = rpc(4, 'tools/call', {
            'name': 'memory_save',
            'arguments': {'text': '情绪快照:今天用户傲娇的瞬间', 'memType': 'project',
                          'category': 'emotional', 'tags': ['emotion', 'tsundere']},
        })
        data = json.loads(r['result']['content'][0]['text'])
        assert data.get('ok') is True, f'memory_save(memType=project) 非 ok: {data}'
        assert data.get('memType') == 'project', f'期望 memType=project,实际: {data.get("memType")}'
        print(f'[smoke] 4/7 memory_save(memType=project) OK -> id={data["id"][:8]}... memType={data.get("memType")}')

        # 5. memory_save(memType=user) → 断言返回 memType=user(AI 对用户画像链路)
        r = rpc(5, 'tools/call', {
            'name': 'memory_save',
            'arguments': {'text': '我喜欢这个用户,用户习惯用中文写代码', 'memType': 'user',
                          'category': 'general', 'tags': ['profile', 'affection']},
        })
        data = json.loads(r['result']['content'][0]['text'])
        assert data.get('ok') is True, f'memory_save(memType=user) 非 ok: {data}'
        assert data.get('memType') == 'user', f'期望 memType=user,实际: {data.get("memType")}'
        print(f'[smoke] 5/7 memory_save(memType=user) OK -> id={data["id"][:8]}... memType={data.get("memType")}')

        # 6. stats_get(project=alpha) → total >= 1
        r = rpc(6, 'tools/call', {
            'name': 'stats_get',
            'arguments': {'project': 'alpha'},
        })
        data = json.loads(r['result']['content'][0]['text'])
        assert data.get('ok') is True, f'stats_get 返回非 ok: {data}'
        assert data.get('total', 0) >= 1, f'stats total={data.get("total")} < 1'
        print(f'[smoke] 6/7 stats_get(project=alpha) OK -> total={data.get("total")} '
              f'characterId={data.get("characterId")} project={data.get("project")}')

        # 7. context_get(project=alpha) → persona.charId 非空
        r = rpc(7, 'tools/call', {
            'name': 'context_get',
            'arguments': {'project': 'alpha'},
        })
        data = json.loads(r['result']['content'][0]['text'])
        assert data.get('ok') is True, f'context_get 返回非 ok: {data}'
        persona = data.get('persona', {})
        assert persona.get('charId'), f'persona.charId 为空: {persona}'
        assert persona.get('name'), f'persona.name 为空: {persona}'
        print(f'[smoke] 7/7 context_get(project=alpha) OK -> persona.charId={persona.get("charId")} '
              f'name={persona.get("name")} stats.total={data.get("stats", {}).get("total")}')

        print('\n[smoke] ALL PASS')
        return 0
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        dump_stderr(proc)


def dump_stderr(proc):
    if proc.stderr:
        try:
            err = proc.stderr.read()
        except Exception:
            err = ''
        if err and err.strip():
            print('[smoke] server stderr (tail):')
            for line in err.strip().splitlines()[-15:]:
                print('   ', line)


if __name__ == '__main__':
    sys.exit(main())
