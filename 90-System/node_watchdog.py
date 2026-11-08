#!/usr/bin/env python3
# Super-Brain 节点看门狗（2026-11-09 任务包 T6，第一期：报告模式 + 演练拉活）
# 职责：盯住本机被看护进程，按现有 heartbeats 机制向大脑报心跳（POST /cmd heartbeat，不新造协议）
# 第一期纪律：真实进程只报告不干预；拉活能力仅对配置里 mode=revive 的演练目标生效
# 用法：SB_TOKEN=<幕僚长口令> python3 node_watchdog.py [--config node_watchdog.json] [--once]
# 口令只走环境变量，不落文件、不进命令行参数（防 ps 泄露）
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
LOG = HERE / "node_watchdog.log"

DEFAULT_CONF = {
    "brain_url": "http://8.218.106.225:18765/cmd",
    "node": "Trae@笔记本",
    "interval": 60,                 # 心跳/巡检间隔（秒）
    "watch": [
        # 真实进程第一期只报告（mode=report），pattern 按实际机器进程名调
        {"name": "DSH二号", "pattern": "deepseek|dsh", "mode": "report"},
        {"name": "Trae", "pattern": "trae", "mode": "report"},
    ],
}


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def alive(pattern):
    """pgrep -f 全命令行匹配；任何匹配即存活。"""
    r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
    return bool(r.stdout.strip())


def heartbeat(conf, token, note):
    body = json.dumps({"cmd": "heartbeat",
                       "args": {"agent": conf["node"], "note": note}}).encode()
    req = urllib.request.Request(
        conf["brain_url"], data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read()).get("ok", False)
    except Exception as e:
        log(f"心跳上报失败: {e}")
        return False


def revive(item):
    """拉起演练目标（仅 mode=revive 允许走到这里）。"""
    log(f"发现死亡，执行拉活: {item['name']} -> {item['start_cmd']}")
    subprocess.Popen(item["start_cmd"], shell=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


def tick(conf, token):
    states = []
    for item in conf["watch"]:
        ok = alive(item["pattern"])
        if not ok and item.get("mode") == "revive" and item.get("start_cmd"):
            revive(item)
            time.sleep(1)
            ok = alive(item["pattern"])
            log(f"拉活结果: {item['name']} {'存活' if ok else '仍死亡'}")
        states.append(f"{item['name']}={'ok' if ok else 'dead'}({item.get('mode', 'report')})")
    note = "节点巡检: " + " ".join(states)
    ok = heartbeat(conf, token, note)
    log(("心跳已上报 " if ok else "心跳未达 ") + note)
    return ok


def main():
    args = sys.argv[1:]
    conf = dict(DEFAULT_CONF)
    if "--config" in args:
        conf.update(json.loads(Path(args[args.index("--config") + 1]).read_text(encoding="utf-8")))
    token = os.environ.get("SB_TOKEN", "")
    if not token:
        print("SB_TOKEN 环境变量未设置（口令只走环境变量）", file=sys.stderr)
        return 1
    log(f"节点看门狗启动 node={conf['node']} interval={conf['interval']}s 目标数={len(conf['watch'])}")
    if "--once" in args:
        return 0 if tick(conf, token) else 1
    while True:
        tick(conf, token)
        time.sleep(conf["interval"])


if __name__ == "__main__":
    sys.exit(main())
