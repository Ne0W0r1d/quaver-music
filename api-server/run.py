"""Quaver sidecar 启动器：`uv run run.py` → http://127.0.0.1:3200（QUAVER_PORT 可覆盖）。"""

from __future__ import annotations

import logging
import os

import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s")

if __name__ == "__main__":
    uvicorn.run(
        "quaver_server.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=int(os.environ.get("QUAVER_PORT", "3200")),
        log_level="info",
        access_log=False,
    )
