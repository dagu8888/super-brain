#!/usr/bin/env python3
"""幕僚长（grok-chief）回复大古 / 读取指挥官对话的命令行工具。

令牌只从环境变量 SUPERBRAIN_GATEWAY_TOKEN 读取，不写文件、不打印。
用法：
  chief_reply.py --to dagu-owner --text "收到，已安排" [--reply-to msg_xxx]
  chief_reply.py --inbox [--limit 20]          # 看最近的大古 ↔ 幕僚长对话（只读，带已有令牌）
  chief_reply.py --work "在做什么"              # 自报忙碌（控制台显示 忙碌 · 在做什么）
  chief_reply.py --work-clear                   # 做完清除
  chief_reply.py --approval "标题" --detail "..." [--options 同意,驳回,改期] [--assist url|text|vault] [--project id]
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

GATEWAY = os.environ.get("SUPERBRAIN_GATEWAY", "http://8.218.106.225:18765").rstrip("/")
INSTANCE = os.environ.get("SUPERBRAIN_INSTANCE", "幕僚长@云端")


def _token():
    t = os.environ.get("SUPERBRAIN_GATEWAY_TOKEN", "").strip()
    if not t:
        sys.exit("缺少环境变量 SUPERBRAIN_GATEWAY_TOKEN（grok-chief 令牌）")
    return t


def cmd(name, args):
    body = json.dumps({"cmd": name, "args": args}, ensure_ascii=False).encode()
    req = urllib.request.Request(GATEWAY + "/cmd", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + _token()})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": "HTTP %s" % e.code}


def get(path):
    req = urllib.request.Request(
        GATEWAY + path,
        headers={"Authorization": "Bearer " + _token(), "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": "HTTP %s" % e.code}


def bj(ts):
    return time.strftime("%m-%d %H:%M", time.gmtime((ts or 0) + 8 * 3600))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--to", default="dagu-owner")
    ap.add_argument("--text")
    ap.add_argument("--reply-to")
    ap.add_argument("--inbox", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--work")
    ap.add_argument("--work-clear", action="store_true")
    ap.add_argument("--approval")
    ap.add_argument("--detail", default="")
    ap.add_argument("--options")
    ap.add_argument("--assist", choices=["url", "text", "vault"])
    ap.add_argument("--project")
    a = ap.parse_args()

    if a.inbox:
        d = get("/api/chat?limit=%d" % a.limit)
        if not d.get("ok"):
            print(json.dumps({k: d.get(k) for k in ("ok", "error", "need_auth") if k in d},
                             ensure_ascii=False))
            return sys.exit(1)
        d = d["data"]
        for m in d["messages"]:
            who = "大古" if m["from_agent"] == "dagu-owner" else (m.get("from_instance") or "幕僚长")
            print("[%s 北京时间] %s %s：%s" % (bj(m["created_at"]), m["msg_id"], who, m["text"]))
        return
    if a.work_clear:
        print(json.dumps(cmd("work", {"clear": 1, "instance": INSTANCE}), ensure_ascii=False))
        return
    if a.work:
        print(json.dumps(cmd("work", {"title": a.work, "instance": INSTANCE}), ensure_ascii=False))
        return
    if a.approval:
        args = {"title": a.approval, "detail": a.detail, "instance": INSTANCE}
        if a.options:
            args["options"] = [x.strip() for x in a.options.replace("，", ",").split(",") if x.strip()]
        if a.assist:
            args["kind"] = "assist"
            args["assist_kind"] = a.assist
        if a.project:
            args["project_id"] = a.project
        print(json.dumps(cmd("approval_request", args), ensure_ascii=False))
        return
    if not a.text:
        ap.error("需要 --text（或 --inbox / --work / --approval）")
    args = {"to": a.to, "text": a.text, "instance": INSTANCE}
    if a.reply_to:
        args["reply_to"] = a.reply_to
    res = cmd("msg", args)
    print(json.dumps({k: res.get(k) for k in ("ok", "msg_id", "to", "error") if k in res}, ensure_ascii=False))
    sys.exit(0 if res.get("ok") else 1)


if __name__ == "__main__":
    main()
