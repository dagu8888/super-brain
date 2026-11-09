#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH二号@笔记本 节点信使（courier）—— 笔记本侧最小实现，仅标准库。

与 dsh1-courier.py 同一套程序，按实例参数化（DSH一号建议 A1 复用，见
60-Outputs/receipts/2026-11-09-dsh1-接入报告.md）。与 trae 信使并行不悖：
不同实例、不同队列目录，互不触碰。

职责（按 90-System/queue/README.md 交接面约定）：
  1. SSE 长连接网关 /api/stream?instance=DSH二号@笔记本 —— 在线心跳 + 变更信号（不轮询）
  2. 变更信号到达 → 拉只读 /api/tasks → 过滤 to_agent=dsh2-chief 的 pending 任务
     → 写 queue/dsh2/task-<id>-<slug>.md（幂等：按 id 查重；done/ 有同 id 则跳过）
  3. 会话侧写 queue/dsh2/results/task-<id>-结果.md 后，由服务端信使收口（本程序只做投递，
     不改任务状态：/cmd 需要 dsh2-chief 专属口令，未交付时本程序绝不用替代凭据越权）

凭据纪律：viewers 口令只从环境变量 SB_VIEWER_TOKEN 或本机用户目录配置文件读取，
           不写入仓库、不出现在日志与回写文件。

用法：
  python dsh2-courier.py                 # 常驻（默认）
  python dsh2-courier.py --once          # 跑一轮即退出（自检/演练用）
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
ROOT = Path(__file__).resolve().parents[2]          # repo root
QDIR = ROOT / "90-System" / "queue" / "dsh2"
LOG = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "dsh2-courier.log"
TOKEN_FILE = Path(os.environ.get("USERPROFILE", str(Path.home()))) / ".dsh2-courier.json"


def token():
    t = os.environ.get("SB_VIEWER_TOKEN", "").strip()
    if t:
        return t
    try:
        return json.loads(TOKEN_FILE.read_text(encoding="utf-8")).get("viewer_token", "").strip()
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
        "Authorization": "Bearer " + token(), "User-Agent": "dsh2-courier"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def slug(text, n=28):
    s = re.sub(r"[^\w一-鿿-]+", "-", str(text or "")).strip("-")
    return s[:n] or "task"


def write_task_files():
    """拉 pending 任务，点名 dsh2-chief 的落 queue/dsh2/task-<id>-<slug>.md（幂等）。"""
    data = api_get("/api/tasks")
    tasks = data.get("data") or []
    QDIR.mkdir(parents=True, exist_ok=True)
    done_dir = QDIR / "done"
    written = []
    for t in tasks:
        if t.get("status") != "pending" or t.get("type") != "assist":
            continue
        detail = api_get("/api/tasks/%d" % t["id"]).get("data") or {}
        p = detail.get("payload") or {}
        if (p.get("to_agent") or p.get("to")) != CHIEF:
            continue
        tid = t["id"]
        if (done_dir / ("task-%d" % tid)).exists() or list(done_dir.glob("task-%d-*" % tid)):
            continue
        if list(QDIR.glob("task-%d-*.md" % tid)):
            continue
        fname = "task-%d-%s.md" % (tid, slug(p.get("text")))
        body = ("# 任务 #%d\n\n- 来自：%s\n- 点名：%s\n- 创建：%d\n- 状态：%s\n\n## 正文\n\n%s\n\n"
                "## 回写\n\n结果写到 `90-System/queue/dsh2/results/task-%d-结果.md`（服务端信使收口）\n"
                % (tid, p.get("from", "?"), INSTANCE, t.get("created_at", 0), t.get("status"),
                   p.get("text", ""), tid))
        (QDIR / fname).write_text(body, encoding="utf-8")
        written.append(fname)
        log("QUEUE_WRITTEN %s" % fname)
    if not written:
        log("TICK 无新增点名任务（已投递文件保持幂等）")
    return written


def stream_forever():
    """SSE 长连接：在线心跳 + 变更信号；断线指数退避重连（自愈）。"""
    backoff = 5
    while True:
        try:
            req = urllib.request.Request(
                GATEWAY + "/api/stream?instance=" + urllib.parse.quote(INSTANCE),
                headers={"Authorization": "Bearer " + token(), "Accept": "text/event-stream",
                         "User-Agent": "dsh2-courier"})
            log("SSE 连接 %s as %s" % (GATEWAY, INSTANCE))
            with urllib.request.urlopen(req, timeout=None) as r:
                backoff = 5
                write_task_files()          # 连上先补一次
                for raw in r:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if line.startswith("data:"):
                        try:
                            write_task_files()
                        except Exception as e:
                            log("TASK_SYNC_ERR " + str(e)[:120])
                    # 注释行 : keepalive 仅维持连接，不触发动作
        except Exception as e:
            log("SSE 断开（%s），%ds 后重连" % (str(e)[:100], backoff))
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


if __name__ == "__main__":

    if not token():
        log("缺少 viewers 口令（SB_VIEWER_TOKEN 或 %s）" % TOKEN_FILE)
        sys.exit(2)
    if "--once" in sys.argv:
        n = write_task_files()
        log("ONCE 完成，新增 %d 个任务文件" % len(n))
        sys.exit(0)
    stream_forever()
