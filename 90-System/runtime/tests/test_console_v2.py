#!/usr/bin/env python3
# 操作台 v2：/api/dashboard（KPI、异常计数口径、点名首回耗时与重复回复）、/api/server、
# /api/messages?agent=、SSE observe=1 只读全量消息、静态资源 PWA 与 ETag；写入仍要口令。
# 用法：python3 90-System/runtime/tests/test_console_v2.py
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
sys.path.insert(0, str(RT))
import console_api  # noqa: E402
import console_v2  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402

FAILS = []
CHIEF = "chief-test-token-v2"


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))
    if not cond:
        FAILS.append(name)


def fresh():
    d = Path(tempfile.mkdtemp(prefix="sb-console-v2-"))
    conn = sqlite3.connect(str(d / "state.db"))
    migrate_v2.migrate(conn)
    message_bus.ensure_schema(conn)
    return d, conn


def msg(conn, mid, frm, inst, to, text, ts, kind="chat", reply=None):
    conn.execute(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES(?,?,?,?,?,?,?,?,?)", (mid, frm, inst, to, kind, text, reply, reply or mid, ts))


_SEQ = [0]


def task(conn, status, payload, created, owner=None):
    _SEQ[0] += 1
    payload = dict(payload, seq=_SEQ[0])      # tasks(type,payload) 唯一，逐条加序号
    conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,lease_owner,claimed_at,created_at) "
        "VALUES(NULL,'assist',?,?,0,?,?,?)",
        (json.dumps(payload, ensure_ascii=False), status, owner, created if owner else None, created))


def seed(conn, now):
    conn.execute("UPDATE agents SET last_seen=NULL")
    reg = [("DSH一号@主机", "dsh-chief", "主机"), ("MAUS二号@笔记本", "maus2-chief", "笔记本"),
           ("Trae@笔记本", "trae-chief", "笔记本"), ("幕僚长@云端", "grok-chief", "box")]
    for name, ref, loc in reg:
        conn.execute("INSERT OR REPLACE INTO registry(name,kind,location,agent_ref,status,registered_at) "
                     "VALUES(?,'instance',?,?,'active',?)", (name, loc, ref, now))
    beats = {"DSH一号@主机": now - 10, "MAUS二号@笔记本": now - 20,
             "Trae@笔记本": now - 7200, "幕僚长@云端": now - 5, "chat-worker": now - 3}
    for a, ts in beats.items():
        conn.execute("INSERT INTO heartbeats(agent,ts,note) VALUES(?,?,'sse') "
                     "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts", (a, ts))
    # deepseek 曾接入但已过期（无实例）→ 心跳过期 1；research 从未接入 → 不算过期
    conn.execute("UPDATE agents SET last_seen=? WHERE agent_id='deepseek-chief'", (now - 4000,))
    # 死信：to_agent 直接点名 / to 写实例名需经名册折回 / 无法归属
    for _ in range(3):
        task(conn, "dead", {"to_agent": "trae-chief", "text": "x"}, now - 90000)
    for _ in range(2):
        task(conn, "dead", {"to": "DSH一号@主机", "text": "x"}, now - 90000)
    task(conn, "dead", {"text": "无人点名"}, now - 90000)
    # 未认领：超过 10 分钟才算；新任务不算
    task(conn, "pending", {"to_agent": "dsh-chief", "text": "等认领"}, now - 1200)
    task(conn, "pending", {"to_agent": "dsh-chief", "text": "刚到"}, now - 30)
    # 执行中只认租约：chat-worker 有 doing 任务
    task(conn, "doing", {"text": "干活"}, now - 50, owner="chat-worker")
    # 点名：两节点回复，其中 MAUS二号 重复回复两次（重放）
    msg(conn, "ping1", "grok-chief", "幕僚长@云端", "all", "在的回复 1", now - 600, kind="ping")
    msg(conn, "r1", "dsh-chief", "DSH一号@主机", "grok-chief", "1", now - 597, reply="ping1")
    msg(conn, "r2", "maus2-chief", "MAUS二号@笔记本", "grok-chief", "1", now - 590, reply="ping1")
    msg(conn, "r3", "maus2-chief", "MAUS二号@笔记本", "grok-chief", "1", now - 300, reply="ping1")
    msg(conn, "r4", "maus2-chief", "MAUS二号@笔记本", "grok-chief", "1", now - 100, reply="ping1")
    msg(conn, "old", "maus2-chief", "MAUS二号@笔记本", "幕僚长@云端", "老消息", now - 7200)
    msg(conn, "veryold", "dsh-chief", None, "grok-chief", "两天前", now - 2 * 86400)
    conn.commit()


def test_dashboard():
    d, conn = fresh()
    now = int(time.time())
    seed(conn, now)
    console_v2.clear_cache()
    code, body = console_api.handle_get(conn, "/api/dashboard")
    check("dashboard 200", code == 200 and body.get("ok"), code)
    data = body["data"]
    k = data["kpi"]
    ag = {a["agent_id"]: a for a in data["agents"]}
    check("console_rev=2", data["console_rev"] == 2)
    check("近 1 小时消息数", k["msgs_1h"] == 5, k["msgs_1h"])
    check("近 24 小时消息数", k["msgs_24h"] == 6, k["msgs_24h"])
    check("累计消息数", k["msgs_total"] == 7, k["msgs_total"])
    check("分时 24 桶且合计=24h", len(data["messages"]["hourly_24h"]) == 24
          and sum(data["messages"]["hourly_24h"]) == 6, data["messages"]["hourly_24h"])
    check("死信按 to_agent 归属", ag["trae-chief"]["anomalies"]["dead"] == 3, ag["trae-chief"]["anomalies"])
    check("死信 to 实例名经名册折回", ag["dsh-chief"]["anomalies"]["dead"] == 2, ag["dsh-chief"]["anomalies"])
    check("无法归属的死信单列", k["anomalies"]["dead"] == 6 and k["anomalies"]["dead_unassigned"] == 1,
          k["anomalies"])
    check("未认领只算超过 10 分钟的", ag["dsh-chief"]["anomalies"]["unclaimed"] == 1 and k["anomalies"]["unclaimed"] == 1,
          ag["dsh-chief"]["anomalies"])
    check("实例心跳过期计入 trae", ag["trae-chief"]["anomalies"]["stale"] == 1 and ag["trae-chief"]["live_status"] == "offline")
    check("无实例但曾接入的过期计 1", ag["deepseek-chief"]["anomalies"]["stale"] == 1)
    check("从未接入不算心跳过期", ag["research-worker"]["anomalies"]["stale"] == 0
          and ag["research-worker"]["live_status"] == "unused")
    check("在线 Agent 不算过期", ag["dsh-chief"]["anomalies"]["stale"] == 0 and ag["dsh-chief"]["live_status"] == "idle")
    check("执行中只认租约", ag["chat-worker"]["live_status"] == "working"
          and ag["dsh-chief"]["live_status"] == "idle" and k["agents_working"] == 1)
    check("异常合计自洽", k["anomalies"]["total"] == k["anomalies"]["dead"] + k["anomalies"]["unclaimed"] + k["anomalies"]["stale"])
    rc = data["last_rollcall"]
    check("最近点名=ping1", rc and rc["msg_id"] == "ping1", rc and rc["msg_id"])
    lat = {r["from_instance"]: r["latency_seconds"] for r in rc["replies"]}
    check("每节点只取首条回复耗时", lat == {"DSH一号@主机": 3, "MAUS二号@笔记本": 10}, lat)
    check("重复回复单独计数", rc["duplicate_replies"] == 2, rc["duplicate_replies"])
    check("点名中位/最慢耗时", rc["latency_max"] == 10 and rc["latency_median"] in (3, 10), rc)
    check("未回节点列出", any(m["instance"] == "Trae@笔记本" for m in rc["missing"]), rc["missing"])
    links = {(l["from"], l["to"]): l["count_24h"] for l in data["messages"]["links_24h"]}
    check("连线把实例名折回 agent", links.get(("maus2-chief", "grok-chief")) == 4, links)
    check("最近消息按时间正序", [m["msg_id"] for m in data["messages"]["recent"]][-1] == "r4")
    # 按 Agent 查消息：发出的 + 发给其 agent_id / 实例名的
    code, body = console_api.handle_get(conn, "/api/messages?agent=grok-chief&limit=50")
    ids = [m["msg_id"] for m in body["data"]]
    check("按 Agent 查消息含实例名收件", "old" in ids and "ping1" in ids and "r1" in ids, ids)
    check("按 Agent 查消息新→旧", body.get("order") == "desc" and ids[0] == "r4", ids[:3])
    code, _ = console_api.handle_get(conn, "/api/messages?agent=" + "x" * 90)
    check("agent 参数过长 400", code == 400, code)
    code, body = console_api.handle_get(conn, "/api/messages?limit=5")
    check("不带 agent 的 /api/messages 行为不变", code == 200 and body.get("order") is None, body.get("order"))
    t0 = time.time()
    console_api.handle_get(conn, "/api/dashboard")
    check("dashboard 二次调用走缓存且快", time.time() - t0 < 1.0, round(time.time() - t0, 3))
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def test_server_health():
    d = Path(tempfile.mkdtemp(prefix="sb-cert-"))
    cert = d / "demo.example.crt"
    made = False
    if shutil.which("openssl"):
        r = subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(d / "k.pem"),
             "-out", str(cert), "-days", "30", "-subj", "/CN=demo.example"],
            capture_output=True, text=True)
        made = r.returncode == 0 and cert.exists()
    console_v2.CERT_GLOB = str(d / "*.crt")
    console_v2.clear_cache()
    h = console_v2.server_health()
    check("服务器健康：内存/磁盘/负载", h.get("mem_total_mb") and h.get("disk_total_gb") and h.get("loadavg") is not None, h)
    check("服务器健康：运行时长", isinstance(h.get("uptime_seconds"), int) and isinstance(h.get("service_uptime_seconds"), int))
    if made:
        c = (h.get("certs") or [None])[0]
        check("证书到期天数", c and 28 <= c["days_left"] <= 30.5 and c["host"] == "demo.example", c)
    else:
        print("SKIP 证书解析（本机无 openssl）")
    check("健康数据不含口令字样", "token" not in json.dumps(h).lower())
    shutil.rmtree(d, ignore_errors=True)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _req(port, path, method="GET", data=None, headers=None):
    req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=data, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def _sse_collect(port, query, seconds=3.0):
    s = socket.create_connection(("127.0.0.1", port), timeout=seconds + 2)
    s.sendall(("GET /api/stream?%s HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n" % query).encode())
    s.settimeout(0.5)
    buf, end = b"", time.time() + seconds
    while time.time() < end:
        try:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        except socket.timeout:
            continue
    s.close()
    return buf


def test_http(d):
    db = d / "state.db"
    tok = d / "tokens.json"
    tok.write_text(json.dumps({"tokens": {"grok-chief": CHIEF}, "viewers": {}}), encoding="utf-8")
    port = _free_port()
    proc = subprocess.Popen([sys.executable, str(RT / "tests" / "fixture_server.py"), str(db), str(tok), str(port)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        proc.stdout.readline()
        up = False
        for _ in range(80):
            try:
                urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=1).read()
                up = True
                break
            except Exception:
                time.sleep(0.1)
        check("fixture 起来", up)
        if not up:
            return
        code, body, _ = _req(port, "/api/dashboard")
        check("HTTP dashboard 免口令 200", code == 200 and json.loads(body)["ok"], code)
        code, body, _ = _req(port, "/api/server")
        check("HTTP server 免口令 200", code == 200 and json.loads(body)["ok"], code)
        code, _, _ = _req(port, "/api/dashboard", method="POST", data=b"{}",
                          headers={"Content-Type": "application/json"})
        check("POST 新只读接口不可写（401/404）", code in (401, 404), code)
        code, _, _ = _req(port, "/cmd", method="POST", data=json.dumps({"cmd": "msg", "args": {"text": "x"}}).encode(),
                          headers={"Content-Type": "application/json"})
        check("/cmd 无口令 401", code == 401, code)
        # SSE：观察模式能看到点对点消息；普通免口令连接看不到（行为不变）；带 instance 无口令 401
        conn = sqlite3.connect(str(db))
        now = int(time.time())
        msg(conn, "live1", "maus2-chief", "MAUS二号@笔记本", "grok-chief", "实时直达", now)
        conn.commit()
        conn.close()
        raw = _sse_collect(port, "observe=1&since=%d" % (now - 2), 2.5)
        check("SSE observe=1 收到点对点消息", b"live1" in raw and b"event: msg" in raw, raw[:200])
        raw = _sse_collect(port, "since=%d" % (now - 2), 2.0)
        check("SSE 非观察模式不推点对点消息", b"live1" not in raw and b"connected" in raw, raw[:200])
        raw = _sse_collect(port, "observe=1&instance=%s" % urllib.request.quote("幕僚长@云端"), 1.0)
        check("SSE 带 instance 无口令仍 401", b"401" in raw[:40], raw[:80])
        # 静态资源：PWA、图标、ETag 304
        code, body, hdr = _req(port, "/console/prototype/index.html")
        html = body.decode()
        check("index 是 v2", code == 200 and "v2/app.js" in html, code)
        for need in ('rel="manifest"', 'rel="apple-touch-icon"', 'name="theme-color"', "viewport-fit=cover",
                     'name="apple-mobile-web-app-capable"'):
            check("index 含 " + need, need in html)
        check("首屏不直接加载 three.js（3D 懒加载）", "three.min.js" not in html)
        etag = hdr.get("ETag")
        code304, _, _ = _req(port, "/console/prototype/index.html", headers={"If-None-Match": etag or "x"})
        check("静态资源 ETag 协商 304", etag and code304 == 304, (etag, code304))
        code, body, hdr = _req(port, "/console/prototype/manifest.webmanifest")
        man = json.loads(body)
        check("manifest 类型正确", code == 200 and "manifest+json" in hdr.get("Content-Type", ""), hdr.get("Content-Type"))
        check("manifest standalone + 主题色", man.get("display") == "standalone" and man.get("theme_color"))
        for ic in man.get("icons", []):
            c, b, _ = _req(port, "/console/prototype/" + ic["src"])
            check("图标可取 " + ic["src"], c == 200 and b[:4] == b"\x89PNG", c)
        c, b, _ = _req(port, "/console/prototype/v2/icons/apple-touch-icon.png")
        check("apple-touch-icon 可取", c == 200 and b[:4] == b"\x89PNG")
        c, js, _ = _req(port, "/console/prototype/v2/app.js")
        js = js.decode()
        check("v2 前端不含口令", CHIEF not in js and "token=" not in js and "?token" not in js)
        check("v2 前端令牌只来自本机配对存储", "localStorage" in js and "sb.owner.v1" in js)
        check("v2 前端用 SSE 且有轮询降级", "EventSource" in js and "observe=1" in js and "轮询模式" in js)
        c, css, _ = _req(port, "/console/prototype/v2/app.css")
        check("v2 样式尊重减少动效", b"prefers-reduced-motion" in css)
        c, sc, _ = _req(port, "/console/prototype/v2/scene3d.js")
        check("3D 场景文件可取", c == 200 and b"SB3D" in sc)
        c, _, _ = _req(port, "/console/prototype/v1.html")
        check("旧版 v1 仍可打开", c == 200)
        c, _, _ = _req(port, "/console/../runtime/api_server.py")
        check("静态目录防穿越", c == 404, c)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    test_dashboard()
    test_server_health()
    d, conn = fresh()
    seed(conn, int(time.time()))
    conn.close()
    try:
        test_http(d)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("\n== %s 项失败 ==" % len(FAILS) if FAILS else "\n== 全部通过 ==")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
