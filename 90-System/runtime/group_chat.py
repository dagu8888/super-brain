#!/usr/bin/env python3
# 群聊最小版。消息写进现有 messages 表（thread_id = 群 id），不进 events、不派任务、不触发 LLM。
# 有新的群消息时，对登记了 webhook 的成员做一次叫醒：通知里只有 event / group_id / msg_id，
# 没有正文、没有令牌。对方自己来拉收件箱。叫醒失败只记状态，不重试、不再派一条任务。
# 不读 heartbeats，不用心跳判断能不能对话。名册来自 agents / registry / 已配对的外部 Agent，
# 「已证实收发」只看 messages 里真实的 chat 收发。
# 外部 Agent 的令牌、一次性配对码都只存 sha256，明文只在签发当时返回给调用方。
import hashlib
import json
import re
import sqlite3
import time
import urllib.error
import urllib.request
import uuid

import message_bus

HUMAN_ID = "dagu-owner"
HUMAN_NAME = "大古"
SYSTEM_ID = "group-system"
PAIR_TTL = 30 * 60
MIN_CHECKIN = 3600          # 稀疏兜底最短 1 小时，拒绝分钟级
DEFAULT_CHECKIN = 6 * 3600  # 默认 6 小时，且不是主通道
WAKE_TIMEOUT = 4
GROUP_RE = re.compile(r"^grp_[0-9a-f]{8,32}$")
DOC_PATH = "/console/prototype/groupchat/install.md"
SKILL_PATH = "/console/prototype/groupchat/skill.md"
INBOX_PATH = "/api/groupchat/inbox"
JOIN_LABEL = "仅限邀请加入"

OWNER_ACTIONS = (
    "group_create", "group_add", "group_send", "group_pair",
    "group_recall", "group_webhook", "group_checkin",
)

# 与操作台 v2 同一套称呼。不在表里的就用 agent_id，不编造在线状态。
DISPLAY = {
    "grok-chief": "幕僚长", "deepseek-chief": "DeepSeek", "muse-chief": "Muse",
    "trae-chief": "Trae", "dsh-chief": "DSH一号", "dsh2-chief": "DSH二号",
    "maus-chief": "MAUS1号", "maus2-chief": "MAUS2号",
    "knowledge-worker": "知识整理", "archive-worker": "归档",
    "research-worker": "研究", "analysis-worker": "分析",
    "chat-worker": "对话", "code-worker": "代码",
    "trae-developer": "开发", "test-agent-worker": "测试",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_groups(
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members(
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  member_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, member_id)
);
CREATE TABLE IF NOT EXISTS external_agents(
  ext_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  webhook_url TEXT,
  checkin_seconds INTEGER NOT NULL DEFAULT 21600,
  created_at INTEGER NOT NULL,
  last_checkin_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS ext_pair_codes(
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  created_by TEXT,
  group_id TEXT,
  suggested_name TEXT
);
CREATE TABLE IF NOT EXISTS wake_hooks(
  member_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_flags(
  msg_id TEXT PRIMARY KEY,
  recalled_at INTEGER,
  recalled_by TEXT
);
CREATE TABLE IF NOT EXISTS group_wakes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_wakes_msg ON group_wakes(msg_id, member_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_member ON chat_members(member_id);
"""

_TRANSPORT = {"fn": None}


def set_wake_transport(fn):
    """测试注入。生产路径为 None，走一次 HTTP POST，失败不重试。"""
    _TRANSPORT["fn"] = fn


def ensure_schema(conn):
    message_bus.ensure_schema(conn)
    conn.executescript(SCHEMA)
    conn.commit()


def _now():
    return int(time.time())


def _hash(raw):
    return hashlib.sha256(str(raw).encode("utf-8")).hexdigest()


def _display(agent_id):
    return DISPLAY.get(agent_id) or agent_id


def _clean_name(name):
    name = str(name or "").strip()
    name = "".join(ch for ch in name if ch >= " " and ch != "\x7f")
    if not name:
        return ""
    return name[:40]


def _valid_url(url):
    url = str(url or "").strip()
    if not url or len(url) > 400 or any(ch.isspace() for ch in url):
        return ""
    if not (url.startswith("https://") or url.startswith("http://")):
        return ""
    return url


def _group_id_ok(group_id):
    return bool(GROUP_RE.match(str(group_id or "")))


def _group_row(conn, group_id):
    if not _group_id_ok(group_id):
        return None
    return conn.execute(
        "SELECT group_id, name, created_by, created_at FROM chat_groups WHERE group_id=?",
        (group_id,)).fetchone()


def is_member(conn, group_id, member_id):
    if not member_id or not _group_id_ok(group_id):
        return False
    return conn.execute(
        "SELECT 1 FROM chat_members WHERE group_id=? AND member_id=?",
        (group_id, member_id)).fetchone() is not None


def _member_map(conn, group_id):
    out = {}
    for mid, kind, name in conn.execute(
            "SELECT member_id, member_kind, display_name FROM chat_members WHERE group_id=?",
            (group_id,)):
        out[mid] = {"member_id": mid, "member_kind": kind, "display_name": name}
    return out


def webhook_for(conn, member_id):
    row = conn.execute("SELECT url FROM wake_hooks WHERE member_id=?", (member_id,)).fetchone()
    if row and row[0]:
        return row[0]
    row = conn.execute(
        "SELECT webhook_url FROM external_agents WHERE ext_id=? AND revoked_at IS NULL",
        (member_id,)).fetchone()
    if row and row[0]:
        return row[0]
    return ""


def _last_tx(conn, member_id):
    """最近一次真正写出或收到的 chat。不看心跳、不看系统通知。"""
    send = conn.execute(
        "SELECT MAX(created_at) FROM messages WHERE from_agent=? AND kind='chat'",
        (member_id,)).fetchone()[0]
    recv = conn.execute(
        'SELECT MAX(created_at) FROM messages WHERE "to"=? AND kind=\'chat\'',
        (member_id,)).fetchone()[0]
    grec = None
    try:
        grec = conn.execute(
            'SELECT MAX(m.created_at) FROM messages m '
            'JOIN chat_members c ON c.group_id = m."to" '
            "WHERE c.member_id=? AND m.from_agent<>? AND m.kind='chat'",
            (member_id, member_id)).fetchone()[0]
    except sqlite3.OperationalError:
        grec = None
    cands = []
    if send:
        cands.append((int(send), "send"))
    if recv:
        cands.append((int(recv), "recv"))
    if grec:
        cands.append((int(grec), "recv"))
    if not cands:
        return None, None
    cands.sort()
    return cands[-1]


def _talk(conn, member_id, paired=False):
    at, direction = _last_tx(conn, member_id)
    if at:
        return {"last_tx_at": at, "last_tx_dir": direction,
                "talk_state": "proven", "talk_label": "已证实收发"}
    label = "已配对，尚未证实收发" if paired else "名册在册，尚未证实收发"
    return {"last_tx_at": None, "last_tx_dir": None,
            "talk_state": "unproven", "talk_label": label}


def _resolve_join(conn, member_id):
    """把调用方给的 id 收成可以进群的身份。实例名折回它的 agent，不另造一个人。"""
    member_id = str(member_id or "").strip()
    if not member_id or member_id in (HUMAN_ID, SYSTEM_ID):
        return None
    ext = conn.execute(
        "SELECT ext_id, name FROM external_agents WHERE ext_id=? AND revoked_at IS NULL",
        (member_id,)).fetchone()
    if ext:
        return ext[0], "external", ext[1]
    ag = conn.execute(
        "SELECT agent_id FROM agents WHERE agent_id=?", (member_id,)).fetchone()
    if ag:
        return ag[0], "agent", _display(ag[0])
    try:
        reg = conn.execute(
            "SELECT agent_ref FROM registry WHERE name=? AND agent_ref IS NOT NULL AND agent_ref<>''",
            (member_id,)).fetchone()
    except sqlite3.OperationalError:
        reg = None
    if reg:
        ag = conn.execute(
            "SELECT agent_id FROM agents WHERE agent_id=?", (reg[0],)).fetchone()
        if ag:
            return ag[0], "agent", _display(ag[0])
    return None


def roster(conn):
    """中台已接入的 Agent + 已配对外部 Agent。没有 online 字段，不用心跳冒充。"""
    ensure_schema(conn)
    places = {}
    try:
        rows = conn.execute(
            "SELECT name, location, agent_ref, status FROM registry WHERE kind='instance'"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    for name, loc, ref, status in rows:
        places.setdefault(ref or "", []).append({
            "name": name, "location": loc or "", "roster_status": status or "",
        })
    out = []
    try:
        agents = conn.execute(
            "SELECT agent_id, kind, status FROM agents ORDER BY kind, agent_id").fetchall()
    except sqlite3.OperationalError:
        agents = []
    for aid, kind, status in agents:
        item = {
            "id": aid,
            "name": _display(aid),
            "kind": kind or "agent",
            "roster_status": status or "",
            "roster_label": "在册" if status == "active" else "已暂停",
            "sender_badge": "你的 agent",
            "places": places.get(aid, []),
            "wake_registered": bool(webhook_for(conn, aid)),
        }
        item.update(_talk(conn, aid, paired=False))
        out.append(item)
    for ext_id, name, seconds, url in conn.execute(
            "SELECT ext_id, name, checkin_seconds, webhook_url FROM external_agents "
            "WHERE revoked_at IS NULL ORDER BY created_at"):
        item = {
            "id": ext_id,
            "name": name,
            "kind": "external",
            "roster_status": "active",
            "roster_label": "外部",
            "sender_badge": "外部",
            "places": [],
            "wake_registered": bool(url or webhook_for(conn, ext_id)),
            "checkin_seconds": max(int(seconds or DEFAULT_CHECKIN), MIN_CHECKIN),
        }
        item.update(_talk(conn, ext_id, paired=True))
        out.append(item)
    return out


def _insert(conn, from_agent, group_id, text, kind, reply_to=None):
    """直接写入 messages。不调用 commander_hook，不写 events，不插入 tasks。"""
    ensure_schema(conn)
    mid = message_bus.new_msg_id()
    now = _now()
    reply_to = str(reply_to or "").strip() or None
    conn.execute(
        "INSERT INTO messages(msg_id,from_agent,from_instance,\"to\",kind,text,"
        "reply_to,thread_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (mid, from_agent, None, group_id, kind, text, reply_to, group_id, now))
    conn.commit()
    return {
        "msg_id": mid, "from_agent": from_agent, "from_instance": None,
        "to": group_id, "kind": kind, "text": text, "reply_to": reply_to,
        "thread_id": group_id, "created_at": now,
    }


def _post_notice(conn, group_id, text):
    return _insert(conn, SYSTEM_ID, group_id, text, "notice")


def _classify(from_agent, names):
    if from_agent == HUMAN_ID:
        return "human", "人", HUMAN_NAME
    if from_agent == SYSTEM_ID:
        return "system", "", "系统"
    if str(from_agent or "").startswith("ext_"):
        return "external", "外部", names.get(from_agent) or from_agent
    return "agent", "你的 agent", names.get(from_agent) or _display(from_agent)


def _flags(conn, msg_ids):
    if not msg_ids:
        return {}
    ph = ",".join("?" * len(msg_ids))
    return {mid: (at, by) for mid, at, by in conn.execute(
        "SELECT msg_id, recalled_at, recalled_by FROM message_flags WHERE msg_id IN (%s)" % ph,
        list(msg_ids))}


def _present_row(row, names, flags):
    mid = row["msg_id"]
    role, badge, name = _classify(row["from_agent"], names)
    text = row["text"]
    recalled = mid in flags
    if recalled:
        return None
    system = role == "system" or row["kind"] == "notice"
    return {
        "msg_id": mid,
        "from_agent": row["from_agent"],
        "to": row["to"],
        "kind": "notice" if system else row["kind"],
        "text": text,
        "reply_to": row["reply_to"],
        "thread_id": row["thread_id"],
        "created_at": row["created_at"],
        "sender_role": "system" if system else role,
        "sender_badge": "" if system else badge,
        "sender_name": name if not system else "系统",
        "recalled": recalled,
    }


def _wake_rows(conn, msg_ids):
    if not msg_ids:
        return {}
    ph = ",".join("?" * len(msg_ids))
    out = {}
    for msg_id, member_id, status, http_status in conn.execute(
            "SELECT msg_id, member_id, status, http_status FROM group_wakes "
            "WHERE msg_id IN (%s) ORDER BY id" % ph, list(msg_ids)):
        out.setdefault(msg_id, []).append({
            "member_id": member_id, "status": status, "http_status": http_status,
        })
    return out


def _attach_wakes(conn, group_id, presented):
    """没打过叫醒的成员标成 no_webhook，方便查看。不因此补发。"""
    members = [mid for mid, in conn.execute(
        "SELECT member_id FROM chat_members WHERE group_id=?", (group_id,))]
    names = {mid: info["display_name"] for mid, info in _member_map(conn, group_id).items()}
    stored = _wake_rows(conn, [m["msg_id"] for m in presented])
    for msg in presented:
        if msg["sender_role"] == "system" and "撤回了" not in (msg["text"] or ""):
            msg["wakes"] = []
            continue
        have = {w["member_id"]: w for w in stored.get(msg["msg_id"], [])}
        wakes = []
        for mid in members:
            if mid == msg["from_agent"] or mid == HUMAN_ID or mid == SYSTEM_ID:
                continue
            w = have.get(mid) or {"member_id": mid, "status": "no_webhook", "http_status": None}
            w = dict(w)
            w["name"] = names.get(mid) or _display(mid)
            wakes.append(w)
        msg["wakes"] = wakes
    return presented


def list_group_messages(conn, group_id, since=None, limit=200):
    ensure_schema(conn)
    if not _group_row(conn, group_id):
        return None
    try:
        limit = max(1, min(int(limit or 200), 500))
    except (TypeError, ValueError):
        limit = 200
    sql = ('SELECT msg_id,from_agent,from_instance,"to",kind,text,reply_to,thread_id,created_at '
           'FROM messages WHERE "to"=?')
    params = [group_id]
    if since is not None:
        sql += " AND created_at>=?"
        params.append(int(since))
    sql += " ORDER BY created_at ASC, rowid ASC LIMIT ?"
    params.append(limit)
    cols = ("msg_id", "from_agent", "from_instance", "to", "kind", "text",
            "reply_to", "thread_id", "created_at")
    rows = [dict(zip(cols, r)) for r in conn.execute(sql, params).fetchall()]
    names = {mid: info["display_name"] for mid, info in _member_map(conn, group_id).items()}
    flags = _flags(conn, [r["msg_id"] for r in rows])
    presented = [p for p in (_present_row(r, names, flags) for r in rows) if p]
    return _attach_wakes(conn, group_id, presented)


def _member_public(conn, group_id):
    out = []
    for mid, kind, name, joined in conn.execute(
            "SELECT member_id, member_kind, display_name, joined_at "
            "FROM chat_members WHERE group_id=? ORDER BY joined_at, member_id",
            (group_id,)):
        item = {
            "member_id": mid,
            "member_kind": kind,
            "display_name": name,
            "joined_at": joined,
            "wake_registered": bool(webhook_for(conn, mid)) if mid != HUMAN_ID else False,
        }
        paired = kind == "external"
        item.update(_talk(conn, mid, paired=paired))
        if kind == "human":
            item["sender_badge"] = "人"
        elif kind == "external":
            item["sender_badge"] = "外部"
        else:
            item["sender_badge"] = "你的 agent"
        out.append(item)
    return out


def _last_preview(conn, group_id, names, flags_lookup=None):
    row = conn.execute(
        'SELECT msg_id, from_agent, kind, text, created_at FROM messages WHERE "to"=? '
        "ORDER BY created_at DESC, rowid DESC LIMIT 1", (group_id,)).fetchone()
    if not row:
        return None, None, ""
    msg_id, frm, kind, text, created = row
    flag = conn.execute(
        "SELECT recalled_by FROM message_flags WHERE msg_id=?", (msg_id,)).fetchone()
    if flag:
        who = names.get(flag[0]) or names.get(frm) or _display(frm)
        text = "%s 撤回了一条消息" % who
    role, badge, name = _classify(frm, names)
    if flag or kind == "notice" or frm == SYSTEM_ID:
        badge, name = "", "系统"
    return int(created), text, badge or name


def get_group(conn, group_id):
    ensure_schema(conn)
    row = _group_row(conn, group_id)
    if not row:
        return None
    members = _member_public(conn, group_id)
    names = {m["member_id"]: m["display_name"] for m in members}
    last_at, preview, last_who = _last_preview(conn, group_id, names)
    agents = sum(1 for m in members if m["member_kind"] in ("agent", "external"))
    humans = sum(1 for m in members if m["member_kind"] == "human")
    return {
        "group_id": row[0],
        "name": row[1],
        "created_by": row[2],
        "created_at": row[3],
        "join_policy": "invite",
        "join_label": JOIN_LABEL,
        "members": members,
        "agent_count": agents,
        "human_count": humans,
        "last_at": last_at,
        "last_preview": preview or "",
        "last_who": last_who,
    }


def list_groups(conn):
    ensure_schema(conn)
    ids = [r[0] for r in conn.execute(
        "SELECT group_id FROM chat_groups ORDER BY created_at DESC").fetchall()]
    groups = [get_group(conn, gid) for gid in ids]
    groups.sort(key=lambda g: (g.get("last_at") or 0, g.get("created_at") or 0), reverse=True)
    return groups


def create_group(conn, name, member_ids=None):
    ensure_schema(conn)
    name = _clean_name(name)
    if not name:
        return {"ok": False, "error": "请填写群名称"}
    if isinstance(member_ids, str):
        member_ids = [x.strip() for x in member_ids.split(",") if x.strip()]
    elif not isinstance(member_ids, (list, tuple)):
        member_ids = []
    gid = "grp_" + uuid.uuid4().hex[:12]
    now = _now()
    conn.execute(
        "INSERT INTO chat_groups(group_id, name, created_by, created_at) VALUES(?,?,?,?)",
        (gid, name, HUMAN_ID, now))
    conn.execute(
        "INSERT INTO chat_members(group_id, member_id, member_kind, display_name, joined_at) "
        "VALUES(?,?,?,?,?)",
        (gid, HUMAN_ID, "human", HUMAN_NAME, now))
    conn.commit()
    _post_notice(conn, gid, "群聊已建立")
    _post_notice(conn, gid, "%s 加入了群聊" % HUMAN_NAME)
    added, skipped = [], []
    for mid in member_ids:
        res = add_member(conn, gid, mid)
        if res.get("ok") and res.get("member_id"):
            added.append(res["member_id"])
        elif not res.get("ok"):
            skipped.append({"member_id": mid, "error": res.get("error")})
    return {"ok": True, "group_id": gid, "group": get_group(conn, gid),
            "added": added, "skipped": skipped}


def add_member(conn, group_id, member_id):
    ensure_schema(conn)
    if not _group_row(conn, group_id):
        return {"ok": False, "error": "群不存在"}
    resolved = _resolve_join(conn, member_id)
    if not resolved:
        return {"ok": False, "error": "%s 不在名册，也还没配对" % (member_id or "")}
    mid, kind, display = resolved
    if is_member(conn, group_id, mid):
        return {"ok": True, "member_id": mid, "note": "已经在群里"}
    conn.execute(
        "INSERT INTO chat_members(group_id, member_id, member_kind, display_name, joined_at) "
        "VALUES(?,?,?,?,?)",
        (group_id, mid, kind, display, _now()))
    conn.commit()
    _post_notice(conn, group_id, "%s 加入了群聊" % display)
    return {"ok": True, "member_id": mid, "display_name": display, "member_kind": kind}


def _default_wake(url, body):
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8",
                 "User-Agent": "super-brain-group-wake"})
    try:
        with urllib.request.urlopen(req, timeout=WAKE_TIMEOUT) as resp:
            return int(resp.status), ""
    except urllib.error.HTTPError as e:
        return int(e.code), "HTTPError"
    except Exception as e:
        return 0, type(e).__name__


def _wake_payload(group_id, msg_id):
    # 固定四个字段。没有 text，没有 token，没有口令。
    return {"event": "inbox", "group_id": group_id, "msg_id": msg_id, "pull": INBOX_PATH}


def wake_others(conn, group_id, msg_id, sender):
    """每个其他成员最多打一次。失败写入 group_wakes，调用方不要据此重试或派任务。"""
    payload = _wake_payload(group_id, msg_id)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    transport = _TRANSPORT["fn"] or _default_wake
    out = []
    members = [r[0] for r in conn.execute(
        "SELECT member_id FROM chat_members WHERE group_id=?", (group_id,))]
    for mid in members:
        if mid in (sender, HUMAN_ID, SYSTEM_ID):
            continue
        url = webhook_for(conn, mid)
        if not url:
            out.append({"member_id": mid, "status": "no_webhook", "http_status": None})
            continue
        try:
            status, err = transport(url, body)
            status = int(status or 0)
        except Exception as e:
            status, err = 0, type(e).__name__
        if 200 <= status < 300:
            st, err = "delivered", ""
        else:
            st = "missed"
        conn.execute(
            "INSERT INTO group_wakes(msg_id, group_id, member_id, status, http_status, error, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (msg_id, group_id, mid, st, status or None, (err or "")[:40], _now()))
        out.append({"member_id": mid, "status": st, "http_status": status or None})
    conn.commit()
    return out


def post_as_member(conn, sender_id, group_id, text, reply_to=None):
    ensure_schema(conn)
    if not _group_row(conn, group_id):
        return {"ok": False, "error": "群不存在"}
    if not is_member(conn, group_id, sender_id):
        return {"ok": False, "error": "你不在这个群"}
    text = str(text or "").strip()
    if not text:
        return {"ok": False, "error": "空消息"}
    if len(text) > message_bus.MAX_TEXT:
        return {"ok": False, "error": "正文过长（>%d 字）" % message_bus.MAX_TEXT}
    reply_to = str(reply_to or "").strip() or None
    if reply_to:
        parent = message_bus.get_message(conn, reply_to)
        if not parent or parent.get("to") != group_id:
            return {"ok": False, "error": "要回复的消息不在这个群"}
        if conn.execute(
                "SELECT 1 FROM message_flags WHERE msg_id=?", (reply_to,)).fetchone():
            return {"ok": False, "error": "这条消息已撤回"}
    row = _insert(conn, sender_id, group_id, text, "chat", reply_to=reply_to)
    wakes = wake_others(conn, group_id, row["msg_id"], sender_id)
    presented = list_group_messages(conn, group_id, since=row["created_at"], limit=20)
    mine = next((m for m in (presented or []) if m["msg_id"] == row["msg_id"]), None)
    if mine is None:
        names = {mid: info["display_name"] for mid, info in _member_map(conn, group_id).items()}
        mine = _present_row(row, names, {})
        mine["wakes"] = wakes
    return {"ok": True, "message": mine, "msg_id": row["msg_id"],
            "group_id": group_id, "wakes": mine.get("wakes") or wakes,
            "note": "已写入消息总线。叫醒只发一次信号，正文要对方自己拉收件箱。"}


def recall(conn, actor_id, group_id, msg_id):
    ensure_schema(conn)
    if not _group_row(conn, group_id):
        return {"ok": False, "error": "群不存在"}
    if not is_member(conn, group_id, actor_id):
        return {"ok": False, "error": "你不在这个群"}
    msg = message_bus.get_message(conn, msg_id)
    if not msg or msg.get("to") != group_id:
        return {"ok": False, "error": "消息不在这个群"}
    if msg.get("kind") == "notice" or msg.get("from_agent") == SYSTEM_ID:
        return {"ok": False, "error": "系统消息不能撤回"}
    if msg.get("from_agent") != actor_id:
        return {"ok": False, "error": "只能撤回自己的消息"}
    if conn.execute("SELECT 1 FROM message_flags WHERE msg_id=?", (msg_id,)).fetchone():
        return {"ok": True, "msg_id": msg_id, "note": "已经撤回"}
    names = {mid: info["display_name"] for mid, info in _member_map(conn, group_id).items()}
    who = names.get(actor_id) or _display(actor_id)
    conn.execute(
        "INSERT INTO message_flags(msg_id, recalled_at, recalled_by) VALUES(?,?,?)",
        (msg_id, _now(), actor_id))
    # 原文从总线上抹掉，避免只读消息流还能看到。另外写一条系统行，SSE 才能通知正在看的人。
    conn.execute(
        "UPDATE messages SET text=?, kind='notice' WHERE msg_id=?",
        ("（已撤回）", msg_id))
    conn.commit()
    note = _post_notice(conn, group_id, "%s 撤回了一条消息" % who)
    wake_others(conn, group_id, note["msg_id"], SYSTEM_ID)
    return {"ok": True, "msg_id": msg_id, "notice_id": note["msg_id"]}


def create_pair_code(conn, group_id=None, suggested_name=""):
    ensure_schema(conn)
    group_id = str(group_id or "").strip() or None
    if group_id and not _group_row(conn, group_id):
        return {"ok": False, "error": "群不存在"}
    raw = secrets_token()
    now = _now()
    conn.execute(
        "INSERT INTO ext_pair_codes(code_hash, created_at, expires_at, created_by, group_id, suggested_name) "
        "VALUES(?,?,?,?,?,?)",
        (_hash(raw), now, now + PAIR_TTL, HUMAN_ID, group_id, _clean_name(suggested_name)))
    conn.commit()
    group_name = None
    if group_id:
        grow = _group_row(conn, group_id)
        group_name = grow[1] if grow else None
    return {
        "ok": True,
        "code": raw,
        "expires_at": now + PAIR_TTL,
        "ttl_seconds": PAIR_TTL,
        "group_id": group_id,
        "group_name": group_name,
        "doc_path": DOC_PATH,
        "skill_path": SKILL_PATH,
        "note": "配对码只显示这一次，服务端只存哈希。30 分钟内一次性有效。",
    }


def secrets_token(nbytes=32):
    import secrets
    return secrets.token_urlsafe(nbytes)


def redeem_pair(conn, code, name, webhook_url="", checkin_seconds=None):
    ensure_schema(conn)
    code = str(code or "").strip()
    if not code:
        return {"ok": False, "error": "缺少配对码"}
    row = conn.execute(
        "SELECT expires_at, used_at, group_id, suggested_name FROM ext_pair_codes WHERE code_hash=?",
        (_hash(code),)).fetchone()
    if not row:
        return {"ok": False, "error": "配对码无效"}
    if row[1]:
        return {"ok": False, "error": "配对码已使用"}
    if int(row[0]) < _now():
        return {"ok": False, "error": "配对码已过期"}
    name = _clean_name(name or row[3] or "")
    if not name:
        return {"ok": False, "error": "请给这个 Agent 起个名字"}
    url = ""
    if str(webhook_url or "").strip():
        url = _valid_url(webhook_url)
        if not url:
            return {"ok": False, "error": "webhook 需要是 http 或 https 地址"}
    seconds = DEFAULT_CHECKIN
    if checkin_seconds not in (None, ""):
        try:
            seconds = int(checkin_seconds)
        except (TypeError, ValueError):
            return {"ok": False, "error": "checkin_seconds 必须是整数"}
        if seconds < MIN_CHECKIN:
            return {"ok": False, "error": "check-in 间隔至少 1 小时，不能设成分钟级"}
        if seconds > 7 * 86400:
            return {"ok": False, "error": "check-in 间隔最长 7 天"}
    token = secrets_token(32)
    ext_id = "ext_" + uuid.uuid4().hex[:10]
    now = _now()
    conn.execute(
        "INSERT INTO external_agents(ext_id, name, token_hash, webhook_url, checkin_seconds, created_at) "
        "VALUES(?,?,?,?,?,?)",
        (ext_id, name, _hash(token), url or None, seconds, now))
    conn.execute(
        "UPDATE ext_pair_codes SET used_at=?, used_by=? WHERE code_hash=?",
        (now, ext_id, _hash(code)))
    if url:
        conn.execute(
            "INSERT OR REPLACE INTO wake_hooks(member_id, url, updated_at) VALUES(?,?,?)",
            (ext_id, url, now))
    conn.commit()
    joined = None
    if row[2] and _group_row(conn, row[2]):
        add_member(conn, row[2], ext_id)
        joined = row[2]
    return {
        "ok": True,
        "token": token,
        "ext_id": ext_id,
        "name": name,
        "group_id": joined,
        "checkin_seconds": seconds,
        "webhook_registered": bool(url),
        "note": "令牌只此一次。服务端只存哈希。有消息时会 POST 你的 webhook（不含正文和令牌），然后你自己拉收件箱。",
    }


def external_by_token(conn, token):
    token = str(token or "").strip()
    if not token:
        return None
    row = conn.execute(
        "SELECT ext_id, name, checkin_seconds, webhook_url, last_checkin_at "
        "FROM external_agents WHERE token_hash=? AND revoked_at IS NULL",
        (_hash(token),)).fetchone()
    if not row:
        return None
    return {
        "id": row[0], "kind": "external", "name": row[1],
        "checkin_seconds": max(int(row[2] or DEFAULT_CHECKIN), MIN_CHECKIN),
        "webhook_registered": bool(row[3]),
        "last_checkin_at": row[4],
    }


def actor_from_token(conn, token, chief_tokens):
    ensure_schema(conn)
    ext = external_by_token(conn, token)
    if ext:
        return ext
    ident = message_bus.identity_from_token(chief_tokens or {}, token)
    chief = ident.get("chief")
    if not chief:
        return None
    ag = None
    try:
        ag = conn.execute(
            "SELECT agent_id, status FROM agents WHERE agent_id=?", (chief,)).fetchone()
    except sqlite3.OperationalError:
        ag = None
    if not ag:
        return None
    return {"id": ag[0], "kind": "agent", "name": _display(ag[0]),
            "webhook_registered": bool(webhook_for(conn, ag[0]))}


def set_webhook(conn, member_id, url):
    ensure_schema(conn)
    member_id = str(member_id or "").strip()
    if not member_id or member_id == HUMAN_ID:
        return {"ok": False, "error": "缺少要登记唤醒地址的 Agent"}
    known = _resolve_join(conn, member_id)
    if not known:
        return {"ok": False, "error": "这个 Agent 不在名册，也还没配对"}
    member_id = known[0]
    if url is None or str(url).strip() == "":
        conn.execute("DELETE FROM wake_hooks WHERE member_id=?", (member_id,))
        conn.execute(
            "UPDATE external_agents SET webhook_url=NULL WHERE ext_id=?", (member_id,))
        conn.commit()
        return {"ok": True, "member_id": member_id, "registered": False}
    clean = _valid_url(url)
    if not clean:
        return {"ok": False, "error": "webhook 需要是 http 或 https 地址"}
    now = _now()
    conn.execute(
        "INSERT OR REPLACE INTO wake_hooks(member_id, url, updated_at) VALUES(?,?,?)",
        (member_id, clean, now))
    conn.execute(
        "UPDATE external_agents SET webhook_url=? WHERE ext_id=?", (clean, member_id))
    conn.commit()
    return {"ok": True, "member_id": member_id, "registered": True,
            "note": "已登记。叫醒时只 POST 信号，不附消息正文，也不附令牌。"}


def set_checkin_interval(conn, ext_id, seconds):
    ensure_schema(conn)
    ext_id = str(ext_id or "").strip()
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        return {"ok": False, "error": "seconds 必须是整数"}
    if seconds < MIN_CHECKIN:
        return {"ok": False, "error": "间隔至少 1 小时（3600 秒）。禁止分钟级定时，check-in 只是稀疏兜底。"}
    if seconds > 7 * 86400:
        return {"ok": False, "error": "间隔最长 7 天"}
    cur = conn.execute(
        "UPDATE external_agents SET checkin_seconds=? WHERE ext_id=? AND revoked_at IS NULL",
        (seconds, ext_id))
    conn.commit()
    if not cur.rowcount:
        return {"ok": False, "error": "没有这个外部 Agent"}
    return {"ok": True, "ext_id": ext_id, "checkin_seconds": seconds,
            "note": "这只是对方自己掌握的兜底间隔，服务端不会按这个频率去轮询。"}


def checkin(conn, actor):
    """外部 Agent 自己来打卡。到点才接受；没到点直接告诉它，不重试、不派任务。"""
    ensure_schema(conn)
    if not actor or actor.get("kind") != "external":
        return {"ok": True, "accepted": False, "reason": "not_external",
                "note": "已接入的中台 Agent 不走定时打卡。有消息时用 webhook 叫醒，然后自己拉收件箱。"}
    row = conn.execute(
        "SELECT checkin_seconds, last_checkin_at FROM external_agents WHERE ext_id=? AND revoked_at IS NULL",
        (actor["id"],)).fetchone()
    if not row:
        return {"ok": False, "error": "外部 Agent 不存在"}
    interval = max(int(row[0] or DEFAULT_CHECKIN), MIN_CHECKIN)
    last = int(row[1] or 0)
    now = _now()
    if last and now - last < interval:
        return {"ok": True, "accepted": False, "reason": "too_soon",
                "checkin_seconds": interval, "next_after": last + interval,
                "note": "还没到稀疏兜底时间。不要立刻重试，不要派新任务。主通道是 webhook。"}
    conn.execute(
        "UPDATE external_agents SET last_checkin_at=? WHERE ext_id=?", (now, actor["id"]))
    conn.commit()
    return {"ok": True, "accepted": True, "checkin_seconds": interval,
            "next_after": now + interval, "inbox": INBOX_PATH,
            "note": "兜底打卡已记下。请自己 GET 收件箱。这不是主通道。"}


def inbox_for(conn, actor, since=None, limit=100):
    ensure_schema(conn)
    mids = [r[0] for r in conn.execute(
        "SELECT group_id FROM chat_members WHERE member_id=?", (actor["id"],))]
    groups = []
    messages = []
    try:
        limit = max(1, min(int(limit or 100), 500))
    except (TypeError, ValueError):
        limit = 100
    for gid in mids:
        g = get_group(conn, gid)
        if g:
            groups.append({"group_id": g["group_id"], "name": g["name"],
                           "join_label": g["join_label"]})
        batch = list_group_messages(conn, gid, since=since, limit=limit) or []
        messages.extend(batch)
    messages.sort(key=lambda m: (m["created_at"], m["msg_id"]))
    if len(messages) > limit:
        messages = messages[-limit:]
    data = {
        "groups": groups,
        "messages": messages,
        "server_time": _now(),
        "pull": INBOX_PATH,
        "note": "收件箱由你自己拉。webhook 里没有正文和令牌。漏了通知只看 wakes 状态，不要自动重试，不要派新任务。",
    }
    if actor.get("kind") == "external":
        data["checkin_seconds"] = actor.get("checkin_seconds") or DEFAULT_CHECKIN
        last = int(actor.get("last_checkin_at") or 0)
        data["next_checkin_after"] = (last + data["checkin_seconds"]) if last else _now()
    return data


def route_cmd(conn, chief_id, cmd, args):
    """/cmd msg|reply 若目标是群，改走群消息。不是群则返回 None，老路径不动。"""
    ensure_schema(conn)
    args = args or {}
    if cmd == "reply":
        reply_to = str(args.get("reply_to") or args.get("id") or "").strip()
        if not reply_to:
            return None
        parent = message_bus.get_message(conn, reply_to)
        if parent and str(parent.get("to") or "").startswith("grp_"):
            return post_as_member(conn, chief_id, parent["to"], args.get("text", ""),
                                  reply_to=reply_to)
        return None
    if cmd == "msg":
        to = str(args.get("to") or "")
        if to.startswith("grp_"):
            return post_as_member(conn, chief_id, to, args.get("text", ""),
                                  reply_to=args.get("reply_to"))
    return None


def owner_act(conn, who, action, args):
    args = args or {}
    if action == "group_create":
        return create_group(conn, args.get("name"), args.get("members") or args.get("member_ids"))
    if action == "group_add":
        return add_member(conn, args.get("group_id"), args.get("member_id"))
    if action == "group_send":
        return post_as_member(conn, HUMAN_ID, args.get("group_id"), args.get("text"),
                              reply_to=args.get("reply_to"))
    if action == "group_pair":
        return create_pair_code(conn, args.get("group_id"), args.get("name") or "")
    if action == "group_recall":
        return recall(conn, HUMAN_ID, args.get("group_id"), args.get("msg_id"))
    if action == "group_webhook":
        return set_webhook(conn, args.get("member_id"), args.get("url"))
    if action == "group_checkin":
        return set_checkin_interval(conn, args.get("ext_id") or args.get("member_id"),
                                    args.get("seconds"))
    return {"ok": False, "error": "未知操作 %s" % action}


def _since_of(q):
    raw = (q or {}).get("since")
    if raw in (None, ""):
        return None, None
    try:
        return int(raw), None
    except (TypeError, ValueError):
        return None, "since 必须是 unix 时间戳"


def handle_public_get(conn, path, q, now):
    """操作台只读。不含令牌、配对码、webhook 地址。"""
    ensure_schema(conn)
    if path == "/api/groupchat/roster":
        return 200, {"ok": True, "ts": now, "data": roster(conn),
                     "note": "不根据心跳显示在线。talk_state=proven 表示消息总线上有过成功收发。"}
    if path == "/api/groupchat/groups":
        return 200, {"ok": True, "ts": now, "data": list_groups(conn)}
    m = re.fullmatch(r"/api/groupchat/groups/(grp_[0-9a-f]+)/messages", path)
    if m:
        since, err = _since_of(q)
        if err:
            return 400, {"ok": False, "error": err}
        limit = (q or {}).get("limit") or 200
        data = list_group_messages(conn, m.group(1), since=since, limit=limit)
        if data is None:
            return 404, {"ok": False, "error": "群不存在"}
        return 200, {"ok": True, "ts": now, "data": data, "total": len(data)}
    m = re.fullmatch(r"/api/groupchat/groups/(grp_[0-9a-f]+)", path)
    if m:
        data = get_group(conn, m.group(1))
        if not data:
            return 404, {"ok": False, "error": "群不存在"}
        return 200, {"ok": True, "ts": now, "data": data}
    if path == "/api/groupchat/wakes":
        msg_id = str((q or {}).get("msg_id") or "").strip()
        if not msg_id:
            return 400, {"ok": False, "error": "缺 msg_id"}
        rows = [{"member_id": a, "status": b, "http_status": c, "at": d} for a, b, c, d in
                conn.execute(
                    "SELECT member_id, status, http_status, created_at FROM group_wakes "
                    "WHERE msg_id=? ORDER BY id", (msg_id,))]
        return 200, {"ok": True, "ts": now, "data": rows,
                     "note": "只查状态。missed 不会自动重试，也不会派新任务。"}
    if path in ("/api/groupchat/inbox", "/api/groupchat/me"):
        return 401, {"ok": False, "error": "这个接口要带令牌", "need_token": True}
    if path.startswith("/api/groupchat"):
        return 404, {"ok": False, "error": "not found"}
    return None


def handle_authed_get(conn, path, q, token, chief_tokens):
    actor = actor_from_token(conn, token, chief_tokens)
    if not actor:
        return 401, {"ok": False, "error": "需要用配对换来的令牌，或已接入 Agent 自己的令牌",
                     "need_token": True}
    if path == "/api/groupchat/me":
        groups = [r[0] for r in conn.execute(
            "SELECT group_id FROM chat_members WHERE member_id=?", (actor["id"],))]
        return 200, {"ok": True, "data": {
            "id": actor["id"], "name": actor["name"], "kind": actor["kind"],
            "webhook_registered": bool(actor.get("webhook_registered")),
            "checkin_seconds": actor.get("checkin_seconds"),
            "groups": groups,
        }}
    if path == "/api/groupchat/inbox":
        since, err = _since_of(q)
        if err:
            return 400, {"ok": False, "error": err}
        return 200, {"ok": True, "data": inbox_for(conn, actor, since=since, limit=(q or {}).get("limit") or 100)}
    return 404, {"ok": False, "error": "not found"}


def handle_post(conn, path, body, token, chief_tokens):
    body = body or {}
    path = (path or "").rstrip("/") or "/"
    if path == "/api/groupchat/pair":
        res = redeem_pair(conn, body.get("code"), body.get("name"),
                          body.get("webhook_url") or "", body.get("checkin_seconds"))
        return (200 if res.get("ok") else 400), res
    actor = actor_from_token(conn, token, chief_tokens)
    if not actor:
        return 401, {"ok": False, "error": "需要用配对换来的令牌，或已接入 Agent 自己的令牌",
                     "need_token": True}
    if path == "/api/groupchat/messages":
        res = post_as_member(conn, actor["id"], body.get("group_id"), body.get("text"),
                             reply_to=body.get("reply_to"))
        return (200 if res.get("ok") else 400), res
    if path == "/api/groupchat/webhook":
        res = set_webhook(conn, actor["id"], body.get("url"))
        return (200 if res.get("ok") else 400), res
    if path == "/api/groupchat/checkin":
        res = checkin(conn, actor)
        return (200 if res.get("ok") else 400), res
    if path == "/api/groupchat/recall":
        res = recall(conn, actor["id"], body.get("group_id"), body.get("msg_id"))
        return (200 if res.get("ok") else 400), res
    return 404, {"ok": False, "error": "not found"}
