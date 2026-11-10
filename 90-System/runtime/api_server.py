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
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import console_api
import message_bus

HERE = Path(__file__).parent
CONF = HERE / "api_tokens.json"
# 口令正本可移出仓库工作区（2026-11-09 止血包）：环境变量优先，其次 /etc/super-brain/
_env_conf = os.environ.get("SUPER_BRAIN_TOKENS")
if _env_conf and Path(_env_conf).is_file():
    CONF = Path(_env_conf)
elif Path("/etc/super-brain/api_tokens.json").is_file():
    CONF = Path("/etc/super-brain/api_tokens.json")
DESIGN = HERE.parents[1] / "70-Console" / "design"   # 控制台静态资源（只含前端文件）
MAX_BODY = 64 * 1024                      # 请求体上限 64KB
STREAM_MAX_CLIENTS = 32                   # SSE 并发上限（每条节点桥占 1 路长连）
STREAM_SECONDS = 600                      # 单连接最长 10 分钟后自动重连（浏览器原生支持）
CORS = (("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
STREAM = {"active": 0}


def _make_handler(db_fn, execute_fn, log_event, tokens, viewers=None, stop=None):
    viewers = viewers or {}
    stop_event = stop or threading.Event()

    class Handler(BaseHTTPRequestHandler):
        server_version = "SuperBrainAPI/1.1"

        def log_message(self, *a):          # 默认访问日志静默（调用留痕走 50-Events）
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for k, v in CORS:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):               # CORS 预检（控制台从本地文件/其他端口访问）
            self.send_response(204)
            for k, v in CORS:
                self.send_header(k, v)
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def _authed(self, allowed):
            auth = self.headers.get("Authorization", "")
            token = auth[7:] if auth.startswith("Bearer ") else ""
            return bool(token) and any(
                t and hmac.compare_digest(str(t).encode(), token.encode()) for t in allowed)

        def _stream(self):
            """SSE 增量推送（EventSource 不支持自定义请求头，token 走查询参数）。"""
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            auth = self.headers.get("Authorization", "")
            token = q.get("token") or (auth[7:] if auth.startswith("Bearer ") else "")
            allowed = list(tokens.values()) + list(viewers.values())
            if not token or not any(
                    t and hmac.compare_digest(str(t).encode(), token.encode()) for t in allowed):
                log_event("api_auth_failed", ip=self.client_address[0], path="/api/stream")
                return self._send(401, {"ok": False, "error": "无效口令"})
            if STREAM["active"] >= STREAM_MAX_CLIENTS:
                return self._send(429, {"ok": False, "error": "推送连接已达上限"})
            try:
                since = int(float(q.get("since", time.time())))
            except Exception:
                since = int(time.time())
            # S3 节点信使：?instance=<名册实例名> 以长连注册心跳（不写新表，沿用 heartbeats/agents）
            instance = (q.get("instance") or "").strip()
            if instance:
                conn = db_fn()
                try:
                    hit = conn.execute(
                        "SELECT status FROM registry WHERE name=? AND kind='instance'",
                        (instance,)).fetchone()
                except Exception:
                    hit = None
                finally:
                    conn.close()
                if not hit or hit[0] != "active":
                    log_event("api_instance_rejected", ip=self.client_address[0], instance=instance[:60])
                    return self._send(403, {"ok": False,
                                            "error": f"{instance} 不在实例名册或已下线"})

            def register_presence():
                # heartbeats.agent 保持实例名；last_seen 写到 registry.agent_ref（如 dsh2-chief）
                conn = db_fn()
                try:
                    console_api.touch_instance_presence(conn, instance)
                    conn.commit()
                finally:
                    conn.close()

            if instance:
                register_presence()
            # 连接身份：口令→chief；无 instance 的连接也能收发给其 chief 的消息
            ident = message_bus.identity_from_token(tokens, token, conn=None, instance=instance)
            if instance and not ident.get("agent_ref"):
                ctmp = db_fn()
                try:
                    ident = message_bus.identity_from_token(tokens, token, conn=ctmp, instance=instance)
                finally:
                    ctmp.close()
            agent_ref = ident.get("agent_ref") or ident.get("chief")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            for k, v in CORS:
                self.send_header(k, v)
            self.end_headers()
            STREAM["active"] += 1
            seen, seen_msg, beat, deadline = set(), set(), time.time(), time.time() + STREAM_SECONDS
            msg_since = since
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while not stop_event.is_set() and time.time() < deadline:
                    conn = db_fn()
                    try:
                        rows = conn.execute(
                            "SELECT event_id,source,type,priority,status,parent_id,created_at "
                            "FROM events WHERE created_at>=? ORDER BY created_at ASC, rowid ASC "
                            "LIMIT 200", (since,)).fetchall()
                        try:
                            msgs = message_bus.poll_for_connection(
                                conn, msg_since, agent_ref, instance)
                        except Exception:
                            msgs = []
                    finally:
                        conn.close()
                    for r in rows:
                        eid = r[0]
                        if eid in seen:
                            continue
                        seen.add(eid)
                        payload = {"event_id": eid, "source": r[1], "type": r[2],
                                   "priority": r[3], "status": r[4], "parent_id": r[5],
                                   "created_at": r[6]}
                        self.wfile.write(
                            f"id: {eid}\nevent: event\ndata: "
                            f"{json.dumps(payload, ensure_ascii=False)}\n\n".encode())
                        since = max(since, int(r[6] or 0))
                    for m in msgs:
                        mid = m.get("msg_id")
                        if not mid or mid in seen_msg:
                            continue
                        seen_msg.add(mid)
                        self.wfile.write(
                            f"id: {mid}\nevent: msg\ndata: "
                            f"{json.dumps(m, ensure_ascii=False)}\n\n".encode())
                        msg_since = max(msg_since, int(m.get("created_at") or 0))
                    if len(seen) > 20000:          # 去重集合封顶，防止长连接内存膨胀
                        seen.clear()
                    if len(seen_msg) > 20000:
                        seen_msg.clear()
                    if time.time() - beat > 15:
                        self.wfile.write(b": ping\n\n")
                        beat = time.time()
                        if instance:               # S3：长连存续即在场，随保活节拍续心跳
                            try:
                                register_presence()
                            except Exception:
                                pass
                    self.wfile.flush()
                    stop_event.wait(1.0)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                STREAM["active"] = max(0, STREAM["active"] - 1)
                self.close_connection = True

        def _static(self):
            """托管控制台静态文件（仅 70-Console/design，防目录穿越，无目录列表）。"""
            path = urlparse(self.path).path
            if path in ("/", "/console", "/console/"):
                self.send_response(302)
                self.send_header("Location", "/console/prototype/index.html")
                for k, v in CORS:
                    self.send_header(k, v)
                self.end_headers()
                return
            if not path.startswith("/console/"):
                return self._send(404, {"ok": False, "error": "not found"})
            target = (DESIGN / unquote(path[len("/console/"):])).resolve()
            try:
                target.relative_to(DESIGN.resolve())
            except ValueError:
                return self._send(404, {"ok": False, "error": "not found"})
            if not target.is_file():
                return self._send(404, {"ok": False, "error": "not found"})
            data = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            for k, v in CORS:
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/healthz"):        # 免鉴权探活
                return self._send(200, {"ok": True, "service": "super-brain-api"})
            if self.path.startswith("/api/stream"):     # 实时推送（SSE）
                return self._stream()
            if self.path.startswith("/api/"):           # 只读控制台接口（viewers 或 chief 口令）
                if not self._authed(list(tokens.values()) + list(viewers.values())):
                    log_event("api_auth_failed", ip=self.client_address[0], path=self.path[:80])
                    return self._send(401, {"ok": False, "error": "无效口令"})
                conn = db_fn()
                try:
                    code, obj = console_api.handle_get(conn, self.path)
                except Exception as e:
                    code, obj = 500, {"ok": False, "error": f"内部错误: {type(e).__name__}: {e}"[:200]}
                finally:
                    conn.close()
                return self._send(code, obj)
            if self.path == "/" or self.path.startswith("/console"):
                return self._static()
            self._send(404, {"ok": False, "error": "not found"})

        def do_HEAD(self):
            if self.path == "/" or self.path.startswith("/console"):
                return self._static()
            self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            if self.path != "/cmd":
                return self._send(404, {"ok": False, "error": "not found"})
            auth = self.headers.get("Authorization", "")
            token = auth[7:] if auth.startswith("Bearer ") else ""
            chief = next((c for c, t in tokens.items()
                          if token and hmac.compare_digest(str(t).encode(), token.encode())), None)
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
    viewers = conf.get("viewers") or {}
    bind, port = str(conf.get("bind", "127.0.0.1")), int(conf.get("port", 18765))
    srv = ThreadingHTTPServer(
        (bind, port),
        _make_handler(db_fn, execute_fn, log_event, tokens, viewers, stop))
    srv.daemon_threads = True
    srv.timeout = 2                         # handle_request 轮询间隔，便于响应 stop

    def _serve():
        log_event("api_started", bind=bind, port=port, chiefs=sorted(tokens), viewers=sorted(viewers))
        while not stop.is_set():
            srv.handle_request()

    t = threading.Thread(target=_serve, name="api-server", daemon=True)
    t.start()

    # 可选：同时监听 80，方便直接用 http://<公网IP>/ 打开控制台（端口被占用则忽略）
    handler = _make_handler(db_fn, execute_fn, log_event, tokens, viewers, stop)
    for extra in conf.get("extra_ports") or []:
        try:
            s2 = ThreadingHTTPServer(("0.0.0.0", int(extra)), handler)
        except OSError as e:
            log_event("api_extra_port_failed", port=extra, error=str(e)[:120])
            continue
        s2.daemon_threads = True
        s2.timeout = 2

        def _serve_extra(srv2=s2, p=extra):
            log_event("api_extra_port_started", port=p)
            while not stop.is_set():
                srv2.handle_request()

        threading.Thread(target=_serve_extra, name=f"api-port-{extra}", daemon=True).start()

    return t
