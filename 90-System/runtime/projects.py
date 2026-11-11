#!/usr/bin/env python3
# 项目维度：projects / project_phases / project_links。
# 完成度 = 已验收且已核实的阶段数 / 阶段总数；「未核实」的验收单列，不计入百分比。不编数据。
# 写入：大古（dagu-owner）与指挥官（grok-chief）可建项目、改阶段、验收；其他 Agent 只读。
import json
import re
import time

EDITORS = ("dagu-owner", "grok-chief")
PHASE_STATES = ("pending", "in_progress", "blocked", "accepted")
SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT,
  agents TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  constraints TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS project_phases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  deliverable TEXT,
  acceptance TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  verified INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  blocker TEXT,
  started_at INTEGER,
  accepted_at INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  UNIQUE(project_id, seq)
);
CREATE TABLE IF NOT EXISTS project_links(
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, kind, ref)
);
"""

# 种子：只放可核实的事实；时间均为北京时间。拿不到证据的标 verified=0（未核实）。
SEED = [
    {"id": "super-brain-net", "name": "Super-Brain 协作网", "owner": "dagu-owner",
     "agents": ["grok-chief", "dsh-chief", "dsh2-chief", "maus-chief", "maus2-chief", "muse-chief"],
     "constraints": "写入需鉴权；不动 8810；不擅自启动 OpenMaus / Trae",
     "summary": "多 Agent 经香港中台互通、可视化操作台、可下指令并回执",
     "phases": [
         ("消息总线 v1", "msg/reply/SSE/rollcall", "Agent 经中台实时双向收发", "accepted", 1,
          "GitHub PR #3 合并于 2026-11-10 20:47（北京时间）"),
         ("操作台 v1", "真实在线状态 + 轨迹抽屉", "上线可打开", "accepted", 1,
          "GitHub PR #2 合并于 2026-11-10 18:40（北京时间）"),
         ("https 正式入口", "console.8.218.106.225.nip.io + Let's Encrypt", "https 页面与接口 200", "accepted", 1,
          "证书有效至 2027-02-09；2026-11-11 11:49 核验 200"),
         ("各 Agent 回 1 验收", "点名全员回复", "在册节点全部回 1", "in_progress", 1,
          "点名 msg_20261110_126eb1（2026-11-10 23:03 北京时间）：4/7 节点回 1（DSH二号、MAUS二号、Muse、MAUS1号），其余未回"),
         ("Agent 层执行", "收到指令后真实执行并交回结果", "MAUS/DSH 各完成一单真实执行", "pending", 1,
          "尚未接执行口令（截至 2026-11-11）"),
         ("操作台 v2", "3D 协作网 + 操作层 + 指挥官对话", "大古手机可用并能下指令", "in_progress", 1,
          "PR #4、#5 已合并上线（2026-11-11 12:38）；操作层进行中"),
     ]},
    {"id": "xauusd-desk", "name": "XAUUSD 研判台", "owner": "dagu-owner", "agents": ["grok-chief"],
     "constraints": "只做研判，禁止实盘下单",
     "summary": "黄金每日研判；规矩 v0 + 定时任务",
     "phases": [
         ("v0 规矩", "研判规矩文档", "大古批准", "accepted", 0, "据幕僚长记录已批；控制台未核实（待补证据链接）"),
         ("三条定时任务", "定时研判 routine", "三条定时已建并能触发", "accepted", 0, "据幕僚长记录已建；控制台未核实"),
         ("每日研判运行", "每日研判输出", "连续运行并留档", "in_progress", 0, "据幕僚长记录运行中；控制台未核实"),
     ]},
]


def _now():
    return int(time.time())


def ensure_schema(conn, seed=True):
    conn.executescript(SCHEMA)
    for col, typ in (("project_id", "TEXT"),):
        cols = [r[1] for r in conn.execute("PRAGMA table_info(approvals)")]
        if cols and col not in cols:
            conn.execute("ALTER TABLE approvals ADD COLUMN %s %s" % (col, typ))
    if seed and not conn.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
        now = _now()
        for p in SEED:
            conn.execute("INSERT OR IGNORE INTO projects(id,name,owner,agents,status,constraints,summary,created_at,updated_at,updated_by) "
                         "VALUES(?,?,?,?,'active',?,?,?,?,'seed')",
                         (p["id"], p["name"], p["owner"], json.dumps(p["agents"]), p["constraints"], p["summary"], now, now))
            for i, (name, deli, acc, st, ver, ev) in enumerate(p["phases"], 1):
                conn.execute("INSERT OR IGNORE INTO project_phases(project_id,seq,name,deliverable,acceptance,status,verified,evidence,"
                             "accepted_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,'seed')",
                             (p["id"], i, name, deli, acc, st, ver, ev, now if st == "accepted" else None, now))
        conn.commit()


def _phases(conn, pid):
    keys = ("id", "seq", "name", "deliverable", "acceptance", "status", "verified", "evidence", "blocker",
            "started_at", "accepted_at", "updated_at", "updated_by")
    return [dict(zip(keys, r)) for r in conn.execute(
        "SELECT " + ",".join(keys) + " FROM project_phases WHERE project_id=? ORDER BY seq", (pid,))]


def summarize(conn, p):
    ph = _phases(conn, p["id"])
    total = len(ph)
    acc_v = sum(1 for x in ph if x["status"] == "accepted" and x["verified"])
    acc_u = sum(1 for x in ph if x["status"] == "accepted" and not x["verified"])
    cur = next((x for x in ph if x["status"] != "accepted"), None)
    blocked = [x for x in ph if x["status"] == "blocked" or (x["blocker"] or "").strip()]
    pend = 0
    try:
        pend = conn.execute("SELECT COUNT(*) FROM approvals WHERE status='pending' AND project_id=?", (p["id"],)).fetchone()[0]
    except Exception:
        pass
    links = [dict(zip(("kind", "ref", "created_at"), r)) for r in conn.execute(
        "SELECT kind,ref,created_at FROM project_links WHERE project_id=? ORDER BY created_at DESC LIMIT 50", (p["id"],))]
    try:
        agents = json.loads(p.get("agents") or "[]")
    except Exception:
        agents = []
    return {**p, "agents": agents, "phases": ph, "phase_total": total,
            "accepted_verified": acc_v, "accepted_unverified": acc_u,
            "completion": round(acc_v * 100 / total) if total else 0,
            "completion_incl_unverified": round((acc_v + acc_u) * 100 / total) if total else 0,
            "current_phase": cur, "blocked": [{"seq": x["seq"], "name": x["name"], "blocker": x["blocker"]} for x in blocked],
            "pending_approvals": pend, "links": links}


def list_projects(conn):
    ensure_schema(conn)
    keys = ("id", "name", "owner", "agents", "status", "constraints", "summary", "created_at", "updated_at", "updated_by")
    rows = [dict(zip(keys, r)) for r in conn.execute("SELECT " + ",".join(keys) + " FROM projects ORDER BY created_at, id")]
    return [summarize(conn, p) for p in rows]


def owner_write(conn, actor, action, args):
    if actor not in EDITORS:
        return {"ok": False, "error": "只有大古和指挥官（grok-chief）可以编辑项目"}
    ensure_schema(conn)
    now = _now()
    args = args or {}
    if action == "project_upsert":
        pid = str(args.get("id") or "").strip()
        name = str(args.get("name") or "").strip()[:80]
        if not re.match(r"^[a-z0-9][a-z0-9-]{1,40}$", pid):
            return {"ok": False, "error": "项目 id：小写字母/数字/-，2-41 位"}
        row = conn.execute("SELECT name FROM projects WHERE id=?", (pid,)).fetchone()
        if not row and not name:
            return {"ok": False, "error": "新建项目必带 name"}
        agents = args.get("agents")
        if agents is not None and (not isinstance(agents, list) or not all(isinstance(x, str) for x in agents)):
            return {"ok": False, "error": "agents 必须是字符串数组"}
        if row:
            sets, vals = [], []
            for k in ("name", "owner", "status", "constraints", "summary"):
                if args.get(k) is not None:
                    sets.append(k + "=?"); vals.append(str(args[k])[:500])
            if agents is not None:
                sets.append("agents=?"); vals.append(json.dumps(agents[:30]))
            sets += ["updated_at=?", "updated_by=?"]; vals += [now, actor, pid]
            conn.execute("UPDATE projects SET " + ",".join(sets) + " WHERE id=?", vals)
        else:
            conn.execute("INSERT INTO projects(id,name,owner,agents,status,constraints,summary,created_at,updated_at,updated_by) "
                         "VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (pid, name, str(args.get("owner") or "dagu-owner"), json.dumps((agents or [])[:30]),
                          str(args.get("status") or "active"), str(args.get("constraints") or "")[:500],
                          str(args.get("summary") or "")[:500], now, now, actor))
        conn.commit()
        return {"ok": True, "project_id": pid, "created": not row}
    pid = str(args.get("project_id") or "").strip()
    if not conn.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone():
        return {"ok": False, "error": f"项目 {pid} 不存在"}
    if action == "phase_upsert":
        try:
            seq = int(args.get("seq"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "缺阶段序号 seq"}
        st = args.get("status")
        if st is not None and st not in PHASE_STATES:
            return {"ok": False, "error": "status 只能是 " + "/".join(PHASE_STATES)}
        if st == "accepted":
            return {"ok": False, "error": "验收请用 phase_accept（必须附证据）"}
        row = conn.execute("SELECT id,status FROM project_phases WHERE project_id=? AND seq=?", (pid, seq)).fetchone()
        if row:
            sets, vals = [], []
            for k in ("name", "deliverable", "acceptance", "evidence", "blocker"):
                if args.get(k) is not None:
                    sets.append(k + "=?"); vals.append(str(args[k])[:1000])
            if st:
                sets.append("status=?"); vals.append(st)
                if st == "in_progress":
                    sets.append("started_at=COALESCE(started_at,?)"); vals.append(now)
                if row[1] == "accepted":
                    sets += ["accepted_at=NULL", "verified=0"]
            sets += ["updated_at=?", "updated_by=?"]; vals += [now, actor, row[0]]
            conn.execute("UPDATE project_phases SET " + ",".join(sets) + " WHERE id=?", vals)
        else:
            name = str(args.get("name") or "").strip()
            if not name:
                return {"ok": False, "error": "新阶段必带 name"}
            conn.execute("INSERT INTO project_phases(project_id,seq,name,deliverable,acceptance,status,evidence,blocker,started_at,updated_at,updated_by) "
                         "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (pid, seq, name[:120], str(args.get("deliverable") or "")[:1000], str(args.get("acceptance") or "")[:1000],
                          st or "pending", str(args.get("evidence") or "")[:1000], str(args.get("blocker") or "")[:1000],
                          now if st == "in_progress" else None, now, actor))
        conn.execute("UPDATE projects SET updated_at=?, updated_by=? WHERE id=?", (now, actor, pid))
        conn.commit()
        return {"ok": True, "project_id": pid, "seq": seq}
    if action == "phase_accept":
        try:
            seq = int(args.get("seq"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "缺阶段序号 seq"}
        ev = str(args.get("evidence") or "").strip()
        if len(ev) < 4:
            return {"ok": False, "error": "验收必须附证据（链接、PR、截图路径或核验记录）"}
        n = conn.execute("UPDATE project_phases SET status='accepted', verified=1, evidence=?, blocker=NULL, accepted_at=?, "
                         "updated_at=?, updated_by=? WHERE project_id=? AND seq=?",
                         (ev[:1000], now, now, actor, pid, seq)).rowcount
        conn.commit()
        if not n:
            return {"ok": False, "error": "阶段不存在"}
        return {"ok": True, "project_id": pid, "seq": seq, "accepted": True}
    return {"ok": False, "error": "未知项目操作"}
