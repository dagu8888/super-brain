#!/usr/bin/env python3
"""受控会话 HTTP。日常语音流式转发给官方 DeepSeek，密钥不进响应。"""
import json
from urllib.parse import urlparse

import assistant_session
import message_bus

CORS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
)
_BOOK = assistant_session.SessionBook()


def _path(handler):
    return urlparse(handler.path).path.rstrip("/") or "/"


def _json_send(handler, code, obj, extra=()):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Assistant-Mode", assistant_session.public_status().get("mode") or "unconfigured")
    for key, value in extra:
        handler.send_header(key, value)
    for key, value in CORS:
        handler.send_header(key, value)
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def _require(handler, db_fn, log_event):
    conn = db_fn()
    try:
        who = handler._owner(conn)
    finally:
        conn.close()
    if not who:
        log_event("owner_auth_failed", path=_path(handler)[-80:])
        _json_send(handler, 401, {"ok": False, "error": "需要先输入当日口令", "need_unlock": True, "mock": False})
        return None
    return who


def _allowlist():
    return ()


def _device(who):
    return str((who or {}).get("device_id") or (who or {}).get("device") or "owner")


def _status(handler, db_fn, log_event):
    if not _require(handler, db_fn, log_event):
        return True
    _json_send(handler, 200, assistant_session.public_status(_allowlist()))
    return True


def _poster(db_fn, device):
    def poster(text, key):
        conn = db_fn()
        try:
            return message_bus.post_message(
                conn, "dagu-owner", "【语音委托】%s" % str(text or "")[:500],
                to=assistant_session.CHIEF_ID, kind="chat")
        except Exception:
            return {"ok": False}
        finally:
            conn.close()
    return poster


def _stream(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    try:
        req = handler._read_json()
    except Exception:
        _json_send(handler, 400, {"ok": False, "error": "请求无效", "mock": False})
        return True
    device = _device(who)
    turn_id = str(req.get("turn_id") or "")
    if not turn_id:
        _json_send(handler, 400, {"ok": False, "error": "缺 turn_id", "mock": False})
        return True
    _BOOK.begin(device, turn_id)
    budget = None
    timeout_s = None
    if req.get("budget") is not None:
        try:
            budget = int(req.get("budget"))
        except (TypeError, ValueError):
            budget = None
    if req.get("timeout_s") is not None:
        try:
            timeout_s = float(req.get("timeout_s"))
        except (TypeError, ValueError):
            timeout_s = None
    mode = assistant_session.public_status().get("mode") or "unconfigured"
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Assistant-Mode", mode)
    for key, value in CORS:
        handler.send_header(key, value)
    handler.end_headers()
    for item in assistant_session.iter_turn(
            _BOOK, device, turn_id, req.get("text") or "",
            source=str(req.get("source") or ""),
            uncertain=bool(req.get("uncertain")),
            budget=budget, timeout_s=timeout_s,
            poster=_poster(db_fn, device)):
        if _BOOK.current(device) != turn_id and item.get("event") != "error":
            item = {"event": "error", "mock": False, "code": "superseded", "stop_tts": True, "stop_mic": False,
                    "message": "新一轮已到，旧流关闭。"}
        payload = dict(item)
        payload["mock"] = False
        name = payload.pop("event")
        blob = json.dumps(payload, ensure_ascii=False)
        handler.wfile.write(("event: %s\ndata: %s\n\n" % (name, blob)).encode("utf-8"))
        handler.wfile.flush()
        if name == "error" and payload.get("code") in ("superseded", "cancelled", "timeout", "budget", "insufficient_balance"):
            break
    log_event("assistant_turn", ok=True, chars=len(str(req.get("text") or "")), mode=mode)
    return True


def _cancel(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    try:
        req = handler._read_json()
    except Exception:
        req = {}
    device = _device(who)
    _BOOK.begin(device, "cancelled:" + str(req.get("turn_id") or ""))
    _json_send(handler, 200, {"ok": True, "mock": False, "stop_tts": True, "stop_mic": False,
                             "message": "已取消播放队列。采集保持。"})
    return True


_GET = {"/api/owner/assistant/status": _status}
_POST = {
    "/api/owner/assistant/stream": _stream,
    "/api/owner/assistant/cancel": _cancel,
}


def try_handle(handler, method, db_fn, log_event):
    path = _path(handler)
    table = _GET if method == "GET" else _POST if method == "POST" else None
    if not table or path not in table:
        return False
    return table[path](handler, db_fn, log_event)
