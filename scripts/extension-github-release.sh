#!/usr/bin/env bash
set -Eeuo pipefail

# 用法：
#   extension-github-release.sh tag <X.Y.Z> <commit>   Extension npm 工作流提交待审后，在本次提交上创建 extension-vX.Y.Z 注解标签
#   extension-github-release.sh release [X.Y.Z]        Extension GitHub Release 工作流在该版本上线 npm 后创建 GitHub Release
# 标签必须在提交待审时创建：工作流的 GITHUB_TOKEN 没有 workflows 权限，目标提交的 .github/workflows 与 main 最新提交不同时，
# GitHub 拒绝创建标签（HTTP 403）。待审期间 main 可能已合入新的工作流改动，所以 release 不再补打标签，标签缺失时失败。
# release 不传版本时使用当前 pi-extension/package.json 的版本；传入历史版本用于补建，补建的 Release 不标记 Latest。
# 需要完整历史与标签（actions/checkout 的 fetch-depth: 0），以及 GH_TOKEN、GITHUB_REPOSITORY；
# RUN_URL、GITHUB_STEP_SUMMARY、RUNNER_TEMP 可选。

package_name="@yefengr/pi-reach"
package_json="pi-extension/package.json"
registry="https://registry.npmjs.org"
# Extension 打包时内置共享协议，Release 说明同时列出两处的提交。
change_paths=(pi-extension packages/protocol)
semver_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

fail() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

summary() {
  printf '%s\n' "$*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

require_version() {
  [[ "$1" =~ $semver_pattern ]] || fail "版本号格式无效：$1"
}

tag_commit() {
  git rev-parse -q --verify "refs/tags/$1^{commit}" || true
}

# 返回 200、404 或其他 HTTP 状态；网络失败时为 000。
npm_status() {
  curl -sS --retry 3 --max-time 30 -o /dev/null -w '%{http_code}' "$registry/${package_name/\//%2f}/$1" || true
}

# 返回提交之前最近一个已在 npm 上线的版本标签。标签在提交待审时创建，未获批准的版本也有标签；
# 以它为起点会漏掉用户从未收到的改动，所以按版本从高到低跳过 npm 上不存在的标签。
previous_published_tag() {
  local commit="$1" candidate status
  while read -r candidate; do
    [[ -n "$candidate" ]] || continue
    status="$(npm_status "${candidate#extension-v}")"
    case "$status" in
      200)
        printf '%s' "$candidate"
        return
        ;;
      404) ;;
      *) fail "无法确认 $candidate 是否已在 npm 上线（HTTP ${status:-无响应}）" ;;
    esac
  done < <(git tag --merged "$commit^" --list 'extension-v*' --sort=-version:refname 2>/dev/null || true)
}

write_notes() {
  local version="$1" commit="$2" file="$3" previous changes
  previous="$(previous_published_tag "$commit")"
  changes="$(git log --no-merges --format='- %s' "${previous:+$previous..}$commit" -- "${change_paths[@]}" \
    | grep -vE '^- chore(\(release\))?: 发布' || true)"
  {
    echo "npm：[\`$package_name@$version\`](https://www.npmjs.com/package/$package_name/v/$version)"
    echo
    if [[ -n "${RUN_URL:-}" ]]; then
      echo "发布记录：[查看工作流]($RUN_URL)"
      echo
    fi
    echo "## 变更"
    echo
    echo "${changes:-- 自 ${previous:-首个版本} 以来没有涉及 Extension 的提交。}"
  } > "$file"
}

create_tag() {
  local version="$1" commit="$2" tag="extension-v$1" existing manifest_version tag_sha
  require_version "$version"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "提交必须是完整的 40 位 SHA：$commit"
  manifest_version="$(git show "$commit:$package_json" | jq -r '.version')"
  [[ "$manifest_version" == "$version" ]] || fail "提交 ${commit:0:7} 的 $package_json 版本为 $manifest_version，不是 $version"

  existing="$(tag_commit "$tag")"
  if [[ -n "$existing" ]]; then
    [[ "$existing" == "$commit" ]] || fail "$tag 已指向其他提交 ${existing:0:7}"
    summary "$tag 已存在，跳过。"
    return
  fi
  tag_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="$tag" -f message="Extension $version" \
    -f object="$commit" -f type=commit --jq .sha)"
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$tag" -f sha="$tag_sha" >/dev/null
  summary "- 已在提交 ${commit:0:7} 上创建 $tag；npm 批准上线后由 Extension GitHub Release 工作流创建 Release。"
}

create_release() {
  local current version tag commit status notes latest
  current="$(jq -r '.version' "$package_json")"
  # 手动运行时输入框容易带入首尾空白。
  version="$(printf '%s' "${1:-$current}" | tr -d '[:space:]')"
  require_version "$version"
  tag="extension-v$version"
  commit="$(tag_commit "$tag")"

  if [[ -n "$commit" ]] && gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    summary "$tag 的 Release 已存在，跳过。"
    return
  fi

  status="$(npm_status "$version")"
  case "$status" in
    200) ;;
    404)
      summary "$package_name@$version 尚未在 npm 上线（待审或未提交），跳过。"
      return
      ;;
    *) fail "无法确认 npm 上是否已有 $package_name@$version（HTTP ${status:-无响应}）" ;;
  esac
  [[ -n "$commit" ]] || fail "$package_name@$version 已上线但缺少标签 $tag；工作流无法补打，请按 docs/DEPLOYMENT.md「版本标签与 GitHub Release」手工打标签后重新运行"

  notes="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$tag.md"
  write_notes "$version" "$commit" "$notes"
  latest="--latest=false"
  if [[ "$version" == "$current" ]]; then
    latest="--latest"
  fi
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "Extension $version" \
    --notes-file "$notes" "$latest"
  summary "- Extension $version：已基于 $tag（提交 ${commit:0:7}）创建 GitHub Release。"
}

cd "$(git rev-parse --show-toplevel)"
[[ -n "${GITHUB_REPOSITORY:-}" ]] || fail "缺少 GITHUB_REPOSITORY"

case "${1:-}" in
  tag)
    [[ $# -eq 3 ]] || fail "用法：$0 tag <X.Y.Z> <commit>"
    create_tag "$2" "$3"
    ;;
  release)
    [[ $# -le 2 ]] || fail "用法：$0 release [X.Y.Z]"
    create_release "${2:-}"
    ;;
  *) fail "用法：$0 tag <X.Y.Z> <commit> | release [X.Y.Z]" ;;
esac
