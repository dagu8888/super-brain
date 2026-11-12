#!/usr/bin/env python3
"""Deepgram 运行时代理。浏览器只跟本进程说话，永久密钥不出这个模块的返回值。

- 转写：Nova-3，language=zh，wss://api.deepgram.com/v1/listen
- 朗读：Flux TTS /v2/speak，model=flux-wenjing-zh，version v2
- 不调用 Deepgram Voice Agent，也不把 think/LLM 接到第三方人格。
- 只允许 https/wss 的 api.deepgram.com。
"""
import json
import os
import ssl
import struct
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlparse

SPEAK_VERSION = "v2"
TTS_MODEL = "flux-wenjing-zh"
TTS_NAME = "文静"
LISTEN_MODEL = "nova-3"
LISTEN_LANGUAGE = "zh"
API_HOST = "api.deepgram.com"
WELCOME_TEXT = "大古，欢迎回来"
WELCOME_FILE = "v2/audio/welcome-dagu-wenjing.mp3"
CHIEF_ID = "grok-chief"
MODES = ("hold", "stream", "live")

PROVIDERS = (
    {"id": "deepgram", "label": "Deepgram", "env": "DEEPGRAM_API_KEY", "file": "deepgram.env", "wired": True,
     "note": "本次接入：Nova-3 转写 + 文静朗读"},
    {"id": "gemini_live", "label": "Gemini Live", "env": "GEMINI_LIVE_API_KEY", "file": "gemini-live.env", "wired": False,
     "note": "已预留，尚未接入通话"},
    {"id": "elevenlabs", "label": "ElevenLabs", "env": "ELEVENLABS_API_KEY", "file": "elevenlabs.env", "wired": False,
     "note": "已预留，尚未接入通话"},
    {"id": "bailian", "label": "阿里云百炼", "env": "DASHSCOPE_API_KEY", "file": "bailian.env", "wired": False,
     "note": "已预留，尚未接入通话"},
)

_hooks = {"transport": None, "ws": None}
_sessions = {}
_sessions_lock = threading.Lock()


def secret_dir():
    return Path(os.environ.get("SB_VOICE_SECRET_DIR") or "/root/provision")


def state_path():
    override = os.environ.get("SB_VOICE_STATE_FILE")
    if override:
        return Path(override)
    return secret_dir() / "voice-settings.json"


def assert_https_deepgram(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() != API_HOST:
        raise ValueError("只允许 HTTPS 访问 api.deepgram.com")


def assert_wss_deepgram(url):
    parsed = urlparse(url)
    if parsed.scheme != "wss" or (parsed.hostname or "").lower() != API_HOST:
        raise ValueError("只允许 WSS 访问 api.deepgram.com")


def _read_env_file(path, name):
    path = Path(path)
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def _write_env_file(path, name, value):
    path = Path(path)
    value = str(value or "")
    if "\n" in value or "\r" in value or len(value) > 512:
        raise ValueError("密钥格式不对")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    if not value:
        if path.exists():
            path.unlink()
        return
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("# local only, mode 600\n%s=%s\n" % (name, value))
    os.chmod(path, 0o600)


def provider_by_id(provider_id):
    for item in PROVIDERS:
        if item["id"] == provider_id:
            return item
    return None


def provider_secret(provider_id):
    item = provider_by_id(provider_id)
    if not item:
        return "", None
    env_val = (os.environ.get(item["env"]) or "").strip()
    if env_val:
        return env_val, "env"
    file_val = _read_env_file(secret_dir() / item["file"], item["env"])
    if file_val:
        return file_val, "file"
    return "", None


def deepgram_key():
    return provider_secret("deepgram")[0]


def save_provider_secret(provider_id, value):
    item = provider_by_id(provider_id)
    if not item:
        raise ValueError("未知渠道")
    _write_env_file(secret_dir() / item["file"], item["env"], value)


def provider_public():
    out = []
    for item in PROVIDERS:
        _secret, source = provider_secret(item["id"])
        out.append({
            "id": item["id"],
            "label": item["label"],
            "configured": bool(_secret),
            "source": source,
            "wired": item["wired"],
            "note": item["note"],
        })
    return out


def load_mode():
    path = state_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "hold"
    mode = str((data or {}).get("mode") or "hold")
    return mode if mode in MODES else "hold"


def save_mode(mode):
    if mode not in MODES:
        raise ValueError("未知语音模式")
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"mode": mode}, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return mode


def public_status():
    providers = provider_public()
    deepgram = next(item for item in providers if item["id"] == "deepgram")
    return {
        "ok": True,
        "version": "2.8.0",
        "mode": load_mode(),
        "voice": {
            "model": TTS_MODEL,
            "name": TTS_NAME,
            "version": SPEAK_VERSION,
            "language": LISTEN_LANGUAGE,
        },
        "welcome": {
            "text": WELCOME_TEXT,
            "source": "static",
            "file": WELCOME_FILE,
        },
        "local_tts": False,
        "stream_tts_fallback": "deepgram-wenjing",
        "stream_tts_note": "本机没有现成的本地 TTS（不安装 ZipVoice / Kokoro）。流式朗读用 Deepgram 文静；没配密钥时改用浏览器语音。",
        "chief": CHIEF_ID,
        "listen": {"model": LISTEN_MODEL, "language": LISTEN_LANGUAGE, "version": "v1"},
        "providers": providers,
        "deepgram": deepgram["configured"],
    }


def speak_url(model=TTS_MODEL):
    return "https://%s/%s/speak?%s" % (API_HOST, SPEAK_VERSION, urlencode({"model": model, "encoding": "mp3"}))


def listen_url():
    return "wss://%s/v1/listen?%s" % (API_HOST, urlencode({
        "model": LISTEN_MODEL,
        "language": LISTEN_LANGUAGE,
        "encoding": "linear16",
        "sample_rate": "16000",
        "channels": "1",
        "interim_results": "true",
        "punctuate": "true",
        "smart_format": "true",
    }))


def flux_ws_url():
    return "wss://%s/%s/speak?%s" % (API_HOST, SPEAK_VERSION, urlencode({
        "model": TTS_MODEL,
        "encoding": "linear16",
        "sample_rate": "24000",
    }))


def auth_header(key):
    return "Token " + key


def https_transport(method, url, headers, body, timeout=25):
    assert_https_deepgram(url)
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k: v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, {k: v for k, v in (err.headers.items() if err.headers else [])}, err.read()


def active_transport():
    return _hooks["transport"] or https_transport


def set_test_hooks(transport=None, ws=None):
    _hooks["transport"] = transport
    _hooks["ws"] = ws


def _batch_speak(text, key, model=TTS_MODEL):
    url = speak_url(model)
    status, headers, body = active_transport()("POST", url, {
        "Authorization": auth_header(key),
        "Content-Type": "application/json",
    }, {"text": text})
    ctype = (headers.get("Content-Type") or headers.get("content-type") or "")
    if status != 200 or not body or "json" in ctype.lower() or body[:1] in (b"{", b"["):
        return None, ""
    return body, (ctype.split(";")[0].strip() or "audio/mpeg")


def wav_header(rate, nbytes):
    data_len = int(nbytes)
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_len, b"WAVE", b"fmt ", 16,
        1, 1, rate, rate * 2, 2, 16, b"data", data_len)


def _ws_connect(url, headers):
    hook = _hooks["ws"]
    if hook is not None:
        return hook(url, headers)
    if _hooks["transport"] is not None:
        return None
    return connect_wss(url, headers)


def iter_flux_wav(text, key):
    """Yield a streaming WAV (header then linear16) from Flux /v2/speak. Raises if the socket cannot be used."""
    url = flux_ws_url()
    assert_wss_deepgram(url)
    ws = _ws_connect(url, {"Authorization": auth_header(key)})
    if ws is None:
        raise OSError("no websocket")
    try:
        ws.send_text(json.dumps({"type": "Speak", "text": text}))
        ws.send_text(json.dumps({"type": "Flush"}))
        yield wav_header(24000, 0x7FFFFFF0)
        while True:
            kind, payload = ws.recv_event(timeout=20)
            if kind == "bin" and payload:
                yield payload
            elif kind == "text":
                try:
                    msg = json.loads(payload)
                except ValueError:
                    msg = {}
                if msg.get("type") in ("SpeechMetadata", "Error"):
                    break
            else:
                break
        try:
            ws.send_text(json.dumps({"type": "Close"}))
        except Exception:
            pass
    finally:
        try:
            ws.close()
        except Exception:
            pass


def synthesize(text, key):
    """返回 (chunks, content_type) 或 (None, reason)。chunks 是字节迭代，可能只有一段。"""
    text = str(text or "").strip()
    if not text:
        return None, "empty"
    if not key:
        return None, "unconfigured"
    try:
        iterator = iter_flux_wav(text[:500], key)
        first = next(iterator)

        def chain():
            yield first
            for part in iterator:
                yield part

        return chain(), "audio/wav"
    except Exception:
        audio, ctype = _batch_speak(text[:500], key)
        if not audio:
            return None, "failed"
        return [audio], ctype or "audio/mpeg"


def issue_grant(key, ttl=30):
    """只返回短时 access_token。永久密钥即使被上游回显也不往外带。"""
    if not key:
        return {"ok": False, "skipped": True, "reason": "unconfigured"}
    ttl = max(1, min(int(ttl or 30), 60))
    status, _headers, body = active_transport()("POST", "https://%s/v1/auth/grant" % API_HOST, {
        "Authorization": auth_header(key),
        "Content-Type": "application/json",
    }, {"ttl_seconds": ttl})
    if status != 200:
        return {"ok": False, "error": "短时令牌没签发"}
    try:
        obj = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError):
        return {"ok": False, "error": "短时令牌没签发"}
    token = str(obj.get("access_token") or "")
    if not token or token == key:
        return {"ok": False, "error": "短时令牌没签发"}
    try:
        expires = int(obj.get("expires_in") or ttl)
    except (TypeError, ValueError):
        expires = ttl
    return {"ok": True, "access_token": token, "expires_in": expires}


def parse_listen_message(obj):
    if not isinstance(obj, dict):
        return None
    if obj.get("type") == "UtteranceEnd":
        return {"kind": "end"}
    channel = obj.get("channel") or {}
    alts = channel.get("alternatives") or []
    text = ""
    if alts and isinstance(alts[0], dict):
        text = str(alts[0].get("transcript") or "").strip()
    if not text:
        return None
    final = bool(obj.get("speech_final") or obj.get("is_final"))
    return {"kind": "final" if final else "partial", "text": text, "speech_final": bool(obj.get("speech_final"))}


class ListenSession:
    def __init__(self, ws):
        self.ws = ws
        self.events = []
        self.lock = threading.Lock()
        self.closed = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while not self.closed:
                kind, payload = self.ws.recv_event(timeout=15)
                if kind != "text":
                    if kind == "close":
                        break
                    continue
                try:
                    msg = json.loads(payload)
                except ValueError:
                    continue
                ev = parse_listen_message(msg)
                if ev:
                    with self.lock:
                        self.events.append(ev)
        except Exception:
            pass
        finally:
            self.closed = True

    def push_pcm(self, pcm):
        self.ws.send_bin(pcm)

    def poll(self, since):
        with self.lock:
            since = max(0, int(since or 0))
            chunk = self.events[since:]
            cursor = len(self.events)
        return {"ok": True, "events": chunk, "cursor": cursor, "closed": self.closed}

    def close(self):
        self.closed = True
        try:
            self.ws.send_text('{"type":"CloseStream"}')
        except Exception:
            pass
        try:
            self.ws.close()
        except Exception:
            pass


def open_listen(key):
    if not key:
        return None, "unconfigured"
    url = listen_url()
    assert_wss_deepgram(url)
    ws = _ws_connect(url, {"Authorization": auth_header(key)})
    if ws is None:
        return None, "failed"
    import secrets
    sid = secrets.token_urlsafe(12)
    sess = ListenSession(ws)
    now = time.time()
    with _sessions_lock:
        stale = [k for k, rec in _sessions.items() if now - rec["t"] > 180]
        for key_id in stale:
            try:
                _sessions[key_id]["s"].close()
            except Exception:
                pass
            _sessions.pop(key_id, None)
        if len(_sessions) >= 4:
            oldest = min(_sessions, key=lambda k: _sessions[k]["t"])
            try:
                _sessions[oldest]["s"].close()
            except Exception:
                pass
            _sessions.pop(oldest, None)
        _sessions[sid] = {"s": sess, "t": now}
    return sid, None


def session_poll(sid, cursor):
    with _sessions_lock:
        rec = _sessions.get(sid)
    if not rec:
        return {"ok": False, "error": "会话已经结束"}
    rec["t"] = time.time()
    return rec["s"].poll(cursor)


def session_audio(sid, pcm):
    with _sessions_lock:
        rec = _sessions.get(sid)
    if not rec:
        return False
    if not pcm or len(pcm) > 64 * 1024:
        return False
    rec["t"] = time.time()
    rec["s"].push_pcm(pcm)
    return True


def session_close(sid):
    with _sessions_lock:
        rec = _sessions.pop(sid, None)
    if rec:
        rec["s"].close()
    return True


def encode_frame(opcode, payload, mask=True):
    payload = payload if isinstance(payload, (bytes, bytearray)) else payload.encode("utf-8")
    first = 0x80 | (opcode & 0x0F)
    length = len(payload)
    mask_bit = 0x80 if mask else 0
    if length < 126:
        header = bytes((first, mask_bit | length))
    elif length < 65536:
        header = bytes((first, mask_bit | 126)) + struct.pack("!H", length)
    else:
        header = bytes((first, mask_bit | 127)) + struct.pack("!Q", length)
    if not mask:
        return header + payload
    mask_key = os.urandom(4)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return header + mask_key + masked


def decode_frames(buffer):
    """从缓冲区拆出完整帧，返回 (frames, rest)。frame 是 (opcode, payload)。"""
    frames = []
    data = buffer
    while True:
        if len(data) < 2:
            break
        first, second = data[0], data[1]
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        offset = 2
        if length == 126:
            if len(data) < 4:
                break
            length = struct.unpack("!H", data[2:4])[0]
            offset = 4
        elif length == 127:
            if len(data) < 10:
                break
            length = struct.unpack("!Q", data[2:10])[0]
            offset = 10
        extra = 4 if masked else 0
        if len(data) < offset + extra + length:
            break
        payload = data[offset + extra:offset + extra + length]
        if masked:
            mask_key = data[offset:offset + 4]
            payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        frames.append((opcode, payload))
        data = data[offset + extra + length:]
    return frames, data


class SocketWebSocket:
    def __init__(self, sock, leftover=b""):
        self.sock = sock
        self.buf = leftover
        self.lock = threading.Lock()

    def send_text(self, text):
        self._send(1, text.encode("utf-8"))

    def send_bin(self, payload):
        self._send(2, payload)

    def _send(self, opcode, payload):
        with self.lock:
            self.sock.sendall(encode_frame(opcode, payload, mask=True))

    def recv_event(self, timeout=15):
        self.sock.settimeout(timeout)
        while True:
            frames, self.buf = decode_frames(self.buf)
            for opcode, payload in frames:
                if opcode == 9:
                    try:
                        self._send(10, payload)
                    except Exception:
                        pass
                    continue
                if opcode == 8:
                    return "close", payload
                if opcode == 1:
                    return "text", payload.decode("utf-8", "replace")
                if opcode == 2:
                    return "bin", payload
            chunk = self.sock.recv(65536)
            if not chunk:
                return "close", b""
            self.buf += chunk

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def connect_wss(url, headers, timeout=12):
    assert_wss_deepgram(url)
    parsed = urlparse(url)
    host = parsed.hostname
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    raw = __import__("socket").create_connection((host, port), timeout=timeout)
    context = ssl.create_default_context()
    sock = context.wrap_socket(raw, server_hostname=host)
    import base64
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    lines = [
        "GET %s HTTP/1.1" % path,
        "Host: %s" % host,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: %s" % key,
        "Sec-WebSocket-Version: 13",
    ]
    for name, value in (headers or {}).items():
        lines.append("%s: %s" % (name, value))
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        piece = sock.recv(4096)
        if not piece:
            sock.close()
            raise OSError("websocket handshake failed")
        buf += piece
        if len(buf) > 65536:
            sock.close()
            raise OSError("websocket handshake too large")
    head, rest = buf.split(b"\r\n\r\n", 1)
    status = head.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        sock.close()
        raise OSError("websocket upgrade rejected")
    return SocketWebSocket(sock, rest)
