#!/usr/bin/env python3
"""指挥页受控会话。本轮只有明确标记的 mock 流。

不调用文本供应商，不读取密钥，不把回环地址或口述 model ID 写成默认值。
真实 base URL 只能等于管理员事先给出的 HTTPS 允许名单；本模块不发起连接，
因此也不会跟随跳转。
"""
import ipaddress
import re
from urllib.parse import urlparse

CHIEF_ID = "grok-chief"
MODE = "mock"
ROLE_CORE = (
    "你是大古的操作台常驻私人助手，不是幕僚长。"
    "这是未生效的核心短卡，只放进模拟上下文，不授予权限。"
    "普通问答不转交。只有明确委托才用最少内容转一次。"
    "不要把听写误词写入永久记忆。不要生成任意脚本。"
)
DELEGATE_RE = re.compile(r"告诉幕僚长|让幕僚长办")
HEALTH_RE = re.compile(r"^(?:服务器健康|健康状态|系统状态|查看服务器|服务器状态)[。！!？?\s]*$")
UI_RULES = (
    (re.compile(r"打开语音设置"), "setVoicePanelCollapsed", {"collapsed": False}),
    (re.compile(r"关闭语音设置"), "setVoicePanelCollapsed", {"collapsed": True}),
    (re.compile(r"回到指挥页|打开指挥页"), "setTab", {"tab": "chat"}),
    (re.compile(r"打开群聊"), "setTab", {"tab": "groups"}),
    (re.compile(r"打开总览"), "setTab", {"tab": "overview"}),
    (re.compile(r"滚到最新|聊天滚到最新"), "scrollChat", {}),
    (re.compile(r"先别读了|停止朗读|暂停朗读"), "stopSpeaking", {}),
    (re.compile(r"把麦关了|关闭采集|关掉麦克风"), "stopCapture", {}),
)
UI_ARGS = {
    "setTab": {"tab": {"chat", "groups", "overview", "projects", "approvals", "feed", "more"}},
    "go": {"target": {"approvals", "agents", "agents-issue", "feed", "feed-event", "rollcall", "server", "chat", "projects", "groups"}},
    "scrollChat": {},
    "setVoicePanelCollapsed": {"collapsed": {True, False}},
    "stopSpeaking": {},
    "stopCapture": {},
    "getServerHealth": {},
}
_BLOCKED_NAMES = {
    "localhost",
    "metadata.google.internal",
}


def allowlist_from_env(raw):
    if not raw:
        return ()
    return tuple(item.strip() for item in str(raw).split(",") if item.strip())


def _origin(parsed):
    host = parsed.hostname or ""
    if parsed.port:
        return "https://%s:%s" % (host, parsed.port)
    return "https://" + host


def _blocked_host(host):
    name = (host or "").lower().rstrip(".")
    if not name or name in _BLOCKED_NAMES or name.endswith(".localhost") or name.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return False
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
    )


def check_base_url(url, allowlist):
    """只做地址校验。不连接，不跟随跳转。"""
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme != "https":
        return "reject-scheme"
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return "reject-secret-or-query"
    host = parsed.hostname or ""
    if _blocked_host(host):
        return "reject-internal"
    origin = _origin(parsed)
    allowed = {item.rstrip("/") for item in allowlist or ()}
    if origin not in allowed:
        return "reject-not-allowlisted"
    return "ok"


def redirects_are_not_followed():
    return False


def public_status(allowlist=()):
    return {
        "ok": True,
        "mock": True,
        "mode": MODE,
        "real_connected": False,
        "label": "模拟流",
        "reason": "未接通真实流式文本接口。当前只有模拟流，不能当作真实对话。",
        "allowlist_size": len(tuple(allowlist or ())),
        "model_id": "",
        "base_url": "",
        "live_listen": False,
        "fields": ["base_url", "model_id", "protocol", "budget", "timeout_s"],
        "price": None,
    }


def split_sentences(text):
    raw = str(text or "").strip()
    if not raw:
        return []
    parts = []
    buf = []
    for ch in raw:
        buf.append(ch)
        if ch in "。！？!?":
            parts.append("".join(buf).strip())
            buf = []
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return [part for part in parts if part]


def _deltas(sentence):
    step = 4
    for i in range(0, len(sentence), step):
        yield sentence[i:i + step]


def validate_action(name, args):
    spec = UI_ARGS.get(name)
    if spec is None:
        return False
    args = args or {}
    if set(args) != set(spec):
        return False
    for key, allowed in spec.items():
        if allowed and args.get(key) not in allowed:
            return False
    return True


def is_echo(text, last_spoken, source, sentences=None):
    if source == "assistant_tts":
        return True
    raw = str(text or "").strip()
    if not raw:
        return False
    if str(last_spoken or "").strip() == raw:
        return True
    for sentence in sentences or ():
        if str(sentence or "").strip() == raw:
            return True
    return False


def delegate_key(text):
    compact = re.sub(r"\s+", "", str(text or ""))
    return "delegate:" + compact[:180]


class SessionBook:
    def __init__(self):
        self.active = {}
        self.memory = {}
        self.spoken = {}
        self.spoken_parts = {}
        self.receipts = {}

    def begin(self, device, turn_id):
        self.active[device] = turn_id
        return turn_id

    def current(self, device):
        return self.active.get(device)

    def remember(self, device, role, text, uncertain=False):
        if uncertain:
            return False
        bucket = self.memory.setdefault(device, [])
        bucket.append({"role": role, "text": str(text or "")[:240]})
        del bucket[:-6]
        return True

    def context_size(self, device):
        return len(self.memory.get(device) or [])


def _mock_sentences(user_text):
    clipped = re.sub(r"\s+", " ", str(user_text or "")).strip()[:40]
    return split_sentences("【模拟流】这不是真实模型。收到：" + clipped + "。")


def _ui_action(text):
    raw = str(text or "").strip()
    for pattern, name, args in UI_RULES:
        if pattern.search(raw):
            if not validate_action(name, args):
                return None
            return {"name": name, "args": dict(args), "mock": True}
    return None


def plan_turn(book, device, turn_id, text, source="", uncertain=False, budget=80, timeout_s=8, poster=None):
    """返回事件列表。每条都带 mock=true。不调用网络。"""
    events = []
    if book.current(device) != turn_id:
        events.append({"event": "error", "mock": True, "code": "superseded", "stop_tts": True, "stop_mic": False,
                       "message": "【模拟流】旧轮次已丢弃，不拼接旧句。"})
        return events
    if is_echo(text, book.spoken.get(device), source, book.spoken_parts.get(device)):
        events.append({"event": "ignored", "mock": True, "code": "echo", "stop_tts": False, "stop_mic": False,
                       "message": "【模拟流】这是刚才的朗读，不当成新指令。"})
        return events
    if timeout_s is not None and float(timeout_s) <= 0:
        events.append({"event": "error", "mock": True, "code": "timeout", "stop_tts": True, "stop_mic": False,
                       "message": "【模拟流】超时，失败关闭。已播内容可打断。采集保持。"})
        return events
    events.append({"event": "context", "mock": True, "role_core": True, "role_chars": len(ROLE_CORE),
                   "role_core_text": ROLE_CORE, "memory_items": book.context_size(device), "uncertain_stored": False})
    if uncertain:
        events.append({"event": "sentence", "mock": True, "text": "【模拟流】这句听不准，我先不问第二遍。误词不写入记忆。"})
        events.append({"event": "done", "mock": True, "usage": {"chars": 0}, "stop_mic": False})
        return events
    if HEALTH_RE.match(str(text or "").strip()):
        action = {"name": "getServerHealth", "args": {}, "mock": True}
        events.append({"event": "action", "mock": True, "name": action["name"], "args": action["args"]})
        events.append({"event": "sentence", "mock": True, "text": "【模拟流】健康查询在本地办理，不进幕僚长。"})
        events.append({"event": "done", "mock": True, "usage": {"chars": 16}, "stop_mic": False})
        book.remember(device, "user", text, uncertain=False)
        return events
    match = DELEGATE_RE.search(str(text or ""))
    if match:
        key = delegate_key(text)
        prior = book.receipts.get((device, key))
        if prior:
            events.append({"event": "delegate", "mock": True, "duplicate": True, "receipt": prior,
                           "text": "【模拟流】这件已经转过。回执仍是 %s。" % prior.get("msg_id")})
            events.append({"event": "done", "mock": True, "usage": {"chars": 8}, "stop_mic": False})
            return events
        receipt = {"ok": False}
        if poster:
            receipt = poster(text, key) or {"ok": False}
        if receipt.get("ok") and receipt.get("msg_id"):
            stored = {"ok": True, "msg_id": receipt.get("msg_id")}
            book.receipts[(device, key)] = stored
            events.append({"event": "delegate", "mock": True, "duplicate": False, "receipt": stored,
                           "text": "【模拟流】已转交。回执是 %s。" % stored["msg_id"]})
        else:
            events.append({"event": "delegate", "mock": True, "duplicate": False, "receipt": None,
                           "text": "【模拟流】没有回执，不能称为已转交。"})
        events.append({"event": "done", "mock": True, "usage": {"chars": 12}, "stop_mic": False})
        book.remember(device, "user", text, uncertain=False)
        return events
    action = _ui_action(text)
    sentences = []
    if action:
        events.append({"event": "action", "mock": True, "name": action["name"], "args": action["args"]})
        sentences = ["【模拟流】界面动作已交给程序。"]
    else:
        sentences = _mock_sentences(text)
    used = 0
    limit = int(budget if budget is not None else 80)
    assembled = []
    for sentence in sentences:
        if book.current(device) != turn_id:
            events.append({"event": "error", "mock": True, "code": "superseded", "stop_tts": True, "stop_mic": False,
                           "message": "【模拟流】新一轮已到，旧句丢弃。"})
            return events
        piece = ""
        for delta in _deltas(sentence):
            if used + len(delta) > limit:
                events.append({"event": "error", "mock": True, "code": "budget", "stop_tts": True, "stop_mic": False,
                               "message": "【模拟流】预算已满，失败关闭。", "usage": {"chars": used}})
                return events
            used += len(delta)
            piece += delta
            events.append({"event": "delta", "mock": True, "text": delta})
        if piece != sentence:
            events.append({"event": "error", "mock": True, "code": "stale-join", "stop_tts": True, "stop_mic": False,
                           "message": "【模拟流】拼装不一致，已关闭。"})
            return events
        events.append({"event": "sentence", "mock": True, "text": sentence})
        assembled.append(sentence)
    if book.current(device) != turn_id:
        events.append({"event": "error", "mock": True, "code": "superseded", "stop_tts": True, "stop_mic": False,
                       "message": "【模拟流】新一轮已到，旧句不写入。"})
        return events
    spoken = "".join(assembled)
    book.spoken[device] = spoken
    book.spoken_parts[device] = list(assembled)
    book.remember(device, "user", text, uncertain=False)
    book.remember(device, "assistant", spoken, uncertain=False)
    events.append({"event": "done", "mock": True, "usage": {"chars": used}, "stop_tts": False, "stop_mic": False,
                   "label": "模拟流"})
    return events
