#!/usr/bin/env python3
# Super-Brain DB Schema v1 → v2 迁移脚本
# 依据《2026-11-08-V2-核心设计书》§6 + 修订 R1（agents / user_identities / canonical_user_id）
# 特性：先备份、可重复执行（幂等）、保留 task_queue_v1 可回滚
# 用法: python3 migrate_v2.py [--db 路径]   （默认取本脚本同目录 state.db）
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
DB = HERE / "state.db"

SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- inbox|cron|watchdog|webhook|user|agent
  type TEXT NOT NULL,                -- inbox_note|kb_change|heartbeat_lost|manual|...
  payload TEXT NOT NULL DEFAULT '{}',
  priority INTEGER DEFAULT 0,        -- 0普通 1高 2紧急
  dedupe_key TEXT UNIQUE,            -- 幂等键
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',-- new|filtered|routed|done|dead
  canonical_user_id TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_pick ON events(status, priority, created_at);

CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|doing|done|failed|dead|cancelled
  priority INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  not_before INTEGER,
  lease_owner TEXT,
  lease_token INTEGER DEFAULT 0,     -- fencing token，每次领取+1
  lease_expires_at INTEGER,
  canonical_user_id TEXT,
  created_at INTEGER, claimed_at INTEGER, done_at INTEGER,
  result TEXT, error TEXT,
  UNIQUE(type, payload)
);
CREATE INDEX IF NOT EXISTS idx_tasks_pick ON tasks(status, type, priority, id);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS sessions(
  thread_id TEXT PRIMARY KEY,
  worker TEXT,
  state_json TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS agents(
  agent_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- chief|worker
  capabilities TEXT NOT NULL,        -- JSON 数组
  task_types TEXT,                   -- JSON 数组，worker 可领取类型；chief 为 NULL
  permissions TEXT NOT NULL,         -- JSON，PathGuard 规则引用
  verified INTEGER DEFAULT 0,        -- 0未验证 1已验证
  status TEXT DEFAULT 'active',      -- active|suspended
  registered_at INTEGER, last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS user_identities(
  source TEXT NOT NULL,
  source_user TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  PRIMARY KEY(source, source_user)
);

CREATE TABLE IF NOT EXISTS perm_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, agent TEXT, path TEXT, action TEXT, allowed INTEGER
);
"""

# 内置角色注册（capabilities 以实际验证为准；trae-developer 未跑通探针前 verified=0）
# 七入口统一能力：七命令 + 协作池（pull 领取 / renew 续租 / report 回传 / assist 提交）
CHIEF_CAPS = ["submit", "status", "list", "progress", "delegate", "link", "cancel",
              "pull", "report", "renew", "assist"]
BUILTIN_AGENTS = [
    # (agent_id, kind, capabilities, task_types, permissions, verified)
    ("grok-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("deepseek-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("maus-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("dsh-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("trae-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("maus2-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("dsh2-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("knowledge-worker", "worker", ["inbox-triage", "kb-organize"], ["inbox-triage", "kb-organize"],
     {"write": ["00-Inbox/", "10-Knowledge/", "30-Reviews/"], "exec": False, "llm": True}, 1),
    ("chat-worker", "worker", ["chat"], ["chat"],
     {"write": ["00-Inbox/", "60-Outputs/"], "exec": False, "llm": True}, 1),
    ("code-worker", "worker", ["code-review", "ci-analysis"], ["code-review", "ci-analysis"],
     {"write": ["60-Outputs/", "50-Events/"], "exec": False, "llm": True}, 1),
    ("research-worker", "worker", ["research"], ["research"],
     {"write": ["60-Outputs/"], "exec": False, "llm": True}, 1),
    ("trae-developer", "worker", ["code-dev", "arch-review", "tech-doc", "code-test"],
     ["code-dev", "arch-review", "tech-doc", "code-test", "probe"],
     {"write": ["60-Outputs/", "30-Reviews/"], "exec": False, "llm": True}, 0),
    # 2026-11-08 口径「7 入口 + 7 执行 agent」：新增两个执行者，复用已验证处理器
    ("analysis-worker", "worker", ["research"], ["research"],
     {"write": ["60-Outputs/"], "exec": False, "llm": True}, 1),
    ("archive-worker", "worker", ["kb-organize", "inbox-triage"], ["kb-organize", "inbox-triage"],
     {"write": ["00-Inbox/", "10-Knowledge/", "30-Reviews/"], "exec": False, "llm": True}, 1),
]

CHIEF_SOURCES = ["grok", "deepseek", "maus", "dsh", "trae", "maus2", "dsh2"]
CANONICAL_USER = "dagu8888"  # 单用户系统：大古老师


def migrate(conn):
    conn.executescript(SCHEMA_V2)

    # task_queue → tasks（状态 doing 重置为 pending；结果/错误映射）
    has_old = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_queue'").fetchone()
    if has_old:
        n = conn.execute(
            """INSERT OR IGNORE INTO tasks
               (type, payload, status, priority, retry_count, created_at, done_at, result, error,
                lease_token, max_retries, canonical_user_id)
               SELECT type, payload,
                      CASE status WHEN 'doing' THEN 'pending' WHEN 'failed' THEN 'failed' ELSE status END,
                      0, 0, created_at, done_at, result,
                      CASE WHEN status='failed' THEN result ELSE NULL END,
                      0, 3, ?
               FROM task_queue""", (CANONICAL_USER,)).rowcount
        conn.execute("ALTER TABLE task_queue RENAME TO task_queue_v1")
        print(f"迁移 task_queue → tasks：{n} 条（原表已改名 task_queue_v1，可回滚）")
    else:
        print("无 task_queue 表（或已迁移过），跳过数据迁移")

    # 注册内置角色
    now = int(time.time())
    for aid, kind, caps, ttypes, perms, verified in BUILTIN_AGENTS:
        conn.execute(
            """INSERT INTO agents(agent_id,kind,capabilities,task_types,permissions,verified,status,registered_at,last_seen)
               VALUES(?,?,?,?,?,?,'active',?,?)
               ON CONFLICT(agent_id) DO UPDATE SET
                 capabilities=excluded.capabilities, task_types=excluded.task_types,
                 permissions=excluded.permissions""",
            (aid, kind, json.dumps(caps, ensure_ascii=False),
             json.dumps(ttypes) if ttypes else None,
             json.dumps(perms, ensure_ascii=False), verified, now, now))

    # 五入口默认身份映射（未知 source_user 时运行时再兜底）
    for src in CHIEF_SOURCES:
        conn.execute(
            "INSERT OR IGNORE INTO user_identities(source,source_user,canonical_user_id) VALUES(?,?,?)",
            (src, CANONICAL_USER, CANONICAL_USER))
    conn.commit()


def main():
    db_path = Path(sys.argv[sys.argv.index("--db") + 1]) if "--db" in sys.argv else DB
    if db_path.exists():
        bak = db_path.with_suffix(f".bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(db_path, bak)
        print(f"已备份：{bak.name}")
    conn = sqlite3.connect(db_path, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    migrate(conn)
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    counts = {t: conn.execute(f"SELECT COUNT(*) FROM [{t}]").fetchone()[0]
              for t in ("events", "tasks", "agents", "user_identities") if t in tables}
    print("表：", ", ".join(tables))
    print("行数：", counts)
    conn.close()
    print("MIGRATE_V2_OK")


if __name__ == "__main__":
    sys.exit(main())
