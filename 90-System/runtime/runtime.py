#!/usr/bin/env python3
# Super-agent 运行时骨架：Router + 3 Worker 常驻进程
# 职责：心跳登记（heartbeats 表）、任务队列（task_queue 表）、事件留痕（50-Events/）
# 任务处理器为占位实现：只登记、不改动用户内容文件；真正处理逻辑后续挂到 HANDLERS
# 用法: python3 runtime.py        （建议由 systemd 托管，见 super-brain.service）
import json
import os
import signal
import sqlite3
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # 仓库根目录
DB = Path(__file__).parent / "state.db"
INBOX = ROOT / "00-Inbox"
EVENTS_DIR = ROOT / "50-Events"
HEARTBEAT_INTERVAL = 60        # 心跳间隔（秒）；watchdog 判死线 15 分钟
SCAN_INTERVAL = 60             # Router 扫描 Inbox 间隔
WORKERS = ["chat-worker", "code-worker", "knowledge-worker"]
TASK_ROUTING = {"inbox-triage": "knowledge-worker"}   # 任务类型 → 负责 Worker

stop = threading.Event()


def db():
    conn = sqlite3.connect(DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")  # 读写并发更稳
    conn.execute("""CREATE TABLE IF NOT EXISTS heartbeats(
        agent TEXT PRIMARY KEY, ts INTEGER, note TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS task_queue(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT, payload TEXT, status TEXT DEFAULT 'pending',
        created_at INTEGER, claimed_by TEXT, claimed_at INTEGER,
        done_at INTEGER, result TEXT,
        UNIQUE(type, payload))""")
    conn.commit()
    return conn


def log_event(kind, **fields):
    EVENTS_DIR.mkdir(exist_ok=True)
    line = json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                       "kind": kind, **fields}, ensure_ascii=False)
    with open(EVENTS_DIR / f"runtime-{time.strftime('%Y-%m-%d')}.jsonl", "a") as f:
        f.write(line + "\n")


def heartbeat(conn, agent, note=""):
    conn.execute("INSERT INTO heartbeats(agent,ts,note) VALUES(?,?,?) "
                 "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts, note=excluded.note",
                 (agent, int(time.time()), note))
    conn.commit()


def handle(task_type, payload):
    # 占位处理器：只登记，不动用户文件。返回 result 字符串。
    if task_type == "inbox-triage":
        return f"已登记待整理：{payload}（等待 LLM 会话或人工整理，文件保持原位）"
    return "无处理器，已跳过"


def router_loop():
    conn = db()
    while not stop.is_set():
        heartbeat(conn, "router", "scanning")
        if INBOX.exists():
            for f in sorted(INBOX.glob("*.md")):
                if f.name == "README.md":
                    continue
                cur = conn.execute(
                    "INSERT OR IGNORE INTO task_queue(type,payload,created_at) VALUES(?,?,?)",
                    ("inbox-triage", str(f.relative_to(ROOT)), int(time.time())))
                if cur.rowcount:
                    log_event("task_enqueued", type="inbox-triage", payload=str(f.relative_to(ROOT)))
            conn.commit()  # 立即提交，避免长事务锁库阻塞 Worker 心跳
        stop.wait(SCAN_INTERVAL)


def worker_loop(name):
    conn = db()
    my_types = [t for t, w in TASK_ROUTING.items() if w == name]
    while not stop.is_set():
        heartbeat(conn, name, "idle")
        for t in my_types:
            row = conn.execute(
                "SELECT id,payload FROM task_queue WHERE type=? AND status='pending' ORDER BY id LIMIT 1",
                (t,)).fetchone()
            if not row:
                continue
            tid, payload = row
            conn.execute("UPDATE task_queue SET status='doing', claimed_by=?, claimed_at=? WHERE id=?",
                         (name, int(time.time()), tid))
            conn.commit()
            log_event("task_claimed", id=tid, type=t, by=name)
            try:
                result = handle(t, payload)
                conn.execute("UPDATE task_queue SET status='done', done_at=?, result=? WHERE id=?",
                             (int(time.time()), result, tid))
                log_event("task_done", id=tid, type=t, by=name, result=result)
            except Exception as e:  # noqa
                conn.execute("UPDATE task_queue SET status='failed', done_at=?, result=? WHERE id=?",
                             (int(time.time()), str(e)[:200], tid))
                log_event("task_failed", id=tid, type=t, by=name, error=str(e)[:200])
            conn.commit()
        stop.wait(5)


def guard(fn, name):
    try:
        fn()
    except Exception as e:  # noqa
        log_event("thread_crashed", thread=name, error=str(e)[:300])


def main():
    db().close()  # 先建表，避免线程并发初始化竞争
    threads = [threading.Thread(target=guard, args=(router_loop, "router"), name="router", daemon=True)]
    threads += [threading.Thread(target=guard, args=(lambda w=w: worker_loop(w), w), name=w, daemon=True)
                for w in WORKERS]
    for t in threads:
        t.start()
    log_event("runtime_started", agents=["router"] + WORKERS, pid=os.getpid())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        stop.wait(1)
    log_event("runtime_stopped", pid=os.getpid())


if __name__ == "__main__":
    sys.exit(main())
