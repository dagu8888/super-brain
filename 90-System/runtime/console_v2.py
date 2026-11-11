#!/usr/bin/env python3
# Super-Brain 操作台 v2 只读聚合层（console_v2）
# 只读：不写库、不改 /cmd、不碰口令。由 console_api.handle_get 分发。
# 端点：
#   /api/dashboard           KPI、各 Agent 异常计数、点名历史（含各节点首回耗时）、近 24h 消息分时、消息连线
#   /api/server              服务器健康：运行时长、负载、内存、磁盘、数据库体积、证书到期
#   /api/messages?agent=<id> 某 Agent 收发的最近消息（新→旧），供详情抽屉
#   /api/approvals           审批中心：approvals 表 + 待拍板任务（只读）
#   /api/audit               大古写操作审计（只读，不含 IP）
#   /api/chat                指挥官对话线程：大古 ↔ grok-chief（旧→新）
#   /api/projects            项目 / 阶段 / 完成度（按阶段验收真实计算）
# 口径（与手册第 5 章一致，不冒充）：
#   在线 = 5 分钟内有心跳 / last_seen / 名册实例心跳（同 console_api._annotate_agent）；
#   执行中 = 只认 tasks.status='doing' 且 lease_owner=该 Agent，心跳不算执行；
#   死信 = 点名该 Agent（payload.to_agent / payload.to → 名册折回）的 dead 任务数；
#   未认领 = 点名该 Agent、pending、无人领取且超过 10 分钟的任务数；
#   心跳过期 = 该 Agent 曾接入过、但现在超过 5 分钟没有任何在场信号（实例逐个计）。
import glob
import os
import shutil
import ssl
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import console_api
import message_bus
import owner_ops

OFFLINE_SECONDS = console_api.OFFLINE_SECONDS
UNCLAIMED_SECONDS = 600
DEAD_CACHE_SECONDS = 300           # 死信是历史存量（十几万行），5 分钟算一次
SERVER_CACHE_SECONDS = 30
CERT_CACHE_SECONDS = 3600
CERT_GLOB = os.environ.get(
    "SB_CERT_GLOB",
    "/var/lib/caddy/.local/share/caddy/certificates/*/*/*.crt")
_CACHE = {}
_PROC_START = time.time()


def _cached(key, ttl, fn):
    hit = _CACHE.get(key)
    now = time.time()
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    _CACHE[key] = (now, val)
    return val


def clear_cache():
    _CACHE.clear()


def _instance_map(conn):
    try:
        return {n: (r or "") for n, r in conn.execute(
            "SELECT name, agent_ref FROM registry WHERE kind='instance'")}
    except Exception:
        return {}


def _target_sql():
    # 任务点名对象：to_agent 优先，其次 to（可能是实例名，再经名册折回）
    return ("COALESCE(NULLIF(json_extract(payload,'$.to_agent'),''),"
            "NULLIF(json_extract(payload,'$.to'),''), lease_owner)")


def _fold(name, inst_map, agent_ids):
    if not name:
        return None
    if name in agent_ids:
        return name
    ref = inst_map.get(name)
    return ref or None


def _dead_by_agent(conn, inst_map, agent_ids):
    def calc():
        out, unassigned, total = {}, 0, 0
        try:
            rows = conn.execute(
                f"SELECT {_target_sql()} AS tgt, COUNT(*) FROM tasks WHERE status='dead' GROUP BY tgt"
            ).fetchall()
        except Exception:
            rows = []
        for tgt, n in rows:
            total += n
            aid = _fold(tgt, inst_map, agent_ids)
            if aid:
                out[aid] = out.get(aid, 0) + n
            else:
                unassigned += n
        return {"by_agent": out, "unassigned": unassigned, "total": total}
    return _cached("dead", DEAD_CACHE_SECONDS, calc)


def _unclaimed_by_agent(conn, inst_map, agent_ids, now):
    out, unassigned, total = {}, 0, 0
    try:
        rows = conn.execute(
            f"SELECT {_target_sql()} AS tgt, COUNT(*) FROM tasks "
            "WHERE status='pending' AND lease_owner IS NULL AND created_at<=? GROUP BY tgt",
            (now - UNCLAIMED_SECONDS,)).fetchall()
    except Exception:
        rows = []
    for tgt, n in rows:
        total += n
        aid = _fold(tgt, inst_map, agent_ids)
        if aid:
            out[aid] = out.get(aid, 0) + n
        else:
            unassigned += n
    return {"by_agent": out, "unassigned": unassigned, "total": total}


def _agents(conn, now):
    busy = {}
    for tid, owner in conn.execute(
            "SELECT id, lease_owner FROM tasks WHERE status='doing' AND lease_owner IS NOT NULL"):
        busy.setdefault(owner, []).append(tid)
    beats, by_ref = console_api._load_presence(conn)
    rows = console_api._rows(conn.execute(
        "SELECT agent_id, kind, status, last_seen FROM agents ORDER BY kind, agent_id"))
    for a in rows:
        console_api._annotate_agent(a, a["agent_id"] in busy, beats, by_ref, now)
        a["doing_task_ids"] = busy.get(a["agent_id"], [])
    return rows


def _stale(agent, now):
    """心跳过期计数：曾接入过、但当前无在场信号。实例逐个计；无实例按 Agent 自身计 1。"""
    if agent.get("status") != "active":
        return 0
    insts = agent.get("instances") or []
    if insts and agent.get("live_status") not in ("idle", "working"):
        return sum(1 for i in insts
                   if i.get("registry_status") == "active" and i.get("heartbeat_at")
                   and now - int(i["heartbeat_at"]) > OFFLINE_SECONDS) or (
            1 if agent.get("ever_connected") else 0)
    if not insts and agent.get("live_status") == "offline":
        return 1
    return 0


def _first_replies(rc):
    """同一节点对同一点名多次回复（重放）时，只取第一条算耗时，另计重复数。"""
    firsts, dup = {}, 0
    for r in rc.get("replies") or []:
        key = r.get("from_instance") or r.get("from_agent")
        if key in firsts:
            dup += 1
            continue
        firsts[key] = {
            "from_agent": r.get("from_agent"),
            "from_instance": r.get("from_instance"),
            "latency_seconds": r.get("latency_seconds"),
            "created_at": r.get("created_at"),
            "text": (r.get("text") or "")[:120],
        }
    return list(firsts.values()), dup


def _rollcalls(conn, limit=8):
    pings = conn.execute(
        "SELECT msg_id FROM messages WHERE kind='ping' ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (limit,)).fetchall()
    out = []
    for (mid,) in pings:
        rc = message_bus.rollcall(conn, mid)
        if not rc:
            continue
        firsts, dup = _first_replies(rc)
        lat = sorted(x["latency_seconds"] for x in firsts if x["latency_seconds"] is not None)
        out.append({
            "msg_id": mid,
            "from_agent": rc["ping"]["from_agent"],
            "to": rc["ping"]["to"],
            "text": (rc["ping"]["text"] or "")[:120],
            "created_at": rc["ping"]["created_at"],
            "expected_count": len(rc["expected"]),
            "replied_nodes": len(firsts),
            "duplicate_replies": dup,
            "missing": [{"agent_id": m["agent_id"], "instance": m["instance"],
                         "online": m["online"]} for m in rc["missing"]],
            "missing_online_count": rc["missing_online_count"],
            "replies": firsts,
            "latency_median": lat[len(lat) // 2] if lat else None,
            "latency_max": lat[-1] if lat else None,
        })
    return out


def _message_stats(conn, now, inst_map):
    def count(since):
        return conn.execute("SELECT COUNT(*) FROM messages WHERE created_at>=?", (since,)).fetchone()[0]
    hours = [0] * 24
    h0 = now - 24 * 3600
    for (ts,) in conn.execute("SELECT created_at FROM messages WHERE created_at>=?", (h0,)):
        i = int((int(ts) - h0) // 3600)
        if 0 <= i < 24:
            hours[i] += 1
    links = {}
    for fa, fi, to, n, last in conn.execute(
            'SELECT from_agent, from_instance, "to", COUNT(*), MAX(created_at) FROM messages '
            "WHERE created_at>=? GROUP BY 1,2,3", (h0,)):
        dst = to if to == "all" else (inst_map.get(to) or to)
        key = (fa, dst)
        cur = links.setdefault(key, {"from": fa, "to": dst, "count_24h": 0, "last_at": 0})
        cur["count_24h"] += n
        cur["last_at"] = max(cur["last_at"], int(last or 0))
    recent = [message_bus._row(r) for r in conn.execute(
        'SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at '
        "FROM messages ORDER BY created_at DESC, rowid DESC LIMIT 80")]
    for r in recent:
        if r.get("text") and len(r["text"]) > 400:
            r["text"] = r["text"][:400] + "…"
    total = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    return {
        "msgs_1h": count(now - 3600),
        "msgs_24h": count(h0),
        "msgs_total": total,
        "hourly_24h": hours,
        "hourly_start": h0,
        "links_24h": sorted(links.values(), key=lambda x: -x["count_24h"]),
        "recent": list(reversed(recent)),
    }


def dashboard(conn, now=None):
    now = int(now or time.time())
    message_bus.ensure_schema(conn)
    agents = _agents(conn, now)
    ids = {a["agent_id"] for a in agents}
    inst_map = _instance_map(conn)
    dead = _dead_by_agent(conn, inst_map, ids)
    unclaimed = _unclaimed_by_agent(conn, inst_map, ids, now)
    active = [a for a in agents if a.get("status") == "active"]
    import current_work
    works = current_work.load_all(conn, now)
    owner_ops.ensure_schema(conn)
    appr_by = {}
    for req, kind, n in conn.execute(
            "SELECT requester, kind, COUNT(*) FROM approvals WHERE status='pending' GROUP BY 1,2"):
        d = appr_by.setdefault(req, {"approval": 0, "assist": 0})
        d[kind or "approval"] = d.get(kind or "approval", 0) + n
    out_agents = []
    stale_total = 0
    for a in agents:
        st = _stale(a, now)
        stale_total += st
        an = {"dead": dead["by_agent"].get(a["agent_id"], 0),
              "unclaimed": unclaimed["by_agent"].get(a["agent_id"], 0),
              "stale": st}
        an["total"] = an["dead"] + an["unclaimed"] + an["stale"]
        w = works.get(a["agent_id"])
        ap = appr_by.get(a["agent_id"], {})
        live = a["live_status"]
        online = live in ("idle", "working")
        # 细分状态：忙碌只认任务租约或自报工作；心跳只说明在线
        if a["status"] != "active":
            detail = {"state": "paused", "label": "已暂停"}
        elif not online:
            detail = {"state": "offline" if a["ever_connected"] else "unused",
                      "label": "离线" if a["ever_connected"] else "未接入",
                      "since": a["presence_at"]}
        elif a["doing_task_ids"] or w:
            detail = {"state": "busy", "label": "忙碌",
                      "work": (w or {}).get("title") or ("执行任务 #%s" % a["doing_task_ids"][0]),
                      "work_source": "self_report" if w else "task_lease",
                      "since": (w or {}).get("started_at")}
        else:
            idle_since = max([x for x in (
                conn.execute("SELECT MAX(created_at) FROM messages WHERE from_agent=?", (a["agent_id"],)).fetchone()[0],
                conn.execute("SELECT MAX(done_at) FROM tasks WHERE lease_owner=? AND status IN ('done','failed')",
                             (a["agent_id"],)).fetchone()[0]) if x] or [None])
            detail = {"state": "idle", "label": "空闲", "idle_since": idle_since}
        out_agents.append({
            "state": detail,
            "current_work": w,
            "pending_approvals": ap.get("approval", 0),
            "pending_assists": ap.get("assist", 0),
            "agent_id": a["agent_id"],
            "kind": a["kind"],
            "status": a["status"],
            "live_status": a["live_status"],
            "presence_at": a["presence_at"],
            "presence_via": a["presence_via"],
            "ever_connected": a["ever_connected"],
            "doing_task_ids": a["doing_task_ids"],
            "instances": [{k: i.get(k) for k in
                           ("name", "location", "registry_status", "heartbeat_at", "note", "online")}
                          for i in a.get("instances") or []],
            "anomalies": an,
        })
    msg = _message_stats(conn, now, inst_map)
    rollcalls = _rollcalls(conn)
    try:
        queue = dict(conn.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall())
    except Exception:
        queue = {}
    ev = lambda s: conn.execute("SELECT COUNT(*) FROM events WHERE created_at>=?", (s,)).fetchone()[0]
    online = [a for a in active if a["live_status"] in ("idle", "working")]
    owner_ops.ensure_schema(conn)
    appr_pending = conn.execute("SELECT COUNT(*) FROM approvals WHERE status='pending'").fetchone()[0]
    dec_tasks = conn.execute("SELECT COUNT(*) FROM tasks WHERE status='pending' AND (priority>=1 OR type='fuse-review')").fetchone()[0]
    return {
        "console_rev": 2,
        "now": now,
        "kpi": {
            "agents_total": len(active),
            "agents_online": len(online),
            "agents_working": sum(1 for a in active if a["live_status"] == "working"),
            "chiefs_online": sum(1 for a in online if a["kind"] == "chief"),
            "chiefs_total": sum(1 for a in active if a["kind"] == "chief"),
            "msgs_1h": msg["msgs_1h"],
            "msgs_24h": msg["msgs_24h"],
            "msgs_total": msg["msgs_total"],
            "events_1h": ev(now - 3600),
            "events_24h": ev(now - 86400),
            "anomalies": {
                "dead": dead["total"],
                "dead_unassigned": dead["unassigned"],
                "unclaimed": unclaimed["total"],
                "stale": stale_total,
                "total": dead["total"] + unclaimed["total"] + stale_total,
            },
            "queue": queue,
            "approvals_pending": appr_pending,
            "decision_tasks": dec_tasks,
        },
        "agents": out_agents,
        "rollcalls": rollcalls,
        "last_rollcall": rollcalls[0] if rollcalls else None,
        "messages": msg,
        "rules": {
            "offline_seconds": OFFLINE_SECONDS,
            "unclaimed_seconds": UNCLAIMED_SECONDS,
            "dead_cache_seconds": DEAD_CACHE_SECONDS,
        },
    }


def agent_messages(conn, agent_id, limit=40):
    message_bus.ensure_schema(conn)
    names = [agent_id]
    try:
        names += [n for (n,) in conn.execute(
            "SELECT name FROM registry WHERE kind='instance' AND agent_ref=?", (agent_id,))]
    except Exception:
        pass
    ph = ",".join("?" * len(names))
    rows = conn.execute(
        'SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at '
        f'FROM messages WHERE from_agent=? OR "to" IN ({ph}) '
        "ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (agent_id, *names, int(limit))).fetchall()
    out = [message_bus._row(r) for r in rows]
    for r in out:
        if r.get("text") and len(r["text"]) > 600:
            r["text"] = r["text"][:600] + "…"
    return out


# ---------- 服务器健康 ----------

def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def _proc_uptime_seconds():
    """本服务进程已运行秒数：/proc/self/stat 的 starttime 与开机时间换算；不可得则用模块加载时刻。"""
    try:
        stat = _read("/proc/self/stat")
        start_ticks = int(stat.rsplit(")", 1)[1].split()[19])
        hz = os.sysconf("SC_CLK_TCK")
        up = float(_read("/proc/uptime").split()[0])
        return max(0, int(up - start_ticks / hz))
    except Exception:
        return int(time.time() - _PROC_START)


def _cert_not_after(path):
    try:
        info = ssl._ssl._test_decode_cert(path)   # 只解析本地证书文件，不联网
        na = info.get("notAfter")
        subj = dict(x[0] for x in info.get("subject", ()))
        san = [v for k, v in info.get("subjectAltName", ()) if k == "DNS"]
        ts = ssl.cert_time_to_seconds(na)
        return {"host": (san[0] if san else subj.get("commonName", Path(path).stem)),
                "not_after": int(ts), "issuer": dict(x[0] for x in info.get("issuer", ())).get(
                    "organizationName", "")}
    except Exception:
        pass
    try:
        out = subprocess.run(["openssl", "x509", "-enddate", "-noout", "-in", path],
                             capture_output=True, text=True, timeout=5).stdout
        na = out.strip().split("=", 1)[1]
        ts = datetime.strptime(na, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc).timestamp()
        return {"host": Path(path).stem, "not_after": int(ts), "issuer": ""}
    except Exception:
        return None


def _certs(now):
    def calc():
        out = []
        for p in sorted(glob.glob(CERT_GLOB))[:8]:
            c = _cert_not_after(p)
            if c:
                out.append(c)
        return out
    certs = _cached("certs", CERT_CACHE_SECONDS, calc)
    return [{**c, "days_left": round((c["not_after"] - now) / 86400, 1)} for c in certs]


def server_health(now=None):
    now = int(now or time.time())

    def calc():
        d = {}
        try:
            d["uptime_seconds"] = int(float(_read("/proc/uptime").split()[0]))
        except Exception:
            d["uptime_seconds"] = None
        try:
            d["loadavg"] = [round(float(x), 2) for x in _read("/proc/loadavg").split()[:3]]
        except Exception:
            d["loadavg"] = None
        d["cpu_count"] = os.cpu_count()
        mem = {}
        for line in _read("/proc/meminfo").splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                try:
                    mem[k] = int(v.strip().split()[0])
                except Exception:
                    pass
        d["mem_total_mb"] = mem.get("MemTotal", 0) // 1024 or None
        d["mem_available_mb"] = mem.get("MemAvailable", 0) // 1024 or None
        try:
            du = shutil.disk_usage(str(console_api.ROOT))
            d["disk_total_gb"] = round(du.total / 1e9, 1)
            d["disk_used_gb"] = round(du.used / 1e9, 1)
            d["disk_free_gb"] = round(du.free / 1e9, 1)
        except Exception:
            d["disk_total_gb"] = None
        db = console_api.ROOT / "90-System" / "runtime" / "state.db"
        try:
            d["db_mb"] = round(sum(Path(str(db) + s).stat().st_size
                                   for s in ("", "-wal") if Path(str(db) + s).exists()) / 1e6, 1)
        except Exception:
            d["db_mb"] = None
        d["service_uptime_seconds"] = _proc_uptime_seconds()
        return d
    d = dict(_cached("server", SERVER_CACHE_SECONDS, calc))
    d["certs"] = _certs(now)
    d["now"] = now
    return d


CHAT_PEER = "grok-chief"


def chat_thread(conn, limit=80, before=None):
    """指挥官对话：dagu-owner ↔ grok-chief（含其实例）双向消息，旧→新。"""
    message_bus.ensure_schema(conn)
    names = [CHAT_PEER] + [n for n, a in _instance_map(conn).items() if a == CHAT_PEER]
    ph = ",".join("?" * len(names))
    sql = ('SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at FROM messages '
           'WHERE ((from_agent=? AND "to" IN (%s)) OR (from_agent=? AND "to"=?))' % ph)
    args = [owner_ops.OWNER_ID] + names + [CHAT_PEER, owner_ops.OWNER_ID]
    if before:
        sql += " AND created_at < ?"
        args.append(int(before))
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    args.append(int(limit))
    keys = ("msg_id", "from_agent", "from_instance", "to", "kind", "text", "reply_to", "thread_id", "created_at")
    rows = [dict(zip(keys, r)) for r in conn.execute(sql, args)]
    rows.reverse()
    # 附上转达指挥官 webhook 的投递状态（只给状态，不给地址/密钥）
    try:
        ids = [r["msg_id"] for r in rows if r["from_agent"] == owner_ops.OWNER_ID]
        if ids:
            hk = {m: (sa, at, le) for m, sa, at, le in conn.execute(
                "SELECT msg_id,sent_at,attempts,last_error FROM webhook_outbox WHERE msg_id IN (%s)" % ",".join("?" * len(ids)), ids)}
            for r in rows:
                if r["msg_id"] in hk:
                    sa, at, le = hk[r["msg_id"]]
                    r["hook"] = {"sent_at": sa, "attempts": at, "error": (le or "")[:80] or None}
    except Exception:
        pass
    import commander_hook
    return {"peer": CHAT_PEER, "hook_configured": commander_hook.configured(), "owner": owner_ops.OWNER_ID, "names": names, "messages": rows}


def handle(conn, path, q, now):
    """命中返回 (code, body)，未命中返回 None。"""
    if path == "/api/dashboard":
        return 200, {"ok": True, "ts": now, "data": dashboard(conn, now)}
    if path == "/api/approvals":
        owner_ops.ensure_schema(conn)
        return 200, {"ok": True, "ts": now, "data": {
            "approvals": owner_ops.list_approvals(conn),
            "decision_tasks": owner_ops.decision_tasks(conn)}}
    if path == "/api/projects":
        import projects
        return 200, {"ok": True, "ts": now, "data": projects.list_projects(conn)}
    if path == "/api/audit":
        lim = console_api._qp_int(q, "limit", 60, 1, 300)
        if lim is None:
            return 400, {"ok": False, "error": "limit 必须是整数"}
        return 200, {"ok": True, "ts": now, "data": owner_ops.list_audit(conn, lim)}
    if path == "/api/chat":
        lim = console_api._qp_int(q, "limit", 80, 1, 300)
        if lim is None:
            return 400, {"ok": False, "error": "limit 必须是整数"}
        bf = q.get("before")
        return 200, {"ok": True, "ts": now, "data": chat_thread(conn, lim, int(bf) if bf and bf.isdigit() else None)}
    if path == "/api/server":
        return 200, {"ok": True, "ts": now, "data": server_health(now)}
    if path == "/api/messages" and q.get("agent"):
        aid = q["agent"].strip()
        if not aid or len(aid) > 80:
            return 400, {"ok": False, "error": "agent 参数不合法"}
        lim = console_api._qp_int(q, "limit", 40, 1, 200)
        if lim is None:
            return 400, {"ok": False, "error": "limit 必须是整数"}
        data = agent_messages(conn, aid, lim)
        return 200, {"ok": True, "ts": now, "data": data, "total": len(data), "order": "desc"}
    return None
