#!/usr/bin/env python3
# 在线状态提示（2026-11-11 grok，替代 heartbeat_lost 告警事件）
# 规则：只在「在线⇄离线」状态翻转时推一条提示给大古；同一 Agent 最短间隔 min_interval_sec，
# 期间来回抖动只记待发，间隔到了且状态仍与上次提示不同才补发；进程启动后 startup_grace_sec 内只同步状态不发。
# 不写知识库、不进 events / LLM，只走消息总线（messages 表）。
import time

import kb_engine
import message_bus

_started = time.time()


def _ensure(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS presence_state(agent TEXT PRIMARY KEY, state TEXT, since INTEGER,"
                 " notified_state TEXT, notified_at INTEGER, last_ts INTEGER)")


def _fmt(ts):
    return time.strftime("%m-%d %H:%M", time.localtime(ts)) if ts else "未知"


def check(conn, now=None, post=None):
    """每轮 router 调一次。返回本轮发出的提示条数。post 便于测试注入。"""
    cfg = kb_engine.load_config()
    p = cfg.get("presence") or {}
    if not p.get("enabled", True):
        return 0
    now = int(now or time.time())
    off_after = int(p.get("offline_after_sec", 900))
    min_iv = int(p.get("min_interval_sec", 1800))
    grace = int(p.get("startup_grace_sec", 900))
    ignore = set(p.get("ignore_agents") or ["router", "supervisor"])
    to = p.get("notify_to") or cfg.get("owner_id") or "dagu-owner"
    sender = cfg.get("system_sender") or "system-watchdog"
    in_grace = (time.time() - _started) < grace
    _ensure(conn)
    changes = []
    for agent, ts in conn.execute("SELECT agent, ts FROM heartbeats").fetchall():
        if agent in ignore:
            continue
        cur = "online" if (ts or 0) >= now - off_after else "offline"
        row = conn.execute("SELECT state, notified_state, notified_at FROM presence_state WHERE agent=?",
                           (agent,)).fetchone()
        if row is None or in_grace:
            # 首次见到 / 启动宽限期：静默同步，视为已告知当前状态
            conn.execute("INSERT OR REPLACE INTO presence_state VALUES(?,?,?,?,?,?)",
                         (agent, cur, now if row is None or row[0] != cur else
                          conn.execute("SELECT since FROM presence_state WHERE agent=?", (agent,)).fetchone()[0],
                          cur, row[2] if row else 0, ts))
            continue
        state, nstate, nat = row
        if state != cur:
            conn.execute("UPDATE presence_state SET state=?, since=?, last_ts=? WHERE agent=?",
                         (cur, now, ts, agent))
        else:
            conn.execute("UPDATE presence_state SET last_ts=? WHERE agent=?", (ts, agent))
        if cur != nstate and now - (nat or 0) >= min_iv:
            changes.append((agent, cur, ts))
            conn.execute("UPDATE presence_state SET notified_state=?, notified_at=? WHERE agent=?",
                         (cur, now, agent))
    conn.commit()
    if not changes:
        return 0
    off = [f"{a}（最后心跳 {_fmt(t)}）" for a, s, t in changes if s == "offline"]
    on = [a for a, s, t in changes if s == "online"]
    parts = []
    if off:
        parts.append("离线：" + "、".join(off))
    if on:
        parts.append("恢复在线：" + "、".join(on))
    text = ("【在线状态】" + "；".join(parts) + "。仅提示，无需处理（常见原因：额度用完/电脑关机）；"
            f"同一节点 {min_iv // 60} 分钟内最多提示一次，状态再变会再提示。")
    (post or message_bus.post_message)(conn, sender, text, to=to, kind="chat")
    return 1
