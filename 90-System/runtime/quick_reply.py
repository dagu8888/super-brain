#!/usr/bin/env python3
# 指挥官对话的快速回复：大古发给 grok-chief 之后，先写一条标明身份的短回复，
# 幕僚长经 /cmd 回来的正式回复仍是另一条。
#
# 香港服务器是 2 vCPU / 2 GiB，Moonshine 边车已占约 400MiB，默认不拉起对话模型。
# 未配置 SB_QUICK_REPLY_URL 时用规则/模板，通常几十毫秒内落库。
# 配了本机地址（Ollama /api/generate 或 OpenAI 兼容 /v1/chat/completions）才请求本地模型，
# 超时或失败就退回规则。不调用付费 API，不读 webhook 密钥文件。
#
# 开关（默认开）：
#   SB_QUICK_REPLY=0|off|false|no     关闭
#   SB_QUICK_REPLY_ENGINE=auto|rules|model   默认 auto
#   SB_QUICK_REPLY_URL=http://127.0.0.1:11434/api/generate
#   SB_QUICK_REPLY_MODEL=qwen2.5:0.5b
#   SB_QUICK_REPLY_TIMEOUT=2          秒，上限 2.5，避免挡住 3 秒体验
#
# 快速回复不是幕僚长：不下单、不发帖、不花钱、不删除、不改设定，也不做承诺。
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import message_bus

AGENT = "local-quick"
LABEL = "快速回复（本地小模型）"
OWNER = "dagu-owner"
CHIEF_TO = {"grok-chief", "幕僚长@云端"}
BEIJING = timezone(timedelta(hours=8))

ACTION_BODY = "这事由幕僚长处理。我已经转过去了，不会代为下单、发帖、花钱、删除或改设定，也不会替幕僚长做承诺。"
DEFAULT_BODY = "收到。已转给幕僚长，正在处理，正式回复随后到达。我只是快速回复（本地小模型），不能替幕僚长做承诺或执行动作。"
GREET_BODY = "收到。幕僚长正在处理，正式回复随后到达。"
WHO_BODY = "我是操作台的快速回复（本地小模型），不是幕僚长。我只先应一声；承诺和执行都等幕僚长的正式回复。"
STATUS_BODY = "消息已经转给幕僚长。对方冷启动通常要几十秒，正式回复会另起一条，和这条不是同一条。"

_ACTION = re.compile(
    r"下单|买入|卖出|开仓|平仓|做多|做空|"
    r"发帖|发个帖|发推|发微博|"
    r"花钱|付款|支付|转账|打款|钱付了|"
    r"删除|删掉|删了|"
    r"改设定|改设置|修改设置|改配置|修改配置|设定改|设置改|配置改|"
    r"重启服务|关掉服务|关闭服务|"
    r"承诺|你保证|要保证"
)
_GREET = re.compile(
    r"^(在吗|在不在|你好|您好|嗨|hi|hello|收到了吗|听到了吗|有人吗)[!！?？。.\s]*$",
    re.I)
_WHO = re.compile(r"你是谁|你是什么|哪个模型|什么模型")
_TIME = re.compile(r"几点|几号|星期几|今天几|现在时间|什么时间|啥时候了")
_STATUS = re.compile(r"幕僚长.{0,12}(多久|在吗|什么时候)|多久.{0,8}回|什么时候回")
_MATH = re.compile(r"(\d+)\s*([+\-*/×xX÷])\s*(\d+)")
_MATH_CN = re.compile(r"(\d+)\s*(加|减|乘|除以|除)\s*(\d+)")
_UNSAFE = re.compile(
    r"已(经)?(帮(你|您))?(下单|买入|卖出|开仓|平仓|发帖|发推|付款|支付|转账|删除|删掉|改好|修改设定|修改设置|重启)"
    r"|我是幕僚长|我就是幕僚长|替(你|您)(做|执行|下单)|保证(完成|办到|赚钱)"
)
_OPS = {"+": "加", "-": "减", "*": "乘", "/": "除",
        "加": "加", "减": "减", "乘": "乘", "除": "除", "除以": "除"}


def enabled():
    v = os.environ.get("SB_QUICK_REPLY", "1").strip().lower()
    return v not in ("0", "off", "false", "no")


def engine_mode():
    v = os.environ.get("SB_QUICK_REPLY_ENGINE", "auto").strip().lower()
    return v if v in ("auto", "rules", "model") else "auto"


def model_url():
    return (os.environ.get("SB_QUICK_REPLY_URL") or "").strip()


def model_name():
    return (os.environ.get("SB_QUICK_REPLY_MODEL") or "qwen2.5:0.5b").strip() or "qwen2.5:0.5b"


def timeout_s():
    try:
        t = float(os.environ.get("SB_QUICK_REPLY_TIMEOUT", "2"))
    except (TypeError, ValueError):
        t = 2.0
    return max(0.2, min(t, 2.5))


def eligible(msg):
    if not enabled() or not msg or not msg.get("ok"):
        return False
    if (msg.get("from_agent") or "") != OWNER:
        return False
    if (msg.get("kind") or "chat") != "chat":
        return False
    if (msg.get("to") or "") not in CHIEF_TO:
        return False
    if str(msg.get("text") or "").startswith("【"):
        return False
    return True


def classify(text):
    raw = str(text or "").strip()
    if not raw:
        return "default"
    if _ACTION.search(raw):
        return "action"
    if _GREET.match(raw):
        return "greet"
    if len(raw) <= 40 and _WHO.search(raw):
        return "who"
    if len(raw) <= 30 and _TIME.search(raw):
        return "time"
    if _STATUS.search(raw):
        return "status"
    if len(raw) <= 40 and (_MATH.search(raw) or _MATH_CN.search(raw)):
        return "math"
    return "default"


def _fmt_num(n):
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    if isinstance(n, float):
        s = ("%s" % round(n, 4)).rstrip("0").rstrip(".")
        return s or "0"
    return str(n)


def _math_answer(text):
    m = _MATH.search(text) or _MATH_CN.search(text)
    if not m:
        return None
    a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
    if a > 10 ** 9 or b > 10 ** 9:
        return None
    if op in ("x", "X", "×"):
        op = "*"
    if op == "÷":
        op = "/"
    name = _OPS.get(op, op)
    if op == "/" and b == 0:
        return "除数是 0，这道算式我答不了。已转给幕僚长。"
    if op == "+":
        val = a + b
    elif op == "-":
        val = a - b
    elif op == "*":
        val = a * b
    elif op == "/":
        val = a / b
    else:
        return None
    return "%s%s%s 等于 %s。正式口径仍以幕僚长回复为准。" % (a, name, b, _fmt_num(val))


def _time_answer(now=None):
    dt = datetime.fromtimestamp(now if now is not None else time.time(), BEIJING)
    week = "一二三四五六日"[dt.weekday()]
    return "现在是北京时间 %s，星期%s。" % (dt.strftime("%Y-%m-%d %H:%M"), week)


def rule_answer(text, intent, now=None):
    if intent == "action":
        return ACTION_BODY
    if intent == "greet":
        return GREET_BODY
    if intent == "who":
        return WHO_BODY
    if intent == "time":
        return _time_answer(now)
    if intent == "status":
        return STATUS_BODY
    if intent == "math":
        return _math_answer(text)
    return None


def prompt_for(text):
    clipped = re.sub(r"\s+", " ", str(text or "")).strip()[:500]
    return (
        "你是 Super-Brain 操作台的快速回复，不是幕僚长。"
        "用一两句中文：确认收到，或直接回答极简单的问题，并说明正式答复由幕僚长随后发出。"
        "禁止声称已经下单、发帖、付款、删除、修改设定，禁止做任何承诺。"
        "主人刚说：" + clipped
    )


def _call_model(url, model, prompt, timeout):
    """本机推理。Ollama 用 /api/generate；路径里带 chat/completions 时走兼容格式。"""
    if "chat/completions" in url:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 120,
            "temperature": 0.2,
            "stream": False,
        }
    else:
        payload = {"model": model, "prompt": prompt, "stream": False}
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "super-brain-quick-reply"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        obj = json.loads(r.read().decode("utf-8", "replace") or "{}")
    if not isinstance(obj, dict):
        raise ValueError("bad model response")
    if obj.get("response"):
        return str(obj.get("response") or "")
    choices = obj.get("choices") or []
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message") or {}
        return str(msg.get("content") or choices[0].get("text") or "")
    raise ValueError("empty model response")


def sanitize(raw):
    text = str(raw or "").strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^【[^】]{0,40}】", "", text).strip()
    if not text or _UNSAFE.search(text):
        return None
    if len(text) > 180:
        text = text[:180].rstrip() + "…"
    return text


def compose(text, now=None):
    """返回 (正文, engine)。动作类请求不交给模型。"""
    intent = classify(text)
    ruled = rule_answer(text, intent, now=now)
    if intent == "action":
        return ACTION_BODY, "rules"
    if ruled and engine_mode() != "model":
        return ruled, "rules"
    url = model_url()
    if url and engine_mode() != "rules":
        try:
            raw = _call_model(url, model_name(), prompt_for(text), timeout_s())
            safe = sanitize(raw)
            if safe:
                return safe, "model"
        except Exception:
            pass
        if ruled:
            return ruled, "rules"
    if ruled:
        return ruled, "rules"
    return DEFAULT_BODY, "rules"


def _existing(conn, reply_to):
    message_bus.ensure_schema(conn)
    return conn.execute(
        "SELECT msg_id FROM messages WHERE from_agent=? AND reply_to=?",
        (AGENT, reply_to)).fetchone()


def _insert(conn, parent, body):
    mid = message_bus.new_msg_id()
    now = max(int(time.time()), int(parent.get("created_at") or 0))
    thread = parent.get("thread_id") or parent.get("msg_id")
    stored = "【%s】\n%s" % (LABEL, body)
    conn.execute(
        "INSERT INTO messages(msg_id,from_agent,from_instance,\"to\",kind,text,"
        "reply_to,thread_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (mid, AGENT, LABEL, OWNER, "chat", stored, parent.get("msg_id"), thread, now))
    conn.commit()
    return {
        "ok": True,
        "msg_id": mid,
        "from_agent": AGENT,
        "from_instance": LABEL,
        "to": OWNER,
        "kind": "chat",
        "text": stored,
        "reply_to": parent.get("msg_id"),
        "thread_id": thread,
        "created_at": now,
        "label": LABEL,
    }


def maybe_reply(conn, msg):
    """写一条快速回复。已有则不重复。任何失败由调用方吞掉。"""
    if not eligible(msg):
        return None
    mid = msg.get("msg_id")
    if not mid or _existing(conn, mid):
        return None
    t0 = time.perf_counter()
    body, engine = compose(msg.get("text") or "")
    elapsed = int((time.perf_counter() - t0) * 1000)
    row = _insert(conn, msg, body)
    row["engine"] = engine
    row["elapsed_ms"] = elapsed
    try:
        from runtime import log_event
        log_event("quick_reply", msg_id=row["msg_id"], reply_to=mid,
                  engine=engine, ms=elapsed)
    except Exception:
        pass
    return row
