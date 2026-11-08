#!/usr/bin/env python3
# Super-Brain state.db 每日备份（2026-11-09 任务包 T5）
# - SQLite 在线备份 API（生产库读写不中断）
# - 保留最近 7 份；备份与生产库不同目录：/root/backups/super-brain/
# - 50-Events 的 jsonl 审计日志同一节奏打包（审计与账本同源，丢一不可）
# 调度：cron 每日 03:15（与现有 watchdog/sync 同一 crontab 风格）
import sqlite3
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = Path(__file__).parent / "state.db"
EVENTS = ROOT / "50-Events"
DEST = Path("/root/backups/super-brain")          # 与生产库不同目录
KEEP = 7


def rotate(pattern):
    olds = sorted(DEST.glob(pattern), key=lambda p: p.stat().st_mtime)
    for p in olds[:-KEEP + 1] if len(olds) >= KEEP else []:
        p.unlink()
        print(f"rotate 删除旧份: {p.name}")


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    # 1) state.db 在线备份（先备份 WAL 内容一并落进去，备份出的库自带一致性）
    out = DEST / f"state-{stamp}.db"
    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    dst = sqlite3.connect(out)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()
    print(f"db 备份完成: {out} ({out.stat().st_size} B)")
    rotate("state-*.db")

    # 2) 50-Events jsonl 审计日志打包（与账本同节奏；jsonl 是纯追加，tar 即一致快照）
    etar = DEST / f"events-{stamp}.tar.gz"
    with tarfile.open(etar, "w:gz") as tar:
        for j in sorted(EVENTS.glob("*.jsonl")) + sorted(EVENTS.glob("*.log")):
            tar.add(j, arcname=j.name)
    print(f"events 打包完成: {etar} ({etar.stat().st_size} B)")
    rotate("events-*.tar.gz")

    print("BACKUP_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
