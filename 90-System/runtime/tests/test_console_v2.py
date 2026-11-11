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


def task(conn, status, payload, created, owner=None, done_at=None):
    _SEQ[0] += 1
    payload = dict(payload, seq=_SEQ[0])      # tasks(type,payload) 唯一，逐条加序号
    conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,lease_owner,claimed_at,created_at,done_at) "
        "VALUES(NULL,'assist',?,?,0,?,?,?,?)",
        (json.dumps(payload, ensure_ascii=False), status, owner,
         created if owner else None, created, done_at))


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
    check("历史死信进归档且按 to_agent 归属",
          ag["trae-chief"]["anomalies"]["archive_dead"] == 3, ag["trae-chief"]["anomalies"])
    check("历史死信 to 实例名经名册折回进归档",
          ag["dsh-chief"]["anomalies"]["archive_dead"] == 2, ag["dsh-chief"]["anomalies"])
    check("无法归属的历史死信进归档",
          k["anomalies"]["archive"]["dead"] == 6 and k["anomalies"]["archive"]["dead_unassigned"] == 1,
          k["anomalies"])
    check("历史死信不进红角标",
          k["anomalies"]["dead"] == 0 and k["anomalies"]["recent_failed"] == 0
          and ag["trae-chief"]["anomalies"]["dead"] == 0
          and ag["dsh-chief"]["anomalies"]["dead"] == 0, k["anomalies"])
    check("未认领只算超过 10 分钟的", ag["dsh-chief"]["anomalies"]["unclaimed"] == 1 and k["anomalies"]["unclaimed"] == 1,
          ag["dsh-chief"]["anomalies"])
    check("实例心跳过期计入 trae", ag["trae-chief"]["anomalies"]["stale"] == 1 and ag["trae-chief"]["live_status"] == "offline")
    check("无实例但曾接入的过期计 1", ag["deepseek-chief"]["anomalies"]["stale"] == 1)
    check("从未接入不算心跳过期", ag["research-worker"]["anomalies"]["stale"] == 0
          and ag["research-worker"]["live_status"] == "unused")
    check("在线 Agent 不算过期", ag["dsh-chief"]["anomalies"]["stale"] == 0 and ag["dsh-chief"]["live_status"] == "idle")
    check("执行中只认租约", ag["chat-worker"]["live_status"] == "working"
          and ag["dsh-chief"]["live_status"] == "idle" and k["agents_working"] == 1)
    check("异常合计=未认领+最近失败，不含历史死信与心跳过期",
          k["anomalies"]["total"] == k["anomalies"]["unclaimed"] + k["anomalies"]["recent_failed"]
          and k["anomalies"]["total"] == 1
          and ag["dsh-chief"]["anomalies"]["total"] == 1
          and ag["trae-chief"]["anomalies"]["total"] == 0, k["anomalies"])
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


def test_dashboard_recent_failed_in_badge():
    """近 24h 的 failed/新死信计入角标；更早的只进归档。"""
    d, conn = fresh()
    now = int(time.time())
    seed(conn, now)
    task(conn, "dead", {"to_agent": "trae-chief", "text": "刚死"}, now - 600, done_at=now - 600)
    task(conn, "failed", {"to_agent": "dsh-chief", "text": "刚失败"}, now - 120, done_at=now - 120)
    console_v2.clear_cache()
    code, body = console_api.handle_get(conn, "/api/dashboard")
    check("recent dashboard 200", code == 200 and body.get("ok"), code)
    k = body["data"]["kpi"]["anomalies"]
    ag = {a["agent_id"]: a["anomalies"] for a in body["data"]["agents"]}
    check("最近失败计入角标", k["recent_failed"] == 2 and k["dead"] == 2, k)
    check("角标=未认领1+最近失败2", k["total"] == 3 and k["unclaimed"] == 1, k)
    check("历史归档仍含旧死信+新死信", k["archive"]["dead"] == 7, k["archive"])
    check("最近失败按 agent 拆开",
          ag["trae-chief"]["recent_failed"] == 1 and ag["dsh-chief"]["recent_failed"] == 1
          and ag["dsh-chief"]["total"] == 2, ag)
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def test_dashboard_storm_not_in_badge():
    """模拟告警风暴存量：上千条历史 dead 不得抬高红角标。"""
    d, conn = fresh()
    now = int(time.time())
    seed(conn, now)
    for i in range(200):
        task(conn, "dead", {"kind": "告警", "from": "内核", "to_agent": "trae-chief", "text": "风暴"},
             now - 200000, done_at=now - 200000)
    console_v2.clear_cache()
    _, body = console_api.handle_get(conn, "/api/dashboard")
    k = body["data"]["kpi"]["anomalies"]
    check("风暴存量进归档", k["archive"]["dead"] >= 200, k["archive"])
    check("风暴不进红角标", k["total"] == 1 and k["recent_failed"] == 0 and k["unclaimed"] == 1, k)
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
        # HTML 入口一律重发（避免 iPhone 主屏幕卡住旧脚本）；js/css 仍走 ETag 304
        etag_html = hdr.get("ETag")
        code_html, _, _ = _req(port, "/console/prototype/index.html", headers={"If-None-Match": etag_html or "x"})
        check("HTML 入口不协商 304", code_html == 200, code_html)
        code_js, _, hdr_js = _req(port, "/console/prototype/v2/app.js")
        etag = hdr_js.get("ETag")
        code304, _, _ = _req(port, "/console/prototype/v2/app.js", headers={"If-None-Match": etag or "x"})
        check("静态资源 ETag 协商 304", code_js == 200 and etag and code304 == 304, (etag, code304))
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
        check("v2 前端令牌只来自本机当日会话存储", "localStorage" in js and "sb.owner.daily.v1" in js)
        check("v2 前端走每日口令解锁", "/api/owner/unlock" in js and "askUnlock" in js)
        check("v2 前端不再引导配对码", "输入配对码" not in js and "askPair" not in js and "#pair=" not in js)
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


def test_dashboard_degraded_receipt():
    """心跳仍新、定向消息超过 60 秒无回执 → live_status=degraded，不计入 agents_online。"""
    d, conn = fresh()
    now = int(time.time())
    seed(conn, now)
    conn.execute(
        "INSERT OR REPLACE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('Muse@本机','instance','sandbox','muse-chief','active',?)", (now,))
    conn.execute(
        "INSERT INTO heartbeats(agent,ts,note) VALUES('Muse@本机',?,'sse') "
        "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts, note=excluded.note", (now - 8,))
    conn.execute("UPDATE agents SET last_seen=?, status='active' WHERE agent_id='muse-chief'", (now - 8,))
    # 已有种子里的广播 ping1（now-600）Muse 补上回执，避免广播把她一直钉在降级
    msg(conn, "ack_ping1_muse", "muse-chief", "Muse@本机", "grok-chief",
        "1", now - 80, kind="chat", reply="ping1")
    # 90 秒前发给 Muse 的任务，没有回执
    msg(conn, "task_muse", "grok-chief", "幕僚长@云端", "muse-chief",
        "请初审并回执", now - 90, kind="chat")
    # 对照：同样心跳新鲜的 dsh-chief 已回执，应保持 idle
    conn.commit()
    console_v2.clear_cache()
    code, body = console_api.handle_get(conn, "/api/dashboard")
    check("degraded dashboard 200", code == 200 and body.get("ok"), code)
    data = body["data"]
    k = data["kpi"]
    ag = {a["agent_id"]: a for a in data["agents"]}
    check("Muse live_status=degraded", ag.get("muse-chief", {}).get("live_status") == "degraded",
          ag.get("muse-chief", {}).get("live_status"))
    check("Muse 状态文案", (ag["muse-chief"].get("state") or {}).get("label") == "在场但回执失败",
          ag["muse-chief"].get("state"))
    inst = (ag["muse-chief"].get("instances") or [{}])[0]
    check("Muse 实例标 degraded", inst.get("degraded") is True or inst.get("link_status") == "degraded", inst)
    check("dsh 仍是健康空闲，不被误伤", ag["dsh-chief"]["live_status"] == "idle")
    # chat-worker 有心跳但从不回广播，不应被标 degraded
    check("worker 不因广播被标 degraded", ag["chat-worker"]["live_status"] == "working",
          ag["chat-worker"]["live_status"])
    check("agents_online 不含 Muse", k["agents_online"] == sum(
        1 for a in data["agents"] if a["status"] == "active" and a["live_status"] in ("idle", "working")),
          k["agents_online"])
    check("agents_degraded 单独计数含 Muse", k.get("agents_degraded") >= 1
          and ag["muse-chief"]["agent_id"] and k["agents_degraded"] == sum(
              1 for a in data["agents"] if a["status"] == "active" and a["live_status"] == "degraded"),
          k.get("agents_degraded"))
    # 补上回执后应恢复 idle
    msg(conn, "ack_muse", "muse-chief", "Muse@本机", "grok-chief",
        "已收到", now - 10, kind="chat", reply="task_muse")
    conn.commit()
    console_v2.clear_cache()
    _, body2 = console_api.handle_get(conn, "/api/dashboard")
    ag2 = {a["agent_id"]: a for a in body2["data"]["agents"]}
    check("回执到达后 Muse 恢复 idle", ag2["muse-chief"]["live_status"] == "idle",
          ag2["muse-chief"]["live_status"])
    conn.close()
    shutil.rmtree(d, ignore_errors=True)



def main():
    test_dashboard()
    test_dashboard_recent_failed_in_badge()
    test_dashboard_storm_not_in_badge()
    test_dashboard_degraded_receipt()
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
