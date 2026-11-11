#!/usr/bin/env python3
# Super-Brain 大古（dagu-owner）操作层：设备配对、审批中心、介入操作、知识库编辑、审计。
# 身份：dagu-owner 是独立身份，不复用任何 Agent 口令。认证二选一：
#   1) /etc/super-brain/api_tokens.json 的 "owner": {"dagu-owner": "<口令>"}（服务器上手工/CLI 生成）；
#   2) 设备令牌：由一次性配对码换取，库里只存 sha256，不存明文；可逐台吊销。
# 配对码：一次性、24 小时有效、库里只存 sha256；用后即废。
# 所有写操作写 owner_audit（谁、何时、做了什么、成败），控制台只读可见（不含 IP）。
# 不提供删除类、交易类操作。
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

import message_bus

OWNER_ID = "dagu-owner"
PAIR_TTL = 24 * 3600
ROOT = Path(__file__).resolve().parents[2]
KB_HISTORY = ROOT / "99-Local" / "kb-history"     # 本地留底，gitignore，不上云
MAX_KB_BYTES = 1_500_000
MAX_NOTE = 2000

SCHEMA = """
CREATE TABLE IF NOT EXISTS owner_devices(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  paired_via TEXT
);
CREATE TABLE IF NOT EXISTS owner_pair_codes(
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id INTEGER,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS owner_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  device TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_owner_audit_ts ON owner_audit(ts);
CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester TEXT NOT NULL,
  requester_instance TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  task_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_note TEXT,
  notes TEXT,                               -- 批注历史 JSON 数组
  result_msg_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
"""


def _has_col(conn, table, col):
    return any(r[1] == col for r in conn.execute("PRAGMA table_info(%s)" % table))


def ensure_schema(conn):
    conn.executescript(SCHEMA)
    for col, typ in (("kind", "TEXT NOT NULL DEFAULT 'approval'"),
                     ("options", "TEXT"), ("assist_kind", "TEXT")):
        if not _has_col(conn, "approvals", col):
            conn.execute("ALTER TABLE approvals ADD COLUMN %s %s" % (col, typ))
    # dagu-owner 登记进名册（kind=owner），Agent 才能回复大古的消息；不进 agents 表、不领任务
    try:
        conn.execute("INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
                     "VALUES(?,?,?,?,'active',?)", (OWNER_ID, "owner", "大古本人", OWNER_ID, _now()))
        conn.commit()
    except Exception:
        pass


def _h(s):
    return hashlib.sha256(str(s).encode()).hexdigest()


def _now():
    return int(time.time())


# ---------------- 认证与配对 ----------------

def authenticate(conn, token, owners):
    """返回 {'actor','device','device_id'} 或 None。Agent 口令不在 owners 里，天然无效。"""
    if not token:
        return None
    for oid, t in (owners or {}).items():
        if t and hmac.compare_digest(str(t).encode(), token.encode()):
            return {"actor": oid, "device": "主口令", "device_id": None}
    ensure_schema(conn)
    row = conn.execute(
        "SELECT id, name FROM owner_devices WHERE token_hash=? AND revoked_at IS NULL",
        (_h(token),)).fetchone()
    if not row:
        return None
    conn.execute("UPDATE owner_devices SET last_used_at=? WHERE id=?", (_now(), row[0]))
    conn.commit()
    return {"actor": OWNER_ID, "device": row[1], "device_id": row[0]}


def create_pair_code(conn, created_by="cli", ttl=PAIR_TTL):
    """返回明文配对码（只此一次）；库里只存哈希。"""
    ensure_schema(conn)
    code = secrets.token_urlsafe(24)
    now = _now()
    conn.execute("INSERT INTO owner_pair_codes(code_hash,created_at,expires_at,created_by) VALUES(?,?,?,?)",
                 (_h(code), now, now + int(ttl), created_by))
    conn.commit()
    return code, now + int(ttl)


def pair(conn, code, device_name):
    """一次性配对码 → 长期设备令牌（明文只返回这一次）。"""
    ensure_schema(conn)
    code = str(code or "").strip()
    if not code or len(code) > 200:
        return {"ok": False, "error": "配对码无效"}
    row = conn.execute("SELECT expires_at, used_at FROM owner_pair_codes WHERE code_hash=?",
                       (_h(code),)).fetchone()
    if not row:
        return {"ok": False, "error": "配对码无效"}
    if row[1]:
        return {"ok": False, "error": "配对码已用过（一次性）"}
    if row[0] < _now():
        return {"ok": False, "error": "配对码已过期（24 小时有效）"}
    name = re.sub(r"[\x00-\x1f]", "", str(device_name or "未命名设备"))[:60] or "未命名设备"
    token = secrets.token_urlsafe(32)
    now = _now()
    cur = conn.execute("INSERT INTO owner_devices(name,token_hash,created_at,last_used_at,paired_via) "
                       "VALUES(?,?,?,?,'pair_code')", (name, _h(token), now, now))
    did = cur.lastrowid
    upd = conn.execute("UPDATE owner_pair_codes SET used_at=?, device_id=? WHERE code_hash=? AND used_at IS NULL",
                       (now, did, _h(code)))
    if upd.rowcount != 1:                      # 并发抢用：回滚这台设备
        conn.rollback()
        return {"ok": False, "error": "配对码已用过（一次性）"}
    conn.commit()
    return {"ok": True, "token": token, "device_id": did, "device": name, "actor": OWNER_ID}


def audit(conn, who, action, target="", detail=None, ok=True, ip=""):
    ensure_schema(conn)
    d = json.dumps(detail or {}, ensure_ascii=False)[:4000]
    conn.execute("INSERT INTO owner_audit(ts,actor,device,ip,action,target,detail,ok) VALUES(?,?,?,?,?,?,?,?)",
                 (_now(), (who or {}).get("actor", "?"), (who or {}).get("device", ""), ip[:64],
                  action[:60], str(target or "")[:200], d, 1 if ok else 0))
    conn.commit()


def list_audit(conn, limit=60):
    ensure_schema(conn)
    rows = conn.execute("SELECT id,ts,actor,device,action,target,detail,ok FROM owner_audit "
                        "ORDER BY id DESC LIMIT ?", (int(limit),)).fetchall()
    out = []
    for r in rows:
        try:
            det = json.loads(r[6] or "{}")
        except Exception:
            det = {}
        out.append({"id": r[0], "ts": r[1], "actor": r[2], "device": r[3], "action": r[4],
                    "target": r[5], "detail": det, "ok": bool(r[7])})
    return out


# ---------------- 审批中心 ----------------

def request_approval(conn, chief_id, args):
    """Agent 经 /cmd approval_request 提交待批示事项。"""
    ensure_schema(conn)
    title = str(args.get("title") or "").strip()[:200]
    if not title:
        return {"ok": False, "error": "approval_request 必带 title"}
    detail = str(args.get("detail") or "")[:8000]
    kind = str(args.get("kind") or "approval").strip().lower()
    if kind not in ("approval", "assist"):
        return {"ok": False, "error": "kind 只能是 approval 或 assist"}
    assist_kind = str(args.get("assist_kind") or args.get("ask") or "").strip().lower() or None
    if kind == "assist":
        if assist_kind not in ("url", "text", "vault", None):
            return {"ok": False, "error": "assist_kind 只能是 url / text / vault"}
        assist_kind = assist_kind or "text"
    else:
        assist_kind = None
    opts = args.get("options")
    if opts is None and kind == "approval":
        opts = ["同意", "驳回"]
    if opts is not None:
        if not isinstance(opts, list) or not all(isinstance(x, str) and x.strip() for x in opts):
            return {"ok": False, "error": "options 必须是非空字符串数组"}
        opts = [x.strip()[:40] for x in opts][:8]
        if len(opts) < 2 and kind == "approval":
            return {"ok": False, "error": "审批至少要 2 个选项"}
    inst = str(args.get("instance") or args.get("from_instance") or "").strip()
    if inst:
        _, err = message_bus.resolve_instance(conn, chief_id, inst)
        if err:
            return {"ok": False, "error": err}
    tid = args.get("task_id")
    try:
        tid = int(tid) if tid not in (None, "") else None
    except (TypeError, ValueError):
        return {"ok": False, "error": "task_id 必须是整数"}
    import projects
    projects.ensure_schema(conn)
    proj = str(args.get("project_id") or "").strip() or None
    if proj and not conn.execute("SELECT 1 FROM projects WHERE id=?", (proj,)).fetchone():
        return {"ok": False, "error": f"项目 {proj} 不存在"}
    cur = conn.execute(
        "INSERT INTO approvals(requester,requester_instance,title,detail,task_id,status,created_at,kind,options,assist_kind,project_id) "
        "VALUES(?,?,?,?,?,'pending',?,?,?,?,?)",
        (chief_id, inst or None, title, detail, tid, _now(), kind,
         json.dumps(opts, ensure_ascii=False) if opts else None, assist_kind, proj))
    conn.commit()
    return {"ok": True, "approval_id": cur.lastrowid, "status": "pending", "kind": kind,
            "note": "已进大古的审批中心；结果会经消息总线推回你（to=你的实例或 chief）"}


def approval_status(conn, chief_id, args):
    ensure_schema(conn)
    try:
        aid = int(args.get("id") or args.get("approval_id"))
    except (TypeError, ValueError):
        return {"ok": False, "error": "缺 id"}
    r = _approval(conn, aid)
    if not r or r["requester"] != chief_id:
        return {"ok": False, "error": f"审批 #{aid} 不存在或不属于你"}
    return {"ok": True, "approval": r}


def _approval(conn, aid):
    row = conn.execute("SELECT id,requester,requester_instance,title,detail,task_id,status,created_at,"
                       "decided_at,decided_by,decision_note,notes,result_msg_id FROM approvals WHERE id=?",
                       (aid,)).fetchone()
    if not row:
        return None
    keys = ("id", "requester", "requester_instance", "title", "detail", "task_id", "status", "created_at",
            "decided_at", "decided_by", "decision_note", "notes", "result_msg_id")
    d = dict(zip(keys, row))
    # 兼容尚未 SELECT 新列的旧查询：再补读
    try:
        extra = conn.execute("SELECT kind,options,assist_kind,project_id FROM approvals WHERE id=?", (d["id"],)).fetchone()
        d["project_id"] = extra[3]
        d["kind"] = extra[0] or "approval"
        try:
            d["options"] = json.loads(extra[1] or "[]") if extra[1] else []
        except Exception:
            d["options"] = []
        d["assist_kind"] = extra[2]
    except Exception:
        d.setdefault("kind", "approval")
        d.setdefault("options", [])
        d.setdefault("assist_kind", None)
    try:
        d["notes"] = json.loads(d["notes"] or "[]")
    except Exception:
        d["notes"] = []
    return d


def list_approvals(conn, limit=40):
    ensure_schema(conn)
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM approvals ORDER BY (status='pending') DESC, id DESC LIMIT ?", (int(limit),))]
    return [_approval(conn, i) for i in ids]


def decision_tasks(conn, limit=30):
    """待拍板任务：pending 且 priority>=1，或 fuse-review（零消耗挂起等大古拍板）。"""
    rows = conn.execute(
        "SELECT id,type,status,priority,created_at,substr(payload,1,1200) FROM tasks "
        "WHERE status='pending' AND (priority>=1 OR type='fuse-review') ORDER BY id DESC LIMIT ?",
        (int(limit),)).fetchall()
    out = []
    for tid, tt, st, pr, ca, pl in rows:
        try:
            p = json.loads(pl)
        except Exception:
            p = {}
        out.append({"id": tid, "type": tt, "status": st, "priority": pr, "created_at": ca,
                    "text": str(p.get("text") or pl)[:600] if isinstance(p, dict) else str(pl)[:600],
                    "from": p.get("from") if isinstance(p, dict) else None,
                    "to": (p.get("to_agent") or p.get("to")) if isinstance(p, dict) else None})
    return out


def _notify(conn, to, text):
    """经消息总线推给对方；对方不在名册时不报错，只记录未投递。"""
    if not to:
        return None
    res = message_bus.post_message(conn, OWNER_ID, text, to=to, kind="chat")
    return res.get("msg_id") if res.get("ok") else None


# ---------------- 介入操作 ----------------

def _target_entry(conn, name):
    entry = message_bus.lookup_name(conn, name)
    if not entry or entry.get("status") != "active":
        return None
    return entry


def _task_row(conn, tid):
    row = conn.execute("SELECT id,type,payload,status,lease_owner FROM tasks WHERE id=?", (tid,)).fetchone()
    if not row:
        return None
    try:
        p = json.loads(row[2])
    except Exception:
        p = {}
    return {"id": row[0], "type": row[1], "payload_raw": row[2], "payload": p if isinstance(p, dict) else {},
            "status": row[3], "lease_owner": row[4]}


def _task_party(conn, t):
    p = t["payload"]
    for cand in (p.get("from"), t.get("lease_owner")):
        if cand and cand != OWNER_ID and _target_entry(conn, cand):
            return cand
    return None


def execute(conn, who, action, args, emit=None):
    """大古的写操作。返回 dict（含 ok）。调用方负责审计。"""
    args = args or {}
    note = str(args.get("note") or "").strip()[:MAX_NOTE]

    if action == "msg":
        to = str(args.get("to") or "").strip()
        if not to:
            return {"ok": False, "error": "缺收件人"}
        if to != "all" and not _target_entry(conn, to):
            return {"ok": False, "error": f"{to} 不在名册或已下线"}
        return message_bus.post_message(conn, OWNER_ID, args.get("text", ""), to=to, kind="chat",
                                        reply_to=args.get("reply_to"))

    if action == "rollcall":
        text = str(args.get("text") or "在的回复 1").strip()[:200]
        return message_bus.post_message(conn, OWNER_ID, text, to="all", kind="ping")

    if action == "submit":
        target = str(args.get("to") or "").strip()
        text = str(args.get("text") or "").strip()
        if not text:
            return {"ok": False, "error": "空指令"}
        entry = _target_entry(conn, target)
        if not entry:
            return {"ok": False, "error": f"{target} 不在名册或已下线，未入队"}
        payload = {"text": text, "from": OWNER_ID, "to": target}
        if entry["kind"] == "worker":
            ag = conn.execute("SELECT task_types FROM agents WHERE agent_id=? AND kind='worker' AND status='active'",
                              (entry["agent_ref"],)).fetchone()
            ttypes = json.loads(ag[0] or "[]") if ag else []
            if not ttypes:
                return {"ok": False, "error": f"{target} 没有可认领的任务类型"}
            ttype = ttypes[0]
        else:
            ttype = "assist"
            payload["to_agent"] = entry["agent_ref"]
        payload["nonce"] = secrets.token_hex(4)          # tasks(type,payload) 唯一：同文重发不被幂等吞掉
        cur = conn.execute(
            "INSERT INTO tasks(type,payload,status,priority,max_retries,canonical_user_id,created_at) "
            "VALUES(?,?,'pending',?,3,?,?)",
            (ttype, json.dumps(payload, ensure_ascii=False), int(args.get("priority") or 0), OWNER_ID, _now()))
        conn.commit()
        return {"ok": True, "task_id": cur.lastrowid, "type": ttype, "to": target}

    if action in ("pause", "resume"):
        aid = str(args.get("agent") or "").strip()
        row = conn.execute("SELECT kind,status FROM agents WHERE agent_id=?", (aid,)).fetchone()
        if not row:
            return {"ok": False, "error": f"{aid} 不存在"}
        new = "disabled" if action == "pause" else "active"
        if row[1] == new:
            return {"ok": True, "agent_id": aid, "status": new, "note": "已是该状态"}
        if new == "disabled":
            n = conn.execute("SELECT COUNT(*) FROM agents WHERE kind=? AND status='active' AND agent_id<>?",
                             (row[0], aid)).fetchone()[0]
            if n == 0:
                return {"ok": False, "error": f"不能暂停最后一个在岗的 {row[0]}"}
        conn.execute("UPDATE agents SET status=? WHERE agent_id=?", (new, aid))
        conn.commit()
        if emit:
            try:
                emit(conn, OWNER_ID, "agent.status_changed", {"agent_id": aid, "status": new, "by": OWNER_ID})
            except Exception:
                pass
        mid = None
        if row[0] == "chief":
            mid = _notify(conn, aid, f"【大古】已{'暂停' if new == 'disabled' else '恢复'}你的指挥权限" +
                          (f"：{note}" if note else ""))
        return {"ok": True, "agent_id": aid, "status": new, "notified_msg": mid,
                "note": "执行线程约 30 秒内回收" if new == "disabled" else "约 30 秒内恢复"}

    if action in ("task_approve", "task_reject", "task_retry", "task_reassign"):
        try:
            tid = int(args.get("task_id"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "缺 task_id"}
        t = _task_row(conn, tid)
        if not t:
            return {"ok": False, "error": f"任务 #{tid} 不存在"}
        now = _now()
        if action == "task_approve":
            if t["status"] not in ("pending", "doing"):
                return {"ok": False, "error": f"任务当前 {t['status']}，不能通过"}
            conn.execute("UPDATE tasks SET status='done', done_at=?, lease_owner=COALESCE(lease_owner,?), "
                         "result=? WHERE id=?", (now, OWNER_ID, "大古批准" + (f"：{note}" if note else ""), tid))
            verb = "通过"
        elif action == "task_reject":
            if t["status"] not in ("pending", "doing", "failed"):
                return {"ok": False, "error": f"任务当前 {t['status']}，不能打回"}
            conn.execute("UPDATE tasks SET status='cancelled', done_at=?, error=? WHERE id=?",
                         (now, "大古打回" + (f"：{note}" if note else ""), tid))
            verb = "打回"
        elif action == "task_retry":
            if t["status"] not in ("failed", "dead", "cancelled", "done"):
                return {"ok": False, "error": f"任务当前 {t['status']}，无需重跑"}
            conn.execute("UPDATE tasks SET status='pending', retry_count=0, lease_owner=NULL, lease_expires_at=NULL, "
                         "claimed_at=NULL, done_at=NULL, not_before=NULL, error=NULL WHERE id=?", (tid,))
            verb = "重跑"
        else:
            target = str(args.get("to") or "").strip()
            entry = _target_entry(conn, target)
            if not entry:
                return {"ok": False, "error": f"{target} 不在名册或已下线"}
            if t["status"] == "doing":
                return {"ok": False, "error": "任务执行中，先打回再转交"}
            p = dict(t["payload"]) if t["payload"] else {"text": t["payload_raw"][:2000]}
            p.update({"to": target, "reassigned_by": OWNER_ID, "reassigned_at": now})
            ttype = t["type"]
            if entry["kind"] == "worker":
                ag = conn.execute("SELECT task_types FROM agents WHERE agent_id=?", (entry["agent_ref"],)).fetchone()
                tts = json.loads(ag[0] or "[]") if ag else []
                if ttype not in tts:
                    if not tts:
                        return {"ok": False, "error": f"{target} 没有可认领的任务类型"}
                    ttype = tts[0]
                p.pop("to_agent", None)
            else:
                ttype = "assist"
                p["to_agent"] = entry["agent_ref"]
            try:
                conn.execute("UPDATE tasks SET type=?, payload=?, status='pending', retry_count=0, lease_owner=NULL, "
                             "lease_expires_at=NULL, claimed_at=NULL, done_at=NULL, not_before=NULL, error=NULL "
                             "WHERE id=?", (ttype, json.dumps(p, ensure_ascii=False), tid))
            except Exception as e:
                return {"ok": False, "error": f"转交失败：{type(e).__name__}"}
            verb = "转交给 " + target
        conn.commit()
        party = _task_party(conn, t)
        mid = _notify(conn, party, f"【大古】任务 #{tid} 已{verb}" + (f"。批注：{note}" if note else "")) if party else None
        if action == "task_reassign":
            _notify(conn, str(args.get("to")), f"【大古】任务 #{tid} 转交给你，请领取执行" + (f"。批注：{note}" if note else ""))
        return {"ok": True, "task_id": tid, "action": verb, "notified": party, "notified_msg": mid}

    if action == "approval_decide":
        ensure_schema(conn)
        try:
            aid = int(args.get("id"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "缺审批 id"}
        dec = str(args.get("decision") or "").strip()
        opt_label = str(args.get("option") or "").strip()
        a_preview = None
        # 允许用选项原文（如「同意」「改期」）作为 decision
        if dec == "option":
            dec = "option" if opt_label else ""
        elif dec not in ("approve", "reject", "comment", "custom"):
            opt_label = dec or opt_label
            dec = "option" if opt_label else dec
        if dec not in ("approve", "reject", "comment", "option", "custom"):
            return {"ok": False, "error": "decision 只能是 approve / reject / comment / custom / 选项原文"}
        if dec in ("reject", "comment", "custom") and not note:
            return {"ok": False, "error": "打回或批注必须写批注内容"}
        a = _approval(conn, aid)
        if not a:
            return {"ok": False, "error": f"审批 #{aid} 不存在"}
        now = _now()
        notes = a["notes"] + [{"ts": now, "by": who.get("actor") if who else OWNER_ID, "decision": dec, "note": note}]
        to = a["requester_instance"] or a["requester"]
        is_assist = (a.get("kind") == "assist")
        tag = "协助" if is_assist else "审批"
        if dec == "comment":
            conn.execute("UPDATE approvals SET notes=? WHERE id=?", (json.dumps(notes, ensure_ascii=False), aid))
            text = f"【{tag}批注】#{aid}「{a['title']}」：{note}"
        else:
            if a["status"] != "pending":
                return {"ok": False, "error": f"{tag} #{aid} 已是 {a['status']}，不能重复裁决"}
            opts = a.get("options") or []
            if dec == "option":
                if opt_label not in opts:
                    return {"ok": False, "error": f"选项不在列表中：{opt_label}"}
                # 「同意/批准/通过」视为批准，含「驳/拒」视为打回，其余记为已批示并保留选项原文
                st = "approved" if any(k in opt_label for k in ("同意", "批准", "通过", "是")) else (
                     "rejected" if any(k in opt_label for k in ("驳", "拒", "否", "不同意")) else "approved")
                chosen = opt_label
            elif dec == "custom":
                # 自定义答复：不归入批准/打回，状态记为「已批示」，原文随结果推回
                st = "answered"
                chosen = "自定义答复"
            else:
                st = "approved" if dec == "approve" else "rejected"
                chosen = "批准" if st == "approved" else "打回"
            if is_assist and st == "approved":
                ak = a.get("assist_kind") or "text"
                reply = str(args.get("reply") or note or "").strip()
                vault_item = str(args.get("vault_item") or "").strip()
                if ak in ("url", "text") and not reply:
                    return {"ok": False, "error": "协助请求需要你填写" + ("网址" if ak == "url" else "内容")}
                if ak == "url" and not (reply.startswith("http://") or reply.startswith("https://")):
                    return {"ok": False, "error": "请填写以 http:// 或 https:// 开头的网址"}
                if ak == "vault":
                    if not vault_item:
                        return {"ok": False, "error": "请选择要授权的口令条目（只传名称）"}
                    import vault
                    ticket = vault.issue_ticket(conn, vault_item, a["requester"],
                                                ttl=int(args.get("ttl") or 3600), uses=int(args.get("uses") or 1))
                    if not ticket.get("ok"):
                        return ticket
                    note = (note + " " if note else "") + f"已授权口令「{vault_item}」，限时{ticket['ttl']}秒、限{ticket['uses']}次"
                    chosen = f"授权口令 {vault_item}"
                    args["_ticket_id"] = ticket.get("ticket_id")
            conn.execute("UPDATE approvals SET status=?, decided_at=?, decided_by=?, decision_note=?, notes=? WHERE id=?",
                         (st, now, OWNER_ID, (chosen + ((" · " + note) if note else "")), json.dumps(notes, ensure_ascii=False), aid))
            extra = ""
            if is_assist and st == "approved" and (a.get("assist_kind") or "text") in ("url", "text"):
                extra = f"。回复：{args.get('reply') or note}"
            elif note:
                extra = f"。批注：{note}"
            text = f"【{tag}结果】#{aid}「{a['title']}」：{chosen}" + extra
        conn.commit()
        mid = _notify(conn, to, text)
        ticket_msg = None
        if args.get("_ticket_id") and to:
            # 票号绑定申请方 Agent，只有它用自己的令牌才能兑换；消息里只有票号，绝无口令值。
            ticket_msg = _notify(conn, to, "【协助授权】口令取用票据 #%s（限时限次，值不在消息中）。"
                                 "用你自己的令牌调用 /cmd vault_redeem {\"ticket_id\": %s} 取值，取到后勿写入日志/消息/仓库。"
                                 % (args["_ticket_id"], args["_ticket_id"]))
        if mid:
            conn.execute("UPDATE approvals SET result_msg_id=? WHERE id=?", (mid, aid))
            conn.commit()
        return {"ok": True, "id": aid, "decision": dec if dec != "option" else opt_label, "pushed_to": to, "msg_id": mid,
                "ticket_id": args.get("_ticket_id"), "ticket_msg": ticket_msg,
                "note": "已经消息总线推回申请方" if mid else "申请方不在名册，结果仅留在审批中心"}

    if action == "kb_save":
        import console_api
        fp, err = console_api._kb_file(args.get("path") or "")
        if err:
            return {"ok": False, "error": err}
        content = args.get("content")
        if not isinstance(content, str):
            return {"ok": False, "error": "content 必须是文本"}
        data = content.encode("utf-8")
        if len(data) > MAX_KB_BYTES:
            return {"ok": False, "error": "内容过大"}
        old = fp.read_bytes()
        base = str(args.get("base_sha256") or "")
        if not base or base != hashlib.sha256(old).hexdigest():
            return {"ok": False, "conflict": True, "error": "文件已被别人改过（或缺版本号），请刷新后再改"}
        rel = fp.resolve().relative_to(ROOT.resolve()).as_posix()
        hist = KB_HISTORY / (rel.replace("/", "__") + f".{_now()}.bak")
        hist.parent.mkdir(parents=True, exist_ok=True)
        hist.write_bytes(old)
        tmp = fp.with_name(fp.name + ".tmp-owner")
        tmp.write_bytes(data)
        os.replace(tmp, fp)
        return {"ok": True, "path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "backup": hist.relative_to(ROOT).as_posix()}

    if action == "pair_code_create":
        code, exp = create_pair_code(conn, created_by=(who or {}).get("device", "console"))
        return {"ok": True, "code": code, "expires_at": exp}

    if action == "devices":
        ensure_schema(conn)
        rows = conn.execute("SELECT id,name,created_at,last_used_at,revoked_at FROM owner_devices ORDER BY id DESC").fetchall()
        return {"ok": True, "devices": [dict(zip(("id", "name", "created_at", "last_used_at", "revoked_at"), r)) for r in rows],
                "current": (who or {}).get("device_id")}

    if action in ("device_revoke", "logout"):
        ensure_schema(conn)
        did = (who or {}).get("device_id") if action == "logout" else args.get("device_id")
        if not did:
            return {"ok": True, "note": "主口令登录，无需吊销设备"}
        n = conn.execute("UPDATE owner_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
                         (_now(), int(did))).rowcount
        conn.commit()
        return {"ok": True, "revoked": n}

    if action == "vault_put":
        import vault
        return vault.put(conn, (who or {}).get("actor", OWNER_ID), args.get("name"), args.get("purpose"), args.get("value"))

    if action in ("vault_disable", "vault_enable"):
        import vault
        return vault.set_disabled(conn, (who or {}).get("actor", OWNER_ID), str(args.get("name") or ""), action == "vault_disable")

    if action == "vault_list":
        import vault
        return {"ok": True, "items": vault.list_items(conn), "available": vault.available(),
                "audit": vault.recent_audit(conn, 30)}

    if action in ("project_upsert", "phase_upsert", "phase_accept"):
        import projects
        return projects.owner_write(conn, OWNER_ID, action, args)

    if action == "whoami":
        return {"ok": True, "actor": who.get("actor"), "device": who.get("device"), "device_id": who.get("device_id")}

    return {"ok": False, "error": f"未知操作 {action}"}


# 审计里不记录正文全文和任何令牌，只记摘要
def audit_detail(action, args, res):
    a = dict(args or {})
    for k in ("token", "code", "content", "reply", "secret", "password", "value", "_ticket_secret", "ticket"):
        if k in a:
            a[k] = f"<{len(str(a[k]))} 字>" if k == "content" else "<已隐去>"
    if "text" in a:
        a["text"] = str(a["text"])[:120]
    r = {k: v for k, v in (res or {}).items() if k not in ("token", "code", "text", "devices", "items", "audit", "value", "ticket")}
    return {"args": a, "result": r}
