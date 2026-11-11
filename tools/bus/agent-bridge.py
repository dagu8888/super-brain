#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""节点桥：挂到中台消息总线，SSE 长连在场，收到 msg 后按 kind 回复。

仅标准库，Windows / Linux 通用。配置与本文件同目录（或 --config 指定）。
口令只从环境变量或本机配置读取，绝不写入 bridge.log 或标准输出。

用法：
  python agent-bridge.py                 # 常驻
  python agent-bridge.py --config path
  python agent-bridge.py --once          # 连上并完成一次在场注册后退出（自检）
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "agent-bridge.json"
LOG = Path(os.environ.get("SB_BRIDGE_LOG") or (HERE / "bridge.log"))
HANDLER_TIMEOUT = 120
BACKOFF_MIN, BACKOFF_MAX = 5, 300

# 探 8799 时尝试过的响应字段（按优先级）
_REPLY_KEYS = ("reply", "text", "message", "content", "output", "result",
               "answer", "data", "choices")


def beijing_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Shanghai"))
    except Exception:
        return datetime.now(timezone.utc) + timedelta(hours=8)


def beijing_str():
    return beijing_now().strftime("%Y-%m-%d %H:%M:%S")


def _redact(s):
    """日志消毒：去掉 query 里的 token、Bearer 头残留。"""
    if not s:
        return s
    out = str(s)
    out = urllib.parse.urlparse(out)._replace(query="").geturl() if "://" in out else out
    # 即使被拼进异常信息也不保留口令形态
    for key in ("token=", "Bearer ", "authorization"):
        if key.lower() in out.lower():
            out = "<redacted>"
            break
    return out[:300]


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + _redact(msg)
    print(line, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_config(path):
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError("找不到配置文件：%s（可复制 agent-bridge.example.json）" % path)
    conf = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(conf, dict):
        raise ValueError("配置必须是 JSON 对象")
    return conf


def token_of(conf):
    env_name = (conf.get("token_env") or "SUPERBRAIN_GATEWAY_TOKEN").strip()
    t = os.environ.get(env_name, "").strip()
    if t:
        return t
    # 兼容旧节点口令环境变量
    for name in ("SB_TOKEN", "SB_VIEWER_TOKEN"):
        t = os.environ.get(name, "").strip()
        if t:
            return t
    t = str(conf.get("token") or "").strip()
    return t


def api_post(gateway, tok, cmd, args, timeout=30):
    body = json.dumps({"cmd": cmd, "args": args}, ensure_ascii=False).encode()
    req = urllib.request.Request(
        gateway.rstrip("/") + "/cmd", data=body, method="POST",
        headers={"Authorization": "Bearer " + tok,
                 "Content-Type": "application/json; charset=utf-8",
                 "User-Agent": "sb-agent-bridge"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_reply(obj):
    """兼容 OpenMAUS / 常见聊天 API 的多种返回形态，抽出一段可回传的文本。"""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj.strip()
    if isinstance(obj, (int, float, bool)):
        return str(obj)
    if isinstance(obj, list):
        parts = [extract_reply(x) for x in obj]
        return "\n".join(p for p in parts if p)
    if not isinstance(obj, dict):
        return str(obj).strip()
    for k in _REPLY_KEYS:
        if k in obj and obj[k] not in (None, "", [], {}):
            v = obj[k]
            if k == "choices" and isinstance(v, list) and v:
                first = v[0]
                if isinstance(first, dict):
                    msg = first.get("message") or first
                    return extract_reply(msg.get("content") if isinstance(msg, dict) else msg)
                return extract_reply(first)
            got = extract_reply(v)
            if got:
                return got
    return ""


def probe_openmaus(base_url, timeout=3):
    """启动时轻量探活 8799，把实际返回形态记到日志，便于配兼容。"""
    base = (base_url or "http://127.0.0.1:8799").rstrip("/")
    found = []
    for path in ("/api/health", "/health", "/healthz", "/openapi.json", "/"):
        try:
            req = urllib.request.Request(
                base + path, headers={"User-Agent": "sb-agent-bridge", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read(4000)
                ctype = r.headers.get("Content-Type", "")
            snippet = raw.decode("utf-8", "replace")[:400].replace("\n", " ")
            found.append("%s %s %s" % (path, r.status, snippet[:160]))
        except Exception as e:
            found.append("%s 失败(%s)" % (path, _redact(type(e).__name__)))
    log("OPENMAUS 探活 %s：%s" % (base, " | ".join(found) or "无响应"))
    return found


def handle_openmaus(conf, text):
    om = conf.get("openmaus") or {}
    mode = (om.get("mode") or "auto").strip().lower()
    bot = om.get("bot_id") or conf.get("bot_id") or ""
    base = (om.get("base_url") or "http://127.0.0.1:8799").rstrip("/")
    if mode in ("auto", "http"):
        path = (om.get("http_path") or "/api/bots/{bot_id}/messages").replace("{bot_id}", bot)
        url = base + path
        bodies = om.get("bodies")
        if not bodies:
            bodies = [
                {"text": text, "content": text, "message": text},
                {"role": "user", "content": text},
                {"input": text},
            ]
        last_err = None
        for body in bodies:
            try:
                payload = json.dumps(body, ensure_ascii=False).encode()
                req = urllib.request.Request(
                    url, data=payload, method=om.get("http_method") or "POST",
                    headers={"Content-Type": "application/json; charset=utf-8",
                             "User-Agent": "sb-agent-bridge", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=HANDLER_TIMEOUT) as r:
                    raw = r.read(200000)
                try:
                    obj = json.loads(raw.decode("utf-8", "replace"))
                except Exception:
                    return raw.decode("utf-8", "replace").strip()
                got = extract_reply(obj)
                if got:
                    return got
                last_err = "HTTP 已返回但无法抽取正文，keys=%s" % (
                    list(obj)[:8] if isinstance(obj, dict) else type(obj).__name__)
            except Exception as e:
                last_err = _redact(str(e)[:200])
                continue
        if mode == "http":
            raise RuntimeError(last_err or "openmaus HTTP 调用失败")
    if mode in ("auto", "cli"):
        cli = om.get("cli") or ["openmausbot", "run", bot, text]
        if isinstance(cli, str):
            cli = cli.replace("{bot_id}", bot).replace("{text}", text)
            cmd = cli
            shell = True
        else:
            cmd = [str(x).replace("{bot_id}", bot).replace("{text}", text) for x in cli]
            shell = False
        r = subprocess.run(cmd, shell=shell, capture_output=True, text=True,
                           timeout=HANDLER_TIMEOUT, encoding="utf-8", errors="replace")
        out = (r.stdout or "").strip() or (r.stderr or "").strip()
        if r.returncode != 0 and not out:
            raise RuntimeError("openmausbot 退出码 %s" % r.returncode)
        return out
    raise RuntimeError("openmaus 未配置可用 mode")


def handle_shell(conf, text):
    sh = conf.get("shell") or {}
    cmd = sh.get("command")
    if not cmd:
        raise RuntimeError("handler=shell 但未配置 shell.command")
    shell = isinstance(cmd, str)
    r = subprocess.run(cmd, shell=shell, input=text, capture_output=True,
                       text=True, timeout=HANDLER_TIMEOUT,
                       encoding="utf-8", errors="replace",
                       cwd=sh.get("cwd") or None)
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    if r.returncode != 0 and not out:
        raise RuntimeError(err or ("命令退出码 %s" % r.returncode))
    return out or err


def format_reply(text, layer, instance):
    body = (text or "").rstrip()
    tag = "layer=%s" % layer
    if tag not in body:
        body = (body + "\n" + tag).strip() if body else tag
    return body


def dispatch(conf, msg):
    """按 kind 处理一条消息，返回 (reply_text, layer) 或 None（无需回）。"""
    kind = (msg.get("kind") or "chat").lower()
    instance = conf.get("instance") or ""
    if kind == "ping":
        text = "1 · %s · 收到于%s（北京时间）" % (instance or conf.get("agent_id") or "?",
                                         beijing_str())
        return format_reply(text, "transport", instance), "transport"
    if kind != "chat":
        log("忽略未识别 kind=%s msg=%s" % (kind, msg.get("msg_id")))
        return None
    handler = (conf.get("handler") or "none").strip().lower()
    try:
        if handler == "none":
            result = "已收到 · %s · %s（北京时间）" % (instance or conf.get("agent_id"), beijing_str())
        elif handler == "openmaus":
            result = handle_openmaus(conf, msg.get("text") or "")
        elif handler == "shell":
            result = handle_shell(conf, msg.get("text") or "")
        else:
            result = "未知 handler=%s，已收到但未执行" % handler
        return format_reply(result, "agent", instance), "agent"
    except subprocess.TimeoutExpired:
        return format_reply("处理超时（>%s 秒），未能完成" % HANDLER_TIMEOUT,
                            "agent", instance), "agent"
    except Exception as e:
        return format_reply("处理失败：%s" % _redact(str(e)[:240]),
                            "agent", instance), "agent"


def _timeout_reply(conf, msg):
    instance = conf.get("instance") or ""
    return format_reply("处理超时（>%s 秒），未能完成" % HANDLER_TIMEOUT,
                        "agent", instance)


def send_reply(conf, tok, msg, text):
    args = {"reply_to": msg["msg_id"], "text": text, "kind": "chat"}
    if conf.get("instance"):
        args["instance"] = conf["instance"]
    try:
        res = api_post(conf["gateway"], tok, "reply", args, timeout=30)
    except Exception as e:
        log("REPLY 失败 %s err=%s" % (msg.get("msg_id"), _redact(str(e)[:160])))
        return
    if res.get("ok"):
        log("REPLY 成功 %s -> %s" % (msg.get("msg_id"), res.get("msg_id")))
    else:
        log("REPLY 拒绝 %s err=%s" % (msg.get("msg_id"), res.get("error")))


def handle_async(conf, tok, msg):
    # ping 立即回；chat 最多等 120 秒，超时回说明
    kind = (msg.get("kind") or "chat").lower()
    if kind == "ping":
        out = dispatch(conf, msg)
        if out:
            send_reply(conf, tok, msg, out[0])
        return
    box = {}
    # 真实工作才报「忙碌」：只有 handler 真的去执行（openmaus/shell）时，经 /cmd work 自报在做什么，做完清除。
    # 心跳从不报忙碌。
    really_works = (conf.get("handler") or "none").strip().lower() in ("openmaus", "shell")
    if really_works:
        report_work(conf, tok, "处理%s的消息：%s" % (msg.get("from_agent") or "?", (msg.get("text") or "")[:40]),
                    msg.get("msg_id"))

    def run():
        box["out"] = dispatch(conf, msg)

    t = threading.Thread(target=run, name="bus-handler", daemon=True)
    t.start()
    t.join(HANDLER_TIMEOUT)
    if really_works:
        report_work(conf, tok, None)
    if t.is_alive():
        log("HANDLER 超时 msg=%s" % msg.get("msg_id"))
        send_reply(conf, tok, msg, _timeout_reply(conf, msg))
        return
    out = box.get("out")
    if out:
        send_reply(conf, tok, msg, out[0])


def report_work(conf, tok, title, ref=None):
    """/cmd work：title 非空=开始做，None=做完清除。失败只记日志，不影响回复。"""
    args = {"clear": 1} if title is None else {"title": title[:120], "ref": ref}
    if conf.get("instance"):
        args["instance"] = conf["instance"]
    try:
        res = api_post(conf["gateway"], tok, "work", args, timeout=10)
        if not res.get("ok"):
            log("WORK 上报被拒 err=%s" % res.get("error"))
    except Exception as e:
        log("WORK 上报失败 err=%s" % _redact(str(e)[:120]))


def iter_sse(resp):
    event, data = "message", []
    for raw in resp:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
            continue
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []


def stream_forever(conf, tok, once=False):
    gateway = conf["gateway"].rstrip("/")
    instance = (conf.get("instance") or "").strip()
    qs = {"since": "0"}
    if instance:
        qs["instance"] = instance
    url = gateway + "/api/stream?" + urllib.parse.urlencode(qs)
    backoff = BACKOFF_MIN
    while True:
        try:
            req = urllib.request.Request(
                url, headers={"Authorization": "Bearer " + tok,
                              "Accept": "text/event-stream",
                              "User-Agent": "sb-agent-bridge"})
            log("SSE 连接 %s as %s / %s" % (
                gateway, conf.get("agent_id") or "?", instance or "(无实例)"))
            with urllib.request.urlopen(req, timeout=None) as resp:
                backoff = BACKOFF_MIN
                log("SSE 已建立（在场心跳中）")
                if once:
                    log("ONCE 自检：连接成功，即断开退出")
                    return
                for event, data in iter_sse(resp):
                    if event != "msg":
                        continue
                    try:
                        msg = json.loads(data)
                    except Exception:
                        log("SSE msg 非 JSON，已忽略")
                        continue
                    mid = msg.get("msg_id")
                    # 不处理自己发出的消息
                    if msg.get("from_agent") == conf.get("agent_id") and not msg.get("reply_to"):
                        if (not instance) or msg.get("from_instance") in (None, "", instance):
                            continue
                    log("收到 msg %s kind=%s from=%s" % (
                        mid, msg.get("kind"), msg.get("from_agent")))
                    threading.Thread(
                        target=handle_async, args=(conf, tok, msg),
                        name="bus-msg-%s" % mid, daemon=True).start()
        except Exception as e:
            if once:
                raise
            log("SSE 断开（%s），%ds 后重连" % (_redact(str(e)[:160]), backoff))
            time.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    once = "--once" in argv
    cfg_path = DEFAULT_CONFIG
    if "--config" in argv:
        i = argv.index("--config")
        if i + 1 >= len(argv):
            log("缺少 --config 路径")
            return 2
        cfg_path = Path(argv[i + 1])
    try:
        conf = load_config(cfg_path)
    except Exception as e:
        log(str(e))
        return 2
    global LOG
    if not os.environ.get("SB_BRIDGE_LOG"):
        LOG = Path(cfg_path).resolve().parent / "bridge.log"
    conf["gateway"] = (conf.get("gateway") or "http://8.218.106.225:18765").rstrip("/")
    tok = token_of(conf)
    if not tok:
        log("缺少口令（环境变量 %s，或配置 token_env）" %
            (conf.get("token_env") or "SUPERBRAIN_GATEWAY_TOKEN"))
        return 2
    if (conf.get("handler") or "none").lower() == "openmaus":
        om = conf.get("openmaus") or {}
        try:
            probe_openmaus(om.get("base_url") or "http://127.0.0.1:8799")
        except Exception as e:
            log("OPENMAUS 探活异常：%s" % _redact(str(e)[:160]))
    try:
        stream_forever(conf, tok, once=once)
        return 0
    except Exception as e:
        log("启动失败：%s" % _redact(str(e)[:200]))
        return 1


if __name__ == "__main__":
    sys.exit(main())
