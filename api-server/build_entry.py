# PyInstaller 入口：冻结版 quaver-server。
# uvicorn.run 的 import-string 工厂在冻结环境不可靠，改用直接对象引用 + 手动 loop。
import asyncio
import logging

import uvicorn

from quaver_server.app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s")

if __name__ == "__main__":
    import os

    app = create_app()
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("QUAVER_PORT", "3200")),
        log_level="info",
        access_log=False,
    )
    server = uvicorn.Server(config)
    asyncio.run(server.serve())
