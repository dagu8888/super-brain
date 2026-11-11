#!/usr/bin/env python3
# 入库闸门（2026-11-11 grok；大古：所有要写进知识库的先晒一下）
# - 自动整理的产出只进暂存区（kb_config.intake.staging_dir），推一条「待审草稿」提示给大古
# - 只有 intake.approvers 名单里的身份能 kb_promote（进编译层）或 kb_reject（丢弃草稿）
# - kb_staging 任何 chief 可查看草稿清单
import re
import time
from pathlib import Path

import kb_engine
import message_bus

ROOT = kb_engine.ROOT
CATEGORIES = ("Concepts", "Decisions", "Playbooks")


def cfg():
    return kb_engine.section("intake")


def gate_on():
    return bool(cfg().get("gate", True))


def staging_root():
    return ROOT / (cfg().get("staging_dir") or "10-Knowledge/_staging")


def notify_draft(conn, rel, title, summary):
    c = kb_engine.load_config()
    i = cfg()
    if not i.get("notify_new_draft", True):
        return None
    sender = c.get("system_sender") or "system-watchdog"
    to = c.get("owner_id") or "dagu-owner"
    day0 = int(time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d")))
    try:
        n = conn.execute("SELECT COUNT(*) FROM messages WHERE from_agent=? AND created_at>=? AND text LIKE '【待审草稿】%'",
                         (sender, day0)).fetchone()[0]
    except Exception:
        n = 0
    if n >= int(i.get("notify_max_per_day", 20)):
        return None
    text = (f"【待审草稿】{title}\n位置：{rel}\n摘要：{(summary or '')[:120]}\n"
            "通过：让任一审批人执行 kb_promote（path=上面位置）；不要：kb_reject。不处理就一直留在暂存区，不进编译层。")
    res = message_bus.post_message(conn, sender, text, to=to, kind="chat")
    return res.get("msg_id") if res.get("ok") else None


def _rel(p):
    return p.resolve().relative_to(ROOT.resolve()).as_posix()


def list_staging(limit=50):
    root = staging_root()
    out = []
    if root.exists():
        for f in sorted(root.rglob("*.md"), key=lambda x: -x.stat().st_mtime)[:limit]:
            meta, _ = kb_engine.parse_frontmatter(f.read_text(encoding="utf-8", errors="replace"))
            out.append({"path": _rel(f), "title": str(meta.get("title") or f.stem),
                        "category": str(meta.get("category") or ""), "supersedes": str(meta.get("supersedes") or ""),
                        "age_hours": round((time.time() - f.stat().st_mtime) / 3600, 1)})
    return out


def _set_fields(text, fields):
    meta_end = text.find("\n---", 3) if text.startswith("---") else -1
    if meta_end < 0:
        head = "".join(f"{k}: {v}\n" for k, v in fields.items())
        return f"---\n{head}---\n\n" + text
    block, rest = text[3:meta_end], text[meta_end:]
    for k, v in fields.items():
        if re.search(rf"^{re.escape(k)}:.*$", block, re.M):
            block = re.sub(rf"^{re.escape(k)}:.*$", f"{k}: {v}", block, flags=re.M)
        else:
            block = block.rstrip("\n") + f"\n{k}: {v}\n"
    return "---" + block + rest


def _check_draft(args):
    rel = str(args.get("path") or "").strip()
    if not rel:
        return None, {"ok": False, "error": "path 必填（暂存区里的草稿路径）"}
    fp = (ROOT / rel).resolve()
    sr = staging_root().resolve()
    if sr not in fp.parents or not fp.is_file() or fp.suffix != ".md":
        return None, {"ok": False, "error": f"只能处理暂存区里的草稿：{rel}"}
    return fp, None


def promote(conn, who, args):
    if who not in (cfg().get("approvers") or []):
        return {"ok": False, "error": f"{who} 不在入库审批人名单（kb_config.intake.approvers）"}
    fp, err = _check_draft(args)
    if err:
        return err
    text = fp.read_text(encoding="utf-8", errors="replace")
    meta, _ = kb_engine.parse_frontmatter(text)
    cat = str(args.get("category") or meta.get("category") or "Concepts")
    if cat not in CATEGORIES:
        return {"ok": False, "error": f"category 只能是 {'/'.join(CATEGORIES)}"}
    today = time.strftime("%Y-%m-%d")
    sup = str(meta.get("supersedes") or "").strip()
    if sup and (ROOT / sup).is_file() and not args.get("as_new"):
        dest = ROOT / sup                       # 同源新版本：覆盖旧编译页（旧版在 git 历史里可追溯）
    else:
        dest = ROOT / "10-Knowledge" / cat / fp.name
        i = 1
        while dest.exists():
            i += 1
            dest = dest.with_name(f"{fp.stem}-{i}.md")
    text = _set_fields(text, {"status": "现行", "quality": "reviewed", "layer": "编译层",
                              "approved_by": who, "approved_at": today, "updated": today})
    text = re.sub(r"^supersedes:.*\n", "", text, count=1, flags=re.M)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")
    fp.unlink()
    return {"ok": True, "promoted": _rel(dest), "from": args.get("path"), "by": who}


def reject(conn, who, args):
    if who not in (cfg().get("approvers") or []):
        return {"ok": False, "error": f"{who} 不在入库审批人名单（kb_config.intake.approvers）"}
    fp, err = _check_draft(args)
    if err:
        return err
    rel = _rel(fp)
    fp.unlink()
    return {"ok": True, "rejected": rel, "by": who, "note": "草稿已删除（原始 Inbox 文本若已提交，可从 git 历史找回）"}


def is_routine(event_type):
    return event_type in (cfg().get("routine_event_types") or [])
