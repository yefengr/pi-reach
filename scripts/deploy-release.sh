#!/usr/bin/env bash
# Release-only helper; Docker writes and public checks have already passed in deploy-ci.mjs.
set -Eeuo pipefail

release() {
  local component="$1" title="$2" version="$3" image="$4" digest="$5" url="$6"
  shift 6
  local tag="$component-v$version" previous changes tag_sha existing commit released_notes
  # 补建时当前标签已存在；从父提交找上一个版本，不能把本次标签当作变更起点。
  previous="$(git describe --tags --abbrev=0 --match "$component-v*" "$GITHUB_SHA^" 2>/dev/null || true)"
  changes="$(git log --no-merges --format='- %s' "${previous:+$previous..}$GITHUB_SHA" -- "$@" | grep -v '^- chore: 发布' || true)"
  {
    if [ -n "$url" ]; then echo "线上地址：[$url]($url)"; else echo "线上地址：未配置"; fi
    echo
    echo "镜像：[\`$image\`]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/pkgs/container/pi-reach-$component)"
    echo
    echo "镜像摘要：\`$digest\`"
    echo
    echo "源提交：\`$GITHUB_SHA\`"
    echo
    echo "部署记录：[查看工作流]($RUN_URL)"
    echo
    echo "## 变更"
    echo
    echo "${changes:-- 自 ${previous:-首个版本} 以来没有涉及该组件的提交。}"
  } > "$RUNNER_TEMP/$tag.md"
  # Distinguish 404 from authentication/network errors; do not overwrite a public tag.
  if existing="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --jq '[.object.type, .object.sha] | join(" ")' 2>"$RUNNER_TEMP/tag-error")"; then
    read -r type commit <<< "$existing"
    if [ "$type" = tag ]; then
      commit="$(gh api "repos/$GITHUB_REPOSITORY/git/tags/$commit" --jq .object.sha)"
    elif [ "$type" != commit ]; then
      echo 'Published tag has an invalid target' >&2; return 1
    fi
    [ "$commit" = "$GITHUB_SHA" ] || { echo 'Published tag belongs to another source commit' >&2; return 1; }
  elif grep -q 'HTTP 404' "$RUNNER_TEMP/tag-error"; then
    tag_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="$tag" -f message="$title $version" -f object="$GITHUB_SHA" -f type=commit --jq .sha)"
    gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$tag" -f sha="$tag_sha" >/dev/null
  else
    echo 'Unable to verify the published tag' >&2; return 1
  fi
  if released_notes="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" --jq .body 2>"$RUNNER_TEMP/release-error")"; then
    [[ "$released_notes" == *"$digest"* ]] || { echo 'Existing Release records another image digest' >&2; return 1; }
    echo "- $title $version Release 已存在，不重复创建。" >> "$GITHUB_STEP_SUMMARY"
  elif grep -q 'HTTP 404' "$RUNNER_TEMP/release-error"; then
    gh release create "$tag" --verify-tag --title "$title $version" --notes-file "$RUNNER_TEMP/$tag.md" --latest=false
    echo "- $title $version 已部署：\`$image@$digest\`" >> "$GITHUB_STEP_SUMMARY"
  else
    echo 'Unable to verify the existing Release' >&2; return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo 'Release only accepts main' >&2; exit 1; }
  for component in relay pwa; do
    selected="SELECT_${component^^}"
    [[ "${!selected}" == true ]] || continue
    variable="${component^^}_IMAGE"
    ref="${!variable}"
    version="${ref#*:v}"; version="${version%@*}"
    digest="${ref##*@}"
    if [[ "$component" == relay ]]; then title=Relay; url="$RELAY_URL"; else title=PWA; url="$PWA_URL"; fi
    release "$component" "$title" "$version" "${ref%@*}" "$digest" "$url" "$component" packages/protocol
  done
fi
