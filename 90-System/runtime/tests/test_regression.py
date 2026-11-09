#!/usr/bin/env python3
# Super-Brain 回归测试（入库版）：第6包 F1-F5、S4-0、第9包 T9-1/T9-2
# 用法：python3 90-System/runtime/tests/test_regression.py
# 全程临时库 + 临时目录，不触碰生产 state.db 与生产队列。
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RT))
import runtime            # noqa: E402
import orchestrator as oc  # noqa: E402
import messenger          # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (" | " + str(detail) if detail else ""))
    if not cond:
        FAILS.append(name)


def fresh():
    d = Path(tempfile.mkdtemp(prefix="sb-regress-"))
    conn = sqlite3.connect(str(d / "state.db"), timeout=10)
    runtime.migrate(conn)
    oc.ROOT = d
    oc.SUMMARY_DIR = d / "60-Outputs" / "orch"
    conn.execute("DELETE FROM registry")
    for name, loc, ref in (("DSH一号@主机", "云服务器", "dsh-chief"),
                           ("DSH二号@笔记本", "笔记本", "dsh2-chief"),
                           ("Trae@笔记本", "笔记本", "trae-chief")):
        conn.execute("INSERT INTO registry(name,kind,location,agent_ref,status,registered_at) "
                     "VALUES(?,'instance',?,?,'active',?)", (name, loc, ref, int(time.time())))
    conn.commit()
    return d, conn


def tick(conn):
    now = int(time.time())
    oc._consume_plans(conn, now)
    for (pid,) in conn.execute("SELECT plan_id FROM orch_plans WHERE status='running'"):
        oc._release_ready(conn, pid, now)
    oc._watch_children(conn, now)
    oc._summarize(conn, now)
    oc._consume_reviews(conn, now)
    oc._consume_cancels(conn, now)


def submit(conn, steps, text="测试", dedupe=None):
    args = {"text": text, "orchestrate": {"title": text, "mode": "all_required", "steps": steps}}
    if dedupe:
        args["dedupe_key"] = dedupe
    return runtime.chief_execute(conn, "muse-chief", "submit", args)


ST = lambda k, **kw: dict({"step_key": k, "to": "chat-worker", "type": "chat", "text": k}, **kw)


def test_f1_to_f5():
    d, conn = fresh()
    # F4
    r = submit(conn, [ST("a")], text="F4", dedupe="f4")
    pid = r["plan_id"]
    check("F4-1 submit 返回 plan_id", bool(pid) and pid.startswith("plan_"))
    tick(conn)
    row = conn.execute("SELECT plan_id FROM orch_plans WHERE root_event_id=?", (r["event_id"],)).fetchone()
    check("F4-2 引擎沿用预生成 plan_id", row and row[0] == pid)
    r2 = submit(conn, [ST("a")], text="F4", dedupe="f4")
    check("F4-3 幂等重放同号不新建",
          r2.get("plan_id") == pid and conn.execute("SELECT COUNT(*) FROM orch_plans").fetchone()[0] == 1)

    # F2 / S4-0
    rr = submit(conn, [dict(ST("A"), depends_on=["B"]), dict(ST("B"), depends_on=["A"])], text="环")
    tick(conn)
    s = runtime.chief_execute(conn, "muse-chief", "plan_status", {"plan_id": rr["plan_id"]})
    check("F2/S4-0 plan_id 查到环形拒因",
          s.get("rejected") and "环形依赖" in s.get("reason", ""), s.get("reason"))
    s2 = runtime.chief_execute(conn, "muse-chief", "plan_status", {"root_event_id": rr["event_id"]})
    check("F2/S4-0 root_event_id 结果一致", s2.get("reason") == s.get("reason"))

    # F1 + F3
    r = submit(conn, [ST("one"), dict(ST("two"), depends_on=["one"])], text="F1")
    pid1, eid1 = r["plan_id"], r["event_id"]
    tick(conn)
    st = runtime.chief_execute(conn, "muse-chief", "plan_status", {"plan_id": pid1})
    check("F1 计划含两步明细", len(st.get("plan", {}).get("steps") or []) == 2)
    check("F1 不存在计划报错",
          not runtime.chief_execute(conn, "muse-chief", "plan_status", {"plan_id": "plan_x"}).get("ok"))
    c = runtime.chief_execute(conn, "muse-chief", "plan_cancel", {"root_event_id": eid1})
    check("F3-1 取消受理", c.get("ok") and c.get("plan_id") == pid1)
    tick(conn)
    check("F3-2 计划 cancelled",
          conn.execute("SELECT status FROM orch_plans WHERE plan_id=?", (pid1,)).fetchone()[0] == "cancelled")
    check("F3-3 子任务取消",
          conn.execute("SELECT status FROM tasks WHERE id=(SELECT child_task_id FROM task_links "
                       "WHERE plan_id=? AND step_key='one')", (pid1,)).fetchone()[0] == "cancelled")
    c2 = runtime.chief_execute(conn, "muse-chief", "plan_cancel", {"plan_id": pid1})
    check("F3-4 终态计划拒绝取消", not c2.get("ok") and "终态" in c2.get("error", ""))

    # F5
    r = submit(conn, [ST("a"), dict(ST("b"), depends_on=["a"]), ST("c")], text="F5")
    pid5 = r["plan_id"]
    tick(conn)
    ta = conn.execute("SELECT child_task_id FROM task_links WHERE plan_id=? AND step_key='a'",
                      (pid5,)).fetchone()[0]
    res = d / "60-Outputs" / "results"
    res.mkdir(parents=True, exist_ok=True)
    (res / "task-a-结果.md").write_text("暗号：PURPLE-ELEPHANT-42\n", encoding="utf-8")
    conn.execute("UPDATE tasks SET status='done',done_at=?,result=? WHERE id=?",
                 (int(time.time()), "已交付 → 60-Outputs/results/task-a-结果.md", ta))
    conn.commit()
    tick(conn)
    pb = json.loads(conn.execute("SELECT t.payload FROM task_links l JOIN tasks t ON t.id=l.child_task_id "
                                 "WHERE l.plan_id=? AND l.step_key='b'", (pid5,)).fetchone()[0])
    up = pb.get("upstream_results") or []
    check("F5-1 下游带 upstream_results", up and up[0]["result_path"] == "60-Outputs/results/task-a-结果.md")
    check("F5-2 正文注入含上游摘要",
          pb.get("text", "").startswith("【系统注入】") and "PURPLE-ELEPHANT-42" in pb.get("text", ""))
    pc = json.loads(conn.execute("SELECT t.payload FROM task_links l JOIN tasks t ON t.id=l.child_task_id "
                                 "WHERE l.plan_id=? AND l.step_key='c'", (pid5,)).fetchone()[0])
    check("F5-3 零依赖步骤无注入", "upstream_results" not in pc)
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def _mk_assist(conn, to, text=None, created_ago=0, claimed=None, extra=None):
    _mk_assist.seq = getattr(_mk_assist, "seq", 0) + 1
    text = text or f"测试任务-{_mk_assist.seq}"       # (type,payload) 有唯一约束，文本须互异
    p = {"text": text, "to": to, "to_agent": {"DSH一号@主机": "dsh-chief",
                                               "DSH二号@笔记本": "dsh2-chief",
                                               "Trae@笔记本": "trae-chief"}.get(to, to), **(extra or {})}
    now = int(time.time())
    cur = conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,max_retries,created_at,claimed_at) "
        "VALUES(NULL,'assist',?,'pending',0,3,?,?)",
        (json.dumps(p, ensure_ascii=False), now - created_ago, claimed))
    conn.commit()
    return cur.lastrowid


def test_t91():
    d, conn = fresh()
    now = int(time.time())
    # 场景一：无在线兄弟 → 告警 + 直接死信
    t1 = _mk_assist(conn, "DSH一号@主机", created_ago=runtime.CLAIM_TIMEOUT + 60)
    runtime._claim_timeout_sweep(conn, now)
    st = conn.execute("SELECT status,error FROM tasks WHERE id=?", (t1,)).fetchone()
    alerts = conn.execute("SELECT COUNT(*) FROM tasks WHERE type='assist' AND payload LIKE '%认领超时告警%'").fetchone()[0]
    check("T9-1-1 无候选 → 死信", st[0] == "dead" and "认领超时" in (st[1] or ""), st)
    check("T9-1-2 无候选 → 已告警发起 chief", alerts >= 1, alerts)
    dead_alerts = conn.execute("SELECT COUNT(*) FROM tasks WHERE payload LIKE '%死信告警%'").fetchone()[0]
    check("T9-1-3 死信再次告警", dead_alerts >= 1, dead_alerts)

    # 场景二：有在线兄弟 → 改派一次，再超时 → 死信
    conn.execute("INSERT INTO heartbeats(agent,ts,note) VALUES('trae-chief',?,'active')", (now,))
    conn.commit()
    t2 = _mk_assist(conn, "DSH二号@笔记本", created_ago=runtime.CLAIM_TIMEOUT + 60)
    runtime._claim_timeout_sweep(conn, now)
    row = conn.execute("SELECT status,payload FROM tasks WHERE id=?", (t2,)).fetchone()
    p2 = json.loads(row[1])
    check("T9-1-4 有候选 → 改派一次保持 pending",
          row[0] == "pending" and p2.get("to_agent") == "trae-chief", (row[0], p2.get("to_agent")))
    runtime._claim_timeout_sweep(conn, now + runtime.CLAIM_TIMEOUT + 60)
    row2 = conn.execute("SELECT status,error FROM tasks WHERE id=?", (t2,)).fetchone()
    check("T9-1-5 改派后仍超时 → 死信", row2[0] == "dead" and "改派" in (row2[1] or ""), row2)

    # 场景三：豁免
    t3 = _mk_assist(conn, "DSH一号@主机", created_ago=99999,
                    extra={"no_claim_timeout": True})
    runtime._claim_timeout_sweep(conn, now)
    check("T9-1-6 no_claim_timeout 豁免",
          conn.execute("SELECT status FROM tasks WHERE id=?", (t3,)).fetchone()[0] == "pending")

    # 场景四：已认领过的 pending（reaper 回收）不受影响
    t4 = _mk_assist(conn, "DSH一号@主机", created_ago=99999, claimed=now - 5000)
    runtime._claim_timeout_sweep(conn, now)
    check("T9-1-7 已认领过的任务不误杀",
          conn.execute("SELECT status FROM tasks WHERE id=?", (t4,)).fetchone()[0] == "pending")

    # 场景五：未过期不动
    t5 = _mk_assist(conn, "DSH一号@主机", created_ago=10)
    runtime._claim_timeout_sweep(conn, now)
    check("T9-1-8 未超时任务不动",
          conn.execute("SELECT status FROM tasks WHERE id=?", (t5,)).fetchone()[0] == "pending")

    conn.close()
    shutil.rmtree(d, ignore_errors=True)


def test_t92():
    d, conn = fresh()
    qd = d / "queue"
    messenger.QUEUE_DIR = qd
    node = qd / "dsh2"
    (node / "results").mkdir(parents=True)
    now = int(time.time())
    tid = conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,max_retries,created_at) "
        "VALUES(NULL,'assist','{\"text\":\"已取消用例\"}','cancelled',0,3,?)", (now,)).lastrowid
    live = conn.execute(
        "INSERT INTO tasks(event_id,type,payload,status,priority,max_retries,created_at) "
        "VALUES(NULL,'assist','{\"text\":\"待办用例\"}','pending',0,3,?)", (now,)).lastrowid
    conn.commit()
    f_cancel = node / f"task-{tid}-已取消.md"
    f_live = node / f"task-{live}-待办.md"
    f_cancel.write_text("x", encoding="utf-8")
    f_live.write_text("y", encoding="utf-8")
    messenger._cleanup_cancelled(conn)
    check("T9-2-1 取消任务的文件挪入 done/",
          not f_cancel.exists() and (node / "done" / f_cancel.name).exists())
    check("T9-2-2 未取消任务文件保留", f_live.exists())
    conn.close()
    shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    test_f1_to_f5()
    test_t91()
    test_t92()
    print(f"\n== {len(FAILS)} 项失败 ==" if FAILS else "\n== 全部通过 ==")
    sys.exit(1 if FAILS else 0)
