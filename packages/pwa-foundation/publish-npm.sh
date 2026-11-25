#!/usr/bin/env bash
set -Eeuo pipefail

# 默认只验证打包；只有 main 的可信发布作业可以显式提交待审。
fail() { printf '基础包发布中止：%s\n' "$1" >&2; exit 1; }
stage=0
artifact_dir=''
if (( $# )); then
  [[ $# -eq 2 && "$1" == --stage && -n "$2" ]] || fail '用法：publish-npm.sh [--stage <artifact-directory>]'
  stage=1
  artifact_dir="$2"
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"
for cli in node tar git; do command -v "$cli" >/dev/null || fail "找不到命令：$cli"; done
if (( stage )); then
  for cli in npm curl; do command -v "$cli" >/dev/null || fail "找不到命令：$cli"; done
else
  command -v pnpm >/dev/null || fail '找不到命令：pnpm'
fi
registry='https://registry.npmjs.org/'
name='@yefengr/pwa-foundation'
version="$(node -e 'const p=require("./package.json"); if(p.name!=="@yefengr/pwa-foundation" || !/^\d+\.\d+\.\d+$/.test(p.version)) process.exit(1); process.stdout.write(p.version)')" || fail '包名或精确 X.Y.Z 版本无效'
out=''
keep=0
auth_dir=''
cleanup() {
  if [[ -n "$auth_dir" ]]; then rm -rf -- "$auth_dir"; fi
  if [[ -n "$out" && "$keep" == 0 ]]; then rm -rf -- "$out"; fi
}
trap cleanup EXIT
source_sha="$(git rev-parse HEAD)"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail '无法确认源码 SHA'
if (( stage )); then
  [[ "${GITHUB_SHA:-}" == "$source_sha" ]] || fail 'GITHUB_SHA 与源码不符'
  [[ "${EXPECTED_SHA256:-}" =~ ^[0-9a-f]{64}$ && "${EXPECTED_VERSION:-}" == "$version" ]] || fail '缺少可信 prepare 摘要或版本'
  [[ -d "$artifact_dir" && ! -L "$artifact_dir" ]] || fail '缺少准备制品目录'
  out="$(cd "$artifact_dir" && pwd)"
  keep=1
  [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REPOSITORY:-}" == yefengr/pi-reach && "${GITHUB_REF:-}" == refs/heads/main ]] || fail '提交待审仅允许自身仓库 main 的 GitHub Actions'
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] || fail '缺少 OIDC 请求环境'
  [[ -z "${NPM_TOKEN:-}" && -z "${NODE_AUTH_TOKEN:-}" ]] || fail '不允许长期 token 回退'
  # npm 不允许 user/global 重复加载同一路径；使用独立空文件隔离既有登录会话。
  # 认证配置不进入制品目录，公开版跳过和所有失败路径也由 EXIT 清理。
  auth_dir="$(mktemp -d "${TMPDIR:-/tmp}/pwa-foundation-auth.XXXXXX")"
  (umask 077; : > "$auth_dir/user.npmrc"; : > "$auth_dir/global.npmrc")
  unset npm_config_userconfig npm_config_globalconfig
  export NPM_CONFIG_USERCONFIG="$auth_dir/user.npmrc" NPM_CONFIG_GLOBALCONFIG="$auth_dir/global.npmrc"
  npm_version="$(npm --version)"
  node -e 'const v=process.argv[1]; if(!/^\d+\.\d+\.\d+$/.test(v)) process.exit(1); const [a,b]=v.split(".").map(Number); process.exit(a>11 || a===11 && b>=15 ? 0 : 1)' "$npm_version" || fail 'npm stage publish 需要 npm >=11.15.0'
else
  [[ -z "${GITHUB_SHA:-}" || "$GITHUB_SHA" == "$source_sha" ]] || fail 'GITHUB_SHA 与源码不符'
  if [[ -n "${PWA_FOUNDATION_PACK_DIR:-}" ]]; then
    # 只认领不存在的新目录，避免覆盖、上传或清理别人的产物。
    [[ "$PWA_FOUNDATION_PACK_DIR" == /* ]] || fail '输出目录必须是绝对路径'
    mkdir -m 700 -- "$PWA_FOUNDATION_PACK_DIR" || fail '输出目录已存在或不可创建'
    out="$PWA_FOUNDATION_PACK_DIR"
    keep=1
  else
    out="$(mktemp -d "${TMPDIR:-/tmp}/pwa-foundation-pack.XXXXXX")"
  fi
  pnpm --filter "$name" typecheck
  pnpm pack --pack-destination "$out"
fi
node --input-type=commonjs - "$out" "$version" "$source_sha" "$stage" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const [out, version, sourceSha, stage] = process.argv.slice(2);
function fail() { throw new Error('tarball 内容不符合公共包清单'); }
const entries = fs.readdirSync(out);
const tarballs = entries.filter(file => file.endsWith('.tgz'));
if(tarballs.length !== 1 || entries.length !== (stage === '1' ? 2 : 1)) fail();
if(stage === '1' && (!entries.includes('metadata.json') || !fs.lstatSync(path.join(out,'metadata.json')).isFile())) fail();
const tgz = path.join(out, tarballs[0]);
if(!fs.lstatSync(tgz).isFile()) fail();
const tar = (...args) => execFileSync('tar', args, {encoding:'utf8', maxBuffer:16*1024*1024});
const listing = tar('-tzf', tgz).trim().split('\n');
const verbose = tar('-tvzf', tgz).trim().split('\n');
if(verbose.some(line => !['-', 'd'].includes(line[0]))) fail();
const files = listing.filter(file => !file.endsWith('/'));
if(new Set(files).size !== files.length) fail();
for(const file of listing) {
  if(/(?:^|[\/_.-])(?:tests?|specs?|fixtures?)(?:[\/_.-]|$)/i.test(file)) fail();
  if(!file.startsWith('package/') || file.includes('..') || file.includes('\\')) fail();
  if(file.endsWith('/')) { if(!/^package\/(dist\/)?$/.test(file)) fail(); continue; }
  if(!/^package\/(package\.json|README\.md|LICENSE|CHANGELOG\.md|DESIGN\.md|foundation\.css|theme\.css|controls\.css|dist\/[a-zA-Z0-9_-]+\.(js|d\.ts))$/.test(file)) fail();
}
for(const file of ['package.json','README.md','LICENSE','CHANGELOG.md','DESIGN.md','foundation.css','theme.css','controls.css']) if(!files.includes('package/'+file)) fail();
const pkg = JSON.parse(tar('-xOf', tgz, 'package/package.json'));
if(pkg.name !== '@yefengr/pwa-foundation' || pkg.version !== version) fail();
const expectedExports = {'.':{types:'./dist/index.d.ts',default:'./dist/index.js'},'./foundation.css':'./foundation.css','./theme.css':'./theme.css','./controls.css':'./controls.css','./mantine':{types:'./dist/mantine.d.ts',default:'./dist/mantine.js'}};
if(JSON.stringify(pkg.exports) !== JSON.stringify(expectedExports)) fail();
function checkTargets(value) {
  if(typeof value === 'string') { if(!files.includes('package/'+value.slice(2))) fail(); return; }
  for(const child of Object.values(value)) checkTargets(child);
}
checkTargets(pkg.exports);
const bytes=fs.readFileSync(tgz);
const digest = algorithm => crypto.createHash(algorithm).update(bytes).digest('hex');
const metadata = {name:pkg.name,version,sourceSha,tarball:tarballs[0],sha256:digest('sha256'),sha512:digest('sha512'),files:files.sort()};
if(stage === '1') {
  if(metadata.sha256 !== process.env.EXPECTED_SHA256) fail();
  const recorded = JSON.parse(fs.readFileSync(path.join(out,'metadata.json'),'utf8'));
  if(!require('node:util').isDeepStrictEqual(recorded,metadata)) fail();
} else {
  fs.writeFileSync(path.join(out,'metadata.json'), JSON.stringify(metadata,null,2)+'\n');
  if(process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`sha256=${metadata.sha256}\nversion=${version}\n`);
}
NODE
if (( stage )); then
  status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' "${registry}@yefengr%2fpwa-foundation/$version")" || fail 'registry 请求失败，未上传'
  case "$status" in
    200) printf '%s@%s 已公开，跳过上传。\n' "$name" "$version"; exit 0 ;;
    404) ;;
    *) fail 'registry 未返回明确的 200/404，未上传' ;;
  esac
  tarballs=("$out"/*.tgz)
  [[ ${#tarballs[@]} -eq 1 && -f "${tarballs[0]}" ]] || fail '没有唯一审核 tarball'
  # 不自动重试：失败可能已经被 npm 接收，必须人工核对待审区。
  npm stage publish "${tarballs[0]}" --access public --ignore-scripts --registry="$registry"
  printf '%s@%s 已提交 npm 待审，尚未公开；由维护者核对并用 2FA 批准。\n' "$name" "$version"
else
  printf '%s@%s 验证打包成功；未联系 npm 上传。\n' "$name" "$version"
fi
