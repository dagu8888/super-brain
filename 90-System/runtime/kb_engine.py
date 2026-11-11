#!/usr/bin/env python3
# 知识库检索引擎（KB-Annex-001 第二阶段，2026-11-11 grok）
# - 只检索 git 跟踪的 Markdown（排除队列、事件流、私密区等，见 kb_config.json）
# - legacy：旧版逐字匹配（行为与原 kb_search 一致，只是范围收窄）
# - hybrid：SQLite FTS5(BM25) + 中文二元组 + 英文/数字实体匹配 + frontmatter 时效过滤 + 覆盖率拒答
# - 输出统一过凭据遮蔽；索引是派生物，放仓库外，HEAD 变化自动重建
# 零依赖（标准库 + 可选 pyyaml），零费用，不调用 LLM。
import json
import math
import os
import re
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).resolve().parent / "kb_config.json"

_cfg_cache = {"mtime": None, "cfg": {}}
_lock = threading.RLock()


def load_config():
    try:
        m = CONFIG_PATH.stat().st_mtime
    except OSError:
        return {}
    if _cfg_cache["mtime"] != m:
        try:
            _cfg_cache["cfg"] = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            _cfg_cache["mtime"] = m
        except Exception:
            pass
    return _cfg_cache["cfg"]


def section(name):
    return load_config().get(name) or {}


# ---------------- 凭据遮蔽 ----------------
_redact_cache = {"src": None, "rx": []}


def redact(text):
    r = section("redact")
    pats = r.get("patterns") or []
    ph = r.get("placeholder") or "（已遮蔽）"
    if _redact_cache["src"] != pats:
        rx = []
        for p in pats:
            try:
                rx.append(re.compile(p))
            except re.error:
                pass
        _redact_cache.update(src=list(pats), rx=rx)
    if not text:
        return text
    for rx in _redact_cache["rx"]:
        text = rx.sub(lambda m: (m.group(1) if m.re.groups and m.group(1) else "") + ph, text)
    return text


# ---------------- 语料：git 跟踪的 md ----------------
_corpus = {"head": None, "files": [], "at": 0}


def git_head():
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True,
                              text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


def corpus_files(extra_exclude=()):
    """git ls-files 下的 *.md，按 HEAD 缓存；排除配置里的前缀。返回相对路径列表。"""
    s = section("search")
    with _lock:
        head = git_head()
        if head != _corpus["head"] or not _corpus["files"]:
            globs = s.get("include_globs") or ["*.md"]
            try:
                out = subprocess.run(["git", "-C", str(ROOT), "-c", "core.quotepath=off", "ls-files", "-z", "--"]
                                     + list(globs), capture_output=True, timeout=30).stdout
                files = [f for f in out.decode("utf-8", "replace").split("\0") if f]
            except Exception:
                files = []
            _corpus.update(head=head, files=files, at=time.time())
        files = list(_corpus["files"])
    excl = tuple(s.get("exclude_prefixes") or ()) + tuple(extra_exclude or ())
    return [f for f in files if not f.startswith(excl) and (ROOT / f).is_file()]


# ---------------- frontmatter / 分层 ----------------
def parse_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    block = text[3:end]
    body = text[end + 4:]
    meta = {}
    try:
        import yaml
        meta = yaml.safe_load(block) or {}
        if not isinstance(meta, dict):
            meta = {}
    except Exception:
        for line in block.splitlines():
            if ":" in line and not line.startswith((" ", "-")):
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
    return {str(k): ("" if v is None else v) for k, v in meta.items()}, body


def layer_of(path, meta):
    lay = str(meta.get("layer") or "")
    for key in ("编译", "原料", "系统", "暂存"):
        if key in lay:
            return {"编译": "编译层", "原料": "原料层", "系统": "系统区", "暂存": "暂存区"}[key]
    for prefix, name in section("search").get("layer_by_prefix") or []:
        if path.startswith(prefix):
            return name
    return "未知"


def status_of(meta, body):
    st = str(meta.get("status") or "").strip()
    vt = str(meta.get("valid_to") or "").strip()
    if vt and vt[:10] < time.strftime("%Y-%m-%d"):
        st = "已失效"
    if not st:
        st = "未标注"
    if st == "现行" and str(meta.get("partially_stale") or "").lower() in ("true", "1", "yes", "是"):
        st = "部分已失效"
    return st


# ---------------- 分词：中文二元组 + 英文/数字词 ----------------
_CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
_TOKEN_RX = re.compile(r"[a-z0-9_]+|[" + _CJK + r"]+")
STOP_PHRASES = ["是什么", "是多少", "是哪个", "是哪些", "是哪位", "是谁", "什么", "多少", "哪个", "哪些", "哪里",
                "怎么", "如何", "为什么", "是否", "有没有", "是不是", "还是", "现在", "目前", "当前", "请问",
                "一下", "可以", "能否", "吗", "呢", "吧", "的", "了", "和", "与", "及", "在", "是", "有", "要",
                "用", "把", "被", "给", "对", "从", "到", "这个", "那个", "我们", "你们", "他们", "多久", "几个",
                "几次", "几", "谁"]
STOP_WORDS = {"the", "a", "an", "of", "to", "is", "are", "and", "or", "in", "on", "for", "what", "which",
              "how", "does", "do", "md"}


def tokens(text, query=False):
    t = (text or "").lower()
    if query:
        for p in STOP_PHRASES:
            t = t.replace(p, " ")
    out = []
    for m in _TOKEN_RX.finditer(t):
        w = m.group(0)
        if w[0] in "abcdefghijklmnopqrstuvwxyz0123456789_":
            if w in STOP_WORDS:
                continue
            out.append(w)
            if "_" in w:
                out.extend(x for x in w.split("_") if len(x) > 1)
        elif len(w) == 1:
            out.append(w)
        else:
            out.extend(w[i:i + 2] for i in range(len(w) - 1))
    return out


def entities(query):
    """英文标识符/数字/路径类实体：要求在正文里原样出现（不区分大小写）。"""
    ents = set()
    for m in re.finditer(r"[A-Za-z0-9_][A-Za-z0-9_.\-/]{2,}", query or ""):
        e = m.group(0).strip(".-/").lower()
        if len(e) >= 3 and e not in STOP_WORDS:
            ents.add(e)
    for m in re.finditer(r"[「“\"《]([^」”\"》]{2,40})[」”\"》]", query or ""):
        ents.add(m.group(1).lower())
    return ents


# ---------------- 索引 ----------------
def _index_path():
    p = (os.environ.get("KB_INDEX_PATH") or section("search").get("index_path")
         or "/var/lib/super-brain/kb_index.db")
    return Path(p)


def _idx_conn():
    p = _index_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(p), timeout=30, check_same_thread=False)
    return c


def build_index(force=False, extra_exclude=()):
    """HEAD 或配置变化才重建。返回 (index_key, 文档数, 是否重建)。"""
    s = section("search")
    files = corpus_files(extra_exclude)
    key = json.dumps([_corpus["head"], sorted(s.get("exclude_prefixes") or []), sorted(extra_exclude or []),
                      s.get("layer_by_prefix"), 2], ensure_ascii=False)
    with _lock:
        c = _idx_conn()
        try:
            c.execute("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)")
            row = c.execute("SELECT v FROM kv WHERE k='key'").fetchone()
            if row and row[0] == key and not force:
                n = c.execute("SELECT COUNT(*) FROM meta").fetchone()[0]
                return key, n, False
            c.execute("DROP TABLE IF EXISTS docs")
            c.execute("DROP TABLE IF EXISTS meta")
            c.execute("DROP TABLE IF EXISTS df")
            c.execute("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, title, tags, body, "
                      "tokenize=\"unicode61 remove_diacritics 0 tokenchars '_'\")")
            c.execute("CREATE TABLE meta(path TEXT PRIMARY KEY, title TEXT, layer TEXT, type TEXT, status TEXT,"
                      " valid_from TEXT, valid_to TEXT, superseded_by TEXT, text TEXT)")
            c.execute("CREATE TABLE df(tok TEXT PRIMARY KEY, n INTEGER)")
            df = {}
            drop = set(s.get("drop_status") or [])
            n = 0
            for rel in files:
                fp = ROOT / rel
                try:
                    if fp.stat().st_size > 2 * 1024 * 1024:
                        continue
                    raw = fp.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    continue
                meta, body = parse_frontmatter(raw)
                st = status_of(meta, body)
                if st in drop:
                    continue
                title = str(meta.get("title") or "")
                if not title:
                    m = re.search(r"^#\s+(.+)$", body, re.M)
                    title = m.group(1).strip() if m else Path(rel).stem
                tags = meta.get("tags") or ""
                if isinstance(tags, list):
                    tags = " ".join(map(str, tags))
                tags = f"{tags} {meta.get('type', '')} {Path(rel).stem}"
                btoks = tokens(raw)
                c.execute("INSERT INTO docs(path,title,tags,body) VALUES(?,?,?,?)",
                          (rel, " ".join(tokens(title)), " ".join(tokens(str(tags))), " ".join(btoks)))
                c.execute("INSERT INTO meta VALUES(?,?,?,?,?,?,?,?,?)",
                          (rel, title, layer_of(rel, meta), str(meta.get("type") or ""), st,
                           str(meta.get("valid_from") or ""), str(meta.get("valid_to") or ""),
                           str(meta.get("superseded_by") or ""), raw))
                for t in set(btoks) | set(tokens(title)):
                    df[t] = df.get(t, 0) + 1
                n += 1
            c.executemany("INSERT INTO df VALUES(?,?)", df.items())
            c.execute("INSERT OR REPLACE INTO kv VALUES('key',?)", (key,))
            c.execute("INSERT OR REPLACE INTO kv VALUES('n',?)", (str(n),))
            c.commit()
            return key, n, True
        finally:
            c.close()


# ---------------- 检索 ----------------
def _snippet(text, qtoks, idf, width):
    body = parse_frontmatter(text)[1]
    paras = [p for p in re.split(r"\n\s*\n|\n(?=#)|\n(?=[-*|>] )", body) if p.strip()]
    best, bs = "", -1.0
    for p in paras:
        pt = set(tokens(p))
        sc = sum(idf.get(t, 1.0) for t in qtoks if t in pt)
        if sc > bs:
            best, bs = p, sc
    best = re.sub(r"\s+", " ", best).strip()
    if len(best) <= width:
        return best
    # 在段内找命中最密的窗口
    low = best.lower()
    pos = [low.find(t) for t in qtoks if low.find(t) >= 0]
    start = 0
    if pos:
        bw = -1
        for p0 in pos:
            s0 = max(0, p0 - width // 4)
            w = low[s0:s0 + width]
            k = sum(1 for t in qtoks if t in w)
            if k > bw:
                bw, start = k, s0
    return ("…" if start else "") + best[start:start + width] + "…"


def search_hybrid(q, limit=10, extra_exclude=(), with_debug=False):
    s = section("search")
    build_index(extra_exclude=extra_exclude)
    qseq = tokens(q, query=True)
    qt = list(dict.fromkeys(qseq))
    ents = entities(q)
    if not qt and not ents:
        return {"hits": [], "refused": True, "best_coverage": 0.0, "note": "查询里没有可检索的词"}
    c = _idx_conn()
    try:
        ndoc = int((c.execute("SELECT v FROM kv WHERE k='n'").fetchone() or ["1"])[0]) or 1
        idf = {}
        for t in qt:
            r = c.execute("SELECT n FROM df WHERE tok=?", (t,)).fetchone()
            dfn = r[0] if r else 0
            idf[t] = math.log(1 + (ndoc - dfn + 0.5) / (dfn + 0.5))
        # 跨词边界的二元组（如「网关端口」里的「关端」）库里没有、左右邻都有 → 视为切分噪声丢掉，不拉低覆盖率
        dfz = {t for t in qt if c.execute("SELECT 1 FROM df WHERE tok=?", (t,)).fetchone() is None}
        junk = set()
        for i, t in enumerate(qseq):
            if t in dfz and len(t) == 2 and 0 < i < len(qseq) - 1 \
                    and qseq[i - 1] not in dfz and qseq[i + 1] not in dfz \
                    and qseq[i - 1][-1:] == t[:1] and qseq[i + 1][:1] == t[-1:]:
                junk.add(t)
        qt = [t for t in qt if t not in junk]
        qt_known = [t for t in qt if idf[t] > 0]
        expr = " OR ".join('"' + t.replace('"', '') + '"' for t in qt_known[:64]) if qt_known else ""
        cand = {}
        if expr:
            for path, b in c.execute("SELECT path, bm25(docs, 0.0, 5.0, 3.0, 1.0) FROM docs WHERE docs MATCH ? "
                                     "ORDER BY 2 LIMIT ?", (expr, int(s.get("candidates", 60)))):
                cand[path] = -b
        # 实体直配：英文标识/数字/引号名，确保逐字出现的也进候选
        for e in ents:
            for (path,) in c.execute("SELECT path FROM meta WHERE instr(lower(text), ?) > 0 LIMIT 30", (e,)):
                cand.setdefault(path, 0.0)
        if not cand:
            return {"hits": [], "refused": True, "best_coverage": 0.0, "note": "库里没有相关页面"}
        total_idf = sum(idf[t] for t in qt) or 1.0
        bmax = max(cand.values()) or 1.0
        lw, sw = s.get("layer_weight") or {}, s.get("status_weight") or {}
        rows = []
        for path, b in cand.items():
            m = c.execute("SELECT title,layer,type,status,valid_from,valid_to,superseded_by,text FROM meta "
                          "WHERE path=?", (path,)).fetchone()
            if not m:
                continue
            title, layer, typ, st, vf, vt, sup, text = m
            low = text.lower()
            dt = set(tokens(text))
            cov = sum(idf[t] for t in qt if t in dt) / total_idf if qt else 0.0
            ent_hit = [e for e in ents if e in low]
            ent_cov = len(ent_hit) / len(ents) if ents else None
            if ents:
                cov_all = 0.7 * cov + 0.3 * ent_cov if qt else ent_cov
            else:
                cov_all = cov
            ttoks = set(tokens(title))
            title_bonus = 0.15 * (sum(1 for t in qt if t in ttoks) / max(1, len(qt)))
            score = (cov_all + 0.35 * (b / bmax) + title_bonus) * lw.get(layer, 0.9) * sw.get(st, 0.9)
            rows.append((score, cov_all, path, title, layer, typ, st, vf, vt, sup, text))
        rows.sort(key=lambda r: -r[0])
        best_cov = max((r[1] for r in rows), default=0.0)
        tau = float(s.get("refuse_below_coverage", 0.6))
        if best_cov < tau:
            out = {"hits": [], "refused": True, "best_coverage": round(best_cov, 3),
                   "note": f"最相关页面只覆盖查询的 {best_cov:.0%}（< {tau:.0%}），判定库里没有答案"}
            if with_debug:
                out["debug"] = [(r[2], round(r[0], 3), round(r[1], 3)) for r in rows[:5]]
            return out
        width = int(s.get("snippet_chars", 200))
        hits = []
        for r in rows[:limit]:
            score, cov_all, path, title, layer, typ, st, vf, vt, sup, text = r
            if cov_all < tau * 0.5:
                continue
            h = {"path": path, "title": title, "layer": layer, "type": typ, "status": st,
                 "valid_from": vf, "valid_to": vt, "superseded_by": sup,
                 "score": round(score, 3), "coverage": round(cov_all, 3),
                 "snippet": redact(_snippet(text, qt + list(ents), idf, width))}
            if st in ("已失效", "部分已失效"):
                h["warning"] = "该页（或部分内容）已失效，请以现行页为准" + (f"：{sup}" if sup else "")
            hits.append(h)
        return {"hits": hits, "refused": False, "best_coverage": round(best_cov, 3)}
    finally:
        c.close()


def search_legacy(q, limit=10, extra_exclude=()):
    """原 kb_search 算法（逐字、首个命中、无排序），范围收窄为 git 跟踪的 md。"""
    kwl = q.lower()
    hits = []
    for rel in corpus_files(extra_exclude):
        if len(hits) >= limit:
            break
        try:
            text = (ROOT / rel).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        pos = text.lower().find(kwl)
        if pos < 0:
            continue
        start = max(0, pos - 60)
        snippet = re.sub(r"\s+", " ", text[start:pos + 120]).strip()
        hits.append({"path": rel, "snippet": redact(("…" if start else "") + snippet + "…")})
    return {"hits": hits, "refused": not hits}


def kb_search(args, log=None):
    """网关 kb_search 入口。args: q/text/keyword, limit, engine(可选覆盖，仅 legacy|hybrid)。"""
    kw = str(args.get("q") or args.get("text") or args.get("keyword") or "").strip()
    if not kw:
        return {"ok": False, "error": "空关键词（q/text/keyword 任选其一）"}
    try:
        limit = max(1, min(int(args.get("limit", 10)), 20))
    except (TypeError, ValueError):
        limit = 10
    engine = str(section("search").get("engine") or "legacy")
    req = str(args.get("engine") or "").strip()
    if req in ("legacy", "hybrid"):
        engine = req
    t0 = time.time()
    if engine == "hybrid":
        try:
            r = search_hybrid(kw, limit)
        except Exception as e:                     # 新引擎异常 → 自动回退旧引擎，不让检索挂掉
            if log:
                log("kb_hybrid_error", error=str(e)[:200])
            r = search_legacy(kw, limit)
            engine = "legacy(回退)"
    else:
        r = search_legacy(kw, limit)
        if engine == "shadow":
            try:
                h = search_hybrid(kw, limit)
                if log:
                    log("kb_shadow", q=kw[:80], legacy=[x["path"] for x in r["hits"][:5]],
                        hybrid=[x["path"] for x in h["hits"][:5]], hybrid_refused=h.get("refused"))
            except Exception as e:
                if log:
                    log("kb_hybrid_error", error=str(e)[:200])
    out = {"ok": True, "q": kw, "engine": engine, "count": len(r["hits"]), "hits": r["hits"],
           "ms": int((time.time() - t0) * 1000)}
    if r.get("refused"):
        out["refused"] = True
        if r.get("note"):
            out["note"] = r["note"]
    return out


if __name__ == "__main__":
    import sys
    a = sys.argv[1:]
    if a and a[0] == "build":
        print(build_index(force=True)[1:])
    elif a:
        print(json.dumps(kb_search({"q": " ".join(a[1:]), "engine": a[0]}), ensure_ascii=False, indent=1))
