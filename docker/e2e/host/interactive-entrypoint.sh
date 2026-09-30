#!/bin/sh
set -eu

export HOME="${HOME:-/home/pi}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$PI_CODING_AGENT_DIR/sessions}"
export PI_OFFLINE=1
export PI_TELEMETRY=0
export PI_REACH_ALLOW_FILE_IDENTITY=1

mkdir -p "$HOME/.pi/pi-reach" "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR" /workspace
cat > "$PI_CODING_AGENT_DIR/settings.json" <<'EOF'
{
  "packages": ["/opt/pi-reach"]
}
EOF

exec node /usr/local/bin/interactive-controller.mjs
