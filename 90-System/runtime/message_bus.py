#!/usr/bin/env python3
# 实时消息总线 v1：Agent 之间经中台双向收发，不进 events 路由，不触发任何 LLM worker。
# 表 messages 在启动/首次使用时幂等建表。from 由口令映射的 chief 写入，调用方不能伪造。
import sqlite3
import time
import uuid

# 与 console_api.OFFLINE_SECONDS 对齐：5 分钟内有心跳才算在场
OFFLINE_SECONDS = 300
MAX_TEXT = 16000
ALLOWED_KINDS = ("chat", "ping", "ack")

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages(
  msg_id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  from_instance TEXT,
  "to" TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  text TEXT NOT NULL,
  reply_to TEXT,
  thread_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_since ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to", created_at);
"""

_COLS = ("msg_id", "from_agent", "from_instance", "to", "kind",
         "text", "reply_to", "thread_id", "created_at")


def ensure_schema(conn):
    """幂等建表。migrate 与 API 热路径均可调用。"""
    conn.executescript(SCHEMA)
    conn.commit()


def new_msg_id():
    return f"msg_{time.strftime('%Y%m%d')}_{uuid.uuid4().hex[:6]}"


def _log(kind, **fields):
    try:
        from runtime import log_event
        log_event(kind, **fields)
    except Exception:
        pass


def _row(r):
    if r is None:
        return None
    if isinstance(r, sqlite3.Row):
        return {k: r[k] for k in r.keys()}
    return dict(zip(_COLS, r))


def lookup_name(conn, name):
    """名册 ∪ agents。返回 dict 或 None。不在册则无法作为收件人。"""
    if not name:
        return None
    try:
        r = conn.execute(
            "SELECT name,kind,agent_ref,status FROM registry WHERE name=?",
            (name,)).fetchone()
        if r:
            return {"name": r[0], "kind": r[1], "agent_ref": r[2], "status": r[3]}
    except sqlite3.OperationalError:
        pass
    try:
        a = conn.execute(
            "SELECT agent_id,kind,status FROM agents WHERE agent_id=?",
            (name,)).fetchone()
    except sqlite3.OperationalError:
        a = None
    if a:
        return {"name": a[0], "kind": a[1], "agent_ref": a[0], "status": a[2]}
    return None


def resolve_instance(conn, chief_id, instance):
    """校验 from_instance：必须是该 chief 名下的在册 active 实例。空则通过。"""
    inst = (instance or "").strip()
    if not inst:
        return "", None
    entry = lookup_name(conn, inst)
    if (not entry or entry.get("kind") != "instance"
            or entry.get("status") != "active"):
        return None, f"{inst} 不在实例名册或已下线"
    if (entry.get("agent_ref") or "") != chief_id:
        return None, f"{inst} 不属于 {chief_id}，不能冒用"
    return inst, None


def get_message(conn, msg_id):
    ensure_schema(conn)
    r = conn.execute(
        'SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at '
        "FROM messages WHERE msg_id=?", (msg_id,)).fetchone()
    return _row(r)


def post_message(conn, from_agent, text, to="all", kind="chat",
                 reply_to=None, from_instance=None, thread_id=None):
    """写入一条消息。不调用 emit_event，故不会进 Router / LLM worker。"""
    ensure_schema(conn)
    from_agent = str(from_agent or "").strip()
    if not from_agent:
        return {"ok": False, "error": "缺发件人身份"}
    text = str(text or "").strip()
    if not text:
        return {"ok": False, "error": "空消息"}
    if len(text) > MAX_TEXT:
        return {"ok": False, "error": f"正文过长（>{MAX_TEXT} 字）"}
    kind = str(kind or "chat").strip().lower() or "chat"
    if kind not in ALLOWED_KINDS:
        return {"ok": False, "error": f"kind 只能是 {' / '.join(ALLOWED_KINDS)}"}

    inst, err = resolve_instance(conn, from_agent, from_instance)
    if err:
        return {"ok": False, "error": err}

    parent = None
    reply_to = str(reply_to or "").strip() or None
    if reply_to:
        parent = get_message(conn, reply_to)
        if not parent:
            return {"ok": False, "error": f"被回复的消息 {reply_to} 不存在"}

    to = str(to or "").strip()
    if parent and not to:
        to = parent["from_agent"]          # reply：收件人强制为原发件人
    if not to:
        return {"ok": False, "error": "缺收件人 to"}
    if to != "all":
        entry = lookup_name(conn, to)
        if not entry or entry.get("status") != "active":
            return {"ok": False, "error": f"{to} 不在名册或已下线，未投递"}

    thread = str(thread_id or "").strip()
    if not thread:
        if parent:
            thread = parent.get("thread_id") or parent["msg_id"]
        else:
            thread = ""                    # 先空，落库后用自身 msg_id

    mid = new_msg_id()
    if not thread:
        thread = mid
    now = int(time.time())
    conn.execute(
        "INSERT INTO messages(msg_id,from_agent,from_instance,\"to\",kind,text,"
        "reply_to,thread_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (mid, from_agent, inst or None, to, kind, text,
         reply_to, thread, now))
    conn.commit()
    _log("bus_msg", msg_id=mid, from_agent=from_agent, to=to, msg_kind=kind,
         reply_to=reply_to or "", instance=inst or "")
    return {"ok": True, "msg_id": mid, "from_agent": from_agent,
            "from_instance": inst or None, "to": to, "kind": kind,
            "text": text, "reply_to": reply_to, "thread_id": thread,
            "created_at": now,
            "note": "已入消息总线，不进 events 路由"}


def handle_cmd(conn, chief_id, cmd, args):
    """供 chief_execute 调用的 msg / reply。from 只用 chief_id，忽略 args.from。"""
    args = args or {}
    # 防伪造：任何自称 from / from_agent 的字段一律丢弃
    text = args.get("text", "")
    kind = args.get("kind", "chat")
    inst = args.get("instance") or args.get("from_instance")
    if cmd == "reply":
        reply_to = str(args.get("reply_to") or args.get("id") or "").strip()
        if not reply_to:
            return {"ok": False, "error": "reply 必带 reply_to"}
        return post_message(conn, chief_id, text, to="", kind=kind or "chat",
                            reply_to=reply_to, from_instance=inst)
    if cmd == "msg":
        return post_message(conn, chief_id, text,
                            to=str(args.get("to", "all") or "all"),
                            kind=kind or "chat",
                            reply_to=args.get("reply_to"),
                            from_instance=inst,
                            thread_id=args.get("thread_id"))
    return {"ok": False, "error": f"未知指令 {cmd}"}


def list_messages(conn, thread=None, since=None, to=None, limit=100):
    ensure_schema(conn)
    try:
        limit = max(1, min(int(limit or 100), 500))
    except (TypeError, ValueError):
        limit = 100
    sql = ('SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,'
           "thread_id,created_at FROM messages WHERE 1=1")
    params = []
    if thread:
        sql += " AND thread_id=?"
        params.append(thread)
    if since is not None and since != "":
        try:
            sql += " AND created_at>=?"
            params.append(int(since))
        except (TypeError, ValueError):
            pass
    if to:
        sql += ' AND "to"=?'
        params.append(to)
    sql += " ORDER BY created_at ASC, rowid ASC LIMIT ?"
    params.append(limit)
    return [_row(r) for r in conn.execute(sql, params).fetchall()]


def poll_for_connection(conn, since, agent_ref, instance):
    """SSE 一轮：该连接可见的新消息（含广播，但不含自己发出的广播）。"""
    ensure_schema(conn)
    try:
        since = int(since)
    except (TypeError, ValueError):
        since = 0
    rows = conn.execute(
        'SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,'
        "thread_id,created_at FROM messages WHERE created_at>=? "
        "ORDER BY created_at ASC, rowid ASC LIMIT 200", (since,)).fetchall()
    out = []
    inst = (instance or "").strip()
    ref = (agent_ref or "").strip()
    for r in rows:
        m = _row(r)
        dest = m["to"]
        visible = dest == "all" or (ref and dest == ref) or (inst and dest == inst)
        if not visible:
            continue
        # 广播不回推给发件人自己（按 chief 或本连接实例判定）
        if dest == "all":
            if ref and m["from_agent"] == ref:
                continue
            if inst and (m.get("from_instance") or "") == inst:
                continue
        out.append(m)
    return out


def _presence_ts(conn):
    """agent_id / 实例名 → 最近心跳或 last_seen。"""
    now = int(time.time())
    beats = {}
    try:
        for agent, ts in conn.execute("SELECT agent, ts FROM heartbeats"):
            if ts:
                beats[agent] = int(ts)
    except sqlite3.OperationalError:
        pass
    last = {}
    try:
        for aid, ts in conn.execute("SELECT agent_id, last_seen FROM agents"):
            if ts:
                last[aid] = int(ts)
    except sqlite3.OperationalError:
        pass
    inst_rows = []
    try:
        inst_rows = conn.execute(
            "SELECT name, location, agent_ref, status FROM registry "
            "WHERE kind='instance'").fetchall()
    except sqlite3.OperationalError:
        inst_rows = []
    return now, beats, last, inst_rows


def _is_online(ts, now):
    return bool(ts) and now - int(ts) <= OFFLINE_SECONDS


def rollcall(conn, msg_id):
    """点名回执清单：谁回了、正文、时延；以及名册 active 但未回复者（附是否在场）。"""
    ensure_schema(conn)
    origin = get_message(conn, msg_id)
    if not origin:
        return None
    replies = [_row(r) for r in conn.execute(
        'SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,'
        "thread_id,created_at FROM messages WHERE reply_to=? "
        "ORDER BY created_at ASC, rowid ASC", (msg_id,)).fetchall()]
    origin_ts = int(origin["created_at"] or 0)
    for r in replies:
        r["latency_seconds"] = max(0, int(r["created_at"] or 0) - origin_ts)

    now, beats, last, inst_rows = _presence_ts(conn)
    sender = origin["from_agent"]
    target = origin["to"]

    # 期望名单：名册里 status=active 的实例 + 对应 chief；不含 worker、不含发件人自己
    expected = []
    seen_keys = set()

    def add_expected(agent_id, instance, location=""):
        key = (agent_id or "", instance or "")
        if key in seen_keys or agent_id == sender:
            return
        seen_keys.add(key)
        ts_cands = []
        if instance and beats.get(instance):
            ts_cands.append(beats[instance])
        if agent_id and beats.get(agent_id):
            ts_cands.append(beats[agent_id])
        if agent_id and last.get(agent_id):
            ts_cands.append(last[agent_id])
        ts = max(ts_cands) if ts_cands else None
        expected.append({
            "agent_id": agent_id,
            "instance": instance or None,
            "location": location or "",
            "presence_at": ts,
            "online": _is_online(ts, now),
            "live_status": ("idle" if _is_online(ts, now) else
                            ("unused" if not ts else "offline")),
        })

    def want(name, agent_ref, kind):
        if target == "all":
            return kind != "worker"
        return name == target or agent_ref == target

    for name, loc, ref, status in inst_rows:
        if status != "active":
            continue
        if want(name, ref, "instance"):
            add_expected(ref, name, loc or "")

    try:
        chiefs = conn.execute(
            "SELECT agent_id,status FROM agents WHERE kind='chief' AND status='active'"
        ).fetchall()
    except sqlite3.OperationalError:
        chiefs = []
    covered = {e["agent_id"] for e in expected if e.get("agent_id")}
    for aid, _st in chiefs:
        if aid in covered:
            continue
        if want(aid, aid, "chief"):
            add_expected(aid, None, "")

    def replied(item):
        for r in replies:
            if item.get("instance") and r.get("from_instance") == item["instance"]:
                return True
            if item.get("agent_id") and r.get("from_agent") == item["agent_id"]:
                # 该 chief 已回（可能来自无实例的连接）
                return True
        return False

    missing = [e for e in expected if not replied(e)]
    missing_online = [e for e in missing if e.get("online")]
    return {
        "ping": origin,
        "replies": replies,
        "expected": expected,
        "missing": missing,
        "missing_online": missing_online,
        "replied_count": len(replies),
        "missing_count": len(missing),
        "missing_online_count": len(missing_online),
    }


def identity_from_token(tokens, token, conn=None, instance=""):
    """口令 → chief；无 chief 时，有实例则用名册 agent_ref。不回传口令。"""
    import hmac
    chief = None
    if token and tokens:
        for name, val in (tokens or {}).items():
            if val and hmac.compare_digest(str(val).encode(), str(token).encode()):
                chief = name
                break
    inst = (instance or "").strip()
    agent_ref = chief
    if not agent_ref and inst and conn is not None:
        entry = lookup_name(conn, inst)
        if entry and entry.get("kind") == "instance" and entry.get("status") == "active":
            agent_ref = entry.get("agent_ref")
    return {"chief": chief, "instance": inst or None, "agent_ref": agent_ref}
