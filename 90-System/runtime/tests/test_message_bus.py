#!/usr/bin/env python3
# 消息总线 v1 单测：建表、msg/reply、防伪造、不进 events，以及本地 HTTP
# 走一遍 msg → SSE → reply → rollcall。
# 用法：python3 90-System/runtime/tests/test_message_bus.py
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RT))
import api_server  # noqa: E402
import console_api  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import runtime  # noqa: E402

FAILS = []
TOKENS = {
    "grok-chief": "test-token-grok",
    "dsh-chief": "test-token-dsh",
    "dsh2-chief": "test-token-dsh2",
    "maus2-chief": "test-token-maus2",
}


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))
    if not cond:
        FAILS.append(name)


def fresh():
    d = Path(tempfile.mkdtemp(prefix="sb-bus-"))
    ev = d / "50-Events"
    ev.mkdir()
    runtime.EVENTS_DIR = ev
    runtime.ROOT = d
    conn = sqlite3.connect(str(d / "state.db"), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    migrate_v2.migrate(conn)
    now = int(time.time())
    conn.execute(
        "INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('MAUS2号@笔记本','instance','笔记本','maus2-chief','active',?)", (now,))
    conn.commit()
    return d, conn


def test_schema_and_cmds():
    d, conn = fresh()
    # 幂等建表
    message_bus.ensure_schema(conn)
    message_bus.ensure_schema(conn)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(messages)")]
    check("表字段齐全", cols == ["msg_id", "from_agent", "from_instance", "to",
                               "kind", "text", "reply_to", "thread_id", "created_at"], cols)

    ev_before = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    r = runtime.chief_execute(conn, "grok-chief", "msg", {
        "to": "all", "text": "所有在线 Agent 回复 1", "kind": "ping",
        "from": "dsh2-chief", "from_agent": "dsh2-chief"})  # 伪造字段必须被忽略
    check("msg 成功", r.get("ok") and str(r.get("msg_id", "")).startswith("msg_"), r)
    check("from 不能伪造", r.get("from_agent") == "grok-chief", r.get("from_agent"))
    ev_after = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    check("msg 不写 events", ev_after == ev_before, (ev_before, ev_after))

    mid = r["msg_id"]
    r2 = runtime.chief_execute(conn, "dsh2-chief", "reply", {
        "reply_to": mid, "text": "1 · DSH二号@笔记本 · 收到于测试",
        "instance": "DSH二号@笔记本"})
    check("reply 成功", r2.get("ok"), r2)
    check("reply.to 是原发件人", r2.get("to") == "grok-chief", r2.get("to"))
    check("reply 挂同一线程", r2.get("thread_id") == r.get("thread_id"), r2.get("thread_id"))

    # 冒用别人的实例名
    bad = runtime.chief_execute(conn, "grok-chief", "msg", {
        "to": "dsh-chief", "text": "x", "instance": "DSH二号@笔记本"})
    check("不能冒用他人实例", not bad.get("ok") and "不属于" in (bad.get("error") or ""), bad)

    # 未知收件人
    bad2 = runtime.chief_execute(conn, "grok-chief", "msg", {"to": "no-such-agent", "text": "x"})
    check("未知收件人拒绝", not bad2.get("ok"), bad2)

    # worker 身份不能发（指挥权分离）
    bad3 = runtime.chief_execute(conn, "chat-worker", "msg", {"to": "all", "text": "x"})
    check("worker 不能发 msg", not bad3.get("ok"), bad3)

    # GET 查询
    code, body = console_api.handle_get(conn, "/api/messages?thread=" + r["thread_id"])
    check("GET /api/messages", code == 200 and body["total"] >= 2, body.get("total"))
    code, rc = console_api.handle_get(conn, "/api/rollcall/" + mid)
    check("GET /api/rollcall", code == 200 and rc["data"]["replied_count"] == 1, rc)
    data = rc["data"]
    check("rollcall 含时延", data["replies"][0]["latency_seconds"] >= 0)
    names = {e["agent_id"] for e in data["missing"]}
    check("发件人不在 missing", "grok-chief" not in names, names)
    check("已回复者不在 missing 或已记入 replies",
          data["replies"][0]["from_agent"] == "dsh2-chief")
    check("rollcall 原消息仍不进 events",
          conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == ev_before)

    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def _post(port, tok, cmd, args):
    body = json.dumps({"cmd": cmd, "args": args}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:%s/cmd" % port, data=body, method="POST",
        headers={"Authorization": "Bearer " + tok,
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _get(port, tok, path):
    req = urllib.request.Request(
        "http://127.0.0.1:%s%s" % (port, path),
        headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _sse_loop(port, tok, instance, bucket, stop, since=0):
    qs = {"since": str(since)}
    if instance:
        qs["instance"] = instance
    url = "http://127.0.0.1:%s/api/stream?%s" % (port, urllib.parse.urlencode(qs))
    req = urllib.request.Request(
        url, headers={"Authorization": "Bearer " + tok, "Accept": "text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=None) as resp:
            bucket["connected"] = True
            event, data = "message", []
            for raw in resp:
                if stop.is_set():
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip())
                elif line == "":
                    if event == "msg" and data:
                        try:
                            bucket.setdefault("msgs", []).append(json.loads("\n".join(data)))
                        except Exception:
                            pass
                    event, data = "message", []
    except Exception as e:
        bucket["error"] = type(e).__name__


def _free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_http_sse_rollcall():
    d, conn = fresh()
    db_path = str(d / "state.db")
    conn.close()
    port = _free_port()
    stop = threading.Event()

    def db_fn():
        c = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
        c.execute("PRAGMA busy_timeout=5000")
        return c

    def log_event(kind, **fields):
        return None

    handler = api_server._make_handler(
        db_fn, runtime.chief_execute, log_event, TOKENS, {}, stop)
    server = api_server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    th = threading.Thread(target=server.serve_forever, name="bus-test-http", daemon=True)
    th.start()
    try:
        urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=3).read()
    except Exception as e:
        check("本地服务器起来", False, e)
        stop.set()
        server.shutdown()
        shutil.rmtree(d, ignore_errors=True)
        return

    nodes = [
        ("dsh-chief", TOKENS["dsh-chief"], "DSH一号@主机"),
        ("dsh2-chief", TOKENS["dsh2-chief"], "DSH二号@笔记本"),
        ("maus2-chief", TOKENS["maus2-chief"], "MAUS2号@笔记本"),
    ]
    stops, buckets, threads = [], [], []
    for _aid, tok, inst in nodes:
        st, b = threading.Event(), {}
        t = threading.Thread(target=_sse_loop, args=(port, tok, inst, b, st, int(time.time()) - 2),
                             daemon=True)
        t.start()
        stops.append(st)
        buckets.append(b)
        threads.append(t)

    # 等三条 SSE 连上
    deadline = time.time() + 5
    while time.time() < deadline and not all(b.get("connected") for b in buckets):
        time.sleep(0.05)
    check("三条模拟节点 SSE 已连接", all(b.get("connected") for b in buckets),
          [b.get("connected") for b in buckets])

    # 点名
    sent = _post(port, TOKENS["grok-chief"], "msg", {
        "to": "all", "kind": "ping", "text": "所有在线 Agent 回复 1"})
    check("HTTP msg 点名成功", sent.get("ok"), sent)
    mid = sent.get("msg_id")

    # 各节点看到消息后 reply（模拟桥的 ping 处理）
    deadline = time.time() + 6
    while time.time() < deadline:
        if all(any(m.get("msg_id") == mid for m in b.get("msgs") or []) for b in buckets):
            break
        time.sleep(0.05)
    seen = [any(m.get("msg_id") == mid for m in b.get("msgs") or []) for b in buckets]
    check("三个节点都收到点名正文", all(seen), seen)
    # 消息应含 text
    if buckets[0].get("msgs"):
        hit = next(m for m in buckets[0]["msgs"] if m.get("msg_id") == mid)
        check("SSE 推了完整正文", "所有在线 Agent 回复 1" in (hit.get("text") or ""), hit)

    # 发件人自己的 SSE 不应收到这条广播
    self_b, self_st = {}, threading.Event()
    # 先发再连会错过，这里只验证：另开一条 grok 连接后不应因回放 since=0 之外的逻辑误推
    # 用 since=点名之前，若过滤正确，grok 仍不应收到自己的广播
    tself = threading.Thread(
        target=_sse_loop,
        args=(port, TOKENS["grok-chief"], None, self_b, self_st, int(sent["created_at"])),
        daemon=True)
    tself.start()
    time.sleep(1.2)
    own = [m for m in self_b.get("msgs") or [] if m.get("msg_id") == mid]
    check("广播不回推给发件人", self_b.get("connected") and not own, own)
    self_st.set()

    # 各节点 reply
    t0 = time.time()
    for aid, tok, inst in nodes:
        time.sleep(0.05)  # 让时延可分辨
        rr = _post(port, tok, "reply", {
            "reply_to": mid,
            "text": "1 · %s · 收到于测试\nlayer=transport" % inst,
            "instance": inst})
        check("节点 %s 回复成功" % inst, rr.get("ok"), rr)
    # rollcall
    rc = _get(port, TOKENS["grok-chief"], "/api/rollcall/" + mid)
    data = rc.get("data") or {}
    replies = data.get("replies") or []
    check("rollcall 三份回复", len(replies) == 3, data.get("replied_count"))
    lats = [r.get("latency_seconds") for r in replies]
    check("每条回复都有时延秒数", all(isinstance(x, int) and x >= 0 for x in lats), lats)
    agents = {r["from_agent"] for r in replies}
    check("三个 chief 都回了", agents == {"dsh-chief", "dsh2-chief", "maus2-chief"}, agents)
    # 点名本身不应进 events
    c = db_fn()
    evn = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    c.close()
    check("整轮点名未写 events", evn == 0, evn)

    print("")
    print("—— 本地点名回执 ——")
    print("msg_id=%s  回复 %s 人" % (mid, data.get("replied_count")))
    for r in replies:
        print("  +%ss  %s / %s" % (r.get("latency_seconds"), r.get("from_agent"),
                                   r.get("from_instance")))
        print("      %s" % (r.get("text") or "").splitlines()[0])
    missing_online = data.get("missing_online") or []
    print("  在场未回复：%s" % (missing_online or "无"))

    for st in stops:
        st.set()
    stop.set()
    server.shutdown()
    shutil.rmtree(d, ignore_errors=True)
    return mid, lats




def test_poll_targeted_not_starved_by_old_broadcasts():
    """复现 2026-11-11：since=0 时全表最旧 200 条里都是别人的消息和旧广播 ping，
    定向给 Muse 的新消息排在 200 条之后，旧实现永远推不到桥。"""
    d, conn = fresh()
    message_bus.ensure_schema(conn)
    conn.execute(
        "INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('Muse@本机','instance','sandbox','muse-chief','active',?)", (1,))
    # 两条旧广播 ping（可见）+ 250 条发给别人的消息（不可见）+ 一条新的定向任务
    conn.execute(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES('ping_old','grok-chief','幕僚长@云端','all','ping','所有在线回复 1',NULL,'ping_old',100)")
    conn.execute(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES('ping_old2','grok-chief','幕僚长@云端','all','ping','再点一次',NULL,'ping_old2',101)")
    rows = []
    for i in range(250):
        mid = "other_%03d" % i
        rows.append((mid, "dsh-chief", "DSH一号@主机", "dsh2-chief", "chat", "别人的话 %d" % i,
                     None, mid, 200 + i))
    conn.executemany(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES(?,?,?,?,?,?,?,?,?)", rows)
    conn.execute(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES('msg_target','grok-chief','幕僚长@云端','muse-chief','chat',"
        "'【自审计交付】请初审并回执',NULL,'msg_target',900)")
    conn.commit()
    got = message_bus.poll_for_connection(conn, 0, "muse-chief", "Muse@本机")
    ids = [m["msg_id"] for m in got]
    check("定向新消息出现在第一轮（未被旧广播饿死）", "msg_target" in ids, ids[:8] + ["..."] + ids[-3:])
    check("旧广播 ping 仍然可见", "ping_old" in ids and "ping_old2" in ids, ids[:5])
    check("别人的定向消息不可见", all(not i.startswith("other_") for i in ids), len(ids))
    check("第一轮条数=2 条广播+1 条定向", len(ids) == 3, len(ids))
    # 自己发出的广播不应出现
    conn.execute(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES('self_all','muse-chief','Muse@本机','all','ping','我发的广播',NULL,'self_all',50)")
    conn.commit()
    got2 = message_bus.poll_for_connection(conn, 0, "muse-chief", "Muse@本机")
    ids2 = [m["msg_id"] for m in got2]
    check("不回推自己发出的广播", "self_all" not in ids2, ids2[:5])
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def main():
    test_schema_and_cmds()
    test_poll_targeted_not_starved_by_old_broadcasts()
    test_http_sse_rollcall()
    print("\n== %s 项失败 ==" % len(FAILS) if FAILS else "\n== 全部通过 ==")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
