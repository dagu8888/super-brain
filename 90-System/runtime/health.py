#!/usr/bin/env python3
# Watchdog v2 系统级巡检（设计书 §7）：七项检查，A/B/C 分级动作
# 用法: python3 health.py        建议 cron 每 10 分钟（只读 DB + 系统指标；A 级自动回收已含）
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
DB = HERE / "state.db"
ROOT = HERE.parents[1]
EVENTS_DIR = ROOT / "50-Events"

DEAD_LINE = 15 * 60          # 心跳判死 15min
BACKLOG_N = 20               # 队列积压阈值
BACKLOG_AGE = 30 * 60        # 最老 pending 阈值
DISK_PCT = 85
MEM_MB = 150


def log(kind, **fields):
    EVENTS_DIR.mkdir(exist_ok=True)
    with open(EVENTS_DIR / f"health-{time.strftime('%Y-%m-%d')}.jsonl", "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                            "kind": kind, **fields}, ensure_ascii=False) + "\n")


def main():
    if not DB.exists():
        print("HEALTH_SKIP: state.db 不存在")
        return 0
    conn = sqlite3.connect(DB, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    now = int(time.time())
    alerts, actions = [], []

    # 1. Worker 心跳（B 级：登记由 Supervisor 重启；连续失败由人工看 health 日志）
    stale = [r for r in conn.execute(
        "SELECT agent_id,last_seen FROM agents WHERE status='active' AND kind='worker' "
        "AND (last_seen IS NULL OR last_seen<?)", (now - DEAD_LINE,))]
    if stale:
        alerts.append(f"B:心跳超时 {[a for a, _ in stale]}")

    # 2. 卡 doing/租约过期（A 级：自动回收；fencing 保护旧 Worker 提交）
    cur = conn.execute(
        "UPDATE tasks SET status='pending', lease_owner=NULL, lease_expires_at=NULL "
        "WHERE status='doing' AND lease_expires_at<?", (now,))
    conn.commit()
    if cur.rowcount:
        actions.append(f"A:回收过期租约 {cur.rowcount} 条")

    # 3. 队列积压（C 级告警）
    backlog = conn.execute("SELECT COUNT(*), MIN(created_at) FROM tasks WHERE status='pending'").fetchone()
    if backlog[0] > BACKLOG_N or (backlog[1] and now - backlog[1] > BACKLOG_AGE):
        alerts.append(f"C:队列积压 pending={backlog[0]} 最老{(now - (backlog[1] or now)) // 60}min")

    # 4. LLM 可用性（C 级：近 10min 有 LLM 错误事件）
    evf = EVENTS_DIR / f"runtime-{time.strftime('%Y-%m-%d')}.jsonl"
    llm_fail = 0
    if evf.exists():
        for line in evf.read_text(encoding="utf-8", errors="replace").splitlines()[-500:]:
            try:
                e = json.loads(line)
                if e.get("kind") == "task_retry" and "LLM" in str(e.get("error", "")):
                    llm_fail += 1
            except Exception:
                pass
    if llm_fail >= 2:
        alerts.append(f"C:LLM 连续失败 {llm_fail} 次")

    # 5. 磁盘（C 级）
    usage = shutil.disk_usage(ROOT)
    if usage.used * 100 / usage.total > DISK_PCT:
        alerts.append(f"C:磁盘占用 {usage.used * 100 // usage.total}%")

    # 6. 内存（C 级）
    try:
        meminfo = Path("/proc/meminfo").read_text()
        avail = int(next(l.split()[1] for l in meminfo.splitlines() if l.startswith("MemAvailable"))) // 1024
        if avail < MEM_MB:
            alerts.append(f"C:可用内存 {avail}MB")
    except Exception:
        pass

    # 7. 死信（C 级：需人工）
    dead = conn.execute("SELECT COUNT(*) FROM tasks WHERE status='dead'").fetchone()[0]
    if dead:
        alerts.append(f"C:死信 {dead} 条待人工处理")

    log("health_check", alerts=alerts, actions=actions)
    conn.close()
    if alerts or actions:
        print("HEALTH_NOTE: " + " | ".join(actions + alerts))
    else:
        print("HEALTH_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
