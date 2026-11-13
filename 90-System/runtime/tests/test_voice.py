#!/usr/bin/env python3
# 按住说话（Moonshine 服务器识别）+ 音频只留最近 10 条。
# 用法：python3 90-System/runtime/tests/test_voice.py
# 可选真模型测试：SB_STT_MODEL_DIR=<模型目录> SB_STT_TEST_WAV=<中文 wav> 用装了 moonshine-voice 的 python 跑。
import io
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
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
ROOT = RT.parents[1]
VOICE = ROOT / "90-System" / "voice"
sys.path.insert(0, str(RT))
sys.path.insert(0, str(VOICE))
import audio_retention  # noqa: E402
import message_bus  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import stt_server  # noqa: E402

FAILS = []
TMP = Path(tempfile.mkdtemp(prefix="sb-voice-"))


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))
    if not cond:
        FAILS.append(name)


def wav_bytes(seconds=1.0, rate=16000, channels=1):
    n = int(seconds * rate)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x01" * n * channels)
    return b.getvalue()


def test_retention_keeps_latest_10():
    d = TMP / "audio"
    d.mkdir()
    now = time.time()
    for i in range(12):                                   # 生成 12 条，越往后越新
        p = d / f"rec-{i:02d}.wav" if i % 2 else d / f"tts-{i:02d}.mp3"
        p.write_bytes(b"x")
        os.utime(p, (now - 1000 + i, now - 1000 + i))
    (d / "model.ort").write_bytes(b"m")                 # 非音频：不动
    (d / "app.wasm").write_bytes(b"w")
    os.utime(d / "model.ort", (now - 5000, now - 5000))
    sub = d / "sub"
    sub.mkdir()
    (sub / "old.wav").write_bytes(b"x")                   # 子目录：不递归
    os.utime(sub / "old.wav", (now - 9000, now - 9000))
    outside = TMP / "outside.wav"
    outside.write_bytes(b"o")
    os.utime(outside, (now - 9999, now - 9999))
    (d / "link.wav").symlink_to(outside)                   # 符号链接：不跟随、不删
    gone = audio_retention.prune(str(d), keep=10)
    left = sorted(p.name for p in d.iterdir() if p.is_file() and not p.is_symlink()
                  and p.suffix in audio_retention.AUDIO_EXTS)
    check("生成 12 条后只剩 10 条", len(left) == 10, left)
    check("删掉的是最旧的 2 条", sorted(gone) == ["tts-00.mp3", "rec-01.wav"][::-1] or set(gone) == {"tts-00.mp3", "rec-01.wav"}, gone)
    check("留下的是最新 10 条", set(left) == {(f"rec-{i:02d}.wav" if i % 2 else f"tts-{i:02d}.mp3") for i in range(2, 12)})
    check("模型/WASM 文件不动", (d / "model.ort").exists() and (d / "app.wasm").exists())
    check("子目录不递归", (sub / "old.wav").exists())
    check("符号链接与目录外文件不动", (d / "link.wav").is_symlink() and outside.exists())
    for i in range(12, 15):                                # 再来 3 条，立即清理仍是 10 条
        p = d / f"rec-{i:02d}.wav"
        p.write_bytes(b"x")
        os.utime(p, (now - 1000 + i, now - 1000 + i))
        audio_retention.prune(str(d), keep=10)
    check("每次新生成后清理到 10 条", len(audio_retention.audio_files(str(d))) == 10)
    r = subprocess.run([sys.executable, str(VOICE / "audio_retention.py"), str(d), "--keep", "10"],
                       capture_output=True, text=True)
    check("命令行（定时兜底）可运行", r.returncode == 0 and "保留最近 10 条" in r.stdout, r.stdout + r.stderr)
    for bad in ("/", "/root", "/tmp", "relative/dir"):
        try:
            audio_retention.prune(bad, keep=10)
            ok = False
        except ValueError:
            ok = True
        check(f"拒绝清理危险/相对目录 {bad}", ok)
    check("目录不存在时什么也不做", audio_retention.prune(str(TMP / "nope")) == [])


def test_decode_wav():
    s, sr, secs = stt_server.decode_wav(wav_bytes(1.0))
    check("16k 单声道 WAV 解码", sr == 16000 and len(s) == 16000 and abs(secs - 1.0) < 1e-6)
    s, sr, _ = stt_server.decode_wav(wav_bytes(1.0, 44100, 2))
    check("44.1k 双声道下混为单声道", sr == 44100 and len(s) == 44100)
    for name, data, exc in (("太短被拒", wav_bytes(0.1), ValueError),
                            ("超过 30 秒被拒", wav_bytes(31, 16000), OverflowError),
                            ("非 WAV 被拒", b"ftypM4A " + b"0" * 100, ValueError)):
        try:
            stt_server.decode_wav(data)
            ok = False
        except exc:
            ok = True
        check(name, ok)


class FakeStt(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(n)
        FakeStt.seen.append(len(data))
        body = json.dumps({"ok": True, "text": "幕僚长你好", "seconds": 1.0, "ms": 5}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def post(url, data, headers):
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_api_stt():
    d = TMP / "api"
    d.mkdir()
    conn = sqlite3.connect(str(d / "state.db"))
    migrate_v2.migrate(conn)
    message_bus.ensure_schema(conn)
    owner_ops.ensure_schema(conn)
    code, _ = owner_ops.create_pair_code(conn)
    tok = owner_ops.pair(conn, code, "测试 iPhone")["token"]
    conn.commit()
    conn.close()
    tf = d / "tokens.json"
    tf.write_text(json.dumps({"tokens": {"grok-chief": "chief-voice-test"}, "owner": {}}))
    sp = free_port()
    fake = HTTPServer(("127.0.0.1", sp), FakeStt)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    port = free_port()
    env = dict(os.environ, SB_STT_URL=f"http://127.0.0.1:{sp}/stt")
    proc = subprocess.Popen([sys.executable, str(RT / "tests" / "fixture_server.py"), str(d / "state.db"), str(tf), str(port)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    try:
        proc.stdout.readline()
        url = f"http://127.0.0.1:{port}/api/owner/stt"
        w = wav_bytes(1.0)
        c, j = post(url, w, {"Content-Type": "audio/wav"})
        check("未授权 401", c == 401 and j.get("need_unlock"), (c, j))
        c, j = post(url, w, {"Content-Type": "audio/wav", "Authorization": "Bearer chief-voice-test"})
        check("Agent 口令不能用语音接口", c == 401, c)
        c, j = post(url, w, {"Content-Type": "audio/mp4", "Authorization": "Bearer " + tok})
        check("非 WAV 415", c == 415, (c, j))
        import http.client
        hc = http.client.HTTPConnection("127.0.0.1", port, timeout=10)   # 只发头：服务端不读超长正文
        hc.putrequest("POST", "/api/owner/stt")
        for k, v in (("Content-Type", "audio/wav"), ("Authorization", "Bearer " + tok),
                     ("Content-Length", str(48000 * 2 * 31))):
            hc.putheader(k, v)
        hc.endheaders()
        r = hc.getresponse()
        check("超长 413（不读正文）", r.status == 413, r.status)
        hc.close()
        c, j = post(url, w, {"Content-Type": "audio/wav", "Authorization": "Bearer " + tok})
        check("已授权设备拿到识别文本", c == 200 and j.get("text") == "幕僚长你好", (c, j))
        check("音频原样转给本机边车", FakeStt.seen and FakeStt.seen[-1] == len(w))
        fake.shutdown()
        fake.server_close()
        c, j = post(url, w, {"Content-Type": "audio/wav", "Authorization": "Bearer " + tok})
        check("边车没起时 503 + 人话", c == 503 and "键盘" in j.get("error", ""), (c, j))
    finally:
        proc.terminate()
        proc.wait(5)
    check("测试目录里没有落盘的音频", not any(p.suffix in audio_retention.AUDIO_EXTS for p in d.rglob("*")))


def test_frontend():
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    check("不再依赖 Web Speech 识别", "webkitSpeechRecognition" not in js and "SpeechRecognition" not in js)
    check("不再 toast ev.error", "语音识别出错" not in js)
    a = js.index("async function micStart"); b = js.index("function micCleanup")
    start = js[a:b]
    check("AudioContext 在手势里同步创建", start.index("new AC()") < start.index("await "))
    check("getUserMedia 在按下时请求", "getUserMedia" in start)
    s2 = js[js.index("async function micStop"):js.index("function encodeWav16k")]
    check("识别结果只放进输入框，不自动发送", "sendChat" not in s2 and "#chat-input" in s2)
    check("页面不把录音存进 Cache/IndexedDB", "indexedDB" not in js and "caches.open" not in js)
    check("有明确的录音/识别状态", "录音中" in js and "识别中" in js and 'id="mic-status"' in html)
    check("权限被拒说人话", "设置 › Safari › 麦克风" in js and "地址栏" in js and "实时通话" in js)


def test_real_model():
    md, wav = os.environ.get("SB_STT_MODEL_DIR"), os.environ.get("SB_STT_TEST_WAV")
    if not (md and wav):
        print("SKIP 真模型测试（未设 SB_STT_MODEL_DIR / SB_STT_TEST_WAV）")
        return
    stt_server.MODEL_DIR = md
    stt_server.load_model()
    r = stt_server.transcribe(Path(wav).read_bytes())
    print("识别文本：" + r["text"], r)
    check("真模型识别出中文", any("\u4e00" <= ch <= "\u9fff" for ch in r["text"]), r)


if __name__ == "__main__":
    test_retention_keeps_latest_10()
    test_decode_wav()
    test_api_stt()
    test_frontend()
    test_real_model()
    print("FAILED: %s" % FAILS if FAILS else "ALL PASS")
    sys.exit(1 if FAILS else 0)
