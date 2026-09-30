#!/usr/bin/env bash
# Build and publish the Relay image. Requires explicit publication authorization.
# Version comes from relay/package.json; build context is the workspace root.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-${REGISTRY_NAMESPACE:-pi-reach-local}/pi-reach-relay}"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER="multiarch"

for executable in node docker; do
  command -v "$executable" >/dev/null 2>&1 || { printf 'Required command not found: %s\n' "$executable" >&2; exit 127; }
done
VERSION="$(node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) process.exit(1); process.stdout.write(pkg.version);' "$ROOT_DIR/relay/package.json")"
TAG="v$VERSION"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi

docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  --file "$ROOT_DIR/relay/Dockerfile" \
  --tag "$IMAGE:$TAG" \
  --tag "$IMAGE:latest" \
  --push \
  "$ROOT_DIR"

printf 'Published %s:%s and %s:latest\n' "$IMAGE" "$TAG" "$IMAGE"
