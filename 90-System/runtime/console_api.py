#!/usr/bin/env python3
# Super-Brain 3.0 控制台只读适配层（console_api）
# 设计原则：只读、不解耦 Runtime、不改 /cmd；由 api_server 的 GET 路由调用。
# 认证：api_tokens.json 中 viewers 字段里的口令（只读），或任意 chief 口令（兼容调试）。
# 端点：/api/overview /api/agents /api/agents/{id} /api/tasks /api/tasks/{id}
#       /api/events /api/monitor /api/knowledge /api/memory
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE = ROOT / "10-Knowledge"
EVENTS_DIR = ROOT / "50-Events"
OFFLINE_SECONDS = 300          # 心跳超过 5 分钟视为离线
_PUBLIC_FIELDS = ("event_id", "source", "type", "priority", "status", "created_at")


def _rows(cur):
    return [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]


def _agent_status(last_seen, busy, kind="worker"):
    # chief 是"入口身份"，不常驻进程，last_seen 只代表最近调用时间，不判离线
    if kind != "chief" and (not last_seen or time.time() - int(last_seen) > OFFLINE_SECONDS):
        return "offline"
    return "working" if busy else "idle"


def _frontmatter(path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:2000]
    except Exception:
        return {}
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip().strip("[]")
    return out


def handle_get(conn, raw_path):
    """返回 (http_code, dict)。conn 为新建的 sqlite3 连接。"""
    u = urlparse(raw_path)
    path, q = u.path.rstrip("/") or "/", {k: v[0] for k, v in parse_qs(u.query).items()}
    now = int(time.time())

    def ok(data, **extra):
        return 200, {"ok": True, "ts": now, "data": data, **extra}

    if path == "/api/overview":
        busy = {r[0] for r in conn.execute(
            "SELECT lease_owner FROM tasks WHERE status='doing' AND lease_owner IS NOT NULL")}
        agents = _rows(conn.execute(
            "SELECT agent_id,kind,status,last_seen FROM agents WHERE status='active' "
            "ORDER BY kind,agent_id"))
        for a in agents:
            a["live_status"] = _agent_status(a["last_seen"], a["agent_id"] in busy, a["kind"])
        tasks = dict(conn.execute("SELECT status,COUNT(*) FROM tasks GROUP BY status").fetchall())
        today0 = int(time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)))
        ev = conn.execute("SELECT COUNT(*) FROM events WHERE created_at>=?", (today0,)).fetchone()[0]
        return ok({
            "agents_total": len(agents),
            "agents_online": sum(1 for a in agents if a["live_status"] != "offline"),
            "agents_working": sum(1 for a in agents if a["live_status"] == "working"),
            "tasks": tasks,
            "tasks_running": tasks.get("doing", 0),
            "tasks_pending": tasks.get("pending", 0),
            "tasks_failed": tasks.get("failed", 0) + tasks.get("dead", 0),
            "events_today": ev,
        })

    if path == "/api/agents":
        busy = {r[0]: r[1] for r in conn.execute(
            "SELECT lease_owner, id FROM tasks WHERE status='doing' AND lease_owner IS NOT NULL")}
        out = []
        for a in _rows(conn.execute("SELECT * FROM agents ORDER BY kind,agent_id")):
            try:
                a["capabilities"] = json.loads(a["capabilities"] or "[]")
                a["task_types"] = json.loads(a["task_types"] or "[]")
                a["permissions"] = json.loads(a["permissions"] or "{}")
            except Exception:
                pass
            a["live_status"] = _agent_status(a["last_seen"], a["agent_id"] in busy, a["kind"])
            a["current_task_id"] = busy.get(a["agent_id"])
            out.append(a)
        return ok(out)

    m = re.fullmatch(r"/api/agents/([\w.-]+)", path)
    if m:
        a = conn.execute("SELECT * FROM agents WHERE agent_id=?", (m.group(1),)).fetchone()
        if not a:
            return 404, {"ok": False, "error": "agent 不存在"}
        cols = [d[0] for d in conn.execute("SELECT * FROM agents LIMIT 0").description]
        d = dict(zip(cols, a))
        for k in ("capabilities", "task_types", "permissions"):
            try:
                d[k] = json.loads(d[k] or "[]")
            except Exception:
                pass
        hist = _rows(conn.execute(
            "SELECT id,type,status,created_at,done_at FROM tasks WHERE lease_owner=? "
            "ORDER BY id DESC LIMIT 10", (d["agent_id"],)))
        return ok({**d, "recent_tasks": hist})

    if path == "/api/tasks":
        limit = min(int(q.get("limit", 50)), 200)
        offset = max(int(q.get("offset", 0)), 0)
        where, args = [], []
        if q.get("status"):
            where.append("status=?")
            args.append(q["status"])
        if q.get("type"):
            where.append("type=?")
            args.append(q["type"])
        if q.get("agent"):
            where.append("lease_owner=?")
            args.append(q["agent"])
        w = ("WHERE " + " AND ".join(where)) if where else ""
        rows = _rows(conn.execute(
            f"SELECT id,type,status,priority,lease_owner,retry_count,created_at,done_at,"
            f"substr(COALESCE(result,error),1,200) AS summary FROM tasks {w} "
            f"ORDER BY id DESC LIMIT ? OFFSET ?", (*args, limit, offset)))
        total = conn.execute(f"SELECT COUNT(*) FROM tasks {w}", args).fetchone()[0]
        return ok(rows, total=total, limit=limit, offset=offset)

    m = re.fullmatch(r"/api/tasks/(\d+)", path)
    if m:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (int(m.group(1)),)).fetchone()
        if not row:
            return 404, {"ok": False, "error": "任务不存在"}
        cols = [d[0] for d in conn.execute("SELECT * FROM tasks LIMIT 0").description]
        d = dict(zip(cols, row))
        try:
            d["payload"] = json.loads(d["payload"] or "{}")
        except Exception:
            pass
        evs = _rows(conn.execute(
            "SELECT event_id,source,type,status,created_at FROM events WHERE parent_id=? "
            "OR event_id=? ORDER BY created_at DESC LIMIT 20", (d["event_id"], d["event_id"])))
        return ok({**d, "events": evs})

    if path == "/api/events":
        limit = min(int(q.get("limit", 50)), 200)
        where, args = [], []
        if q.get("since"):
            where.append("created_at>?")
            args.append(int(q["since"]))
        if q.get("type"):
            where.append("type=?")
            args.append(q["type"])
        w = ("WHERE " + " AND ".join(where)) if where else ""
        rows = _rows(conn.execute(
            "SELECT event_id,source,type,priority,status,parent_id,created_at "
            f"FROM events {w} ORDER BY created_at DESC, rowid DESC LIMIT ?", (*args, limit)))
        return ok(rows)

    if path == "/api/monitor":
        hb = _rows(conn.execute("SELECT agent,ts,note FROM heartbeats ORDER BY agent"))
        for h in hb:
            h["age_seconds"] = now - int(h["ts"] or 0)
        queue = dict(conn.execute("SELECT status,COUNT(*) FROM tasks GROUP BY status").fetchall())
        health = None
        try:
            files = sorted(EVENTS_DIR.glob("health-*.jsonl"))
            if files:
                health = json.loads(files[-1].read_text(encoding="utf-8").strip().splitlines()[-1])
        except Exception:
            pass
        sysinfo = {}
        try:
            sysinfo["loadavg"] = [round(float(x), 2) for x in open("/proc/loadavg").read().split()[:3]]
            mem = {}
            for line in open("/proc/meminfo"):
                k, v = line.split(":", 1)
                mem[k] = int(v.strip().split()[0])
            sysinfo["mem_total_mb"] = mem.get("MemTotal", 0) // 1024
            sysinfo["mem_available_mb"] = mem.get("MemAvailable", 0) // 1024
        except Exception:
            pass
        return ok({"heartbeats": hb, "queue": queue, "health": health, "system": sysinfo})

    if path == "/api/knowledge":
        limit = min(int(q.get("limit", 100)), 500)
        items = []
        for p in sorted(KNOWLEDGE.rglob("*.md"))[-limit:]:
            fm = _frontmatter(p)
            items.append({
                "path": str(p.relative_to(ROOT)),
                "title": fm.get("title") or p.stem,
                "category": fm.get("category") or p.parent.name,
                "tags": [t for t in re.split(r",\s*", fm.get("tags", "")) if t],
                "quality": fm.get("quality", ""),
                "updated": fm.get("updated", ""),
                "size": p.stat().st_size,
            })
        return ok(items, total=len(items))

    if path == "/api/memory":
        rows = _rows(conn.execute(
            "SELECT thread_id,worker,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 100"))
        agents = _rows(conn.execute(
            "SELECT agent_id,last_seen FROM agents WHERE last_seen IS NOT NULL ORDER BY last_seen DESC"))
        return ok({"sessions": rows, "agent_memory": agents})

    return 404, {"ok": False, "error": "not found"}
