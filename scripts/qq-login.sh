#!/usr/bin/env bash
# Quaver — QQ 音乐扫码登录助手
# 在终端渲染二维码（qrencode + zbarimg），扫码成功后把会话 token 存到
# ~/.config/quaver/session.txt（权限 600），供 curl / dev server 复用。
#
# 用法:  ./scripts/qq-login.sh [qq|wechat]
# 依赖:  curl jq qrencode zbarimg;  本地 API 已在 :3200 运行
set -euo pipefail

CHANNEL="${1:-qq}"
BASE="${QUAVER_API:-http://localhost:3200}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/quaver"
mkdir -p "$CONF"; chmod 700 "$CONF"

command -v qrencode >/dev/null && command -v zbarimg >/dev/null || {
  echo "缺依赖: sudo dnf install qrencode zbar"; exit 1; }

# 登录态加密提示：session.txt 是敏感凭证（等同已登录 Web 会话）。
# 正式客户端应接 KSecretsService/KDE Wallet；此处 600 权限仅开发用。

echo "[1/4] 请求 QR key ..."
UNIKEY=$(curl -sf -m 15 "$BASE/login/qr/key?channel=$CHANNEL" | jq -r .data.unikey) \
  || { echo "key 失败（服务没起？被 429 backoff？等 90s 重试）"; exit 1; }

echo "[2/4] 拉取二维码 ..."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -sf -m 15 "$BASE/login/qr/create?key=$UNIKEY" \
  | jq -r .data.qrimg \
  | sed 's/^data:image\/[a-z]*;base64,//' \
  | base64 -d > "$TMP/qr.png"
zbarimg -q --raw "$TMP/qr.png" > "$TMP/url"

clear 2>/dev/null || true
echo "请用 ${CHANNEL} 客户端扫码（码有效期约 2 分钟）:"
echo
qrencode -t ansiutf8 < "$TMP/url"
echo
echo "[3/4] 等待扫码 ..."

for _ in $(seq 1 80); do
  STATE=$(curl -s -m 10 "$BASE/login/qr/check?key=$UNIKEY" | tee "$TMP/chk.json" | jq -r .code)
  case "$STATE" in
    803)
      TOKEN=$(jq -r '.cookie // empty' "$TMP/chk.json" | sed 's/^qqmusic_session=//')
      if [ -n "$TOKEN" ]; then
        printf '%s' "$TOKEN" > "$CONF/session.txt"; chmod 600 "$CONF/session.txt"
        echo
        echo "[4/4] ✅ 登录成功，token 已存 $CONF/session.txt"
        echo "验证: curl -H \"cookie: qqmusic_session=\$(cat $CONF/session.txt)\" $BASE/user/detail | jq .profile.info.nick"
        exit 0
      fi
      echo "803 但没拿到 token，响应: $(cat "$TMP/chk.json")"; exit 1 ;;
    800) echo "❌ 二维码过期/失效，重跑本脚本"; exit 1 ;;
    802) printf '.' ;;
    801) printf '.' ;;
    *)   echo "意外状态: $(cat "$TMP/chk.json")"; exit 1 ;;
  esac
  sleep 2
done
echo "超时"; exit 1
