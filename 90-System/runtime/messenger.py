#!/usr/bin/env python3
# Super-Brain 节点信使（任务包第5包 S3）：队列写手 + 结果/ask 搬运，单线程三轮
# 约定（见 90-System/queue/README.md）：
#   queue/<节点>/task-<id>-<slug>.md   待办任务文件（写手落，幂等：按 id 查重）
#   queue/<节点>/results/task-<id>-*.md 节点执行结果（节点写回）
#   queue/<节点>/done/                  已归档任务文件
#   60-Outputs/results/                 收口后的结果存档
# 幂等：一切按任务 id/文件名查重；崩溃重启不重复派单、不重复收口。
import json
import re
import sqlite3
import threading
import time
from pathlib import Path

from runtime import log_event

HERE = Path(__file__).parent
ROOT = HERE.parents[1]
DB = HERE / "state.db"
CHAT_DIR = ROOT / "60-Outputs" / "chat"
RESULTS_DIR = ROOT / "60-Outputs" / "results"
QUEUE_DIR = ROOT / "90-System" / "queue"
INTERVAL = 10

_STOP = threading.Event()


def _db():
    conn = sqlite3.connect(DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _slug(text, n=30):
    s = re.sub(r"[^\w一-鿿-]+", "-", str(text or "")).strip("-")
    return (s[:n] or "task")


def _node_dir(agent_ref):
    """幕僚长/实例 ref → 队列目录名：trae-chief → trae；实例名 → @ 前小写。"""
    ref = str(agent_ref or "")
    if ref.endswith("-chief"):
        return ref[:-6]
    return ref.split("@")[0].lower() or "misc"


def _write_queue_files(conn, now):
    """待办写手：pending assist 且点名到具体执行方的任务 → queue/<节点>/ 任务文件。"""
    rows = conn.execute(
        "SELECT id,payload,created_at FROM tasks WHERE type='assist' AND status='pending'"
    ).fetchall()
    for tid, payload, created in rows:
        try:
            p = json.loads(payload or "{}")
        except Exception:
            continue
        to_agent = p.get("to_agent") or p.get("to")
        if not to_agent:
            continue
        node = _node_dir(to_agent)
        d = QUEUE_DIR / node
        # 幂等：任何以 task-<id>- 开头的文件（含 done/ 归档）都视为已写
        if d.exists() and (list(d.glob(f"task-{tid}-*.md")) or
                           list((d / "done").glob(f"task-{tid}-*.md") if (d / "done").exists() else [])):
            continue
        d.mkdir(parents=True, exist_ok=True)
        orch = p.get("orch") or {}
        title = _slug(p.get("text", ""), 24)
        body = [f"# 任务 #{tid}",
                "",
                f"- 类型：{p.get('kind', '协助')}",
                f"- 来自：{p.get('from', '?')}",
                f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(created or now))}"]
        if orch:
            body.append(f"- 编排：plan {orch.get('plan_id')} · 步骤 {orch.get('step_key')}"
                        f" · 第 {orch.get('round', 1)} 轮")
        body += ["", "## 内容", "", str(p.get("text", "")), "",
                 "---", "## 做完以后", "",
                 f"把结果写到本目录 results/task-{tid}-结果.md（一段话说清结果即可），",
                 "大脑的信使会自动收口、归档并推进后续步骤。"]
        f = d / f"task-{tid}-{title}.md"
        tmp = f.with_suffix(".md.tmp")
        tmp.write_text("\n".join(body) + "\n", encoding="utf-8")
        tmp.rename(f)
        log_event("messenger_queue_written", task=tid, node=node, file=f.name)


def _collect_results(conn, now):
    """结果收口：results/task-<id>-*.md → 任务 done + 结果归档 + 任务文件归档。"""
    if not QUEUE_DIR.exists():
        return
    for d in QUEUE_DIR.iterdir():
        res = d / "results"
        if not d.is_dir() or not res.exists():
            continue
        for f in res.glob("task-*-*.md"):
            m = re.match(r"task-(\d+)-", f.name)
            if not m:
                continue
            tid = int(m.group(1))
            row = conn.execute(
                "SELECT status FROM tasks WHERE id=? AND type='assist'", (tid,)).fetchone()
            if not row or row[0] != "pending":
                # 已收口过的残留文件：挪走防重复处理
                stale = RESULTS_DIR / f.name
                RESULTS_DIR.mkdir(parents=True, exist_ok=True)
                try:
                    f.replace(stale)
                except OSError:
                    pass
                continue
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
            dest = RESULTS_DIR / f.name
            f.replace(dest)                       # 先挪走（幂等锚：文件消失=已处理）
            conn.execute(
                "UPDATE tasks SET status='done', result=?, done_at=? WHERE id=? AND status='pending'",
                (f"已交付 → 60-Outputs/results/{f.name}", now, tid))
            conn.commit()
            for old in list(d.glob(f"task-{tid}-*.md")):
                (d / "done").mkdir(exist_ok=True)
                try:
                    old.replace(d / "done" / old.name)
                except OSError:
                    pass
            log_event("messenger_result_collected", task=tid, node=d.name, file=f.name)


_ASK_RE = re.compile(r'\{[^{}]*"ask"\s*:\s*\[', re.S)


def _extract_ask(text):
    """从 chat 结果 md 里找 Autoloop 式收尾标记 { "ask": [...] }，返回 (ask列表, 上下文)。"""
    m = _ASK_RE.search(text)
    if not m:
        return None, ""
    try:
        obj, _ = json.JSONDecoder().raw_decode(text, m.start())
    except Exception:
        return None, ""
    asks = obj.get("ask") if isinstance(obj, dict) else None
    if not isinstance(asks, list) or not asks:
        return None, ""
    ctx = text[:m.start()].strip()[-400:]
    return asks, ctx


def _move_asks(conn, now):
    """ask 搬运：chat 结果文件含 {"ask":...} → assist 任务给原发起者 + 文件归档 results/。"""
    if not CHAT_DIR.exists():
        return
    for f in sorted(CHAT_DIR.glob("*.md")):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")[:20000]
        except Exception:
            continue
        asks, ctx = _extract_ask(text)
        if not asks:
            continue
        # 溯源：哪个任务产出了这个文件 → 事件 → 原发起 chief
        src = conn.execute(
            "SELECT e.source FROM tasks t JOIN events e ON t.event_id=e.event_id "
            "WHERE t.result LIKE ? ORDER BY t.id DESC LIMIT 1", (f"%{f.name}%",)).fetchone()
        to_agent = src[0] if src else None
        if not to_agent:
            continue                            # 找不到主，宁留文件不瞎派
        titles = "；".join(str(a.get("title") or a.get("text") or "?")[:40]
                          for a in asks if isinstance(a, dict)) or "有待拍板"
        payload = {"kind": "拍板", "from": "结果信使", "to": to_agent, "to_agent": to_agent,
                   "text": f"任务结果需要你拍板：{titles}\n来源文件：60-Outputs/results/{f.name}\n"
                           f"上下文：{ctx[-200:]}",
                   "asks": asks, "source_file": f.name}
        cur = conn.execute(
            "INSERT OR IGNORE INTO tasks(event_id,type,payload,status,priority,max_retries,created_at) "
            "VALUES(NULL,'assist',?,'pending',1,3,?)",
            (json.dumps(payload, ensure_ascii=False), now))
        conn.commit()
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            f.replace(RESULTS_DIR / f.name)     # 幂等锚：文件消失=已搬运
        except OSError:
            pass
        if cur.rowcount:
            log_event("messenger_ask_moved", file=f.name, to=to_agent, asks=len(asks))


def messenger_loop():
    while not _STOP.is_set():
        try:
            now = int(time.time())
            conn = _db()
            try:
                _write_queue_files(conn, now)
                _collect_results(conn, now)
                _move_asks(conn, now)
            finally:
                conn.close()
        except Exception as e:
            log_event("messenger_tick_error", error=str(e)[:200])
        _STOP.wait(INTERVAL)


if __name__ == "__main__":
    messenger_loop()
