#!/usr/bin/env python3
# 用临时库把 api_server 拉起来，供控制台测试。不读、不写 api_tokens.json。
import json
import os
import sqlite3
import sys
import threading
from pathlib import Path

db_path, token_file, port = sys.argv[1:]
os.environ["SUPER_BRAIN_TOKENS"] = token_file
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api_server  # noqa: E402


def db_fn():
    return sqlite3.connect(db_path, timeout=10)


def execute_fn(conn, chief, cmd, args):
    return {"ok": False, "error": "fixture 不执行指令"}


def log_event(kind, **fields):
    return None


conf = json.loads(Path(token_file).read_text(encoding="utf-8"))
handler = api_server._make_handler(
    db_fn, execute_fn, log_event, conf.get("tokens") or {}, conf.get("viewers") or {},
    threading.Event(), conf.get("owner") or {})
server = api_server.ThreadingHTTPServer(("127.0.0.1", int(port)), handler)
print("FIXTURE_READY %s" % port, flush=True)
server.serve_forever()
