#!/usr/bin/env python3
# 阶段 1：明确标记的 mock SSE。不连接文本供应商，不读密钥，不部署。
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
TMP = Path(tempfile.mkdtemp(prefix="sb-assistant-mock-"))
os.environ["SB_OWNER_UNLOCK_PHRASE"] = "语音测试口令"
os.environ["SB_COMMANDER_WEBHOOK_ENV"] = str(TMP / "no-webhook.env")
os.environ.pop("SB_QUICK_REPLY_URL", None)
os.environ["SB_QUICK_REPLY_ENGINE"] = "rules"
os.environ.pop("SB_ASSISTANT_BASE_ALLOWLIST", None)
sys.path.insert(0, str(RT))

import assistant_http  # noqa: E402
import assistant_session  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import api_server  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else " " + str(detail)))
    if not cond:
        FAILS.append(name)


def fresh():
    path = TMP / "state.db"
    conn = sqlite3.connect(str(path))
    migrate_v2.migrate(conn)
    owner_ops.ensure_schema(conn)
    conn.close()
    return path


def serve(path):
    def db_fn():
        return sqlite3.connect(str(path), timeout=10)

    handler = api_server._make_handler(db_fn, lambda *a: {"ok": False}, lambda *a, **k: None, {"grok-chief": "chief-x"}, {}, threading.Event(), {})
    httpd = api_server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def req(port, method, path, body=None, headers=None):
    import urllib.error
    import urllib.request
    data = None if body is None else json.dumps(body).encode()
    h = dict(headers or {})
    if data is not None:
        h.setdefault("Content-Type", "application/json")
    request = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(request, timeout=8) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.headers.get("X-Assistant-Mode", ""), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("Content-Type", ""), err.headers.get("X-Assistant-Mode", ""), err.read()


def events_of(raw):
    text = raw.decode("utf-8")
    out = []
    for block in text.split("\n\n"):
        name, data = "message", ""
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if data:
            out.append((name, json.loads(data)))
    return out


def chief_count(path):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute('SELECT COUNT(*) FROM messages WHERE "to"=?', ("grok-chief",)).fetchone()[0]
    finally:
        conn.close()


def test_policy_and_plan():
    status = assistant_session.public_status(())
    check("真实流未接通且没有默认模型", status["real_connected"] is False and status["mock"] is True and status["model_id"] == "" and status["base_url"] == "" and status["price"] is None and "未接通" in status["reason"])
    check("不跟随跳转", assistant_session.redirects_are_not_followed() is False)
    allow = ("https://api.example.com",)
    check("允许名单内的 HTTPS 通过", assistant_session.check_base_url("https://api.example.com/v1", allow) == "ok")
    rejected = {
        "http://api.example.com": "reject-scheme",
        "https://user:pw@api.example.com": "reject-secret-or-query",
        "https://api.example.com/?k=v": "reject-secret-or-query",
        "https://127.0.0.1": "reject-internal",
        "https://localhost": "reject-internal",
        "https://10.1.2.3": "reject-internal",
        "https://192.168.1.9": "reject-internal",
        "https://169.254.169.254": "reject-internal",
        "https://metadata.google.internal": "reject-internal",
        "https://evil.example": "reject-not-allowlisted",
    }
    check("非预期地址全部拒绝", all(assistant_session.check_base_url(url, allow) == why for url, why in rejected.items()), assistant_session.check_base_url("https://127.0.0.1", allow))
    src = (RT / "assistant_session.py").read_text(encoding="utf-8") + (RT / "assistant_http.py").read_text(encoding="utf-8")
    check("生产代码不写回环默认、口述模型或价格", "3425" not in src and "deepseek" not in src.lower() and "magpie" not in src.lower() and "workbuddy" not in src.lower() and "urlopen" not in src)

    book = assistant_session.SessionBook()
    book.begin("d", "t1")
    ev = assistant_session.plan_turn(book, "d", "t1", "你好", budget=80, timeout_s=8, poster=lambda text, key: {"ok": True, "msg_id": "should-not"})
    deltas = [item["text"] for item in ev if item["event"] == "delta"]
    sentences = [item["text"] for item in ev if item["event"] == "sentence"]
    joined = "".join(deltas)
    check("模拟流按句拼装", ev[0]["event"] == "context" and ev[0]["mock"] is True and "私人助手" in ev[0]["role_core_text"] and sentences and joined == "".join(sentences) and all(item["mock"] is True for item in ev) and "【模拟流】" in joined)
    check("普通闲聊不调用转交", all(item["event"] != "delegate" for item in ev) and book.context_size("d") == 2)

    before = book.context_size("d")
    echo = assistant_session.plan_turn(book, "d", "t1", sentences[0], budget=80, timeout_s=8)
    check("朗读回授不记成新指令", echo[0]["code"] == "echo" and book.context_size("d") == before)
    tts = assistant_session.plan_turn(book, "d", "t1", "任意", source="assistant_tts", budget=80, timeout_s=8)
    check("标记为朗读来源的文本被丢掉", tts[0]["code"] == "echo" and book.context_size("d") == before)

    book.begin("d", "t2")
    unsure = assistant_session.plan_turn(book, "d", "t2", "听错了", uncertain=True, budget=80, timeout_s=8)
    check("听写误词不进记忆", any(item["event"] == "sentence" for item in unsure) and book.context_size("d") == before and all(item.get("code") != "echo" for item in unsure))

    book.begin("d", "t3")
    limited = assistant_session.plan_turn(book, "d", "t3", "预算", budget=3, timeout_s=8)
    check("预算打满失败关闭且不关麦", any(item.get("code") == "budget" and item.get("stop_mic") is False and item.get("stop_tts") is True for item in limited) and not any(item["event"] == "done" for item in limited))
    book.begin("d", "t4")
    late = assistant_session.plan_turn(book, "d", "t4", "超时", budget=80, timeout_s=0)
    check("超时失败关闭且不关麦", late[0]["code"] == "timeout" and late[0]["stop_mic"] is False and "失败关闭" in late[0]["message"])

    calls = []

    def poster(text, key):
        calls.append(key)
        return {"ok": True, "msg_id": "m-1"}

    book.begin("d", "t5")
    first = assistant_session.plan_turn(book, "d", "t5", "告诉幕僚长，整理今天的回执", poster=poster)
    book.begin("d", "t6")
    second = assistant_session.plan_turn(book, "d", "t6", "告诉幕僚长，整理今天的回执", poster=poster)
    check("明确委托只转一次并带回执", len(calls) == 1 and first[1]["receipt"]["msg_id"] == "m-1" and "已转交" in first[1]["text"] and second[1]["duplicate"] is True and second[1]["receipt"]["msg_id"] == "m-1")
    book.begin("d", "t7")
    missing = assistant_session.plan_turn(book, "d", "t7", "让幕僚长办另一件", poster=lambda text, key: {"ok": False})
    check("没有回执就不称已转交", missing[1]["receipt"] is None and "不能称为已转交" in missing[1]["text"] and "回执是" not in missing[1]["text"])

    book.begin("d", "t8")
    health = assistant_session.plan_turn(book, "d", "t8", "服务器健康", poster=poster)
    check("健康查询是本地动作", any(item["event"] == "action" and item["name"] == "getServerHealth" for item in health) and all(item["event"] != "delegate" for item in health))
    check("白名单动作可过、任意脚本不过", assistant_session.validate_action("setTab", {"tab": "chat"}) and assistant_session.validate_action("scrollChat", {}) and not assistant_session.validate_action("eval", {}) and not assistant_session.validate_action("setTab", {"tab": "chat", "code": "1"}))

    class Flip(assistant_session.SessionBook):
        def __init__(self):
            super().__init__()
            self.n = 0

        def current(self, device):
            self.n += 1
            if self.n >= 3:
                return "newer"
            return super().current(device)

    flip = Flip()
    flip.begin("d", "old")
    dropped = assistant_session.plan_turn(flip, "d", "old", "新的一轮来了")
    check("新一轮丢弃旧流且不写旧句", any(item.get("code") == "superseded" for item in dropped) and flip.context_size("d") == 0 and sum(1 for item in dropped if item["event"] == "sentence") == 1)


def test_http():
    assistant_http._BOOK = assistant_session.SessionBook()
    path = fresh()
    conn = sqlite3.connect(str(path))
    token = owner_ops.unlock(conn, "语音测试口令", "模拟机")["token"]
    conn.close()
    httpd = serve(path)
    port = httpd.server_address[1]
    try:
        code, ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "你好", "turn_id": "a"})
        check("无主人会话 401 且没有流内容", code == 401 and b"mock" in body and "你好" not in body.decode("utf-8", "replace"))
        code, ctype, mode, body = req(port, "GET", "/api/owner/assistant/status", headers={"Authorization": "Bearer " + token})
        status = json.loads(body.decode())
        check("状态写明模拟流未接通", code == 200 and status.get("mock") is True and status.get("real_connected") is False and "未接通" in status.get("reason", "") and mode == "mock")
        before = chief_count(path)
        code, ctype, mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "今天天气怎么样", "turn_id": "b1", "budget": 80, "timeout_s": 8}, {"Authorization": "Bearer " + token})
        ev = events_of(body)
        check("已鉴权模拟流拆包并标记", code == 200 and "text/event-stream" in ctype and mode == "mock" and any(name == "delta" and item.get("mock") is True for name, item in ev) and any(name == "sentence" and "【模拟流】" in item.get("text", "") for name, item in ev))
        check("普通语音闲聊没有幕僚长消息", chief_count(path) == before)
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "再聊一句", "turn_id": "b2"}, {"Authorization": "Bearer " + token})
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "第三句", "turn_id": "b3"}, {"Authorization": "Bearer " + token})
        check("三轮普通语音仍没有幕僚长消息", chief_count(path) == before)
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "告诉幕僚长，只转这一次", "turn_id": "d1"}, {"Authorization": "Bearer " + token})
        first = events_of(body)
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "告诉幕僚长，只转这一次", "turn_id": "d2"}, {"Authorization": "Bearer " + token})
        second = events_of(body)
        receipt = next(item.get("receipt") for name, item in first if name == "delegate")
        again = next(item for name, item in second if name == "delegate")
        check("回执可核对且第二次不新增", bool(receipt.get("msg_id")) and again.get("duplicate") is True and again.get("receipt", {}).get("msg_id") == receipt.get("msg_id") and chief_count(path) == before + 1)
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "很短", "turn_id": "bud", "budget": 2}, {"Authorization": "Bearer " + token})
        bud = events_of(body)
        check("HTTP 预算失败关闭", any(item.get("code") == "budget" and item.get("stop_mic") is False for _n, item in bud))
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/stream", {"text": "来不及", "turn_id": "to", "timeout_s": 0}, {"Authorization": "Bearer " + token})
        late = events_of(body)
        check("HTTP 超时失败关闭", any(item.get("code") == "timeout" and "失败关闭" in item.get("message", "") for _n, item in late))
        code, _ctype, _mode, body = req(port, "POST", "/api/owner/assistant/cancel", {"turn_id": "b3"}, {"Authorization": "Bearer " + token})
        cancelled = json.loads(body.decode())
        check("取消只停播放并保持采集", code == 200 and cancelled.get("stop_tts") is True and cancelled.get("stop_mic") is False and cancelled.get("mock") is True)
    finally:
        httpd.shutdown()


def test_page_and_node():
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    fn = js.split("async function runMockAssistant", 1)[1].split("function pcm16", 1)[0]
    check("模拟朗读不调用文静", "/api/owner/voice/speak" not in fn and "openSpeak" not in fn and "speechSynthesis" not in fn and "静音夹具" in fn)
    cancel = js.split("function cancelAssistantPlayback", 1)[1].split("function stopCaptureExplicit", 1)[0]
    check("取消播放不释放音轨", "stopConversation" not in cancel and "releaseStream" not in cancel and "assistantPlayer.stop" in cancel)
    mic = js.split("function stopCaptureExplicit", 1)[1].split("function applyAssistantUi", 1)[0]
    check("显式关麦才停通话", "stopConversation()" in mic)
    proc = subprocess.run(["node", str(RT / "tests" / "test_assistant_stream.mjs")], capture_output=True, text=True)
    print(proc.stdout.strip())
    check("浏览器侧拼装、取消和回授", proc.returncode == 0 and "ALL PASS" in proc.stdout, (proc.stdout + proc.stderr)[-800:])


if __name__ == "__main__":
    test_policy_and_plan()
    test_http()
    test_page_and_node()
    if FAILS:
        print("FAILED " + ", ".join(FAILS))
        sys.exit(1)
    print("ALL PASS")
