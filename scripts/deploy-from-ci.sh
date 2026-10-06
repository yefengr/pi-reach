#!/usr/bin/env bash
# Restricted SSH entry point. Only the server's fixed command selects the write environment.
# Requests: deploy <pwa|relay> <versioned image@digest>, snapshot <production|staging>.
set -Eeuo pipefail

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
info() { printf '→ %s\n' "$*" >&2; }
warn() { printf '! %s\n' "$*" >&2; }

REMOTE_DIR="${PI_REACH_REMOTE_DIR:-}"
IMAGE_PREFIX="${PI_REACH_IMAGE_PREFIX:-}"
ENVIRONMENT="${PI_REACH_DEPLOY_ENVIRONMENT-production}"
KEEP_IMAGE_VERSIONS="${PI_REACH_KEEP_IMAGE_VERSIONS:-3}"
HEALTH_ATTEMPTS="${PI_REACH_HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${PI_REACH_HEALTH_INTERVAL:-2}"
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "PI_REACH_REMOTE_DIR must be an absolute path without shell metacharacters"
[[ "$IMAGE_PREFIX" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+$ ]] || fail "PI_REACH_IMAGE_PREFIX must look like registry/namespace"
[[ "$KEEP_IMAGE_VERSIONS" =~ ^[0-9]+$ ]] || fail "PI_REACH_KEEP_IMAGE_VERSIONS must be a non-negative integer"
[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "PI_REACH_HEALTH_ATTEMPTS must be a positive integer"
[[ "$HEALTH_INTERVAL" =~ ^[0-9]+$ ]] || fail "PI_REACH_HEALTH_INTERVAL must be a non-negative integer"
case "$ENVIRONMENT" in
  production) PRODUCTION_DIR="$REMOTE_DIR"; PROJECT=pi-reach ;;
  staging)
    PRODUCTION_DIR="${PI_REACH_PRODUCTION_DIR:-}"
    [[ "$PRODUCTION_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "PI_REACH_PRODUCTION_DIR must be an absolute path"
    PROJECT=pi-reach-staging ;;
  *) fail "Unknown deployment environment" ;;
esac
# Resolve aliases before choosing locks, so symlinks and /../ cannot evade serialization.
REMOTE_DIR="$(cd "$REMOTE_DIR" && pwd -P)" || fail "Deployment directory does not exist"
PRODUCTION_DIR="$(cd "$PRODUCTION_DIR" && pwd -P)" || fail "Production directory does not exist"
if [[ "$ENVIRONMENT" == staging && "$REMOTE_DIR" == "$PRODUCTION_DIR" ]]; then
  fail "Staging directory must differ from production"
fi

reject() { fail "Rejected request. Expected: deploy <pwa|relay> <versioned image@digest> or snapshot <production|staging>"; }
# Do not let read's first-line behavior silently accept a second command.
[[ "${SSH_ORIGINAL_COMMAND:-}" != *$'\n'* && "${SSH_ORIGINAL_COMMAND:-}" != *$'\r'* ]] || reject
read -r -a REQUEST <<< "${SSH_ORIGINAL_COMMAND:-}" || true
ACTION="${REQUEST[0]:-}"
if [[ "$ACTION" == snapshot ]]; then
  (( ${#REQUEST[@]} == 2 )) || reject
  case "${REQUEST[1]}" in
    production) SNAPSHOT_PROJECT=pi-reach ;;
    staging) SNAPSHOT_PROJECT=pi-reach-staging ;;
    *) reject ;;
  esac
else
  (( ${#REQUEST[@]} == 3 )) || reject
  [[ "$ACTION" == deploy ]] || reject
  SERVICE="${REQUEST[1]}"
  case "$SERVICE" in pwa|relay) ;; *) reject ;; esac
  CONTAINER="$PROJECT-$SERVICE"
  IMAGE="${REQUEST[2]}"
  REPOSITORY="$IMAGE_PREFIX/pi-reach-$SERVICE"
  [[ "${IMAGE%%:*}" == "$REPOSITORY" ]] || reject
  TAG_AND_DIGEST="${IMAGE#"$REPOSITORY":}"
  TAG="${TAG_AND_DIGEST%%@*}"
  DIGEST="${TAG_AND_DIGEST#*@}"
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || reject
  [[ "$IMAGE" == "$REPOSITORY:$TAG@$DIGEST" ]] || reject
  TARGET="$REPOSITORY@$DIGEST"
  VERSION_REF="$REPOSITORY:$TAG"
  [[ -f "$REMOTE_DIR/docker-compose.yml" ]] || fail "Missing Compose file; run a local deployment once to upload it"
fi

LOCKS=()
TEMPLATE=""
cleanup() {
  local index
  [[ -z "$TEMPLATE" ]] || rm -f "$TEMPLATE"
  for (( index=${#LOCKS[@]}-1; index>=0; index-- )); do
    rmdir "${LOCKS[$index]}" 2>/dev/null || warn "Unable to release deployment lock"
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
acquire_lock() {
  local lock="$1/.pi-reach-deploy-lock"
  mkdir "$lock" 2>/dev/null || fail "Concurrent deployment rejected: lock exists. Verify no deployment is running before removing it manually."
  LOCKS+=("$lock")
}
acquire_lock "$PRODUCTION_DIR"
if [[ "$ACTION" == deploy && "$ENVIRONMENT" == staging ]]; then acquire_lock "$REMOTE_DIR"; fi

snapshot_component() {
  local service="$1" container="$SNAPSHOT_PROJECT-$1" id version revision digests digest="" ref repository
  repository="$IMAGE_PREFIX/pi-reach-$service"
  [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null)" == healthy ]] || fail "Snapshot requires both healthy containers"
  id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || fail "Snapshot container is missing"
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "Snapshot image ID is invalid"
  version="$(docker image inspect --format '{{with index .Config.Labels "org.opencontainers.image.version"}}{{.}}{{end}}' "$id" 2>/dev/null)" || fail "Snapshot image metadata is missing"
  version="${version#v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Snapshot requires a version label on the actual image"
  revision="$(docker image inspect --format '{{with index .Config.Labels "org.opencontainers.image.revision"}}{{.}}{{end}}' "$id" 2>/dev/null)" || fail "Snapshot revision is missing"
  [[ -z "$revision" || "$revision" =~ ^[a-f0-9]{40,64}$ ]] || fail "Snapshot revision is invalid"
  digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$id" 2>/dev/null)" || fail "Snapshot digest metadata is missing"
  while IFS= read -r ref; do
    [[ "$ref" == "$repository@"* ]] || continue
    ref="${ref#"$repository@"}"
    [[ "$ref" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "Snapshot digest is invalid"
    [[ -z "$digest" || "$digest" == "$ref" ]] || fail "Snapshot digest is ambiguous"
    digest="$ref"
  done <<< "$digests"
  [[ -n "$digest" ]] || fail "Snapshot requires a digest from the allowed repository"
  printf '{"image":"%s:v%s@%s","revision":"%s"}' "$repository" "$version" "$digest" "$revision"
}
if [[ "$ACTION" == snapshot ]]; then
  RELAY_METADATA="$(snapshot_component relay)"
  PWA_METADATA="$(snapshot_component pwa)"
  printf '{"relay":%s,"pwa":%s}\n' "$RELAY_METADATA" "$PWA_METADATA"
  exit 0
fi

# This is a strict deployment contract, mirrored by root/staging Compose tests.
# Compare Compose's complete normalized model; never parse YAML/JSON or print resolved settings.
# Disable ambient .env overrides: public staging parameters come from the fixed server environment.
trusted_compose() {
  local relay_port=3000 pwa_port=3001
  if [[ "$ENVIRONMENT" == staging ]]; then relay_port=3002; pwa_port=3003; fi
  printf 'name: %s\n\nservices:\n  relay:\n' "$PROJECT"
  cat <<'EOF'
    image: ${RELAY_IMAGE:?RELAY_IMAGE must be set}
EOF
  printf '    container_name: %s-relay\n    restart: unless-stopped\n\n    ports:\n      - "127.0.0.1:%s:3000"\n\n' "$PROJECT" "$relay_port"
  cat <<'EOF'
    environment:
      PI_REACH_RELAY_PORT: "3000"

    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
EOF
  if [[ "$ENVIRONMENT" == staging ]]; then
    cat <<'EOF'
    cpus: ${PI_REACH_STAGING_RELAY_CPUS:?staging Relay CPU limit is required}
    mem_limit: ${PI_REACH_STAGING_RELAY_MEMORY:?staging Relay memory limit is required}
    pids_limit: ${PI_REACH_STAGING_RELAY_PIDS_LIMIT:?staging Relay PID limit is required}
EOF
  fi
  cat <<'EOF'

  pwa:
    image: ${PWA_IMAGE:?PWA_IMAGE must be set}
EOF
  printf '    container_name: %s-pwa\n    restart: unless-stopped\n\n    ports:\n      - "127.0.0.1:%s:3000"\n\n' "$PROJECT" "$pwa_port"
  cat <<'EOF'
    environment:
      PORT: "3000"
EOF
  if [[ "$ENVIRONMENT" == staging ]]; then
    cat <<'EOF'
      PI_REACH_DEFAULT_RELAY_URL: ${PI_REACH_DEFAULT_RELAY_URL:?staging public Relay URL is required}
EOF
  fi
  cat <<'EOF'

    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
EOF
  if [[ "$ENVIRONMENT" == staging ]]; then
    cat <<'EOF'
    cpus: ${PI_REACH_STAGING_PWA_CPUS:?staging PWA CPU limit is required}
    mem_limit: ${PI_REACH_STAGING_PWA_MEMORY:?staging PWA memory limit is required}
    pids_limit: ${PI_REACH_STAGING_PWA_PIDS_LIMIT:?staging PWA PID limit is required}
EOF
  fi
}
compose_with() {
  local image="$1" file="$2"
  shift 2
  local relay_image=invalid.invalid/pi-reach-relay-unselected:never pwa_image=invalid.invalid/pi-reach-pwa-unselected:never
  if [[ "$SERVICE" == relay ]]; then relay_image="$image"; else pwa_image="$image"; fi
  (cd "$REMOTE_DIR" && unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES &&
    RELAY_IMAGE="$relay_image" PWA_IMAGE="$pwa_image" docker-compose --env-file /dev/null --project-directory "$REMOTE_DIR" -f "$file" "$@")
}
TEMPLATE="$(mktemp "$REMOTE_DIR/.pi-reach-compose-contract.XXXXXX")"
trusted_compose > "$TEMPLATE"
ACTUAL="$(compose_with "$TARGET" "$REMOTE_DIR/docker-compose.yml" config --format json 2>/dev/null)" || fail "Unable to parse Compose configuration"
EXPECTED="$(compose_with "$TARGET" "$TEMPLATE" config --format json 2>/dev/null)" || fail "Required deployment configuration is missing or invalid"
[[ "$ACTUAL" == "$EXPECTED" ]] || fail "Compose configuration does not match the deployment environment contract"
unset ACTUAL EXPECTED

wait_for_health() {
  local state attempt
  info "Waiting for $SERVICE health check"
  for (( attempt=1; attempt<=HEALTH_ATTEMPTS; attempt++ )); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER" 2>/dev/null || true)"
    [[ "$state" == healthy ]] && return 0
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}
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
    repo="${ref%:*}"; deployed="${ref##*:}"
    while IFS='|' read -r tag id; do
      [ -n "$tag" ] || continue
      if printf '%s\n' "$in_use" | grep -qxF "$id"; then continue; fi
      docker rmi "$repo:$tag" >/dev/null && removed=$((removed + 1))
    done < <(docker images --no-trunc --format '{{.CreatedAt}}|{{.Tag}}|{{.ID}}' "$repo" | LC_ALL=C sort -r |
      awk -F'|' -v keep="$keep" -v deployed="$deployed" '$2 == deployed { next } kept < keep - 1 { kept++; next } { print $2 "|" $3 }')
  done
  for id in $(docker images --no-trunc --quiet --filter dangling=true --filter "label=pi-reach.image"); do
    if printf '%s\n' "$in_use" | grep -qxF "$id"; then continue; fi
    docker rmi "$id" >/dev/null && removed=$((removed + 1))
  done
  printf '%s\n' "$removed"
}
PREVIOUS="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
[[ -z "$PREVIOUS" || "$PREVIOUS" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "Current container image ID is invalid"
info "Deploying $SERVICE: $TARGET"
docker pull --quiet "$TARGET" >/dev/null
# 初始化时旧生产 PWA 不能被启动到 staging 后误连生产 Relay。
if [[ "$ENVIRONMENT" == staging && "$SERVICE" == pwa ]]; then
  capability="$(docker image inspect --format '{{with index .Config.Labels "pi-reach.runtime-config"}}{{.}}{{end}}' "$TARGET" 2>/dev/null)" || fail "Unable to verify PWA runtime configuration capability"
  [[ "$capability" == 1 ]] || fail "Staging PWA requires a runtime-config-capable candidate; select PWA for the first release"
fi
docker tag "$TARGET" "$VERSION_REF"
# Version tags are housekeeping metadata only, never the runtime/rollback source of truth.
if ! compose_with "$TARGET" "$REMOTE_DIR/docker-compose.yml" up -d --pull never "$SERVICE" || ! wait_for_health; then
  [[ -n "$PREVIOUS" ]] || fail "$SERVICE failed and there is no earlier image to restore"
  warn "$SERVICE failed; restoring $PREVIOUS"
  if compose_with "$PREVIOUS" "$REMOTE_DIR/docker-compose.yml" up -d --pull never "$SERVICE" && wait_for_health; then
    fail "Deployment of $TARGET failed; $SERVICE was restored to $PREVIOUS"
  fi
  fail "Deployment failed and restoring $PREVIOUS did not become healthy; check the server now"
fi
compose_with "$TARGET" "$REMOTE_DIR/docker-compose.yml" ps "$SERVICE" >&2
if [[ "$ENVIRONMENT" == production ]] && (( KEEP_IMAGE_VERSIONS > 0 )); then
  if pruned="$(prune_images "$KEEP_IMAGE_VERSIONS" "$VERSION_REF")"; then
    info "Removed ${pruned:-0} old image(s)"
  else
    warn "Image pruning failed; the deployment itself succeeded"
  fi
fi
printf '✓ Deployed %s %s\n' "$SERVICE" "$IMAGE"
