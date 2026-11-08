#!/usr/bin/env python3
# Orchestrator 中台引擎（任务包第4包 S1；古大已批 D1-D3）
# 只做五件事：接计划、生成子任务图、按规则分配、盯状态推进、齐套汇总。
# 纪律（Trae 审计结论，全程遵守）：
#   - 旁路订阅：捞 status='new' 且带 orchestrate 标记的事件，置 orch_consumed 后处理；主路一字不动
#   - 子任务直接落 tasks 表，不产生新路由事件、不进 Router/模型层
#   - 单写者：orch_plans/task_links 派生状态只由本模块写；多行写入同事务；写事务内无网络/LLM 调用
#   - 失联判定沿用心跳 300 秒；D2 尺度：worker 内重试(既有) → 改派兄弟(attempt=2) → dead+assist 告警
import json
import sqlite3
import time
from pathlib import Path

from runtime import log_event, now_id, registry_lookup

HERE = Path(__file__).parent
ROOT = HERE.parents[1]
DB = HERE / "state.db"
SUMMARY_DIR = ROOT / "60-Outputs" / "orch"

ORCH_INTERVAL = 5                # 巡检间隔（秒）
OFFLINE_SECONDS = 300            # 心跳失联阈值（与 console_api 同口径）
TERMINAL = ("done", "failed", "dead", "cancelled")


def _db():
    conn = sqlite3.connect(DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


# ---------- 计划接入 ----------

def _topo_cycle(steps):
    """DFS 查环；返回环路径（list）或 None。"""
    deps = {s["step_key"]: list(s.get("depends_on") or []) for s in steps}
    WHITE, GRAY, BLACK = 0, 1, 2
    color, stack, cycle = {k: WHITE for k in deps}, [], []

    def dfs(u):
        color[u] = GRAY
        stack.append(u)
        for v in deps.get(u, []):
            if v not in deps:                      # 依赖了不存在的步骤
                continue
            if color[v] == GRAY:
                cycle.extend(stack[stack.index(v):] + [v])
                return True
            if color[v] == WHITE and dfs(v):
                return True
        stack.pop()
        color[u] = BLACK
        return False

    for k in deps:
        if color[k] == WHITE and dfs(k):
            return cycle
    return None


def _consume_plans(conn, now):
    """捞带编排标记的新事件 → 拓扑查环 → 同事务落计划+步骤+首批入队。"""
    rows = conn.execute(
        "SELECT event_id,source,payload,canonical_user_id FROM events "
        "WHERE status='new' AND json_extract(payload,'$.orchestrate') IS NOT NULL "
        "ORDER BY created_at LIMIT 10").fetchall()
    for eid, source, raw, canon in rows:
        try:
            orch = (json.loads(raw) or {}).get("orchestrate") or {}
            steps = orch.get("steps") or []
            mode = orch.get("mode", "all_required")
            if not steps or mode not in ("all_required", "partial_ok"):
                raise ValueError("steps 为空或 mode 非法")
            keys = [s.get("step_key") for s in steps]
            if any(not k for k in keys) or len(set(keys)) != len(keys):
                raise ValueError("step_key 缺失或重复")
            dep_keys = {d for s in steps for d in (s.get("depends_on") or [])}
            unknown = dep_keys - set(keys)
            if unknown:
                raise ValueError(f"依赖了不存在的 step_key: {sorted(unknown)}")
            cycle = _topo_cycle(steps)
            if cycle:
                raise ValueError("环形依赖: " + " -> ".join(cycle))
        except (ValueError, json.JSONDecodeError) as e:
            conn.execute("UPDATE events SET status='orch_rejected' WHERE event_id=?", (eid,))
            conn.commit()
            log_event("orch_plan_rejected", event=eid, reason=str(e)[:300])
            continue

        plan_id = now_id("plan")
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "INSERT INTO orch_plans(plan_id,root_event_id,chief,canonical_user_id,title,mode,status,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,'running',?,?)",
                (plan_id, eid, source, canon, str(orch.get("title") or "")[:200], mode, now, now))
            for s in steps:
                conn.execute(
                    "INSERT INTO task_links(plan_id,step_key,link_type,depends_on,target,task_type,payload,status,created_at) "
                    "VALUES(?,?,'child',?,?,?,?,'waiting',?)",
                    (plan_id, s["step_key"], json.dumps(s.get("depends_on") or []),
                     s.get("to"), s.get("type"),
                     json.dumps(s.get("payload") or ({"text": s["text"]} if s.get("text") else {}),
                              ensure_ascii=False), now))
            conn.execute("UPDATE events SET status='orch_consumed' WHERE event_id=?", (eid,))
            conn.commit()
        except sqlite3.IntegrityError:             # root_event_id 唯一约束：同事件只许一份计划
            conn.rollback()
            conn.execute("UPDATE events SET status='orch_rejected' WHERE event_id=?", (eid,))
            conn.commit()
            log_event("orch_plan_rejected", event=eid, reason="root_event_id 重复，计划已存在")
            continue
        log_event("orch_plan_started", plan=plan_id, event=eid, by=source,
                  steps=len(steps), mode=mode)
        _release_ready(conn, plan_id, now)


# ---------- 子任务入队与依赖释放 ----------

def _enqueue_child(conn, plan_id, link, canon, now):
    """子任务直接落 tasks 表（不过 Router）；payload 带 orch 上下文可追溯。"""
    base = json.loads(link["payload"] or "{}")
    target, ttype = link["target"], link["task_type"]
    base["orch"] = {"plan_id": plan_id, "step_key": link["step_key"],
                    "attempt": link["attempt"], "round": link.get("round", 1), "target": target}
    if target:
        entry = registry_lookup(conn, target)
        if not entry or entry["status"] != "active":
            log_event("orch_target_rejected", plan=plan_id, step=link["step_key"], target=target)
            return None                          # 名册拒绝：留在 waiting，等失联/人工处置
        if entry["kind"] == "worker":
            ttype = ttype or json.loads(conn.execute(
                "SELECT task_types FROM agents WHERE agent_id=?", (entry["agent_ref"],)
            ).fetchone()[0] or "[]")[0]
        else:                                    # 实例/幕僚长 → 入口协作池点名
            base.update({"to": target, "to_agent": entry["agent_ref"], "from": "orchestrator"})
            ttype = "assist"
    if not ttype:
        log_event("orch_step_no_type", plan=plan_id, step=link["step_key"])
        return None
    cur = conn.execute(
        "INSERT OR IGNORE INTO tasks(event_id,type,payload,status,priority,max_retries,canonical_user_id,created_at) "
        "VALUES(?,?,?,'pending',0,?,?,?)",
        (None, ttype, json.dumps(base, ensure_ascii=False), 3, canon, now))
    if cur.rowcount:
        tid = cur.lastrowid
    else:                                        # 幂等命中：找回既有任务
        tid = conn.execute("SELECT id FROM tasks WHERE type=? AND payload=?",
                           (ttype, json.dumps(base, ensure_ascii=False))).fetchone()[0]
    conn.execute("UPDATE task_links SET child_task_id=?, status='enqueued' WHERE id=?",
                 (tid, link["id"]))
    log_event("orch_step_enqueued", plan=plan_id, step=link["step_key"], task=tid, type=ttype)
    return tid


def _release_ready(conn, plan_id, now):
    """依赖齐套（全部 done）才释放；依赖非 done 终态按模式处置。返回是否有动作。"""
    plan = conn.execute("SELECT mode,chief,canonical_user_id FROM orch_plans WHERE plan_id=?",
                        (plan_id,)).fetchone()
    if not plan:
        return
    mode, chief, canon = plan
    links = conn.execute(
        "SELECT id,step_key,depends_on,target,task_type,payload,attempt,round FROM task_links "
        "WHERE plan_id=? AND status='waiting'", (plan_id,)).fetchall()
    cols = ["id", "step_key", "depends_on", "target", "task_type", "payload", "attempt", "round"]
    for raw in links:
        link = dict(zip(cols, raw))
        deps = json.loads(link["depends_on"] or "[]")
        bad, ready = None, True
        for d in deps:
            dep = conn.execute(
                "SELECT t.status FROM task_links l JOIN tasks t ON l.child_task_id=t.id "
                "WHERE l.plan_id=? AND l.step_key=?", (plan_id, d)).fetchone()
            if not dep or dep[0] not in TERMINAL:
                ready = False
                break
            if dep[0] != "done":
                bad = (d, dep[0])
        if not ready:
            continue
        if bad:                                  # 依赖非 done 终态：本步骤永不可达
            _step_terminal(conn, plan_id, link["step_key"], None, f"skipped: 依赖 {bad[0]} 终态 {bad[1]}",
                           mode, chief, canon, now)
            continue
        _enqueue_child(conn, plan_id, link, canon, now)
    conn.commit()


# ---------- 终态处置 / 改派 / 告警 ----------

def _alert(conn, plan_id, chief, canon, text, now):
    conn.execute(
        "INSERT INTO tasks(type,payload,status,priority,max_retries,canonical_user_id,created_at) "
        "VALUES('assist',?,'pending',1,3,?,?)",
        (json.dumps({"text": text, "from": "orchestrator", "to": chief, "to_agent": chief,
                     "plan_id": plan_id}, ensure_ascii=False), canon, now))


def _step_terminal(conn, plan_id, step_key, status, note, mode, chief, canon, now):
    """步骤终局：标记 terminal；all_required 遇非 done → 计划 failed + 告警；partial_ok 记红字待收口。"""
    conn.execute("UPDATE task_links SET status='terminal' WHERE plan_id=? AND step_key=?",
                 (plan_id, step_key))
    log_event("orch_step_terminal", plan=plan_id, step=step_key, status=status, note=note[:200])
    if mode == "all_required" and status not in ("done", None):
        conn.execute(
            "UPDATE orch_plans SET status='failed', review_reason=?, updated_at=?, done_at=? WHERE plan_id=?",
            (f"步骤 {step_key} 终态 {status}：{note}"[:300], now, now, plan_id))
        _alert(conn, plan_id, chief, canon,
               f"中台告警：计划 {plan_id} 失败 —— 步骤 {step_key} 终态 {status}（{note[:120]}）", now)


def _sibling(conn, link, child_owner):
    """D2 改派候选：同 task_type 的其他在线 verified worker；或名册内其他在线实例。无则 None。"""
    now = int(time.time())
    if child_owner:
        rows = conn.execute(
            "SELECT agent_id,task_types FROM agents WHERE kind='worker' AND status='active' "
            "AND verified=1 AND agent_id!=?", (child_owner,)).fetchall()
        for aid, tt in rows:
            if link["task_type"] in json.loads(tt or "[]"):
                hb = conn.execute("SELECT ts FROM heartbeats WHERE agent=?", (aid,)).fetchone()
                if hb and now - hb[0] < OFFLINE_SECONDS:
                    return aid
    if link["target"]:
        rows = conn.execute(
            "SELECT name,agent_ref FROM registry WHERE kind='instance' AND status='active' AND name!=?",
            (link["target"],)).fetchall()
        for name, ref in rows:
            hb = conn.execute("SELECT ts FROM heartbeats WHERE agent=?", (ref,)).fetchone()
            if hb and now - hb[0] < OFFLINE_SECONDS:
                return name
    return None


def _watch_children(conn, now):
    """盯在途子任务：dead → 第一次改派兄弟（attempt=2）→ 再死则终局+告警。"""
    plans = {r[0]: (r[1], r[2], r[3]) for r in conn.execute(
        "SELECT plan_id,mode,chief,canonical_user_id FROM orch_plans WHERE status='running'")}
    if not plans:
        return
    rows = conn.execute(
        "SELECT l.id,l.plan_id,l.step_key,l.target,l.task_type,l.payload,l.attempt,l.child_task_id,"
        "       t.status,t.lease_owner FROM task_links l JOIN tasks t ON l.child_task_id=t.id "
        "WHERE l.status='enqueued'").fetchall()
    for (lid, plan_id, step_key, target, ttype, payload, attempt, tid,
         tstatus, owner) in rows:
        if plan_id not in plans:
            continue
        mode, chief, canon = plans[plan_id]
        if tstatus in ("done", "failed", "cancelled"):
            conn.execute("UPDATE task_links SET status='terminal' WHERE id=?", (lid,))
            _step_terminal_if_needed(conn, plan_id, step_key, tstatus, mode, chief, canon, now)
        elif tstatus == "dead":
            if attempt < 2:
                sib = _sibling(conn, {"target": target, "task_type": ttype}, owner)
                if sib:
                    conn.execute(
                        "UPDATE task_links SET attempt=2, child_task_id=NULL, status='waiting', target=? "
                        "WHERE id=?", (sib, lid))
                    log_event("orch_step_reassigned", plan=plan_id, step=step_key,
                              from_owner=owner, to=sib)
                    continue
            _step_terminal(conn, plan_id, step_key, "dead", "重试与改派用尽", mode, chief, canon, now)
    conn.commit()
    for plan_id in plans:
        _release_ready(conn, plan_id, now)


def _step_terminal_if_needed(conn, plan_id, step_key, status, mode, chief, canon, now):
    if status != "done":
        _step_terminal(conn, plan_id, step_key, status, "子任务终态", mode, chief, canon, now)


# ---------- 汇总收口 ----------

def _summarize(conn, now):
    for plan_id, mode, chief, title, summary_path in conn.execute(
            "SELECT plan_id,mode,chief,title,summary_path FROM orch_plans WHERE status='running'"):
        left = conn.execute(
            "SELECT COUNT(*) FROM task_links WHERE plan_id=? AND status!='terminal'", (plan_id,)
        ).fetchone()[0]
        if left:
            continue
        steps = conn.execute(
            "SELECT l.step_key,l.child_task_id,t.status,substr(COALESCE(t.result,t.error,''),1,300) "
            "FROM task_links l LEFT JOIN tasks t ON l.child_task_id=t.id "
            "WHERE l.plan_id=? ORDER BY l.id", (plan_id,)).fetchall()
        bad = [(k, st) for k, _, st, _ in steps if st != "done"]
        if mode == "all_required" and bad:
            conn.execute(
                "UPDATE orch_plans SET status='failed', review_reason=?, updated_at=?, done_at=? "
                "WHERE plan_id=?", (f"未齐套：{bad}"[:300], now, now, plan_id))
            continue
        fpath = SUMMARY_DIR / f"{plan_id}.md"
        if not fpath.exists():                   # reconcile 幂等：已写过的汇总不重写
            lines = [f"# 计划汇总 {plan_id}", f"", f"- 标题：{title or '（无）'}",
                     f"- 发起：{chief} · 模式：{mode}", f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
                     f"", "| 步骤 | 任务 | 终态 | 结果摘要 |", "|---|---|---|---|"]
            for k, tid, st, summ in steps:
                mark = "  **（失败/未完成，红字标注）**" if st != "done" else ""
                lines.append(f"| {k} | #{tid or '-'} | {st or 'skipped'}{mark} | {(summ or '')[:120]} |")
            SUMMARY_DIR.mkdir(parents=True, exist_ok=True)
            tmp = fpath.with_suffix(".md.tmp")
            tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
            tmp.rename(fpath)                    # 原子改名
        try:
            rel = str(fpath.relative_to(ROOT))
        except ValueError:                       # 演练环境 SUMMARY_DIR 在仓库外
            rel = str(fpath)
        conn.execute(
            "UPDATE orch_plans SET status='awaiting_review', summary_path=?, updated_at=? WHERE plan_id=?",
            (rel, now, plan_id))
        log_event("orch_plan_awaiting_review", plan=plan_id, summary=str(fpath))
    conn.commit()


# ---------- 验收意向消费（events 账本，单写者） ----------

def _consume_reviews(conn, now):
    rows = conn.execute(
        "SELECT event_id,payload FROM events WHERE type='plan_review' AND status IN ('new','done') "
        "ORDER BY created_at LIMIT 10").fetchall()
    for eid, raw in rows:
        p = json.loads(raw)
        plan_id, decision, reason = p.get("plan_id"), p.get("decision"), p.get("reason", "")
        conn.execute("UPDATE events SET status='orch_consumed' WHERE event_id=?", (eid,))
        plan = conn.execute(
            "SELECT status,mode,chief,canonical_user_id FROM orch_plans WHERE plan_id=?",
            (plan_id,)).fetchone()
        if not plan or plan[0] not in ("awaiting_review", "rework"):
            conn.commit()
            continue
        _, mode, chief, canon = plan
        if decision == "approve":
            conn.execute(
                "UPDATE orch_plans SET status='done', updated_at=?, done_at=? WHERE plan_id=?",
                (now, now, plan_id))
            log_event("orch_plan_done", plan=plan_id, by="plan_review")
        else:                                    # reject → 返工子任务点名原执行方
            conn.execute(
                "UPDATE orch_plans SET status='running', review_reason=?, updated_at=? WHERE plan_id=?",
                (reason[:300], now, plan_id))
            links = conn.execute(
                "SELECT id,step_key,target,task_type,payload,attempt,round FROM task_links WHERE plan_id=?",
                (plan_id,)).fetchall()
            for lid, step_key, target, ttype, payload, attempt, rnd in links:
                conn.execute(
                    "UPDATE task_links SET status='waiting', child_task_id=NULL, round=round+1 WHERE id=?",
                    (lid,))
                _enqueue_child(conn, plan_id,
                               {"id": lid, "step_key": step_key, "target": target,
                                "task_type": ttype, "payload": payload,
                                "attempt": attempt, "round": rnd + 1},
                               canon, now)
            log_event("orch_plan_rework", plan=plan_id, reason=reason[:200])
        conn.commit()


# ---------- 主循环 ----------

def reconcile(conn):
    """启动续推：未终态计划数量留痕；汇总半状态由 _summarize 幂等补状态（文件在则不重写）。"""
    n = conn.execute(
        "SELECT COUNT(*) FROM orch_plans WHERE status IN ('running','rework','awaiting_review')"
    ).fetchone()[0]
    log_event("orch_reconcile", open_plans=n)


def orchestrator_loop(stop):
    conn = _db()
    reconcile(conn)
    while not stop.is_set():
        try:
            now = int(time.time())
            _consume_plans(conn, now)
            for (pid,) in conn.execute("SELECT plan_id FROM orch_plans WHERE status='running'"):
                _release_ready(conn, pid, now)
            _watch_children(conn, now)
            _summarize(conn, now)
            _consume_reviews(conn, now)
        except Exception as e:
            log_event("orch_tick_error", error=str(e)[:200])
        stop.wait(ORCH_INTERVAL)


if __name__ == "__main__":
    import threading
    orchestrator_loop(threading.Event())
