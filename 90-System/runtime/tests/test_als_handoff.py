#!/usr/bin/env python3
# 交办任务号和明确纠正词表。只用临时库，不发生产，不调用官方接口。
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
TMP = Path(tempfile.mkdtemp(prefix="sb-als-handoff-"))
os.environ["SB_OWNER_UNLOCK_PHRASE"] = "语音测试口令"
os.environ["SB_COMMANDER_WEBHOOK_ENV"] = str(TMP / "no-webhook.env")
os.environ.pop("SB_QUICK_REPLY_URL", None)
os.environ["SB_QUICK_REPLY_ENGINE"] = "rules"
os.environ.pop("SB_DEEPSEEK_API_KEY", None)
sys.path.insert(0, str(RT))

import assistant_deepseek  # noqa: E402
import assistant_handoff  # noqa: E402
import assistant_http  # noqa: E402
import assistant_session  # noqa: E402
import assistant_store  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import api_server  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else " " + str(detail)[:240]))
    if not cond:
        FAILS.append(name)


def fresh():
    path = TMP / ("state-%s.db" % len(list(TMP.glob("state-*.db"))))
    conn = sqlite3.connect(str(path))
    migrate_v2.migrate(conn)
    owner_ops.ensure_schema(conn)
    message_bus.ensure_schema(conn)
    assistant_store.ensure_schema(conn)
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
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode() or "{}")
            except ValueError:
                return resp.status, {"raw": raw.decode("utf-8", "replace")[:300]}
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read().decode() or "{}")
        except ValueError:
            return err.code, {}


def task_rows(path):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute("SELECT id, type, status FROM tasks WHERE type=?", (assistant_handoff.TASK_TYPE,)).fetchall()
    finally:
        conn.close()


def chief_count(path):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute('SELECT COUNT(*) FROM messages WHERE "to"=?', ("grok-chief",)).fetchone()[0]
    finally:
        conn.close()


def test_slots_and_memory_gap():
    path = fresh()
    conn = sqlite3.connect(str(path))
    slots = assistant_handoff.context_slots(conn)
    text = assistant_store.compose_system(slots=slots)
    check("新会话四栏有来源且主人记忆仍是缺口",
          "NOT IMPLEMENTED" in slots["{{USER_MEMORY}}"] and "没有主人记忆表" in slots["{{USER_MEMORY}}"]
          and "没有 projects 表" in slots["{{PROJECT_STATE}}"]
          and "0 条" in slots["{{ACTIVE_TASKS}}"] and "tasks" in slots["{{ACTIVE_TASKS}}"]
          and "0 条" in slots["{{ASR_GLOSSARY}}"] and "asr_glossary" in slots["{{ASR_GLOSSARY}}"]
          and "贾维斯" not in slots["{{ASR_GLOSSARY}}"]
          and "{{USER_MEMORY}}" not in text and "二、发给 Grokbot" not in text)
    check("空词表没有被例子种上", conn.execute("SELECT COUNT(*) FROM asr_glossary").fetchone()[0] == 0)
    conn.execute("CREATE TABLE projects(id TEXT, name TEXT, status TEXT, updated_at INTEGER, updated_by TEXT)")
    conn.execute("INSERT INTO projects VALUES('p1','隔离项目','active',1700000000,'dagu-owner')")
    conn.commit()
    project = assistant_handoff.project_slot(conn)
    check("项目栏带来源时间且不编百分比", "隔离项目" in project and "1700000000" in project and "projects" in project and "%" not in project)
    conn.close()


def test_glossary_correction():
    path = fresh()
    conn = sqlite3.connect(str(path))
    sid = assistant_store.open_session(conn, "dev")
    original = "周五开会改到下午"
    assistant_store.append_turn(conn, sid, "dagu", original, "dagu:stt")
    refused = assistant_handoff.save_correction(conn, {
        "explicit": False, "wrong": "开会", "right": "会议", "domain": "日程",
        "confidence": 0.99, "source_ref": "no", "original_transcript": original,
    }, "dev")
    check("没标明明确纠正就不写", refused.get("ok") is False and conn.execute("SELECT COUNT(*) FROM asr_glossary").fetchone()[0] == 0)
    low = assistant_handoff.save_correction(conn, {
        "explicit": True, "wrong": "下午", "right": "傍晚", "domain": "日程",
        "confidence": 0.4, "source_ref": "turn-low", "original_transcript": original,
    }, "dev")
    high = assistant_handoff.save_correction(conn, {
        "explicit": True, "wrong": "开会", "right": "会议", "domain": "日程",
        "confidence": 0.95, "source_ref": "turn-stt", "original_transcript": original,
    }, "dev")
    row = conn.execute("SELECT source_kind, source_ref, original_transcript, confidence FROM asr_glossary WHERE wrong='开会'").fetchone()
    kept = conn.execute("SELECT text FROM steward_turns WHERE dedupe_key='dagu:stt'").fetchone()[0]
    mapped = assistant_handoff.prepare_turn(conn, original, "日程")
    other = assistant_handoff.prepare_turn(conn, original, "人名")
    none = assistant_handoff.prepare_turn(conn, original, "")
    check("高置信纠正带来源且原转写还在", high.get("ok") and high.get("applied") is True and row[0].startswith("owner_correction:") and row[1] == "turn-stt" and row[2] == original and kept == original)
    check("低置信入库但不改写", low.get("ok") and low.get("applied") is False and "傍晚" not in mapped["model_text"])
    check("同领域才改写且原话留在理解层", mapped["confirm"] is False and "用户原话：" + original in mapped["model_text"] and "会议" in mapped["model_text"] and other["model_text"] == original and none["reason"] == "no_domain")
    danger = assistant_handoff.save_correction(conn, {
        "explicit": True, "wrong": "改到", "right": "下单", "domain": "命令",
        "confidence": 0.99, "source_ref": "turn-risk", "original_transcript": "帮我改到周五",
    }, "dev")
    risky = assistant_handoff.prepare_turn(conn, "帮我改到周五", "命令")
    overlap_a = assistant_handoff.save_correction(conn, {
        "explicit": True, "wrong": "开会", "right": "会议", "domain": "重叠",
        "confidence": 0.9, "source_ref": "a", "original_transcript": "周五开会",
    }, "dev")
    overlap_b = assistant_handoff.save_correction(conn, {
        "explicit": True, "wrong": "周五开会", "right": "下周会", "domain": "重叠",
        "confidence": 0.9, "source_ref": "b", "original_transcript": "周五开会",
    }, "dev")
    ambiguous = assistant_handoff.prepare_turn(conn, "周五开会", "重叠")
    check("有后果或重叠歧义不改原话", danger.get("ok") and risky["confirm"] is True and risky["model_text"] == "帮我改到周五" and overlap_a.get("ok") and overlap_b.get("ok") and ambiguous["confirm"] is True and ambiguous["model_text"] == "周五开会")
    conn.close()


def test_chat_does_not_dispatch():
    path = fresh()
    calls = {"n": 0}

    def poster(text, key):
        calls["n"] += 1
        return {"ok": True, "msg_id": "should-not", "task_id": 1}

    book = assistant_session.SessionBook()
    book.begin("d", "chat")
    ev = assistant_session.plan_turn(book, "d", "chat", "你好，周五开会", poster=poster, transport=lambda *a, **k: iter([
        {"type": "delta", "text": "在。"}, {"type": "done", "finish": "stop"}]))
    conn = sqlite3.connect(str(path))
    assistant_handoff.ensure_schema(conn)
    spoken = assistant_handoff.save_correction(conn, {
        "explicit": True, "wrong": "开会", "right": "会议", "domain": "日程",
        "confidence": 0.95, "source_ref": "x", "original_transcript": "周五开会",
    }, "dev")
    view = assistant_handoff.prepare_turn(conn, "你好，周五开会", "日程")
    book.begin("d", "mapped")
    mapped = assistant_session.plan_turn(
        book, "d", "mapped", "你好，周五开会", poster=poster, utterance=view,
        transport=lambda messages, cancel, timeout_s=None, max_tokens=None, opener=None: iter([
            {"type": "delta", "text": "好。"}, {"type": "done", "finish": "stop"}]))
    check("闲聊不派单", calls["n"] == 0 and all(item["event"] != "delegate" for item in ev) and task_rows(path) == [])
    check("理解层改写不写进派单", spoken.get("ok") and calls["n"] == 0 and "会议" in view["model_text"])
    # The transport above doesn't record messages. Re-run once to inspect the prompt.
    seen = {}

    def transport(messages, cancel, timeout_s=None, max_tokens=None, opener=None):
        seen["user"] = messages[-1]["content"]
        yield {"type": "delta", "text": "好。"}
        yield {"type": "done", "finish": "stop"}

    book.begin("d", "seen")
    assistant_session.plan_turn(book, "d", "seen", "你好，周五开会", poster=poster, utterance=view, transport=transport)
    check("模型看到原话和改写，库存转写未派单", "用户原话：你好，周五开会" in seen.get("user", "") and "会议" in seen.get("user", "") and calls["n"] == 0)
    conn.close()
    del mapped


def test_verbal_and_status():
    assistant_deepseek.reset_for_tests()
    assistant_http._BOOK = assistant_session.SessionBook()
    path = fresh()
    conn = sqlite3.connect(str(path))
    token = owner_ops.unlock(conn, "语音测试口令", "模拟机")["token"]
    before_turns = conn.execute("SELECT COUNT(*) FROM steward_turns").fetchone()[0]
    conn.close()
    httpd = serve(path)
    port = httpd.server_address[1]
    auth = {"Authorization": "Bearer " + token}
    try:
        code, body = req(port, "GET", "/api/owner/assistant/task?task_id=1")
        check("未登录不能查任务", code == 401 and (body.get("need_unlock") is True or body.get("need_auth") is True))
        code, body = req(port, "POST", "/api/owner/assistant/glossary", {
            "explicit": True, "wrong": "开会", "right": "会议", "domain": "日程",
            "confidence": 0.95, "source_ref": "http-1", "original_transcript": "周五开会",
        })
        check("未登录不能写词表", code == 401)
        real = assistant_deepseek.stream_events

        def patched(messages, cancel, timeout_s=None, max_tokens=None, opener=None):
            yield {"type": "delta", "text": "在的。"}
            yield {"type": "done", "finish": "stop"}

        assistant_deepseek.stream_events = patched
        before = chief_count(path)
        req(port, "POST", "/api/owner/assistant/stream", {"text": "你好", "turn_id": "c1", "domain": "日程"}, auth)
        check("闲聊后没有任务也没有幕僚长消息", task_rows(path) == [] and chief_count(path) == before)
        req(port, "POST", "/api/owner/assistant/stream", {"text": "告诉幕僚长，只转这一次", "turn_id": "d1"}, auth)
        req(port, "POST", "/api/owner/assistant/stream", {"text": "告诉幕僚长，只转这一次", "turn_id": "d2"}, auth)
        rows = task_rows(path)
        conn = sqlite3.connect(str(path))
        link = conn.execute("SELECT task_id, msg_id, source FROM als_handoffs").fetchone()
        stored = assistant_handoff.task_status(conn, link[0] if link else 0)
        payload = json.loads(conn.execute("SELECT payload FROM tasks WHERE id=?", (link[0],)).fetchone()[0])
        chief = conn.execute('SELECT text FROM messages WHERE "to"=?', ("grok-chief",)).fetchone()[0]
        conn.close()
        check("明确委托只产生一个任务号并关联消息号",
              len(rows) == 1 and rows[0][2] == "pending" and link[2] == "owner_verbal"
              and link[1] and str(link[0]) != link[1] and chief_count(path) == before + 1
              and "任务号 %s" % link[0] in chief and link[1] not in str(link[0]))
        check("状态是未执行且没有假百分比",
              stored["execution"] == "未执行" and stored["progress_percent"] is None and stored["status"] == "pending"
              and stored["msg_id"] == link[1] and payload["approval_required"] is True and "title" in payload)
        code, body = req(port, "GET", "/api/owner/assistant/task?task_id=%s" % link[0], headers=auth)
        check("主人能查到同一条真实状态", code == 200 and body.get("task_id") == link[0] and body.get("execution") == "未执行" and body.get("progress_percent") is None)
        code, missing = req(port, "GET", "/api/owner/assistant/task?task_id=99999", headers=auth)
        check("没有的任务不明说已完成", code == 404 and missing.get("execution") == "未知")
        code, saved = req(port, "POST", "/api/owner/assistant/glossary", {
            "explicit": True, "wrong": "开会", "right": "会议", "domain": "日程",
            "confidence": 0.95, "source_ref": "http-1", "original_transcript": "周五开会",
        }, auth)
        code, listed = req(port, "GET", "/api/owner/assistant/glossary", headers=auth)
        check("主人纠正后能按来源读回", saved.get("ok") and listed.get("items") and listed["items"][0]["source_ref"] == "http-1" and listed["items"][0]["original_transcript"] == "周五开会")
        conn = sqlite3.connect(str(path))
        turns = conn.execute("SELECT COUNT(*) FROM steward_turns").fetchone()[0]
        conn.close()
        check("旧历史条数只增加这次对话", turns >= before_turns)
        assistant_deepseek.stream_events = real
    finally:
        httpd.shutdown()


def test_pack_once_and_old_rows():
    path = fresh()
    conn = sqlite3.connect(str(path))
    assistant_store.save_card(conn, "自定义短卡，只为回归。")
    sid = assistant_store.open_session(conn, "dev")
    assistant_store.append_turn(conn, sid, "dagu", "帮我记一下周五开会", "dagu:1")
    message_bus.post_message(conn, "dagu-owner", "旧直聊留着", to="grok-chief")
    turns_before = conn.execute("SELECT COUNT(*) FROM steward_turns").fetchone()[0]
    chief_before = conn.execute('SELECT COUNT(*) FROM messages WHERE "to"=?', ("grok-chief",)).fetchone()[0]
    conn.close()
    packed = {"n": 0}

    def poster(text):
        packed["n"] += 1
        return {"ok": True, "msg_id": "pack-real-1"}

    conn = sqlite3.connect(str(path))
    first = assistant_store.pack_session(conn, "dev", sid, poster)
    second = assistant_store.pack_session(conn, "dev", sid, poster)
    status = assistant_handoff.task_status(conn, first.get("task_id"))
    turns_after = conn.execute("SELECT COUNT(*) FROM steward_turns").fetchone()[0]
    chief_after = conn.execute('SELECT COUNT(*) FROM messages WHERE "to"=?', ("grok-chief",)).fetchone()[0]
    card = assistant_store.load_card(conn)
    conn.close()
    check("点击打包一次且任务号消息号不同",
          packed["n"] == 1 and first.get("task_id") and first.get("msg_id") == "pack-real-1"
          and str(first["task_id"]) != first["msg_id"] and second.get("duplicate") is True
          and second.get("task_id") == first["task_id"] and second.get("msg_id") == first["msg_id"])
    check("打包状态未执行且旧记录还在",
          status["execution"] == "未执行" and status["progress_percent"] is None
          and turns_after == turns_before and chief_after == chief_before and card["text"] == "自定义短卡，只为回归。")

    path2 = fresh()
    conn = sqlite3.connect(str(path2))
    sid = assistant_store.open_session(conn, "dev")
    assistant_store.append_turn(conn, sid, "dagu", "帮我记一下并发", "dagu:1")
    conn.close()
    calls = {"n": 0}

    def slow(text):
        calls["n"] += 1
        time.sleep(0.2)
        return {"ok": True, "msg_id": "parallel-1"}

    results = [None, None]

    def worker(idx):
        own = sqlite3.connect(str(path2), timeout=10)
        try:
            results[idx] = assistant_store.pack_session(own, "dev", sid, slow)
        finally:
            own.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in (0, 1)]
    for item in threads:
        item.start()
    for item in threads:
        item.join(5)
    ids = {item.get("task_id") for item in results if item}
    check("并发打包只有一个任务号", calls["n"] == 1 and len(ids) == 1 and task_rows(path2).__len__() == 1)


if __name__ == "__main__":
    test_slots_and_memory_gap()
    test_glossary_correction()
    test_chat_does_not_dispatch()
    test_verbal_and_status()
    test_pack_once_and_old_rows()
    if FAILS:
        print("FAILED " + ", ".join(FAILS))
        sys.exit(1)
    print("ALL PASS")
