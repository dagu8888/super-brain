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
from email.utils import formatdate
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import assistant_http
import console_api
import message_bus
import owner_ops
import read_auth
import voice_http

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
OWNER_FAILS = {}                          # ip -> [失败时刻]，大古接口防爆破
# 按住说话（2026-11-11）：录音转发给本机 Moonshine 边车（90-System/voice/stt_server.py，仅 127.0.0.1）
STT_URL = os.environ.get("SB_STT_URL", "http://127.0.0.1:18791/stt")
STT_MAX_BYTES = 48000 * 2 * 30 + 1024     # 与边车一致：16-bit 单声道 ≤30 秒
STT_RATE = {}                             # device -> [请求时刻]，每设备每分钟 ≤20 次
STT_BUSY = threading.Semaphore(2)         # 同时最多 2 路排队，其余直接 429


def _make_handler(db_fn, execute_fn, log_event, tokens, viewers=None, stop=None, owners=None, emit_fn=None, token_scopes=None):
    viewers = viewers or {}
    token_scopes = token_scopes or {}
    stop_event = stop or threading.Event()

    class Handler(BaseHTTPRequestHandler):
        server_version = "SuperBrainAPI/1.1"

        def log_message(self, *a):          # 默认访问日志静默（调用留痕走 50-Events）
            pass

        def _secure(self):
            proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
            return proto == "https"

        def _cookie(self, token, expires_at=None, clear=False):
            if clear:
                c = "sb_owner=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            else:
                c = "sb_owner=%s; Path=/; HttpOnly; SameSite=Lax" % token
                if expires_at:
                    c += "; Expires=" + formatdate(int(expires_at), usegmt=True)
            if self._secure():
                c += "; Secure"
            return c

        def _send(self, code, obj, cookies=None):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for k, v in CORS:
                self.send_header(k, v)
            if cookies:
                if isinstance(cookies, str):
                    cookies = [cookies]
                for c in cookies:
                    self.send_header("Set-Cookie", c)
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
            """SSE 增量推送。观察模式不再免口令，先过 _gate_read。
            EventSource 不能带自定义头，因此本接口仍接受查询参数 token 或 sb_owner cookie。
            带 instance 的节点连接必须是 tokens/viewers 令牌，不能只用主人会话冒充在场。"""
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            principal = getattr(self, "_read_principal", None) or {}
            token = getattr(self, "_presented", "") or ""
            instance = (q.get("instance") or "").strip()
            # 操作台 v2 观察模式：?observe=1 且不带 instance 时，推送全部消息（与 GET /api/messages
            # 同口径，只读）。必须已通过读鉴权。带 instance 的节点连接不受观察模式影响。
            observe = (not instance) and q.get("observe") == "1"
            if instance and principal.get("kind") not in ("token", "viewer"):
                log_event("api_auth_failed", ip=self.client_address[0], path="/api/stream")
                if principal.get("kind") in ("owner", "group"):
                    return self._send(403, {"ok": False, "error": "实例连接需要节点令牌", "need_auth": True})
                return self._send(401, {"ok": False, "error": "无效口令", "need_auth": True})
            if STREAM["active"] >= STREAM_MAX_CLIENTS:
                return self._send(429, {"ok": False, "error": "推送连接已达上限"})
            try:
                since = int(float(q.get("since", time.time())))
            except Exception:
                since = int(time.time())
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
                            if observe:
                                msgs = message_bus.list_messages(conn, since=msg_since, limit=200)
                            else:
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
            st = target.stat()
            etag = '"%x-%x"' % (int(st.st_mtime_ns // 1000), st.st_size)
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix == ".webmanifest":
                ctype = "application/manifest+json"
            if target.suffix.lower() == ".md":
                ctype = "text/markdown"
            if ctype.startswith("text/") or ctype in (
                    "application/javascript", "application/json", "application/manifest+json"):
                ctype += "; charset=utf-8"
            # HTML 入口不缓存（iPhone Safari / 主屏幕易卡住旧 index，从而加载旧 app.js）
            is_html = target.suffix.lower() in (".html", ".htm")
            cache = "no-store, no-cache, must-revalidate" if is_html else "no-cache"
            # 静态资源协商缓存：内容不变则 304（HTML 一律重发，避免主屏幕卡住旧入口）
            if (not is_html) and self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache)
                for k, v in CORS:
                    self.send_header(k, v)
                self.end_headers()
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            if is_html:
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
            for k, v in CORS:
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _client_ip(self):
            return (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                    or self.client_address[0])

        def _owner_token(self):
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer ") and auth[7:].strip():
                return auth[7:].strip()
            for part in (self.headers.get("Cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "sb_owner" and v:
                    return v.strip()
            return ""

        def _owner(self, conn):
            """大古身份：当日会话令牌、旧设备令牌或主口令；Agent 口令一律无效。"""
            return owner_ops.authenticate(conn, self._owner_token(), owners or {})

        def _audit_ua(self, detail):
            d = dict(detail or {})
            ua = (self.headers.get("User-Agent") or "").strip()
            if ua:
                d["ua"] = ua[:200]
            return d

        def _limited(self):
            ip = self._client_ip()
            now = time.time()
            hits = [t for t in OWNER_FAILS.get(ip, []) if now - t < 600]
            OWNER_FAILS[ip] = hits
            return len(hits) >= 20

        def _fail(self):
            ip = self._client_ip()
            OWNER_FAILS.setdefault(ip, []).append(time.time())

        def _read_json(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n > MAX_BODY * 32:
                raise ValueError("请求体过大")
            obj = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(obj, dict):
                raise ValueError("JSON 必须是对象")
            return obj

        def _owner_post(self):
            """POST /api/owner/unlock（当日口令换会话令牌）、/pair（兼容旧配对码）与 /act（写操作）。"""
            path = urlparse(self.path).path
            try:
                req = self._read_json()
            except Exception as e:
                return self._send(400, {"ok": False, "error": f"请求无效：{e}"[:80]})
            conn = db_fn()
            try:
                if path == "/api/owner/unlock":
                    ip = self._client_ip()
                    if owner_ops.unlock_is_locked(ip):
                        return self._send(429, {"ok": False, "error": "失败次数过多，5 分钟后再试"})
                    res = owner_ops.unlock(conn, req.get("phrase"), req.get("device_name"),
                                           ua=self.headers.get("User-Agent") or "")
                    who = {"actor": owner_ops.OWNER_ID, "device": res.get("device") or "?"}
                    owner_ops.audit(conn, who, "unlock", res.get("device", ""),
                                    self._audit_ua({"ok": res.get("ok"), "error": res.get("error")}),
                                    ok=res.get("ok"), ip=ip)
                    if not res.get("ok"):
                        owner_ops.unlock_note_failure(ip)
                        log_event("owner_unlock_failed", ip=ip)
                        if owner_ops.unlock_is_locked(ip):
                            return self._send(429, {"ok": False, "error": "失败次数过多，5 分钟后再试"})
                        return self._send(401, res)
                    owner_ops.unlock_note_success(ip)
                    return self._send(200, res, cookies=self._cookie(res["token"], res.get("expires_at")))
                if self._limited():
                    return self._send(429, {"ok": False, "error": "失败次数过多，10 分钟后再试"})
                if path == "/api/owner/pair":
                    ip = self._client_ip()
                    # 旧配对框兼容：直接输入当日口令，按 unlock 签发当日会话令牌
                    if owner_ops.phrase_matches(req.get("code")):
                        if owner_ops.unlock_is_locked(ip):
                            return self._send(429, {"ok": False, "error": "失败次数过多，5 分钟后再试"})
                        res = owner_ops.unlock(conn, req.get("code"), req.get("device_name"),
                                               ua=self.headers.get("User-Agent") or "")
                        who = {"actor": owner_ops.OWNER_ID, "device": res.get("device") or "?"}
                        owner_ops.audit(conn, who, "unlock", res.get("device", ""),
                                        self._audit_ua({"ok": res.get("ok"), "via": "pair"}),
                                        ok=res.get("ok"), ip=ip)
                        if not res.get("ok"):
                            owner_ops.unlock_note_failure(ip)
                            log_event("owner_unlock_failed", ip=ip, via="pair")
                            return self._send(401, res)
                        owner_ops.unlock_note_success(ip)
                        return self._send(200, res, cookies=self._cookie(res["token"], res.get("expires_at")))
                    res = owner_ops.pair(conn, req.get("code"), req.get("device_name"))
                    who = {"actor": owner_ops.OWNER_ID, "device": res.get("device") or "?"}
                    owner_ops.audit(conn, who, "pair", res.get("device", ""),
                                    {"ok": res.get("ok"), "error": res.get("error")}, ok=res.get("ok"), ip=ip)
                    if not res.get("ok"):
                        self._fail()
                        log_event("owner_pair_failed", ip=ip)
                    return self._send(200 if res.get("ok") else 400, res)
                if path != "/api/owner/act":
                    return self._send(404, {"ok": False, "error": "not found"})
                who = self._owner(conn)
                if not who:
                    self._fail()
                    log_event("owner_auth_failed", ip=self._client_ip())
                    return self._send(401, {"ok": False, "error": "需要先输入当日口令", "need_unlock": True})
                action = str(req.get("action") or "")
                args = req.get("args") or {}
                if not isinstance(args, dict):
                    return self._send(400, {"ok": False, "error": "args 必须是对象"})
                try:
                    res = owner_ops.execute(conn, who, action, args, emit=emit_fn)
                except Exception as e:
                    res = {"ok": False, "error": f"内部错误: {type(e).__name__}"}
                if action not in ("whoami", "devices", "vault_list"):   # 只读动作不记审计
                    target = (args.get("to") or args.get("agent") or args.get("task_id")
                              or args.get("id") or args.get("path") or args.get("group_id") or "")
                    owner_ops.audit(conn, who, action, target, self._audit_ua(owner_ops.audit_detail(action, args, res)),
                                    ok=bool(res.get("ok")), ip=self._client_ip())
                    log_event("owner_act", action=action, ok=bool(res.get("ok")), device=who.get("device", ""))
                cookies = None
                if action == "logout" and res.get("ok"):
                    cookies = self._cookie("", clear=True)
                return self._send(200 if res.get("ok") else 400, res, cookies=cookies)
            finally:
                conn.close()

        def _owner_stt(self):
            """POST /api/owner/stt：大古设备令牌 + audio/wav 原始字节 → 识别文本。
            音频只在内存中转发，不落盘、不进日志、不进审计；识别结果只回给调用方，
            由前端放进输入框等大古确认后再发（语音只是输入通道，不是授权）。"""
            if self._limited():
                return self._send(429, {"ok": False, "error": "失败次数过多，10 分钟后再试"})
            conn = db_fn()
            try:
                who = self._owner(conn)
            finally:
                conn.close()
            if not who:
                self._fail()
                log_event("owner_auth_failed", ip=self._client_ip(), path="/api/owner/stt")
                return self._send(401, {"ok": False, "error": "需要先输入当日口令", "need_unlock": True})
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype not in ("audio/wav", "audio/x-wav", "audio/wave"):
                return self._send(415, {"ok": False, "error": "只接受 WAV 录音"})
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
            except ValueError:
                n = -1
            if n <= 0:
                return self._send(400, {"ok": False, "error": "没有收到录音"})
            if n > STT_MAX_BYTES:
                return self._send(413, {"ok": False, "error": "录音太长（最多 30 秒）"})
            dev = str(who.get("device_id") or who.get("device") or "owner")
            now = time.time()
            hits = [t for t in STT_RATE.get(dev, []) if now - t < 60]
            if len(hits) >= 20:
                STT_RATE[dev] = hits
                return self._send(429, {"ok": False, "error": "说得太频繁了，歇一分钟再试"})
            STT_RATE[dev] = hits + [now]
            if not STT_BUSY.acquire(blocking=False):
                return self._send(429, {"ok": False, "error": "识别引擎正忙，稍后再试"})
            data = b""
            try:
                data = self.rfile.read(n)
                import urllib.error
                import urllib.request
                req = urllib.request.Request(STT_URL, data=data, method="POST",
                                             headers={"Content-Type": "audio/wav"})
                try:
                    with urllib.request.urlopen(req, timeout=45) as r:
                        code, obj = r.status, json.loads(r.read() or b"{}")
                except urllib.error.HTTPError as e:
                    try:
                        code, obj = e.code, json.loads(e.read() or b"{}")
                    except Exception:
                        code, obj = e.code, {"ok": False, "error": "识别失败"}
                except (urllib.error.URLError, OSError, TimeoutError):
                    code, obj = 503, {"ok": False, "error": "语音识别服务没启动或超时，请先用键盘输入"}
                log_event("owner_stt", ok=bool(obj.get("ok")), seconds=obj.get("seconds"),
                          ms=obj.get("ms"), chars=len(obj.get("text") or ""))
                if code >= 500 and code != 503:
                    code = 502
                return self._send(code, {k: obj.get(k) for k in ("ok", "text", "seconds", "ms", "error") if k in obj})
            finally:
                data = b""
                STT_BUSY.release()

        def _groupchat(self, method):
            """外部 Agent / 已接入 Agent 的群聊写接口与收件箱。令牌不进日志。"""
            import group_chat
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.startswith("Bearer ") else ""
            conn = db_fn()
            try:
                if method == "GET":
                    code, obj = group_chat.handle_authed_get(conn, path, q, token, tokens)
                else:
                    try:
                        req = self._read_json()
                    except Exception:
                        return self._send(400, {"ok": False, "error": "请求无效"})
                    code, obj = group_chat.handle_post(conn, path, req, token, tokens)
                    who = {"actor": "pair" if path == "/api/groupchat/pair" else "http",
                           "device": "groupchat"}
                    if token and path != "/api/groupchat/pair":
                        try:
                            act = group_chat.actor_from_token(conn, token, tokens)
                        except Exception:
                            act = None
                        if act and act.get("id"):
                            who = {"actor": str(act["id"])[:80],
                                   "device": str(act.get("kind") or "")[:40]}
                    try:
                        owner_ops.audit(conn, who, "groupchat_post", path[-80:],
                                        {"ok": bool(obj.get("ok"))}, ok=bool(obj.get("ok")),
                                        ip=self._client_ip())
                    except Exception:
                        pass
            except Exception as e:
                code, obj = 500, {"ok": False, "error": "内部错误: %s" % type(e).__name__}
            finally:
                conn.close()
            log_event("groupchat", method=method, path=path[-80:], ok=bool(obj.get("ok")))
            return self._send(code, obj)

        def _audit_access(self, conn, path, principal, ok, action=None):
            action = action or ("read" if ok else "read_denied")
            actor = str((principal or {}).get("actor") or "anonymous")[:80]
            if not read_auth.should_record((actor, path, action, bool(ok))):
                return
            try:
                owner_ops.audit(
                    conn,
                    {"actor": actor, "device": str((principal or {}).get("kind") or "")[:40]},
                    action, path[:200],
                    {"via": str((principal or {}).get("auth") or (principal or {}).get("kind") or "")[:40]},
                    ok=bool(ok), ip=self._client_ip())
            except Exception:
                pass
            if not ok:
                log_event("api_read_denied" if action == "read_denied" else "api_read_forbidden",
                          path=path, actor=actor, ip=self._client_ip())

        def _gate_read(self):
            """业务读接口：主人会话、带 scope 的 Bearer，或过渡期令牌哈希比对。匿名默认 401。"""
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            need = "stream" if path.startswith("/api/stream") else "read"
            secret = read_auth.presented_secret(self, allow_query=path.startswith("/api/stream"))
            conn = db_fn()
            try:
                principal = None
                if secret:
                    principal = read_auth.resolve(
                        conn, secret, tokens, viewers, owners or {}, token_scopes)
                if read_auth.anon_enabled():
                    read_auth.note_anon_window(log_event, True)
                    if not (principal and read_auth.allows(principal, path, need)):
                        principal = {"kind": "anon", "actor": "anon", "auth": "rollback",
                                     "scopes": ("read", "stream")}
                        secret = ""
                    self._read_principal = principal
                    self._presented = secret if principal.get("kind") in ("token", "viewer") else ""
                    self._audit_access(conn, path, principal, True)
                    return True
                read_auth.note_anon_window(log_event, False)
                if not principal:
                    self._audit_access(conn, path, {"kind": "anonymous", "actor": "anonymous"}, False)
                    self._send(401, {"ok": False, "error": "需要主人会话或令牌", "need_auth": True})
                    return False
                if not read_auth.allows(principal, path, need):
                    self._audit_access(conn, path, principal, False, action="read_forbidden")
                    self._send(403, {"ok": False, "error": "权限不足", "need_auth": True})
                    return False
                self._read_principal = principal
                self._presented = secret if principal.get("kind") in ("token", "viewer") else ""
                self._audit_access(conn, path, principal, True)
                return True
            except Exception as e:
                log_event("api_read_auth_error", path=path, error=type(e).__name__)
                try:
                    self._send(500, {"ok": False, "error": "鉴权失败"})
                except Exception:
                    pass
                return False
            finally:
                conn.close()

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/healthz" or path.startswith("/healthz/"):
                return self._send(200, {"ok": True, "service": "super-brain-api"})
            if path.startswith("/api/") and not self._gate_read():
                return
            if voice_http.try_handle(self, "GET", db_fn, log_event):
                return
            if assistant_http.try_handle(self, "GET", db_fn, log_event):
                return
            gpath = path.rstrip("/") or "/"
            if gpath in ("/api/groupchat/inbox", "/api/groupchat/me"):
                return self._groupchat("GET")
            if path.startswith("/api/owner/"):     # 大古身份自查（需主人会话）
                conn = db_fn()
                try:
                    who = self._owner(conn)
                finally:
                    conn.close()
                if not who:
                    return self._send(401, {"ok": False, "error": "需要先输入当日口令", "need_unlock": True})
                return self._send(200, {"ok": True, "data": {k: who[k] for k in ("actor", "device", "device_id")}})
            if path.startswith("/api/stream"):     # 实时推送（SSE，已过读鉴权）
                return self._stream()
            if path.startswith("/api/"):           # 只读控制台接口：字段与旧版相同，但不再匿名
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
            if voice_http.try_handle(self, "POST", db_fn, log_event):
                return
            if assistant_http.try_handle(self, "POST", db_fn, log_event):
                return
            if urlparse(self.path).path == "/api/owner/stt":
                return self._owner_stt()
            if self.path.startswith("/api/owner/"):
                return self._owner_post()
            if urlparse(self.path).path.startswith("/api/groupchat"):
                return self._groupchat("POST")
            if self.path != "/cmd":
                return self._send(404, {"ok": False, "error": "not found"})
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.startswith("Bearer ") else ""
            chief, why = read_auth.chief_for_write(token, tokens, token_scopes)
            if why != "ok":
                log_event("api_auth_failed", ip=self.client_address[0],
                          reason="scope" if why == "forbidden" else "missing")
                if why == "forbidden":
                    return self._send(403, {"ok": False, "error": "权限不足", "need_auth": True})
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
                try:
                    owner_ops.audit(conn, {"actor": chief, "device": "bearer"}, "cmd", cmd[:60],
                                    {"ok": bool(res.get("ok"))}, ok=bool(res.get("ok")),
                                    ip=self._client_ip())
                except Exception:
                    pass
            finally:
                conn.close()
            log_event("api_call", chief=chief, cmd=cmd, ok=bool(res.get("ok")))
            self._send(200 if res.get("ok") else 400, res)

    return Handler


def maybe_start(stop, log_event, db_fn, execute_fn, emit_fn=None):
    """配置存在则启动 API 守护线程并返回之；配置缺失返回 None（不影响主运行时）。"""
    try:
        conf = json.loads(CONF.read_text(encoding="utf-8"))
        tokens = conf.get("tokens") or {}
        assert tokens, "tokens 为空"
    except Exception:
        log_event("api_disabled", note="api_tokens.json 缺失或无效，仅 CLI 入口可用")
        return None
    viewers = conf.get("viewers") or {}
    owners = conf.get("owner") or {}          # 大古独立身份 {"dagu-owner": "..."}，不与 Agent 口令混用
    token_scopes = conf.get("token_scopes") or {}
    bind, port = str(conf.get("bind", "127.0.0.1")), int(conf.get("port", 18765))
    srv = ThreadingHTTPServer(
        (bind, port),
        _make_handler(db_fn, execute_fn, log_event, tokens, viewers, stop, owners, emit_fn, token_scopes))
    srv.daemon_threads = True
    srv.timeout = 2                         # handle_request 轮询间隔，便于响应 stop

    def _serve():
        log_event("api_started", bind=bind, port=port, chiefs=sorted(tokens), viewers=sorted(viewers),
                  anon_read=read_auth.anon_enabled())
        while not stop.is_set():
            srv.handle_request()

    t = threading.Thread(target=_serve, name="api-server", daemon=True)
    t.start()

    # 可选：同时监听 80，方便直接用 http://<公网IP>/ 打开控制台（端口被占用则忽略）
    handler = _make_handler(db_fn, execute_fn, log_event, tokens, viewers, stop, owners, emit_fn, token_scopes)
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
