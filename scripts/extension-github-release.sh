#!/usr/bin/env bash
set -Eeuo pipefail

# 用法：extension-github-release.sh [X.Y.Z]
# 为已在 npm 上线的 Extension 版本创建 extension-vX.Y.Z 注解标签与 GitHub Release，由 Extension GitHub Release 工作流调用。
# 不传版本时使用当前 pi-extension/package.json 的版本；传入历史版本用于补建，补建的 Release 不标记 Latest。
# 标签与 Release 都已存在，或 npm 上尚无该版本（待审或未提交）时跳过；无法确认 npm 状态时失败。
# 标签打在 package.json 版本号变为该版本的提交上。需要完整历史与标签（actions/checkout 的 fetch-depth: 0），
# 以及 GH_TOKEN、GITHUB_REPOSITORY；RUN_URL、GITHUB_STEP_SUMMARY、RUNNER_TEMP 可选。

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

version_at() {
  git show "$1:$package_json" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true
}

# 从新到旧遍历改动过 package.json 的提交，返回连续等于该版本的最早一个，即版本号变为该版本的提交。
find_version_commit() {
  local version="$1" sha found=""
  while read -r sha; do
    if [[ "$(version_at "$sha")" == "$version" ]]; then
      found="$sha"
    elif [[ -n "$found" ]]; then
      break
    fi
  done < <(git log --first-parent --format=%H HEAD -- "$package_json")
  printf '%s' "$found"
}

write_notes() {
  local version="$1" commit="$2" file="$3" previous changes
  previous="$(git describe --tags --abbrev=0 --match 'extension-v*' "$commit^" 2>/dev/null || true)"
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

cd "$(git rev-parse --show-toplevel)"
[[ -n "${GITHUB_REPOSITORY:-}" ]] || fail "缺少 GITHUB_REPOSITORY"

current="$(jq -r '.version' "$package_json")"
version="${1:-$current}"
[[ "$version" =~ $semver_pattern ]] || fail "版本号格式无效：$version"
tag="extension-v$version"

has_tag=0
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  has_tag=1
  if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    summary "$tag 的标签与 Release 已存在，跳过。"
    exit 0
  fi
fi

status="$(curl -sS --retry 3 --max-time 30 -o /dev/null -w '%{http_code}' "$registry/${package_name/\//%2f}/$version" || true)"
case "$status" in
  200) ;;
  404)
    summary "$package_name@$version 尚未在 npm 上线（待审或未提交），跳过。"
    exit 0
    ;;
  *) fail "无法确认 npm 上是否已有 $package_name@$version（HTTP ${status:-无响应}）" ;;
esac

commit="$(find_version_commit "$version")"
[[ -n "$commit" ]] || fail "当前分支历史中没有把 $package_json 版本改为 $version 的提交"

notes="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$tag.md"
write_notes "$version" "$commit" "$notes"

if [[ "$has_tag" == 0 ]]; then
  tag_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="$tag" -f message="Extension $version" \
    -f object="$commit" -f type=commit --jq .sha)"
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$tag" -f sha="$tag_sha" >/dev/null
fi

latest="--latest=false"
if [[ "$version" == "$current" ]]; then
  latest="--latest"
fi
gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "Extension $version" \
  --notes-file "$notes" "$latest"
summary "- Extension $version：已创建 $tag 与 GitHub Release（提交 ${commit:0:7}）。"
