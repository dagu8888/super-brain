#!/usr/bin/env python3
# 大古身份运维（只在服务器上由管理员执行；任何口令/配对码都不打印到终端或日志）
#   python3 owner_cli.py init  [--conf /etc/super-brain/api_tokens.json]
#        若无 "owner": {"dagu-owner": ...} 则生成一个独立主口令写入（文件保持 600）；已有则不动。需重启服务生效。
#   python3 owner_cli.py pair  --base https://host/console/prototype/index.html --out /root/owner-pair-link.txt [--ttl-hours 24]
#        生成一次性配对码，把配对链接写进 --out（600），终端只提示文件路径。
#   python3 owner_cli.py devices            列出已配对设备（不含令牌）
#   python3 owner_cli.py revoke <id>        吊销某台设备
#   python3 owner_cli.py set-unlock [--out /etc/super-brain/owner_unlock.hash]
#        从标准输入读口令（每行一条），写成加盐哈希（600）。终端不回显原文或哈希。
import argparse
import json
import os
import secrets
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import owner_ops  # noqa: E402

DB = HERE / "state.db"


def _write_600(path, text):
    path = Path(path)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)


def cmd_init(a):
    p = Path(a.conf)
    conf = json.loads(p.read_text(encoding="utf-8"))
    owner = conf.get("owner") or {}
    if owner.get(owner_ops.OWNER_ID):
        print("已有 dagu-owner 主口令，未改动")
        return 0
    used = set((conf.get("tokens") or {}).values()) | set((conf.get("viewers") or {}).values())
    tok = secrets.token_urlsafe(32)
    while tok in used:
        tok = secrets.token_urlsafe(32)
    owner[owner_ops.OWNER_ID] = tok
    conf["owner"] = owner
    tmp = p.with_name(p.name + ".tmp")
    _write_600(tmp, json.dumps(conf, ensure_ascii=False, indent=2))
    os.replace(tmp, p)
    print("已写入 dagu-owner 独立主口令（未显示）；重启 super-brain 后生效")
    return 0


def cmd_pair(a):
    conn = sqlite3.connect(str(a.db), timeout=10)
    try:
        code, exp = owner_ops.create_pair_code(conn, created_by="owner_cli", ttl=int(a.ttl_hours * 3600))
    finally:
        conn.close()
    link = f"{a.base}#pair={code}"
    _write_600(a.out, link + "\n")
    print(f"配对链接已写入 {a.out}（600），一次性，{a.ttl_hours:g} 小时内有效")
    return 0


def cmd_devices(a):
    conn = sqlite3.connect(str(a.db), timeout=10)
    owner_ops.ensure_schema(conn)
    for r in conn.execute("SELECT id,name,created_at,last_used_at,revoked_at FROM owner_devices ORDER BY id"):
        print(r)
    conn.close()
    return 0


def cmd_revoke(a):
    conn = sqlite3.connect(str(a.db), timeout=10)
    owner_ops.ensure_schema(conn)
    n = conn.execute("UPDATE owner_devices SET revoked_at=strftime('%s','now') WHERE id=? AND revoked_at IS NULL",
                     (a.id,)).rowcount
    conn.commit()
    conn.close()
    print(f"已吊销 {n} 台")
    return 0


def cmd_set_unlock(a):
    phrases = []
    for ln in sys.stdin:
        s = ln.strip()
        if s and not s.startswith("#"):
            phrases.append(s)
    if not phrases:
        print("请从标准输入提供至少一条口令（每行一条）", file=sys.stderr)
        return 1
    n = owner_ops.write_unlock_hashes(a.out, phrases)
    print(f"已写入口令哈希到 {a.out}（600），共 {n} 条；未回显内容")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DB))
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init")
    s.add_argument("--conf", default="/etc/super-brain/api_tokens.json")
    s = sub.add_parser("pair")
    s.add_argument("--base", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--ttl-hours", type=float, default=24)
    sub.add_parser("devices")
    s = sub.add_parser("revoke")
    s.add_argument("id", type=int)
    s = sub.add_parser("set-unlock")
    s.add_argument("--out", default="/etc/super-brain/owner_unlock.hash")
    a = ap.parse_args()
    return {"init": cmd_init, "pair": cmd_pair, "devices": cmd_devices,
            "revoke": cmd_revoke, "set-unlock": cmd_set_unlock}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
