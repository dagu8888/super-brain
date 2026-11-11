#!/usr/bin/env python3
# 口令包（加密保险箱）。值用 AES-256-GCM 加密存在 /var/lib/super-brain/vault/items.json（600），
# 主密钥单独存 master.key（600），都不在仓库里。控制台只看名称和用途，从不回显值。
# Agent 不能列出或读取；只能凭大古批准后签发的「限时、限次」票据，经 /cmd vault_redeem 取值一次，全程审计。
import base64
import hashlib
import json
import os
import re
import secrets
import time
from pathlib import Path

VAULT_DIR = Path(os.environ.get("SB_VAULT_DIR", "/var/lib/super-brain/vault"))
NAME_RE = re.compile(r"^[\w.\-\u4e00-\u9fff]{1,60}$")
MAX_VALUE = 8192
MAX_TTL = 24 * 3600
MAX_USES = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS vault_tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_hash TEXT NOT NULL UNIQUE,
  item TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses_left INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS vault_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  item TEXT,
  ok INTEGER NOT NULL,
  note TEXT
);
"""


def _aes():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM


def available():
    try:
        _aes()
        return True
    except Exception:
        return False


def ensure_schema(conn):
    conn.executescript(SCHEMA)


def _write_600(path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def _key():
    kp = VAULT_DIR / "master.key"
    if not kp.exists():
        _write_600(kp, base64.b64encode(secrets.token_bytes(32)))
    return base64.b64decode(kp.read_bytes().strip())


def _load():
    ip = VAULT_DIR / "items.json"
    if not ip.exists():
        return {}
    return json.loads(ip.read_text(encoding="utf-8"))


def _save(items):
    _write_600(VAULT_DIR / "items.json", json.dumps(items, ensure_ascii=False, indent=1).encode())


def _audit(conn, actor, action, item, ok, note=""):
    ensure_schema(conn)
    conn.execute("INSERT INTO vault_audit(ts,actor,action,item,ok,note) VALUES(?,?,?,?,?,?)",
                 (int(time.time()), actor, action, item, 1 if ok else 0, str(note)[:200]))
    conn.commit()


def put(conn, actor, name, purpose, value):
    if not available():
        return {"ok": False, "error": "服务器缺 cryptography 库，口令包不可用"}
    name = str(name or "").strip()
    if not NAME_RE.match(name):
        return {"ok": False, "error": "名称 1-60 字：中文/字母/数字/._-"}
    value = str(value or "")
    if not value or len(value.encode()) > MAX_VALUE:
        return {"ok": False, "error": "值为空或过长"}
    items = _load()
    nonce = secrets.token_bytes(12)
    ct = _aes()(_key()).encrypt(nonce, value.encode(), name.encode())
    now = int(time.time())
    old = items.get(name) or {}
    items[name] = {"purpose": str(purpose or "")[:200], "nonce": base64.b64encode(nonce).decode(),
                   "ct": base64.b64encode(ct).decode(), "created_at": old.get("created_at", now),
                   "updated_at": now, "disabled": False}
    _save(items)
    _audit(conn, actor, "put" if not old else "update", name, True)
    return {"ok": True, "name": name, "updated": bool(old)}


def set_disabled(conn, actor, name, disabled):
    items = _load()
    if name not in items:
        return {"ok": False, "error": "没有这条口令"}
    items[name]["disabled"] = bool(disabled)
    items[name]["updated_at"] = int(time.time())
    _save(items)
    if disabled:
        ensure_schema(conn)
        conn.execute("UPDATE vault_tickets SET revoked_at=? WHERE item=? AND revoked_at IS NULL", (int(time.time()), name))
        conn.commit()
    _audit(conn, actor, "disable" if disabled else "enable", name, True)
    return {"ok": True, "name": name, "disabled": bool(disabled)}


def list_items(conn=None):
    """只返回名称、用途、时间、状态；绝不含值。"""
    items = _load()
    out = []
    for n, it in sorted(items.items()):
        out.append({"name": n, "purpose": it.get("purpose", ""), "created_at": it.get("created_at"),
                    "updated_at": it.get("updated_at"), "disabled": bool(it.get("disabled"))})
    return out


def issue_ticket(conn, item, agent_id, ttl=3600, uses=1):
    ensure_schema(conn)
    items = _load()
    it = items.get(item)
    if not it or it.get("disabled"):
        return {"ok": False, "error": "口令条目不存在或已停用"}
    ttl = max(60, min(int(ttl or 3600), MAX_TTL))
    uses = max(1, min(int(uses or 1), MAX_USES))
    t = "vt_" + secrets.token_urlsafe(24)
    now = int(time.time())
    cur = conn.execute("INSERT INTO vault_tickets(ticket_hash,item,agent_id,created_at,expires_at,uses_left) "
                       "VALUES(?,?,?,?,?,?)", (hashlib.sha256(t.encode()).hexdigest(), item, agent_id, now, now + ttl, uses))
    conn.commit()
    _audit(conn, "dagu-owner", "issue_ticket", item, True, f"to={agent_id} ttl={ttl} uses={uses}")
    return {"ok": True, "ticket_id": cur.lastrowid, "ttl": ttl, "uses": uses, "expires_at": now + ttl}


def redeem(conn, agent_id, ticket_id):
    """Agent 凭票取值。票据按编号绑定到申请方 Agent：调用者必须用自己的令牌（/cmd 已鉴权）、
    票据属于本人、未过期、有剩余次数、条目未停用。票据本身不含秘密，所以推送票号的消息可公开显示。"""
    ensure_schema(conn)
    if not available():
        return {"ok": False, "error": "口令包不可用"}
    try:
        tid = int(ticket_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "缺 ticket_id"}
    row = conn.execute("SELECT id,item,agent_id,expires_at,uses_left,revoked_at FROM vault_tickets WHERE id=?",
                       (tid,)).fetchone()
    now = int(time.time())
    if not row or row[2] != agent_id:
        _audit(conn, agent_id, "redeem", row[1] if row else None, False, "票据无效或不属于你")
        return {"ok": False, "error": "票据无效"}
    tid, item, _, exp, left, revoked = row
    if revoked or exp < now or left <= 0:
        _audit(conn, agent_id, "redeem", item, False, "票据过期/用完/已撤销")
        return {"ok": False, "error": "票据已过期、用完或被撤销"}
    it = _load().get(item)
    if not it or it.get("disabled"):
        _audit(conn, agent_id, "redeem", item, False, "条目已停用")
        return {"ok": False, "error": "口令条目已停用"}
    val = _aes()(_key()).decrypt(base64.b64decode(it["nonce"]), base64.b64decode(it["ct"]), item.encode()).decode()
    conn.execute("UPDATE vault_tickets SET uses_left=uses_left-1 WHERE id=?", (tid,))
    conn.commit()
    _audit(conn, agent_id, "redeem", item, True, f"ticket#{tid} 剩余 {left - 1}")
    return {"ok": True, "item": item, "value": val, "uses_left": left - 1, "expires_at": exp,
            "note": "值只在本次响应中返回，请勿写入日志、消息或仓库"}


def recent_audit(conn, limit=40):
    ensure_schema(conn)
    return [dict(zip(("ts", "actor", "action", "item", "ok", "note"), r)) for r in conn.execute(
        "SELECT ts,actor,action,item,ok,note FROM vault_audit ORDER BY id DESC LIMIT ?", (int(limit),))]
