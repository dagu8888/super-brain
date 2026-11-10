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

CREATE TABLE IF NOT EXISTS heartbeats(
  agent TEXT PRIMARY KEY, ts INTEGER, note TEXT
);

CREATE TABLE IF NOT EXISTS registry(
  name TEXT PRIMARY KEY,           -- 名册条目：实例（DSH一号@主机）或角色别名
  kind TEXT NOT NULL,              -- instance|worker|chief
  location TEXT,                   -- 实例所在机器（实例类用）
  agent_ref TEXT,                  -- 对应的 agents.agent_id
  status TEXT DEFAULT 'active',    -- active|retired（下线留档，不删记录）
  registered_at INTEGER
);

-- Orchestrator 中台三表（任务包第4包 S1；老表一列不改；逆迁移见 migrate_orch_rollback.sql）
CREATE TABLE IF NOT EXISTS orch_plans(
  plan_id TEXT PRIMARY KEY,
  root_event_id TEXT UNIQUE NOT NULL,   -- 防重闸：同一事件只许一份计划
  chief TEXT NOT NULL,                  -- 发起幕僚长
  canonical_user_id TEXT,               -- 归属用户（子任务入队沿用）
  title TEXT,
  mode TEXT DEFAULT 'all_required',     -- all_required|partial_ok
  status TEXT DEFAULT 'running',        -- running|awaiting_review|done|rework|failed|cancelled
  review_reason TEXT,                   -- reject 理由落库
  summary_path TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  done_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  child_task_id INTEGER,                -- 当前在执行的子任务（改派/返工时换绑）
  link_type TEXT DEFAULT 'child',       -- child 子任务（depends_on 以 JSON 列表达，语义同设计稿）
  depends_on TEXT DEFAULT '[]',         -- JSON：前置 step_key 列表
  target TEXT,                          -- 点名目标（worker type / 实例 / 幕僚长）
  task_type TEXT,
  payload TEXT,                         -- 子任务 payload JSON
  attempt INTEGER DEFAULT 1,            -- 1=首派 2=改派（D2 尺度）
  round INTEGER DEFAULT 1,              -- 返工轮次（plan_reject 后 +1，区分新旧子任务 payload）
  status TEXT DEFAULT 'waiting',        -- waiting|enqueued|terminal
  created_at INTEGER,
  UNIQUE(plan_id, step_key)             -- 防重复生成锚
);
CREATE INDEX IF NOT EXISTS idx_task_links_plan ON task_links(plan_id);

CREATE TABLE IF NOT EXISTS agent_caps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_ref TEXT NOT NULL,              -- registry/agents 条目
  capability TEXT NOT NULL,             -- 自由文本（新能力不改表）
  max_parallel INTEGER DEFAULT 1,
  note TEXT,
  UNIQUE(agent_ref, capability)
);

-- 实时消息总线 v1（不进 events 路由，不触发 LLM worker）
CREATE TABLE IF NOT EXISTS messages(
  msg_id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  from_instance TEXT,
  "to" TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  text TEXT NOT NULL,
  reply_to TEXT,
  thread_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_since ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to", created_at);
"""

# 内置角色注册（capabilities 以实际验证为准；trae-developer 未跑通探针前 verified=0）
# 七入口统一能力：七命令 + 协作池（pull 领取 / renew 续租 / report 回传 / assist 提交）
CHIEF_CAPS = ["submit", "status", "list", "progress", "delegate", "link", "cancel",
              "pull", "report", "renew", "assist", "kb_search", "kb_read", "heartbeat",
              "msg", "reply"]
BUILTIN_AGENTS = [
    # (agent_id, kind, capabilities, task_types, permissions, verified)
    ("grok-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("deepseek-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("maus-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("dsh-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("trae-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("maus2-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    ("dsh2-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
    # 2026-11-09 起入口不限数：随增随减、以真实注册为准；下线的入口留档（status='suspended'）
    ("muse-chief", "chief", CHIEF_CAPS, None, {"write": [], "exec": False, "llm": False}, 1),
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

CHIEF_SOURCES = ["grok", "deepseek", "maus", "dsh", "trae", "maus2", "dsh2", "muse"]
CANONICAL_USER = "dagu8888"  # 单用户系统：大古老师

# 实例名册种子（2026-11-09 任务包 T3）：实例 → 其幕僚长身份；下线改 status='retired' 留档
REGISTRY_SEED = [
    # (name, kind, location, agent_ref)
    ("DSH一号@主机", "instance", "云服务器", "dsh-chief"),
    ("DSH二号@笔记本", "instance", "笔记本", "dsh2-chief"),
    ("Trae@笔记本", "instance", "笔记本", "trae-chief"),
]


def migrate(conn):
    conn.executescript(SCHEMA_V2)
    try:
        import message_bus
        message_bus.ensure_schema(conn)
    except Exception:
        pass

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

    # 入口默认身份映射（未知 source_user 时运行时再兜底；入口随增随减，下线留档）
    for src in CHIEF_SOURCES:
        conn.execute(
            "INSERT OR IGNORE INTO user_identities(source,source_user,canonical_user_id) VALUES(?,?,?)",
            (src, CANONICAL_USER, CANONICAL_USER))

    # 实例名册种子（幂等；worker/chief 由 agents 表自动在册，无需重复登记）
    for name, kind, loc, ref in REGISTRY_SEED:
        conn.execute(
            "INSERT OR IGNORE INTO registry(name,kind,location,agent_ref,status,registered_at) "
            "VALUES(?,?,?,?,'active',?)", (name, kind, loc, ref, now))

    # agent_caps 首批数据（任务包第4包 S1-2）：Trae 按身份卡导入；DSH 占位待回执确认，不编造
    CAPS_SEED = [
        ("trae-chief", "代码施工", 1, "Trae 身份卡回执（2026-11-09 T1）"),
        ("trae-chief", "架构审计", 1, "同上"),
        ("trae-chief", "运维排障", 1, "同上；云服务器运维权限在 Trae"),
        ("trae-chief", "知识整理", 1, "同上"),
        ("trae-chief", "文档撰写", 1, "同上"),
        ("dsh-chief", "待回执确认", 1, "占位：能力待 DSH 回执确认，不编造"),
        ("dsh2-chief", "待回执确认", 1, "占位：能力待 DSH 回执确认，不编造"),
    ]
    for ref, cap, par, note in CAPS_SEED:
        conn.execute(
            "INSERT OR IGNORE INTO agent_caps(agent_ref,capability,max_parallel,note) VALUES(?,?,?,?)",
            (ref, cap, par, note))
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


