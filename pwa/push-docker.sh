#!/usr/bin/env bash
# Build a multi-platform image and push it to Docker Hub.
#
# Usage:
#   ./push-docker.sh              → tags as :latest
#   ./push-docker.sh v1.2.3       → tags as :v1.2.3 AND :latest
#
# Requirements:
#   docker buildx (bundled with modern Docker).
#   Log in first with: docker login

set -euo pipefail

IMAGE="${IMAGE:-${REGISTRY_NAMESPACE:-pi-reach-local}/pi-reach-pwa}"
VERSION="${1:-}"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER="multiarch"

# 共享锁文件位于仓库根；Dockerfile 仍保留在 pwa/。
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# The default `docker` driver cannot build multi-platform images in one shot.
# Ensure a `docker-container` builder exists and is selected. Idempotent.
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "→ Creating buildx builder '$BUILDER' (docker-container driver)"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi
docker buildx use "$BUILDER"

if [[ -n "$VERSION" ]]; then
  TAGS="--tag $IMAGE:$VERSION --tag $IMAGE:latest"
  echo "→ Building $IMAGE:$VERSION + :latest ($PLATFORMS)"
else
  TAGS="--tag $IMAGE:latest"
  echo "→ Building $IMAGE:latest ($PLATFORMS)"
fi

# shellcheck disable=SC2086
docker buildx build \
  --platform "$PLATFORMS" \
  $TAGS \
  --push \
  --file "$ROOT_DIR/pwa/Dockerfile" \
  "$ROOT_DIR"

echo "✓ Done"
