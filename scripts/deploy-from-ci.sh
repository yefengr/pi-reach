#!/usr/bin/env bash
# Server-side entry point for the Deploy workflow, reached only through a restricted SSH key.
# authorized_keys forces this script with restrict and command=, and sets in that command:
#   PI_REACH_REMOTE_DIR    deployment directory holding docker-compose.yml (the same REMOTE_DIR as local deploys)
#   PI_REACH_IMAGE_PREFIX  image prefix allowed to deploy, such as ghcr.io/<owner>
# The client request arrives in SSH_ORIGINAL_COMMAND and must be exactly:
#   deploy <pwa|relay> <PI_REACH_IMAGE_PREFIX>/pi-reach-<pwa|relay>:vX.Y.Z@sha256:<digest>
# The image is pulled by digest and tagged with its version, then only that service is updated;
# if it never becomes healthy the previous image is restored and the script fails.
# Shares the deployment lock with scripts/deploy-self-hosted.sh and never changes Caddy or docker-compose.yml.
# Installation and configuration: docs/DEPLOYMENT.md, "自动部署".

set -Eeuo pipefail

fail() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

info() {
  printf '→ %s\n' "$*"
}

warn() {
  printf '! %s\n' "$*" >&2
}

REMOTE_DIR="${PI_REACH_REMOTE_DIR:-}"
IMAGE_PREFIX="${PI_REACH_IMAGE_PREFIX:-}"
KEEP_IMAGE_VERSIONS="${PI_REACH_KEEP_IMAGE_VERSIONS:-3}"
HEALTH_ATTEMPTS="${PI_REACH_HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${PI_REACH_HEALTH_INTERVAL:-2}"

[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "PI_REACH_REMOTE_DIR must be an absolute path without shell metacharacters"
[[ "$IMAGE_PREFIX" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+$ ]] || fail "PI_REACH_IMAGE_PREFIX must look like registry/namespace"
[[ "$KEEP_IMAGE_VERSIONS" =~ ^[0-9]+$ ]] || fail "PI_REACH_KEEP_IMAGE_VERSIONS must be a non-negative integer"
[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "PI_REACH_HEALTH_ATTEMPTS must be a positive integer"
[[ "$HEALTH_INTERVAL" =~ ^[0-9]+$ ]] || fail "PI_REACH_HEALTH_INTERVAL must be a non-negative integer"

reject() {
  fail "Rejected request. Expected: deploy <pwa|relay> $IMAGE_PREFIX/pi-reach-<pwa|relay>:vX.Y.Z@sha256:<digest>"
}

# Split on whitespace only, never evaluated by a shell; any extra word or format deviation is rejected.
read -r -a REQUEST <<< "${SSH_ORIGINAL_COMMAND:-}" || true
(( ${#REQUEST[@]} == 3 )) || reject
[[ "${REQUEST[0]}" == deploy ]] || reject
SERVICE="${REQUEST[1]}"
IMAGE="${REQUEST[2]}"
case "$SERVICE" in
  pwa) CONTAINER=pi-reach-pwa ;;
  relay) CONTAINER=pi-reach-relay ;;
  *) reject ;;
esac
REPOSITORY="$IMAGE_PREFIX/pi-reach-$SERVICE"
[[ "${IMAGE%%:*}" == "$REPOSITORY" ]] || reject
TAG_AND_DIGEST="${IMAGE#"$REPOSITORY":}"
TAG="${TAG_AND_DIGEST%%@*}"
DIGEST="${TAG_AND_DIGEST#*@}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || reject
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || reject
[[ "$IMAGE" == "$REPOSITORY:$TAG@$DIGEST" ]] || reject
TARGET="$REPOSITORY:$TAG"

[[ -f "$REMOTE_DIR/docker-compose.yml" ]] || fail "Missing $REMOTE_DIR/docker-compose.yml; run a local deployment once to upload it"

LOCK_DIR="$REMOTE_DIR/.pi-reach-deploy-lock"
mkdir "$LOCK_DIR" 2>/dev/null || fail "Concurrent deployment rejected: lock $LOCK_DIR exists. Verify no deployment is running before removing it manually."
release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || warn "Unable to release deployment lock $LOCK_DIR"
}
trap release_lock EXIT

# Compose needs both image variables to parse; the other service gets a placeholder it never starts.
compose_with() {
  local image="$1"
  shift
  local relay_image=invalid.invalid/pi-reach-relay-unselected:never
  local pwa_image=invalid.invalid/pi-reach-pwa-unselected:never
  if [[ "$SERVICE" == relay ]]; then relay_image="$image"; else pwa_image="$image"; fi
  (cd "$REMOTE_DIR" && RELAY_IMAGE="$relay_image" PWA_IMAGE="$pwa_image" docker-compose "$@")
}

wait_for_health() {
  local state attempt
  info "Waiting for $SERVICE health check"
  for (( attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++ )); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER" 2>/dev/null || true)"
    [[ "$state" == healthy ]] && return 0
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# Same as prune_images in deploy-self-hosted.sh: keep the deployed tag plus the newest other tags of its
# repository, KEEP in total, then remove older tags and untagged images labelled pi-reach.image. Images used
# by any container are never removed. Prints the number of removed images.
prune_images() {
  local keep="$1"
  shift
  local containers in_use="" ref repo deployed tag id removed=0
  containers="$(docker ps -aq)"
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086
    in_use="$(docker inspect --format '{{.Image}}' $containers | sort -u)"
  fi
  for ref in "$@"; do
    repo="${ref%:*}"
    deployed="${ref##*:}"
    while IFS='|' read -r tag id; do
      [ -n "$tag" ] || continue
      if printf '%s\n' "$in_use" | grep -qxF "$id"; then continue; fi
      docker rmi "$repo:$tag" >/dev/null && removed=$((removed + 1))
    done < <(docker images --no-trunc --format '{{.CreatedAt}}|{{.Tag}}|{{.ID}}' "$repo" \
      | LC_ALL=C sort -r \
      | awk -F'|' -v keep="$keep" -v deployed="$deployed" '
          $2 == deployed { next }
          kept < keep - 1 { kept++; next }
          { print $2 "|" $3 }')
  done
  for id in $(docker images --no-trunc --quiet --filter dangling=true --filter "label=pi-reach.image"); do
    if printf '%s\n' "$in_use" | grep -qxF "$id"; then continue; fi
    docker rmi "$id" >/dev/null && removed=$((removed + 1))
  done
  printf '%s\n' "$removed"
}

info "Deploying $SERVICE: $TARGET ($DIGEST)"
PREVIOUS="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
info "Current $SERVICE image: ${PREVIOUS:-none}"

info "Pulling image by digest"
docker pull --quiet "$REPOSITORY@$DIGEST" >/dev/null
docker tag "$REPOSITORY@$DIGEST" "$TARGET"

info "Validating Compose configuration"
compose_with "$TARGET" config --quiet || fail "Unable to parse $REMOTE_DIR/docker-compose.yml"

info "Updating service: $SERVICE"
compose_with "$TARGET" up -d --pull never --remove-orphans "$SERVICE"
if ! wait_for_health; then
  compose_with "$TARGET" logs --tail=80 "$SERVICE" || true
  if [[ -z "$PREVIOUS" || "$PREVIOUS" == "$TARGET" ]]; then
    fail "$SERVICE is not healthy and there is no earlier image to restore"
  fi
  warn "$SERVICE is not healthy; restoring $PREVIOUS"
  compose_with "$PREVIOUS" up -d --pull never --remove-orphans "$SERVICE"
  if wait_for_health; then
    fail "Deployment of $TARGET failed; $SERVICE was restored to $PREVIOUS"
  fi
  fail "Deployment of $TARGET failed and restoring $PREVIOUS did not become healthy; check the server now"
fi
compose_with "$TARGET" ps "$SERVICE"

# Pruning is housekeeping: a failure is reported but never fails a deployment that is already live.
if (( KEEP_IMAGE_VERSIONS > 0 )); then
  info "Pruning images older than the newest $KEEP_IMAGE_VERSIONS"
  if pruned="$(prune_images "$KEEP_IMAGE_VERSIONS" "$TARGET")"; then
    info "Removed ${pruned:-0} old image(s)"
  else
    warn "Image pruning failed; the deployment itself succeeded"
  fi
fi
printf '✓ Deployed %s %s\n' "$SERVICE" "$TARGET"
