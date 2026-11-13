#!/usr/bin/env python3
# 操作台 v2 第二批：大古身份与配对、写操作鉴权与审计、指挥官对话 /api/chat、commander webhook（异步/重试/幂等）、
# 细分状态（忙碌只认自报/租约）、审批选项与协助、口令包（加密、票据限时限次、值不进审计/消息）、项目完成度。
# 用法：python3 90-System/runtime/tests/test_owner_v2.py
import http.server
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
import urllib.error
import urllib.request
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RT))
TMP = Path(tempfile.mkdtemp(prefix="sb-owner-v2-"))
os.environ["SB_VAULT_DIR"] = str(TMP / "vault")
import commander_hook  # noqa: E402
import console_api  # noqa: E402
import console_v2  # noqa: E402
import current_work  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import projects  # noqa: E402
import vault  # noqa: E402

FAILS = []
OWNER_MASTER = "owner-master-test-token"
CHIEF = "chief-test-token-owner"
# 测试口令只走环境变量，仓库与生产哈希文件都不写真实口令原文
PHRASE_A = "测试口令甲"
PHRASE_B = "测试口令乙"
os.environ["SB_OWNER_UNLOCK_PHRASE"] = PHRASE_A + "|" + PHRASE_B


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))
    if not cond:
        FAILS.append(name)


def fresh():
    d = Path(tempfile.mkdtemp(prefix="db-", dir=TMP))
    conn = sqlite3.connect(str(d / "state.db"))
    migrate_v2.migrate(conn)
    message_bus.ensure_schema(conn)
    owner_ops.ensure_schema(conn)
    conn.execute("INSERT OR REPLACE INTO registry(name,kind,location,agent_ref,status,registered_at) "
                 "VALUES('幕僚长@云端','instance','box','grok-chief','active',?)", (int(time.time()),))
    conn.commit()
    return d, conn


def test_pairing_and_auth():
    d, conn = fresh()
    code, exp = owner_ops.create_pair_code(conn)
    check("配对码 24 小时有效", 86000 < exp - time.time() <= 86400)
    row = conn.execute("SELECT code_hash FROM owner_pair_codes").fetchone()[0]
    check("库里只存配对码哈希", row != code and len(row) == 64)
    r = owner_ops.pair(conn, code, "测试 iPhone")
    check("配对成功拿到设备令牌", r["ok"] and r["token"])
    r2 = owner_ops.pair(conn, code, "第二台")
    check("配对码一次性", not r2["ok"] and "用过" in r2["error"], r2)
    who = owner_ops.authenticate(conn, r["token"], {})
    check("设备令牌可认证为 dagu-owner", who and who["actor"] == "dagu-owner")
    check("Agent 口令不是大古身份", owner_ops.authenticate(conn, CHIEF, {"dagu-owner": OWNER_MASTER}) is None)
    check("主口令可认证", owner_ops.authenticate(conn, OWNER_MASTER, {"dagu-owner": OWNER_MASTER})["actor"] == "dagu-owner")
    owner_ops.execute(conn, who, "logout", {})
    check("退出后令牌失效", owner_ops.authenticate(conn, r["token"], {}) is None)
    c2, _ = owner_ops.create_pair_code(conn, ttl=-1)
    check("过期配对码被拒", "过期" in owner_ops.pair(conn, c2, "x")["error"])


def test_daily_unlock():
    d, conn = fresh()
    owner_ops.reset_unlock_fails()
    r = owner_ops.unlock(conn, "  " + PHRASE_A + "  ", "测试机", ua="UnitTest/1.0")
    check("正确口令（写法一，去空格）通过", r["ok"] and r.get("token") and r.get("expires_at"), r.get("ok"))
    tok = r["token"]
    who = owner_ops.authenticate(conn, tok, {})
    check("当日令牌认证为 dagu-owner", who and who["actor"] == "dagu-owner" and who.get("auth") == "daily")
    r2 = owner_ops.unlock(conn, PHRASE_B, "测试机B")
    check("正确口令（写法二）通过", r2["ok"] and r2.get("token") and r2["token"] != tok)
    bad = owner_ops.unlock(conn, "这不是口令")
    check("错口令拒绝", (not bad["ok"]) and "不对" in (bad.get("error") or ""))
    check("错口令不发令牌", not bad.get("token"))
    # 过期：把会话 expires_at 改到过去
    conn.execute("UPDATE owner_sessions SET expires_at=? WHERE token_hash=?", (int(time.time()) - 10, owner_ops._h(tok)))
    conn.commit()
    check("过期次日失效", owner_ops.authenticate(conn, tok, {}) is None)
    # 哈希文件路径（临时关闭 env，改读文件）
    env = os.environ.pop("SB_OWNER_UNLOCK_PHRASE", None)
    try:
        hf = d / "owner_unlock.hash"
        owner_ops.write_unlock_hashes(hf, ["文件口令A", "文件口令B"])
        os.environ["SB_OWNER_UNLOCK_FILE"] = str(hf)
        check("哈希文件口令通过", owner_ops.phrase_matches("文件口令A") and owner_ops.phrase_matches(" 文件口令B "))
        check("哈希文件错口令拒绝", not owner_ops.phrase_matches("文件口令C"))
        # 文件里不应出现口令原文
        text = hf.read_text(encoding="utf-8")
        check("哈希文件不含口令原文", "文件口令A" not in text and "文件口令B" not in text and "salt=" in text)
        mode = oct(hf.stat().st_mode & 0o777)
        check("哈希文件权限 600", mode == "0o600", mode)
    finally:
        os.environ.pop("SB_OWNER_UNLOCK_FILE", None)
        if env is not None:
            os.environ["SB_OWNER_UNLOCK_PHRASE"] = env
    # 限速：同 IP 连续错 10 次锁定
    owner_ops.reset_unlock_fails()
    now = 1_700_000_000.0
    locked = False
    for i in range(10):
        locked = owner_ops.unlock_note_failure("1.2.3.4", now=now + i)
    check("第 10 次连续错误后锁定", locked and owner_ops.unlock_is_locked("1.2.3.4", now=now + 9))
    check("锁定 5 分钟内仍锁", owner_ops.unlock_is_locked("1.2.3.4", now=now + 9 + 299))
    check("5 分钟后解锁", not owner_ops.unlock_is_locked("1.2.3.4", now=now + 9 + 300))
    owner_ops.reset_unlock_fails()
    for _ in range(3):
        owner_ops.unlock_note_failure("5.6.7.8", now=now)
    owner_ops.unlock_note_success("5.6.7.8")
    check("成功后清零连续失败", not owner_ops.unlock_is_locked("5.6.7.8", now=now))
    # 有效期落在北京时间次日 0 点
    exp = owner_ops.beijing_day_end(now)
    from datetime import datetime
    dt = datetime.fromtimestamp(exp, owner_ops.BEIJING)
    check("过期时间是北京时间次日 00:00:00", dt.hour == 0 and dt.minute == 0 and dt.second == 0 and dt.tzinfo is not None)
    # 写操作走当日令牌
    d2, conn2 = fresh()
    sess = owner_ops.unlock(conn2, PHRASE_A, "测")
    who = owner_ops.authenticate(conn2, sess["token"], {})
    res = owner_ops.execute(conn2, who, "msg", {"to": "幕僚长@云端", "text": "令牌自测"})
    check("写操作带当日令牌成功", res.get("ok"), res)
    logout = owner_ops.execute(conn2, who, "logout", {})
    check("退出后当日令牌失效", logout.get("ok") and owner_ops.authenticate(conn2, sess["token"], {}) is None)


def test_work_state():
    d, conn = fresh()
    now = int(time.time())
    conn.execute("INSERT INTO heartbeats(agent,ts,note) VALUES('幕僚长@云端',?,'sse') "
                 "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts", (now - 5,))
    conn.commit()
    console_v2.clear_cache()
    ag = {a["agent_id"]: a for a in console_v2.dashboard(conn, now)["agents"]}
    check("只有心跳 → 空闲，不是忙碌", ag["grok-chief"]["state"]["state"] == "idle", ag["grok-chief"]["state"])
    current_work.set_work(conn, "grok-chief", {"title": "整理 XAUUSD 日报"})
    console_v2.clear_cache()
    ag = {a["agent_id"]: a for a in console_v2.dashboard(conn, now)["agents"]}
    st = ag["grok-chief"]["state"]
    check("自报工作 → 忙碌 + 在做什么", st["state"] == "busy" and st["work"] == "整理 XAUUSD 日报"
          and st["work_source"] == "self_report", st)
    current_work.clear(conn, "grok-chief")
    console_v2.clear_cache()
    ag = {a["agent_id"]: a for a in console_v2.dashboard(conn, now)["agents"]}
    check("清除后回到空闲", ag["grok-chief"]["state"]["state"] == "idle")
    check("离线带最近在场时间", all(a["state"].get("since") is not None or not a["ever_connected"]
                                for a in ag.values() if a["state"]["state"] == "offline"))


def test_approvals():
    d, conn = fresh()
    who = {"actor": "dagu-owner", "device": "t"}
    r = owner_ops.request_approval(conn, "grok-chief", {"title": "改期？", "options": ["同意", "改到周五", "驳回"]})
    check("提交带选项的审批", r["ok"], r)
    aid = r["approval_id"]
    res = owner_ops.execute(conn, who, "approval_decide", {"id": aid, "decision": "option", "option": "改到周五"})
    a = owner_ops._approval(conn, aid)
    check("按选项裁决并推回", res["ok"] and res["msg_id"] and "改到周五" in (a["decision_note"] or ""), res)
    m = conn.execute("SELECT text,\"to\",from_agent FROM messages WHERE msg_id=?", (res["msg_id"],)).fetchone()
    check("结果经总线推给申请方", m and m[2] == "dagu-owner" and "改到周五" in m[0], m)
    bad = owner_ops.execute(conn, who, "approval_decide", {"id": aid, "decision": "approve"})
    check("不能重复裁决", not bad["ok"])
    r = owner_ops.request_approval(conn, "grok-chief", {"title": "要个网址", "kind": "assist", "assist_kind": "url"})
    no = owner_ops.execute(conn, who, "approval_decide", {"id": r["approval_id"], "decision": "approve", "reply": "不是网址"})
    check("协助-网址校验", not no["ok"])
    ok = owner_ops.execute(conn, who, "approval_decide", {"id": r["approval_id"], "decision": "approve", "reply": "https://example.com/x"})
    check("协助-网址回复", ok["ok"])
    r = owner_ops.request_approval(conn, "grok-chief", {"title": "自定义"})
    ok = owner_ops.execute(conn, who, "approval_decide", {"id": r["approval_id"], "decision": "custom", "note": "先等我电话"})
    check("自定义答复 → 已批示", ok["ok"] and owner_ops._approval(conn, r["approval_id"])["status"] == "answered", ok)
    console_v2.clear_cache()
    r = owner_ops.request_approval(conn, "grok-chief", {"title": "待办"})
    ag = {a["agent_id"]: a for a in console_v2.dashboard(conn)["agents"]}
    check("Agent 红点数 = 待审批数", ag["grok-chief"]["pending_approvals"] == 1, ag["grok-chief"]["pending_approvals"])


def test_vault():
    d, conn = fresh()
    who = {"actor": "dagu-owner", "device": "t"}
    secret = "S3cr3t-Value-不应出现"
    r = owner_ops.execute(conn, who, "vault_put", {"name": "github-pat", "purpose": "推代码", "value": secret})
    check("存入口令", r["ok"], r)
    raw = (TMP / "vault" / "items.json").read_text()
    check("磁盘上是密文", secret not in raw and "github-pat" in raw)
    check("主密钥文件 600", oct((TMP / "vault" / "master.key").stat().st_mode & 0o777) == "0o600")
    check("清单不含值", secret not in json.dumps(vault.list_items(), ensure_ascii=False))
    ap = owner_ops.request_approval(conn, "grok-chief", {"title": "用 PAT", "kind": "assist", "assist_kind": "vault"})
    res = owner_ops.execute(conn, who, "approval_decide", {"id": ap["approval_id"], "decision": "approve", "vault_item": "github-pat", "uses": 1})
    check("批准后签发票据", res["ok"] and res.get("ticket_id"), res)
    msgs = json.dumps(conn.execute("SELECT text FROM messages").fetchall(), ensure_ascii=False)
    check("消息里没有口令值", secret not in msgs and "vault_redeem" in msgs)
    detail = json.dumps(owner_ops.audit_detail("vault_put", {"name": "x", "value": secret}, r), ensure_ascii=False)
    check("审计隐去口令值", secret not in detail)
    other = vault.redeem(conn, "dsh-chief", res["ticket_id"])
    check("别的 Agent 不能用这张票", not other["ok"])
    got = vault.redeem(conn, "grok-chief", res["ticket_id"])
    check("申请方凭票取到值", got["ok"] and got["value"] == secret)
    again = vault.redeem(conn, "grok-chief", res["ticket_id"])
    check("票据限次（用完即止）", not again["ok"])
    t2 = vault.issue_ticket(conn, "github-pat", "grok-chief", ttl=60, uses=3)
    conn.execute("UPDATE vault_tickets SET expires_at=? WHERE id=?", (int(time.time()) - 1, t2["ticket_id"]))
    conn.commit()
    check("票据限时（过期拒绝）", not vault.redeem(conn, "grok-chief", t2["ticket_id"])["ok"])
    owner_ops.execute(conn, who, "vault_disable", {"name": "github-pat"})
    check("停用后不能再签票", not vault.issue_ticket(conn, "github-pat", "grok-chief")["ok"])
    aud = json.dumps(vault.recent_audit(conn), ensure_ascii=False)
    check("口令包审计有取用记录且无值", "redeem" in aud and secret not in aud)


def test_projects():
    d, conn = fresh()
    pl = {p["id"]: p for p in projects.list_projects(conn)}
    sb = pl["super-brain-net"]
    check("种子项目存在", "super-brain-net" in pl and "xauusd-desk" in pl)
    check("完成度按已核实验收计算", sb["completion"] == round(sb["accepted_verified"] * 100 / sb["phase_total"]), sb["completion"])
    xa = pl["xauusd-desk"]
    check("未核实不计入完成度", xa["completion"] == 0 and xa["accepted_unverified"] == 2, (xa["completion"], xa["accepted_unverified"]))
    check("其他 Agent 不能改项目", not projects.owner_write(conn, "dsh-chief", "phase_accept", {"project_id": "xauusd-desk", "seq": 1, "evidence": "xxxx"})["ok"])
    check("验收必须附证据", not projects.owner_write(conn, "dagu-owner", "phase_accept", {"project_id": "xauusd-desk", "seq": 1, "evidence": ""})["ok"])
    r = projects.owner_write(conn, "grok-chief", "phase_accept", {"project_id": "xauusd-desk", "seq": 1, "evidence": "规矩文档 KB 路径 + 大古批复消息号"})
    xa = {p["id"]: p for p in projects.list_projects(conn)}["xauusd-desk"]
    check("指挥官验收后转为已核实并计入", r["ok"] and xa["accepted_verified"] == 1 and xa["completion"] == 33, xa["completion"])
    r = projects.owner_write(conn, "dagu-owner", "project_upsert", {"id": "new-proj", "name": "新项目", "agents": ["grok-chief"]})
    r2 = projects.owner_write(conn, "dagu-owner", "phase_upsert", {"project_id": "new-proj", "seq": 1, "name": "一期", "status": "blocked", "blocker": "等授权"})
    np_ = {p["id"]: p for p in projects.list_projects(conn)}["new-proj"]
    check("新建项目与阶段、阻塞可见", r["ok"] and r2["ok"] and np_["blocked"] and np_["completion"] == 0)
    ap = owner_ops.request_approval(conn, "grok-chief", {"title": "项目审批", "project_id": "new-proj"})
    np_ = {p["id"]: p for p in projects.list_projects(conn)}["new-proj"]
    check("审批可挂项目，项目红点计数", ap["ok"] and np_["pending_approvals"] == 1)


class _Hook(http.server.BaseHTTPRequestHandler):
    got = []
    fail_first = [1]

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if _Hook.fail_first[0]:
            _Hook.fail_first[0] -= 1
            self.send_response(503)
            self.end_headers()
            return
        _Hook.got.append((dict(self.headers), json.loads(body)))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


def test_commander_hook():
    d, conn = fresh()
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Hook)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = TMP / "commander_webhook.env"
    commander_hook.ENV_PATH = env
    # 未配置：只记日志不报错
    commander_hook._STATE.update({"loaded": False})
    r = message_bus.post_message(conn, "dagu-owner", "未配置时也能发", to="grok-chief")
    check("webhook 未配置时消息照常入总线", r["ok"])
    env.write_text("COMMANDER_WEBHOOK_URL=http://127.0.0.1:%d/hook\nCOMMANDER_WEBHOOK_KEY=k-123\nCOMMANDER_WEBHOOK_AUTH=header:X-Commander-Key\n" % srv.server_port)
    os.chmod(env, 0o644)
    commander_hook._STATE.update({"loaded": False})
    check("配置文件权限过宽被拒", not commander_hook.load_config(force=True))
    os.chmod(env, 0o600)
    check("配置 600 可加载", commander_hook.load_config(force=True))
    r = message_bus.post_message(conn, "dagu-owner", "帮我看下今天的研判", to="grok-chief")
    check("大古→幕僚长 入 outbox", conn.execute("SELECT COUNT(*) FROM webhook_outbox WHERE msg_id=?", (r["msg_id"],)).fetchone()[0] == 1)
    commander_hook.enqueue(conn, r)
    check("同 msg_id 幂等不重复入队", conn.execute("SELECT COUNT(*) FROM webhook_outbox").fetchone()[0] == 1)
    db = str(d / "state.db")
    conn.commit()
    for _ in range(4):
        commander_hook.pump(lambda: sqlite3.connect(db), once=True)
        conn.execute("UPDATE webhook_outbox SET next_at=0 WHERE sent_at IS NULL")
        conn.commit()
        if _Hook.got:
            break
    check("失败后重试并送达", len(_Hook.got) == 1, len(_Hook.got))
    if _Hook.got:
        h, body = _Hook.got[0]
        check("密钥头可配置（X-Commander-Key）", h.get("X-Commander-Key") == "k-123")
        check("payload 带 msg_id 作幂等键", body["msg_id"] == r["msg_id"] and body["idempotency_key"] == r["msg_id"])
    m2 = message_bus.post_message(conn, "dsh-chief", "普通消息", to="grok-chief")
    check("非大古消息不转发", conn.execute("SELECT COUNT(*) FROM webhook_outbox WHERE msg_id=?", (m2["msg_id"],)).fetchone()[0] == 0)
    chat = console_v2.chat_thread(conn)
    owners = [m for m in chat["messages"] if m["from_agent"] == "dagu-owner"]
    quicks = [m for m in chat["messages"] if m["from_agent"] == "local-quick"]
    check("/api/chat 只有大古和快速回复，不含其他发件人",
          {m["from_agent"] for m in chat["messages"]} <= {"dagu-owner", "local-quick"} and len(owners) == 2,
          {m["from_agent"] for m in chat["messages"]})
    check("/api/chat 每条大古消息都有快速回复且不冒充幕僚长",
          len(quicks) == 2 and all(q["from_agent"] != "grok-chief" and "快速回复（本地小模型）" in (q.get("text") or "") for q in quicks),
          len(quicks))
    check("/api/chat 带投递状态", any((m.get("hook") or {}).get("sent_at") for m in chat["messages"]))
    srv.shutdown()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _req(port, path, method="GET", data=None, headers=None, with_headers=False):
    req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            body = json.loads(r.read() or b"{}")
            return (r.status, body, dict(r.headers)) if with_headers else (r.status, body)
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"{}")
        except Exception:
            body = {}
        return (e.code, body, dict(e.headers)) if with_headers else (e.code, body)


def test_http():
    d, conn = fresh()
    code, _ = owner_ops.create_pair_code(conn)
    conn.close()
    tok = d / "tokens.json"
    tok.write_text(json.dumps({"tokens": {"grok-chief": CHIEF}, "viewers": {}, "owner": {"dagu-owner": OWNER_MASTER}}))
    port = _free_port()
    proc = subprocess.Popen([sys.executable, str(RT / "tests" / "fixture_server.py"), str(d / "state.db"), str(tok), str(port)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=dict(os.environ))
    try:
        proc.stdout.readline()
        for _ in range(80):
            try:
                urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=1).read()
                break
            except Exception:
                time.sleep(0.1)
        J = {"Content-Type": "application/json"}
        for path in ("/api/chat", "/api/projects", "/api/approvals", "/api/audit"):
            c, b = _req(port, path)
            check("GET %s 匿名 401" % path, c == 401 and b.get("need_auth") and "data" not in b, c)
        c, b = _req(port, "/api/owner/act", "POST", json.dumps({"action": "msg", "args": {"to": "grok-chief", "text": "x"}}).encode(), J)
        check("写操作无令牌 401", c == 401 and b.get("need_unlock"), c)
        c, b = _req(port, "/api/owner/act", "POST", json.dumps({"action": "msg", "args": {"to": "grok-chief", "text": "x"}}).encode(),
                    dict(J, Authorization="Bearer " + CHIEF))
        check("Agent 口令不能做大古写操作", c == 401, c)
        owner_ops.reset_unlock_fails()
        c, b, h = _req(port, "/api/owner/unlock", "POST",
                       json.dumps({"phrase": "  " + PHRASE_A + "  ", "device_name": "HTTP机"}).encode(),
                       dict(J, **{"User-Agent": "OwnerUnlockTest/1.0"}), with_headers=True)
        check("HTTP 正确口令一解锁 200", c == 200 and b.get("ok") and b.get("token") and b.get("expires_at"), c)
        daily = b.get("token")
        raw_c = ""
        for k, v in h.items():
            if k.lower() == "set-cookie" and "sb_owner=" in v:
                raw_c = v
                break
        check("解锁响应 Set-Cookie", "sb_owner=" in raw_c, "present" if raw_c else "missing")
        A_DAILY = dict(J, Authorization="Bearer " + daily)
        c, b = _req(port, "/api/owner/act", "POST",
                    json.dumps({"action": "msg", "args": {"to": "grok-chief", "text": "口令改造自测，可忽略"}}).encode(), A_DAILY)
        check("写操作带当日令牌成功", c == 200 and b.get("ok"), c)
        # cookie 亦可认证（无 Bearer）
        cookie = ""
        for part in raw_c.split(";"):
            if part.strip().startswith("sb_owner="):
                cookie = part.strip()
                break
        if cookie:
            c, b = _req(port, "/api/owner/act", "POST",
                        json.dumps({"action": "whoami"}).encode(), dict(J, Cookie=cookie))
            check("Cookie 会话可认证", c == 200 and b.get("ok") and b.get("actor") == "dagu-owner", c)
        c, b = _req(port, "/api/owner/unlock", "POST", json.dumps({"phrase": PHRASE_B, "device_name": "HTTP机2"}).encode(), J)
        check("HTTP 正确口令二解锁 200", c == 200 and b.get("ok") and b.get("token"), c)
        c, b = _req(port, "/api/owner/unlock", "POST", json.dumps({"phrase": "错的口令"}).encode(), J)
        check("HTTP 错口令 401", c == 401 and not b.get("token"), c)
        # 审计不含口令原文
        c, b = _req(port, "/api/audit", headers=dict(J, Authorization="Bearer " + daily))
        aud = json.dumps(b, ensure_ascii=False)
        check("审计含 unlock 且不含口令原文", "unlock" in aud and PHRASE_A not in aud and PHRASE_B not in aud and daily not in aud)
        c, b, h = _req(port, "/api/owner/pair", "POST",
                       json.dumps({"code": "  " + PHRASE_A + "  ", "device_name": "旧配对框"}).encode(), J, with_headers=True)
        check("旧配对框输入当日口令也可解锁", c == 200 and b.get("ok") and b.get("token") and b.get("expires_at"), c)
        pair_tok = b.get("token")
        c, b = _req(port, "/api/owner/act", "POST",
                    json.dumps({"action": "msg", "args": {"to": "grok-chief", "text": "旧框口令自测，可忽略"}}).encode(),
                    dict(J, Authorization="Bearer " + pair_tok))
        check("旧框解锁令牌可发消息", c == 200 and b.get("ok"), c)
        c, b = _req(port, "/api/owner/pair", "POST", json.dumps({"code": "错的口令", "device_name": "旧配对框"}).encode(), J)
        check("旧配对框错口令仍拒绝", c in (400, 401) and not b.get("token"), c)
        # 先成功一次，清掉服务端子进程里的失败计数，再连续错 10 次
        c, _b = _req(port, "/api/owner/unlock", "POST", json.dumps({"phrase": PHRASE_A, "device_name": "限速前清零"}).encode(), J)
        check("限速测试前成功解锁", c == 200, c)
        last = 0
        for i in range(10):
            last, _b = _req(port, "/api/owner/unlock", "POST", json.dumps({"phrase": "错" + str(i)}).encode(), J)
        check("HTTP 连续错 10 次后 429", last == 429, last)
        last, _b = _req(port, "/api/owner/unlock", "POST", json.dumps({"phrase": PHRASE_A}).encode(), J)
        check("锁定期间对的口令也 429", last == 429, last)
        c, b = _req(port, "/api/owner/pair", "POST", json.dumps({"code": code, "device_name": "测试机"}).encode(), J)
        check("HTTP 配对成功", c == 200 and b.get("token"), c)
        dev = b.get("token")
        A = dict(J, Authorization="Bearer " + dev)
        c, b = _req(port, "/api/owner/act", "POST", json.dumps({"action": "msg", "args": {"to": "grok-chief", "text": "从手机发"}}).encode(), A)
        check("配对设备可发消息给幕僚长", c == 200 and b.get("ok"), b)
        c, b = _req(port, "/api/chat", headers=A)
        check("对话线程出现这条", any(m["text"] == "从手机发" for m in b["data"]["messages"]))
        c, b = _req(port, "/api/owner/act", "POST", json.dumps({"action": "vault_put", "args": {"name": "k1", "purpose": "测", "value": "VAL-xyz-123"}}).encode(), A)
        check("HTTP 存口令", c == 200 and b.get("ok") and "VAL-xyz-123" not in json.dumps(b), b)
        c, b = _req(port, "/api/audit", headers=A)
        aud = json.dumps(b, ensure_ascii=False)
        check("审计有记录且不含口令值/令牌", "vault_put" in aud and "VAL-xyz-123" not in aud and dev not in aud)
        c, b = _req(port, "/api/owner/act", "POST", json.dumps({"action": "phase_accept", "args": {"project_id": "xauusd-desk", "seq": 2, "evidence": "定时任务列表截图路径"}}).encode(), A)
        check("大古可验收项目阶段", c == 200 and b.get("ok"), b)
        bad = 0
        for _ in range(22):
            c, _b = _req(port, "/api/owner/act", "POST", b'{"action":"whoami"}', dict(J, Authorization="Bearer wrong"))
            bad = c
        check("连续失败限流 429", bad == 429, bad)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    try:
        test_pairing_and_auth()
        test_daily_unlock()
        test_work_state()
        test_approvals()
        test_vault()
        test_projects()
        test_commander_hook()
        test_http()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print("\n== %s 项失败 ==" % len(FAILS) if FAILS else "\n== 全部通过 ==")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
