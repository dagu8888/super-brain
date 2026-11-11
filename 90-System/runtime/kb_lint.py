#!/usr/bin/env python3
# 知识库周体检 + 巩固草稿（P3，2026-11-11 grok）。不调用 LLM、零费用，建议每周一次 cron。
# 用法：python3 kb_lint.py [--consolidate] [--no-notify] [--dry-run]
#  - 体检报告写到 kb_config.lint.report_dir（原料层），推一条摘要提示给大古
#  - --consolidate：对「近似重复」的原料页生成一份合并草稿到暂存区（只拼接来源与要点，不改原页），等审批
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb_engine  # noqa: E402

ROOT = kb_engine.ROOT


def git(*a):
    return subprocess.run(["git", "-C", str(ROOT), "-c", "core.quotepath=off", *a],
                          capture_output=True, text=True, timeout=60).stdout


def last_commit_days(rel):
    out = git("log", "-1", "--format=%ct", "--", rel).strip()
    return (time.time() - int(out)) / 86400 if out else None


def jaccard(a, b):
    return len(a & b) / max(1, len(a | b))


def run(consolidate=False, notify=True, dry=False):
    cfg = kb_engine.load_config()
    L = cfg.get("lint") or {}
    files = kb_engine.corpus_files()
    pages = []
    for rel in files:
        raw = (ROOT / rel).read_text(encoding="utf-8", errors="replace")
        meta, body = kb_engine.parse_frontmatter(raw)
        pages.append({"rel": rel, "raw": raw, "meta": meta, "layer": kb_engine.layer_of(rel, meta),
                      "status": kb_engine.status_of(meta, body), "toks": set(kb_engine.tokens(body))})
    compiled = [p for p in pages if p["layer"] == "编译层"]
    req = L.get("compiled_required_fields") or []
    issues = {"缺 frontmatter 字段（编译层）": [], "长期未复核仍标现行": [], "近似重复": [], "孤儿页（编译层无人链接）": [],
              "疑似明文凭据": [], "例行日志混入": [], "暂存区草稿超期未审": [], "受保护目录被非人工提交改动": [],
              "已失效但缺 superseded_by": []}
    for p in compiled:
        miss = [k for k in req if not str(p["meta"].get(k) or "").strip()]
        if miss:
            issues["缺 frontmatter 字段（编译层）"].append(f"{p['rel']}：缺 {', '.join(miss)}")
        if p["status"] == "已失效" and not p["meta"].get("superseded_by"):
            issues["已失效但缺 superseded_by"].append(p["rel"])
        d = last_commit_days(p["rel"])
        if p["status"] == "现行" and d and d > float(L.get("stale_after_days", 45)):
            issues["长期未复核仍标现行"].append(f"{p['rel']}（{int(d)} 天未改）")
    # 近似重复：同层页面的二元组 Jaccard
    thr = float(L.get("dup_jaccard", 0.6))
    big = [p for p in pages if len(p["toks"]) > 30 and p["layer"] in ("编译层", "原料层")]
    dups = []
    for i in range(len(big)):
        for j in range(i + 1, len(big)):
            s = jaccard(big[i]["toks"], big[j]["toks"])
            if s >= thr:
                dups.append((s, big[i]["rel"], big[j]["rel"]))
    dups.sort(reverse=True)
    issues["近似重复"] = [f"{a} ≈ {b}（{s:.0%}）" for s, a, b in dups[:30]]
    # 孤儿：编译层页面的文件名/标题在其它页面里都没被提到
    alltext = "\n".join(p["raw"] for p in pages)
    for p in compiled:
        stem = Path(p["rel"]).stem
        if alltext.count(stem) <= 1 and alltext.count(str(p["meta"].get("title") or "\0")) <= 1:
            issues["孤儿页（编译层无人链接）"].append(p["rel"])
    # 凭据（只报位置，不报内容）
    for p in pages:
        red = kb_engine.redact(p["raw"])
        if red != p["raw"]:
            issues["疑似明文凭据"].append(p["rel"])
        if re.search(r"心跳丢失|heartbeat_lost", p["rel"]):
            issues["例行日志混入"].append(p["rel"])
    st_dir = ROOT / ((cfg.get("intake") or {}).get("staging_dir") or "10-Knowledge/_staging")
    max_age = float(L.get("staging_max_age_days", 7))
    if st_dir.exists():
        for f in st_dir.rglob("*.md"):
            age = (time.time() - f.stat().st_mtime) / 86400
            if age > max_age:
                issues["暂存区草稿超期未审"].append(f"{f.relative_to(ROOT).as_posix()}（{int(age)} 天）")
    writers = set((cfg.get("protect") or {}).get("writers") or []) | {"hk-server"}
    prot = (cfg.get("protect") or {}).get("prefixes") or []
    if prot:
        out = git("log", "--since=7.days", "--format=@@%h %an", "--name-only", "--", *prot)
        cur = None
        for line in out.splitlines():
            if line.startswith("@@"):
                cur = line[2:]
            elif line.strip() and cur and cur.split(" ", 1)[1] == "hk-server":
                issues["受保护目录被非人工提交改动"].append(f"{cur}：{line}")
    today = time.strftime("%Y-%m-%d")
    total = sum(len(v) for v in issues.values())
    lines = [f"---\ntitle: 知识库周体检 {today}\ntype: raw\nlayer: 原料层\nstatus: 现行\nvalid_from: {today}\n"
             f"source: [90-System/runtime/kb_lint.py]\nconfidence: 文档依据\n---\n",
             f"# 知识库周体检 {today}\n",
             f"> 自动生成（kb_lint.py，无 LLM）。扫描 {len(pages)} 页，其中编译层 {len(compiled)} 页；问题 {total} 条。\n"]
    for k, v in issues.items():
        lines.append(f"\n## {k}（{len(v)}）\n")
        lines.extend(f"- {x}\n" for x in v[:40])
        if len(v) > 40:
            lines.append(f"- …另 {len(v) - 40} 条\n")
    report = "".join(lines)
    rdir = ROOT / (L.get("report_dir") or "60-Outputs/kb-lint")
    rpath = rdir / f"{today}-知识库周体检.md"
    drafts = []
    if consolidate and dups:
        lay = {p["rel"]: p["layer"] for p in pages}
        # 只为涉及编译层的重复对出合并草稿；原料层之间的相似（如同类任务回执）只进报告，不生成草稿
        cdups = [d for d in dups if "编译层" in (lay.get(d[1]), lay.get(d[2]))]
        drafts = consolidation_drafts(cdups[:5], st_dir, dry)
    if not dry:
        rdir.mkdir(parents=True, exist_ok=True)
        rpath.write_text(report, encoding="utf-8")
    summary = "；".join(f"{k} {len(v)}" for k, v in issues.items() if v) or "无问题"
    if notify and not dry:
        try:
            import sqlite3
            import message_bus
            conn = sqlite3.connect(str(ROOT / "90-System/runtime/state.db"), timeout=30)
            message_bus.post_message(conn, cfg.get("system_sender") or "system-watchdog",
                                     f"【知识库周体检】{summary}。报告：{rpath.relative_to(ROOT).as_posix()}"
                                     + (f"；新合并草稿 {len(drafts)} 份待审" if drafts else ""),
                                     to=cfg.get("owner_id") or "dagu-owner", kind="chat")
            conn.close()
        except Exception as e:
            print("notify failed:", e)
    return {"report": rpath.relative_to(ROOT).as_posix(), "total": total,
            "counts": {k: len(v) for k, v in issues.items()}, "drafts": drafts}


def consolidation_drafts(dups, st_dir, dry):
    """把近似重复的页面拼成一份合并草稿（列来源 + 各自标题/要点），放暂存区等审批；不动原页。"""
    out = []
    for s, a, b in dups:
        ta = (ROOT / a).read_text(encoding="utf-8", errors="replace")
        tb = (ROOT / b).read_text(encoding="utf-8", errors="replace")
        heads = []
        for rel, t in ((a, ta), (b, tb)):
            body = kb_engine.parse_frontmatter(t)[1]
            hs = re.findall(r"^#{1,3}\s+(.+)$", body, re.M)[:12]
            heads.append((rel, hs))
        name = f"合并草稿-{Path(a).stem[:30]}.md"
        today = time.strftime("%Y-%m-%d")
        text = (f"---\ntitle: 合并草稿：{Path(a).stem}\ntype: 综合页\nlayer: 暂存区\nstatus: 草稿\n"
                f"valid_from: {today}\nsource: [{a}, {b}]\nconfidence: 文档依据\ncategory: Concepts\n---\n\n"
                f"# 合并草稿：{Path(a).stem}\n\n> kb_lint 发现两页相似度 {s:.0%}，建议合并为一页。"
                "审批人确认后用 kb_promote 入编译层，并把旧页标 status: 已失效 + superseded_by。\n\n")
        for rel, hs in heads:
            text += f"## 来源：{rel}\n\n" + "".join(f"- {h}\n" for h in hs) + "\n"
        dest = st_dir / "Concepts" / name
        if not dry and not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8")
        out.append(dest.relative_to(ROOT).as_posix())
    return out


if __name__ == "__main__":
    a = sys.argv[1:]
    print(json.dumps(run(consolidate="--consolidate" in a, notify="--no-notify" not in a, dry="--dry-run" in a),
                     ensure_ascii=False, indent=1))
