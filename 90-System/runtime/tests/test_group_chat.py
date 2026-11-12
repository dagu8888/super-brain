#!/usr/bin/env python3
# 群聊：建群、主人发言、外部 Agent 配对后发言、叫醒不含正文和令牌、失败不派任务、
# 名册不把心跳当成可对话。
# 用法：python3 90-System/runtime/tests/test_group_chat.py
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
sys.path.insert(0, str(RT))

os.environ["SB_OWNER_UNLOCK_PHRASE"] = "群聊测试口令甲|群聊测试口令乙"

import api_server  # noqa: E402
import console_api  # noqa: E402
import group_chat  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import runtime  # noqa: E402

FAILS = []
WHO = {"actor": "dagu-owner", "device": "test", "device_id": None}
TOKENS = {"grok-chief": "test-token-grok", "dsh-chief": "test-token-dsh"}


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def fresh():
    d = Path(tempfile.mkdtemp(prefix="sb-group-"))
    runtime.EVENTS_DIR = d / "50-Events"
    runtime.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    runtime.ROOT = d
    conn = sqlite3.connect(str(d / "state.db"))
    conn.execute("PRAGMA journal_mode=WAL")
    migrate_v2.migrate(conn)
    message_bus.ensure_schema(conn)
    owner_ops.ensure_schema(conn)
    group_chat.ensure_schema(conn)
    group_chat.set_wake_transport(None)
    return d, conn


def counts(conn):
    ev = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    tk = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    return ev, tk


def dump_db(conn):
    parts = []
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        try:
            rows = conn.execute("SELECT * FROM %s" % name).fetchall()
        except sqlite3.OperationalError:
            continue
        parts.append(name + ":" + json.dumps(rows, ensure_ascii=False, default=str))
    return "\n".join(parts)


def test_create_send_and_roster():
    d, conn = fresh()
    ev0, tk0 = counts(conn)
    now = int(time.time())
    conn.execute(
        "INSERT INTO heartbeats(agent, ts, note) VALUES('muse-chief', ?, 'sse')", (now,))
    conn.commit()
    made = owner_ops.execute(conn, WHO, "group_create",
                             {"name": "外部协作", "members": ["grok-chief", "不存在的人"]})
    check("建群成功", made.get("ok") and str(made.get("group_id", "")).startswith("grp_"), made.get("error"))
    gid = made["group_id"]
    check("主人自动进群", any(m["member_id"] == "dagu-owner" and m["sender_badge"] == "人"
                           for m in made["group"]["members"]))
    check("名册里的 Agent 被拉进群", "grok-chief" in made["added"], made["added"])
    grok_m = next((m for m in made["group"]["members"] if m["member_id"] == "grok-chief"), None)
    check("群成员把中台 Agent 标成你的 agent", bool(grok_m) and grok_m.get("sender_badge") == "你的 agent")
    check("不在名册的人拉不进来", any("不存在" in (s.get("error") or "") for s in made["skipped"]))
    check("建群不写 events / tasks", counts(conn) == (ev0, tk0))

    code, roster = console_api.handle_get(conn, "/api/groupchat/roster")
    by_id = {a["id"]: a for a in roster["data"]}
    check("名册接口可读", code == 200 and "grok-chief" in by_id and "muse-chief" in by_id)
    check("名册把中台 Agent 标成你的 agent", by_id["grok-chief"].get("sender_badge") == "你的 agent")
    check("心跳不构成可对话", by_id["muse-chief"]["talk_state"] == "unproven" and "online" not in by_id["muse-chief"],
          by_id["muse-chief"].get("talk_label"))
    check("名册文案不说在线", "在线" not in by_id["muse-chief"]["talk_label"] and "离线" not in by_id["muse-chief"]["talk_label"])

    sent = owner_ops.execute(conn, WHO, "group_send", {"group_id": gid, "text": "大家好，我是主人"})
    check("主人发言成功", sent.get("ok"), sent.get("error"))
    msg = sent["message"]
    check("主人消息标成人", msg["sender_role"] == "human" and msg["sender_badge"] == "人" and msg["sender_name"] == "大古")
    check("发言写在 messages 且线程是群", conn.execute(
        'SELECT thread_id, "to", from_agent FROM messages WHERE msg_id=?', (sent["msg_id"],)).fetchone()
          == (gid, gid, "dagu-owner"))
    check("发言仍不写 events / tasks", counts(conn) == (ev0, tk0))

    hist = console_api.handle_get(conn, "/api/groupchat/groups/%s/messages" % gid)[1]["data"]
    texts = [m["text"] for m in hist]
    check("历史里看得到主人的话", "大家好，我是主人" in texts)
    check("历史里有加入记录", any("加入了群聊" in t for t in texts))

    # 群消息不把指挥入口打成「回执失败」
    conn.execute("INSERT INTO heartbeats(agent, ts, note) VALUES('幕僚长@云端', ?, 'sse')", (now,))
    conn.execute("UPDATE agents SET last_seen=? WHERE agent_id='grok-chief'", (now,))
    conn.commit()
    code, agents = console_api.handle_get(conn, "/api/agents")
    grok = next(a for a in agents["data"] if a["agent_id"] == "grok-chief")
    check("群消息不把 Agent 打成回执失败", grok["live_status"] != "degraded", grok["live_status"])

    # 已接入 Agent 用 /cmd msg 进同一群
    via = runtime.chief_execute(conn, "grok-chief", "msg", {
        "to": gid, "text": "幕僚长收到", "from": "dagu-owner"})
    check("成员可以用 /cmd msg 发言", via.get("ok") and via["message"]["sender_badge"] == "你的 agent", via.get("error"))
    check("不能伪造 from", via["message"]["from_agent"] == "grok-chief")
    outsider = runtime.chief_execute(conn, "dsh-chief", "msg", {"to": gid, "text": "我不在群里"})
    check("群外的人不能发言", not outsider.get("ok") and "不在这个群" in (outsider.get("error") or ""))

    # 有过真实收发之后才算证实，仍然不看心跳
    code, roster = console_api.handle_get(conn, "/api/groupchat/roster")
    by_id = {a["id"]: a for a in roster["data"]}
    check("发言后才证实可收发", by_id["grok-chief"]["talk_state"] == "proven" and by_id["grok-chief"]["last_tx_at"])
    check("只有心跳的仍未证实", by_id["muse-chief"]["talk_state"] == "unproven")

    rec = owner_ops.execute(conn, WHO, "group_recall", {"group_id": gid, "msg_id": sent["msg_id"]})
    check("可以撤回自己的消息", rec.get("ok"), rec.get("error"))
    hist = console_api.handle_get(conn, "/api/groupchat/groups/%s/messages" % gid)[1]["data"]
    check("撤回后原文不在群历史里", "大家好，我是主人" not in json.dumps(hist, ensure_ascii=False))
    check("撤回是单独一行系统事件", any(m["sender_role"] == "system" and "撤回了一条消息" in m["text"] for m in hist))
    check("撤回也不派任务", counts(conn) == (ev0, tk0))
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def test_wake_once_without_body():
    d, conn = fresh()
    ev0, tk0 = counts(conn)
    made = owner_ops.execute(conn, WHO, "group_create", {"name": "叫醒", "members": ["grok-chief"]})
    gid = made["group_id"]
    owner_ops.execute(conn, WHO, "group_webhook",
                      {"member_id": "grok-chief", "url": "http://127.0.0.1:9/hook"})
    seen = []

    def transport(url, body):
        seen.append((url, body))
        return 500, "HTTPError"

    group_chat.set_wake_transport(transport)
    secret = "这句话不能出现在叫醒里-TOKEN-abc"
    try:
        sent = owner_ops.execute(conn, WHO, "group_send", {"group_id": gid, "text": secret})
    finally:
        group_chat.set_wake_transport(None)
    check("失败的叫醒只打一次", len(seen) == 1, len(seen))
    raw = seen[0][1].decode("utf-8") if seen else ""
    payload = json.loads(raw) if raw else {}
    check("叫醒只有信号字段", set(payload) == {"event", "group_id", "msg_id", "pull"}, sorted(payload))
    check("叫醒不含正文和令牌", secret not in raw and "TOKEN" not in raw and "Authorization" not in raw)
    check("叫醒指向收件箱", payload.get("event") == "inbox" and payload.get("pull") == "/api/groupchat/inbox")
    check("状态是 missed 且不派任务", sent["wakes"][0]["status"] == "missed" and counts(conn) == (ev0, tk0),
          sent.get("wakes"))
    code, wakes = console_api.handle_get(conn, "/api/groupchat/wakes?msg_id=" + sent["msg_id"])
    check("漏通知只查得到状态", code == 200 and wakes["data"][0]["status"] == "missed")
    # 再查一次不会补打
    check("查询状态不会再次叫醒", len(seen) == 1)
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def test_external_pair_and_speak():
    d, conn = fresh()
    ev0, tk0 = counts(conn)
    made = owner_ops.execute(conn, WHO, "group_create", {"name": "外部群", "members": []})
    gid = made["group_id"]
    paired = owner_ops.execute(conn, WHO, "group_pair", {"group_id": gid, "name": "Claude"})
    code = paired.get("code")
    check("能签发配对码", paired.get("ok") and code and "code" not in json.dumps(owner_ops.audit_detail("group_pair", {}, paired)))
    check("配对码带真实群名", paired.get("group_name") == "外部群" and paired.get("group_id") == gid)
    loose = owner_ops.execute(conn, WHO, "group_pair", {})
    check("没绑群就不写群名", loose.get("ok") and not loose.get("group_id") and not loose.get("group_name"))
    short = owner_ops.execute(conn, WHO, "group_checkin", {"ext_id": "ext_nope", "seconds": 60})
    check("拒绝分钟级 check-in", not short.get("ok") and "1 小时" in (short.get("error") or ""))

    res = group_chat.redeem_pair(conn, code, "Claude", checkin_seconds=60)
    check("过短的 check-in 不能换令牌", not res.get("ok"))
    res = group_chat.redeem_pair(conn, code, "Claude", webhook_url="http://127.0.0.1:9/wake",
                                 checkin_seconds=21600)
    token = res.get("token")
    check("配对码换到令牌并进群", res.get("ok") and res.get("group_id") == gid and token, res.get("error"))
    again = group_chat.redeem_pair(conn, code, "Claude")
    check("配对码只能用一次", not again.get("ok"))
    blob = dump_db(conn)
    check("库里没有配对码和令牌明文", code not in blob and token not in blob)

    seen = []

    def transport(url, body):
        seen.append(body)
        return 204, ""

    group_chat.set_wake_transport(transport)
    try:
        posted = group_chat.handle_post(
            conn, "/api/groupchat/messages",
            {"group_id": gid, "text": "外部 Agent 到了"},
            token, {})
    finally:
        group_chat.set_wake_transport(None)
    check("外部 Agent 发言接口成功", posted[0] == 200 and posted[1].get("ok"), posted[1].get("error"))
    check("外部消息标成外部", posted[1]["message"]["sender_role"] == "external" and posted[1]["message"]["sender_badge"] == "外部")
    check("气泡出现外部字样", "外部" in json.dumps(posted[1]["message"], ensure_ascii=False))
    code_r, roster = console_api.handle_get(conn, "/api/groupchat/roster")
    ext_row = next((a for a in roster["data"] if a.get("id") == res.get("ext_id")), None)
    check("名册出现外部字样", code_r == 200 and ext_row and ext_row.get("sender_badge") == "外部" and ext_row.get("kind") == "external"
          and "外部" in json.dumps(ext_row, ensure_ascii=False))
    internal = next((a for a in roster["data"] if a.get("id") == "grok-chief"), None)
    check("名册里中台 Agent 仍是你的 agent", internal and internal.get("sender_badge") == "你的 agent")
    members = (group_chat.get_group(conn, gid) or {}).get("members") or []
    ext_m = next((m for m in members if m["member_id"] == res.get("ext_id")), None)
    human_m = next((m for m in members if m["member_id"] == "dagu-owner"), None)
    check("群成员列表出现外部字样", bool(ext_m) and ext_m.get("sender_badge") == "外部" and ext_m.get("member_kind") == "external"
          and "外部" in json.dumps(ext_m, ensure_ascii=False))
    check("群成员里主人仍是人", bool(human_m) and human_m.get("sender_badge") == "人")
    hist = group_chat.list_group_messages(conn, gid)
    check("群历史看得到外部发言", any(m["text"] == "外部 Agent 到了" for m in hist))
    check("外部发言不派任务", counts(conn) == (ev0, tk0))
    # 主人没有 webhook，被叫醒的是... 外部自己发的，其他成员只有主人，主人不叫醒。seen 应为空。
    check("不会叫醒发件人自己", seen == [])

    # 主人再发一句，应该叫醒外部 Agent 一次，且正文不在信号里
    group_chat.set_wake_transport(transport)
    try:
        owner_ops.execute(conn, WHO, "group_send", {"group_id": gid, "text": "主人回复外部"})
    finally:
        group_chat.set_wake_transport(None)
    check("主人发言会叫醒外部 Agent 一次", len(seen) == 1)
    raw = seen[0].decode("utf-8")
    check("这次叫醒也没有正文和令牌", "主人回复外部" not in raw and token not in raw and code not in raw)

    early = group_chat.checkin(conn, group_chat.external_by_token(conn, token))
    check("第一次稀疏打卡被接受", early.get("accepted") is True and counts(conn) == (ev0, tk0))
    late = group_chat.checkin(conn, group_chat.external_by_token(conn, token))
    check("间隔未到不重试不派任务", late.get("accepted") is False and late.get("reason") == "too_soon" and counts(conn) == (ev0, tk0))

    inbox = group_chat.handle_authed_get(conn, "/api/groupchat/inbox", {}, token, {})
    check("收件箱要令牌且能读到群", inbox[0] == 200 and any(
        m["text"] == "外部 Agent 到了" for m in inbox[1]["data"]["messages"]))
    naked = group_chat.handle_authed_get(conn, "/api/groupchat/inbox", {}, "", {})
    check("没有令牌不能拉收件箱", naked[0] == 401)

    paired2 = owner_ops.execute(conn, WHO, "group_pair", {"group_id": gid})
    status, redeemed = group_chat.handle_post(
        conn, "/api/groupchat/pair",
        {"code": paired2.get("code"), "name": "只凭码"},
        "", {})
    check("pair 只凭 code、不带 Authorization 就能换令牌",
          status == 200 and redeemed.get("ok") and redeemed.get("token") and redeemed.get("group_id") == gid
          and not redeemed.get("webhook_registered"), redeemed.get("error"))
    group_chat.set_wake_transport(lambda url, body: (204, ""))
    try:
        said = group_chat.handle_post(
            conn, "/api/groupchat/messages",
            {"group_id": gid, "text": "只凭邀请码进群"},
            redeemed.get("token") or "", {})
    finally:
        group_chat.set_wake_transport(None)
    msg = (said[1] or {}).get("message") or {}
    check("不带主人令牌也能进群发言", said[0] == 200 and said[1].get("ok") and msg.get("sender_badge") == "外部")
    check("只凭码进群后仍不派任务", counts(conn) == (ev0, tk0))
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


class _WakeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.server.got = self.rfile.read(n)
        self.server.auth = self.headers.get("Authorization")
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        return


def _free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _req(port, path, method="GET", body=None, token=""):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            obj = json.loads(raw or "{}")
        except Exception:
            obj = {"ok": False, "error": raw[:180]}
        return e.code, obj


def test_http_pair_speak_and_real_wake():
    d, conn = fresh()
    db_path = str(d / "state.db")
    conn.close()
    port = _free_port()
    wake_port = _free_port()
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
    threading.Thread(target=server.serve_forever, name="group-api", daemon=True).start()

    wake = ThreadingHTTPServer(("127.0.0.1", wake_port), _WakeHandler)
    wake.got = b""
    wake.auth = "unset"
    wake.daemon_threads = True
    threading.Thread(target=wake.serve_forever, name="group-wake", daemon=True).start()
    group_chat.set_wake_transport(None)
    try:
        urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=3).read()
        st, unlocked = _req(port, "/api/owner/unlock", "POST",
                            {"phrase": "群聊测试口令甲", "device_name": "测试"})
        check("HTTP 当日口令可解锁", st == 200 and unlocked.get("token"), st)
        owner = unlocked.get("token") or ""
        st, made = _req(port, "/api/owner/act", "POST",
                        {"action": "group_create", "args": {"name": "接口群", "members": ["grok-chief"]}},
                        owner)
        check("HTTP 建群", st == 200 and made.get("ok"), made.get("error"))
        gid = made.get("group_id")
        st, said = _req(port, "/api/owner/act", "POST",
                        {"action": "group_send", "args": {"group_id": gid, "text": "从接口发出"}},
                        owner)
        check("HTTP 主人发言", st == 200 and said.get("message", {}).get("sender_badge") == "人", said.get("error"))
        st, hist = _req(port, "/api/groupchat/groups/%s/messages" % gid)
        check("免口令能看历史", st == 200 and any(m.get("text") == "从接口发出" for m in hist.get("data") or []))

        st, paired = _req(port, "/api/owner/act", "POST",
                          {"action": "group_pair", "args": {"group_id": gid}}, owner)
        check("HTTP 生成配对码", st == 200 and paired.get("code") and paired.get("group_name") == "接口群")
        st, ext = _req(port, "/api/groupchat/pair", "POST", {
            "code": paired["code"], "name": "ChatGPT",
            "webhook_url": "http://127.0.0.1:%s/hook" % wake_port,
        })
        check("HTTP 配对码换令牌", st == 200 and ext.get("token") and ext.get("group_id") == gid, ext.get("error"))
        check("HTTP pair 只凭 code、不带 Authorization", st == 200 and ext.get("token") and not ext.get("error"))
        token = ext.get("token") or ""
        st, spoken = _req(port, "/api/groupchat/messages", "POST",
                          {"group_id": gid, "text": "ChatGPT 进群了"}, token)
        check("HTTP 外部 Agent 发言", st == 200 and spoken.get("ok"), spoken.get("error"))
        # 外部发言不该叫醒自己；再让主人说一句，真实 HTTP 叫醒应打到本地
        wake.got = b""
        st, said2 = _req(port, "/api/owner/act", "POST",
                         {"action": "group_send", "args": {"group_id": gid, "text": "请看收件箱"}},
                         owner)
        check("HTTP 主人再次发言", st == 200 and said2.get("ok"))
        deadline = time.time() + 3
        while time.time() < deadline and not wake.got:
            time.sleep(0.02)
        body = (wake.got or b"").decode("utf-8")
        payload = json.loads(body) if body else {}
        check("真实 webhook 收到且无正文无令牌",
              payload.get("event") == "inbox" and "请看收件箱" not in body and token not in body
              and wake.auth in (None, "", "unset"), body[:180])
        st, inbox = _req(port, "/api/groupchat/inbox", token=token)
        check("外部 Agent 拉到收件箱", st == 200 and any(
            m.get("text") == "请看收件箱" for m in inbox.get("data", {}).get("messages") or []))
        st, doc = 200, urllib.request.urlopen(
            "http://127.0.0.1:%s/console/prototype/groupchat/install.md" % port, timeout=3).read().decode("utf-8")
        check("接入文档能从操作台路径读到", "webhook" in doc and "/api/groupchat/pair" in doc and "分钟" in doc)
        check("线上的 install 不让外部 Agent 去要当日口令",
              "一次性邀请码就是入场凭证" in doc and "口令沿用" not in doc and "把当日口令" not in doc
              and "需要当日口令" not in doc)
        c = sqlite3.connect(db_path)
        blob = dump_db(c)
        c.close()
        check("HTTP 流程后库里仍无令牌明文", token not in blob and paired["code"] not in blob)
    finally:
        stop.set()
        server.shutdown()
        wake.shutdown()
        group_chat.set_wake_transport(None)
        shutil.rmtree(d, ignore_errors=True)


def _asks_agent_for_daily_pass(text):
    """外部 Agent 读到的文档里，不能出现让他们去要、去填当日口令的句子。"""
    bad = (
        "口令沿用",
        "把当日口令",
        "索取当日口令",
        "需要当日口令",
        "输入当日口令",
        "提供当日口令",
        "主人给你的当日口令",
        "主人给你的口令",
        "向主人要当日口令",
    )
    return [b for b in bad if b in text]


def test_pages_exist():
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    check("操作台有群聊板块", 'data-tab="groups"' in html and "以你自己的身份说点什么" in html)
    check("前端走现有口令解锁和群接口", "group_send" in js and "/api/groupchat/roster" in js and "askUnlock" in js)
    check("前端不写死令牌", "token=" not in js and "?token" not in js)
    check("静态资源版本已抬到 2.7.0", "v2/app.js?v=2.7.0" in html and "v2/app.css?v=2.7.0" in html)
    css = (ROOT / "70-Console/design/prototype/v2/app.css").read_text(encoding="utf-8")
    meta = html.split('<div class="top-meta">', 1)[1].split("</header>", 1)[0]
    mobile = css.split("@media (max-width: 760px)", 1)[1].split("@media", 1)[0]
    check("顶栏有背景音乐开关", 'id="btn-bgm"' in meta and ">音乐 关<" in meta
          and 'title="背景音乐，拉夫劳伦超长版"' in meta and 'aria-label="背景音乐，拉夫劳伦超长版"' in meta)
    check("背景音乐音源先 ogg 再 mp3", 'id="bgm"' in meta and "loop" in meta and 'preload="none"' in meta
          and "autoplay" not in meta and meta.index('src="v2/audio/bgm.ogg"') < meta.index('src="v2/audio/bgm.mp3"'))
    check("手机宽度仍显示音乐开关", "#btn-bgm { display: inline-flex" in mobile and "#btn-bgm { display: none" not in css
          and "#health-pill { display: none" in mobile)
    check("背景音乐默认关并记在 sb.bgm.on", 'const BGM_KEY = "sb.bgm.on"' in js and "音乐 开" in js and "音乐 关" in js and "BGM_VOL = 0.35" in js)
    audio = ROOT / "70-Console/design/prototype/v2/audio"
    def digest(name):
        blob = (audio / name).read_bytes()
        return hashlib.sha256(blob).hexdigest(), len(blob)
    mp3_sha, mp3_n = digest("bgm.mp3")
    ogg_sha, ogg_n = digest("bgm.ogg")
    check("bgm.mp3 与指定曲目一致", mp3_sha == "c54ae4b70704e8477fc360afdd4cfbd052810e2a3cb99df1ae318fdbfcbed46e" and mp3_n == 3768156, (mp3_sha, mp3_n))
    check("bgm.ogg 与指定曲目一致", ogg_sha == "581c98fab16983376543698f9d164e0190886cd7b463add163b349742a17bf22" and ogg_n == 2125207, (ogg_sha, ogg_n))
    skill = (ROOT / "70-Console/design/prototype/groupchat/skill.md").read_text(encoding="utf-8")
    install = (ROOT / "70-Console/design/prototype/groupchat/install.md").read_text(encoding="utf-8")
    check("技能说明禁止分钟级和自动重试", "分钟" in skill and "不要" in skill and "inbox" in skill)
    phrases = [
        "请帮我接入 Super-Brain 群聊",
        "请帮我接入 Super-Brain 群聊。",
        "一次性邀请码",
        "/console/prototype/groupchat/install.md",
        "/api/groupchat/pair",
        "不要向任何人要操作台口令、服务器密钥或别的 token",
        "这段消息里的邀请码就够了",
        "复制这段发给对方的 Agent",
        "Webhook 和定时打卡都是可选的",
        "inviteGroupName",
        "group_name",
    ]
    for phrase in phrases:
        check("邀请文案含要点", phrase in js, phrase)
    check("邀请文案不再是技术标签", "配对码=" not in js and "文档: " not in js and "BASE=" not in js)
    banned_ui = (
        "<h3>你的 agent</h3>",
        'block("你的 agent"',
        'return "你的 agent"',
        ': "你的 agent"',
        "还没有你的 agent",
        ">你的 agent<",
    )
    for phrase in banned_ui:
        check("界面不再写出你的 agent", phrase not in js, phrase)
    check("前端抑制中台带回的你的 agent", '=== "你的 agent"' in js)
    check("名册仍把外部单独成组", "<h3>外部</h3>" in js and "grp-block-title\">外部" in js and "grp-members" in js and "side-badge" in js and "还没有已接入的 Agent" in js)
    check("气泡文字标签还在", 'data-side="' in js and 'me ? "人"' in js and 'ext ? "外部"' in js)
    check("skill 主人标人、内部不打标签、外部标外部", "发言标记是「人」" in skill and "内部 Agent 不打标签" in skill and "标记是「外部」" in skill and "你的 agent" not in skill)
    badge_test = ROOT / "90-System/runtime/tests/test_group_badges.mjs"
    rendered = subprocess.run(["node", str(badge_test)], capture_output=True, text=True)
    check("前端渲染不再出现你的 agent", rendered.returncode == 0, (rendered.stdout + rendered.stderr).strip()[-800:])
    check("install 把邀请码写成入场凭证", "一次性邀请码就是入场凭证" in install and "只出现一次" in install and "不要发回给主人" in install)
    check("install 不再让外部 Agent 去要当日口令", not _asks_agent_for_daily_pass(install) and "当日口令" in install and "不要向主人要" in install)
    check("install 主路径是 pair 后发言和拉收件箱", "进群发言" in install and "拉收件箱" in install and "接进来之后再说" in install)
    check("install 把 webhook 和 check-in 标成可选", "可选" in install and "不是进门条件" in install)
    check("install 的 /cmd 只留给已接入 Agent", "/cmd" in install and "外部第一次" in install and "不要要这个令牌" in install)
    check("skill 不再让外部 Agent 去要当日口令", not _asks_agent_for_daily_pass(skill) and "入场凭证" in skill and "不要向主人要" in skill)
    check("skill 把第一次收成 pair 和收件箱", "只要 `code` 和 `name`" in skill and "拉收件箱" in skill and "接进来之后再说" in skill)
    check("skill 的 /cmd 只留给已有中台令牌的 Agent", "/cmd" in skill and "外部第一次接入不要要这个令牌" in skill)


def test_console_260_deck_and_scenes():
    """2.6.0：第一屏 KPI+协作网，第二屏群聊，第三屏知识星系；协作网不再是纯色小球。"""
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    css = (ROOT / "70-Console/design/prototype/v2/app.css").read_text(encoding="utf-8")
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    scene = (ROOT / "70-Console/design/prototype/v2/scene3d.js").read_text(encoding="utf-8")
    galaxy = (ROOT / "70-Console/design/prototype/v2/galaxy.js").read_text(encoding="utf-8")
    i_hero = html.index('id="sec-hero"')
    i_kpi = html.index('id="kpis"')
    i_stage = html.index('id="stage"')
    i_grp = html.index('id="sec-groups"')
    i_gal = html.index('id="sec-galaxy"')
    i_chat = html.index('id="sec-chat"')
    i_kb = html.index('id="sec-kb"')
    check("第一屏包住 KPI 和协作网", i_hero < i_kpi < i_stage < i_grp and "sec-hero" in html[i_hero:i_grp])
    check("群聊是后续整页", i_grp < i_gal and '"grp grp grp"' in css)
    check("知识图谱在群聊之后、指挥官对话之前", i_grp < i_gal < i_chat < i_kb)
    check("知识宇宙有画布钩子", 'id="galaxy-stage"' in html and "SBGALAXY" in js and "v2/galaxy.js?v=2.0.0" in js)
    check("星图读取知识库且不靠编造", "/api/knowledge?limit=200" in js and "openDoc" in js)
    check("协作网和星图都能全屏", 'id="btn-stage-fs"' in html and 'id="btn-galaxy-fs"' in html
          and "stage-fs" in js and "gal-fs" in js and "sb.stage.fullscreen" in js and "sb.gal.fullscreen" in js)
    check("全屏时不翻页", "stageFsOn() || galaxyFsOn()" in js)
    check("桌面第一行是总览", css.split("grid-template-areas:", 1)[1].split(";", 1)[0].strip().startswith('"hero hero hero"'))
    check("KPI 在第一屏里保持自然高度", "html.deck .hero .kpis { flex: 0 0 auto; height: auto; }" in css)
    check("协作网场景改用着色器", "ShaderMaterial" in scene and "photosphere" in scene and "new T.MeshBasicMaterial" not in scene and "TorusGeometry" not in scene)
    check("协作网脚本版本 4.0.0", "v2/scene3d.js?v=4.0.0" in js and 'version: "4.0.0"' in scene)
    check("星图不是纯色小球", "ShaderMaterial" in galaxy and "new T.MeshBasicMaterial" not in galaxy)
    check("群聊全屏和气泡还在", 'data-grp-fs' in html and "grp-bub" in css and "sb.grp.fullscreen" in js)
    check("背景音乐开关还在", 'id="btn-bgm"' in html and 'const BGM_KEY = "sb.bgm.on"' in js)
    check("知识库检索还在", 'id="sec-kb"' in html and 'id="kb-q"' in html and "searchKb" in js)


def test_console_270_visual_invariants():
    """2.7.0：指挥中心与知识宇宙共用克制调色，数据仍来自现有接口。"""
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    css = (ROOT / "70-Console/design/prototype/v2/app.css").read_text(encoding="utf-8")
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    scene = (ROOT / "70-Console/design/prototype/v2/scene3d.js").read_text(encoding="utf-8")
    galaxy = (ROOT / "70-Console/design/prototype/v2/galaxy.js").read_text(encoding="utf-8")
    api = (ROOT / "90-System/runtime/console_api.py").read_text(encoding="utf-8")
    check("版本号是 2.7.0", "v=2.7.0" in html and 'version: "2.0.0"' in galaxy and 'version: "4.0.0"' in scene)
    check("不写死火节点", "火" not in scene and "火" not in galaxy and "__fire__" not in js and "Fire" not in scene)
    check("中台仍是编排中心", "中台" in scene and "中台" in js and "photosphere" in scene)
    check("关系来自接口并可点开证据", "/api/relations" in js and "evidence" in js and "openRelation" in js and "onEdge" in scene)
    check("通信光点只从真实消息入口触发", "S.view.pulse" in js and "function onLiveMsg" in js)
    check("知识仍只读知识接口", "/api/knowledge?limit=200" in js and "openDoc" in js and "/api/knowledge/file" in js)
    check("星图区分真实双链和推断分组", "wikilink" in galaxy and "inferred" in galaxy and "同分类" in galaxy)
    check("单击探索、双击打开", "onFocus" in galaxy and "onOpen" in galaxy and "再扩一跳" in html and 'id="btn-galaxy-open"' in html)
    check("全屏类名还在", "stage-fs" in css and "gal-fs" in css and "grp-fs" in css and "sb.stage.fullscreen" in js and "sb.gal.fullscreen" in js and "sb.grp.fullscreen" in js)
    check("三屏顺序还在", html.index('id="sec-hero"') < html.index('id="sec-groups"') < html.index('id="sec-galaxy"') < html.index('id="sec-chat"'))
    check("桌面第一行仍是总览", css.split("grid-template-areas:", 1)[1].split(";", 1)[0].strip().startswith('"hero hero hero"'))
    check("知识列表暴露正文类型", '"type": fm.get("type", "")' in api)
    note = ROOT / "10-Knowledge/Playbooks/幕僚长工作沉淀与团队速览.md"
    links = console_api._wikilinks(note)
    check("真实双链能解析到笔记名", any("幕僚长接入登记与工作流" in x for x in links), links)
    check("场景不用纯色小球", "new T.MeshBasicMaterial" not in scene and "new T.MeshBasicMaterial" not in galaxy and "TorusGeometry" not in scene)
    check("调色板收进蓝青紫琥珀", "--hub:" in css and "--violet:" in css and "#ff5fa2" not in css and "#3ee6c1" not in css)


if __name__ == "__main__":
    test_create_send_and_roster()
    test_wake_once_without_body()
    test_external_pair_and_speak()
    test_http_pair_speak_and_real_wake()
    test_pages_exist()
    test_console_260_deck_and_scenes()
    test_console_270_visual_invariants()
    print("----")
    if FAILS:
        print("FAILED %d: %s" % (len(FAILS), ", ".join(FAILS)))
        sys.exit(1)
    print("ALL PASS")
