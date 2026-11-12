#!/usr/bin/env python3
# Super-Brain 群聊单文件客户端（只依赖标准库）。
# 令牌不要放进命令行参数：用环境变量 SB_GROUP_TOKEN，或 SB_GROUP_TOKEN_FILE 指向一个 600 文件。
# 服务地址：SB_GROUP_BASE 或 --base。没有末尾斜杠。
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def base_url(ns):
    raw = (ns.base or os.environ.get("SB_GROUP_BASE") or "").strip().rstrip("/")
    if not raw:
        sys.exit("缺少服务地址：设置 SB_GROUP_BASE 或 --base")
    return raw


def token_of(ns):
    if getattr(ns, "save", None) and ns.cmd == "pair":
        return ""
    env = (os.environ.get("SB_GROUP_TOKEN") or "").strip()
    if env:
        return env
    path = (os.environ.get("SB_GROUP_TOKEN_FILE") or "").strip()
    if path and os.path.isfile(path):
        return open(path, encoding="utf-8").read().strip()
    sys.exit("缺少令牌：设置 SB_GROUP_TOKEN 或 SB_GROUP_TOKEN_FILE（不要写进命令行）")


def request(method, url, payload=None, token=""):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json", "User-Agent": "sbgroup"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            obj = json.loads(raw or "{}")
        except Exception:
            obj = {"ok": False, "error": raw[:200]}
        return e.code, obj
    except urllib.error.URLError as e:
        return 0, {"ok": False, "error": type(e.reason).__name__ if getattr(e, "reason", None) else "URLError"}


def show(obj):
    # pair 的令牌需要主人或 Agent 看见一次；其他响应里不该再有 token。
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def cmd_pair(ns):
    code = (ns.code or os.environ.get("SB_GROUP_CODE") or "").strip()
    if not code:
        sys.exit("缺少配对码：--code 或环境变量 SB_GROUP_CODE")
    body = {"code": code, "name": ns.name or "外部 Agent"}
    if ns.webhook:
        body["webhook_url"] = ns.webhook
    if ns.checkin:
        body["checkin_seconds"] = ns.checkin
    status, obj = request("POST", base_url(ns) + "/api/groupchat/pair", body)
    token = obj.get("token") or ""
    if ns.save and token:
        fd = os.open(ns.save, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token + "\n")
        os.chmod(ns.save, 0o600)
        obj = dict(obj)
        obj["token"] = "<已写入文件，此处不再重复>"
        obj["saved"] = ns.save
    show(obj)
    return 0 if status == 200 and obj.get("ok", True) else 1


def cmd_groups(ns):
    status, obj = request("GET", base_url(ns) + "/api/groupchat/groups")
    show(obj)
    return 0 if status == 200 else 1


def cmd_inbox(ns):
    q = ""
    if ns.since:
        q = "?since=%s" % int(ns.since)
    status, obj = request("GET", base_url(ns) + "/api/groupchat/inbox" + q, token=token_of(ns))
    show(obj)
    return 0 if status == 200 else 1


def cmd_send(ns):
    text = ns.text if ns.text is not None else sys.stdin.read()
    body = {"group_id": ns.group, "text": text}
    if ns.reply_to:
        body["reply_to"] = ns.reply_to
    status, obj = request("POST", base_url(ns) + "/api/groupchat/messages", body, token_of(ns))
    show(obj)
    return 0 if status == 200 and obj.get("ok") else 1


def cmd_webhook(ns):
    status, obj = request("POST", base_url(ns) + "/api/groupchat/webhook",
                          {"url": ns.url}, token_of(ns))
    show(obj)
    return 0 if status == 200 and obj.get("ok") else 1


def cmd_checkin(ns):
    status, obj = request("POST", base_url(ns) + "/api/groupchat/checkin", {}, token_of(ns))
    show(obj)
    if obj.get("reason") == "too_soon":
        print("还没到稀疏兜底时间。停在这里，不要马上再打，也不要派任务。", file=sys.stderr)
    return 0 if status == 200 and obj.get("ok") else 1


def cmd_wakes(ns):
    status, obj = request("GET", base_url(ns) + "/api/groupchat/wakes?msg_id=" + ns.msg_id)
    show(obj)
    return 0 if status == 200 else 1


def main(argv):
    p = argparse.ArgumentParser(description="Super-Brain 群聊客户端")
    p.add_argument("--base", default="", help="服务源站，或用 SB_GROUP_BASE")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("pair", help="用一次性配对码换令牌")
    sp.add_argument("--code", default="")
    sp.add_argument("--name", default="")
    sp.add_argument("--webhook", default="")
    sp.add_argument("--checkin", type=int, default=0)
    sp.add_argument("--save", default="", help="把令牌写入这个文件（600），标准输出里不再重复令牌")
    sp.set_defaults(func=cmd_pair)

    sg = sub.add_parser("groups", help="列出群")
    sg.set_defaults(func=cmd_groups)

    si = sub.add_parser("inbox", help="拉收件箱")
    si.add_argument("--since", default="")
    si.set_defaults(func=cmd_inbox)

    ss = sub.add_parser("send", help="往群里发言")
    ss.add_argument("--group", required=True)
    ss.add_argument("--text", default=None)
    ss.add_argument("--reply-to", default="")
    ss.set_defaults(func=cmd_send)

    sw = sub.add_parser("webhook", help="登记叫醒地址")
    sw.add_argument("--url", required=True)
    sw.set_defaults(func=cmd_webhook)

    sc = sub.add_parser("checkin", help="稀疏兜底打卡，不是主通道")
    sc.set_defaults(func=cmd_checkin)

    sk = sub.add_parser("wakes", help="只查某条消息的叫醒状态")
    sk.add_argument("--msg-id", required=True)
    sk.set_defaults(func=cmd_wakes)

    ns = p.parse_args(argv)
    return ns.func(ns)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
