#!/usr/bin/env python3
# 操作台 2.8.0：语音模式、Deepgram 代理不泄密钥、欢迎语顺序、项目名字圈、知识宇宙八级。
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
VOICE = ROOT / "90-System" / "voice"
TMP = Path(tempfile.mkdtemp(prefix="sb-voice280-"))
SECRET = "unit-test-not-a-real-key"
os.environ["SB_OWNER_UNLOCK_PHRASE"] = "语音测试口令"
os.environ["SB_VOICE_SECRET_DIR"] = str(TMP / "provision")
os.environ["SB_VOICE_STATE_FILE"] = str(TMP / "voice-settings.json")
os.environ.pop("DEEPGRAM_API_KEY", None)
os.environ.pop("GEMINI_LIVE_API_KEY", None)
os.environ.pop("ELEVENLABS_API_KEY", None)
os.environ.pop("DASHSCOPE_API_KEY", None)
sys.path.insert(0, str(RT))
sys.path.insert(0, str(VOICE))

import deepgram_proxy  # noqa: E402
import migrate_v2  # noqa: E402
import owner_ops  # noqa: E402
import voice_http  # noqa: E402
import api_server  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)


def fresh_db():
    d = TMP / "db"
    d.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(d / "state.db"))
    migrate_v2.migrate(conn)
    owner_ops.ensure_schema(conn)
    return conn


def serve(conn_path):
    def db_fn():
        return sqlite3.connect(conn_path, timeout=10)

    def log_event(kind, **fields):
        blob = json.dumps(fields, ensure_ascii=False)
        check("日志不含测试密钥", SECRET not in blob)

    handler = api_server._make_handler(db_fn, lambda *a: {"ok": False}, log_event, {"grok-chief": "chief-x"}, {}, threading.Event(), {})
    httpd = api_server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def req(port, method, path, body=None, headers=None, raw=False):
    import urllib.error
    import urllib.request
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    h = dict(headers or {})
    if body is not None and not isinstance(body, bytes) and "Content-Type" not in h:
        h["Content-Type"] = "application/json"
    request = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(request, timeout=8) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if raw:
                return resp.status, ctype, payload
            return resp.status, json.loads(payload.decode() or "{}")
    except urllib.error.HTTPError as err:
        payload = err.read()
        if raw:
            return err.code, err.headers.get("Content-Type", ""), payload
        try:
            return err.code, json.loads(payload.decode() or "{}")
        except ValueError:
            return err.code, {"raw": payload.decode("utf-8", "replace")}


def test_logic():
    check("拒绝非 Deepgram 主机", _raises(lambda: deepgram_proxy.assert_https_deepgram("https://evil.example/v2/speak")))
    check("拒绝明文 HTTP", _raises(lambda: deepgram_proxy.assert_https_deepgram("http://api.deepgram.com/v2/speak")))
    url = deepgram_proxy.speak_url()
    check("朗读走 /v2/speak 与文静", "/v2/speak" in url and "flux-wenjing-zh" in url and url.startswith("https://api.deepgram.com/"))
    listen = deepgram_proxy.listen_url()
    check("转写是 Nova-3 简体 zh", "model=nova-3" in listen and "language=zh" in listen and listen.startswith("wss://api.deepgram.com/v1/listen"))
    check("版本常量是 v2", deepgram_proxy.SPEAK_VERSION == "v2")
    frame = deepgram_proxy.encode_frame(1, b"hello", mask=True)
    frames, rest = deepgram_proxy.decode_frames(frame)
    check("websocket 帧可往返", frames == [(1, b"hello")] and rest == b"")
    check("默认模式是按住说话", deepgram_proxy.load_mode() == "hold")
    deepgram_proxy.save_mode("stream")
    check("模式能记住", deepgram_proxy.load_mode() == "stream")
    check("拒绝未知模式", _raises(lambda: deepgram_proxy.save_mode("agent")))
    deepgram_proxy.save_mode("hold")
    os.environ["DEEPGRAM_API_KEY"] = SECRET
    status = json.dumps(deepgram_proxy.public_status(), ensure_ascii=False)
    check("状态 JSON 不含密钥", SECRET not in status and '"configured": true' in status)
    os.environ.pop("DEEPGRAM_API_KEY", None)
    deepgram_proxy.save_provider_secret("deepgram", SECRET)
    path = Path(os.environ["SB_VOICE_SECRET_DIR"]) / "deepgram.env"
    mode = path.stat().st_mode & 0o777
    check("密钥文件是 600", mode == 0o600, oct(mode))
    text = path.read_text(encoding="utf-8")
    check("文件里有密钥且状态接口不回显", SECRET in text and SECRET not in json.dumps(deepgram_proxy.public_status()))
    calls = []

    def transport(method, url, headers, body, timeout=25):
        calls.append((method, url, headers.get("Authorization", ""), body))
        if url.endswith("/v1/auth/grant"):
            return 200, {"Content-Type": "application/json"}, json.dumps({"access_token": "short-lived", "expires_in": 30, "api_key": SECRET}).encode()
        return 200, {"Content-Type": "audio/mpeg"}, b"ID3fake-audio"

    deepgram_proxy.set_test_hooks(transport=transport, ws=None)
    chunks, ctype = deepgram_proxy.synthesize("大古，欢迎回来", deepgram_proxy.deepgram_key())
    audio = b"".join(chunks)
    check("缺 websocket 时走批量朗读且带 Token 头", ctype == "audio/mpeg" and audio == b"ID3fake-audio" and calls[-1][2] == "Token " + SECRET)
    check("批量音频本身不含密钥", SECRET.encode() not in audio)
    grant = deepgram_proxy.issue_grant(SECRET)
    dumped = json.dumps(grant)
    check("短时令牌响应不带回永久密钥", grant.get("access_token") == "short-lived" and SECRET not in dumped)
    calls.clear()
    missing, reason = deepgram_proxy.synthesize("你好", "")
    check("没密钥不发起朗读", missing is None and reason == "unconfigured" and calls == [])


def _raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


class ScriptedWS:
    def __init__(self):
        self.sent = []
        self.queue = [
            ("bin", b"\x01\x02" * 40),
            ("text", json.dumps({"type": "SpeechMetadata"})),
        ]

    def send_text(self, text):
        self.sent.append(text)

    def send_bin(self, payload):
        self.sent.append(payload)

    def recv_event(self, timeout=1):
        if self.queue:
            return self.queue.pop(0)
        return ("close", b"")

    def close(self):
        pass


def test_http():
    conn = fresh_db()
    path = TMP / "db" / "state.db"
    unlocked = owner_ops.unlock(conn, "语音测试口令", "测试机")
    token = unlocked["token"]
    conn.close()
    seen = {}

    def transport(method, url, headers, body, timeout=25):
        seen["url"] = url
        seen["auth"] = headers.get("Authorization", "")
        if str(url).endswith("/v1/auth/grant"):
            return 200, {"Content-Type": "application/json"}, json.dumps({
                "access_token": "short-lived", "expires_in": 30, "api_key": SECRET}).encode()
        return 200, {"Content-Type": "audio/mpeg"}, b"ID3-batch"

    def ws(url, headers):
        seen["ws"] = url
        seen["ws_auth"] = headers.get("Authorization", "")
        return ScriptedWS()

    deepgram_proxy.set_test_hooks(transport=transport, ws=ws)
    os.environ.pop("DEEPGRAM_API_KEY", None)
    deepgram_proxy.save_provider_secret("deepgram", "")
    httpd = serve(str(path))
    port = httpd.server_address[1]
    try:
        code, anon = req(port, "GET", "/api/voice/status")
        check("匿名查看语音状态 401", code == 401 and anon.get("need_auth") and "providers" not in anon)
        code, status = req(port, "GET", "/api/voice/status", headers={"Authorization": "Bearer " + token})
        blob = json.dumps(status, ensure_ascii=False)
        check("会话可看语音状态", code == 200 and status.get("ok") and status.get("mode") == "hold")
        check("状态列出四种渠道且不带密钥", len(status.get("providers") or []) == 4 and SECRET not in blob and "api_key" not in blob)
        check("欢迎语是静态文案", (status.get("welcome") or {}).get("text") == "大古，欢迎回来" and (status.get("welcome") or {}).get("source") == "static")
        code, denied = req(port, "POST", "/api/owner/voice/settings", {"mode": "live"})
        check("改模式要口令", code == 401 and denied.get("need_unlock"))
        code, changed = req(port, "POST", "/api/owner/voice/settings", {"mode": "live"}, {"Authorization": "Bearer " + token})
        check("授权后能切到实时", code == 200 and changed.get("mode") == "live")
        code, again = req(port, "GET", "/api/voice/status", headers={"Authorization": "Bearer " + token})
        check("模式切换被记住", again.get("mode") == "live")
        code, bad = req(port, "POST", "/api/owner/voice/settings", {"mode": "nope"}, {"Authorization": "Bearer " + token})
        check("未知模式被拒绝", code == 400)
        code, skipped = req(port, "POST", "/api/owner/voice/speak", {"text": "你好"}, {"Authorization": "Bearer " + token})
        check("没密钥时朗读降级且不调用上游", code == 200 and skipped.get("reason") == "unconfigured" and "ws" not in seen and SECRET not in json.dumps(skipped))
        code, saved = req(port, "POST", "/api/owner/voice/secret", {"provider": "deepgram", "api_key": SECRET}, {"Authorization": "Bearer " + token})
        check("能保存 Deepgram 槽位", code == 200 and saved.get("configured") is True and SECRET not in json.dumps(saved))
        code, status = req(port, "GET", "/api/voice/status", headers={"Authorization": "Bearer " + token})
        check("保存后只显示已配置", status["providers"][0]["configured"] is True and SECRET not in json.dumps(status))
        code, ctype, audio = req(port, "POST", "/api/owner/voice/speak", {"text": "幕僚长"}, {"Authorization": "Bearer " + token}, raw=True)
        check("朗读走 Flux websocket 且响应没有密钥", code == 200 and ctype.startswith("audio/wav") and audio.startswith(b"RIFF") and SECRET.encode() not in audio)
        check("上游地址是文静 v2", "wss://api.deepgram.com/v2/speak" in seen.get("ws", "") and "flux-wenjing-zh" in seen.get("ws", ""))
        check("上游鉴权是 Token 而不是把密钥写进 URL", seen.get("ws_auth") == "Token " + SECRET and SECRET not in seen.get("ws", ""))
        conn = sqlite3.connect(str(path))
        audit = "\n".join(r[0] or "" for r in conn.execute("SELECT detail FROM owner_audit"))
        conn.close()
        check("审计不含密钥", SECRET not in audit)
        code, granted = req(port, "POST", "/api/owner/voice/grant", {}, {"Authorization": "Bearer " + token})
        check("短时令牌接口不泄露永久密钥", code == 200 and granted.get("access_token") == "short-lived" and SECRET not in json.dumps(granted))
    finally:
        httpd.shutdown()
        deepgram_proxy.set_test_hooks(None, None)
        os.environ.pop("DEEPGRAM_API_KEY", None)


def _spoken(sock):
    for raw in sock.sent:
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "Speak":
            return obj.get("text") or ""
    return ""


def test_speak_stream_latency():
    """本机打点：同一条 500 字响应，旧路径要等整段，新路径在第一块 PCM 就可播。不访问 Deepgram。"""
    import http.client
    import time
    conn = fresh_db()
    unlocked = owner_ops.unlock(conn, "语音测试口令", "流式机")
    token = unlocked["token"]
    conn.close()
    pace = {"first": 0.0, "per_char": 0.0}
    sockets = []
    seen = {}

    class PacedWS:
        def __init__(self):
            self.sent = []
            self.n = 0
            self.chars = 0

        def send_text(self, text):
            self.sent.append(text)
            try:
                obj = json.loads(text)
            except ValueError:
                return
            if isinstance(obj, dict) and obj.get("type") == "Speak":
                self.chars = len(obj.get("text") or "")

        def send_bin(self, payload):
            return None

        def recv_event(self, timeout=20):
            self.n += 1
            if self.n == 1:
                if pace["first"]:
                    time.sleep(pace["first"])
                return ("bin", b"\x01\x00" * 480)
            if self.n == 2:
                delay = pace["per_char"] * self.chars
                if delay:
                    time.sleep(delay)
                return ("bin", b"\x02\x00" * 480)
            if self.n == 3:
                return ("text", json.dumps({"type": "SpeechMetadata"}))
            return ("close", b"")

        def close(self):
            return None

    def ws(url, headers):
        seen["url"] = url
        seen["auth"] = headers.get("Authorization", "")
        sock = PacedWS()
        sockets.append(sock)
        return sock

    deepgram_proxy.set_test_hooks(transport=None, ws=ws)
    os.environ.pop("DEEPGRAM_API_KEY", None)
    deepgram_proxy.save_provider_secret("deepgram", SECRET)
    httpd = serve(str(TMP / "db" / "state.db"))
    port = httpd.server_address[1]
    try:
        code, ctype, audio = req(port, "POST", "/api/owner/voice/speak", {"text": "句" * 600}, {"Authorization": "Bearer " + token}, raw=True)
        spoken = _spoken(sockets[-1]) if sockets else ""
        check("600 字不再被截成 500", code == 200 and ctype.startswith("audio/wav") and spoken == "句" * 600 and SECRET.encode() not in audio, len(spoken))
        code, _ctype, audio = req(port, "POST", "/api/owner/voice/speak", {"text": "句" * 4500}, {"Authorization": "Bearer " + token}, raw=True)
        spoken = _spoken(sockets[-1]) if sockets else ""
        check("单次上限 4000", code == 200 and spoken == "句" * 4000 and SECRET.encode() not in audio, len(spoken))
        check("流式上游仍是文静", "wss://api.deepgram.com/v2/speak" in seen.get("url", "") and "flux-wenjing-zh" in seen.get("url", "") and seen.get("auth") == "Token " + SECRET and SECRET not in seen.get("url", ""))
        pace["first"] = 0.04
        pace["per_char"] = 0.0009
        text = "测" * 500
        client = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
        t0 = time.perf_counter()
        client.request("POST", "/api/owner/voice/speak", body=json.dumps({"text": text}).encode(), headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        })
        resp = client.getresponse()
        buf = b""
        t_pcm = None
        while True:
            piece = resp.read(256)
            if not piece:
                break
            buf += piece
            if t_pcm is None and len(buf) >= 46 and buf.startswith(b"RIFF"):
                t_pcm = time.perf_counter() - t0
        t_full = time.perf_counter() - t0
        client.close()
        before_ms = round(t_full * 1000, 1)
        after_ms = round((t_pcm if t_pcm is not None else t_full) * 1000, 1)
        print("SPEAK_LATENCY " + json.dumps({
            "before_ms": before_ms,
            "after_ms": after_ms,
            "saved_ms": round(before_ms - after_ms, 1),
            "chars": 500,
            "note": "local paced upstream, no Deepgram",
        }, ensure_ascii=False))
        check("首段 PCM 早于整段收完", t_pcm is not None and t_full > t_pcm + 0.25 and buf.startswith(b"RIFF") and SECRET.encode() not in buf and _spoken(sockets[-1]) == text, (after_ms, before_ms))
    finally:
        httpd.shutdown()
        deepgram_proxy.set_test_hooks(None, None)
        os.environ.pop("DEEPGRAM_API_KEY", None)


def test_pages():
    html = (ROOT / "70-Console/design/prototype/index.html").read_text(encoding="utf-8")
    js = (ROOT / "70-Console/design/prototype/v2/app.js").read_text(encoding="utf-8")
    css = (ROOT / "70-Console/design/prototype/v2/app.css").read_text(encoding="utf-8")
    galaxy = (ROOT / "70-Console/design/prototype/v2/galaxy.js").read_text(encoding="utf-8")
    check("三种模式都在设置里", all(x in html for x in ("value=\"hold\"", "value=\"stream\"", "value=\"live\"", "按住说话", "流式（本地小模型）", "实时语音 API")))
    check("音色写成文静", "flux-wenjing-zh" in html and "文静" in html)
    check("欢迎语是完整一句并带版本号", "大古，欢迎回来" in html and "welcome-dagu-wenjing.mp3?v=2.8.4" in html and "welcome-dagu-wenjing.ogg?v=2.8.4" in html)
    tools = html.split('class="chat-tools"', 1)[1].split("</div>", 1)[0]
    panel = html.split('id="voice-panel"', 1)[1].split('id="chat"', 1)[0]
    check("头栏有实时通话按钮", 'id="btn-live-call"' in tools and ">实时通话<" in tools and "btn-live-call" not in panel)
    check("三种模式仍在设置里且面板没有被换成另一页", all(x in html for x in ("value=\"hold\"", "value=\"stream\"", "value=\"live\"")) and "voice-slots" in panel)
    check("打字和发送仍在", 'id="chat-input"' in html and 'id="chat-send"' in html and ">发送<" in html and "disabled" not in html.split('id="chat-form"', 1)[1].split("</form>", 1)[0])
    call = js.split("function onLiveCall", 1)[1].split("function bgmWanted", 1)[0]
    gum = call.index("getUserMedia")
    check("点击在同步堆栈里申请麦克风，再切 live，再开始通话", "await" not in call[:gum] and gum < call.index('"live"') < call.index('startConversation(e, "live"'))
    check("通话中再点就是挂断", "stopConversation()" in call[:gum])
    check("实时通话不改打字框", "chat-input" not in call and "chat-send" not in call)
    err = js.split("function micErrorText", 1)[1].split("async function micStart", 1)[0]
    check("拒绝麦克风时提示改地址栏并覆盖 iPhone", "NotAllowedError" in err and "SecurityError" in err and "地址栏" in err and "锁" in err and "麦克风图标" in err and "实时通话" in err and "设置 › Safari › 麦克风" in err and "键盘输入不受影响" in err)
    check("页面缓存仍是 no-store", 'Cache-Control" content="no-store' in html)
    check("静态脚本样式版本是 2.8.4", "v2/app.js?v=2.8.4" in html and "v2/app.css?v=2.8.4" in html and "v2/voice-entry.js?v=2.8.4" in html and "v2/speak-queue.js?v=2.8.4" in html and "v2/roster.js?v=2.8.4" in html)
    queue = (ROOT / "70-Console/design/prototype/v2/speak-queue.js").read_text(encoding="utf-8")
    proxy = (VOICE / "deepgram_proxy.py").read_text(encoding="utf-8")
    voice = js.split("function stopSpeaking", 1)[1].split("async function commitUtterance", 1)[0]
    check("朗读上限是 4000，服务端不再截 500", "SPEAK_TEXT_MAX = 4000" in proxy and "text[:500]" not in proxy and "SPEAK_TEXT_MAX = 4000" in queue)
    check("边收边播，不支持时退回整段", "getReader" in voice and "arrayBuffer" in voice and voice.index("getReader") < voice.index("arrayBuffer"))
    check("朗读路径不再截 500 字", "slice(0, 500)" not in voice)
    say = js.split("async function say", 1)[1].split("async function commitUtterance", 1)[0]
    say_head = say.split("await ", 1)[0]
    check("按句排队且新朗读会先停掉上一段", "splitSpeakText" in queue and "createSession" in js and "stopSpeaking()" in say_head and "speakSession.begin" in say_head)
    check("快速回复念正文，正式回复仍走 say", "say(chatBody(m))" in js and "say(m.text)" in js)
    live = js.split("if (rms > 0.02)", 1)[1].split("else t.quiet", 1)[0]
    check("开口仍打断当前播放", "stopSpeaking()" in live)
    call = js.split("function startConversation", 1)[1].split("if (!canRecord", 1)[0]
    check("进入实时通话会先停朗读", "stopSpeaking()" in call)
    check("实时定稿仍走 sendChat", "await sendChat()" in js.split("async function commitUtterance", 1)[1].split("function pcm16", 1)[0])
    check("音色常量仍是文静", 'TTS_MODEL = "flux-wenjing-zh"' in proxy and "flux-wenjing-zh" in js)
    check("前端不出现 Deepgram 主机和密钥名", "api.deepgram.com" not in js and "DEEPGRAM_API_KEY" not in js and "token=" not in js)
    begin = js[js.index("async function beginEntry"):js.index("function bindBgm")]
    check("欢迎语在背景音乐之前", begin.index("playWelcomeEl") < begin.index("startBgm"))
    check("项目圈是正圆", "aspect-ratio: 1 / 1" in css and "border-radius: 50%" in css and "layoutRosters" in js)
    for n in range(1, 9):
        check("知识宇宙有 %d 级" % n, 'data-depth="%d"' % n in html)
    check("默认展开是 8 级", 'data-depth="8" class="on"' in html and "let hop = 8" in galaxy)
    check("星图仍只认真实双链", "wikilink" in galaxy and "未解析" in galaxy and "TorusGeometry" not in galaxy)
    check("发光不用彩虹和扫描线", "#ff5fa2" not in galaxy and "扫描线" not in galaxy and "AdditiveBlending" in galaxy)
    audio = ROOT / "70-Console/design/prototype/v2/audio/welcome-dagu-wenjing.mp3"
    if audio.exists():
        check("已放入的欢迎语不是空文件", audio.stat().st_size > 800)
    else:
        check("欢迎语文件还没放入时页面仍可降级", "finish(\"skip\")" in js)


def test_node():
    return None


if __name__ == "__main__":
    test_logic()
    test_http()
    test_speak_stream_latency()
    proc = subprocess.run(
        ["node", "-e", r"""
const fs = require("fs");
const vm = require("vm");
function load(file) {
  const ctx = { window: {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
  return ctx;
}
const E = load(process.argv[1]).window.SBVoiceEntry;
const R = load(process.argv[2]).window.SBRoster;
const mem = { m: {}, getItem(k){ return Object.prototype.hasOwnProperty.call(this.m, k) ? this.m[k] : null; }, setItem(k,v){ this.m[k] = String(v); } };
const fail = (n) => { console.error(n); process.exit(1); };
if (E.readMode(mem) !== "hold") fail("default mode");
E.writeMode(mem, "stream");
if (E.readMode(mem) !== "stream") fail("stream");
E.writeMode(mem, "live");
if (E.readMode(mem) !== "live") fail("live");
E.writeMode(mem, "other");
if (E.readMode(mem) !== "hold") fail("bad mode");
if (E.bgmWanted(mem) !== true) fail("bgm default");
mem.setItem("sb.bgm.on", "0");
if (E.bgmWanted(mem) !== false) fail("bgm off");
if (E.entrySteps({ welcome: "ready", bgm: true }).steps.join(",") !== "welcome,bgm") fail("order");
if (E.entrySteps({ welcome: "skip", bgm: true }).steps.join(",") !== "bgm") fail("skip");
const blocked = E.entrySteps({ welcome: "blocked", bgm: true });
if (!blocked.deferred || blocked.steps.join(",") !== "welcome,bgm") fail("blocked");
if (R.columns(6, 520) !== 6) fail("one row " + R.columns(6, 520));
if (R.columns(6, 400) !== 3) fail("even split " + R.columns(6, 400));
if (R.columns(6, 160) !== 2) fail("pairs");
if (E.WELCOME_TEXT !== "大古，欢迎回来") fail("welcome text");
""" , str(ROOT / "70-Console/design/prototype/v2/voice-entry.js"), str(ROOT / "70-Console/design/prototype/v2/roster.js")],
        capture_output=True, text=True)
    check("模式切换、欢迎语顺序和名字圈列数", proc.returncode == 0, (proc.stdout + proc.stderr)[-500:])
    queued = subprocess.run(["node", "--check", str(ROOT / "70-Console/design/prototype/v2/app.js")], capture_output=True, text=True)
    check("app.js 语法", queued.returncode == 0, queued.stderr[-300:])
    queued = subprocess.run(["node", str(ROOT / "90-System/runtime/tests/test_speak_queue.mjs")], capture_output=True, text=True)
    print(queued.stdout.strip())
    check("按句排队与首段时钟", queued.returncode == 0 and "SPEAK_LATENCY_MODEL" in queued.stdout, (queued.stdout + queued.stderr)[-800:])
    test_pages()
    print("----")
    if FAILS:
        print("FAILED %d: %s" % (len(FAILS), ", ".join(FAILS)))
        sys.exit(1)
    print("ALL PASS")
