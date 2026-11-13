#!/usr/bin/env python3
# P0-1：匿名读 401、主人会话通过、令牌通过、healthz 仍公开、回滚开关生效。
# 不读取生产 api_tokens.json，不打印令牌。
import hashlib
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
sys.path.insert(0, str(RT))
os.environ.pop("SB_ALLOW_ANON_READ", None)
os.environ["SB_OWNER_UNLOCK_PHRASE"] = "读接口测试口令"
os.environ["SB_VOICE_SECRET_DIR"] = str(Path(tempfile.mkdtemp(prefix="sb-read-auth-voice-")) / "secrets")
os.environ["SB_VOICE_STATE_FILE"] = str(Path(tempfile.mkdtemp(prefix="sb-read-auth-voice-")) / "voice.json")

import api_server  # noqa: E402
import group_chat  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import read_auth  # noqa: E402

FAILS = []
CHIEF = "chief-read-auth-token"
VIEWER = "viewer-read-auth-token"
NARROW = "narrow-read-auth-token"
MARKER = "LEAK-MARKER-p0-1"
AUDIT_BODY = "AUDIT-BODY-SHOULD-STAY-OUT"
PHRASE = os.environ["SB_OWNER_UNLOCK_PHRASE"]


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:180]) if (detail and not cond) else ""))
    if not cond:
        FAILS.append(name)


def test_helpers():
    check("哈希比对认得出同一令牌", read_auth.hashes_equal("abc", "abc"))
    check("哈希比对拒绝不同令牌", not read_auth.hashes_equal("abc", "abcd"))
    check("空令牌不相等", not read_auth.hashes_equal("", "abc"))
    check("默认关闭匿名读", read_auth.anon_enabled() is False)
    os.environ["SB_ALLOW_ANON_READ"] = "1"
    check("1 打开回滚", read_auth.anon_enabled() is True)
    os.environ["SB_ALLOW_ANON_READ"] = "off"
    check("off 仍关闭", read_auth.anon_enabled() is False)
    os.environ.pop("SB_ALLOW_ANON_READ", None)
    principal = {"scopes": ("groupchat",)}
    check("群令牌不能读消息总线", not read_auth.allows(principal, "/api/messages", "read"))
    check("群令牌可以读群名册", read_auth.allows(principal, "/api/groupchat/roster", "read"))
    check("只写 scope 不能读", not read_auth.allows({"scopes": ("write",)}, "/api/tasks", "read"))
    check("read scope 可以看流", read_auth.allows({"scopes": ("read",)}, "/api/stream", "stream"))


class Handler(urllib.request.BaseHandler):
    pass


def call(port, path, method="GET", body=None, headers=None):
    data = None if body is None else body
    req = urllib.request.Request(
        "http://127.0.0.1:%s%s" % (port, path), data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            raw = res.read()
            hdrs = dict(res.headers)
            code = res.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        hdrs = dict(e.headers)
        code = e.code
    obj = None
    ctype = (hdrs.get("Content-Type") or "")
    if "json" in ctype or (raw[:1] in (b"{", b"[")):
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            obj = None
    return code, raw, obj, hdrs


def read_sse(port, query, headers=None, seconds=2.2):
    sock = socket.create_connection(("127.0.0.1", port), 5)
    sock.settimeout(0.4)
    extra = ""
    if headers:
        extra = "".join("%s: %s\r\n" % (k, v) for k, v in headers.items())
    sock.sendall((
        "GET /api/stream?%s HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n"
        "Connection: close\r\n%s\r\n" % (query, extra)).encode())
    buf, end = b"", time.time() + seconds
    while time.time() < end:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            if b"401" in buf[:80] or b"403" in buf[:80]:
                break
            continue
        if not chunk:
            break
        buf += chunk
    sock.close()
    return buf


def cookie_from(hdrs):
    raw = ""
    for key, value in hdrs.items():
        if key.lower() == "set-cookie" and "sb_owner=" in value:
            raw = value
    for part in raw.split(";"):
        part = part.strip()
        if part.startswith("sb_owner=") and len(part) > len("sb_owner="):
            return part
    return ""


def test_http():
    d = Path(tempfile.mkdtemp(prefix="sb-read-auth-"))
    db_path = str(d / "state.db")
    conn = sqlite3.connect(db_path)
    migrate_v2.migrate(conn)
    message_bus.ensure_schema(conn)
    owner_ops.ensure_schema(conn)
    group_chat.ensure_schema(conn)
    now = int(time.time())
    conn.execute(
        'INSERT INTO messages(msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at) '
        "VALUES(?,?,?,?,?,?,?,?,?)",
        ("m-leak", "grok-chief", "", "dagu-owner", "chat", MARKER, None, "t-leak", now))
    conn.execute(
        "INSERT OR REPLACE INTO registry(name,kind,location,agent_ref,status,registered_at) "
        "VALUES('幕僚长@云端','instance','box','grok-chief','active',?)", (now,))
    code, _exp = owner_ops.create_pair_code(conn)
    paired = owner_ops.pair(conn, code, "读接口设备")
    device = paired["token"]
    ext = "ext-read-auth-token"
    conn.execute(
        "INSERT INTO external_agents(ext_id,name,token_hash,checkin_seconds,created_at) "
        "VALUES(?,?,?,?,?)",
        ("ext_read", "外部", hashlib.sha256(ext.encode("utf-8")).hexdigest(), 21600, now))
    conn.commit()
    conn.close()

    logs = []

    def db_fn():
        c = sqlite3.connect(db_path, timeout=10)
        c.execute("PRAGMA busy_timeout=5000")
        return c

    def execute_fn(conn, chief, cmd, args):
        return {"ok": True, "cmd": cmd}

    def log_event(kind, **fields):
        logs.append((kind, json.dumps(fields, ensure_ascii=False)))

    tokens = {"grok-chief": CHIEF, "narrow": NARROW}
    scopes = {"narrow": ["write"]}
    handler = api_server._make_handler(
        db_fn, execute_fn, log_event, tokens, {"console": VIEWER}, threading.Event(),
        {}, None, scopes)
    httpd = api_server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    secrets = (CHIEF, VIEWER, NARROW, device, ext, PHRASE)
    try:
        paths = (
            "/api/overview", "/api/agents", "/api/tasks", "/api/events", "/api/monitor",
            "/api/knowledge", "/api/memory", "/api/messages", "/api/dashboard", "/api/server",
            "/api/relations", "/api/projects", "/api/approvals", "/api/audit", "/api/chat",
            "/api/groupchat/roster", "/api/groupchat/groups", "/api/voice/status",
            "/api/rollcall/missing", "/api/review/annual",
            "/api/knowledge/file?path=10-Knowledge/x.md", "/api/round/nope", "/api/tasks/1",
        )
        for path in paths:
            code, raw, obj, _ = call(port, path)
            blob = raw.decode("utf-8", "replace")
            check("匿名 %s 401" % path.split("?")[0], code == 401 and obj and obj.get("need_auth")
                  and "data" not in obj and MARKER not in blob, code)

        code, raw, obj, _ = call(port, "/healthz")
        check("healthz 仍公开", code == 200 and obj and obj.get("ok") and obj.get("service") == "super-brain-api")
        code, raw, obj, _ = call(port, "/healthz", headers={"Authorization": "Bearer nope"})
        check("healthz 带错令牌仍公开", code == 200 and obj and obj.get("ok"))
        code, raw, _, _ = call(port, "/console/prototype/index.html")
        check("静态页仍公开", code == 200 and b"v2/app.js?v=2.8.2" in raw, code)

        code, raw, obj, _ = call(port, "/api/messages", headers={"Authorization": "Bearer nope"})
        check("错令牌 401", code == 401 and MARKER.encode() not in raw)

        code, raw, obj, _ = call(port, "/api/messages", headers={"Authorization": "Bearer " + CHIEF})
        texts = [m.get("text") for m in (obj or {}).get("data") or []]
        check("令牌可读消息且字段仍在", code == 200 and obj.get("ok") and "ts" in obj and "total" in obj
              and MARKER in texts, code)
        code, _, obj, _ = call(port, "/api/tasks", headers={"Authorization": "Bearer " + CHIEF})
        check("任务列表字段兼容", code == 200 and obj.get("ok") and obj.get("excluded_dead") is True
              and "data" in obj and "total" in obj)

        code, _, obj, _ = call(port, "/api/overview", headers={"Authorization": "Bearer " + VIEWER})
        check("viewer 可读", code == 200 and obj.get("ok"))
        code, _, obj, _ = call(port, "/cmd", "POST",
                              json.dumps({"cmd": "status", "args": {}}).encode(),
                              {"Authorization": "Bearer " + VIEWER, "Content-Type": "application/json"})
        check("viewer 不能写 /cmd", code == 401)

        code, raw, obj, _ = call(port, "/api/messages", headers={"Authorization": "Bearer " + NARROW})
        check("只写 scope 读接口 403", code == 403 and obj.get("error") == "权限不足" and MARKER.encode() not in raw)
        code, _, obj, _ = call(port, "/cmd", "POST",
                              json.dumps({"cmd": "status", "args": {"text": AUDIT_BODY}}).encode(),
                              {"Authorization": "Bearer " + NARROW, "Content-Type": "application/json"})
        check("只写 scope 仍可写 /cmd", code == 200 and obj.get("ok"))

        code, raw, obj, _ = call(port, "/api/messages", headers={"Cookie": "sb_owner=" + device})
        texts = [m.get("text") for m in (obj or {}).get("data") or []]
        check("已有设备会话免再输口令即可看", code == 200 and MARKER in texts and PHRASE.encode() not in raw, code)

        code, _, obj, hdrs = call(
            port, "/api/owner/unlock", "POST",
            json.dumps({"phrase": PHRASE, "device_name": "读接口会话"}).encode(),
            {"Content-Type": "application/json"})
        cookie = cookie_from(hdrs)
        check("解锁签发会话 cookie", code == 200 and obj.get("ok") and cookie.startswith("sb_owner="))
        code, _, obj, _ = call(port, "/api/dashboard", headers={"Cookie": cookie})
        check("只有 cookie 没有 Bearer 也能看操作台", code == 200 and obj.get("ok") and "data" in obj, code)
        streamed = read_sse(port, "observe=1&since=%d" % (now - 5), {"Cookie": cookie})
        check("cookie 可以订阅观察流", b"200" in streamed.split(b"\r\n", 1)[0] and MARKER.encode() in streamed,
              streamed[:120])
        anon_stream = read_sse(port, "observe=1&since=%d" % (now - 5), seconds=1.0)
        check("匿名观察流 401", b"401" in anon_stream[:80] and MARKER.encode() not in anon_stream, anon_stream[:80])

        code, _, obj, _ = call(port, "/api/groupchat/roster", headers={"Authorization": "Bearer " + ext})
        check("配对令牌仍可读群名册", code == 200 and obj.get("ok"), code)
        code, raw, obj, _ = call(port, "/api/messages", headers={"Authorization": "Bearer " + ext})
        check("配对令牌不能读消息总线", code == 403 and MARKER.encode() not in raw, code)
        code, _, obj, _ = call(port, "/api/groupchat/inbox", headers={"Authorization": "Bearer " + ext})
        check("配对令牌仍可拉收件箱", code == 200 and obj.get("ok"), code)

        code, _, obj, _ = call(port, "/cmd", "POST",
                              json.dumps({"cmd": "status", "args": {"text": AUDIT_BODY}}).encode(),
                              {"Authorization": "Bearer " + CHIEF, "Content-Type": "application/json"})
        check("chief 写操作仍成功", code == 200 and obj.get("ok") and AUDIT_BODY not in json.dumps(obj))
        audit_conn = sqlite3.connect(db_path)
        rows = audit_conn.execute("SELECT action,target,detail FROM owner_audit").fetchall()
        audit_conn.close()
        blob = json.dumps(rows, ensure_ascii=False)
        check("写操作记了审计", any(r[0] == "cmd" for r in rows))
        check("审计不含令牌和请求正文", all(s not in blob for s in secrets + (AUDIT_BODY,)))
        check("拒绝匿名读也有审计", any(r[0] == "read_denied" for r in rows))

        os.environ["SB_ALLOW_ANON_READ"] = "1"
        code, raw, obj, _ = call(port, "/api/messages")
        texts = [m.get("text") for m in (obj or {}).get("data") or []]
        check("回滚开关打开后匿名可读", code == 200 and MARKER in texts, code)
        os.environ["SB_ALLOW_ANON_READ"] = "0"
        code, raw, obj, _ = call(port, "/api/messages")
        check("回滚开关关闭后再次 401", code == 401 and MARKER.encode() not in raw and "data" not in (obj or {}))
        os.environ.pop("SB_ALLOW_ANON_READ", None)

        logged = "\n".join(item[1] for item in logs)
        check("运行日志不含测试凭证", all(s not in logged for s in secrets))
    finally:
        os.environ.pop("SB_ALLOW_ANON_READ", None)
        httpd.shutdown()


def test_frontend_and_doc():
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    ops = (ROOT / "70-Console/design/prototype/ops.js").read_text(encoding="utf-8")
    doc = (ROOT / "40-Agents/读接口鉴权-迁移说明.md").read_text(encoding="utf-8")
    check("静态版本是 2.8.2", "v2/app.js?v=2.8.2" in html and "v2/app.css?v=2.8.2" in html and "v=3.0" not in html)
    check("读请求带会话", 'credentials: "same-origin"' in js and "withCredentials: true" in js)
    check("401 可见且不冒充没有风险", "这不是「没有风险」" in js and "need_auth" not in js or "未授权" in js)
    check("前端不把令牌放进 SSE 查询", "token=" not in js and "?token" not in js)
    check("旧操作台也带会话", 'credentials: "same-origin"' in ops and "withCredentials: true" in ops
          and "不是因为没有风险" in ops)
    check("迁移说明给外部 Agent", "SB_ALLOW_ANON_READ" in doc and "401" in doc and "元Ai" in doc
          and "圆AI" not in doc and "不要向主人索取当日口令" in doc)
    check("页面仍禁止缓存 HTML", 'Cache-Control" content="no-store' in html)


def main():
    test_helpers()
    test_frontend_and_doc()
    test_http()
    print("\n== %s 项失败 ==" % len(FAILS) if FAILS else "\n== 全部通过 ==")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
