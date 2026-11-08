#!/usr/bin/env python3
# chief 统一指令接口（设计书 §11.3）：五个幕僚长入口共用同一任务中心
# 用法:
#   python3 chief_cli.py --as trae-chief submit "整理一下收集箱"
#   python3 chief_cli.py --as grok-chief status 12
#   python3 chief_cli.py --as maus-chief list [--status pending] [--limit 20]
#   python3 chief_cli.py --as dsh-chief progress 12
#   python3 chief_cli.py --as trae-chief delegate 12 trae-developer
#   python3 chief_cli.py --as deepseek-chief link 12 "补充：重点关注可靠性"
#   python3 chief_cli.py --as trae-chief cancel 12
# 也支持 worker 身份注入 chief_cmd 事件（验证权限分离）：
#   python3 chief_cli.py --as trae-developer submit "x"   # 应被拒绝
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import runtime  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Super-Brain chief 指令接口")
    ap.add_argument("--as", dest="chief", default="trae-chief",
                    help="入口身份：grok-chief|deepseek-chief|maus-chief|dsh-chief|trae-chief")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("submit"); p.add_argument("text"); p.add_argument("--priority", type=int, default=0)
    p.add_argument("--dedupe", dest="dedupe_key", default=None)
    p = sub.add_parser("status"); p.add_argument("id", type=int)
    p = sub.add_parser("list"); p.add_argument("--status", default=None); p.add_argument("--limit", type=int, default=10)
    p = sub.add_parser("progress"); p.add_argument("id", type=int)
    p = sub.add_parser("delegate"); p.add_argument("id", type=int); p.add_argument("to")
    p = sub.add_parser("link"); p.add_argument("id", type=int); p.add_argument("text")
    p = sub.add_parser("cancel"); p.add_argument("id", type=int)
    args = ap.parse_args()

    conn = runtime.db()
    res = runtime.chief_execute(conn, args.chief, args.cmd, vars(args))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    conn.close()
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
