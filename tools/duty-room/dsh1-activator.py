#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH一号@主机 自唤醒执行插件（activator）—— 把「有新任务」变成「自动开工」。

链路（零 LLM、零网关轮询）：
  courier(SSE 长连) 落队列文件 → 本插件监听 queue/dsh/ 新任务文件
  → /cmd status 验状态（纪律1：cancelled 不执行）→ 拉起 dsh headless 干活会话
  → 会话写 results/task-<id>-结果.md → 本插件 git add -f + commit + push 上云
  → hk-server 定时同步 → 服务端信使收口。

纪律（施工单 #334，Muse 下发）：
  1) 执行前经网关验任务状态，cancelled 的不执行；
  2) 只动本节点队列 queue/dsh/，不碰其他节点；
  3) 不碰服务器运行时（90-System/runtime 只读参照）；
  4) 凭据只走环境变量 SB_TOKEN（chief，机器级），绝不写文件/日志/仓库。

防重复执行（三层）：
  A. 状态文件 %USERPROFILE%/dsh1-activator-state.json：finished/in-flight 按任务 id 登记；
  B. results/task-<id>-*.md 已存在即视为已交付（服务端收口锚点）；
  C. 执行锁 90-System/queue/dsh/.activator/<id>.lock（O_EXCL 原子建，崩溃残留由启动清扫回收）。
  红线：results/ 下绝不允许出现会话最终结果以外的 task-<id>-* 文件——服务端信使对
  results/task-<id>-*.md 一律收口，任何中间标记放 .activator/ 目录。

用法：
  python dsh1-activator.py                # 常驻（3s 目录扫描，串行执行）
  python dsh1-activator.py --once         # 扫描一轮（dry-run：验状态不拉起）
  python dsh1-activator.py --selftest     # 内建自测（真实拉起最小会话，不碰队列/网关）
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY = "http://8.218.106.225:18765"
ROOT = Path(__file__).resolve().parents[2]          # 仓库根
QDIR = ROOT / "90-System" / "queue" / "dsh"
RES = QDIR / "results"
LOCKDIR = QDIR / ".activator"
LOG = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "dsh1-activator.log"
STATE = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "dsh1-activator-state.json"
DSH_BIN = os.environ.get("DSH_BIN", r"D:\DSH\OpenMausBot\tools\npm-global\dsh.cmd")
SCAN_INTERVAL = 3          # 目录扫描间隔（秒）
TASK_TIMEOUT = 25 * 60     # 单任务会话上限（秒）
PUSH_RETRY = 3


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg
    print(line, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def chief_token():
    return (os.environ.get("SB_TOKEN") or "").strip()


def gw_status(tid):
    """POST /cmd status 验任务状态；网络异常返回 None（不执行）。"""
    tok = chief_token()
    if not tok:
        log("NO_TOKEN 跳过 #%d（SB_TOKEN 未设置）" % tid)
        return None
    body = json.dumps({"cmd": "status", "args": {"id": tid}}).encode("utf-8")
    req = urllib.request.Request(
        GATEWAY + "/cmd", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
            return (data.get("task") or {}).get("status")
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            detail = e.read().decode("utf-8", "replace")[:120]
        except Exception:
            detail = ""
        log("GW_HTTP_ERR #%d code=%s %s" % (tid, code, detail))
        return None
    except Exception as e:
        log("GW_ERR #%d %s" % (tid, str(e)[:120]))
        return None


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"finished": {}, "inflight": {}}


def save_state(st):
    tmp = STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE)


def result_exists(tid):
    return bool(list(RES.glob("task-%d-*.md" % tid))) if RES.exists() else False


def acquire_lock(tid):
    LOCKDIR.mkdir(parents=True, exist_ok=True)
    p = LOCKDIR / ("%d.lock" % tid)
    try:
        p.open("x").close()
        return p
    except FileExistsError:
        return None


def launch_session(tid, text):
    """拉起 dsh headless 干活会话：任务文本走 stdin（`-`），避开引号转义。
    新建会话必须省略 --session-id（该旗标仅用于续接既有会话，实测 19:41）。
    返回 (ok, tail)。超时按进程树杀。"""
    argv = ["cmd", "/c", DSH_BIN, "--profile", "headless", "-"]
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    log("LAUNCH #%d" % tid)
    proc = subprocess.Popen(argv, cwd=str(ROOT), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, shell=False)
    try:
        out, err = proc.communicate(text.encode("utf-8"), timeout=TASK_TIMEOUT)
        tail = (out or b"").decode("utf-8", "replace")[-800:]
        log("EXIT #%d code=%s" % (tid, proc.returncode))
        return True, tail
    except subprocess.TimeoutExpired:
        log("TIMEOUT #%d（%ds）进程树击杀" % (tid, TASK_TIMEOUT))
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=30)
        except Exception as e:
            log("KILL_ERR #%d %s" % (tid, str(e)[:120]))
        return False, "会话超时（%d 分钟）被插件终止" % (TASK_TIMEOUT // 60)


def push_result_file(path):
    """结果文件上云：add -f → commit → rebase → push（重试 ×3）。"""
    for i in range(1, PUSH_RETRY + 1):
        try:
            subprocess.run(["git", "add", "-f", str(path)], cwd=str(ROOT),
                           capture_output=True, timeout=60)
            msg = "回写：task-%d 自动执行结果（dsh1-activator）" % tid_of(path)
            c = subprocess.run(["git", "-c", "user.name=dsh1-activator",
                                "-c", "user.email=dsh1@super-brain.local",
                                "commit", "-m", msg], cwd=str(ROOT),
                               capture_output=True, timeout=60)
            if c.returncode != 0 and b"nothing to commit" not in c.stderr:
                log("COMMIT_ERR %s" % c.stderr.decode("utf-8", "replace")[-200:])
            r = subprocess.run(["git", "pull", "--rebase", "--autostash"], cwd=str(ROOT),
                               capture_output=True, timeout=120)
            p = subprocess.run(["git", "push"], cwd=str(ROOT),
                               capture_output=True, timeout=120)
            if p.returncode == 0:
                log("PUSHED %s" % path.name)
                return True
            log("PUSH_FAIL(%d/%d) %s" % (i, PUSH_RETRY,
                p.stderr.decode("utf-8", "replace")[-150:]))
        except Exception as e:
            log("PUSH_ERR(%d) %s" % (i, str(e)[:150]))
        time.sleep(20 * i)
    log("PUSH_GIVEUP %s（commit 已留本地，后续扫描/人工补推）" % path.name)
    return False


def tid_of(path):
    try:
        return int(path.name.split("-")[1])
    except Exception:
        return -1


def write_failure_result(tid, why):
    """会话失败时插件如实落结果文件（任务收口为 done 带失败说明，避免死信+跨机改派）。"""
    RES.mkdir(parents=True, exist_ok=True)
    f = RES / ("task-%d-失败-自动执行.md" % tid)
    f.write_text(
        "# 任务 #%d 结果 — 自动执行失败\n\n- 队列文件名：task-%d（见本目录上级）\n"
        "- 任务编号：**%d**\n- 执行时间：%s\n- 结果：**失败** — %s\n\n"
        "本结果由 dsh1-activator 插件如实落盘；任务未产出有效交付。\n"
        % (tid, tid, tid, time.strftime("%Y-%m-%d %H:%M"), why),
        encoding="utf-8")
    return f


def handle_task(path, dry=False):
    tid = tid_of(path)
    if tid <= 0:
        return
    st = load_state()
    if str(tid) in st["finished"] or str(tid) in st["inflight"]:
        return
    if result_exists(tid):
        st["finished"][str(tid)] = time.strftime("%Y-%m-%d %H:%M:%S")
        save_state(st)
        return
    if dry:
        s = gw_status(tid)
        log("ONCE #%d 网关状态=%s → %s" % (tid, s, "将执行" if s == "pending" else "跳过"))
        return
    if acquire_lock(tid) is None:
        log("LOCKED #%d（他处处理中，跳过）" % tid)
        return
    st["inflight"][str(tid)] = time.strftime("%Y-%m-%d %H:%M:%S")
    save_state(st)
    try:
        status = None
        for _ in range(3):
            status = gw_status(tid)
            if status is not None:
                break
            time.sleep(10)
        if status != "pending":
            log("SKIP #%d 状态=%s（非 pending 不执行）" % (tid, status))
            st["finished"][str(tid)] = time.strftime("%Y-%m-%d %H:%M:%S") + " skip:" + str(status)
            save_state(st)
            return
        text = path.read_text(encoding="utf-8", errors="replace")
        ok, tail = launch_session(tid, text)
        produced = list(RES.glob("task-%d-*.md" % tid))
        if not produced:
            f = write_failure_result(tid, tail or "会话退出但未产出结果文件")
            produced = [f]
        log("RESULT #%d → %s" % (tid, produced[0].name))
        push_result_file(produced[0])
        st["finished"][str(tid)] = time.strftime("%Y-%m-%d %H:%M:%S")
    finally:
        st = load_state()
        st["inflight"].pop(str(tid), None)
        save_state(st)
        try:
            (LOCKDIR / ("%d.lock" % tid)).unlink()
        except OSError:
            pass


def sweep_stale_locks():
    """启动清扫：无 in-flight 登记却残留的锁视为崩溃残留，回收。"""
    if not LOCKDIR.exists():
        return
    st = load_state()
    for p in LOCKDIR.glob("*.lock"):
        tid = p.name.split(".")[0]
        if tid not in st["inflight"]:
            try:
                p.unlink()
                log("STALE_LOCK 回收 %s" % p.name)
            except OSError:
                pass


def scan_once(dry=False):
    if not QDIR.exists():
        return
    for f in sorted(QDIR.glob("task-*-*.md")):
        handle_task(f, dry=dry)


def selftest():
    """自测：真实拉起一个最小 headless 会话，不碰队列/网关/收口。"""
    log("SELFTEST 开始（最小会话，验证拉起链路）")
    argv = ["cmd", "/c", DSH_BIN, "--profile", "headless", "-"]
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    t0 = time.time()
    try:
        proc = subprocess.Popen(argv, cwd=str(ROOT), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, shell=False)
        out, err = proc.communicate("只回复四个字：自测通过".encode("utf-8"), timeout=300)
        out_s = (out or b"").decode("utf-8", "replace").strip()
        log("SELFTEST 退出码=%s 用时=%.0fs 输出尾部=%s"
            % (proc.returncode, time.time() - t0, out_s[-120:] or "(空)"))
        print("SELFTEST_%s" % ("OK" if proc.returncode == 0 and out_s else "FAIL"))
    except Exception as e:
        log("SELFTEST_FAIL %s" % str(e)[:200])
        print("SELFTEST_FAIL")


def main():
    LOCKDIR.mkdir(parents=True, exist_ok=True)
    if "--selftest" in sys.argv:
        selftest()
        return
    if "--once" in sys.argv:
        scan_once(dry=True)
        return
    log("ACTIVATOR 启动（监听 %s）" % QDIR)
    sweep_stale_locks()
    scan_once()
    while True:
        try:
            scan_once()
        except Exception as e:
            log("SCAN_ERR %s" % str(e)[:150])
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
