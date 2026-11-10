#!/usr/bin/env python3
# Super-Brain 3.0 控制台只读适配层（console_api）
# 设计原则：只读、不解耦 Runtime、不改 /cmd；由 api_server 的 GET 路由调用。
# 认证：api_tokens.json 中 viewers 字段里的口令（只读），或任意 chief 口令（兼容调试）。
# 端点：/api/overview /api/agents /api/agents/{id} /api/tasks /api/tasks/{id}
#       /api/events /api/monitor /api/knowledge /api/memory
#       /api/messages /api/rollcall/{msg_id}（消息总线 v1，只读查询）
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import message_bus

ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE = ROOT / "10-Knowledge"
EVENTS_DIR = ROOT / "50-Events"
OFFLINE_SECONDS = 300          # 心跳超过 5 分钟视为离线
DEFAULT_ESTIMATE = 120         # 无历史样本时的默认预计耗时（秒）
# 列表默认排除 dead：历史风暴在这一态，必须走 status= 索引，禁止无条件下扫全表
OPEN_STATUSES = ("pending", "doing", "done", "failed", "cancelled")
# 控制台全文只读这些知识类目录，其余（含 90-System、.git）一律拒绝
KB_READ_PREFIXES = (
    "00-Inbox/", "10-Knowledge/", "20-Skills/", "30-Reviews/",
    "40-Agents/", "60-Outputs/",
)
KB_READ_SUFFIXES = (".md", ".txt", ".markdown")
KB_READ_MAX_BYTES = 1_500_000
_EST_CACHE = {}                # type -> (中位耗时, 样本数, 计算时刻)
_RESULT_PATH = re.compile(r"60-Outputs/[\w./+\-\u4e00-\u9fff（）()]+\.md")


def _estimate(conn, ttype):
    """同类任务最近 20 条完成耗时的中位数；样本为零回退默认值。样本越多越准（自学习）。"""
    hit = _EST_CACHE.get(ttype)
    if hit and time.time() - hit[2] < 60:
        return hit[0], hit[1]
    vals = sorted(r[0] for r in conn.execute(
        "SELECT done_at-claimed_at FROM tasks WHERE type=? AND status='done' "
        "AND claimed_at IS NOT NULL AND done_at IS NOT NULL AND done_at>claimed_at "
        "ORDER BY id DESC LIMIT 20", (ttype,)))
    out = (int(vals[len(vals) // 2]), len(vals)) if vals else (DEFAULT_ESTIMATE, 0)
    _EST_CACHE[ttype] = (*out, time.time())
    return out


def _with_progress(conn, row, now):
    """给任务行补 progress（仅 doing 有估算值）：进度=已过/预计，封顶 95，完成回填 100。"""
    st = row.get("status")
    if st == "done":
        row.update(progress=100, estimate_seconds=None, elapsed_seconds=None)
    elif st == "pending":
        row.update(progress=0, estimate_seconds=None, elapsed_seconds=None)
    elif st == "doing" and row.get("claimed_at"):
        est, n = _estimate(conn, row.get("type") or "")
        el = max(0, now - int(row["claimed_at"]))
        row.update(progress=min(95, max(1, round(el * 100 / est))),
                   estimate_seconds=est, elapsed_seconds=el, estimate_samples=n)
    else:
        row.update(progress=None, estimate_seconds=None, elapsed_seconds=None)
    return row


def _claimable_types(conn):
    """所有 active 执行者可认领的 task_type 并集。"""
    out = set()
    for (tt,) in conn.execute(
            "SELECT task_types FROM agents WHERE kind='worker' AND status='active'"):
        try:
            out.update(json.loads(tt or "[]"))
        except Exception:
            pass
    return out


_AWAITING_NOTES = {
    "fuse-review": "跳数熔断待拍板 · 挂起零消耗（不花 Token）",
    "assist": "挂起等入口认领 · 零消耗（不花 Token）",
}


def _with_awaiting(conn, row):
    """挂起零消耗标注：pending 且无执行者可认领 = 躺着等大古拍板，不花一分钱 Token。"""
    if row.get("status") == "pending" and row.get("type") not in _claimable_types(conn):
        row["awaiting"] = True
        row["awaiting_note"] = _AWAITING_NOTES.get(
            row.get("type"), "挂起待认领 · 零消耗（无对应执行者，不花 Token）")
    return row
_PUBLIC_FIELDS = ("event_id", "source", "type", "priority", "status", "created_at")


def _rows(cur):
    return [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]


def _qp_int(q, key, default, lo, hi):
    raw = q.get(key, None)
    if raw is None or raw == "":
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return max(lo, min(n, hi))


def _live_status(seen, busy, now):
    """chief 与 worker 同一口径：5 分钟内有心跳/last_seen 才算在线。从不出现=久未使用。"""
    if not seen:
        return "unused"
    if now - int(seen) > OFFLINE_SECONDS:
        return "offline"
    return "working" if busy else "idle"


def _load_presence(conn):
    """heartbeats.agent 是实例名或进程名；实例经 registry.agent_ref 折回 chief。"""
    beats = {}
    try:
        for agent, ts, note in conn.execute("SELECT agent, ts, note FROM heartbeats"):
            beats[agent] = (int(ts or 0), note or "")
    except Exception:
        beats = {}
    by_ref = {}
    try:
        rows = conn.execute(
            "SELECT name, location, agent_ref, status FROM registry WHERE kind='instance'"
        ).fetchall()
    except Exception:
        rows = []
    now = int(time.time())
    for name, loc, ref, status in rows:
        ts, note = beats.get(name, (None, ""))
        by_ref.setdefault(ref or "", []).append({
            "name": name,
            "location": loc or "",
            "registry_status": status or "",
            "heartbeat_at": ts,
            "note": note,
            "online": bool(ts) and status == "active" and now - int(ts) <= OFFLINE_SECONDS,
        })
    return beats, by_ref


def _annotate_agent(agent, busy, beats, by_ref, now):
    """用 last_seen、自身心跳、名册实例心跳三者的最大值判定在线，不看 kind。"""
    inst = list(by_ref.get(agent.get("agent_id"), []))
    cands = []
    if agent.get("last_seen"):
        cands.append(("last_seen", int(agent["last_seen"])))
    own = beats.get(agent.get("agent_id"))
    if own and own[0]:
        cands.append(("heartbeat", own[0]))
    for item in inst:
        if item.get("heartbeat_at"):
            cands.append(("instance:" + item["name"], int(item["heartbeat_at"])))
    if cands:
        via, seen = max(cands, key=lambda x: x[1])
    else:
        via, seen = "", None
    agent["presence_at"] = seen
    agent["presence_via"] = via
    agent["instances"] = inst
    agent["instance_names"] = [i["name"] for i in inst]
    agent["live_status"] = _live_status(seen, busy, now)
    agent["ever_connected"] = seen is not None
    return agent


def touch_instance_presence(conn, instance, now_ts=None):
    """SSE 在场：心跳键仍是实例名；agents.last_seen 按 registry.agent_ref 回写。

    不把实例名当成 agent_id。名册没有对应行时只记心跳、不改 agents。不提交事务。
    """
    now_ts = int(now_ts if now_ts is not None else time.time())
    conn.execute(
        "INSERT INTO heartbeats(agent,ts,note) VALUES(?,?,'sse') "
        "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts, note=excluded.note",
        (instance, now_ts))
    agent_id = ""
    try:
        ref = conn.execute(
            "SELECT agent_ref FROM registry WHERE name=? AND kind='instance' AND status='active'",
            (instance,)).fetchone()
        agent_id = (ref[0] or "").strip() if ref else ""
    except Exception:
        agent_id = ""
    updated = 0
    if agent_id:
        updated = conn.execute(
            "UPDATE agents SET last_seen=? WHERE agent_id=?", (now_ts, agent_id)).rowcount
    return {"instance": instance, "agent_id": agent_id or None, "updated": updated, "ts": now_ts}


def _instruction_of(payload):
    """从任务 payload 取出给人看的指令原文。过大的对象不整包返回。"""
    if payload is None:
        return "", None
    obj = payload
    if isinstance(payload, str):
        try:
            obj = json.loads(payload)
        except Exception:
            return payload[:1200], None
    if isinstance(obj, dict):
        text = obj.get("text") or obj.get("instruction") or obj.get("prompt") or obj.get("content") or ""
        raw = json.dumps(obj, ensure_ascii=False)
        return str(text)[:1200], (obj if len(raw) <= 8000 else None)
    return str(obj)[:800], None


def _result_paths(*blobs):
    found, seen = [], set()
    for blob in blobs:
        if isinstance(blob, dict):
            for key in ("result_path", "path", "file"):
                val = blob.get(key)
                if isinstance(val, str):
                    blob_s = val
                    if blob_s.startswith("60-Outputs/") and blob_s.endswith(".md") and blob_s not in seen:
                        seen.add(blob_s)
                        found.append(blob_s)
            blob = json.dumps(blob, ensure_ascii=False)
        for m in _RESULT_PATH.findall(str(blob or "")):
            if m not in seen:
                seen.add(m)
                found.append(m)
    return found


def _enrich_task(conn, row, now, with_events=False):
    payload_raw = row.get("payload")
    instruction, payload_obj = _instruction_of(payload_raw)
    row["instruction"] = instruction
    if payload_obj is not None:
        row["payload"] = payload_obj
    elif isinstance(payload_raw, str):
        row.pop("payload", None)
        row["payload_omitted"] = True
    row["result_paths"] = _result_paths(payload_obj, row.get("result"), row.get("summary"))
    _with_awaiting(conn, _with_progress(conn, row, now))
    if with_events and row.get("event_id"):
        eid = row["event_id"]
        row["events"] = _rows(conn.execute(
            "SELECT event_id,source,type,status,created_at,substr(COALESCE(payload,''),1,500) AS payload "
            "FROM events WHERE event_id=? OR parent_id=? ORDER BY created_at DESC LIMIT 20",
            (eid, eid)))
    return row


def _is_sensitive_name(name):
    n = (name or "").lower()
    return n.startswith(("api_tokens", "llm.json", "state.db", ".env")) or n.endswith(
        (".db", ".db-wal", ".db-shm", ".pem", ".key"))


def _kb_file(rel):
    """解析知识全文路径。返回 (Path|None, error|None)。拒绝穿越、敏感文件与知识目录之外。"""
    rel = (rel or "").replace("\\", "/").strip()
    if not rel or "\x00" in rel or rel.startswith("/") or ":" in rel.split("/")[0]:
        return None, "非法路径"
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts) or any(p == ".git" or p.startswith(".git") for p in parts):
        return None, "非法路径"
    rel = "/".join(parts)
    if not any(rel.startswith(p) for p in KB_READ_PREFIXES):
        return None, "只允许读取知识类目录"
    if _is_sensitive_name(parts[-1]):
        return None, "敏感文件拒绝读取"
    root = ROOT.resolve()
    fp = (root / rel).resolve()
    try:
        resolved = fp.relative_to(root).as_posix()
    except ValueError:
        return None, "越界路径"
    if resolved != rel or not any(resolved.startswith(p) for p in KB_READ_PREFIXES):
        return None, "越界路径"
    if any(p == ".git" for p in fp.parts) or _is_sensitive_name(fp.name):
        return None, "敏感文件拒绝读取"
    if fp.suffix.lower() not in KB_READ_SUFFIXES:
        return None, "只允许读取 Markdown 或纯文本"
    if not fp.is_file():
        return None, "文件不存在"
    return fp, None


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


def _plain_body(path):
    """正文纯文本摘要：去掉 frontmatter、压缩空白，供列表预览与搜索。"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)
    return re.sub(r"\s+", " ", text).strip()


def _wikilinks(path):
    """解析正文 [[wikilink]]（kepano 规范：允许未解析链接，留作面包屑）。返回去重链接名。"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)
    seen, out = set(), []
    for m in re.findall(r"\[\[([^\[\]|#]+)(?:[#|][^\[\]]*)?\]\]", text):
        name = m.strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
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
        beats, by_ref = _load_presence(conn)
        agents = _rows(conn.execute(
            "SELECT agent_id,kind,status,last_seen FROM agents WHERE status='active' "
            "ORDER BY kind,agent_id"))
        for a in agents:
            _annotate_agent(a, a["agent_id"] in busy, beats, by_ref, now)
        tasks = dict(conn.execute("SELECT status,COUNT(*) FROM tasks GROUP BY status").fetchall())
        dec = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE status='pending' AND priority>=1").fetchone()[0]
        today0 = int(time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)))
        ev = conn.execute("SELECT COUNT(*) FROM events WHERE created_at>=?", (today0,)).fetchone()[0]
        online = sum(1 for a in agents if a["live_status"] in ("idle", "working"))
        return ok({
            "console_rev": 1,
            "agents_total": len(agents),
            "agents_online": online,
            "agents_working": sum(1 for a in agents if a["live_status"] == "working"),
            "agents_offline": sum(1 for a in agents if a["live_status"] == "offline"),
            "agents_unused": sum(1 for a in agents if a["live_status"] == "unused"),
            "tasks": tasks,
            "tasks_running": tasks.get("doing", 0),
            "tasks_pending": tasks.get("pending", 0),
            "tasks_failed": tasks.get("failed", 0) + tasks.get("dead", 0),
            "events_today": ev,
            "pending_decisions": dec,
        })

    if path == "/api/agents":
        doing = {}
        for r in conn.execute(
                "SELECT id, lease_owner, type, substr(COALESCE(payload,''),1,240) "
                "FROM tasks WHERE status='doing' AND lease_owner IS NOT NULL LIMIT 40"):
            doing[r[1]] = {"id": r[0], "type": r[2],
                           "instruction": _instruction_of(r[3])[0][:180]}
        beats, by_ref = _load_presence(conn)
        dec = dict(conn.execute(
            "SELECT e.source, COUNT(*) FROM tasks t JOIN events e ON t.event_id=e.event_id "
            "WHERE t.status='pending' AND t.priority>=1 GROUP BY 1").fetchall())
        out = []
        for a in _rows(conn.execute("SELECT * FROM agents ORDER BY kind,agent_id")):
            try:
                a["capabilities"] = json.loads(a["capabilities"] or "[]")
                a["task_types"] = json.loads(a["task_types"] or "[]")
                a["permissions"] = json.loads(a["permissions"] or "{}")
            except Exception:
                pass
            _annotate_agent(a, a["agent_id"] in doing, beats, by_ref, now)
            cur = doing.get(a["agent_id"])
            a["current_task_id"] = cur["id"] if cur else None
            a["current_task"] = cur
            a["pending_decisions"] = dec.get(a["agent_id"], 0)
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
        beats, by_ref = _load_presence(conn)
        doing_id = conn.execute(
            "SELECT id FROM tasks WHERE lease_owner=? AND status='doing' ORDER BY id DESC LIMIT 1",
            (d["agent_id"],)).fetchone()
        _annotate_agent(d, bool(doing_id), beats, by_ref, now)
        d["current_task_id"] = doing_id[0] if doing_id else None
        hist = _rows(conn.execute(
            "SELECT id,event_id,type,status,priority,lease_owner,retry_count,claimed_at,"
            "created_at,done_at,payload,substr(COALESCE(result,error),1,400) AS summary "
            "FROM tasks WHERE lease_owner=? AND status IN (?,?,?,?,?) "
            "ORDER BY id DESC LIMIT 12",
            (d["agent_id"], *OPEN_STATUSES)))
        for row in hist:
            _enrich_task(conn, row, now, with_events=(doing_id and row["id"] == doing_id[0]))
        d["recent_tasks"] = hist
        if doing_id:
            d["current_task"] = next((r for r in hist if r["id"] == doing_id[0]), None)
        else:
            d["current_task"] = None
        return ok(d)

    if path == "/api/tasks":
        limit = _qp_int(q, "limit", 50, 1, 200)
        offset = _qp_int(q, "offset", 0, 0, 5000)
        if limit is None or offset is None:
            return 400, {"ok": False, "error": "limit 或 offset 不是整数"}
        where, args = [], []
        status = (q.get("status") or "").strip()
        excluded_dead = False
        if status:
            where.append("status=?")
            args.append(status)
        else:
            where.append("status IN (%s)" % ",".join("?" * len(OPEN_STATUSES)))
            args.extend(OPEN_STATUSES)
            excluded_dead = True
        if q.get("type"):
            where.append("type=?")
            args.append(q["type"])
        if q.get("agent"):
            where.append("lease_owner=?")
            args.append(q["agent"])
        if q.get("q"):
            raw_q = q["q"].strip()[:80]
            kw = "%" + raw_q + "%"
            where.append(
                "(type LIKE ? OR lease_owner LIKE ? OR "
                "substr(COALESCE(result,error,''),1,200) LIKE ? OR CAST(id AS TEXT)=?)")
            args.extend([kw, kw, kw, raw_q])
        w = "WHERE " + " AND ".join(where)
        rows = _rows(conn.execute(
            f"SELECT id,event_id,type,status,priority,lease_owner,retry_count,claimed_at,"
            f"created_at,done_at,"
            f"substr(COALESCE(result,error),1,200) AS summary FROM tasks {w} "
            f"ORDER BY id DESC LIMIT ? OFFSET ?", (*args, limit, offset)))
        for r in rows:
            _with_awaiting(conn, _with_progress(conn, r, now))
        total = conn.execute(f"SELECT COUNT(*) FROM tasks {w}", args).fetchone()[0]
        return ok(rows, total=total, limit=limit, offset=offset, excluded_dead=excluded_dead)

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
        instr, _ = _instruction_of(d.get("payload"))
        d["instruction"] = instr
        d["result_paths"] = _result_paths(d.get("payload"), d.get("result"))
        _with_awaiting(conn, _with_progress(conn, d, now))
        evs = _rows(conn.execute(
            "SELECT event_id,source,type,status,created_at FROM events WHERE parent_id=? "
            "OR event_id=? ORDER BY created_at DESC LIMIT 20", (d["event_id"], d["event_id"])))
        return ok({**d, "events": evs})

    m = re.fullmatch(r"/api/round/([\w.-]+)", path)
    if m:
        # why 复盘视图（借鉴 Agent-Autoloop）：一轮任务为什么开始、经过几跳、谁接的活、结果如何，
        # 一条时间线全部翻出来。向上沿 parent_id 找根，向下递归收集整条链的事件与任务。
        eid = m.group(1)
        if not conn.execute("SELECT 1 FROM events WHERE event_id=?", (eid,)).fetchone():
            return 404, {"ok": False, "error": "事件不存在"}
        chain, pid, guard_i = [], eid, 0
        while pid and guard_i < 64:                # 向上找根（防御环）
            r = conn.execute("SELECT event_id,parent_id FROM events WHERE event_id=?",
                             (pid,)).fetchone()
            if not r:
                break
            chain.append(r[0])
            pid = r[1]
            guard_i += 1
        root = chain[-1] if chain else eid
        ids, frontier, guard_i = [root], [root], 0
        while frontier and guard_i < 20:           # 向下递归收集后代（防御爆链）
            ph = ",".join("?" * len(frontier))
            children = [r[0] for r in conn.execute(
                f"SELECT event_id FROM events WHERE parent_id IN ({ph})", frontier)]
            ids += children
            frontier = children
            guard_i += 1
        ph = ",".join("?" * len(ids))
        evs = _rows(conn.execute(
            f"SELECT event_id,source,type,priority,status,parent_id,payload,created_at "
            f"FROM events WHERE event_id IN ({ph}) ORDER BY created_at, rowid", ids))
        tasks = _rows(conn.execute(
            f"SELECT id,event_id,type,status,priority,lease_owner,created_at,claimed_at,done_at,"
            f"substr(COALESCE(result,error),1,200) AS summary FROM tasks "
            f"WHERE event_id IN ({ph}) ORDER BY created_at, id", ids))
        timeline = []
        for e in evs:
            hop = None
            try:
                hop = json.loads(e.get("payload") or "{}").get("_hop")
            except Exception:
                pass
            timeline.append({"kind": "event", "ts": e["created_at"], "event_id": e["event_id"],
                             "source": e["source"], "type": e["type"], "status": e["status"],
                             "priority": e["priority"], "hop": hop, "parent_id": e["parent_id"]})
        for t_ in tasks:
            timeline.append({"kind": "task", "ts": t_["created_at"], "task_id": t_["id"],
                             "event_id": t_["event_id"], "type": t_["type"], "status": t_["status"],
                             "priority": t_["priority"], "lease_owner": t_["lease_owner"],
                             "claimed_at": t_["claimed_at"], "done_at": t_["done_at"],
                             "summary": t_["summary"]})
        timeline.sort(key=lambda x: (x["ts"], 0 if x["kind"] == "event" else 1))
        return ok({"root": root, "focus": eid, "chain_events": len(ids),
                   "chain_tasks": len(tasks), "timeline": timeline})

    if path == "/api/relations":
        # 依据一：真实历史派发记录（events.source → tasks.lease_owner），有据可查
        rows = _rows(conn.execute(
            "SELECT e.source AS source, t.lease_owner AS target, COUNT(*) AS task_count, "
            "MAX(t.created_at) AS last_at FROM tasks t JOIN events e ON t.event_id=e.event_id "
            "WHERE t.lease_owner IS NOT NULL AND t.lease_owner!='' AND e.source!='' "
            "GROUP BY 1,2 ORDER BY task_count DESC LIMIT 60"))
        for r in rows:
            r["type"] = "delegation"
            r["evidence"] = "history"
        busy = {r[0] for r in conn.execute(
            "SELECT lease_owner FROM tasks WHERE status='doing' AND lease_owner IS NOT NULL")}
        covered = {(r["source"], r["target"]) for r in rows}
        # 依据二：尚无派发记录的入口 → 默认路由 chat-worker（规则层真实兜底，非虚构）
        for (c,) in conn.execute("SELECT agent_id FROM agents WHERE kind='chief' AND status='active'"):
            if not any(s == c for s, _ in covered) and (c, "chat-worker") not in covered:
                rows.append({"source": c, "target": "chat-worker", "task_count": 0,
                             "last_at": None, "type": "delegation", "evidence": "default_route"})
        for r in rows:
            r["state"] = "active" if (r["target"] in busy and r["evidence"] == "history") else "idle"
        return ok(rows)

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
        ref_of = {}
        try:
            ref_of = dict(conn.execute(
                "SELECT name, agent_ref FROM registry WHERE kind='instance'").fetchall())
        except Exception:
            ref_of = {}
        for h in hb:
            h["age_seconds"] = now - int(h["ts"] or 0)
            h["online"] = h["age_seconds"] <= OFFLINE_SECONDS
            if h["agent"] in ref_of:
                h["agent_ref"] = ref_of[h["agent"]]
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

    if path == "/api/knowledge/file":
        fp, err = _kb_file(q.get("path") or "")
        if err == "文件不存在":
            return 404, {"ok": False, "error": err}
        if err:
            return 400, {"ok": False, "error": err}
        size = fp.stat().st_size
        if size > KB_READ_MAX_BYTES:
            return 413, {"ok": False, "error": "文件过大，控制台不全文加载"}
        text = fp.read_text(encoding="utf-8", errors="replace")
        truncated = len(text) > 120_000
        if truncated:
            text = text[:120_000]
        fm = _frontmatter(fp)
        rel = fp.resolve().relative_to(ROOT.resolve()).as_posix()
        return ok({
            "path": rel,
            "title": fm.get("title") or fp.stem,
            "category": fm.get("category") or fp.parent.name,
            "content": text,
            "truncated": truncated,
            "bytes": size,
        })

    if path == "/api/knowledge":
        limit = min(int(q.get("limit", 100)), 500)
        kw = (q.get("q") or "").strip().lower()
        cat = (q.get("category") or "").strip()
        items, total = [], 0
        for p in sorted(KNOWLEDGE.rglob("*.md")):
            fm = _frontmatter(p)
            title = fm.get("title") or p.stem
            category = fm.get("category") or p.parent.name
            tags = [t for t in re.split(r",\s*", fm.get("tags", "")) if t]
            relpath = str(p.relative_to(ROOT))
            if cat and category != cat:
                continue
            body = _plain_body(p)
            if kw and kw not in f"{title} {relpath} {' '.join(tags)} {category} {body}".lower():
                continue
            items.append({
                "path": relpath,
                "title": title,
                "category": category,
                "tags": tags,
                "quality": fm.get("quality", ""),
                "rating": fm.get("rating", ""),
                "created": fm.get("created", ""),
                "updated": fm.get("updated", ""),
                "links": _wikilinks(p),
                "size": p.stat().st_size,
                "snippet": _plain_body(p)[:180],
            })
        total = len(items)
        items = items[-limit:] if not (kw or cat) else items[:limit]
        return ok(items, total=total)

    if path == "/api/memory":
        rows = _rows(conn.execute(
            "SELECT thread_id,worker,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 100"))
        agents = _rows(conn.execute(
            "SELECT agent_id,last_seen FROM agents WHERE last_seen IS NOT NULL ORDER BY last_seen DESC"))
        return ok({"sessions": rows, "agent_memory": agents})

    if path == "/api/knowledge/canvas":
        # JSON Canvas 1.0（obsidianmd/jsoncanvas）：每个分类一个 group，笔记为 file 节点，
        # [[wikilink]] 解析到文件名（大小写不敏感）生成 edge；未解析链接只计数（kepano：面包屑是特性）。
        entries = []
        for p in sorted(KNOWLEDGE.rglob("*.md")):
            fm = _frontmatter(p)
            entries.append({
                "p": p,
                "path": str(p.relative_to(ROOT)),
                "stem": p.stem,
                "category": fm.get("category") or p.parent.name,
            })
        stem_map = {}
        for e in entries:
            stem_map.setdefault(e["stem"].lower(), e["path"])
        cats = {}
        for e in entries:
            cats.setdefault(e["category"], []).append(e)
        nodes, edges, file_node = [], [], {}
        COLORS = ("4", "5", "6", "1", "2", "3")   # canvas preset 色：蓝紫粉红橙绿
        gx, nc = 0, 0
        for ci, cat in enumerate(sorted(cats)):
            fl = cats[cat]
            gw, rowh = 440, 96
            gh = 60 + len(fl) * rowh + 24
            nodes.append({"id": "g%d" % ci, "type": "group", "x": gx, "y": 0,
                          "width": gw, "height": gh, "label": cat,
                          "color": COLORS[ci % len(COLORS)]})
            for i, e in enumerate(fl):
                nid = "n%d" % nc
                nc += 1
                file_node[e["path"]] = nid
                nodes.append({"id": nid, "type": "file", "file": e["path"],
                              "x": gx + 40, "y": 60 + i * rowh,
                              "width": 360, "height": 80})
            gx += gw + 80
        unresolved, seen_edge = 0, set()
        for e in entries:
            src = file_node[e["path"]]
            for name in _wikilinks(e["p"]):
                tgt_path = stem_map.get(name.lower())
                if not tgt_path:
                    unresolved += 1
                    continue
                tgt = file_node.get(tgt_path)
                if not tgt or tgt == src or (src, tgt) in seen_edge:
                    continue
                seen_edge.add((src, tgt))
                edges.append({"id": "e%d" % len(edges), "fromNode": src, "toNode": tgt,
                              "fromSide": "right", "toSide": "left", "toEnd": "arrow"})
        return ok({"canvas": {"nodes": nodes, "edges": edges},
                   "stats": {"nodes": len(nodes), "edges": len(edges),
                             "unresolved": unresolved}})

    if path == "/api/review/annual":
        # 年度回顾（kepano 40 questions 的数据佐证）：全部来自 DB 与文件系统实算
        year = int(q.get("year") or time.localtime().tm_year)
        y0 = int(time.mktime((year, 1, 1, 0, 0, 0, 0, 0, -1)))
        y1 = int(time.mktime((year + 1, 1, 1, 0, 0, 0, 0, 0, -1)))
        done = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE status='done' AND done_at>=? AND done_at<?",
            (y0, y1)).fetchone()[0]
        failed = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE status IN ('failed','dead') AND done_at>=? AND done_at<?",
            (y0, y1)).fetchone()[0]
        top_types = _rows(conn.execute(
            "SELECT type, COUNT(*) AS n FROM tasks WHERE created_at>=? AND created_at<? "
            "GROUP BY type ORDER BY n DESC LIMIT 5", (y0, y1)))
        events_total = conn.execute(
            "SELECT COUNT(*) FROM events WHERE created_at>=? AND created_at<?",
            (y0, y1)).fetchone()[0]
        active_days = conn.execute(
            "SELECT COUNT(DISTINCT date(created_at,'unixepoch','localtime')) FROM events "
            "WHERE created_at>=? AND created_at<?", (y0, y1)).fetchone()[0]
        per_agent = _rows(conn.execute(
            "SELECT lease_owner AS agent, COUNT(*) AS done FROM tasks "
            "WHERE status='done' AND done_at>=? AND done_at<? "
            "AND lease_owner IS NOT NULL AND lease_owner!='' "
            "GROUP BY 1 ORDER BY done DESC", (y0, y1)))
        knowledge_new = 0
        for p in KNOWLEDGE.rglob("*.md"):
            c = (_frontmatter(p).get("created") or "")[:4]
            if c.isdigit():
                if int(c) == year:
                    knowledge_new += 1
            elif y0 <= int(p.stat().st_mtime) < y1:
                knowledge_new += 1
        return ok({"year": year, "tasks_done": done, "tasks_failed": failed,
                   "top_types": top_types, "events_total": events_total,
                   "active_days": active_days, "per_agent": per_agent,
                   "knowledge_new": knowledge_new})

    if path == "/api/review/fractal":
        # 分形回顾：日 / ISO 周 / 月 三个尺度的真实计数
        days_n = min(int(q.get("days", 30)), 120)
        today0 = int(time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)))
        t0 = today0 - (days_n - 1) * 86400
        ev_day = dict(conn.execute(
            "SELECT date(created_at,'unixepoch','localtime'), COUNT(*) FROM events "
            "WHERE created_at>=? GROUP BY 1", (t0,)))
        done_day = dict(conn.execute(
            "SELECT date(done_at,'unixepoch','localtime'), COUNT(*) FROM tasks "
            "WHERE status='done' AND done_at>=? GROUP BY 1", (t0,)))
        fail_day = dict(conn.execute(
            "SELECT date(done_at,'unixepoch','localtime'), COUNT(*) FROM tasks "
            "WHERE status IN ('failed','dead') AND done_at>=? GROUP BY 1", (t0,)))
        sess_day = dict(conn.execute(
            "SELECT date(updated_at,'unixepoch','localtime'), COUNT(*) FROM sessions "
            "WHERE updated_at>=? GROUP BY 1", (t0,)))
        src_rows = conn.execute(
            "SELECT date(created_at,'unixepoch','localtime') d, source, COUNT(*) n "
            "FROM events WHERE created_at>=? GROUP BY 1,2 ORDER BY 1, n DESC", (t0,)).fetchall()
        src_day = {}
        for d, s, n in src_rows:
            src_day.setdefault(d, []).append((s, n))
        days = []
        for i in range(days_n):
            dstr = time.strftime("%Y-%m-%d",
                                 time.localtime(today0 - (days_n - 1 - i) * 86400))
            days.append({"date": dstr, "events": ev_day.get(dstr, 0),
                         "tasks_done": done_day.get(dstr, 0),
                         "tasks_failed": fail_day.get(dstr, 0),
                         "sessions": sess_day.get(dstr, 0),
                         "top_sources": [{"source": s, "n": n}
                                         for s, n in (src_day.get(dstr) or [])[:3]]})
        wk_ev = dict(conn.execute(
            "SELECT strftime('%Y-W%W',created_at,'unixepoch','localtime') w, COUNT(*) "
            "FROM events WHERE created_at>=? GROUP BY w", (t0,)))
        wk_done = dict(conn.execute(
            "SELECT strftime('%Y-W%W',done_at,'unixepoch','localtime') w, COUNT(*) "
            "FROM tasks WHERE status='done' AND done_at>=? GROUP BY w", (t0,)))
        wk_fail = dict(conn.execute(
            "SELECT strftime('%Y-W%W',done_at,'unixepoch','localtime') w, COUNT(*) "
            "FROM tasks WHERE status IN ('failed','dead') AND done_at>=? GROUP BY w", (t0,)))
        weeks = [{"week": w, "events": wk_ev.get(w, 0),
                  "tasks_done": wk_done.get(w, 0), "tasks_failed": wk_fail.get(w, 0)}
                 for w in sorted(set(wk_ev) | set(wk_done) | set(wk_fail))]
        mo_ev = dict(conn.execute(
            "SELECT strftime('%Y-%m',created_at,'unixepoch','localtime') m, COUNT(*) "
            "FROM events WHERE created_at>=? GROUP BY m", (t0,)))
        mo_done = dict(conn.execute(
            "SELECT strftime('%Y-%m',done_at,'unixepoch','localtime') m, COUNT(*) "
            "FROM tasks WHERE status='done' AND done_at>=? GROUP BY m", (t0,)))
        mo_fail = dict(conn.execute(
            "SELECT strftime('%Y-%m',done_at,'unixepoch','localtime') m, COUNT(*) "
            "FROM tasks WHERE status IN ('failed','dead') AND done_at>=? GROUP BY m", (t0,)))
        months = [{"month": m, "events": mo_ev.get(m, 0),
                   "tasks_done": mo_done.get(m, 0), "tasks_failed": mo_fail.get(m, 0)}
                  for m in sorted(set(mo_ev) | set(mo_done) | set(mo_fail))]
        return ok({"days": days, "weeks": weeks, "months": months})

    if path == "/api/messages":
        try:
            since = q.get("since", "")
            since = int(since) if since not in (None, "") else None
        except (TypeError, ValueError):
            return 400, {"ok": False, "error": "since 必须是 unix 时间戳"}
        limit = _qp_int(q, "limit", 100, 1, 500)
        if limit is None:
            return 400, {"ok": False, "error": "limit 必须是整数"}
        data = message_bus.list_messages(
            conn, thread=q.get("thread") or None, since=since,
            to=q.get("to") or None, limit=limit)
        return ok(data, total=len(data))

    if path.startswith("/api/rollcall/"):
        msg_id = path[len("/api/rollcall/"):].strip()
        if not msg_id or "/" in msg_id:
            return 400, {"ok": False, "error": "缺 msg_id"}
        data = message_bus.rollcall(conn, msg_id)
        if not data:
            return 404, {"ok": False, "error": f"消息 {msg_id} 不存在"}
        return ok(data)

    return 404, {"ok": False, "error": "not found"}


