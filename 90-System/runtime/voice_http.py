#!/usr/bin/env python3
"""操作台语音 HTTP。挂在 api_server 同一进程里。响应里不出现密钥。"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VOICE_DIR = Path(__file__).resolve().parent.parent / "voice"
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import deepgram_proxy  # noqa: E402
import owner_ops  # noqa: E402

CORS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
)
PARTIAL_MAX = 48000 * 2 * 20 + 1024
_PARTIAL_RATE = {}


def _path(handler):
    return urlparse(handler.path).path.rstrip("/") or "/"


def _query(handler):
    return {k: v[0] for k, v in parse_qs(urlparse(handler.path).query).items()}


def _json_send(handler, code, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
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
        _json_send(handler, 401, {"ok": False, "error": "需要先输入当日口令", "need_unlock": True})
        return None
    return who


def _read_body(handler, limit):
    try:
        n = int(handler.headers.get("Content-Length", 0) or 0)
    except ValueError:
        n = -1
    if n < 0 or n > limit:
        return None
    return handler.rfile.read(n) if n else b""


def _audit(db_fn, who, action, target, detail, ok, handler):
    conn = db_fn()
    try:
        owner_ops.audit(conn, who, action, target, detail, ok=ok, ip=handler._client_ip())
    finally:
        conn.close()


def _status(handler):
    _json_send(handler, 200, deepgram_proxy.public_status())
    return True


def _settings(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    try:
        req = handler._read_json()
    except Exception:
        _json_send(handler, 400, {"ok": False, "error": "请求无效"})
        return True
    mode = str(req.get("mode") or "")
    if mode not in deepgram_proxy.MODES:
        _json_send(handler, 400, {"ok": False, "error": "未知语音模式"})
        return True
    try:
        deepgram_proxy.save_mode(mode)
    except OSError:
        _json_send(handler, 500, {"ok": False, "error": "模式没写进去"})
        return True
    _audit(db_fn, who, "voice_mode", mode, {"mode": mode}, True, handler)
    log_event("voice_mode", mode=mode, ok=True)
    _json_send(handler, 200, {"ok": True, "mode": mode})
    return True


def _secret(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    try:
        req = handler._read_json()
    except Exception:
        _json_send(handler, 400, {"ok": False, "error": "请求无效"})
        return True
    provider = str(req.get("provider") or "")
    if not deepgram_proxy.provider_by_id(provider):
        _json_send(handler, 400, {"ok": False, "error": "未知渠道"})
        return True
    raw = req.get("api_key")
    if not isinstance(raw, str):
        _json_send(handler, 400, {"ok": False, "error": "密钥格式不对"})
        return True
    try:
        deepgram_proxy.save_provider_secret(provider, raw.strip())
    except ValueError as err:
        _json_send(handler, 400, {"ok": False, "error": str(err)})
        return True
    except OSError:
        _json_send(handler, 500, {"ok": False, "error": "密钥没写进去（检查目录权限）"})
        return True
    _audit(db_fn, who, "voice_secret", provider, {"provider": provider, "configured": bool(raw.strip())}, True, handler)
    log_event("voice_secret", provider=provider, configured=bool(raw.strip()))
    _json_send(handler, 200, {"ok": True, "provider": provider, "configured": bool(raw.strip()) or bool(deepgram_proxy.provider_secret(provider)[0])})
    return True


def _speak(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    try:
        req = handler._read_json()
    except Exception:
        _json_send(handler, 400, {"ok": False, "error": "请求无效"})
        return True
    text = str(req.get("text") or "").strip()
    if not text:
        _json_send(handler, 400, {"ok": False, "error": "没有要朗读的文字"})
        return True
    key = deepgram_proxy.deepgram_key()
    chunks, info = deepgram_proxy.synthesize(text, key)
    if chunks is None:
        reason = info if info in ("unconfigured", "failed", "empty") else "failed"
        _json_send(handler, 200, {"ok": False, "skipped": True, "reason": reason})
        return True
    ctype = info or "audio/mpeg"
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Accel-Buffering", "no")
    for name, value in CORS:
        handler.send_header(name, value)
    handler.close_connection = True
    handler.end_headers()
    try:
        for part in chunks:
            if part:
                handler.wfile.write(part)
                handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    log_event("voice_speak", ok=True, chars=len(text))
    return True


def _partial(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    ctype = (handler.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if ctype not in ("audio/wav", "audio/x-wav", "audio/wave"):
        _json_send(handler, 415, {"ok": False, "error": "只接受 WAV"})
        return True
    data = _read_body(handler, PARTIAL_MAX)
    if data is None:
        _json_send(handler, 413, {"ok": False, "error": "这一小段太长"})
        return True
    if not data:
        _json_send(handler, 400, {"ok": False, "error": "没有收到录音"})
        return True
    dev = str(who.get("device_id") or who.get("device") or "owner")
    now = time.time()
    hits = [t for t in _PARTIAL_RATE.get(dev, []) if now - t < 60]
    if len(hits) >= 90:
        _PARTIAL_RATE[dev] = hits
        _json_send(handler, 429, {"ok": False, "error": "说得太频繁了，歇一下"})
        return True
    _PARTIAL_RATE[dev] = hits + [now]
    url = os.environ.get("SB_STT_URL", "http://127.0.0.1:18791/stt")
    try:
        req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "audio/wav"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            obj = json.loads(resp.read() or b"{}")
            code = resp.status
    except urllib.error.HTTPError as err:
        try:
            obj = json.loads(err.read() or b"{}")
        except Exception:
            obj = {"ok": False, "error": "识别失败"}
        code = err.code
    except (urllib.error.URLError, OSError, TimeoutError, ValueError):
        code, obj = 503, {"ok": False, "error": "语音识别服务没启动，请先用键盘输入"}
    if code >= 500 and code != 503:
        code = 502
    safe = {k: obj.get(k) for k in ("ok", "text", "seconds", "ms", "error") if k in obj}
    log_event("voice_partial", ok=bool(safe.get("ok")), chars=len(safe.get("text") or ""))
    _json_send(handler, code if code < 500 or code == 503 else 502, safe or {"ok": False, "error": "识别失败"})
    return True


def _live_open(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    sid, reason = deepgram_proxy.open_listen(deepgram_proxy.deepgram_key())
    if not sid:
        _json_send(handler, 200, {"ok": False, "skipped": True, "reason": reason or "failed"})
        return True
    log_event("voice_live_open", ok=True)
    _json_send(handler, 200, {"ok": True, "session": sid, "model": deepgram_proxy.LISTEN_MODEL, "language": deepgram_proxy.LISTEN_LANGUAGE})
    return True


def _live_audio(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    sid = _query(handler).get("session") or ""
    data = _read_body(handler, 64 * 1024)
    if data is None or not data:
        _json_send(handler, 400, {"ok": False, "error": "没有音频"})
        return True
    if not deepgram_proxy.session_audio(sid, data):
        _json_send(handler, 404, {"ok": False, "error": "会话已经结束"})
        return True
    _json_send(handler, 200, {"ok": True})
    return True


def _live_poll(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    q = _query(handler)
    try:
        cursor = int(q.get("cursor") or 0)
    except ValueError:
        cursor = 0
    _json_send(handler, 200, deepgram_proxy.session_poll(q.get("session") or "", cursor))
    return True


def _live_close(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    try:
        req = handler._read_json()
    except Exception:
        req = {}
    deepgram_proxy.session_close(str(req.get("session") or _query(handler).get("session") or ""))
    _json_send(handler, 200, {"ok": True})
    return True


def _grant(handler, db_fn, log_event):
    who = _require(handler, db_fn, log_event)
    if not who:
        return True
    result = deepgram_proxy.issue_grant(deepgram_proxy.deepgram_key())
    log_event("voice_grant", ok=bool(result.get("ok")))
    _json_send(handler, 200, result)
    return True


_GET = {
    "/api/voice/status": _status,
    "/api/owner/voice/live/poll": _live_poll,
}
_POST = {
    "/api/owner/voice/settings": _settings,
    "/api/owner/voice/secret": _secret,
    "/api/owner/voice/speak": _speak,
    "/api/owner/voice/partial": _partial,
    "/api/owner/voice/live/open": _live_open,
    "/api/owner/voice/live/audio": _live_audio,
    "/api/owner/voice/live/close": _live_close,
    "/api/owner/voice/grant": _grant,
}


def try_handle(handler, method, db_fn, log_event):
    path = _path(handler)
    table = _GET if method == "GET" else _POST if method == "POST" else None
    if not table or path not in table:
        return False
    return table[path](handler, db_fn, log_event) if path != "/api/voice/status" else _status(handler)
