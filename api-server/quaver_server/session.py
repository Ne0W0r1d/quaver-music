"""Quaver 本地 API sidecar — 基于 L-1124/QQMusicApi 的薄适配层.

会话/凭证持久化：
- credential 存 ~/.config/quaver/credential.json（0600），QR 登录 DONE 时由服务端写入，
  token 不落浏览器（与旧版 session.txt 同思路，但格式换成 SDK 的 Credential JSON）。
- device.json 存 ~/.local/state/quaver/device.json（SDK 的设备指纹，跨重启保号）。
"""

from __future__ import annotations

import json
import logging
import os
import stat
import tempfile
import threading
from pathlib import Path

from qqmusic_api import Client, Credential
from qqmusic_api.core.exceptions import CredentialInvalidError

logger = logging.getLogger("quaver.session")


def _xdg(base_env: str, default: str) -> Path:
    return Path(os.environ.get(base_env, str(Path.home() / default))).expanduser()


CREDENTIAL_PATH = _xdg("XDG_CONFIG_HOME", ".config") / "quaver" / "credential.json"
DEVICE_PATH = _xdg("XDG_STATE_HOME", ".local/state") / "quaver" / "device.json"


def credential_has_login(credential: Credential) -> bool:
    """Credential 是否含可用登录信息（同上游 web 层判定）."""
    return credential.musicid > 0 and bool(credential.musickey)


def _load_credential_from_disk() -> Credential:
    try:
        raw = CREDENTIAL_PATH.read_text(encoding="utf-8").strip()
        if not raw:
            return Credential()
        cred = Credential.model_validate_json(raw)
        if credential_has_login(cred):
            logger.info("已加载登录凭证 musicid=%s", cred.musicid)
            return cred
    except FileNotFoundError:
        pass
    except Exception:
        logger.exception("凭证文件解析失败，按未登录处理: %s", CREDENTIAL_PATH)
        try:
            CREDENTIAL_PATH.unlink()
        except OSError:
            pass
    return Credential()


def save_credential(credential: Credential) -> None:
    """持久化凭证（原子写 + 0600）."""
    CREDENTIAL_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=CREDENTIAL_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(credential.model_dump_json())
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, CREDENTIAL_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def clear_credential() -> None:
    try:
        CREDENTIAL_PATH.unlink()
    except FileNotFoundError:
        pass


class Session:
    """进程级 SDK Client 封装（凭证变更集中处理）."""

    def __init__(self) -> None:
        DEVICE_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = threading.RLock()
        self.client = Client(credential=_load_credential_from_disk(), device_path=str(DEVICE_PATH))

    @property
    def credential(self) -> Credential:
        return self.client.credential

    @property
    def logged_in(self) -> bool:
        return credential_has_login(self.client.credential)

    def require(self) -> Credential:
        cred = self.client.credential
        if not credential_has_login(cred):
            raise CredentialInvalidError("需要登录：请先在应用内扫码登录")
        return cred

    def adopt(self, credential: Credential) -> None:
        """登录成功后写入新凭证（内存 + 磁盘）."""
        with self._lock:
            self.client.credential = credential
            save_credential(credential)
            logger.info("登录凭证已更新 musicid=%s", credential.musicid)

    async def logout(self) -> None:
        with self._lock:
            if self.logged_in:
                try:
                    await self.client.login.logout()
                except Exception:
                    logger.warning("上游登出失败，仅清除本地凭证", exc_info=True)
            clear_credential()
            self.client.credential = Credential()


session = Session()


def self_euin() -> str:
    """当前账号的加密 UIN / 字符串 UIN（收藏歌单等接口的主键）."""
    cred = session.require()
    return cred.encrypt_uin or cred.str_musicid or str(cred.musicid)
