#!/usr/bin/env python3
"""语音音频保留规则（大古 2026-11-11 13:20 硬规则）：任何录音/合成音频只留最近 10 条。

- 只处理「音频目录」本层的普通文件，且扩展名必须在 AUDIO_EXTS 内；
  不递归、不跟随符号链接、不碰子目录，模型文件（.ort/.json/.bin）与 WASM 资源一律不动。
- 每次新生成音频后立即调用 prune()；另由 sb-audio-prune.timer 每小时兜底。
- 目录必须是绝对路径且不是根目录/家目录等危险位置。

用法：python3 audio_retention.py /var/lib/super-brain/audio [--keep 10] [--dry-run]
"""
import argparse
import os
import stat
import sys
from pathlib import Path

KEEP = 10
AUDIO_EXTS = frozenset({".wav", ".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus",
                        ".webm", ".flac", ".caf", ".amr", ".pcm", ".f32", ".raw"})
DEFAULT_DIR = "/var/lib/super-brain/audio"
_FORBIDDEN = {"/", "/root", "/home", "/etc", "/usr", "/var", "/var/lib", "/tmp", "/opt", "/boot", "/srv"}


def _safe_dir(d):
    p = Path(d)
    if not p.is_absolute():
        raise ValueError("音频目录必须是绝对路径")
    if os.path.normpath(str(p)) in _FORBIDDEN:
        raise ValueError(f"拒绝清理系统目录：{p}")
    if p.is_symlink() or not p.is_dir():
        raise ValueError(f"不是普通目录：{p}")
    return p


def audio_files(d):
    """返回目录本层的音频文件 [(mtime_ns, name, path)]，不递归、不跟随链接。"""
    base = _safe_dir(d)
    out = []
    with os.scandir(base) as it:
        for e in it:
            try:
                st = e.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(st.st_mode):          # 跳过目录、符号链接、设备等
                continue
            if Path(e.name).suffix.lower() not in AUDIO_EXTS:
                continue
            out.append((st.st_mtime_ns, e.name, Path(e.path)))
    out.sort(key=lambda x: (x[0], x[1]), reverse=True)  # 新 → 旧
    return out


def prune(d=DEFAULT_DIR, keep=KEEP, dry_run=False):
    """按修改时间保留最新 keep 条音频，删除更早的；返回被删文件名列表。目录不存在则什么也不做。"""
    if keep < 0:
        raise ValueError("keep 不能为负")
    if not Path(d).is_absolute():
        raise ValueError("音频目录必须是绝对路径")
    if not Path(d).exists():
        return []
    base = _safe_dir(d).resolve()
    removed = []
    for _, name, path in audio_files(base)[keep:]:
        if path.resolve().parent != base:                # 双保险：绝不跨目录
            continue
        if not dry_run:
            try:
                path.unlink()
            except FileNotFoundError:
                continue
        removed.append(name)
    return removed


def main(argv=None):
    ap = argparse.ArgumentParser(description="音频只保留最近 N 条")
    ap.add_argument("dirs", nargs="*", default=[DEFAULT_DIR])
    ap.add_argument("--keep", type=int, default=KEEP)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    rc = 0
    for d in a.dirs:
        try:
            gone = prune(d, a.keep, a.dry_run)
            print(f"{d}: 删除 {len(gone)} 条，保留最近 {a.keep} 条")
        except ValueError as e:
            print(f"{d}: 跳过（{e}）", file=sys.stderr)
            rc = 2
    return rc


if __name__ == "__main__":
    sys.exit(main())
