#!/usr/bin/env python3
# Super-Brain 运行时 V2：事件驱动 + Router(规则层→模型层) + Worker(租约/fencing) + Supervisor
# 依据《2026-11-08-V2-核心设计书》及修订 R1；用法: python3 runtime.py（建议 systemd 托管）
# 仅标准库 + PyYAML（缺失时规则层退化为默认 ALLOW，不影响主干）
import json
import os
import re
import signal
import sqlite3
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from migrate_v2 import migrate, CANONICAL_USER          # noqa: E402
from path_guard import PathGuard, PermissionDenied      # noqa: E402

try:
    import yaml
except Exception:                                        # 无 yaml 也能跑主干
    yaml = None

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
DB = HERE / "state.db"
INBOX = ROOT / "00-Inbox"
EVENTS_DIR = ROOT / "50-Events"
KNOWLEDGE = ROOT / "10-Knowledge"
OUTPUTS = ROOT / "60-Outputs"
FILTERS = ROOT / "40-Agents/router/filters.yaml"
LLM_CONF = HERE / "llm.json"
CATEGORIES = ["Concepts", "Decisions", "Playbooks"]

HEARTBEAT_INTERVAL = 60
SCAN_INTERVAL = 30               # Router 事件轮询
LEASE_SECONDS = 120              # 租约时长
RENEW_INTERVAL = 30              # 执行中续租间隔
REAPER_INTERVAL = 60             # 租约回收
SUPERVISOR_INTERVAL = 30         # 线程存活检查
WORKER_IDLE_WAIT = 5
MAX_RETRIES = 3
BACKOFF_BASE = 30                # 退避：2^retry * 30s

stop = threading.Event()


# ---------- 基础 ----------

def db():
    conn = sqlite3.connect(DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS heartbeats(
        agent TEXT PRIMARY KEY, ts INTEGER, note TEXT)""")
    conn.commit()
    return conn


def log_event(kind, **fields):
    EVENTS_DIR.mkdir(exist_ok=True)
    line = json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                       "kind": kind, **fields}, ensure_ascii=False)
    with open(EVENTS_DIR / f"runtime-{time.strftime('%Y-%m-%d')}.jsonl", "a") as f:
        f.write(line + "\n")


def heartbeat(conn, agent, note=""):
    now = int(time.time())
    conn.execute("INSERT INTO heartbeats(agent,ts,note) VALUES(?,?,?) "
                 "ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts, note=excluded.note",
                 (agent, now, note))
    conn.execute("UPDATE agents SET last_seen=? WHERE agent_id=?", (now, agent))
    conn.commit()


def now_id(prefix):
    return f"{prefix}_{time.strftime('%Y%m%d')}_{uuid.uuid4().hex[:6]}"


# ---------- 事件与身份 ----------

def resolve_user(conn, source, source_user):
    row = conn.execute("SELECT canonical_user_id FROM user_identities WHERE source=? AND source_user=?",
                       (source, source_user)).fetchone()
    return row[0] if row else CANONICAL_USER     # 单用户系统兜底


def emit_event(conn, source, etype, payload, priority=0, dedupe_key=None,
               parent_id=None, source_user=""):
    eid = now_id("evt")
    cur = conn.execute(
        """INSERT OR IGNORE INTO events
           (event_id,source,type,payload,priority,dedupe_key,parent_id,status,canonical_user_id,created_at)
           VALUES(?,?,?,?,?,?,?,'new',?,?)""",
        (eid, source, etype, json.dumps(payload, ensure_ascii=False), priority,
         dedupe_key, parent_id, resolve_user(conn, source.split("-")[0], source_user),
         int(time.time())))
    conn.commit()
    return eid if cur.rowcount else None          # None = 重复事件被幂等吞掉


# ---------- LLM ----------

class RetryableError(Exception):
    pass


def load_llm():
    try:
        return json.loads(LLM_CONF.read_text(encoding="utf-8"))
    except Exception:
        return None


def call_llm(conf, system, user, max_tokens=3000):
    body = json.dumps({
        "model": conf.get("model", "deepseek-chat"),
        "temperature": 0.2, "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user[:12000]}],
    }).encode()
    req = urllib.request.Request(
        conf.get("base_url", "https://api.deepseek.com").rstrip("/") + "/v1/chat/completions",
        data=body, headers={"Authorization": "Bearer " + conf["api_key"],
                            "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code >= 500 or e.code == 429:
            raise RetryableError(f"LLM HTTP {e.code}")
        raise
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise RetryableError(f"LLM 网络错误 {e}")
    return data["choices"][0]["message"]["content"]


def parse_json(raw):
    return json.loads(re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip())


# ---------- 规则层（消费 filters.yaml） ----------

class RuleEngine:
    def __init__(self, path=FILTERS):
        self.conf, self.default = {}, "ALLOW"
        if yaml and path.exists():
            try:
                doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                self.conf = doc.get("sources", {})
                self.default = (doc.get("defaults") or {}).get("action", "ALLOW")
            except Exception as e:
                log_event("filters_load_failed", error=str(e)[:200])

    def _cond(self, cond, ev):
        p = ev["payload"]
        text = str(p.get("text", "") or p.get("content", ""))
        for k, v in (cond or {}).items():
            if k in ("sender_is_bot", "author_is_bot", "draft", "mentioned"):
                if bool(p.get(k)) != bool(v):
                    return False
            elif k == "matches":
                if not re.search(str(v), text):
                    return False
            elif k in ("action_in", "conclusion_in", "from_in", "paths_match"):
                key = {"action_in": "action", "conclusion_in": "conclusion",
                       "from_in": "from", "paths_match": "paths"}[k]
                val = p.get(key)
                if isinstance(v, str) and v.startswith("${"):     # 环境变量注入
                    v = os.environ.get(v.strip("${}"), "").split(",")
                vals = v if isinstance(v, list) else [v]
                if key == "paths":
                    paths = val if isinstance(val, list) else [val or ""]
                    if not any(re.search(g.replace("**", ".*"), str(pp)) for g in vals for pp in paths):
                        return False
                elif val not in vals:
                    return False
            elif k == "header_contains":
                if str(v).lower() not in str(p.get("headers", "")).lower():
                    return False
            elif k in ("base_branch", "conclusion"):
                if p.get(k) != v:
                    return False
        return True

    def match(self, ev):
        """返回 (action, dispatch_worker, task_type, rule_name)"""
        for rule in (self.conf.get(ev["source"], {}) or {}).get("rules", []):
            if self._cond(rule.get("if"), ev):
                return (rule.get("action", self.default), rule.get("dispatch"),
                        rule.get("task_type"), rule.get("name", "?"))
        return (self.default, None, None, "default")


# ---------- 模型层（意图分类，JSON Schema 校验） ----------

ROUTER_PROMPT = """你是任务路由器。根据事件选择唯一合适的执行 Worker。
只输出一个 JSON 对象：
{"intent":"<任务类型，必须属于所选 worker 的 capabilities>",
 "worker":"<worker 的 agent_id>",
 "subtasks":["可选，执行要点"],
 "reason":"一句话理由"}
可选 Worker 注册表：
{registry}
规则：不知道选谁就用 chat-worker；绝不编造注册表外的 worker 或能力。"""


def registry_snapshot(conn):
    rows = conn.execute(
        "SELECT agent_id,capabilities,task_types FROM agents "
        "WHERE kind='worker' AND status='active' AND verified=1").fetchall()
    return {r[0]: {"capabilities": json.loads(r[1]), "task_types": json.loads(r[2] or "[]")}
            for r in rows}


def model_classify(conn, conf, ev):
    reg = registry_snapshot(conn)
    raw = call_llm(conf, ROUTER_PROMPT.replace("{registry}", json.dumps(reg, ensure_ascii=False)),
                   json.dumps({"source": ev["source"], "type": ev["type"],
                               "payload": ev["payload"]}, ensure_ascii=False)[:4000],
                   max_tokens=500)
    out = parse_json(raw)
    # JSON Schema 校验（手工）：字段与类型
    if not isinstance(out, dict) or not isinstance(out.get("intent"), str) \
            or not isinstance(out.get("worker"), str) \
            or not isinstance(out.get("subtasks", []), list):
        raise ValueError("模型输出不符合 Schema")
    # 权限复核：worker 必须已注册且能力匹配，否则降级 chat-worker
    if out["worker"] not in reg or out["intent"] not in reg.get(out["worker"], {}).get("capabilities", []):
        log_event("model_dispatch_rejected", worker=out.get("worker"), intent=out.get("intent"))
        return {"intent": "chat", "worker": "chat-worker",
                "subtasks": out.get("subtasks", []), "reason": "模型输出越权，降级 chat-worker"}
    return out


# ---------- 任务入队 ----------

def enqueue_task(conn, ev, task_type, payload, priority=0):
    cur = conn.execute(
        """INSERT OR IGNORE INTO tasks
           (event_id,type,payload,status,priority,max_retries,canonical_user_id,created_at)
           VALUES(?,?,?,'pending',?,?,?,?)""",
        (ev["event_id"], task_type, json.dumps(payload, ensure_ascii=False),
         priority, MAX_RETRIES, ev.get("canonical_user_id"), int(time.time())))
    conn.commit()
    if cur.rowcount:
        log_event("task_enqueued", type=task_type, event=ev["event_id"], priority=priority)
    return cur.rowcount > 0


# ---------- chief 指令接口（设计书 §11.3，七接口） ----------

def chief_execute(conn, chief_id, cmd, args):
    row = conn.execute("SELECT kind,status FROM agents WHERE agent_id=?", (chief_id,)).fetchone()
    if not row or row[0] != "chief" or row[1] != "active":
        return {"ok": False, "error": f"{chief_id} 不是有效 chief（指挥权与执行权分离）"}
    canon = resolve_user(conn, chief_id.split("-")[0], chief_id)

    if cmd == "submit":
        text = str(args.get("text", "")).strip()
        if not text:
            return {"ok": False, "error": "空指令"}
        eid = emit_event(conn, chief_id, "manual", {"text": text},
                         priority=int(args.get("priority", 0)),
                         dedupe_key=args.get("dedupe_key"), source_user=chief_id)
        return {"ok": bool(eid), "event_id": eid, "canonical_user_id": canon,
                "error": None if eid else "重复指令被幂等忽略"}

    if cmd == "status":
        t = conn.execute(
            "SELECT id,type,status,priority,retry_count,result,error,created_at,claimed_at,done_at,lease_owner "
            "FROM tasks WHERE id=?", (int(args["id"]),)).fetchone()
        if not t:
            return {"ok": False, "error": "任务不存在"}
        return {"ok": True, "task": dict(zip(
            ["id", "type", "status", "priority", "retry_count", "result", "error",
             "created_at", "claimed_at", "done_at", "worker"], t))}

    if cmd == "list":
        limit = int(args.get("limit", 10))
        where = "WHERE status=?" if args.get("status") else ""
        params = [args["status"], limit] if args.get("status") else [limit]
        rows = conn.execute(
            f"SELECT id,type,status,priority,created_at,canonical_user_id FROM tasks {where} "
            "ORDER BY id DESC LIMIT ?", params).fetchall()
        return {"ok": True, "tasks": [dict(zip(
            ["id", "type", "status", "priority", "created_at", "canonical_user_id"], r)) for r in rows]}

    if cmd == "progress":
        tid = int(args["id"])
        evs = conn.execute(
            "SELECT event_id,payload,created_at FROM events WHERE type='task_progress' "
            "AND payload LIKE ? ORDER BY created_at", (f'%"task_id": {tid}%',)).fetchall()
        evs += conn.execute(
            "SELECT event_id,payload,created_at FROM events WHERE type='task_progress' "
            "AND payload LIKE ? ORDER BY created_at", (f'%"task_id":{tid}%',)).fetchall()
        return {"ok": True, "progress": [
            {"event": e[0], "payload": json.loads(e[1]), "ts": e[2]} for e in evs]}

    if cmd == "delegate":
        tid, target = int(args["id"]), str(args["to"])
        ag = conn.execute("SELECT task_types,verified,status FROM agents WHERE agent_id=? AND kind='worker'",
                          (target,)).fetchone()
        if not ag or not ag[2] == "active" or not ag[1]:
            return {"ok": False, "error": f"{target} 未通过验证或未激活，按铁律不能派单"}
        ttypes = json.loads(ag[0] or "[]")
        cur = conn.execute("SELECT type FROM tasks WHERE id=?", (tid,)).fetchone()
        new_type = cur[0] if cur and cur[0] in ttypes else ttypes[0]   # 类型兼容则保留
        cur = conn.execute(
            "UPDATE tasks SET type=?, status='pending', lease_owner=NULL, lease_expires_at=NULL, "
            "not_before=NULL, retry_count=0 WHERE id=? AND status IN ('pending','failed','dead')",
            (new_type, tid))
        conn.commit()
        if not cur.rowcount:
            return {"ok": False, "error": "任务状态不允许转交"}
        emit_event(conn, chief_id, "task_delegated", {"task_id": tid, "to": target, "type": new_type})
        return {"ok": True, "task_id": tid, "to": target, "new_type": new_type}

    if cmd == "link":
        tid = int(args["id"])
        row = conn.execute("SELECT payload FROM tasks WHERE id=?", (tid,)).fetchone()
        if not row:
            return {"ok": False, "error": "任务不存在"}
        payload = json.loads(row[0])
        payload.setdefault("linked_instructions", []).append(
            {"from": chief_id, "text": str(args.get("text", "")), "ts": int(time.time())})
        conn.execute("UPDATE tasks SET payload=? WHERE id=?", (json.dumps(payload, ensure_ascii=False), tid))
        conn.commit()
        emit_event(conn, chief_id, "task_linked", {"task_id": tid}, parent_id=None)
        return {"ok": True, "task_id": tid}

    if cmd == "cancel":
        cur = conn.execute(
            "UPDATE tasks SET status='cancelled' WHERE id=? AND status IN ('pending','doing')",
            (int(args["id"]),))
        conn.commit()
        return {"ok": bool(cur.rowcount), "error": None if cur.rowcount else "任务已终态，不可取消"}

    return {"ok": False, "error": f"未知指令 {cmd}"}


# ---------- Adapters（事件接入层 D1） ----------

def inbox_adapter(conn):
    if not INBOX.exists():
        return
    for f in sorted(INBOX.glob("*.md")):
        if f.name == "README.md":
            continue
        rel = str(f.relative_to(ROOT))
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            text = ""
        emit_event(conn, "inbox", "inbox_note",
                   {"path": rel, "size": f.stat().st_size, "text": text[:4000]},
                   dedupe_key=f"inbox:{rel}")


_cron_last = {"kb": 0}


def cron_adapter(conn):
    """每 6h 若 Inbox 积压 ≥3 篇，发 kb-organize 提醒事件。"""
    now = int(time.time())
    if now - _cron_last["kb"] < 6 * 3600:
        return
    _cron_last["kb"] = now
    n = len([f for f in INBOX.glob("*.md") if f.name != "README.md"]) if INBOX.exists() else 0
    if n >= 3:
        emit_event(conn, "cron", "kb_change", {"paths": ["00-Inbox/"], "count": n},
                   priority=1, dedupe_key=f"cron:kb:{time.strftime('%Y%m%d%H')}")


def watchdog_adapter(conn):
    """Worker 心跳 >15min 未更新 → heartbeat_lost 事件（每小时去重）。"""
    dead_line = int(time.time()) - 15 * 60
    for agent, ts in conn.execute("SELECT agent,ts FROM heartbeats WHERE ts<?", (dead_line,)):
        if agent in ("router", "supervisor"):
            continue
        emit_event(conn, "watchdog", "heartbeat_lost", {"agent": agent, "last_ts": ts},
                   priority=1, dedupe_key=f"wd:{agent}:{time.strftime('%Y%m%d%H')}")


# ---------- Router ----------

def router_loop():
    conn = db()
    rules = RuleEngine()
    conf = load_llm()
    circuit = {"open": False}                     # LLM 熔断状态（本线程内记忆，用于跳变留痕）
    while not stop.is_set():
        heartbeat(conn, "router", "routing")
        inbox_adapter(conn)
        cron_adapter(conn)
        watchdog_adapter(conn)
        # LLM 熔断（设计书 §7）：近 10min ≥2 个任务因 LLM 失败重试 → 暂停 inbox-triage 入队
        llm_fails = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE error LIKE '%LLM%' AND claimed_at>?",
            (int(time.time()) - 600,)).fetchone()[0]
        llm_down = llm_fails >= 2
        if llm_down != circuit["open"]:
            circuit["open"] = llm_down
            log_event("circuit_open" if llm_down else "circuit_closed", recent_llm_fails=llm_fails)
        # 内部留痕事件（进度/回执/指令结果等）不参与路由，直接归档
        conn.execute(
            "UPDATE events SET status='done' WHERE status='new' AND type IN "
            "('task_progress','receipt','chief_result','task_delegated','task_linked','agent_verified')")
        conn.commit()
        rows = conn.execute(
            "SELECT event_id,source,type,payload,priority,canonical_user_id FROM events "
            "WHERE status='new' AND type!='chief_cmd' "
            "ORDER BY priority DESC, created_at LIMIT 10").fetchall()
        for eid, source, etype, payload, prio, canon in rows:
            ev = {"event_id": eid, "source": source, "type": etype,
                  "payload": json.loads(payload), "canonical_user_id": canon}
            action, dispatch, task_type, rname = rules.match(ev)
            if action == "DROP":
                conn.execute("UPDATE events SET status='filtered' WHERE event_id=?", (eid,))
                log_event("event_dropped", event=eid, rule=rname, source=source)
                continue
            if dispatch and task_type:
                if llm_down and task_type == "inbox-triage":
                    continue                        # 熔断：事件留 new，恢复后自动续
                # 规则直派：URGENT 提优先级+回执；ALLOW+dispatch 为确定性映射（不调模型）
                enqueue_task(conn, ev, task_type, ev["payload"], priority=2 if action == "URGENT" else prio)
                if action == "URGENT":
                    emit_event(conn, "router", "receipt",
                               {"event": eid, "msg": f"紧急事件已直派 {dispatch}"}, parent_id=eid)
            else:                                   # ALLOW 无直派 → 模型层
                if not conf or not conf.get("api_key"):
                    enqueue_task(conn, ev, "chat", ev["payload"], priority=prio)   # 无 LLM 兜底
                else:
                    try:
                        dec = model_classify(conn, conf, ev)
                        enqueue_task(conn, ev, dec["intent"],
                                     {**ev["payload"], "subtasks": dec["subtasks"],
                                      "route_reason": dec["reason"]}, priority=prio)
                    except RetryableError:
                        continue                    # 下轮重试该事件
                    except Exception as e:          # Schema/解析失败 → 规则兜底
                        log_event("model_fallback", event=eid, error=str(e)[:200])
                        enqueue_task(conn, ev, "chat", ev["payload"], priority=prio)
            conn.execute("UPDATE events SET status='routed' WHERE event_id=?", (eid,))
            conn.commit()
        # chief_cmd 事件（外部 Agent 经 DB 注入的指令）
        for eid, source, payload in conn.execute(
                "SELECT event_id,source,payload FROM events WHERE status='new' AND type='chief_cmd'").fetchall():
            p = json.loads(payload)
            res = chief_execute(conn, source, p.get("cmd", ""), p.get("args", {}))
            emit_event(conn, "router", "chief_result", {"cmd": p.get("cmd"), "result": res}, parent_id=eid)
            conn.execute("UPDATE events SET status='done' WHERE event_id=?", (eid,))
            conn.commit()
        stop.wait(SCAN_INTERVAL)


# ---------- Worker 框架（原子领取 + 租约 + fencing + 退避 + 死信 + 取消） ----------

class TaskContext:
    def __init__(self, worker_id, task):
        self.worker_id = worker_id
        self.task = task
        self.conn = db()
        self.guard = PathGuard(self.conn, worker_id)
        self.llm = load_llm()

    def emit(self, etype, payload, **kw):
        return emit_event(self.conn, self.worker_id, etype, payload, **kw)

    def progress(self, note, pct=None):
        self.emit("task_progress", {"task_id": self.task["id"], "note": note, "pct": pct})

    def close(self):
        self.conn.close()


def _renew_loop(task_id, token, done_flag):
    conn = db()
    while not done_flag.wait(RENEW_INTERVAL):
        conn.execute("UPDATE tasks SET lease_expires_at=? WHERE id=? AND lease_token=? AND status='doing'",
                     (int(time.time()) + LEASE_SECONDS, task_id, token))
        conn.commit()
    conn.close()


def claim_task(conn, worker_id, types):
    if not types:
        return None
    now = int(time.time())
    ph = ",".join("?" * len(types))
    row = conn.execute(
        f"""UPDATE tasks SET status='doing', lease_owner=?, lease_token=lease_token+1,
            lease_expires_at=?, claimed_at=?
            WHERE id=(SELECT id FROM tasks WHERE status='pending' AND type IN ({ph})
                      AND (not_before IS NULL OR not_before<=?)
                      ORDER BY priority DESC, id LIMIT 1)
              AND status='pending'
            RETURNING id, lease_token, type, payload, retry_count, event_id""",
        (worker_id, now + LEASE_SECONDS, now, *types, now)).fetchone()
    conn.commit()
    if not row:
        return None
    return {"id": row[0], "token": row[1], "type": row[2],
            "payload": json.loads(row[3]), "retry_count": row[4], "event_id": row[5]}


def worker_loop(worker_id):
    conn = db()
    while not stop.is_set():
        heartbeat(conn, worker_id, "idle")
        # 每轮重读注册信息：verified/task_types 可能已被探针或管理员更新
        row = conn.execute("SELECT task_types,verified FROM agents "
                           "WHERE agent_id=? AND kind='worker' AND status='active'", (worker_id,)).fetchone()
        types = json.loads(row[0]) if row and row[0] else []
        if row and not row[1]:
            types = [t for t in types if t == "probe"]  # 铁律：未验证 Agent 只能领 probe
        task = claim_task(conn, worker_id, types)
        if not task:
            stop.wait(WORKER_IDLE_WAIT)
            continue
        # 取消检查（领取后、执行前）
        if conn.execute("SELECT status FROM tasks WHERE id=?", (task["id"],)).fetchone()[0] == "cancelled":
            continue
        log_event("task_claimed", id=task["id"], type=task["type"], by=worker_id, token=task["token"])
        done_flag = threading.Event()
        renewer = threading.Thread(target=_renew_loop, args=(task["id"], task["token"], done_flag), daemon=True)
        renewer.start()
        ctx = TaskContext(worker_id, task)
        try:
            handler = HANDLERS.get(task["type"])
            if not handler:
                raise ValueError(f"无处理器 {task['type']}")
            ctx.progress("开始执行")
            result = handler(task["payload"], ctx)
            cur = conn.execute(
                "UPDATE tasks SET status='done', done_at=?, result=?, error=NULL "
                "WHERE id=? AND lease_token=? AND status='doing'",
                (int(time.time()), str(result)[:500], task["id"], task["token"]))
            conn.commit()
            if cur.rowcount:
                log_event("task_done", id=task["id"], type=task["type"], by=worker_id, result=str(result)[:200])
            else:
                log_event("fencing_rejected", id=task["id"], by=worker_id, note="提交时 token 已失效")
        except PermissionDenied as e:               # 权限拒绝 → 死信（不可重试）
            conn.execute("UPDATE tasks SET status='dead', done_at=?, error=? WHERE id=? AND lease_token=?",
                         (int(time.time()), str(e)[:300], task["id"], task["token"]))
            conn.commit()
            log_event("task_dead_perm", id=task["id"], by=worker_id, error=str(e)[:200])
        except Exception as e:                      # noqa
            retry = task["retry_count"] + 1
            retryable = isinstance(e, (RetryableError, sqlite3.OperationalError))
            if retryable and retry <= MAX_RETRIES:
                conn.execute(
                    "UPDATE tasks SET status='pending', retry_count=?, not_before=?, "
                    "lease_owner=NULL, lease_expires_at=NULL, error=? WHERE id=? AND lease_token=?",
                    (retry, int(time.time()) + (2 ** retry) * BACKOFF_BASE,
                     str(e)[:300], task["id"], task["token"]))
                log_event("task_retry", id=task["id"], by=worker_id, retry=retry, error=str(e)[:200])
            else:
                conn.execute("UPDATE tasks SET status='dead', done_at=?, error=? WHERE id=? AND lease_token=?",
                             (int(time.time()), f"{'不可重试' if not retryable else '重试超限'}: {e}"[:300],
                              task["id"], task["token"]))
                log_event("task_dead", id=task["id"], by=worker_id, error=str(e)[:200])
            conn.commit()
        finally:
            done_flag.set()
            ctx.close()
        stop.wait(1)


# ---------- Reaper（租约回收；lease_token 不变 → 旧 Worker 提交被 fencing 拒绝） ----------

def reaper_loop():
    conn = db()
    while not stop.is_set():
        now = int(time.time())
        cur = conn.execute(
            "UPDATE tasks SET status='pending', lease_owner=NULL, lease_expires_at=NULL "
            "WHERE status='doing' AND lease_expires_at<?", (now,))
        conn.commit()
        if cur.rowcount:
            log_event("lease_recovered", count=cur.rowcount)
        stop.wait(REAPER_INTERVAL)


# ---------- Worker 处理器（D4） ----------

TRIAGE_PROMPT = """你是知识库整理员。用户给你一篇收集箱笔记，请整理归档。
只输出一个 JSON 对象（不要输出其他内容）：
{"category":"Concepts | Decisions | Playbooks 三选一",
 "title":"简洁标题（可含中文，不要扩展名）",
 "summary":"一句话摘要（30字内）",
 "tags":["标签1","标签2"],
 "content":"整理后的 Markdown 正文：保留全部原始信息，理顺结构，去除口语冗余"}"""


def _frontmatter(info, source, version=1):
    today = time.strftime("%Y-%m-%d")
    tags = "[" + ", ".join(info.get("tags", [])) + "]"
    return (f"---\nid: {now_id('kn')}\ntitle: {info.get('title','')}\n"
            f"category: {info.get('category','Concepts')}\ntags: {tags}\n"
            f"source: {source}\ncreated: {today}\nupdated: {today}\n"
            f"version: {version}\nquality: auto-triaged\n---\n\n")


def handle_inbox_triage(payload, ctx):
    """复用 V1 handle_inbox + frontmatter 注入（F1）+ 同源幂等（重复整理→升 version）。"""
    path_rel = payload["path"] if isinstance(payload, dict) else str(payload)
    src = ROOT / path_rel
    if not src.exists():
        return "源文件已不存在，跳过"
    ctx.guard.require_llm()
    if not ctx.llm or not ctx.llm.get("api_key"):
        return f"未配置 LLM，仅登记：{path_rel}（文件保持原位）"
    raw = call_llm(ctx.llm, TRIAGE_PROMPT, src.read_text(encoding="utf-8", errors="replace"))
    info = parse_json(raw)
    info["category"] = info.get("category") if info.get("category") in CATEGORIES else "Concepts"
    title = re.sub(r'[\\/:*?"<>|\s]+', "-", (info.get("title") or src.stem).strip())[:60].strip("-") or src.stem
    # 同源幂等：已归档过同 source → 更新 version 而非新建
    for old in KNOWLEDGE.rglob("*.md"):
        try:
            head = old.read_text(encoding="utf-8", errors="replace")[:600]
        except Exception:
            continue
        if f"source: {path_rel}" in head:
            ver = int(re.search(r"version: (\d+)", head).group(1)) + 1 if re.search(r"version: (\d+)", head) else 2
            body = (_frontmatter(info, path_rel, ver) + f"# {info.get('title', title)}\n\n"
                    f"> {info.get('summary', '')}\n> 来源：{path_rel} ｜ knowledge-worker 整理（v{ver}）\n\n"
                    f"{info.get('content', '').strip()}\n")
            ctx.guard.write_text(old, body)
            src.unlink(missing_ok=True)
            return f"已更新 → {old.relative_to(ROOT)}（v{ver}）"
    dest_dir = KNOWLEDGE / info["category"]
    dest, i = dest_dir / f"{title}.md", 1
    while dest.exists():
        i += 1
        dest = dest_dir / f"{title}-{i}.md"
    body = (_frontmatter(info, path_rel) + f"# {info.get('title', title)}\n\n"
            f"> {info.get('summary', '')}\n> 来源：{path_rel} ｜ {time.strftime('%Y-%m-%d')} knowledge-worker 自动整理\n\n"
            f"{info.get('content', '').strip()}\n")
    ctx.guard.write_text(dest, body)
    src.unlink(missing_ok=True)
    ctx.progress(f"归档至 {dest.relative_to(ROOT)}", 100)
    return f"已整理 → {dest.relative_to(ROOT)}（{info.get('summary', '')}）"


def handle_kb_organize(payload, ctx):
    n = 0
    if INBOX.exists():
        for f in sorted(INBOX.glob("*.md")):
            if f.name == "README.md":
                continue
            rel = str(f.relative_to(ROOT))
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except Exception:
                text = ""
            # 发新事件走确定性规则直派；tasks 表 UNIQUE(type,payload) 防重复入队
            if emit_event(ctx.conn, "inbox", "inbox_note",
                          {"path": rel, "size": f.stat().st_size, "text": text[:4000]}):
                n += 1
    return f"kb-organize：补登记 {n} 篇待整理"


def _kb_snippets(question, limit=4, chars=800):
    """文件级检索：按关键词重叠打分（向量库暂缓，设计书 §8/F3）。"""
    words = {w for w in re.findall(r"[\w一-鿿]{2,}", question.lower())}
    hits = []
    for f in KNOWLEDGE.rglob("*.md"):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        score = sum(text.lower().count(w) for w in words)
        if score:
            hits.append((score, f, text))
    hits.sort(reverse=True)
    return [f"### {f.name}\n{t[:chars]}" for _, f, t in hits[:limit]]


CHAT_PROMPT = """你是超级大脑助手，基于知识库内容回答用户问题。
只输出 JSON：{"answer":"Markdown 答复正文","title":"简短标题"}"""


def handle_chat(payload, ctx):
    q = str(payload.get("text") or payload.get("question") or payload)
    ctx.guard.require_llm()
    if not ctx.llm or not ctx.llm.get("api_key"):
        return f"未配置 LLM，问题已登记：{q[:50]}"
    snippets = _kb_snippets(q)
    raw = call_llm(ctx.llm, CHAT_PROMPT,
                   f"知识库摘录：\n{''.join(snippets) or '（无相关内容）'}\n\n用户问题：{q}")
    out = parse_json(raw)
    title = re.sub(r'[\\/:*?"<>|\s]+', "-", (out.get("title") or "chat"))[:40].strip("-")
    dest = OUTPUTS / "chat" / f"{time.strftime('%Y%m%d-%H%M%S')}-{title}.md"
    ctx.guard.write_text(dest, f"# {out.get('title', '答复')}\n\n> 问题：{q}\n\n{out.get('answer', '')}\n")
    # 会话状态持久化（sessions 表）
    thread = str(payload.get("thread_id") or ctx.task.get("event_id") or "default")
    ctx.conn.execute(
        "INSERT INTO sessions(thread_id,worker,state_json,updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(thread_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at",
        (thread, ctx.worker_id, json.dumps({"last_q": q[:200], "output": str(dest.relative_to(ROOT))}),
         int(time.time())))
    ctx.conn.commit()
    return f"已答复 → {dest.relative_to(ROOT)}"


CODE_PROMPT = """你是代码评审员。只输出 JSON：
{"verdict":"approve|comment|request_changes","summary":"一句话结论","report":"Markdown 评审正文"}"""


def handle_code(payload, ctx):
    note = str(payload.get("text") or payload.get("note") or "")
    paths = payload.get("paths") or []
    ctx.guard.require_llm()
    if not ctx.llm or not ctx.llm.get("api_key"):
        return f"未配置 LLM，评审请求已登记：{note[:50]}"
    material = ""
    for rel in paths[:6]:                          # 读不限制；写才走 PathGuard
        f = ROOT / rel
        if f.is_file():
            material += f"\n### {rel}\n```\n{f.read_text(encoding='utf-8', errors='replace')[:3000]}\n```\n"
    raw = call_llm(ctx.llm, CODE_PROMPT, f"评审请求：{note}\n相关材料：{material or '（未提供）'}")
    out = parse_json(raw)
    dest = OUTPUTS / "code-review" / f"{time.strftime('%Y%m%d-%H%M%S')}-review.md"
    ctx.guard.write_text(dest, f"# 代码评审（{out.get('verdict', '?')}）\n\n"
                               f"> {out.get('summary', '')}\n\n{out.get('report', '')}\n")
    return f"评审完成（{out.get('verdict', '?')}）→ {dest.relative_to(ROOT)}"


RESEARCH_PROMPT = """你是研究员。基于知识库摘录与自身知识输出研究报告。
只输出 JSON：{"title":"报告标题","report":"Markdown 正文（含结论、依据、建议）"}"""


def handle_research(payload, ctx):
    topic = str(payload.get("text") or payload.get("topic") or payload)
    ctx.guard.require_llm()
    if not ctx.llm or not ctx.llm.get("api_key"):
        return f"未配置 LLM，研究主题已登记：{topic[:50]}"
    snippets = _kb_snippets(topic)
    raw = call_llm(ctx.llm, RESEARCH_PROMPT,
                   f"知识库摘录：\n{''.join(snippets) or '（无）'}\n\n研究主题：{topic}")
    out = parse_json(raw)
    title = re.sub(r'[\\/:*?"<>|\s]+', "-", (out.get("title") or "research"))[:40].strip("-")
    dest = OUTPUTS / "research" / f"{time.strftime('%Y%m%d-%H%M%S')}-{title}.md"
    ctx.guard.write_text(dest, f"# {out.get('title', '研究报告')}\n\n> 主题：{topic}\n\n{out.get('report', '')}\n")
    return f"研究完成 → {dest.relative_to(ROOT)}"


def handle_probe(payload, ctx):
    """探针任务：Agent 注册后跑通一个 probe 方可 verified=1（派发铁律）。"""
    agent = str(payload.get("agent_id") or ctx.worker_id)
    dest = OUTPUTS / "probe" / f"{agent}-{time.strftime('%Y%m%d-%H%M%S')}.md"
    ctx.guard.write_text(dest, f"# 探针通过\n\nagent: {agent}\nts: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    ctx.conn.execute("UPDATE agents SET verified=1 WHERE agent_id=?", (agent,))
    ctx.conn.commit()
    log_event("agent_verified", agent=agent)
    return f"探针通过，{agent} 已标记 verified=1 → {dest.relative_to(ROOT)}"


HANDLERS = {
    "inbox-triage": handle_inbox_triage,
    "kb-organize": handle_kb_organize,
    "chat": handle_chat,
    "code-review": handle_code,
    "ci-analysis": handle_code,
    "research": handle_research,
    "probe": handle_probe,
    # trae-developer 能力（首期与通用处理器共用小步实现，后续独立强化）
    "code-dev": handle_code,
    "arch-review": handle_code,
    "tech-doc": handle_research,
    "code-test": handle_code,
}

WORKER_IDS = ["knowledge-worker", "chat-worker", "code-worker", "research-worker", "trae-developer"]


# ---------- Supervisor（E3：线程崩溃检测重启） ----------

def guard_run(fn, name):
    try:
        fn()
    except Exception as e:                       # noqa
        log_event("thread_crashed", thread=name, error=str(e)[:300])


def main():
    conn = db()
    migrate(conn)                                # 幂等：确保 v2 表与注册存在
    conn.close()
    targets = {"router": router_loop, "reaper": reaper_loop}
    targets.update({w: (lambda w=w: worker_loop(w)) for w in WORKER_IDS})
    threads = {n: threading.Thread(target=guard_run, args=(f, n), name=n, daemon=True)
               for n, f in targets.items()}
    for t in threads.values():
        t.start()
    log_event("runtime_started", version="v2", agents=list(targets), pid=os.getpid())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    conn = db()
    while not stop.is_set():
        heartbeat(conn, "supervisor", "watching")
        for name, t in list(threads.items()):
            if not t.is_alive():
                threads[name] = threading.Thread(target=guard_run, args=(targets[name], name),
                                                 name=name, daemon=True)
                threads[name].start()
                log_event("worker_restarted", thread=name)
        stop.wait(SUPERVISOR_INTERVAL)
    log_event("runtime_stopped", pid=os.getpid())


if __name__ == "__main__":
    sys.exit(main())
