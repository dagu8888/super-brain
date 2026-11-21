#!/usr/bin/env python3
# 官方 deepseek-flash 适配器。不访问 api.deepseek.com，不打印密钥。
import json
import os
import sys
import threading
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RT))

import assistant_deepseek as ds  # noqa: E402

FAILS = []
KEY = "unit-test-key-not-real"


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not detail else " " + str(detail)[:180]))
    if not cond:
        FAILS.append(name)


class Resp:
    def __init__(self, status, chunks):
        self.status = status
        self.chunks = list(chunks)
        self.closed = False

    def read(self, n=128):
        if not self.chunks:
            return b""
        return self.chunks.pop(0)

    def close(self):
        self.closed = True


class Open:
    def __init__(self, resp):
        self.resp = resp
        self.calls = 0
        self.reqs = []

    def __call__(self, req, timeout=None):
        self.calls += 1
        self.reqs.append(req)
        return self.resp


def test_contract():
    saved = {name: os.environ.pop(name, None) for name in ("SB_DEEPSEEK_API_KEY", "SB_ASSISTANT_BASE_URL", "SB_ASSISTANT_MODEL")}
    try:
        ds.reset_for_tests()
        view = ds.public_view()
        check("未配置时不宣称已接通", view["configured"] is False and view["mock"] is False and view["fallback"] == "none" and view["probed"] is False)
        check("官方模型和地址固定", view["model_id"] == "deepseek-flash" and view["base_url"] == "https://api.deepseek.com" and view["stream"] is True and view["thinking"] == "disabled")
        check("拒绝 Magpie 别名和其它主机", ds.resolve_model("deepseek/deepseek-flash")[0] == "reject-model" and ds.resolve_base("https://magpie.example")[0] == "reject-base" and ds.resolve_base("http://api.deepseek.com")[0] == "reject-base" and ds.resolve_base("https://127.0.0.1")[0] == "reject-base" and ds.resolve_base("https://169.254.169.254")[0] == "reject-base")
        payload = ds.build_payload([{"role": "user", "content": "你好"}], 512)
        check("请求体是官方流式且关闭思考", payload["model"] == "deepseek-flash" and payload["stream"] is True and payload["thinking"] == {"type": "disabled"} and KEY not in json.dumps(payload))
        src = (RT / "assistant_deepseek.py").read_text(encoding="utf-8")
        check("源码不写别名、回环端口或价格", "deepseek/deepseek-flash" not in src and "3425" not in src and "magpie" not in src.lower())
        parser = ds.SseParser()
        blob = 'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n'.encode()
        check("拆开的网络帧能拼回可见字", parser.feed(blob[:15]) == [] and parser.feed(blob[15:]) == [{"type": "delta", "text": "你"}])
        hidden = 'data: {"choices":[{"delta":{"reasoning_content":"内部","content":null}}]}\n\n'.encode()
        check("思考字段不进入可见文本", ds.SseParser().feed(hidden) == [])
    finally:
        for name, value in saved.items():
            if value is not None:
                os.environ[name] = value


def _events(opener, cancel=None):
    os.environ["SB_DEEPSEEK_API_KEY"] = KEY
    ds.reset_for_tests()
    return list(ds.stream_events([{"role": "user", "content": "你好"}], cancel or threading.Event(), opener=opener))


def test_stream_controls():
    saved = os.environ.get("SB_DEEPSEEK_API_KEY")
    try:
        framed = (
            'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"好。"},"finish_reason":"stop"}]}\n\n'
            "data: [DONE]\n\n"
        ).encode()
        opener = Open(Resp(200, [framed[:20], framed[20:]]))
        ev = _events(opener)
        texts = [item.get("text") for item in ev if item.get("type") == "delta"]
        check("适配器只交出可见增量", texts == ["你", "好。"] and any(item.get("type") == "done" for item in ev), texts)
        req = opener.reqs[0]
        body = json.loads(req.data.decode())
        check("发出的就是官方 URL 和 deepseek-flash", req.full_url == ds.OFFICIAL_URL and body["model"] == "deepseek-flash" and body["thinking"]["type"] == "disabled")
        check("事件里没有测试密钥", KEY not in json.dumps(ev, ensure_ascii=False))
        cancel = threading.Event()
        cancel.set()
        stopped = Open(Resp(200, [b"data: [DONE]\n\n"]))
        ev = _events(stopped, cancel)
        check("取消会关掉上游且不再读完", stopped.resp.closed and ev[-1]["type"] == "cancelled")
        poor = Open(Resp(402, [b'{"error":{"message":"Insufficient Balance"}}']))
        first = _events(poor)
        second = list(ds.stream_events([{"role": "user", "content": "再来"}], threading.Event(), opener=poor))
        check("余额不足只请求一次并停止", first[0]["code"] == "insufficient_balance" and poor.calls == 1 and second[0]["code"] == "insufficient_balance" and "不会自动充值" in first[0]["message"])
        ds.reset_for_tests()
        jump = Open(Resp(302, [b""]))
        jumped = _events(jump)
        check("拒绝跳转且不第二次请求", jumped[0]["code"] == "redirect_rejected" and jump.calls == 1)
        os.environ.pop("SB_ASSISTANT_BASE_URL", None)
        os.environ["SB_ASSISTANT_MODEL"] = "deepseek/deepseek-flash"
        blocked = Open(Resp(200, [b"data: [DONE]\n\n"]))
        rejected = _events(blocked)
        check("别名模型不会发出请求", rejected[0]["code"] == "reject-model" and blocked.calls == 0)
    finally:
        ds.reset_for_tests()
        if saved is None:
            os.environ.pop("SB_DEEPSEEK_API_KEY", None)
        else:
            os.environ["SB_DEEPSEEK_API_KEY"] = saved
        os.environ.pop("SB_ASSISTANT_MODEL", None)


if __name__ == "__main__":
    test_contract()
    test_stream_controls()
    if FAILS:
        print("FAILED " + ", ".join(FAILS))
        sys.exit(1)
    print("ALL PASS")
