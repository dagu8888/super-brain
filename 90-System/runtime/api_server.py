#!/usr/bin/env python3
# 五入口在线接入（2026-11-08 批示#5）：HTTP API 包装 chief_execute 七接口
# 配置文件 api_tokens.json（与本文件同目录，600 权限，gitignore，绝不入库）：
#   {"bind": "127.0.0.1", "port": 18765,
#    "tokens": {"grok-chief": "...", "deepseek-chief": "...", "maus-chief": "...",
#               "dsh-chief": "...", "trae-chief": "..."}}
# 配置缺失则不启动（CLI 入口仍可用）。token 即身份：谁持有口令，谁就能以对应 chief 名义下指令。
# 用法（由 runtime.main 调用）：
#   import api_server; api_server.maybe_start(stop, log_event, db, chief_execute)
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
CONF = HERE / "api_tokens.json"
MAX_BODY = 64 * 1024                      # 请求体上限 64KB


def _make_handler(db_fn, execute_fn, log_event, tokens):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SuperBrainAPI/1.0"

        def log_message(self, *a):          # 默认访问日志静默（调用留痕走 50-Events）
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/healthz":     # 免鉴权探活
                return self._send(200, {"ok": True, "service": "super-brain-api"})
            self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            if self.path != "/cmd":
                return self._send(404, {"ok": False, "error": "not found"})
            auth = self.headers.get("Authorization", "")
            token = auth[7:] if auth.startswith("Bearer ") else ""
            chief = next((c for c, t in tokens.items()
                          if token and hmac.compare_digest(str(t), token)), None)
            if not chief:
                log_event("api_auth_failed", ip=self.client_address[0])
                return self._send(401, {"ok": False, "error": "无效口令"})
            try:
                n = int(self.headers.get("Content-Length", 0))
                if n > MAX_BODY:
                    return self._send(413, {"ok": False, "error": "请求体过大(>64KB)"})
                req = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                return self._send(400, {"ok": False, "error": "JSON 解析失败"})
            cmd, args = str(req.get("cmd", "")), req.get("args") or {}
            if not isinstance(args, dict):
                return self._send(400, {"ok": False, "error": "args 必须是对象"})
            conn = db_fn()
            try:
                res = execute_fn(conn, chief, cmd, args)
            finally:
                conn.close()
            log_event("api_call", chief=chief, cmd=cmd, ok=bool(res.get("ok")))
            self._send(200 if res.get("ok") else 400, res)

    return Handler


def maybe_start(stop, log_event, db_fn, execute_fn):
    """配置存在则启动 API 守护线程并返回之；配置缺失返回 None（不影响主运行时）。"""
    try:
        conf = json.loads(CONF.read_text(encoding="utf-8"))
        tokens = conf.get("tokens") or {}
        assert tokens, "tokens 为空"
    except Exception:
        log_event("api_disabled", note="api_tokens.json 缺失或无效，仅 CLI 入口可用")
        return None
    bind, port = str(conf.get("bind", "127.0.0.1")), int(conf.get("port", 18765))
    srv = ThreadingHTTPServer((bind, port), _make_handler(db_fn, execute_fn, log_event, tokens))
    srv.daemon_threads = True
    srv.timeout = 2                         # handle_request 轮询间隔，便于响应 stop

    def _serve():
        log_event("api_started", bind=bind, port=port, chiefs=sorted(tokens))
        while not stop.is_set():
            srv.handle_request()

    t = threading.Thread(target=_serve, name="api-server", daemon=True)
    t.start()
    return t
