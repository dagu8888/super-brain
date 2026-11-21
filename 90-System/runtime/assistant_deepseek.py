#!/usr/bin/env python3
"""官方 DeepSeek 流式适配器。

只连接 https://api.deepseek.com/chat/completions。
模型只接受 deepseek-flash。stream 固定为 true，thinking 固定为 disabled。
密钥只从 SB_DEEPSEEK_API_KEY 读取，不进日志、响应或仓库。
不跟随跳转，不做跨供应商回退，余额不足后停止，不自动充值、不循环重试。
"""
import json
import os
import threading
import urllib.request

OFFICIAL_ORIGIN = "https://api.deepseek.com"
OFFICIAL_URL = OFFICIAL_ORIGIN + "/chat/completions"
OFFICIAL_MODEL = "deepseek-flash"
KEY_ENV = "SB_DEEPSEEK_API_KEY"

_GATE = threading.BoundedSemaphore(2)
_STATE = {"balance_blocked": False}
_STATE_LOCK = threading.Lock()


def reset_for_tests():
    with _STATE_LOCK:
        _STATE["balance_blocked"] = False


def balance_blocked():
    with _STATE_LOCK:
        return bool(_STATE["balance_blocked"])


def _block_balance():
    with _STATE_LOCK:
        _STATE["balance_blocked"] = True


def load_key():
    return os.environ.get(KEY_ENV, "").strip()


def redact(text, key=None):
    raw = str(text or "")
    secret = key if key is not None else load_key()
    if secret and secret in raw:
        raw = raw.replace(secret, "[redacted]")
    return raw


def resolve_base(raw):
    text = str(raw or "").strip().rstrip("/")
    if not text:
        return "ok", OFFICIAL_ORIGIN
    if text != OFFICIAL_ORIGIN:
        return "reject-base", ""
    return "ok", OFFICIAL_ORIGIN


def resolve_model(raw):
    text = str(raw or "").strip()
    if not text:
        return "ok", OFFICIAL_MODEL
    if text != OFFICIAL_MODEL:
        return "reject-model", ""
    return "ok", OFFICIAL_MODEL


def _clamp(name, default, lo, hi, cast):
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = cast(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def limits_from_env():
    return {
        "timeout_s": _clamp("SB_ASSISTANT_TIMEOUT_S", 20.0, 1.0, 45.0, float),
        "max_tokens": int(_clamp("SB_ASSISTANT_MAX_TOKENS", 512, 16, 1024, float)),
        "max_chars": int(_clamp("SB_ASSISTANT_MAX_CHARS", 800, 40, 2000, float)),
    }


def configured():
    base, _origin = resolve_base(os.environ.get("SB_ASSISTANT_BASE_URL"))
    model, _name = resolve_model(os.environ.get("SB_ASSISTANT_MODEL"))
    return bool(load_key()) and base == "ok" and model == "ok" and not balance_blocked()


def public_view():
    base_code, origin = resolve_base(os.environ.get("SB_ASSISTANT_BASE_URL"))
    model_code, model = resolve_model(os.environ.get("SB_ASSISTANT_MODEL"))
    ready = configured()
    if balance_blocked():
        reason = "官方 DeepSeek 返回余额不足，已停止。不会自动充值，也不会改用模拟回答。"
    elif not load_key():
        reason = "服务器未配置 SB_DEEPSEEK_API_KEY。不会用模拟回答代替。"
    elif base_code != "ok":
        reason = "SB_ASSISTANT_BASE_URL 不是 https://api.deepseek.com，已拒绝。"
    elif model_code != "ok":
        reason = "SB_ASSISTANT_MODEL 不是 deepseek-flash，已拒绝。"
    else:
        reason = ""
    return {
        "ok": True,
        "mock": False,
        "fallback": "none",
        "adapter": "official-deepseek",
        "mode": "deepseek" if ready else "unconfigured",
        "configured": ready,
        "probed": False,
        "model_id": model if model_code == "ok" else "",
        "base_url": origin if base_code == "ok" else "",
        "stream": True,
        "thinking": "disabled",
        "balance_blocked": balance_blocked(),
        "live_listen": False,
        "price": None,
        "label": "deepseek-flash" if ready else "未接通",
        "reason": reason,
    }


def build_payload(messages, max_tokens):
    return {
        "model": OFFICIAL_MODEL,
        "messages": messages,
        "stream": True,
        "thinking": {"type": "disabled"},
        "max_tokens": int(max_tokens),
    }


class _NoRedirect(urllib.request.HTTPErrorProcessor):
    def http_response(self, request, response):
        return response

    https_response = http_response


def default_opener():
    return urllib.request.build_opener(_NoRedirect())


class SseParser:
    """把可能被网络拆开的 SSE 字节拼回事件。只取出可见 content。"""

    def __init__(self):
        self.buf = bytearray()
        self.finish = ""

    def feed(self, chunk):
        if chunk:
            self.buf.extend(chunk)
        out = []
        while True:
            sep, width = self._sep()
            if sep < 0:
                break
            block = bytes(self.buf[:sep]).decode("utf-8", "replace")
            del self.buf[:sep + width]
            out.extend(self._block(block))
        return out

    def _sep(self):
        a = self.buf.find(b"\n\n")
        b = self.buf.find(b"\r\n\r\n")
        if a < 0 and b < 0:
            return -1, 0
        if a < 0 or (b >= 0 and b < a):
            return b, 4
        return a, 2

    def _block(self, block):
        data = ""
        for line in block.splitlines():
            if line.startswith("data:"):
                data += line[5:].strip()
        if not data:
            return []
        if data == "[DONE]":
            return [{"type": "done", "finish": self.finish or "stop"}]
        try:
            obj = json.loads(data)
        except ValueError:
            return [{"type": "error", "code": "bad-sse", "message": "官方流不是完整的 JSON，已停止。没有改用模拟回答。"}]
        if isinstance(obj, dict) and obj.get("error"):
            return [_error_obj(obj)]
        choices = obj.get("choices") if isinstance(obj, dict) else None
        if not choices:
            return []
        choice = choices[0] or {}
        finish = choice.get("finish_reason") or ""
        if finish:
            self.finish = finish
        delta = choice.get("delta") or {}
        text = delta.get("content")
        if not isinstance(text, str) or text == "":
            return []
        return [{"type": "delta", "text": text}]


def _error_obj(obj):
    err = obj.get("error") or {}
    message = err.get("message") if isinstance(err, dict) else str(err)
    return _status_error(402 if _is_balance(message) else 400, message)


def _is_balance(message):
    text = str(message or "").lower()
    return "insufficient" in text or "balance" in text or "quota" in text


def _status_error(status, message):
    if status == 402 or _is_balance(message):
        _block_balance()
        return {"type": "error", "code": "insufficient_balance", "message": "官方 DeepSeek 余额不足，已停止。不会自动充值，也不会改用模拟回答。"}
    if status in (301, 302, 303, 307, 308):
        return {"type": "error", "code": "redirect_rejected", "message": "官方接口返回了跳转，已拒绝，没有跟随。"}
    if status == 401:
        return {"type": "error", "code": "upstream_auth", "message": "官方 DeepSeek 拒绝了服务器密钥。没有改用模拟回答。"}
    if status == 429:
        return {"type": "error", "code": "rate_limit", "message": "官方 DeepSeek 限流，这一轮已停止。不会在后台重试。"}
    return {"type": "error", "code": "upstream", "message": "官方 DeepSeek 没有完成这一轮。没有改用模拟回答。"}


def stream_events(messages, cancel, timeout_s=None, max_tokens=None, opener=None):
    key = load_key()
    base_code, _origin = resolve_base(os.environ.get("SB_ASSISTANT_BASE_URL"))
    model_code, _model = resolve_model(os.environ.get("SB_ASSISTANT_MODEL"))
    if not key or base_code != "ok" or model_code != "ok":
        code = "not_configured"
        if base_code != "ok":
            code = "reject-base"
        elif model_code != "ok":
            code = "reject-model"
        view = public_view()
        yield {"type": "error", "code": code, "message": view["reason"] or "未接通官方 DeepSeek。不会用模拟回答代替。"}
        return
    if balance_blocked():
        yield {"type": "error", "code": "insufficient_balance", "message": public_view()["reason"]}
        return
    if not _GATE.acquire(blocking=False):
        yield {"type": "error", "code": "busy", "message": "已有对话在进行，这一轮没有向官方接口发出。"}
        return
    limits = limits_from_env()
    timeout = limits["timeout_s"] if timeout_s is None else min(float(timeout_s), limits["timeout_s"])
    tokens = limits["max_tokens"] if max_tokens is None else min(int(max_tokens), limits["max_tokens"])
    payload = build_payload(messages, tokens)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(OFFICIAL_URL, data=body, method="POST")
    req.add_header("Authorization", "Bearer " + key)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")
    open_fn = opener or default_opener().open
    resp = None
    try:
        try:
            resp = open_fn(req, timeout=timeout)
        except Exception:
            yield {"type": "error", "code": "upstream", "message": "官方接口没有连上。没有改用模拟回答。"}
            return
        status = getattr(resp, "status", None)
        if status is None:
            status = resp.getcode()
        if status != 200:
            raw = ""
            try:
                raw = resp.read().decode("utf-8", "replace")
            except Exception:
                raw = ""
            yield _status_error(status, redact(raw, key))
            return
        parser = SseParser()
        while not cancel.is_set():
            try:
                chunk = resp.read(128)
            except Exception:
                yield {"type": "error", "code": "upstream", "message": "官方流中断。没有改用模拟回答。"}
                return
            if not chunk:
                break
            for piece in parser.feed(chunk):
                yield piece
                if piece.get("type") == "error":
                    return
                if piece.get("type") == "done":
                    return
        if cancel.is_set():
            yield {"type": "cancelled"}
    finally:
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        _GATE.release()
