import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'extension-github-release.sh');
const REPOSITORY = 'example/pi-reach';

// curl 与 gh 的替身：记录调用；gh release create 时一并记下说明文件内容，便于断言 Release 文本。
// FAKE_NPM_STATUS_MAP 按版本覆盖 npm 状态，如 "0.0.2=404"；其余版本返回 FAKE_NPM_STATUS。
const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
url="\${@: -1}"
version="\${url##*/}"
for pair in $FAKE_NPM_STATUS_MAP; do
  if [ "\${pair%%=*}" = "$version" ]; then printf '%s' "\${pair#*=}"; exit 0; fi
done
printf '%s' "$FAKE_NPM_STATUS"
`;
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const entry = { args };
const notesIndex = args.indexOf('--notes-file');
if (notesIndex >= 0) entry.notes = fs.readFileSync(args[notesIndex + 1], 'utf8');
fs.appendFileSync(process.env.FAKE_LOG, 'gh ' + JSON.stringify(entry) + '\n');
if (args[0] === 'release' && args[1] === 'view') process.exit(process.env.FAKE_RELEASE_EXISTS ? 0 : 1);
if (args[0] === 'api' && args[1].endsWith('/git/tags')) process.stdout.write('fake-tag-sha\n');
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function commit(cwd, message, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

const manifest = (version, description = 'Pi Reach') => JSON.stringify({ name: '@yefengr/pi-reach', version, description });

// 0.0.1 与 0.0.2 已在提交待审时打过标签；当前版本为 0.0.3，其后还有未发布的提交。
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-extension-release-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);

  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'chore(release): 发布 Extension 0.0.1', { 'pi-extension/package.json': manifest('0.0.1') });
  git(repo, 'tag', '-a', 'extension-v0.0.1', '-m', 'Extension 0.0.1');
  commit(repo, 'fix: 修复扩展重连', { 'pi-extension/src/index.ts': 'export {};\n' });
  commit(repo, 'fix(pwa): 与扩展无关', { 'pwa/src/app.ts': 'export {};\n' });
  commit(repo, 'feat(protocol): 新增事件', { 'packages/protocol/src/index.ts': 'export {};\n' });
  const v2 = commit(repo, 'chore(release): 发布 PWA 0.0.9 与 Extension 0.0.2', {
    'pi-extension/package.json': manifest('0.0.2'),
  });
  git(repo, 'tag', '-a', 'extension-v0.0.2', '-m', 'Extension 0.0.2');
  commit(repo, 'docs: 更新扩展描述', { 'pi-extension/package.json': manifest('0.0.2', 'Pi Reach extension') });
  const v3 = commit(repo, 'chore(release): 发布 Extension 0.0.3', {
    'pi-extension/package.json': manifest('0.0.3', 'Pi Reach extension'),
  });
  commit(repo, 'fix: 下一版本的修复', { 'pi-extension/src/index.ts': 'export const next = 1;\n' });
  return { root, repo, v2, v3 };
}

function run(fixture, args, { npmStatus = '200', npmStatusMap = '', releaseExists = false } = {}) {
  const log = join(fixture.root, 'calls.log');
  const summary = join(fixture.root, 'summary.md');
  rmSync(log, { force: true });
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    env: {
      ...gitEnv(),
      PATH: `${join(fixture.root, 'bin')}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_NPM_STATUS: npmStatus,
      FAKE_NPM_STATUS_MAP: npmStatusMap,
      FAKE_RELEASE_EXISTS: releaseExists ? '1' : '',
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: fixture.root,
      RUN_URL: 'https://github.com/example/pi-reach/actions/runs/123',
    },
  });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const curl = lines.filter((line) => line.startsWith('curl '));
  const gh = lines.filter((line) => line.startsWith('gh ')).map((line) => JSON.parse(line.slice(3)));
  return { result, curl, gh };
}

function withFixture(fn) {
  const fixture = createFixture();
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const tagV3 = (fixture) => git(fixture.repo, 'tag', '-a', 'extension-v0.0.3', '-m', 'Extension 0.0.3', fixture.v3);

test('tag：在提交待审的提交上创建注解标签', () => withFixture((fixture) => {
  const { result, curl, gh } = run(fixture, ['tag', '0.0.3', fixture.v3]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 0);
  assert.deepEqual(gh.map((call) => call.args), [
    ['api', `repos/${REPOSITORY}/git/tags`, '-f', 'tag=extension-v0.0.3', '-f', 'message=Extension 0.0.3',
      '-f', `object=${fixture.v3}`, '-f', 'type=commit', '--jq', '.sha'],
    ['api', `repos/${REPOSITORY}/git/refs`, '-f', 'ref=refs/tags/extension-v0.0.3', '-f', 'sha=fake-tag-sha'],
  ]);
  assert.ok(readFileSync(join(fixture.root, 'summary.md'), 'utf8').includes('extension-v0.0.3'));
}));

test('tag：重跑时标签已指向同一提交则跳过，指向其他提交则失败', () => withFixture((fixture) => {
  const same = run(fixture, ['tag', '0.0.2', fixture.v2]);
  assert.equal(same.result.status, 0, same.result.stderr);
  assert.equal(same.gh.length, 0);

  git(fixture.repo, 'tag', '-f', '-a', 'extension-v0.0.2', '-m', 'Extension 0.0.2', 'HEAD~1');
  const other = run(fixture, ['tag', '0.0.2', fixture.v2]);
  assert.notEqual(other.result.status, 0);
  assert.match(other.result.stderr, /已指向其他提交/);
  assert.equal(other.gh.length, 0);
}));

test('tag：拒绝版本号与提交内容不符、格式无效的版本号或缩写 SHA', () => withFixture((fixture) => {
  const mismatch = run(fixture, ['tag', '0.0.3', fixture.v2]);
  assert.notEqual(mismatch.result.status, 0);
  assert.match(mismatch.result.stderr, /版本为 0\.0\.2，不是 0\.0\.3/);

  const invalid = run(fixture, ['tag', '0.0.3;touch x', fixture.v3]);
  assert.match(invalid.result.stderr, /版本号格式无效/);

  const short = run(fixture, ['tag', '0.0.3', fixture.v3.slice(0, 7)]);
  assert.match(short.result.stderr, /完整的 40 位 SHA/);
  assert.equal(mismatch.gh.length + invalid.gh.length + short.gh.length, 0);
}));

test('release：当前版本已上线时基于已有标签创建 Latest Release，不再创建标签', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release']);
  assert.equal(result.status, 0, result.stderr);
  // 先确认当前版本已上线，再确认起点标签 0.0.2 已上线。
  assert.deepEqual(curl.map((line) => line.split('/').at(-1)), ['0.0.3', '0.0.2']);
  assert.ok(curl[0].includes('https://registry.npmjs.org/@yefengr%2fpi-reach/0.0.3'));
  assert.deepEqual(gh.map((call) => call.args.slice(0, 2)), [['release', 'view'], ['release', 'create']]);
  const release = gh[1];
  assert.deepEqual(release.args.filter((arg) => !arg.endsWith('.md')), [
    'release', 'create', 'extension-v0.0.3', '--repo', REPOSITORY, '--verify-tag', '--title', 'Extension 0.0.3',
    '--notes-file', '--latest',
  ]);
  // 上一个标签是 0.0.2：列出其后涉及扩展或协议的提交，排除发布提交与版本号之后的提交。
  assert.equal(release.notes, [
    'npm：[`@yefengr/pi-reach@0.0.3`](https://www.npmjs.com/package/@yefengr/pi-reach/v/0.0.3)',
    '',
    '发布记录：[查看工作流](https://github.com/example/pi-reach/actions/runs/123)',
    '',
    '## 变更',
    '',
    '- docs: 更新扩展描述',
    '',
  ].join('\n'));
}));

test('release：补建历史版本时不标记 Latest，并去掉输入的首尾空白', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, ['release', ' 0.0.2 ']);
  assert.equal(result.status, 0, result.stderr);
  const release = gh.at(-1);
  assert.equal(release.args[2], 'extension-v0.0.2');
  assert.ok(release.args.includes('--latest=false'));
  // 与其他组件无关的提交不进入说明。
  assert.ok(release.notes.endsWith('## 变更\n\n- feat(protocol): 新增事件\n- fix: 修复扩展重连\n'));
}));

test('release：跳过未获批准的版本标签，从上一个已上线版本列出变更', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release'], { npmStatusMap: '0.0.2=404' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(curl.map((line) => line.split('/').at(-1)), ['0.0.3', '0.0.2', '0.0.1']);
  assert.ok(gh.at(-1).notes.endsWith('## 变更\n\n- docs: 更新扩展描述\n- feat(protocol): 新增事件\n- fix: 修复扩展重连\n'));
}));

test('release：无法确认起点标签是否上线时失败，不创建 Release', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, gh } = run(fixture, ['release'], { npmStatusMap: '0.0.2=503' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无法确认 extension-v0\.0\.2 是否已在 npm 上线（HTTP 503）/);
  assert.ok(gh.every((call) => call.args[1] === 'view'));
}));

test('release：Release 已存在时跳过，不查询 npm', () => withFixture((fixture) => {
  tagV3(fixture);
  const { result, curl, gh } = run(fixture, ['release'], { releaseExists: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 0);
  assert.deepEqual(gh.map((call) => call.args.slice(0, 2)), [['release', 'view']]);
}));

test('release：npm 上尚无该版本（待审）时跳过，不写入 GitHub', () => withFixture((fixture) => {
  for (const tagged of [true, false]) {
    if (tagged) tagV3(fixture);
    else git(fixture.repo, 'tag', '-d', 'extension-v0.0.3');
    const { result, gh } = run(fixture, ['release'], { npmStatus: '404' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /尚未在 npm 上线/);
    assert.ok(gh.every((call) => call.args[1] === 'view'));
  }
}));

test('release：已上线但缺少标签时失败并提示手工打标签', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, ['release']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少标签 extension-v0\.0\.3.*手工打标签/);
  assert.equal(gh.length, 0);
}));

test('release：无法确认 npm 状态或版本号无效时失败，不写入 GitHub', () => withFixture((fixture) => {
  tagV3(fixture);
  const unknown = run(fixture, ['release'], { npmStatus: '503' });
  assert.notEqual(unknown.result.status, 0);
  assert.match(unknown.result.stderr, /HTTP 503/);
  assert.ok(unknown.gh.every((call) => call.args[1] === 'view'));

  const invalid = run(fixture, ['release', '0.0.3;touch x']);
  assert.match(invalid.result.stderr, /版本号格式无效/);
  assert.equal(invalid.curl.length + invalid.gh.length, 0);
}));

test('未知子命令或参数数量不符时失败', () => withFixture((fixture) => {
  for (const args of [[], ['publish'], ['tag', '0.0.3'], ['release', '0.0.3', 'extra']]) {
    const { result, gh } = run(fixture, args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /用法/);
    assert.equal(gh.length, 0);
  }
}));
