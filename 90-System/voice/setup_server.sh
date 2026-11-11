#!/usr/bin/env bash
# 一次性安装/升级语音边车（幂等）。不花钱：模型来自 Moonshine 官方 CDN（MIT），版本钉死并做 SHA256 校验。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_VER="0.1.6"
MODEL_URL="https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24"
MODEL_DIR=/opt/sb-voice/models/tiny-streaming-zh
install -d -m 755 /opt/sb-voice "$MODEL_DIR"
install -d -m 700 /var/lib/super-brain/audio
# Ubuntu 默认不带 venv/ensurepip（2026-11-11 部署时实际踩到），缺则装系统包（免费）
python3 -c "import ensurepip" 2>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-venv
if [ ! -x /opt/sb-voice/venv/bin/pip ]; then rm -rf /opt/sb-voice/venv; python3 -m venv /opt/sb-voice/venv; fi
/opt/sb-voice/venv/bin/pip install -q --disable-pip-version-check "moonshine-voice==${PKG_VER}"
cd "$MODEL_DIR"
while read -r sum name; do
  if ! echo "$sum  $name" | sha256sum -c --status 2>/dev/null; then
    curl -fsSL --retry 3 -o "$name.part" "$MODEL_URL/$name"
    mv "$name.part" "$name"
  fi
done < "$HERE/model-tiny-streaming-zh.sha256"
sha256sum -c "$HERE/model-tiny-streaming-zh.sha256"
install -m 644 "$HERE/sb-stt.service" "$HERE/sb-audio-prune.service" "$HERE/sb-audio-prune.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sb-audio-prune.timer
systemctl enable sb-stt.service
systemctl restart sb-stt.service
