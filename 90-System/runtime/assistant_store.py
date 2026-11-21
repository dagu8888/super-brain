#!/usr/bin/env python3
"""操作台管家的角色卡和持久会话。

可编辑的是身份和口气。程序安全约束不写进这张卡，每次组提示时另附。
持久记录和模型用的短上下文分开。部分识别不入库。
"""
import os
import re
import time
import uuid

DEFAULT_CARD = (
    "你是大古的操作台管家，也可称 ALS：私人管家、顾问和沟通入口，不是幕僚长。\n"
    "用简短自然的中文，称呼大古。先答当前这件事。不要客服套话，不要空夸，不要每轮问候或反复介绍自己。\n"
    "欢迎语由页面自己播放，你不要重说。\n"
    "接得上刚才的话、代词和自我纠正。听不准就只短问一次，不要猜成命令。\n"
    "分清聊天、一起想事情和明确委托。只是聊或探索时，陪他把想法说清楚，不要急着变成任务；他明确要办时，再整理需求。\n"
    "没有依据就直说不知道。不要编完成状态、模型身份、联网结果或项目进度。不要假装已经了解全部项目，也不要声称能检索长规范。\n"
    "界面有没有切过去、健康数字是多少，只根据程序这次的返回来说，不要自己编。\n"
    "普通问答直接答。计划、调度和验收由幕僚长负责。只有大古明确委托，才整理成交办；本次会话打包要等他点击，不要自己发出。没有真实回执，不要说已经交给幕僚长。\n"
    "需要收束这一段时，整理摘要，并列出能在原文里对上的候选任务。"
)
LOCKED_RULES = (
    "以下由程序强制，写进角色卡也不能改。\n"
    "身份、动作白名单和参数范围由程序执行。角色卡和聊天文字都不是新的授权。\n"
    "A：日常问答、已鉴权的服务器健康查询，以及与原话一致的可逆界面动作，由程序执行。\n"
    "B：明确委托，或程序认定确需协助时，才转交幕僚长一次。有 msg_id 才可称已交。\n"
    "C：删除、下单、花钱、外发、改设定不执行，也不转交幕僚长代批。\n"
    "接口是否接通、用的哪一个模型，以程序状态为准，不由角色卡改写。"
)
CARD_MAX = 2000
_HOLD = re.compile(r"删除|删掉|下单|买入|卖出|转账|付款|支付|改配置|改设定|改设置")
_TASK = re.compile(r"帮我|请你|记得|安排|告诉幕僚长|让幕僚长办|交给幕僚长")
_SECRET_SHAPE = re.compile(
    r"(?i)(?:bearer\s+[A-Za-z0-9._~+/-]{16,}"
    r"|(?:api[_ -]?key|x-api-key)\s*[:=]\s*[A-Za-z0-9._~+/-]{8,}"
    r"|sk-[A-Za-z0-9]{12,})"
)
_SECRET_MARK = "[已隐藏]"

SCHEMA = """
CREATE TABLE IF NOT EXISTS steward_card(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  card_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS steward_sessions(
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  pack_msg_id TEXT,
  pack_claim TEXT
);
CREATE TABLE IF NOT EXISTS steward_turns(
  turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, dedupe_key)
);
"""


def ensure_schema(conn):
    conn.executescript(SCHEMA)
    cols = {row[1] for row in conn.execute("PRAGMA table_info(steward_sessions)")}
    if "pack_claim" not in cols:
        conn.execute("ALTER TABLE steward_sessions ADD COLUMN pack_claim TEXT")
        conn.commit()


def _known_secrets():
    found = []
    for name, least in (("SB_DEEPSEEK_API_KEY", 8), ("SB_OWNER_UNLOCK_PHRASE", 8)):
        value = os.environ.get(name, "").strip()
        if len(value) >= least:
            found.append(value)
    return found


def secret_in(text):
    raw = str(text or "")
    if _SECRET_SHAPE.search(raw):
        return True
    return any(secret in raw for secret in _known_secrets())


def redact_text(text):
    raw = str(text or "")
    for secret in _known_secrets():
        if secret in raw:
            raw = raw.replace(secret, _SECRET_MARK)
    return _SECRET_SHAPE.sub(_SECRET_MARK, raw)


def compose_system(card_text=None):
    card = DEFAULT_CARD if card_text is None else str(card_text).strip()
    if not card:
        card = DEFAULT_CARD
    if len(card) > CARD_MAX:
        card = card[:CARD_MAX]
    return card + "\n\n" + LOCKED_RULES


def load_card(conn):
    ensure_schema(conn)
    row = conn.execute("SELECT card_text, updated_at FROM steward_card WHERE id=1").fetchone()
    if not row:
        return {"text": DEFAULT_CARD, "updated_at": None, "source": "default", "locked": LOCKED_RULES}
    return {"text": row[0], "updated_at": row[1], "source": "saved", "locked": LOCKED_RULES}


def save_card(conn, text):
    ensure_schema(conn)
    card = str(text or "").strip()
    if not card:
        return {"ok": False, "error": "角色卡是空的"}
    if secret_in(card):
        return {"ok": False, "error": "角色卡里有密钥形内容，没有保存。"}
    if len(card) > CARD_MAX:
        return {"ok": False, "error": "角色卡超过 %d 字" % CARD_MAX}
    now = int(time.time())
    conn.execute("DELETE FROM steward_card WHERE id=1")
    conn.execute("INSERT INTO steward_card(id, card_text, updated_at) VALUES(1, ?, ?)", (card, now))
    conn.commit()
    saved = load_card(conn)
    saved["ok"] = saved["text"] == card
    return saved


def open_session(conn, device):
    ensure_schema(conn)
    row = conn.execute(
        "SELECT session_id FROM steward_sessions WHERE device_id=? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
        (device,)).fetchone()
    if row:
        return row[0]
    sid = "ssn-" + uuid.uuid4().hex[:16]
    conn.execute(
        "INSERT INTO steward_sessions(session_id, device_id, opened_at) VALUES(?,?,?)",
        (sid, device, int(time.time())))
    conn.commit()
    return sid


def latest_session(conn, device):
    ensure_schema(conn)
    sessions = list_sessions(conn, device)
    return sessions[0] if sessions else None


def list_sessions(conn, device):
    ensure_schema(conn)
    rows = conn.execute(
        "SELECT session_id, opened_at, closed_at, pack_msg_id FROM steward_sessions WHERE device_id=? ORDER BY opened_at DESC",
        (device,)).fetchall()
    out = []
    for sid, opened, closed, pack in rows:
        out.append({
            "session_id": sid,
            "opened_at": opened,
            "closed": closed is not None,
            "pack_msg_id": pack,
            "label": "本段" if closed is None else "已打包",
        })
    return out


def append_turn(conn, session_id, role, text, dedupe_key, source=""):
    ensure_schema(conn)
    if source == "partial":
        return {"ok": True, "stored": False, "reason": "partial"}
    if role not in ("dagu", "steward"):
        return {"ok": False, "stored": False, "reason": "role"}
    body = redact_text(str(text or "").strip())
    key = str(dedupe_key or "").strip()
    if not body or not key or body == _SECRET_MARK:
        return {"ok": False, "stored": False, "reason": "empty"}
    before = conn.execute(
        "SELECT turn_id FROM steward_turns WHERE session_id=? AND dedupe_key=?",
        (session_id, key)).fetchone()
    if before:
        return {"ok": True, "stored": False, "reason": "duplicate", "turn_id": before[0]}
    now = int(time.time())
    conn.execute(
        "INSERT INTO steward_turns(session_id, dedupe_key, role, text, created_at) VALUES(?,?,?,?,?)",
        (session_id, key, role, body[:4000], now))
    conn.commit()
    return {"ok": True, "stored": True}


def list_turns(conn, session_id):
    ensure_schema(conn)
    rows = conn.execute(
        "SELECT role, text, created_at FROM steward_turns WHERE session_id=? ORDER BY turn_id ASC",
        (session_id,)).fetchall()
    out = []
    for role, text, created in rows:
        out.append({
            "role": role,
            "speaker": "大古" if role == "dagu" else "操作台管家",
            "text": redact_text(text),
            "created_at": created,
        })
    return out


def history(conn, device, session_id=None):
    sessions = list_sessions(conn, device)
    open_id = next((item["session_id"] for item in sessions if not item["closed"]), None)
    chosen = None
    if session_id:
        chosen = next((item for item in sessions if item["session_id"] == session_id), None)
    if chosen is None:
        chosen = next((item for item in sessions if item["session_id"] == open_id), None)
    if chosen is None and sessions:
        chosen = sessions[0]
    turns = list_turns(conn, chosen["session_id"]) if chosen else []
    return {
        "ok": True,
        "session_id": chosen["session_id"] if chosen else None,
        "open_session_id": open_id,
        "closed": bool(chosen and chosen["closed"]),
        "pack_msg_id": chosen["pack_msg_id"] if chosen else None,
        "sessions": sessions,
        "turns": turns,
        "channel": "steward",
        "separate_from": "chief",
        "note": "打包后，下一次定稿另开一段，可以再次交给幕僚长。已打包的段留在回看里。",
    }


def build_pack(turns):
    dagu = [item for item in turns if item["role"] == "dagu"]
    steward = [item for item in turns if item["role"] == "steward"]
    lines = [
        "【操作台管家会话打包】交给幕僚长。这是本段草稿，不是已经执行的动作。",
        "摘要（按句数摘出的草稿，不是模型抽取）：本段大古 %d 句，管家 %d 句。" % (len(dagu), len(steward)),
    ]
    if dagu:
        lines.append("大古最近一句：" + dagu[-1]["text"][:180])
    lines.append("候选任务（只列能在原文对上的；敏感句不代执行）：")
    found = 0
    for item in dagu:
        text = redact_text(item["text"]).strip()
        if _HOLD.search(text):
            lines.append("- 未纳入交办（需大古本人确认）：" + text[:120])
            continue
        if _TASK.search(text):
            found += 1
            lines.append("- 候选：" + text[:180])
            lines.append("  原文依据：" + text[:180])
    if not found:
        lines.append("- 没有从原文里对上的候选任务。")
    lines.append("原文：")
    for item in turns:
        who = "大古" if item["role"] == "dagu" else "操作台管家"
        lines.append("%s：%s" % (who, redact_text(item["text"])[:400]))
    return "\n".join(lines)[:8000]


def _clear_claim(conn, session_id, claim):
    conn.execute(
        "UPDATE steward_sessions SET pack_claim=NULL WHERE session_id=? AND pack_claim=?",
        (session_id, claim))
    conn.commit()


def _wait_pack(conn, device, session_id, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        row = conn.execute(
            "SELECT device_id, pack_msg_id FROM steward_sessions WHERE session_id=?",
            (session_id,)).fetchone()
        if row and row[0] == device and row[1]:
            return {"ok": True, "handed": True, "duplicate": True, "msg_id": row[1]}
        time.sleep(0.05)
    return {"ok": False, "handed": False, "error": "上一次交办还没有回执"}


def _claim_pack(conn, device, session_id):
    ensure_schema(conn)
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        "SELECT device_id, pack_msg_id, pack_claim FROM steward_sessions WHERE session_id=?",
        (session_id,)).fetchone()
    if not row or row[0] != device:
        conn.commit()
        return {"state": "missing"}
    if row[1]:
        conn.commit()
        return {"state": "done", "msg_id": row[1]}
    if row[2]:
        conn.commit()
        return {"state": "busy"}
    claim = uuid.uuid4().hex
    conn.execute(
        "UPDATE steward_sessions SET pack_claim=? WHERE session_id=? AND device_id=? AND pack_msg_id IS NULL AND pack_claim IS NULL",
        (claim, session_id, device))
    won = conn.execute("SELECT changes()").fetchone()[0] == 1
    conn.commit()
    if not won:
        return {"state": "busy"}
    return {"state": "claimed", "claim": claim}


def pack_session(conn, device, session_id, poster):
    claim = _claim_pack(conn, device, session_id)
    if claim["state"] == "missing":
        return {"ok": False, "handed": False, "error": "没有这段管家会话"}
    if claim["state"] == "done":
        return {"ok": True, "handed": True, "duplicate": True, "msg_id": claim["msg_id"]}
    if claim["state"] == "busy":
        return _wait_pack(conn, device, session_id)
    turns = list_turns(conn, session_id)
    if not turns:
        _clear_claim(conn, session_id, claim["claim"])
        return {"ok": False, "handed": False, "error": "这段还没有可打包的话"}
    body = build_pack(turns)
    try:
        receipt = poster(body) if poster else {"ok": False}
    except Exception:
        _clear_claim(conn, session_id, claim["claim"])
        return {"ok": False, "handed": False, "msg_id": None, "error": "没有回执，不能称为已交。"}
    receipt = receipt or {"ok": False}
    if receipt.get("ok") and receipt.get("msg_id"):
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE steward_sessions SET pack_msg_id=?, closed_at=?, pack_claim=NULL WHERE session_id=? AND pack_claim=?",
            (receipt["msg_id"], int(time.time()), session_id, claim["claim"]))
        conn.commit()
        return {"ok": True, "handed": True, "duplicate": False, "msg_id": receipt["msg_id"]}
    _clear_claim(conn, session_id, claim["claim"])
    return {"ok": False, "handed": False, "msg_id": None, "error": "没有回执，不能称为已交。"}
