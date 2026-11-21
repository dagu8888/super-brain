#!/usr/bin/env python3
"""指挥页受控会话。日常语音走官方 DeepSeek，不经幕僚长。

权限在这里用代码强制：A 类直办，明确委托或确需协助才转交一次，
C 类不执行也不转交代批。模型输出的动作标记只是提议。
未接通或上游失败时只给出可见错误，不用模拟回答顶上。
"""
import json
import re
import threading

import assistant_deepseek
import assistant_store

CHIEF_ID = "grok-chief"
MODE = "deepseek"
DELEGATE_RE = re.compile(r"告诉幕僚长|让幕僚长办")
GENUINE_RE = re.compile(r"跨项目|多步骤|需要幕僚长协助|交给幕僚长")
SENSITIVE_RE = re.compile(r"删除|删掉|重启|关机|下单|买入|卖出|转账|付款|支付|改配置|改设定|改设置|执行命令|运行命令|sudo|\brm\b|\bcurl\b|\bwget\b|\bbash\b|\bsh\b|\beval\b|powershell|drop\s+table|[|&;`$<>\\]")
ACTION_RE = re.compile(r"\[\[sb:(\{.*?\})\]\]", re.DOTALL)
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
def redirects_are_not_followed():
    return False


def public_status(allowlist=()):
    view = assistant_deepseek.public_view()
    view["allowlist_size"] = 1 if view.get("base_url") else 0
    return view


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
        self.cancels = {}

    def begin(self, device, turn_id):
        old = self.cancels.get(device)
        if old is not None:
            old.set()
        self.cancels[device] = threading.Event()
        self.active[device] = turn_id
        return turn_id

    def cancel_flag(self, device):
        flag = self.cancels.get(device)
        if flag is None:
            flag = threading.Event()
            self.cancels[device] = flag
        return flag

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


def _ui_action(text):
    raw = str(text or "").strip()
    for pattern, name, args in UI_RULES:
        if pattern.search(raw):
            if not validate_action(name, args):
                return None
            return {"name": name, "args": dict(args)}
    return None


def _mark(event, **fields):
    item = {"mock": False, "stop_mic": False}
    item.update(event)
    item.update(fields)
    item["mock"] = False
    return item


def _err(code, message):
    return _mark({"event": "error", "code": code, "stop_tts": True, "message": message})


def messages_for(book, device, user_text, card_text=None, slots=None):
    prior = []
    for item in book.memory.get(device) or []:
        role = item.get("role")
        if role not in ("user", "assistant"):
            continue
        prior.append({"role": role, "content": item.get("text") or ""})
    return [{"role": "system", "content": assistant_store.compose_system(card_text, slots)}] + prior + [{"role": "user", "content": user_text}]


def peel_actions(text):
    actions = []

    def take(match):
        try:
            obj = json.loads(match.group(1))
        except ValueError:
            return ""
        if isinstance(obj, dict) and obj.get("name"):
            actions.append(obj)
        return ""

    visible = ACTION_RE.sub(take, text)
    return visible, actions


def accept_proposal(user_text, proposal):
    """模型提议不能单独授权。C 类直接拒绝。界面动作必须和用户原话一致。"""
    if SENSITIVE_RE.search(user_text or ""):
        return False
    name = proposal.get("name")
    args = proposal.get("args") if isinstance(proposal.get("args"), dict) else {}
    if name == "handoff":
        goal = args.get("goal")
        if not isinstance(goal, str) or not goal.strip() or len(goal) > 120:
            return False
        return bool(DELEGATE_RE.search(user_text or "") or GENUINE_RE.search(user_text or ""))
    local = _ui_action(user_text)
    if not local or local["name"] != name:
        return False
    return validate_action(name, args) and args == local["args"]


def _finish_local(book, device, text, spoken):
    if spoken:
        book.spoken[device] = spoken
        book.spoken_parts[device] = split_sentences(spoken)
    book.remember(device, "user", text, uncertain=False)
    if spoken:
        book.remember(device, "assistant", spoken, uncertain=False)


def _delegate(book, device, text, poster, key_text=None, spoken=""):
    key = delegate_key(key_text or text)
    prior = book.receipts.get((device, key))
    if prior:
        sentence = "这件已经转过。回执仍是 %s。" % prior.get("msg_id")
        if prior.get("task_id"):
            sentence += "任务号 %s。" % prior.get("task_id")
        yield _mark({"event": "delegate", "duplicate": True, "receipt": prior, "text": sentence})
        yield _mark({"event": "done", "usage": {"chars": len(sentence)}})
        return
    receipt = poster(text, key) if poster else {"ok": False}
    receipt = receipt or {"ok": False}
    if receipt.get("ok") and receipt.get("msg_id"):
        stored = {"ok": True, "msg_id": receipt.get("msg_id")}
        if receipt.get("task_id"):
            stored["task_id"] = receipt.get("task_id")
        book.receipts[(device, key)] = stored
        sentence = "已转交。回执是 %s。" % stored["msg_id"]
        if stored.get("task_id"):
            sentence += "任务号 %s。没有执行记录。" % stored["task_id"]
        yield _mark({"event": "delegate", "duplicate": False, "receipt": stored, "text": sentence})
        _finish_local(book, device, key_text or text, spoken or sentence)
    else:
        sentence = "没有回执，不能称为已转交。"
        yield _mark({"event": "delegate", "duplicate": False, "receipt": None, "text": sentence})
    yield _mark({"event": "done", "usage": {"chars": len(sentence)}})


def iter_turn(book, device, turn_id, text, source="", uncertain=False, budget=None, timeout_s=None, poster=None, transport=None, card_text=None, slots=None, utterance=None):
    """逐条产出事件。日常回答只来自传入的上游；失败不另造一句模拟回答。"""
    if book.current(device) != turn_id:
        yield _err("superseded", "旧轮次已丢弃，不拼接旧句。")
        return
    if is_echo(text, book.spoken.get(device), source, book.spoken_parts.get(device)):
        yield _mark({"event": "ignored", "code": "echo", "stop_tts": False, "message": "这是刚才的朗读，不当成新指令。"})
        return
    if timeout_s is not None and float(timeout_s) <= 0:
        yield _err("timeout", "超时，失败关闭。已播内容可打断。采集保持。")
        return
    limits = assistant_deepseek.limits_from_env()
    cap = limits["max_chars"] if budget is None else min(int(budget), limits["max_chars"])
    system = assistant_store.compose_system(card_text, slots)
    yield _mark({"event": "context", "role_core": True, "role_chars": len(system), "role_core_text": system,
                 "memory_items": book.context_size(device), "uncertain_stored": False, "model_id": assistant_deepseek.OFFICIAL_MODEL})
    if uncertain:
        sentence = "这句听不准，没有写入记忆，也没有发给模型。"
        yield _mark({"event": "sentence", "text": sentence})
        yield _mark({"event": "done", "usage": {"chars": len(sentence)}})
        return
    if SENSITIVE_RE.search(str(text or "")):
        yield _err("confirm", "这句需要你本人确认。语音不会执行，也不会转交幕僚长代批。")
        return
    if HEALTH_RE.match(str(text or "").strip()):
        yield _mark({"event": "action", "name": "getServerHealth", "args": {}})
        sentence = "健康查询在本地办理，不进幕僚长。"
        yield _mark({"event": "sentence", "text": sentence})
        yield _mark({"event": "done", "usage": {"chars": len(sentence)}})
        _finish_local(book, device, text, sentence)
        return
    if DELEGATE_RE.search(str(text or "")):
        for item in _delegate(book, device, text, poster):
            yield item
        return
    action = _ui_action(text)
    if action:
        yield _mark({"event": "action", "name": action["name"], "args": action["args"]})
        sentence = "界面动作已在本地执行。"
        yield _mark({"event": "sentence", "text": sentence})
        yield _mark({"event": "done", "usage": {"chars": len(sentence)}})
        _finish_local(book, device, text, sentence)
        return
    if utterance and utterance.get("confirm"):
        yield _err("confirm", "这句按词表会改成另一种意思，没有改写原话，也没有交给模型。")
        return
    model_user = utterance.get("model_text") if utterance and utterance.get("model_text") else str(text or "")[:2000]
    upstream = transport or assistant_deepseek.stream_events
    cancel = book.cancel_flag(device)
    visible = ""
    pending = ""
    assembled = []
    handoff = None
    calls = 0
    for piece in upstream(messages_for(book, device, model_user, card_text, slots), cancel, timeout_s=limits["timeout_s"], max_tokens=limits["max_tokens"]):
        calls += 1
        if calls > 1 and piece.get("type") == "error" and piece.get("code") == "insufficient_balance":
            pass
        if book.current(device) != turn_id or cancel.is_set() and piece.get("type") != "cancelled":
            yield _err("superseded", "新一轮已到，旧句丢弃。")
            cancel.set()
            return
        kind = piece.get("type")
        if kind == "error":
            yield _err(piece.get("code") or "upstream", piece.get("message") or "官方接口没有完成。没有改用模拟回答。")
            return
        if kind == "cancelled":
            yield _err("cancelled", "已取消。采集保持。")
            return
        if kind == "delta":
            pending += piece.get("text") or ""
            speakable, proposals = peel_actions(pending)
            # 半截标记先留着，避免把 [[sb: 念出去。
            hold = ""
            cut = speakable.rfind("[[sb:")
            if cut >= 0 and "]]" not in speakable[cut:]:
                hold = speakable[cut:]
                speakable = speakable[:cut]
            pending = hold
            for proposal in proposals:
                if not accept_proposal(str(text or ""), proposal):
                    continue
                if proposal.get("name") == "handoff":
                    handoff = proposal
                    continue
                yield _mark({"event": "action", "name": proposal["name"], "args": proposal.get("args") or {}})
            if not speakable:
                continue
            if len(visible) + len(speakable) > cap:
                cancel.set()
                yield _err("budget", "输出已到上限，后面没有继续生成。")
                return
            visible += speakable
            yield _mark({"event": "delta", "text": speakable})
            sentences = split_sentences(speakable)
            if speakable and speakable[-1] not in "。！？!?":
                carry = sentences.pop() if sentences else ""
            else:
                carry = ""
            # split_sentences on a fragment that continues a previous clause needs the buffer.
            # Re-split the whole visible tail instead of the fragment alone when we already emitted.
            # The fragment split above can repeat earlier sentences. Emit only the new complete ones.
            whole = split_sentences(visible)
            new_count = len(whole) - (0 if visible[-1] in "。！？!?" else 1)
            already = len(assembled)
            for sentence in whole[already:new_count]:
                assembled.append(sentence)
                yield _mark({"event": "sentence", "text": sentence})
            del carry
        if kind == "done":
            if piece.get("finish") == "length":
                yield _err("budget", "已到输出上限，后面没有继续生成。")
                return
            break
    if pending.strip() and "[[sb:" not in pending:
        if len(visible) + len(pending) <= cap:
            visible += pending
            yield _mark({"event": "delta", "text": pending})
    if visible and (not assembled or "".join(assembled) != visible):
        tail = visible[len("".join(assembled)):].strip()
        if tail:
            assembled.append(tail)
            yield _mark({"event": "sentence", "text": tail})
    if not assembled and handoff is None:
        yield _err("empty", "官方接口没有返回可见文字。没有改用模拟回答。")
        return
    if handoff is not None:
        goal = str((handoff.get("args") or {}).get("goal") or "")
        body = (str(text or "") + " 目标：" + goal).strip()
        for item in _delegate(book, device, body, poster, key_text=str(text or ""), spoken="".join(assembled)):
            yield item
        return
    if book.current(device) != turn_id:
        yield _err("superseded", "新一轮已到，旧句不写入。")
        return
    spoken = "".join(assembled)
    book.spoken[device] = spoken
    book.spoken_parts[device] = list(assembled)
    book.remember(device, "user", text, uncertain=False)
    if spoken:
        book.remember(device, "assistant", spoken, uncertain=False)
    yield _mark({"event": "done", "usage": {"chars": len(spoken)}, "stop_tts": False, "label": assistant_deepseek.OFFICIAL_MODEL})


def plan_turn(*args, **kwargs):
    return list(iter_turn(*args, **kwargs))
