#!/usr/bin/env python3
# Agent 自报「当前在做什么」。只认这条记录或任务租约为忙碌；心跳不算。
# 超过 STALE_SECONDS 未更新则不再显示为忙碌（防止忘了 clear）。
import json
import time

STALE_SECONDS = 2 * 3600
SCHEMA = """
CREATE TABLE IF NOT EXISTS current_work(
  agent_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT,
  task_id INTEGER,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT
);
"""


def ensure_schema(conn):
    conn.executescript(SCHEMA)


def _now():
    return int(time.time())


def set_work(conn, agent_id, args):
    ensure_schema(conn)
    title = str(args.get("title") or args.get("text") or args.get("work") or "").strip()[:200]
    if not title:
        return {"ok": False, "error": "上报工作必带 title 或 text"}
    detail = str(args.get("detail") or "")[:2000]
    tid = args.get("task_id")
    try:
        tid = int(tid) if tid not in (None, "") else None
    except (TypeError, ValueError):
        return {"ok": False, "error": "task_id 必须是整数"}
    now = _now()
    row = conn.execute("SELECT started_at FROM current_work WHERE agent_id=?", (agent_id,)).fetchone()
    started = row[0] if row else now
    conn.execute(
        "INSERT INTO current_work(agent_id,title,detail,task_id,started_at,updated_at,source) "
        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET "
        "title=excluded.title, detail=excluded.detail, task_id=excluded.task_id, "
        "updated_at=excluded.updated_at, source=excluded.source, "
        "started_at=CASE WHEN current_work.title=excluded.title THEN current_work.started_at ELSE excluded.started_at END",
        (agent_id, title, detail, tid, started, now, str(args.get("source") or "cmd")[:40]))
    conn.commit()
    return {"ok": True, "agent_id": agent_id, "title": title, "task_id": tid, "started_at": started, "updated_at": now}


def clear(conn, agent_id):
    ensure_schema(conn)
    conn.execute("DELETE FROM current_work WHERE agent_id=?", (agent_id,))
    conn.commit()
    return {"ok": True, "agent_id": agent_id, "cleared": True}


def get_work(conn, agent_id, now=None):
    ensure_schema(conn)
    now = int(now or _now())
    row = conn.execute(
        "SELECT agent_id,title,detail,task_id,started_at,updated_at,source FROM current_work WHERE agent_id=?",
        (agent_id,)).fetchone()
    return {"ok": True, "work": _row(row, now)}


def _row(row, now):
    if not row:
        return None
    age = now - int(row[5] or 0)
    if age > STALE_SECONDS:
        return None
    return {"agent_id": row[0], "title": row[1], "detail": row[2] or "", "task_id": row[3],
            "started_at": row[4], "updated_at": row[5], "source": row[6], "age_seconds": age}


def load_all(conn, now=None):
    ensure_schema(conn)
    now = int(now or _now())
    out = {}
    for row in conn.execute(
            "SELECT agent_id,title,detail,task_id,started_at,updated_at,source FROM current_work"):
        w = _row(row, now)
        if w:
            out[row[0]] = w
    return out
