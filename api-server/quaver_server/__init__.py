"""Quaver sidecar 包入口：把 vendor/QQMusicApi 注入 sys.path.

上游以 path 依赖安装（uv sync 时 editable 装进 venv），这里的注入只是兜底，
保证直接 `python run.py` 在未 sync 的 python 下也能 import 到 SDK。
"""

from __future__ import annotations

import sys
from pathlib import Path

_VENDOR = Path(__file__).resolve().parent.parent.parent / "vendor" / "QQMusicApi"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

# Typhoeus 播放后端核心（本 submodule 内）：以源码路径接入，免安装即可 `uv run run.py`
_TYPHOEUS = Path(__file__).resolve().parent.parent.parent / "vendor" / "Typhoeus"
if _TYPHOEUS.is_dir() and str(_TYPHOEUS) not in sys.path:
    sys.path.insert(0, str(_TYPHOEUS))
