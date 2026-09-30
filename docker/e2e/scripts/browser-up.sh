#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
COMPOSE="$ROOT/docker/e2e/compose.yml"
PROJECT=pi-reach-e2e

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI is required.' >&2
  exit 127
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker Compose v2 is required.' >&2
  exit 127
fi

# Foreground mode lets Playwright own shutdown. Compose stops containers without
# deleting the named identity/session volumes when this process is terminated.
exec docker compose -p "$PROJECT" -f "$COMPOSE" up --build --remove-orphans relay interactive
