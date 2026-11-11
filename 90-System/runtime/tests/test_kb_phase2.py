#!/usr/bin/env python3
# 第二阶段回归：遮蔽 / 检索范围 / 拒答 / 受保护目录 / 在线状态提示限频 / 入库闸门
# 用法：python3 90-System/runtime/tests/test_kb_phase2.py   （临时库 + 临时索引，不碰生产 state.db）
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

RT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RT))
os.environ["KB_INDEX_PATH"] = str(Path(tempfile.mkdtemp(prefix="sb-kbidx-")) / "idx.db")
import kb_engine        # noqa: E402
import presence_notify  # noqa: E402
import kb_intake        # noqa: E402
from path_guard import PathGuard, PermissionDenied  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (" | " + str(detail) if detail else ""))
    if not cond:
        FAILS.append(name)


# 1 遮蔽
fake = "登录 密码：Abc12345xyz 其它 a@b.com----Pw998877 激活码：ZZXXCCVV1122 token ghp_" + "a" * 30
red = kb_engine.redact(fake)
check("redact 密码", "Abc12345xyz" not in red and "密码：（已遮蔽）" in red)
check("redact 账号----密码", "Pw998877" not in red)
check("redact 激活码/gh token", "ZZXXCCVV1122" not in red and "ghp_aaaa" not in red)
check("redact 占位符不重复遮蔽", kb_engine.redact("密码：（凭据已移除，见口令包）") == "密码：（凭据已移除，见口令包）")

# 2 语料只含 git 跟踪的 md，排除队列/事件
files = kb_engine.corpus_files()
check("corpus 非空", len(files) > 50, len(files))
check("corpus 只含 .md", all(f.endswith(".md") for f in files))
check("corpus 不含 queue/events", not any(f.startswith(("90-System/queue/", "50-Events/")) for f in files))

# 3 两种引擎可用；无关查询 hybrid 拒答
r = kb_engine.kb_search({"q": "kb_search", "engine": "legacy"})
check("legacy 有结果", r["ok"] and r["count"] > 0, r.get("count"))
r = kb_engine.kb_search({"q": "超级大脑 网关 端口", "engine": "hybrid"})
check("hybrid 有结果且带状态字段", r["ok"] and r["count"] > 0 and "status" in r["hits"][0], r.get("count"))
r = kb_engine.kb_search({"q": "火星殖民飞船的燃料配方", "engine": "hybrid"})
check("hybrid 库外问题拒答", r["ok"] and r["count"] == 0 and r.get("refused"), r.get("note"))
check("空查询报错", not kb_engine.kb_search({"q": ""})["ok"])

# 4 受保护目录
c = sqlite3.connect(":memory:")
c.execute("CREATE TABLE agents(agent_id TEXT, permissions TEXT)")
c.execute("CREATE TABLE perm_audit(ts,agent,path,action,allowed)")
c.execute("INSERT INTO agents VALUES('w1', ?)", ('{"write": ["90-System/", "60-Outputs/"]}',))
g = PathGuard(c, "w1")
try:
    g.check_write("90-System/runtime/x.txt")
    check("受保护目录拒写（即使 allowlist 放行）", False)
except PermissionDenied:
    check("受保护目录拒写（即使 allowlist 放行）", True)
try:
    g.check_write("60-Outputs/tmp-test.md")
    check("普通目录照常放行", True)
except PermissionDenied:
    check("普通目录照常放行", False)

# 5 在线状态提示：只在翻转时发、限频、启动宽限期静默
c = sqlite3.connect(":memory:")
c.execute("CREATE TABLE heartbeats(agent TEXT PRIMARY KEY, ts INTEGER, note TEXT)")
sent = []
post = lambda conn, frm, text, to, kind: sent.append(text) or {"ok": True}  # noqa: E731
presence_notify._started = 0                   # 跳过启动宽限期
T = 1_800_000_000
c.execute("INSERT INTO heartbeats VALUES('a', ?, '')", (T,))
c.execute("INSERT INTO heartbeats VALUES('router', ?, '')", (T - 99999,))
presence_notify.check(c, now=T + 10, post=post)
check("首次见到只同步不发", len(sent) == 0)
presence_notify.check(c, now=T + 1000, post=post)        # 超 900s → 离线
check("离线翻转发 1 条", len(sent) == 1 and "离线" in sent[0], sent)
for k in range(20):
    presence_notify.check(c, now=T + 1000 + k * 10, post=post)
check("持续离线不重复发", len(sent) == 1, len(sent))
c.execute("UPDATE heartbeats SET ts=? WHERE agent='a'", (T + 1100,))
presence_notify.check(c, now=T + 1110, post=post)
check("30 分钟内恢复不立即发（限频）", len(sent) == 1, len(sent))
c.execute("UPDATE heartbeats SET ts=? WHERE agent='a'", (T + 2900,))
presence_notify.check(c, now=T + 2905, post=post)
check("限频到期补发恢复在线", len(sent) == 2 and "恢复在线" in sent[1], sent[-1:])
check("router 被忽略", not any("router" in s for s in sent))

# 6 入库闸门：非审批人不能 promote；越界路径拒绝
r = kb_intake.promote(None, "maus-chief", {"path": "10-Knowledge/_staging/x.md"})
check("非审批人 promote 被拒", not r["ok"], r.get("error"))
r = kb_intake.promote(None, "grok-chief", {"path": "10-Knowledge/Decisions/../../README.md"})
check("暂存区外路径 promote 被拒", not r["ok"], r.get("error"))
check("heartbeat_lost 视为例行日志", kb_intake.is_routine("heartbeat_lost"))

print("\n" + ("ALL PASS" if not FAILS else f"FAILED: {FAILS}"))
sys.exit(1 if FAILS else 0)
