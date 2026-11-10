#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""box 侧消息总线客户端：发送、点名回执、订阅打印发给本身份的消息。

口令只从环境变量读取（默认 SUPERBRAIN_GATEWAY_TOKEN），不接受命令行明文、不写日志。

用法：
  python sbmsg.py send --to all --kind ping "所有在线 Agent 回复 1"
  python sbmsg.py rollcall <msg_id>
  python sbmsg.py tail
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

DEFAULT_GATEWAY = "http://8.218.106.225:18765"


def beijing_fmt(ts):
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Asia/Shanghai")
        return datetime.fromtimestamp(int(ts), tz).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return datetime.utcfromtimestamp(int(ts) + 8 * 3600).strftime("%Y-%m-%d %H:%M:%S")


def token():
    for name in ("SUPERBRAIN_GATEWAY_TOKEN", "SB_TOKEN"):
        t = os.environ.get(name, "").strip()
        if t:
            return t
    return ""


def die(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)


def request(gateway, method, path, tok, body=None, timeout=30):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    headers = {"Authorization": "Bearer " + tok, "User-Agent": "sbmsg",
               "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(gateway.rstrip("/") + path, data=data,
                                 method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            obj = json.loads(e.read().decode("utf-8"))
        except Exception:
            obj = {"ok": False, "error": "HTTP %s" % e.code}
        return e.code, obj


def cmd_send(ns):
    tok = token()
    if not tok:
        die("缺少环境变量 SUPERBRAIN_GATEWAY_TOKEN")
    args = {"to": ns.to, "text": ns.text, "kind": ns.kind}
    if ns.reply_to:
        args["reply_to"] = ns.reply_to
    if ns.instance:
        args["instance"] = ns.instance
    code, obj = request(ns.gateway, "POST", "/cmd", tok,
                        {"cmd": "msg", "args": args})
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    if not obj.get("ok"):
        sys.exit(1)
    if ns.kind == "ping":
        print("点名已发出。查回执：python sbmsg.py rollcall %s" % obj.get("msg_id"),
              file=sys.stderr)


def cmd_rollcall(ns):
    tok = token()
    if not tok:
        die("缺少环境变量 SUPERBRAIN_GATEWAY_TOKEN")
    code, obj = request(ns.gateway, "GET", "/api/rollcall/" + urllib.parse.quote(ns.msg_id), tok)
    if not obj.get("ok"):
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        sys.exit(1)
    data = obj.get("data") or obj
    ping = data.get("ping") or {}
    print("点名 %s  kind=%s  from=%s  to=%s  发出于 %s（北京时间）" % (
        ping.get("msg_id"), ping.get("kind"), ping.get("from_agent"),
        ping.get("to"), beijing_fmt(ping.get("created_at") or 0)))
    print("正文：%s" % (ping.get("text") or ""))
    print("已回复 %s 人 / 名册未回复 %s（其中在场 %s）" % (
        data.get("replied_count"), data.get("missing_count"),
        data.get("missing_online_count")))
    print("")
    print("—— 回复 ——")
    for r in data.get("replies") or []:
        print("  +%.1fs  %s / %s" % (
            float(r.get("latency_seconds") or 0),
            r.get("from_agent") or "?",
            r.get("from_instance") or "-"))
        for line in (r.get("text") or "").splitlines() or [""]:
            print("      %s" % line)
    missing = data.get("missing") or []
    if missing:
        print("")
        print("—— 名册 active 未回复 ——")
        for e in missing:
            flag = "在场" if e.get("online") else (e.get("live_status") or "离线")
            print("  - %s / %s  [%s]" % (e.get("agent_id") or "?",
                                        e.get("instance") or "-", flag))
    if ns.json:
        print("")
        print(json.dumps(data, ensure_ascii=False, indent=2))


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


def cmd_tail(ns):
    tok = token()
    if not tok:
        die("缺少环境变量 SUPERBRAIN_GATEWAY_TOKEN")
    qs = {"since": str(int(time.time()) - ns.since_window)}
    if ns.instance:
        qs["instance"] = ns.instance
    url = ns.gateway.rstrip("/") + "/api/stream?" + urllib.parse.urlencode(qs)
    print("订阅中 %s （发给本身份的消息会打印；Ctrl+C 退出）" % ns.gateway, flush=True)
    backoff = 5
    while True:
        try:
            req = urllib.request.Request(
                url, headers={"Authorization": "Bearer " + tok,
                              "Accept": "text/event-stream",
                              "User-Agent": "sbmsg-tail"})
            with urllib.request.urlopen(req, timeout=None) as resp:
                backoff = 5
                for event, data in iter_sse(resp):
                    if event != "msg":
                        continue
                    try:
                        m = json.loads(data)
                    except Exception:
                        continue
                    ts = beijing_fmt(m.get("created_at") or 0)
                    print("[%s 北京时间] %s -> %s  kind=%s  id=%s" % (
                        ts, m.get("from_agent"), m.get("to"),
                        m.get("kind"), m.get("msg_id")), flush=True)
                    if m.get("reply_to"):
                        print("  reply_to: %s" % m["reply_to"], flush=True)
                    for line in (m.get("text") or "").splitlines() or [""]:
                        print("  %s" % line, flush=True)
                    print("", flush=True)
        except KeyboardInterrupt:
            print("已停止订阅")
            return
        except Exception as e:
            typ = type(e).__name__
            print("连接断开（%s），%ds 后重连" % (typ, backoff), file=sys.stderr, flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


def main():
    ap = argparse.ArgumentParser(description="Super-Brain 消息总线客户端")
    ap.add_argument("--gateway", default=os.environ.get("SUPERBRAIN_GATEWAY") or DEFAULT_GATEWAY)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("send", help="发送一条消息")
    p.add_argument("text")
    p.add_argument("--to", default="all")
    p.add_argument("--kind", default="chat", choices=("chat", "ping", "ack"))
    p.add_argument("--reply-to", dest="reply_to", default=None)
    p.add_argument("--instance", default=None)
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("rollcall", help="查看点名回执与时延")
    p.add_argument("msg_id")
    p.add_argument("--json", action="store_true", help="在人读摘要后再打印完整 JSON")
    p.set_defaults(func=cmd_rollcall)

    p = sub.add_parser("tail", help="订阅打印发给本身份（口令对应 chief）的消息")
    p.add_argument("--instance", default=None)
    p.add_argument("--since-window", type=int, default=5,
                   help="连接时回溯多少秒（默认 5）")
    p.set_defaults(func=cmd_tail)

    ns = ap.parse_args()
    ns.func(ns)


if __name__ == "__main__":
    main()
