#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地自测：起一个临时中台，拉起 3 个真实 agent-bridge 模拟节点，
用 sbmsg 点名 → 各桥自动 transport 回执 → rollcall 显示时延。

不触网、不用生产口令。用法（在仓库根目录或本目录均可）：

  python3 tools/bus/selftest.py
"""
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RT = ROOT / "90-System" / "runtime"
sys.path.insert(0, str(RT))
sys.path.insert(0, str(HERE))
import api_server  # noqa: E402
import migrate_v2  # noqa: E402
import runtime  # noqa: E402

TOKENS = {
    "grok-chief": "selftest-token-grok",
    "dsh-chief": "selftest-token-dsh",
    "dsh2-chief": "selftest-token-dsh2",
    "maus2-chief": "selftest-token-maus2",
}
NODES = [
    ("dsh-chief", "DSH一号@主机"),
    ("dsh2-chief", "DSH二号@笔记本"),
    ("maus2-chief", "MAUS2号@笔记本"),
]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    d = Path(tempfile.mkdtemp(prefix="sb-bus-selftest-"))
    ev = d / "50-Events"
    ev.mkdir()
    runtime.EVENTS_DIR = ev
    runtime.ROOT = d
    db_path = d / "state.db"
    conn = sqlite3.connect(str(db_path), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    migrate_v2.migrate(conn)
    now = int(time.time())
    conn.execute(
        "INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('MAUS2号@笔记本','instance','笔记本','maus2-chief','active',?)", (now,))
    conn.execute("UPDATE agents SET last_seen=NULL")
    conn.commit()
    conn.close()

    port = free_port()
    gateway = "http://127.0.0.1:%s" % port
    stop = threading.Event()

    def db_fn():
        c = sqlite3.connect(str(db_path), timeout=10, check_same_thread=False)
        c.execute("PRAGMA busy_timeout=5000")
        return c

    handler = api_server._make_handler(
        db_fn, runtime.chief_execute, runtime.log_event, TOKENS, {}, stop)
    server = api_server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="selftest-api", daemon=True).start()
    urllib.request.urlopen(gateway + "/healthz", timeout=3).read()

    procs = []
    try:
        for aid, inst in NODES:
            cfg = {
                "gateway": gateway,
                "token_env": "SUPERBRAIN_GATEWAY_TOKEN",
                "instance": inst,
                "agent_id": aid,
                "handler": "none",
            }
            cfg_path = d / ("%s.json" % aid)
            cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
            env = os.environ.copy()
            env["SUPERBRAIN_GATEWAY_TOKEN"] = TOKENS[aid]
            env["SB_BRIDGE_LOG"] = str(d / ("%s.log" % aid))
            # 防止误用外部环境口令
            env.pop("SB_TOKEN", None)
            env.pop("SB_VIEWER_TOKEN", None)
            p = subprocess.Popen(
                [sys.executable, str(HERE / "agent-bridge.py"), "--config", str(cfg_path)],
                env=env, cwd=str(d),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            procs.append(p)

        # 等桥连上（日志出现「已建立」）
        deadline = time.time() + 8
        while time.time() < deadline:
            ok = 0
            for aid, _inst in NODES:
                lp = d / ("%s.log" % aid)
                if lp.is_file() and "SSE 已建立" in lp.read_text(encoding="utf-8", errors="replace"):
                    ok += 1
            if ok == 3:
                break
            time.sleep(0.1)
        print("模拟节点已连接：%s" % ", ".join(inst for _a, inst in NODES))

        env = os.environ.copy()
        env["SUPERBRAIN_GATEWAY_TOKEN"] = TOKENS["grok-chief"]
        env["SUPERBRAIN_GATEWAY"] = gateway
        send = subprocess.run(
            [sys.executable, str(HERE / "sbmsg.py"), "--gateway", gateway,
             "send", "--to", "all", "--kind", "ping", "所有在线 Agent 回复 1"],
            env=env, capture_output=True, text=True, encoding="utf-8")
        print(send.stdout)
        if send.returncode != 0:
            print(send.stderr, file=sys.stderr)
            return 1
        obj = json.loads(send.stdout)
        mid = obj["msg_id"]

        # 等 3 份回执
        deadline = time.time() + 8
        n = 0
        data = {}
        while time.time() < deadline:
            rc = subprocess.run(
                [sys.executable, str(HERE / "sbmsg.py"), "--gateway", gateway,
                 "rollcall", mid, "--json"],
                env=env, capture_output=True, text=True, encoding="utf-8")
            # 人读摘要在 stdout 前半，JSON 在末尾；再直接打 HTTP 更稳
            import urllib.request as u
            req = u.Request(
                gateway + "/api/rollcall/" + mid,
                headers={"Authorization": "Bearer " + TOKENS["grok-chief"]})
            with u.urlopen(req, timeout=5) as r:
                data = json.loads(r.read().decode("utf-8")).get("data") or {}
            n = data.get("replied_count") or 0
            if n >= 3:
                break
            time.sleep(0.2)

        # 再跑一遍 sbmsg rollcall 把人读输出打到终端
        pretty = subprocess.run(
            [sys.executable, str(HERE / "sbmsg.py"), "--gateway", gateway, "rollcall", mid],
            env=env, capture_output=True, text=True, encoding="utf-8")
        print(pretty.stdout)

        evn = db_fn()
        events = evn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        evn.close()

        replies = data.get("replies") or []
        ok = n >= 3 and events == 0 and all("latency_seconds" in r for r in replies)
        print("自测结果：回复 %s 人，events=%s，时延=%s" % (
            n, events, [r.get("latency_seconds") for r in replies]))
        if not ok:
            print("SELFTEST_FAIL", file=sys.stderr)
            return 1
        print("SELFTEST_OK")
        return 0
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
        stop.set()
        server.shutdown()
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
