#!/usr/bin/env bash
# 仅供本地开发；不改变 Pi Reach 的安装方式或产品入口。
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/pi-dev/launcher.mjs" "$@"
