#!/usr/bin/env bash
# 服务器端部署入口：由 GitHub Actions 的 Deploy 工作流通过受限 SSH 密钥调用。
# authorized_keys 用 restrict 与 command= 强制执行本脚本，并在 command= 中给出：
#   PI_REACH_REMOTE_DIR    部署目录，内含 docker-compose.yml（与本机部署脚本的 REMOTE_DIR 相同）
#   PI_REACH_IMAGE_PREFIX  允许部署的镜像前缀，如 ghcr.io/<owner>
# 客户端请求的命令在 SSH_ORIGINAL_COMMAND 中，只接受一种形式：
#   deploy <site|relay> <PI_REACH_IMAGE_PREFIX>/pi-reach-<site|relay>:vX.Y.Z@sha256:<digest>
# 按摘要拉取镜像并打上版本标签，只更新所选服务；健康检查失败时恢复部署前的镜像并以失败退出。
# 与本机 scripts/deploy-self-hosted.sh 共用部署锁，Caddy 与 docker-compose.yml 不在这里修改。
# 安装与配置见 docs/DEPLOYMENT.md「自动部署」。

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
  fail "Rejected request. Expected: deploy <site|relay> $IMAGE_PREFIX/pi-reach-<site|relay>:vX.Y.Z@sha256:<digest>"
}

# 只按空白拆分，不经过 shell 求值；任何多余参数或格式偏差都拒绝。
read -r -a REQUEST <<< "${SSH_ORIGINAL_COMMAND:-}" || true
(( ${#REQUEST[@]} == 3 )) || reject
[[ "${REQUEST[0]}" == deploy ]] || reject
SERVICE="${REQUEST[1]}"
IMAGE="${REQUEST[2]}"
case "$SERVICE" in
  site) CONTAINER=pi-reach-site ;;
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

# Compose 需要两个镜像变量才能解析；未选服务取一个永远不会启动的占位符。
compose_with() {
  local image="$1"
  shift
  local relay_image=invalid.invalid/pi-reach-relay-unselected:never
  local site_image=invalid.invalid/pi-reach-site-unselected:never
  if [[ "$SERVICE" == relay ]]; then relay_image="$image"; else site_image="$image"; fi
  (cd "$REMOTE_DIR" && RELAY_IMAGE="$relay_image" SITE_IMAGE="$site_image" docker-compose "$@")
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

# 与 deploy-self-hosted.sh 的 prune_images 相同：保留本次部署的标签及最新的其他标签共 KEEP 个，
# 删除更旧的标签与带 pi-reach.image 标签的悬空镜像，跳过任何容器正在使用的镜像。输出删除数量。
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
compose_with "$TARGET" up -d --pull never "$SERVICE"
if ! wait_for_health; then
  compose_with "$TARGET" logs --tail=80 "$SERVICE" || true
  if [[ -z "$PREVIOUS" || "$PREVIOUS" == "$TARGET" ]]; then
    fail "$SERVICE is not healthy and there is no earlier image to restore"
  fi
  warn "$SERVICE is not healthy; restoring $PREVIOUS"
  compose_with "$PREVIOUS" up -d --pull never "$SERVICE"
  if wait_for_health; then
    fail "Deployment of $TARGET failed; $SERVICE was restored to $PREVIOUS"
  fi
  fail "Deployment of $TARGET failed and restoring $PREVIOUS did not become healthy; check the server now"
fi
compose_with "$TARGET" ps "$SERVICE"

# 清理只是收尾：失败只给出警告，不影响已经上线的部署。
if (( KEEP_IMAGE_VERSIONS > 0 )); then
  info "Pruning images older than the newest $KEEP_IMAGE_VERSIONS"
  if pruned="$(prune_images "$KEEP_IMAGE_VERSIONS" "$TARGET")"; then
    info "Removed ${pruned:-0} old image(s)"
  else
    warn "Image pruning failed; the deployment itself succeeded"
  fi
fi
printf '✓ Deployed %s %s\n' "$SERVICE" "$TARGET"
