#!/usr/bin/env python3
# 操作台 v1：在线判定、实例心跳回写、死信默认不入列表、知识全文防穿越。
# 用法：python3 90-System/runtime/tests/test_console_v1.py
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
import urllib.parse
import urllib.request
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
sys.path.insert(0, str(RT))
import console_api  # noqa: E402
import migrate_v2  # noqa: E402

FAILS = []
VIEWER = "viewer-test-token"
CHIEF = "chief-test-token"


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))
    if not cond:
        FAILS.append(name)


def fresh():
    d = Path(tempfile.mkdtemp(prefix="sb-console-"))
    conn = sqlite3.connect(str(d / "state.db"))
    migrate_v2.migrate(conn)
    return d, conn


def seed(conn, now=None):
    """拟真：大量 dead，实例心跳与 chief 的 last_seen 故意错开。"""
    now = int(now or time.time())
    conn.execute("UPDATE agents SET last_seen=NULL")
    old = now - 86400 * 3
    fresh_ids = ("chat-worker", "knowledge-worker", "deepseek-chief", "analysis-worker", "archive-worker")
    for aid in fresh_ids:
        conn.execute("UPDATE agents SET last_seen=? WHERE agent_id=?", (now - 20, aid))
    for aid in ("maus-chief", "research-worker", "dsh2-chief", "trae-chief"):
        conn.execute("UPDATE agents SET last_seen=? WHERE agent_id=?", (old, aid))
    conn.execute(
        "INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('幕僚长@云端','instance','Grok Bot box','grok-chief','active',?)", (now,))
    conn.execute(
        "INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('MAUS二号@笔记本','instance','笔记本','maus2-chief','active',?)", (now,))
    conn.execute(
        "INSERT INTO heartbeats(agent,ts,note) VALUES('DSH二号@笔记本',?,'sse') "
        "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts", (now - 5,))
    conn.execute(
        "INSERT INTO heartbeats(agent,ts,note) VALUES('Trae@笔记本',?,'sse') "
        "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts", (now - 8,))
    conn.execute(
        "INSERT INTO heartbeats(agent,ts,note) VALUES('chat-worker',?,'idle') "
        "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts", (now - 3,))
    conn.execute(
        "INSERT INTO events(event_id,source,type,payload,priority,status,created_at) "
        "VALUES('evt_dec','dsh2-chief','manual','{}',1,'new',?)", (now,))
    conn.execute(
        "INSERT INTO events(event_id,source,type,payload,priority,status,parent_id,created_at) "
        "VALUES('evt_do','dsh2-chief','manual','{\"text\":\"交给对话\"}',0,'new',NULL,?)", (now,))
    conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,lease_owner,claimed_at,created_at) "
        "VALUES('evt_dec','assist',?, 'pending',2,NULL,NULL,?)",
        (json.dumps({"text": "请批示：是否继续"}, ensure_ascii=False), now))
    doing_payload = json.dumps({"text": "把操作台总览写完，并附上心跳时间"}, ensure_ascii=False)
    cur = conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,lease_owner,claimed_at,created_at,result) "
        "VALUES('evt_do','chat',?,'doing',0,'chat-worker',?,?,NULL)",
        (doing_payload, now - 40, now - 80))
    doing_id = cur.lastrowid
    conn.execute(
        "INSERT INTO events(event_id,source,type,payload,priority,status,parent_id,created_at) "
        "VALUES('evt_prog','chat-worker','task_progress',?,0,'new','evt_do',?)",
        (json.dumps({"task_id": doing_id, "note": "写到实时事件流"}, ensure_ascii=False), now - 10))
    dsh_payload = json.dumps({"text": "DSH二号正在看队列"}, ensure_ascii=False)
    conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,lease_owner,claimed_at,created_at) "
        "VALUES('evt_dsh','assist',?,'doing',0,'dsh2-chief',?,?)",
        (dsh_payload, now - 30, now - 60))
    conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,lease_owner,created_at,done_at,result) "
        "VALUES('evt_done','chat',?,'done',0,'chat-worker',?,?,?)",
        (json.dumps({"text": "已交付的普通任务"}, ensure_ascii=False), now - 500, now - 400,
         "已完成 → 60-Outputs/results/task-demo-结果.md DONEMARKER"))
    dead_rows = [(json.dumps({"n": i, "text": "storm"}), now - i) for i in range(6000)]
    conn.executemany(
        "INSERT INTO tasks(event_id,type,payload,status,priority,max_retries,created_at,result) "
        "VALUES(NULL,'storm',?,'dead',0,3,?,'DEADMARKER')", dead_rows)
    conn.commit()
    return doing_id


def test_presence_and_lists():
    d, conn = fresh()
    now = int(time.time())
    doing_id = seed(conn, now)
    # 读路径：last_seen 仍是三天前，但实例心跳新鲜 → chief 在线
    code, body = console_api.handle_get(conn, "/api/agents")
    check("agents 200", code == 200)
    by_id = {a["agent_id"]: a for a in body["data"]}
    check("dsh2 实例心跳算工作中", by_id["dsh2-chief"]["live_status"] == "working",
          by_id["dsh2-chief"]["live_status"])
    check("dsh2 带上实例名", "DSH二号@笔记本" in (by_id["dsh2-chief"].get("instance_names") or []))
    check("trae 仅实例心跳也算空闲", by_id["trae-chief"]["live_status"] == "idle",
          by_id["trae-chief"]["live_status"])
    check("grok 从无心跳是久未使用", by_id["grok-chief"]["live_status"] == "unused")
    check("maus 过期是离线", by_id["maus-chief"]["live_status"] == "offline",
          by_id["maus-chief"]["live_status"])
    check("chat-worker 执行中", by_id["chat-worker"]["live_status"] == "working")
    check("knowledge-worker 空闲", by_id["knowledge-worker"]["live_status"] == "idle")
    check("code-worker 久未使用", by_id["code-worker"]["live_status"] == "unused")
    check("research-worker 离线", by_id["research-worker"]["live_status"] == "offline")

    code, one = console_api.handle_get(conn, "/api/agents/chat-worker")
    check("详情含指令原文", code == 200 and "操作台总览" in (one["data"].get("current_task") or {}).get("instruction", ""))
    notes = (one["data"].get("current_task") or {}).get("events") or []
    check("详情含进度留痕", any("实时事件流" in (e.get("payload") or "") for e in notes), notes[:1])
    paths = []
    for t in one["data"].get("recent_tasks") or []:
        paths.extend(t.get("result_paths") or [])
    check("详情抽出结果文件路径", any(p.startswith("60-Outputs/results/") for p in paths), paths)

    t0 = time.time()
    code, tasks = console_api.handle_get(conn, "/api/tasks?limit=30")
    elapsed = time.time() - t0
    statuses = {r["status"] for r in tasks["data"]}
    check("默认列表不含 dead", code == 200 and "dead" not in statuses and tasks.get("excluded_dead") is True, statuses)
    check("默认 total 不含 6000 死信", tasks.get("total", 0) < 100, tasks.get("total"))
    check("6000 死信下列表仍快", elapsed < 2.0, round(elapsed, 3))
    code, found = console_api.handle_get(conn, "/api/tasks?q=DONEMARKER")
    check("关键字命中非死信", found.get("total") == 1 and found["data"][0]["status"] == "done")
    code, missed = console_api.handle_get(conn, "/api/tasks?q=DEADMARKER")
    check("关键字默认不扫进死信结果", missed.get("total") == 0, missed.get("total"))
    code, dead = console_api.handle_get(conn, "/api/tasks?status=dead&limit=5")
    check("显式死信仍可分页", code == 200 and len(dead["data"]) == 5 and dead["data"][0]["status"] == "dead")
    check("死信 total 是存量", dead.get("total") == 6000, dead.get("total"))

    code, ov = console_api.handle_get(conn, "/api/overview")
    check("overview 带 console_rev", ov["data"].get("console_rev") == 1)
    check("overview 在线数不含久未使用", ov["data"]["agents_online"] < ov["data"]["agents_total"])
    check("待批示至少 1", ov["data"]["pending_decisions"] >= 1, ov["data"]["pending_decisions"])

    # 写路径：按 agent_ref 回写 last_seen，实例名不能变成 agent_id
    before = conn.execute("SELECT last_seen FROM agents WHERE agent_id='grok-chief'").fetchone()[0]
    touched = console_api.touch_instance_presence(conn, "幕僚长@云端", now)
    conn.commit()
    after = conn.execute("SELECT last_seen FROM agents WHERE agent_id='grok-chief'").fetchone()[0]
    ghost = conn.execute("SELECT COUNT(*) FROM agents WHERE agent_id='幕僚长@云端'").fetchone()[0]
    hb = conn.execute("SELECT ts FROM heartbeats WHERE agent='幕僚长@云端'").fetchone()
    check("touch 更新 grok-chief.last_seen", before != after and after == now, (before, after, touched))
    check("touch 不制造实例名 agent 行", ghost == 0)
    check("心跳键仍是实例名", hb and hb[0] == now)
    code, agents = console_api.handle_get(conn, "/api/agents")
    grok = next(a for a in agents["data"] if a["agent_id"] == "grok-chief")
    check("登记心跳后 grok 变为空闲", grok["live_status"] == "idle", grok["live_status"])

    # 名册没有的实例只记心跳，不改任何 last_seen
    snap = dict(conn.execute("SELECT agent_id,last_seen FROM agents"))
    console_api.touch_instance_presence(conn, "不存在的实例", now)
    conn.commit()
    snap2 = dict(conn.execute("SELECT agent_id,last_seen FROM agents"))
    check("未登记实例不改 agents", snap == snap2)
    check("详情进行中的任务号还在", doing_id > 0)
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def test_kb_guard():
    d = Path(tempfile.mkdtemp(prefix="sb-kb-"))
    try:
        (d / "10-Knowledge").mkdir()
        (d / "10-Knowledge" / "note.md").write_text("# 标题\n\n正文甲乙丙\n", encoding="utf-8")
        (d / "10-Knowledge" / "api_tokens.json").write_text("secret", encoding="utf-8")
        (d / "60-Outputs" / "results").mkdir(parents=True)
        (d / "60-Outputs" / "results" / "task-1-结果.md").write_text("结果正文\n", encoding="utf-8")
        (d / "90-System").mkdir()
        (d / "90-System" / "runtime.py").write_text("print(1)\n", encoding="utf-8")
        (d / ".git").mkdir()
        (d / ".git" / "config").write_text("secret\n", encoding="utf-8")
        old_root, old_k = console_api.ROOT, console_api.KNOWLEDGE
        console_api.ROOT = d
        console_api.KNOWLEDGE = d / "10-Knowledge"
        conn = sqlite3.connect(":memory:")
        try:
            code, body = console_api.handle_get(conn, "/api/knowledge/file?path=" + urllib.parse.quote("10-Knowledge/note.md"))
            check("全文可读", code == 200 and "正文甲乙丙" in body["data"]["content"], code)
            for path in (
                "10-Knowledge/../../90-System/runtime.py",
                "90-System/runtime.py",
                ".git/config",
                "10-Knowledge/api_tokens.json",
                "/etc/passwd",
                "10-Knowledge/note.md/../../.git/config",
            ):
                code, body = console_api.handle_get(conn, "/api/knowledge/file?path=" + urllib.parse.quote(path))
                check("拒绝 " + path, code in (400, 404) and "正文甲乙丙" not in json.dumps(body, ensure_ascii=False),
                      (code, body.get("error")))
            code, body = console_api.handle_get(
                conn, "/api/knowledge/file?path=" + urllib.parse.quote("60-Outputs/results/task-1-结果.md"))
            check("结果目录可读", code == 200 and "结果正文" in body["data"]["content"])
            code, body = console_api.handle_get(conn, "/api/knowledge/file?path=" + urllib.parse.quote("10-Knowledge/missing.md"))
            check("缺文件与缺路由区分", code == 404 and body.get("error") == "文件不存在", body)
        finally:
            console_api.ROOT = old_root
            console_api.KNOWLEDGE = old_k
            conn.close()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _get(port, path, token=VIEWER):
    req = urllib.request.Request(
        "http://127.0.0.1:%s%s" % (port, path),
        headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=8) as res:
        return res.status, json.loads(res.read().decode())


def _sse(port, instance):
    sock = socket.create_connection(("127.0.0.1", port), 5)
    sock.settimeout(5)
    q = urllib.parse.urlencode({"token": VIEWER, "instance": instance, "since": "1"})
    sock.sendall(("GET /api/stream?%s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" % q).encode())
    data = b""
    try:
        while b"\n" not in data and len(data) < 400:
            chunk = sock.recv(200)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    sock.close()
    return data


def _get_plain(port, path):
    req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path))
    with urllib.request.urlopen(req, timeout=8) as res:
        return res.status, json.loads(res.read().decode())


def _post_cmd(port, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        "http://127.0.0.1:%s/cmd" % port,
        data=b'{"cmd":"status","args":{}}',
        headers=headers,
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _sse_query(port, query):
    sock = socket.create_connection(("127.0.0.1", port), 5)
    sock.settimeout(5)
    sock.sendall(("GET /api/stream?%s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" % query).encode())
    data = b""
    try:
        while b"\r\n\r\n" not in data and len(data) < 800:
            chunk = sock.recv(200)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    sock.close()
    return data


def test_http_and_pages(db_path, port):
    code, health = _get(port, "/healthz", token="x")
    check("healthz 免鉴权", code == 200 and health.get("ok"), health)
    code, ov = _get_plain(port, "/api/overview")
    check("只读 overview 免口令", code == 200 and ov.get("ok") is not False, ov if code != 200 else "ok")
    code, ov = _get(port, "/api/overview", token="nope")
    check("错口令仍可只读", code == 200 and "data" in ov, code)
    cmd_code, _body = _post_cmd(port, token=None)
    check("写入 /cmd 无口令 401", cmd_code == 401, cmd_code)
    pub = _sse_query(port, "since=1")
    check("操作台 SSE 免口令", b"200" in pub.split(b"\r\n", 1)[0] or b"connected" in pub, pub[:180])
    denied = _sse_query(port, urllib.parse.urlencode({"instance": "幕僚长@云端", "since": "1"}))
    check("带 instance 的 SSE 无口令 401", b"401" in denied[:80], denied[:120])
    text = urllib.request.urlopen("http://127.0.0.1:%s/console/prototype/index.html" % port, timeout=8).read().decode()
    check("入口仍是 prototype", "多 Agent 操作台" in text and "ops.js" in text and "three.min.js" not in text)
    check("前端无口令框", 'id="token"' not in text and "gate-form" not in text)
    raw = _sse(port, "幕僚长@云端")
    check("SSE 实例连接", b"200" in raw.split(b"\r\n", 1)[0] or b"connected" in raw, raw[:180])
    conn = sqlite3.connect(db_path)
    try:
        seen = conn.execute("SELECT last_seen FROM agents WHERE agent_id='grok-chief'").fetchone()[0]
        ghost = conn.execute("SELECT COUNT(*) FROM agents WHERE agent_id='幕僚长@云端'").fetchone()[0]
        check("HTTP 在场写到 grok-chief", seen and int(time.time()) - int(seen) < 30, seen)
        check("HTTP 在场不把实例名当 agent_id", ghost == 0)
    finally:
        conn.close()
    bad = _sse(port, "没有这个实例")
    check("未登记实例 403", b"403" in bad[:80], bad[:120])
    code, body = _get(port, "/api/tasks?limit=10")
    check("HTTP 任务列表排除死信", all(r["status"] != "dead" for r in body["data"]))
    js = urllib.request.urlopen("http://127.0.0.1:%s/console/prototype/ops.js" % port, timeout=8).read().decode()
    check("前端不硬编码测试口令", VIEWER not in js and CHIEF not in js)
    check("前端按 console_rev 决定能否不带 status 拉任务", "consoleRev" in js)
    check("前端一条 SSE 失败会改轮询", "轮询模式" in js and "EventSource" in js)


def shoot(port):
    art = Path("/opt/cursor/artifacts")
    art.mkdir(parents=True, exist_ok=True)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright", "-q"])
        site = Path(sys.executable).resolve().parent.parent / "lib"
        user = Path.home() / ".local" / "lib"
        for base in (user, site):
            for p in base.glob("python*/site-packages"):
                if str(p) not in sys.path:
                    sys.path.append(str(p))
        from playwright.sync_api import sync_playwright
    url = "http://127.0.0.1:%s/console/prototype/index.html" % port
    shots = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/usr/local/bin/google-chrome",
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        def nav(page_id):
            page.locator('#nav button[data-page="%s"]' % page_id).click()

        page.goto(url)
        page.wait_for_selector("#feed")
        page.screenshot(path=str(art / "console-overview.png"))
        shots.append("console-overview.png")
        nav("agents")
        page.wait_for_selector('[data-agent="dsh2-chief"]')
        page.screenshot(path=str(art / "console-agents.png"))
        shots.append("console-agents.png")
        page.locator('[data-agent="dsh2-chief"]').click()
        page.wait_for_selector("#drawer >> text=当前在做什么")
        page.wait_for_selector("#drawer >> text=DSH二号正在看队列")
        page.screenshot(path=str(art / "console-agent-trace.png"))
        shots.append("console-agent-trace.png")
        page.locator("#drawer [data-close]").click()
        nav("tasks")
        page.wait_for_selector("#task-body >> text=已隐藏死信")
        page.screenshot(path=str(art / "console-tasks.png"))
        shots.append("console-tasks.png")
        nav("knowledge")
        page.wait_for_selector("#know-q")
        page.fill("#know-q", "幕僚长接入")
        page.press("#know-q", "Enter")
        page.wait_for_selector("[data-doc*='幕僚长接入']")
        page.locator("[data-doc*='幕僚长接入']").first.click()
        page.wait_for_selector("text=写前先拉")
        page.screenshot(path=str(art / "console-knowledge.png"))
        shots.append("console-knowledge.png")
        nav("network")
        page.wait_for_selector("text=可以委派的通道")
        page.wait_for_selector(".ops-edge.active", state="attached")
        page.screenshot(path=str(art / "console-network.png"))
        shots.append("console-network.png")
        page.set_viewport_size({"width": 390, "height": 844})
        nav("overview")
        page.wait_for_selector("#feed")
        page.screenshot(path=str(art / "console-overview-mobile.png"))
        shots.append("console-overview-mobile.png")
        browser.close()
    for name in shots:
        check("截图 " + name, (art / name).stat().st_size > 5000)
    print("SHOTS " + ", ".join(shots))


def main():
    test_presence_and_lists()
    test_kb_guard()
    d, conn = fresh()
    seed(conn)
    conn.close()
    token_file = d / "tokens.json"
    token_file.write_text(json.dumps({
        "tokens": {"grok-chief": CHIEF},
        "viewers": {"console": VIEWER},
    }), encoding="utf-8")
    port = 18766
    proc = subprocess.Popen(
        [sys.executable, str(RT / "tests" / "fixture_server.py"), str(d / "state.db"), str(token_file), str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        line = proc.stdout.readline()
        print(line.strip())
        deadline = time.time() + 8
        up = False
        while time.time() < deadline:
            try:
                urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=1).read()
                up = True
                break
            except Exception:
                if proc.poll() is not None:
                    break
                time.sleep(0.1)
        check("fixture 服务起来", up, line)
        if up:
            test_http_and_pages(str(d / "state.db"), port)
            shoot(port)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(d, ignore_errors=True)
    print("\n== %s 项失败 ==" % len(FAILS) if FAILS else "\n== 全部通过 ==")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
