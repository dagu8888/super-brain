#!/usr/bin/env python3
# PathGuard 权限模块（设计书 §5）
# 所有 Worker 文件写操作必须经 guard.write()；越权 → PermissionDenied + perm_audit 留痕
import json
import re
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 硬禁写清单（任何身份不可写）
HARD_DENY = [
    re.compile(r"(^|/)\.git(/|$)"),
    re.compile(r"llm\.json$"),
    re.compile(r"\.(key|pem|p12)$"),
    re.compile(r"(^|/)90-System/runtime/state\.db"),
]


def _protect_cfg():
    """读 kb_config.json 的 protect 段；配置缺失/损坏时按默认保护 40-Agents/、90-System/（宁严勿松）。"""
    try:
        cfg = json.loads((Path(__file__).resolve().parent / "kb_config.json").read_text(encoding="utf-8"))
        return cfg.get("protect") or {"prefixes": ["40-Agents/", "90-System/"], "writers": []}
    except Exception:
        return {"prefixes": ["40-Agents/", "90-System/"], "writers": []}


class PermissionDenied(Exception):
    pass


class PathGuard:
    """按 agents 表注册的 permissions 控制写路径。默认只读；写需显式 allowlist。"""

    def __init__(self, conn: sqlite3.Connection, agent_id: str):
        self.conn = conn
        self.agent_id = agent_id
        row = conn.execute("SELECT permissions FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
        perms = json.loads(row[0]) if row else {}
        self.allow_write = tuple(perms.get("write", []))
        self.can_exec = bool(perms.get("exec", False))
        self.can_llm = bool(perms.get("llm", False))

    def _audit(self, path: str, action: str, allowed: bool):
        self.conn.execute(
            "INSERT INTO perm_audit(ts,agent,path,action,allowed) VALUES(?,?,?,?,?)",
            (int(time.time()), self.agent_id, path, action, int(allowed)))
        self.conn.commit()

    def check_write(self, path) -> Path:
        """校验写权限，返回仓库内绝对路径；越权抛 PermissionDenied 并记审计。"""
        p = Path(path)
        if not p.is_absolute():
            p = ROOT / p
        p = p.resolve()
        try:
            rel = p.relative_to(ROOT).as_posix() + ("/" if p.is_dir() else "")
        except ValueError:
            self._audit(str(p), "write", False)
            raise PermissionDenied(f"{self.agent_id}: 仓库外路径禁写 {p}")
        if any(rx.search(rel) for rx in HARD_DENY):
            self._audit(rel, "write", False)
            raise PermissionDenied(f"{self.agent_id}: 硬禁路径 {rel}")
        # 2026-11-11 受保护目录（kb_config.json protect）：不在 writers 名单的身份一律禁写，allowlist 也不能放行
        prot = _protect_cfg()
        if rel.startswith(tuple(prot.get("prefixes") or ())) and self.agent_id not in (prot.get("writers") or []):
            self._audit(rel, "write", False)
            raise PermissionDenied(f"{self.agent_id}: 受保护目录 {rel}（需大古批准，见 kb_config.json protect）")
        if not any(rel.startswith(a) for a in self.allow_write):
            self._audit(rel, "write", False)
            raise PermissionDenied(f"{self.agent_id}: {rel} 不在写白名单 {list(self.allow_write)}")
        self._audit(rel, "write", True)
        return p

    def write_text(self, path, text: str, encoding="utf-8") -> Path:
        p = self.check_write(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding=encoding)
        return p

    def unlink(self, path) -> None:
        p = self.check_write(path)
        p.unlink(missing_ok=True)

    def require_llm(self):
        if not self.can_llm:
            self._audit("-", "llm", False)
            raise PermissionDenied(f"{self.agent_id}: 无 LLM 调用权限")

    def require_exec(self):
        if not self.can_exec:
            self._audit("-", "exec", False)
            raise PermissionDenied(f"{self.agent_id}: 无 exec 权限（高危操作走人工确认）")
