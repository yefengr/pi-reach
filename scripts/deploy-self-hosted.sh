#!/usr/bin/env bash
# Deploy Pi Reach to its single self-hosted environment for a selected service scope:
# build the selected images locally, transfer them over SSH, update only the matching services,
# then prune older images of those services locally and on the server.
# Caddy is intentionally untouched.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG:-$ROOT_DIR/deploy.env}"
readonly DEPLOY_CONFIG_WAS_SET="${DEPLOY_CONFIG+x}"
readonly DEPLOY_CONFIG_VALUE="${DEPLOY_CONFIG-}"
readonly BUILDER_WAS_SET="${BUILDER+x}"
readonly BUILDER_VALUE="${BUILDER-}"
readonly CLI_SCOPE="${1:-both}"

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

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-self-hosted.sh [pwa|relay|both]

Defaults:
  scope   both

Builds the selected images locally, transfers them over SSH and updates the matching services.
EOF
}

case "$CLI_SCOPE" in
  -h|--help) usage; exit 0 ;;
esac

[[ -f "$CONFIG_FILE" ]] || fail "Missing deployment config: $CONFIG_FILE (copy deploy.env.example to deploy.env)"
# shellcheck disable=SC1090
source "$CONFIG_FILE"

# Command-line choices and explicitly exported runner settings always win over deploy.env.
SCOPE="$CLI_SCOPE"
if [[ "$DEPLOY_CONFIG_WAS_SET" == x ]]; then
  DEPLOY_CONFIG="$DEPLOY_CONFIG_VALUE"
fi
if [[ "$BUILDER_WAS_SET" == x ]]; then
  BUILDER="$BUILDER_VALUE"
else
  BUILDER="${BUILDER:-multiarch}"
fi

if (( $# > 1 )); then
  usage >&2
  exit 2
fi
case "$SCOPE" in
  pwa|relay|both) ;;
  *) usage >&2; exit 2 ;;
esac

: "${DEPLOY_SSH:?DEPLOY_SSH is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${REMOTE_DIR:?REMOTE_DIR is required}"
: "${IMAGE_NAMESPACE:?IMAGE_NAMESPACE is required}"
if [[ "$SCOPE" == relay || "$SCOPE" == both ]]; then
  : "${RELAY_VERSION:?RELAY_VERSION is required for relay scope}"
fi
if [[ "$SCOPE" == pwa || "$SCOPE" == both ]]; then
  if [[ -n "${SITE_VERSION:-}" && -z "${PWA_VERSION:-}" ]]; then
    fail "SITE_VERSION was renamed to PWA_VERSION; update $CONFIG_FILE"
  fi
  : "${PWA_VERSION:?PWA_VERSION is required for pwa scope}"
fi

PUBLISH_IMAGES="${PUBLISH_IMAGES:-0}"
KEEP_IMAGE_ARCHIVE="${KEEP_IMAGE_ARCHIVE:-0}"
KEEP_IMAGE_VERSIONS="${KEEP_IMAGE_VERSIONS:-3}"
PWA_URL="${PWA_URL:-}"
RELAY_URL="${RELAY_URL:-}"
SSH_TARGET="${DEPLOY_USER}@${DEPLOY_SSH}"
RELAY_IMAGE=""
PWA_IMAGE=""
if [[ "$SCOPE" == relay || "$SCOPE" == both ]]; then
  RELAY_IMAGE="${IMAGE_NAMESPACE}/pi-reach-relay:${RELAY_VERSION}"
fi
if [[ "$SCOPE" == pwa || "$SCOPE" == both ]]; then
  PWA_IMAGE="${IMAGE_NAMESPACE}/pi-reach-pwa:${PWA_VERSION}"
fi

valid_token() {
  [[ "$1" =~ ^[A-Za-z0-9._:/-]+$ ]]
}

valid_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]
}

valid_token "$DEPLOY_SSH" || fail "DEPLOY_SSH contains unsupported characters"
valid_token "$DEPLOY_USER" || fail "DEPLOY_USER contains unsupported characters"
valid_path "$REMOTE_DIR" || fail "REMOTE_DIR must be an absolute path without shell metacharacters"
valid_token "$IMAGE_NAMESPACE" || fail "IMAGE_NAMESPACE contains unsupported characters"
if [[ -n "$RELAY_IMAGE" ]]; then
  valid_token "$RELAY_VERSION" || fail "RELAY_VERSION contains unsupported characters"
fi
if [[ -n "$PWA_IMAGE" ]]; then
  valid_token "$PWA_VERSION" || fail "PWA_VERSION contains unsupported characters"
fi
[[ "$PUBLISH_IMAGES" == 0 || "$PUBLISH_IMAGES" == 1 ]] || fail "PUBLISH_IMAGES must be 0 or 1"
[[ "$KEEP_IMAGE_ARCHIVE" == 0 || "$KEEP_IMAGE_ARCHIVE" == 1 ]] || fail "KEEP_IMAGE_ARCHIVE must be 0 or 1"
[[ "$KEEP_IMAGE_VERSIONS" =~ ^[0-9]+$ ]] || fail "KEEP_IMAGE_VERSIONS must be a non-negative integer"

REQUIRED_COMMANDS=(ssh docker scp gzip)
if [[ -n "$PWA_URL" || -n "$RELAY_URL" ]]; then
  REQUIRED_COMMANDS+=(curl)
fi
for command in "${REQUIRED_COMMANDS[@]}"; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command not found: $command"
done

[[ -f "$ROOT_DIR/docker-compose.yml" ]] || fail "Missing $ROOT_DIR/docker-compose.yml"
if [[ "$SCOPE" == relay || "$SCOPE" == both ]]; then
  [[ -f "$ROOT_DIR/relay/Dockerfile" ]] || fail "Missing Relay Dockerfile"
fi
if [[ "$SCOPE" == pwa || "$SCOPE" == both ]]; then
  [[ -f "$ROOT_DIR/pwa/Dockerfile" ]] || fail "Missing PWA Dockerfile"
fi

# Compose needs both image variables to parse; an unselected service gets a placeholder it never starts.
CONFIG_RELAY_IMAGE="${RELAY_IMAGE:-invalid.invalid/pi-reach-relay-unselected:never}"
CONFIG_PWA_IMAGE="${PWA_IMAGE:-invalid.invalid/pi-reach-pwa-unselected:never}"
DEPLOY_LOCK_DIR="$REMOTE_DIR/.pi-reach-deploy-lock"
DEPLOY_LOCK_HELD=0

IMAGE_LABELS=()
IMAGE_REFS=()
IMAGE_DOCKERFILES=()
SERVICES=()
CONTAINERS=()

if [[ "$SCOPE" == relay || "$SCOPE" == both ]]; then
  IMAGE_LABELS+=(Relay)
  IMAGE_REFS+=("$RELAY_IMAGE")
  IMAGE_DOCKERFILES+=("$ROOT_DIR/relay/Dockerfile")
  SERVICES+=(relay)
  CONTAINERS+=(pi-reach-relay)
fi
if [[ "$SCOPE" == pwa || "$SCOPE" == both ]]; then
  IMAGE_LABELS+=(PWA)
  IMAGE_REFS+=("$PWA_IMAGE")
  IMAGE_DOCKERFILES+=("$ROOT_DIR/pwa/Dockerfile")
  SERVICES+=(pwa)
  CONTAINERS+=(pi-reach-pwa)
fi

# Built images carry this label so that copies left untagged by a later load can still be pruned.
readonly IMAGE_KIND_LABEL="pi-reach.image"

remote() {
  ssh -o ConnectTimeout=15 -o BatchMode=yes "$SSH_TARGET" "$1"
}

cleanup_deploy_lock() {
  local exit_status=$?
  local cleanup_status=0
  trap - ERR INT TERM EXIT

  if [[ "$DEPLOY_LOCK_HELD" == 1 ]]; then
    remote "rmdir '$DEPLOY_LOCK_DIR'" || cleanup_status=$?
    if (( cleanup_status != 0 )); then
      printf '✗ Unable to release remote deployment lock: %s. Verify no deployment process is running before removing it manually.\n' "$DEPLOY_LOCK_DIR" >&2
      if (( exit_status == 0 )); then
        exit_status=$cleanup_status
      fi
    fi
  fi

  exit "$exit_status"
}

handle_deploy_error() {
  local exit_status=$?
  trap - ERR
  exit "$exit_status"
}

handle_deploy_signal() {
  local exit_status="$1"
  trap - ERR INT TERM
  exit "$exit_status"
}

acquire_deploy_lock() {
  if ! remote "mkdir -p '$REMOTE_DIR' && mkdir '$DEPLOY_LOCK_DIR'"; then
    fail "Concurrent deployment rejected: unable to create remote lock $DEPLOY_LOCK_DIR. Another deployment may be active or a stale lock may remain; verify no deployment process is running, then remove the lock directory manually."
  fi

  DEPLOY_LOCK_HELD=1
  trap cleanup_deploy_lock EXIT
  trap handle_deploy_error ERR
  trap 'handle_deploy_signal 130' INT
  trap 'handle_deploy_signal 143' TERM
}

compose_remote() {
  local compose_args="$1"
  remote "cd '$REMOTE_DIR' && unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES && export RELAY_IMAGE='$CONFIG_RELAY_IMAGE' PWA_IMAGE='$CONFIG_PWA_IMAGE' && docker-compose --env-file /dev/null -f '$REMOTE_DIR/docker-compose.yml' $compose_args"
}

# 本机备用入口仍只允许固定生产结构；用 Compose 自身规范化完整契约。
production_compose_contract() {
  cat <<'EOF'
name: pi-reach

services:
  relay:
    image: ${RELAY_IMAGE:?RELAY_IMAGE must be set}
    container_name: pi-reach-relay
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      PI_REACH_RELAY_PORT: "3000"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
  pwa:
    image: ${PWA_IMAGE:?PWA_IMAGE must be set}
    container_name: pi-reach-pwa
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3000"
    environment:
      PORT: "3000"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
EOF
}
VALIDATE_PROGRAM="$(declare -f production_compose_contract)"$'\n''set -Eeuo pipefail
shift
REMOTE_DIR="$1"
export RELAY_IMAGE="$2" PWA_IMAGE="$3"
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
cd "$REMOTE_DIR"
TEMPLATE="$(mktemp "$REMOTE_DIR/.pi-reach-compose-contract.XXXXXX")"
trap '\''rm -f "$TEMPLATE"'\'' EXIT
production_compose_contract > "$TEMPLATE"
ACTUAL="$(docker-compose --env-file /dev/null --project-directory "$REMOTE_DIR" -f "$REMOTE_DIR/docker-compose.yml" config --format json 2>/dev/null)" || exit 1
EXPECTED="$(docker-compose --env-file /dev/null --project-directory "$REMOTE_DIR" -f "$TEMPLATE" config --format json 2>/dev/null)" || exit 1
[[ "$ACTUAL" == "$EXPECTED" ]]'

validate_remote_compose() {
  remote "bash -s -- compose-contract '$REMOTE_DIR' '$CONFIG_RELAY_IMAGE' '$CONFIG_PWA_IMAGE'" <<< "$VALIDATE_PROGRAM" || fail "Unable to parse the remote Compose configuration or production contract mismatch"
}

wait_for_health() {
  local container="$1"
  local service="$2"
  info "Waiting for $service health check"
  remote "for attempt in \$(seq 1 30); do
    state=\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' '$container' 2>/dev/null || true)
    if [ \"\$state\" = healthy ]; then exit 0; fi
    sleep 2
  done
  printf 'Service health check failed\n' >&2
  exit 1"
}

check_url() {
  local label="$1"
  local url="$2"
  [[ -n "$url" ]] || return 0
  info "Checking $label"
  curl -fsS --connect-timeout 10 --max-time 30 "$url" >/dev/null
}

get_remote_image_id() {
  local image="$1"
  local image_id
  image_id="$(remote "docker image inspect --format '{{.Id}}' '$image'")" || fail "Selected image is missing on the remote host: $image"
  [[ "$image_id" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || fail "Remote image returned an invalid image ID: $image"
  printf '%s\n' "$image_id"
}

# Runs with the same body locally and on the server (see PRUNE_PROGRAM). For each deployed image
# reference it keeps that tag plus the newest other tags of its repository, KEEP in total, then
# removes older tags and untagged images carrying the Pi Reach label. Images used by any container
# are never removed. Prints the number of removed images.
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
  for id in $(docker images --no-trunc --quiet --filter dangling=true --filter "label=$PRUNE_LABEL"); do
    if printf '%s\n' "$in_use" | grep -qxF "$id"; then continue; fi
    docker rmi "$id" >/dev/null && removed=$((removed + 1))
  done
  printf '%s\n' "$removed"
}
PRUNE_PROGRAM="PRUNE_LABEL='$IMAGE_KIND_LABEL'
$(declare -f prune_images)
prune_images \"\$@\""

info "Deployment scope=$SCOPE"
for index in "${!IMAGE_REFS[@]}"; do
  info "${IMAGE_LABELS[$index]} image reference: ${IMAGE_REFS[$index]}"
done

info "Checking SSH and remote Docker"
remote 'docker info >/dev/null && docker-compose version >/dev/null'

info "Acquiring remote deployment lock"
acquire_deploy_lock

REMOTE_ARCH="$(remote 'uname -m')"
case "$REMOTE_ARCH" in
  x86_64|amd64) PLATFORM="linux/amd64" ;;
  aarch64|arm64) PLATFORM="linux/arm64" ;;
  *) fail "Unsupported remote architecture: $REMOTE_ARCH" ;;
esac
info "Remote architecture: $REMOTE_ARCH ($PLATFORM)"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  info "Creating Buildx builder: $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi
docker buildx use "$BUILDER" >/dev/null

for index in "${!IMAGE_REFS[@]}"; do
  image="${IMAGE_REFS[$index]}"
  dockerfile="${IMAGE_DOCKERFILES[$index]}"
  label="${IMAGE_LABELS[$index]}"
  kind_label="$IMAGE_KIND_LABEL=${SERVICES[$index]}"
  if [[ "$PUBLISH_IMAGES" == 1 ]]; then
    info "Publishing $label target-platform image"
    docker buildx build --builder "$BUILDER" --platform "$PLATFORM" \
      --tag "$image" --label "$kind_label" --file "$dockerfile" --push "$ROOT_DIR"
  fi
  info "Building $label locally ($PLATFORM)"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORM" \
    --tag "$image" --label "$kind_label" --file "$dockerfile" --load "$ROOT_DIR"
done
docker image inspect "${IMAGE_REFS[@]}" >/dev/null

info "Preparing remote deployment directory"
remote "mkdir -p '$REMOTE_DIR'"
scp -q "$ROOT_DIR/docker-compose.yml" "$SSH_TARGET:$REMOTE_DIR/docker-compose.yml"

info "Validating remote production Compose contract"
validate_remote_compose

info "Transferring selected local images to the server"
if [[ "$KEEP_IMAGE_ARCHIVE" == 1 ]]; then
  ARCHIVE_DIR="$ROOT_DIR/.pi/tmp"
  mkdir -p "$ARCHIVE_DIR"
  ARCHIVE="$ARCHIVE_DIR/pi-reach-$SCOPE-images-$(date +%Y%m%d%H%M%S).tar.gz"
  docker save "${IMAGE_REFS[@]}" | gzip -1 > "$ARCHIVE"
  ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$SSH_TARGET" \
    'gzip -dc | docker load' < "$ARCHIVE"
  info "Kept image archive: $ARCHIVE"
else
  docker save "${IMAGE_REFS[@]}" | gzip -1 | \
    ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$SSH_TARGET" \
      'gzip -dc | docker load'
fi

for index in "${!IMAGE_REFS[@]}"; do
  image_id="$(get_remote_image_id "${IMAGE_REFS[$index]}")"
  info "${IMAGE_LABELS[$index]} image: ${IMAGE_REFS[$index]} (${image_id:0:19})"
  if [[ "${SERVICES[$index]}" == relay ]]; then CONFIG_RELAY_IMAGE="$image_id"; else CONFIG_PWA_IMAGE="$image_id"; fi
done

info "Validating remote Compose configuration"
compose_remote "config --quiet" || fail "Unable to parse the remote Compose configuration"

info "Updating services: ${SERVICES[*]}"
# --remove-orphans drops containers of services no longer in the Compose file (such as the former site service) so they release their ports.
compose_remote "up -d --pull never --remove-orphans ${SERVICES[*]}"
for index in "${!SERVICES[@]}"; do
  wait_for_health "${CONTAINERS[$index]}" "${SERVICES[$index]}"
done
compose_remote "ps ${SERVICES[*]}"

if [[ "$SCOPE" == relay || "$SCOPE" == both ]] && [[ -n "$RELAY_URL" ]]; then
  check_url "public Relay" "${RELAY_URL%/}/health"
fi
if [[ "$SCOPE" == pwa || "$SCOPE" == both ]]; then
  check_url "public PWA" "$PWA_URL"
fi

# Pruning is housekeeping: a failure is reported but never fails a deployment that is already live.
if (( KEEP_IMAGE_VERSIONS > 0 )); then
  info "Pruning images older than the newest $KEEP_IMAGE_VERSIONS per service"
  if pruned="$(remote "bash -s -- $KEEP_IMAGE_VERSIONS ${IMAGE_REFS[*]}" <<< "$PRUNE_PROGRAM")"; then
    info "Server: removed ${pruned:-0} old image(s)"
  else
    warn "Server image pruning failed; the deployment itself succeeded"
  fi
  if pruned="$(bash -c "$PRUNE_PROGRAM" prune "$KEEP_IMAGE_VERSIONS" "${IMAGE_REFS[@]}")"; then
    info "Local: removed ${pruned:-0} old image(s)"
  else
    warn "Local image pruning failed; the deployment itself succeeded"
  fi
fi
printf '✓ Deployment completed for scope %s\n' "$SCOPE"
