#!/usr/bin/env python3
# 快速回复：规则秒回、动作类只转幕僚长、本地模型失败退回规则、webhook 不被拖住。
# 用法：python3 90-System/runtime/tests/test_quick_reply.py
import http.server
import json
import os
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
ROOT = RT.parents[1]
sys.path.insert(0, str(RT))
TMP = Path(tempfile.mkdtemp(prefix="sb-quick-"))
os.environ["SB_VAULT_DIR"] = str(TMP / "vault")
os.environ.setdefault("SB_OWNER_UNLOCK_PHRASE", "测试口令甲")
import commander_hook  # noqa: E402
import console_v2  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import quick_reply  # noqa: E402

FAILS = []
PHRASE = "测试口令甲"
LAT = {}


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


def _env_saved(*keys):
    return {k: os.environ.get(k) for k in keys}


def _env_restore(saved):
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_rules_and_guard():
    saved = _env_saved("SB_QUICK_REPLY", "SB_QUICK_REPLY_URL", "SB_QUICK_REPLY_ENGINE", "SB_QUICK_REPLY_TIMEOUT")
    os.environ["SB_QUICK_REPLY"] = "1"
    os.environ.pop("SB_QUICK_REPLY_URL", None)
    os.environ["SB_QUICK_REPLY_ENGINE"] = "auto"
    samples = []
    try:
        for _ in range(20):
            t0 = time.perf_counter()
            body, engine = quick_reply.compose("在吗")
            samples.append((time.perf_counter() - t0) * 1000)
        samples.sort()
        LAT["rules_min"] = round(samples[0], 3)
        LAT["rules_median"] = round(samples[len(samples) // 2], 3)
        LAT["rules_max"] = round(samples[-1], 3)
        print("LATENCY_RULES_MS min=%s median=%s max=%s" % (LAT["rules_min"], LAT["rules_median"], LAT["rules_max"]))
        check("打招呼走规则且确认收到", engine == "rules" and "收到" in body and "幕僚长正在处理" in body, body)
        check("规则回复低于 100 毫秒", samples[-1] < 100, samples[-1])

        body, engine = quick_reply.compose("1+1等于几")
        check("简单算术直答", engine == "rules" and "等于 2" in body, body)
        body, engine = quick_reply.compose("8/2")
        check("除法直答", engine == "rules" and "等于 4" in body, body)
        body, engine = quick_reply.compose("1/0")
        check("除零不装会算", "除数是 0" in body and "已转给幕僚长" in body, body)
        body, engine = quick_reply.compose("现在几点")
        check("时间用北京时间直答", engine == "rules" and "北京时间" in body and "星期" in body, body)
        body, engine = quick_reply.compose("你是谁")
        check("自报不是幕僚长", "不是幕僚长" in body and "快速回复（本地小模型）" in body, body)

        called = []

        def forbid_model(*a, **k):
            called.append(1)
            return "已经帮你下单了"

        real_model = quick_reply._call_model
        quick_reply._call_model = forbid_model
        os.environ["SB_QUICK_REPLY_URL"] = "http://127.0.0.1:9/api/generate"
        try:
            for text in ("帮我下单买入黄金", "发个帖宣布一下", "把这笔钱付了", "删掉昨天的记录", "把设定改成自动交易", "你保证一定赚钱"):
                body, engine = quick_reply.compose(text)
                bad = any(x in body for x in ("已经帮你下单", "已发帖", "已付款", "已删除", "已修改", "保证赚钱"))
                check("动作只转交不代办：" + text[:8], engine == "rules" and "幕僚长" in body and "不会代为" in body and not bad, body)
            check("动作类请求不调用模型", not called, called)
        finally:
            quick_reply._call_model = real_model
            os.environ.pop("SB_QUICK_REPLY_URL", None)
    finally:
        _env_restore(saved)


def test_bus_order_and_switch():
    saved = _env_saved("SB_QUICK_REPLY", "SB_QUICK_REPLY_URL", "SB_QUICK_REPLY_ENGINE")
    os.environ["SB_QUICK_REPLY"] = "1"
    os.environ["SB_QUICK_REPLY_ENGINE"] = "auto"
    os.environ["SB_QUICK_REPLY_URL"] = "http://127.0.0.1:9/nope"
    d, conn = fresh()
    order = []
    real_enq = commander_hook.enqueue
    real_model = quick_reply._call_model

    def enq(conn, msg, reason="owner_to_chief"):
        order.append("hook")
        return real_enq(conn, msg, reason)

    def model(*a, **k):
        order.append("model")
        raise TimeoutError("slow")

    commander_hook.enqueue = enq
    quick_reply._call_model = model
    try:
        t0 = time.perf_counter()
        r = message_bus.post_message(conn, "dagu-owner", "咖啡因是什么", to="grok-chief")
        wall = (time.perf_counter() - t0) * 1000
        LAT["post_wall_ms"] = round(wall, 3)
        q = r.get("quick_reply") or {}
        LAT["post_inner_ms"] = q.get("elapsed_ms")
        print("LATENCY_POST_MS wall=%s inner=%s engine=%s" % (LAT["post_wall_ms"], LAT["post_inner_ms"], q.get("engine")))
        check("先入 webhook 再问模型", order == ["hook", "model"], order)
        check("模型失败仍有规则回复", r["ok"] and q.get("engine") == "rules" and "收到" in q.get("text", ""), q.get("engine"))
        check("整段发送低于 1 秒", wall < 1000, wall)
        check("快速回复身份不是幕僚长",
              q.get("from_agent") == "local-quick" and q.get("from_instance") == quick_reply.LABEL
              and q.get("reply_to") == r["msg_id"] and "【快速回复（本地小模型）】" in q.get("text", ""))
        again = quick_reply.maybe_reply(conn, r)
        n = conn.execute("SELECT COUNT(*) FROM messages WHERE from_agent='local-quick' AND reply_to=?",
                         (r["msg_id"],)).fetchone()[0]
        check("同一条消息不重复秒回", again is None and n == 1, n)

        os.environ.pop("SB_QUICK_REPLY_URL", None)
        hi = message_bus.post_message(conn, "dagu-owner", "在吗", to="grok-chief")
        check("打招呼秒回", (hi.get("quick_reply") or {}).get("engine") == "rules" and "收到" in hi["quick_reply"]["text"])
        other = message_bus.post_message(conn, "dagu-owner", "你好", to="dsh-chief")
        check("不是发给幕僚长就不秒回", other["ok"] and "quick_reply" not in other)
        ping = message_bus.post_message(conn, "dagu-owner", "在的回复 1", to="all", kind="ping")
        check("点名不秒回", ping["ok"] and "quick_reply" not in ping)
        appr = message_bus.post_message(conn, "dagu-owner", "【审批】同意", to="grok-chief")
        check("系统审批条不秒回", appr["ok"] and "quick_reply" not in appr)

        alias = message_bus.post_message(conn, "dagu-owner", "在吗", to="幕僚长@云端")
        check("发给幕僚长实例名也会秒回", (alias.get("quick_reply") or {}).get("from_agent") == "local-quick")

        official = message_bus.handle_cmd(conn, "grok-chief", "msg",
                                           {"to": "dagu-owner", "text": "正式答复：先看盘，不下单。"})
        check("/cmd 正式回复仍是幕僚长本人",
              official.get("ok") and official.get("from_agent") == "grok-chief" and "quick_reply" not in official, official.get("from_agent"))
        chat = console_v2.chat_thread(conn)
        seq = [(m["from_agent"], "快速回复" in (m.get("text") or ""), "正式答复" in (m.get("text") or "")) for m in chat["messages"]]
        check("对话里快速回复和正式回复同时在且身份不同",
              any(a == "local-quick" and quick for a, quick, _ in seq)
              and any(a == "grok-chief" and not quick and formal for a, quick, formal in seq)
              and chat.get("quick_reply") is True, seq)

        os.environ["SB_QUICK_REPLY"] = "0"
        off = message_bus.post_message(conn, "dagu-owner", "关掉之后", to="grok-chief")
        n_off = conn.execute("SELECT COUNT(*) FROM messages WHERE from_agent='local-quick' AND reply_to=?",
                             (off["msg_id"],)).fetchone()[0]
        check("SB_QUICK_REPLY=0 不再秒回", off["ok"] and "quick_reply" not in off and n_off == 0, n_off)
        os.environ["SB_QUICK_REPLY"] = "1"
    finally:
        commander_hook.enqueue = real_enq
        quick_reply._call_model = real_model
        _env_restore(saved)
        conn.close()


def test_webhook_not_blocked():
    saved = _env_saved("SB_QUICK_REPLY")
    os.environ["SB_QUICK_REPLY"] = "1"
    d, conn = fresh()
    env = TMP / "quick-webhook.env"
    old_path = commander_hook.ENV_PATH
    old_state = dict(commander_hook._STATE)
    commander_hook.ENV_PATH = env
    env.write_text("COMMANDER_WEBHOOK_URL=http://127.0.0.1:9/hook\nCOMMANDER_WEBHOOK_KEY=k-test\n", encoding="utf-8")
    os.chmod(env, 0o600)
    commander_hook._STATE.update({"loaded": False, "warned": False, "url": "", "key": ""})
    real = quick_reply.maybe_reply

    def boom(conn, msg):
        raise RuntimeError("quick down")

    quick_reply.maybe_reply = boom
    try:
        r = message_bus.post_message(conn, "dagu-owner", "webhook 不能被拖住", to="grok-chief")
        n = conn.execute("SELECT COUNT(*) FROM webhook_outbox WHERE msg_id=?", (r["msg_id"],)).fetchone()[0]
        kept = conn.execute("SELECT text FROM messages WHERE msg_id=?", (r["msg_id"],)).fetchone()
        check("快速回复抛错时原消息仍成功且 webhook 已入队",
              r["ok"] and "quick_reply" not in r and n == 1 and kept and kept[0] == "webhook 不能被拖住", n)
    finally:
        quick_reply.maybe_reply = real
        commander_hook.ENV_PATH = old_path
        commander_hook._STATE.clear()
        commander_hook._STATE.update(old_state)
        commander_hook._STATE["loaded"] = False
        _env_restore(saved)
        conn.close()


def test_local_model_path():
    saved = _env_saved("SB_QUICK_REPLY", "SB_QUICK_REPLY_URL", "SB_QUICK_REPLY_ENGINE", "SB_QUICK_REPLY_TIMEOUT", "SB_QUICK_REPLY_MODEL")
    os.environ["SB_QUICK_REPLY"] = "1"
    os.environ["SB_QUICK_REPLY_ENGINE"] = "auto"
    os.environ["SB_QUICK_REPLY_MODEL"] = "tiny-test"

    class Ok(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            self.server.got = json.loads(self.rfile.read(n) or b"{}")
            if self.path.endswith("/v1/chat/completions"):
                body = {"choices": [{"message": {"content": "咖啡因是一种生物碱。"}}]}
            else:
                body = {"response": "已经帮你下单了，放心。"}
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *a):
            pass

    ok = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Ok)
    threading.Thread(target=ok.serve_forever, daemon=True).start()

    class Slow(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            time.sleep(3)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    slow = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=slow.serve_forever, daemon=True).start()
    try:
        os.environ["SB_QUICK_REPLY_URL"] = "http://127.0.0.1:%d/v1/chat/completions" % ok.server_address[1]
        t0 = time.perf_counter()
        body, engine = quick_reply.compose("咖啡因是什么")
        model_ms = (time.perf_counter() - t0) * 1000
        LAT["model_ms"] = round(model_ms, 3)
        print("LATENCY_MODEL_MS %s" % LAT["model_ms"])
        prompt = ((ok.got or {}).get("messages") or [{}])[-1].get("content") or ""
        check("本地模型直答被采用", engine == "model" and "生物碱" in body and "已经帮你" not in body, body)
        check("模型提示词声明不是幕僚长", "不是幕僚长" in prompt and "禁止" in prompt, prompt[:80])
        check("本地模型往返低于 3 秒", model_ms < 3000, model_ms)

        os.environ["SB_QUICK_REPLY_URL"] = "http://127.0.0.1:%d/api/generate" % ok.server_address[1]
        body, engine = quick_reply.compose("今天天气怎么样")
        check("模型声称已下单时改回规则", engine == "rules" and "已经帮你下单" not in body and "已转给幕僚长" in body, body)

        os.environ["SB_QUICK_REPLY_URL"] = "http://127.0.0.1:%d/api/generate" % slow.server_address[1]
        os.environ["SB_QUICK_REPLY_TIMEOUT"] = "0.4"
        t0 = time.perf_counter()
        body, engine = quick_reply.compose("顺便问一下库存")
        slow_ms = (time.perf_counter() - t0) * 1000
        LAT["model_timeout_ms"] = round(slow_ms, 3)
        print("LATENCY_MODEL_TIMEOUT_MS %s" % LAT["model_timeout_ms"])
        check("模型超时退回规则且不超过 2 秒", engine == "rules" and "收到" in body and slow_ms < 2000, (engine, slow_ms, body[:40]))
    finally:
        ok.shutdown()
        slow.shutdown()
        _env_restore(saved)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _req(port, path, method="GET", data=None, headers=None):
    req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"{}")
        except Exception:
            body = {}
        return e.code, body


def test_http_roundtrip():
    saved = _env_saved("SB_QUICK_REPLY", "SB_QUICK_REPLY_URL", "SB_OWNER_UNLOCK_PHRASE")
    os.environ["SB_QUICK_REPLY"] = "1"
    os.environ.pop("SB_QUICK_REPLY_URL", None)
    os.environ["SB_OWNER_UNLOCK_PHRASE"] = PHRASE
    d, conn = fresh()
    db = str(d / "state.db")
    conn.close()
    tok = d / "tokens.json"
    tok.write_text(json.dumps({"tokens": {"grok-chief": "chief-http"}, "viewers": {}, "owner": {"dagu-owner": "owner-http"}}),
                   encoding="utf-8")
    port = _free_port()
    env = dict(os.environ)
    env["SB_QUICK_REPLY"] = "1"
    env.pop("SB_QUICK_REPLY_URL", None)
    env.pop("SB_ALLOW_ANON_READ", None)
    env["SB_OWNER_UNLOCK_PHRASE"] = PHRASE
    proc = subprocess.Popen([sys.executable, str(RT / "tests" / "fixture_server.py"), db, str(tok), str(port)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    try:
        proc.stdout.readline()
        ready = False
        for _ in range(80):
            try:
                urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=1).read()
                ready = True
                break
            except Exception:
                time.sleep(0.1)
        check("临时接口已起来", ready)
        if not ready:
            return
        J = {"Content-Type": "application/json"}
        c, b = _req(port, "/api/chat")
        check("匿名读 /api/chat 仍是 401", c == 401 and b.get("need_auth") and "data" not in b, c)
        c, b = _req(port, "/api/owner/unlock", "POST",
                    json.dumps({"phrase": PHRASE, "device_name": "快速回复测试"}).encode(), J)
        check("测试口令可解锁", c == 200 and b.get("token"), c)
        if not b.get("token"):
            return
        A = dict(J, Authorization="Bearer " + b["token"])
        t0 = time.perf_counter()
        c, sent = _req(port, "/api/owner/act", "POST",
                       json.dumps({"action": "msg", "args": {"to": "grok-chief", "text": "在吗"}}).encode(), A)
        http_ms = (time.perf_counter() - t0) * 1000
        q = sent.get("quick_reply") or {}
        LAT["http_ms"] = round(http_ms, 3)
        print("LATENCY_HTTP_MS %s inner=%s" % (LAT["http_ms"], q.get("elapsed_ms")))
        check("发送接口 1 秒内带回快速回复",
              c == 200 and sent.get("ok") and q.get("from_agent") == "local-quick"
              and "快速回复（本地小模型）" in (q.get("text") or "") and "收到" in q.get("text", "")
              and http_ms < 1000, (c, http_ms, q.get("from_agent")))
        c, chat = _req(port, "/api/chat", headers=A)
        msgs = (chat.get("data") or {}).get("messages") or []
        check("对话线程能看到这条快速回复",
              c == 200 and any(m.get("text") == "在吗" and m.get("from_agent") == "dagu-owner" for m in msgs)
              and any(m.get("from_agent") == "local-quick" and m.get("reply_to") == sent.get("msg_id") for m in msgs))
        conn = sqlite3.connect(db)
        official = message_bus.handle_cmd(conn, "grok-chief", "msg", {"to": "dagu-owner", "text": "正式答复：我在，先看盘。"})
        conn.close()
        c, chat = _req(port, "/api/chat", headers=A)
        msgs = (chat.get("data") or {}).get("messages") or []
        check("正式回复另条出现且不是快速回复",
              official.get("ok") and any(m.get("from_agent") == "grok-chief" and "正式答复" in (m.get("text") or "") and "快速回复" not in (m.get("from_instance") or "") for m in msgs)
              and any(m.get("from_agent") == "local-quick" for m in msgs))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        _env_restore(saved)


def test_frontend_marks():
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    css = (ROOT / "70-Console/design/prototype/v2/app.css").read_text(encoding="utf-8")
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    check("前端认 local-quick", 'const QUICK_ID = "local-quick"' in js and "快速回复（本地小模型）" in js)
    check("气泡区分快速回复和正式回复", "who-tag quick" in js and "幕僚长 · 正式回复" in js and ".bub.quick" in css and ".who-tag.chief" in css)
    check("发送响应会立刻画上快速回复", "j.quick_reply" in js and "addChat(j.quick_reply, true)" in js)
    check("语音定稿仍走 sendChat", "async function commitUtterance" in js and "await sendChat({ voiceGen: sttGen })" in js)
    check("页面版本已抬到 2.8.6", "v2/app.js?v=2.8.6" in html and "v2/app.css?v=2.8.6" in html)
    check("前端没有把令牌写进查询", "token=" not in js and "?token" not in js)


def main():
    try:
        test_rules_and_guard()
        test_bus_order_and_switch()
        test_webhook_not_blocked()
        test_local_model_path()
        test_http_roundtrip()
        test_frontend_marks()
    finally:
        print("LATENCY_SUMMARY " + json.dumps(LAT, ensure_ascii=False))
    if FAILS:
        print("FAILED %d" % len(FAILS))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
