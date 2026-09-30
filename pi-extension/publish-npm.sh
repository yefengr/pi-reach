#!/usr/bin/env bash
set -Eeuo pipefail

# 用法：publish-npm.sh [--stage]
# 默认直接发布；--stage 执行 npm stage publish，把版本提交到 npm 待审区，维护者用 2FA 批准后才上线。
# 认证按顺序选择：NPM_TOKEN、GitHub Actions OIDC（npm trusted publishing）、已登录的 npm 会话。

registry="https://registry.npmjs.org/"
stage_min_npm_version="11.15.0"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_npmrc=""
pack_dir=""
otp=""
stage=0
oidc=0

cleanup() {
  unset otp NPM_TOKEN
  if [[ -n "$temp_npmrc" ]]; then
    rm -f "$temp_npmrc"
  fi
  if [[ -n "$pack_dir" ]]; then
    rm -rf "$pack_dir"
  fi
}

trap cleanup EXIT

fail() {
  printf '发布中止：%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "找不到命令：$1"
}

version_at_least() {
  node -e '
    const [actual, minimum] = process.argv.slice(1).map((value) => value.split(".").map((part) => Number.parseInt(part, 10)));
    for (let index = 0; index < 3; index += 1) {
      if (actual[index] !== minimum[index]) process.exit(actual[index] > minimum[index] ? 0 : 1);
    }
  ' "$1" "$2"
}

for arg in "$@"; do
  case "$arg" in
    --stage) stage=1 ;;
    *) fail "未知参数：${arg}（用法：publish-npm.sh [--stage]）" ;;
  esac
done

cd "$script_dir"
require_command node
require_command npm
require_command pnpm

if (( stage )); then
  npm_version="$(npm --version)"
  version_at_least "$npm_version" "$stage_min_npm_version" \
    || fail "npm stage publish 需要 npm $stage_min_npm_version 或更高版本，当前为 $npm_version"
fi

if [[ -n "${NPM_TOKEN:-}" ]]; then
  temp_npmrc="$(mktemp "${TMPDIR:-/tmp}/pi-reach-npmrc.XXXXXX")"
  chmod 600 "$temp_npmrc"
  printf '%s\n' \
    "registry=$registry" \
    "@yefengr:registry=$registry" \
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' \
    >"$temp_npmrc"
  export NPM_CONFIG_USERCONFIG="$temp_npmrc"
  printf '使用 NPM_TOKEN 临时认证；凭据不会写入仓库或命令参数。\n'
elif [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
  oidc=1
  printf '使用 GitHub Actions OIDC（npm trusted publishing）认证；上传时由 npm 换取短期凭据。\n'
fi

package_name="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).name)')"
package_version="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).version)')"

[[ "$package_name" == "@yefengr/pi-reach" ]] || fail "package.json 的 name 不是 @yefengr/pi-reach：$package_name"
[[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "版本必须是精确的 X.Y.Z：$package_version"

# OIDC 凭据只在上传时换取，npm whoami 无法提前确认。
if (( ! oidc )) && ! npm whoami --registry="$registry" >/dev/null 2>&1; then
  fail "当前 npm 会话未认证；先执行 npm login --registry=$registry"
fi

set +e
version_output="$(npm view "$package_name@$package_version" version --registry="$registry" 2>&1)"
version_status=$?
set -e

if (( version_status == 0 )); then
  fail "$package_name@$package_version 已存在，不能重复发布"
fi

case "$version_output" in
  *E404*|*404*|*"No match found"*) ;;
  *)
    printf '%s\n' "$version_output" >&2
    fail "无法确认版本是否已存在，请检查 npm registry 和网络"
    ;;
esac

if (( stage )); then
  printf '准备提交 %s@%s 到 npm 待审区\n' "$package_name" "$package_version"
else
  printf '准备发布 %s@%s\n' "$package_name" "$package_version"
fi
printf '清理旧 dist/ 编译产物...\n'
rm -rf dist

printf '运行 pnpm verify...\n'
pnpm verify

printf '检查 npm tarball 内容...\n'
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-reach-pack.XXXXXX")"
set +e
pack_output="$(pnpm pack --json --pack-destination "$pack_dir" 2>&1)"
pack_status=$?
set -e
printf '%s\n' "$pack_output"
(( pack_status == 0 )) || fail "pnpm pack 失败"

if [[ "$pack_output" =~ dist/.*(mesh|rooms|broker|pi_forward|peer_inventory|leader_election) ]]; then
  fail "npm tarball 中仍包含旧 Mesh/跨 Pi 编译产物，请检查 dist/"
fi

# pnpm publish may return a spurious E404 for granular bypass-2FA tokens.
# Verification and packing stay on pnpm; npm CLI performs only the final upload.
# pnpm pack 会将 catalog 引用转换为实际版本；上传检查过的包，不能重新打包源码目录。
tarballs=("$pack_dir"/*.tgz)
[[ ${#tarballs[@]} -eq 1 && -f "${tarballs[0]}" ]] || fail "打包目录中没有唯一的 npm tarball"

if (( stage )); then
  # 提交待审不需要 2FA；批准时才需要。
  npm stage publish "${tarballs[0]}" --access public --ignore-scripts
  printf '已提交到 npm 待审区：%s@%s\n' "$package_name" "$package_version"
  printf '在 npmjs.com 的 Staged Packages 中核对并用 2FA 批准后才会上线；也可在交互式终端执行 npm stage list %s 与 npm stage approve <stage-id>。\n' \
    "$package_name"
  printf '本版本依赖新的协议帧或事件时，批准前先确认 PWA 已部署。\n'
  exit 0
fi

publish_args=(publish "${tarballs[0]}" --access public --ignore-scripts)

if [[ -n "${NPM_TOKEN:-}" ]] || (( oidc )); then
  npm "${publish_args[@]}"
else
  printf '请输入 npm 2FA 验证码（OTP）；使用授权链接/扫码请直接回车：'
  IFS= read -r -s otp || true
  printf '\n'
  if [[ -n "$otp" ]]; then
    publish_args+=(--otp="$otp")
  fi
  npm "${publish_args[@]}"
fi

unset otp

verification_attempts=12
verification_delay_seconds=5
published_version=""

for ((attempt = 1; attempt <= verification_attempts; attempt++)); do
  published_version="$(npm view "$package_name@$package_version" version --registry="$registry" --prefer-online 2>/dev/null || true)"
  if [[ "$published_version" == "$package_version" ]]; then
    printf '发布成功：%s@%s\n' "$package_name" "$package_version"
    exit 0
  fi
  if (( attempt < verification_attempts )); then
    printf 'npm registry 尚未确认 %s@%s（%d/%d），%d 秒后重试...\n' \
      "$package_name" "$package_version" "$attempt" "$verification_attempts" "$verification_delay_seconds" >&2
    sleep "$verification_delay_seconds"
  fi
done

printf '警告：npm publish 已成功，但 registry 在约 60 秒内尚未确认 %s@%s。\n' \
  "$package_name" "$package_version" >&2
printf '稍后手动检查：npm view %s@%s version --prefer-online\n' \
  "$package_name" "$package_version" >&2
exit 0
