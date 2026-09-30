#!/usr/bin/env bash
#
# Pi Reach Extension bootstrap installer
#
#   bash pi-extension/install.sh
#
# This script installs Node and Pi in user-writable locations when needed, then
# installs the Pi Reach Extension into Pi. It does not create, start, stop, or
# remove operating-system services.
#
set -euo pipefail

MIN_NODE="20.6.0"
NODE_LTS="22"
PI_PKG="@earendil-works/pi-coding-agent"
PLUGIN_SPEC="npm:@yefengr/pi-reach"
USER_PREFIX="$HOME/.local"
LOCAL_BIN="$USER_PREFIX/bin"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi

step() { printf '%s\n' "${BLU}${BOLD}==>${RST} ${BOLD}$*${RST}"; }
info() { printf '%s\n' "    $*"; }
ok() { printf '%s\n' "    ${GRN}ok${RST} $*"; }
warn() { printf '%s\n' "    ${YLW}warning${RST} $*"; }
die() { printf '%s\n' "${RED}error:${RST} $*" >&2; exit 1; }

version_gte() {
  [ "$1" = "$2" ] && return 0
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

detect_os() {
  case "${OS:-}" in Windows_NT) echo "windows"; return ;; esac
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

ensure_local_bin_on_path() {
  mkdir -p "$LOCAL_BIN"
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) export PATH="$LOCAL_BIN:$PATH" ;;
  esac
}

ensure_node() {
  step "Checking Node.js (need >= $MIN_NODE)"
  if command -v node >/dev/null 2>&1; then
    local have
    have="$(node -v 2>/dev/null | sed 's/^v//')"
    if [ -n "$have" ] && version_gte "$have" "$MIN_NODE"; then
      ok "using Node v$have"
      return
    fi
  fi

  info "installing Node $NODE_LTS with nvm"
  unset npm_config_prefix 2>/dev/null || true
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_LTS" >/dev/null
  nvm use "$NODE_LTS" >/dev/null
  local installed
  installed="$(node -v | sed 's/^v//')"
  version_gte "$installed" "$MIN_NODE" || die "installed Node v$installed is older than $MIN_NODE"
  ok "installed Node v$installed"
}

ensure_pi() {
  step "Installing Pi coding agent"
  if command -v pi >/dev/null 2>&1; then
    ok "Pi is already available"
    return
  fi
  info "npm install -g --prefix $USER_PREFIX $PI_PKG"
  npm install -g --prefix "$USER_PREFIX" "$PI_PKG" >/dev/null
  command -v pi >/dev/null 2>&1 || die "Pi installed but is not available on PATH"
  ok "installed Pi"
}

install_extension() {
  step "Installing Pi Reach Extension"
  pi install "$PLUGIN_SPEC" >/dev/null
  ok "installed Pi Reach Extension"
}

print_next_steps() {
  cat <<EOF

${GRN}${BOLD}Pi Reach Extension is installed.${RST}

Open Pi in the project you want to control. The Extension connects to the Relay
when the Pi session starts; run ${BOLD}/pi-reach pair${RST} to pair a browser device.

EOF
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) warn "open a new shell so pi is available on PATH" ;;
  esac
}

main() {
  local os
  os="$(detect_os)"
  [ "$os" != "windows" ] || die "use WSL to install Pi Reach"
  [ "$os" != "unknown" ] || die "unsupported platform"
  ensure_local_bin_on_path
  ensure_node
  ensure_pi
  install_extension
  print_next_steps
}

main "$@"
