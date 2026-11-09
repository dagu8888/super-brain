#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH二号@笔记本 自唤醒插件（waker）—— 值班室施工 #285。

职责（按 90-System/queue/dsh2/results/task-285-设计说明.md 双层架构）：
  发现层（本程序，零 LLM、零轮询）：
    1. SSE 长连网关 /api/stream?instance=DSH二号@笔记本（与 dsh2-courier.py 同一套连接逻辑）
    2. 变更信号 → GET /api/tasks 过滤 status=pending & type=assist & to_agent=dsh2-chief
    3. 每个新任务先 GET /api/tasks/<id> 复核状态：cancelled/非 pending 一律不投递（#257 教训）
    4. 幂等写待办文件 D:\\DSH\\AIOS-V4.0\\_duty\\todo\\task-<id>.todo
       （已存在 .todo / .claimed / .done 则跳过）
  执行层（不属本程序）：DSH 原生调度任务（值班巡查，每 20 分钟投递进 DSH二号会话）
    读取 .todo → 网关二次验状态 → rename .claimed → 执行 → 写 results/ 上云 → .done。

本程序只发现、只落盘：不执行任务、不调 LLM、不改任务状态、不碰 90-System/runtime/、
不碰 trae 队列、不碰 MAUS二号。

凭据纪律：SB_VIEWER_TOKEN 只走环境变量（与 dsh2-courier 共用），不读不写口令文件、不进日志。

用法：
  python dsh2-waker.py            # 常驻（默认）
  python dsh2-waker.py --once     # 单轮自检（发现即落盘后退出）
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

GATEWAY = "http://8.218.106.225:18765"
INSTANCE = "DSH二号@笔记本"
CHIEF = "dsh2-chief"
TODO_DIR = Path(r"D:\DSH\AIOS-V4.0\_duty\todo")
LOG = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "dsh2-waker.log"


def token():
    t = os.environ.get("SB_VIEWER_TOKEN", "").strip()
    if t:
        return t
    try:  # fallback: user env var persisted via setx (not inherited by long-lived sessions)
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, "SB_VIEWER_TOKEN")
        return (v or "").strip()
    except Exception:
        return ""


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg
    print(line, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def api_get(path):
    req = urllib.request.Request(GATEWAY + path, headers={
        "Authorization": "Bearer " + token(), "User-Agent": "dsh2-waker"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def todo_paths(tid):
    """同一任务的三个状态文件路径。"""
    return [TODO_DIR / ("task-%d%s" % (tid, sfx)) for sfx in (".todo", ".claimed", ".done")]


def already_delivered(tid):
    return any(p.exists() for p in todo_paths(tid))


def deliver_task(tid, detail):
    """复核通过后写待办文件（幂等）。"""
    p = detail.get("payload") or {}
    title = (p.get("title") or "").strip()
    text = p.get("text") or ""
    if not title:
        m = re.search(r"【(.+?)】", text)
        title = ("【" + m.group(1) + "】") if m else (text[:30] or "无标题")
    body = (
        "# 待办任务 #%d（waker 自动发现）\n\n"
        "- 来自：%s\n"
        "- 点名：%s（to_agent=%s）\n"
        "- 网关复核状态：%s（发现时点）\n"
        "- 创建：%s\n"
        "- 发现：%s\n\n"
        "## 正文\n\n%s\n\n"
        "## 执行约定\n\n"
        "领取时先经网关复核 status（非 pending 即放弃并改名 .done）；\n"
        "领取即 rename 为 .claimed（防跑两次）；完成后 rename 为 .done。\n"
        % (tid, p.get("from", "?"), INSTANCE, CHIEF,
           detail.get("status", "?"),
           time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(detail.get("created_at", 0))) if detail.get("created_at") else "?",
           time.strftime("%Y-%m-%d %H:%M:%S"), text))
    dst = TODO_DIR / ("task-%d.todo" % tid)
    dst.write_text(body, encoding="utf-8")
    log("TODO_WRITTEN task-%d.todo" % tid)


def discover_once():
    """拉一轮点名任务并落盘待办（幂等）。返回新投递的任务号列表。"""
    data = api_get("/api/tasks")
    tasks = data.get("data") or []
    TODO_DIR.mkdir(parents=True, exist_ok=True)
    delivered = []
    for t in tasks:
        if t.get("status") != "pending" or t.get("type") != "assist":
            continue
        tid = t["id"]
        if already_delivered(tid):
            continue
        detail = api_get("/api/tasks/%d" % tid).get("data") or {}
        p = detail.get("payload") or {}
        if (p.get("to_agent") or p.get("to")) != CHIEF:
            continue
        if detail.get("status") != "pending":       # 落盘前复核：cancelled/已完成不投递
            log("SKIP #%d 状态=%s（非 pending，不投递）" % (tid, detail.get("status")))
            continue
        deliver_task(tid, detail)
        delivered.append(tid)
    if not delivered:
        log("TICK 无新点名任务（幂等守恒）")
    return delivered


def stream_forever():
    """SSE 长连（发现层常驻）；断线指数退避 5→300s。"""
    backoff = 5
    while True:
        try:
            req = urllib.request.Request(
                GATEWAY + "/api/stream?instance=" + urllib.parse.quote(INSTANCE),
                headers={"Authorization": "Bearer " + token(), "Accept": "text/event-stream",
                         "User-Agent": "dsh2-waker"})
            log("SSE 已建立（waker 在场，instance=%s）" % INSTANCE)
            with urllib.request.urlopen(req, timeout=None) as r:
                backoff = 5
                discover_once()                      # 连上先补一轮
                for raw in r:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if line.startswith("data:"):
                        try:
                            discover_once()
                        except Exception as e:
                            log("DISCOVER_ERR " + str(e)[:120])
        except Exception as e:
            log("SSE 断开（%s），%ds 后重连" % (str(e)[:100], backoff))
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


if __name__ == "__main__":
    if not token():
        log("缺少 viewers 口令（环境变量 SB_VIEWER_TOKEN）——waker 凭据只走环境变量，不读口令文件")
        sys.exit(2)
    if "--once" in sys.argv:
        n = discover_once()
        log("ONCE 完成，本轮新投递 %d 个待办" % len(n))
        sys.exit(0)
    stream_forever()
