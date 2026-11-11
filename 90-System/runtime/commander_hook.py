#!/usr/bin/env python3
# 指挥官唤醒转发器：大古发给 grok-chief 的消息，以及大古对审批/协助的回复，
# 异步 POST 到 routine webhook，用来叫醒指挥官。
# 配置只从 /etc/super-brain/commander_webhook.env 读取（600）；缺配置不报错，只记一条日志。
# 密钥不进日志、不进响应、不进仓库。带 msg_id，已成功的不再重发（幂等）。
import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV_PATH = Path(os.environ.get("SB_COMMANDER_WEBHOOK_ENV", "/etc/super-brain/commander_webhook.env"))
CHIEF = "grok-chief"
CHIEF_ALIASES = {"grok-chief", "幕僚长@云端"}
OWNER = "dagu-owner"
MAX_ATTEMPTS = 8
BACKOFF = (1, 2, 5, 15, 60, 120, 300, 600)

# 鉴权方式（COMMANDER_WEBHOOK_AUTH），按常见 webhook 习惯做成可配置：
#   bearer              Authorization: Bearer <key>     —— 默认，也是多数 routine/自动化平台的写法
#   raw                 Authorization: <key>            —— 密钥本身已含 Bearer / Basic 前缀时用
#   x-api-key           X-Api-Key: <key>
#   x-webhook-secret    X-Webhook-Secret: <key>
#   header:<Name>       <Name>: <key>                   —— 自定义头，例如 header:X-Routine-Key
AUTH_HELP = "bearer | raw | x-api-key | x-webhook-secret | header:<Name>"

_STATE = {"loaded": False, "url": "", "key": "", "auth": "bearer", "warned": False, "thread": None, "cv": None}
_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS webhook_outbox(
  msg_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_next ON webhook_outbox(sent_at, next_at);
"""


def ensure_schema(conn):
    conn.executescript(SCHEMA)


def _parse_env(text):
    out = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def load_config(force=False):
    with _LOCK:
        # 未配置时每 60 秒重读一次文件：装好配置后无需重启服务
        if _STATE["loaded"] and not force and (_STATE["url"] or time.time() - _STATE.get("checked", 0) < 60):
            return bool(_STATE["url"])
        _STATE["loaded"] = True
        _STATE["checked"] = time.time()
        _STATE["url"] = _STATE["key"] = ""
        _STATE["auth"] = "bearer"
        try:
            if not ENV_PATH.is_file():
                return False
            if os.stat(ENV_PATH).st_mode & 0o077:
                # 其他用户可读则拒绝加载，避免把密钥用在不安全的文件上
                _warn("commander webhook 配置文件权限过宽（应为 600），已忽略")
                return False
            cfg = _parse_env(ENV_PATH.read_text(encoding="utf-8"))
            _STATE["url"] = (cfg.get("COMMANDER_WEBHOOK_URL") or "").strip()
            _STATE["key"] = (cfg.get("COMMANDER_WEBHOOK_KEY") or "").strip()
            _STATE["auth"] = (cfg.get("COMMANDER_WEBHOOK_AUTH") or "bearer").strip() or "bearer"
            return bool(_STATE["url"])
        except Exception as e:
            _warn("读取 commander webhook 配置失败：%s" % type(e).__name__)
            return False


def configured():
    """只回答是否已配置，不暴露地址或密钥。"""
    return load_config()


def _warn(msg):
    if _STATE.get("warned") and "未配置" in msg:
        return
    if "未配置" in msg:
        _STATE["warned"] = True
    try:
        from runtime import log_event
        log_event("commander_hook", note=msg[:200])
    except Exception:
        pass


def auth_headers(key, style):
    style = (style or "bearer").strip()
    if not key:
        return {}
    if style == "bearer":
        return {"Authorization": "Bearer " + key}
    if style == "raw":
        return {"Authorization": key}
    if style == "x-api-key":
        return {"X-Api-Key": key}
    if style == "x-webhook-secret":
        return {"X-Webhook-Secret": key}
    if style.lower().startswith("header:") and style.split(":", 1)[1].strip():
        return {style.split(":", 1)[1].strip(): key}
    return {"Authorization": "Bearer " + key}


def should_forward(msg):
    if not msg:
        return False
    if (msg.get("from_agent") or "") != OWNER:
        return False
    dest = msg.get("to") or ""
    kind = (msg.get("kind") or "chat").lower()
    # 发给指挥官，或大古对审批/协助的回复（正文以【审批 / 【协助 开头，或 reply_to 存在且目标是某 Agent）
    if dest in CHIEF_ALIASES or dest == CHIEF:
        return True
    text = msg.get("text") or ""
    if text.startswith("【审批") or text.startswith("【协助") or text.startswith("【大古】"):
        return True
    return False


def enqueue(conn, msg, reason="owner_to_chief"):
    """入队；已在队或已发送则跳过。缺配置时只记一次日志，不抛错。"""
    if not should_forward(msg):
        return False
    mid = msg.get("msg_id")
    if not mid:
        return False
    if not load_config():
        _warn("commander webhook 未配置，消息 %s 未转发（不报错）" % mid)
        return False
    ensure_schema(conn)
    payload = {
        "event": "commander_message",
        "reason": reason,
        "msg_id": mid,
        "from": msg.get("from_agent"),
        "to": msg.get("to"),
        "kind": msg.get("kind"),
        "text": msg.get("text"),
        "reply_to": msg.get("reply_to"),
        "thread_id": msg.get("thread_id"),
        "created_at": msg.get("created_at"),
        "idempotency_key": mid,
    }
    now = int(time.time())
    cur = conn.execute(
        "INSERT OR IGNORE INTO webhook_outbox(msg_id,payload,created_at,attempts,next_at) VALUES(?,?,?,0,?)",
        (mid, json.dumps(payload, ensure_ascii=False), now, now))
    conn.commit()
    if cur.rowcount:
        _kick()
    return cur.rowcount > 0


def _post(url, key, auth, body):
    headers = {"Content-Type": "application/json; charset=utf-8", "User-Agent": "super-brain-commander-hook"}
    headers.update(auth_headers(key, auth))
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status


def _deliver_one(conn, mid, payload, attempts):
    url, key, auth = _STATE["url"], _STATE["key"], _STATE["auth"]
    if not url:
        return "no-config"
    try:
        status = _post(url, key, auth, payload.encode("utf-8"))
        if 200 <= int(status) < 300:
            conn.execute("UPDATE webhook_outbox SET sent_at=?, last_error=NULL, attempts=? WHERE msg_id=?",
                         (int(time.time()), attempts + 1, mid))
            conn.commit()
            _warn("commander webhook 已投递 %s" % mid)
            return "ok"
        err = "HTTP %s" % status
    except urllib.error.HTTPError as e:
        err = "HTTP %s" % e.code
        if e.code in (400, 401, 403, 404, 410):
            # 永久失败，不再重试，避免用坏密钥空打
            conn.execute("UPDATE webhook_outbox SET attempts=?, last_error=?, next_at=? WHERE msg_id=?",
                         (MAX_ATTEMPTS, err[:160], int(time.time()) + 86400 * 30, mid))
            conn.commit()
            _warn("commander webhook 永久失败 %s %s" % (mid, err))
            return "fatal"
    except Exception as e:
        err = type(e).__name__
    nxt = int(time.time()) + BACKOFF[min(attempts, len(BACKOFF) - 1)]
    conn.execute("UPDATE webhook_outbox SET attempts=?, last_error=?, next_at=? WHERE msg_id=?",
                 (attempts + 1, err[:160], nxt, mid))
    conn.commit()
    return "retry"


def pump(db_fn, once=False):
    if not load_config():
        return 0
    n = 0
    conn = db_fn()
    try:
        ensure_schema(conn)
        now = int(time.time())
        rows = conn.execute(
            "SELECT msg_id,payload,attempts FROM webhook_outbox "
            "WHERE sent_at IS NULL AND attempts<? AND next_at<=? ORDER BY next_at LIMIT 20",
            (MAX_ATTEMPTS, now)).fetchall()
        for mid, payload, attempts in rows:
            _deliver_one(conn, mid, payload, attempts)
            n += 1
    finally:
        conn.close()
    return n


def _loop(db_fn, stop):
    while not (stop and stop.is_set()):
        try:
            pump(db_fn)
        except Exception:
            pass
        cv = _STATE.get("cv")
        if cv:
            with cv:
                cv.wait(5)
        else:
            time.sleep(5)


def _kick():
    cv = _STATE.get("cv")
    if cv:
        with cv:
            cv.notify()


def start(db_fn, stop=None):
    """由 runtime / api_server 启动后台线程。可重复调用，只启动一次。"""
    load_config()
    with _LOCK:
        if _STATE["thread"] and _STATE["thread"].is_alive():
            return
        _STATE["cv"] = threading.Condition()
        t = threading.Thread(target=_loop, args=(db_fn, stop), name="commander-hook", daemon=True)
        _STATE["thread"] = t
        t.start()
