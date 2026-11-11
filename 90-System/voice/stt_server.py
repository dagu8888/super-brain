#!/usr/bin/env python3
"""Super-Brain 语音转文字边车（Moonshine Voice · Mandarin Tiny Streaming，MIT）。

只监听 127.0.0.1，由主运行时 api_server 在校验 dagu-owner 身份后转发；本进程不做鉴权，
因此绝不能绑定到公网地址。

- 输入：16-bit PCM 单声道 WAV（浏览器端已用 Web Audio 采集并重采样，iOS 不依赖 MediaRecorder 格式）。
- 限制：≤ MAX_BYTES、≤ MAX_SECONDS；超限 413。
- 音频全程只在内存里：不写盘、不打日志，转写完立即释放。之后按保留规则清理音频目录（本服务不产生文件，
  调用只是兜底，确保「音频最多 10 条」对该目录始终成立）。
- 由 systemd 以 MemoryMax 限内存运行，OOM 只会杀掉本进程，不影响 super-brain 主进程。
"""
import array
import gc
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import audio_retention  # noqa: E402

BIND = "127.0.0.1"
PORT = int(os.environ.get("SB_STT_PORT", "18791"))
MODEL_DIR = os.environ.get("SB_STT_MODEL_DIR", "/opt/sb-voice/models/tiny-streaming-zh")
AUDIO_DIR = os.environ.get("SB_AUDIO_DIR", audio_retention.DEFAULT_DIR)
MAX_SECONDS = 30
MAX_BYTES = 48000 * 2 * MAX_SECONDS + 1024      # 48kHz 16-bit 单声道 30 秒的上限
MIN_SECONDS = 0.3

_lock = threading.Lock()
_model = {"t": None, "loaded_at": None}


def load_model():
    """加载 Mandarin Tiny Streaming。实测（moonshine-voice 0.1.6）：
    - transcribe_without_streaming 对同一段音频会出现不稳定结果，偶发「说说说说」式重复；
    - 每次请求新建一条 stream 走流式接口更稳，所以统一走流式；
    - 仍有少量随机偏差，故最多跑 3 遍做多数表决（每遍约 0.1–0.3 秒）。"""
    from moonshine_voice import ModelArch, Transcriber
    t0 = time.time()
    _model["t"] = Transcriber(model_path=MODEL_DIR, model_arch=ModelArch.TINY_STREAMING,
                              options={"max_tokens_per_second": "13.0"})
    _model["loaded_at"] = int(time.time())
    return round(time.time() - t0, 2)


def _once(samples, sr):
    st = _model["t"].create_stream()
    try:
        st.start()
        step = max(1, sr // 2)
        for i in range(0, len(samples), step):
            st.add_audio(samples[i:i + step], sr)
        tr = st.stop()
        return "".join((ln.text or "") for ln in tr.lines).strip()
    finally:
        st.close()


def looks_repetitive(text):
    """同一个字或短语连续重复 ≥4 次，视为解码打转。"""
    t = text.replace(",", "").replace("，", "").replace(" ", "")
    for n in (1, 2, 3, 4):
        for i in range(0, max(0, len(t) - n * 4) + 1):
            unit = t[i:i + n]
            if unit and unit * 4 == t[i:i + n * 4]:
                return True
    return False


def vote(samples, sr, runs=3):
    seen = []
    for _ in range(runs):
        txt = _once(samples, sr)
        seen.append(txt)
        if seen.count(txt) >= 2 and not looks_repetitive(txt):
            return txt
    good = [t for t in seen if t and not looks_repetitive(t)]
    pool = good or seen
    return max(pool, key=lambda t: (pool.count(t), -abs(len(t) - _median_len(pool))))


def _median_len(pool):
    ls = sorted(len(t) for t in pool)
    return ls[len(ls) // 2] if ls else 0


def decode_wav(data):
    """校验并解码 16-bit PCM WAV → (float 样本列表, 采样率, 秒数)。不合格抛 ValueError（人话）。"""
    if len(data) > MAX_BYTES:
        raise OverflowError("录音太长（最多 30 秒）")
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("不是 WAV 音频")
    try:
        with wave.open(io.BytesIO(data)) as w:
            ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if sw != 2 or ch not in (1, 2) or not 8000 <= sr <= 48000:
                raise ValueError("只接受 16-bit PCM、单/双声道、8–48kHz")
            raw = w.readframes(n)
    except wave.Error as e:
        raise ValueError(f"WAV 解析失败：{e}") from None
    secs = n / sr
    if secs > MAX_SECONDS:
        raise OverflowError("录音太长（最多 30 秒）")
    if secs < MIN_SECONDS:
        raise ValueError("录音太短，请按住说完再松手")
    pcm = array.array("h")
    pcm.frombytes(raw)
    if sys.byteorder != "little":
        pcm.byteswap()
    if ch == 2:
        samples = [(pcm[i] + pcm[i + 1]) / 65536.0 for i in range(0, len(pcm) - 1, 2)]
    else:
        samples = [s / 32768.0 for s in pcm]
    del raw, pcm
    return samples, sr, secs


def transcribe(data):
    samples, sr, secs = decode_wav(data)
    with _lock:                                    # 单路推理，2 核小机不并发
        t0 = time.time()
        text = vote(samples, sr)
        ms = int((time.time() - t0) * 1000)
    del samples
    gc.collect()
    return {"text": text, "seconds": round(secs, 2), "ms": ms}


def _rss_mb():
    try:
        for line in open("/proc/self/status"):
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "SB-STT/1.0"

    def log_message(self, *a):                    # 静默：不记任何请求内容
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"ok": _model["t"] is not None, "model": "moonshine tiny-streaming-zh",
                                    "rss_mb": _rss_mb(), "loaded_at": _model["loaded_at"]})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/stt":
            return self._send(404, {"ok": False, "error": "not found"})
        data = b""
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0:
                return self._send(400, {"ok": False, "error": "没有收到录音"})
            if n > MAX_BYTES:
                return self._send(413, {"ok": False, "error": "录音太长（最多 30 秒）"})
            data = self.rfile.read(n)
            res = transcribe(data)
            return self._send(200, dict(ok=True, **res))
        except OverflowError as e:
            return self._send(413, {"ok": False, "error": str(e)})
        except ValueError as e:
            return self._send(400, {"ok": False, "error": str(e)})
        except Exception as e:                      # 不回显内部细节以外的内容
            return self._send(500, {"ok": False, "error": f"识别引擎出错：{type(e).__name__}"})
        finally:
            data = b""
            try:
                audio_retention.prune(AUDIO_DIR)
            except Exception:
                pass


def main():
    secs = load_model()
    print(f"sb-stt ready model={MODEL_DIR} load={secs}s rss={_rss_mb()}MB", flush=True)
    HTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
