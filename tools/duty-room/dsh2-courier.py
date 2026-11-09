#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH二号@笔记本 在场心跳（heartbeat）—— 笔记本侧最小实现，仅标准库。

机制修正（2026-11-09 古大当面纠正，原接入指令第 3 步作废）：
  信使只有一份、跑在服务器里，不在任何节点电脑上部署。本机职责只有两件：
    1. 保持仓库同步 —— 点名本实例的新任务以文件形式出现在 90-System/queue/dsh2/，
       git 同步即可看见（投递与收口全部由服务器信使经 git 完成）。
    2. 条件允许时挂一条 GET /api/stream?instance=DSH二号@笔记本 的长连接作在场心跳
       （本脚本：SSE 长连 + 断线指数退避自愈，不轮询、不调 LLM、不写任何队列文件）。

报完成走文件路：结果写 queue/dsh2/results/task-<任务号>-结果.md 并同步回仓库
（.gitignore 忽略 queue/*，需 git add -f，与 #229/#230 同式）；
progress 指令只读查进度，不能报完成。

凭据纪律：viewers 口令只从环境变量 SB_VIEWER_TOKEN 或本机用户目录配置文件读取，
           不写入仓库、不出现在日志与回写文件。

用法：
  python dsh2-courier.py                 # 常驻心跳（默认）
  python dsh2-courier.py --once          # 连通自检：连上即报在场并退出
"""
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

GATEWAY = "http://8.218.106.225:18765"
INSTANCE = "DSH二号@笔记本"
ROOT = Path(__file__).resolve().parents[2]          # repo root（保持同步由 git 完成）
LOG = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "dsh2-courier.log"
TOKEN_FILE = Path(os.environ.get("USERPROFILE", str(Path.home()))) / ".dsh2-courier.json"


def token():
    t = os.environ.get("SB_VIEWER_TOKEN", "").strip()
    if t:
        return t
    try:
        return json.loads(TOKEN_FILE.read_text(encoding="utf-8")).get("viewer_token", "").strip()
    except Exception:
        pass
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


def stream_forever():
    """SSE 长连接在场心跳；断线指数退避重连（自愈）。不读任务、不写文件。"""
    backoff = 5
    while True:
        try:
            req = urllib.request.Request(
                GATEWAY + "/api/stream?instance=" + urllib.parse.quote(INSTANCE),
                headers={"Authorization": "Bearer " + token(), "Accept": "text/event-stream",
                         "User-Agent": "dsh2-heartbeat"})
            log("SSE 心跳连接 %s as %s" % (GATEWAY, INSTANCE))
            with urllib.request.urlopen(req, timeout=None) as r:
                backoff = 5
                log("SSE 已建立（在场心跳中）")
                for _ in r:
                    pass    # keepalive 行仅维持连接；任务投递走 git 同步，不做任何动作
        except Exception as e:
            log("SSE 断开（%s），%ds 后重连" % (str(e)[:100], backoff))
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


if __name__ == "__main__":

    if not token():
        log("缺少 viewers 口令（SB_VIEWER_TOKEN 或 %s）" % TOKEN_FILE)
        sys.exit(2)
    if "--once" in sys.argv:
        req = urllib.request.Request(
            GATEWAY + "/api/stream?instance=" + urllib.parse.quote(INSTANCE),
            headers={"Authorization": "Bearer " + token(), "Accept": "text/event-stream",
                     "User-Agent": "dsh2-heartbeat"})
        with urllib.request.urlopen(req, timeout=20) as r:
            log("ONCE 自检：连接成功（在场正常），即断开退出")
        sys.exit(0)
    stream_forever()
