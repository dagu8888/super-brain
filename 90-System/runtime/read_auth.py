#!/usr/bin/env python3
# P0-1 读接口鉴权。
# 默认拒绝匿名读取。紧急回滚：环境变量 SB_ALLOW_ANON_READ=1（true/yes/on 亦可）。
# 通过条件（任一）：
#   1. 主人设备会话：owner_ops.authenticate（cookie sb_owner 或 Bearer）
#   2. 带 scope 的 Bearer：token_scopes 或令牌对象里的 scopes
#   3. 过渡期：把请求令牌与配置里的现有令牌做 sha256 后常量时间比对（不把明文写入日志）
# 未写 scopes 时，tokens 默认 read+write+stream，viewers 默认 read+stream。
import hashlib
import hmac
import os
import threading
import time
from urllib.parse import parse_qs, unquote, urlparse

import owner_ops

ANON_ENV = "SB_ALLOW_ANON_READ"
_ON = {"1", "true", "yes", "on"}
TOKEN_SCOPES = ("read", "write", "stream")
VIEWER_SCOPES = ("read", "stream")
_AUDIT_AT = {}
_AUDIT_LOCK = threading.Lock()
_ANON_LOGGED = {"on": False}


def anon_enabled():
    return (os.environ.get(ANON_ENV) or "").strip().lower() in _ON


def note_anon_window(log_event, enabled):
    """回滚窗打开时记一次，不含任何令牌。关掉后再打开会再记。"""
    if not enabled:
        _ANON_LOGGED["on"] = False
        return
    if _ANON_LOGGED["on"]:
        return
    _ANON_LOGGED["on"] = True
    log_event("api_anon_read_enabled", env=ANON_ENV)


def should_record(key, interval=60):
    """同一身份、同一路径、同一动作每分钟最多记一条，避免轮询撑满审计。"""
    now = time.time()
    with _AUDIT_LOCK:
        prev = _AUDIT_AT.get(key)
        if prev is not None and now - prev < interval:
            return False
        _AUDIT_AT[key] = now
        if len(_AUDIT_AT) > 4000:
            cutoff = now - interval
            for old, ts in list(_AUDIT_AT.items()):
                if ts < cutoff:
                    _AUDIT_AT.pop(old, None)
        return True


def hashes_equal(presented, stored):
    """过渡期：双方先 sha256，再常量时间比对。长度不同也不会抛错。"""
    if presented is None or stored is None:
        return False
    presented, stored = str(presented), str(stored)
    if not presented or not stored:
        return False
    left = hashlib.sha256(presented.encode("utf-8")).digest()
    right = hashlib.sha256(stored.encode("utf-8")).digest()
    return hmac.compare_digest(left, right)


def presented_secret(handler, allow_query=False):
    """Bearer，其次 sb_owner cookie。查询参数 token 只给 SSE（EventSource 不能自定义头）。"""
    auth = handler.headers.get("Authorization", "") or ""
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        if token and len(token) <= 4096:
            return token
        if token:
            return ""
    for part in (handler.headers.get("Cookie") or "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == "sb_owner" and value.strip():
            token = unquote(value.strip())
            return token if len(token) <= 4096 else ""
    if allow_query:
        raw = (parse_qs(urlparse(handler.path).query).get("token") or [""])[0].strip()
        if raw and len(raw) <= 4096:
            return raw
    return ""


def _as_scopes(raw):
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return ()
    return tuple(str(item).strip() for item in raw if str(item).strip())


def secret_and_scopes(name, raw, bucket, overlay):
    explicit = None
    if isinstance(raw, dict):
        secret = raw.get("secret") if raw.get("secret") is not None else raw.get("token")
        if "scopes" in raw:
            explicit = raw.get("scopes")
    else:
        secret = raw
    if overlay and name in overlay:
        explicit = overlay[name]
    if explicit is None:
        scopes = TOKEN_SCOPES if bucket == "tokens" else VIEWER_SCOPES
    else:
        scopes = _as_scopes(explicit)
    return "" if secret is None else str(secret), scopes


def match_named(secret, table, overlay, bucket):
    """扫完全表再返回第一命中，避免提前返回放大时序差。"""
    if not secret:
        return None
    found = None
    for name, raw in (table or {}).items():
        stored, scopes = secret_and_scopes(name, raw, bucket, overlay)
        if stored and hashes_equal(secret, stored) and found is None:
            found = (str(name), scopes)
    return found


def chief_for_write(secret, tokens, overlay):
    """返回 (chief 名, 'ok'|'missing'|'forbidden')。不回传令牌。"""
    hit = match_named(secret, tokens, overlay, "tokens")
    if not hit:
        return None, "missing"
    name, scopes = hit
    if "*" in scopes or "write" in scopes:
        return name, "ok"
    return name, "forbidden"


def allows(principal, path, need):
    scopes = set((principal or {}).get("scopes") or ())
    if "*" in scopes:
        return True
    if need == "stream":
        return bool(scopes & {"stream", "read"})
    if "read" in scopes:
        return True
    return "groupchat" in scopes and (path or "").startswith("/api/groupchat")


def resolve(conn, secret, tokens, viewers, owners, overlay):
    """返回不含令牌明文的身份；认不出返回 None。路径是否允许由 allows() 再判。"""
    if not secret:
        return None
    who = owner_ops.authenticate(conn, secret, owners or {})
    if who:
        return {
            "kind": "owner",
            "actor": who.get("actor") or owner_ops.OWNER_ID,
            "device": who.get("device") or "",
            "auth": who.get("auth") or "session",
            "scopes": ("read", "stream"),
        }
    hit = match_named(secret, tokens, overlay, "tokens")
    if hit:
        name, scopes = hit
        return {"kind": "token", "actor": name, "auth": "bearer", "scopes": scopes}
    hit = match_named(secret, viewers, overlay, "viewers")
    if hit:
        name, scopes = hit
        return {"kind": "viewer", "actor": name, "auth": "bearer", "scopes": scopes}
    # 配对令牌在所有路径上都能认出身份，但 scope 只有 groupchat。
    # 读消息总线等接口会落到 403，而不是假装没有凭证。
    import group_chat
    try:
        actor = group_chat.actor_from_token(conn, secret, tokens or {})
    except Exception:
        actor = None
    if actor and actor.get("kind") == "external":
        return {
            "kind": "group",
            "actor": actor.get("id") or "external",
            "auth": "group",
            "scopes": ("groupchat",),
        }
    return None
