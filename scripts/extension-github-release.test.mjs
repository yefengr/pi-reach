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
const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
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

// 0.0.1 已有标签；0.0.2 尚未打标签；当前版本为 0.0.3，其后还有未发布的提交。
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
  git(repo, 'tag', 'extension-v0.0.1');
  commit(repo, 'fix: 修复扩展重连', { 'pi-extension/src/index.ts': 'export {};\n' });
  commit(repo, 'fix(pwa): 与扩展无关', { 'pwa/src/app.ts': 'export {};\n' });
  commit(repo, 'feat(protocol): 新增事件', { 'packages/protocol/src/index.ts': 'export {};\n' });
  const v2 = commit(repo, 'chore(release): 发布 PWA 0.0.9 与 Extension 0.0.2', {
    'pi-extension/package.json': manifest('0.0.2'),
  });
  commit(repo, 'docs: 更新扩展描述', { 'pi-extension/package.json': manifest('0.0.2', 'Pi Reach extension') });
  const v3 = commit(repo, 'chore(release): 发布 Extension 0.0.3', {
    'pi-extension/package.json': manifest('0.0.3', 'Pi Reach extension'),
  });
  commit(repo, 'fix: 下一版本的修复', { 'pi-extension/src/index.ts': 'export const next = 1;\n' });
  return { root, repo, v2, v3 };
}

function run(fixture, { args = [], npmStatus = '200', releaseExists = false } = {}) {
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

test('当前版本已上线时在版本号变更提交上打标签，并创建 Latest Release', () => withFixture((fixture) => {
  const { result, curl, gh } = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 1);
  assert.ok(curl[0].includes('https://registry.npmjs.org/@yefengr%2fpi-reach/0.0.3'));

  assert.equal(gh.length, 3);
  assert.deepEqual(gh[0].args, [
    'api', `repos/${REPOSITORY}/git/tags`, '-f', 'tag=extension-v0.0.3', '-f', 'message=Extension 0.0.3',
    '-f', `object=${fixture.v3}`, '-f', 'type=commit', '--jq', '.sha',
  ]);
  assert.deepEqual(gh[1].args, [
    'api', `repos/${REPOSITORY}/git/refs`, '-f', 'ref=refs/tags/extension-v0.0.3', '-f', 'sha=fake-tag-sha',
  ]);
  assert.deepEqual(gh[2].args.filter((arg) => !arg.endsWith('.md')), [
    'release', 'create', 'extension-v0.0.3', '--repo', REPOSITORY, '--verify-tag', '--title', 'Extension 0.0.3',
    '--notes-file', '--latest',
  ]);
  // 上一个标签是 0.0.1：列出其后涉及扩展或协议的提交，排除发布提交、其他组件与版本号之后的提交。
  assert.equal(gh[2].notes, [
    'npm：[`@yefengr/pi-reach@0.0.3`](https://www.npmjs.com/package/@yefengr/pi-reach/v/0.0.3)',
    '',
    '发布记录：[查看工作流](https://github.com/example/pi-reach/actions/runs/123)',
    '',
    '## 变更',
    '',
    '- docs: 更新扩展描述',
    '- feat(protocol): 新增事件',
    '- fix: 修复扩展重连',
    '',
  ].join('\n'));
  assert.ok(readFileSync(join(fixture.root, 'summary.md'), 'utf8').includes('extension-v0.0.3'));
}));

test('补建历史版本时定位该版本的变更提交，且不标记 Latest', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, { args: ['0.0.2'] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(gh[0].args.includes(`object=${fixture.v2}`));
  const release = gh.at(-1);
  assert.ok(release.args.includes('--latest=false'));
  assert.ok(release.notes.endsWith('## 变更\n\n- feat(protocol): 新增事件\n- fix: 修复扩展重连\n'));
}));

test('标签与 Release 都已存在时跳过，不查询 npm', () => withFixture((fixture) => {
  git(fixture.repo, 'tag', 'extension-v0.0.3', fixture.v3);
  const { result, curl, gh } = run(fixture, { releaseExists: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(curl.length, 0);
  assert.deepEqual(gh.map((call) => call.args.slice(0, 2)), [['release', 'view']]);
}));

test('标签已存在但缺少 Release 时只补建 Release', () => withFixture((fixture) => {
  git(fixture.repo, 'tag', 'extension-v0.0.3', fixture.v3);
  const { result, gh } = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(gh.map((call) => call.args.slice(0, 2)), [['release', 'view'], ['release', 'create']]);
}));

test('npm 上尚无该版本（待审）时跳过，不写入 GitHub', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, { npmStatus: '404' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /尚未在 npm 上线/);
  assert.equal(gh.length, 0);
}));

test('无法确认 npm 状态时失败，不写入 GitHub', () => withFixture((fixture) => {
  const { result, gh } = run(fixture, { npmStatus: '503' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 503/);
  assert.equal(gh.length, 0);
}));

test('拒绝格式无效的版本号与历史中不存在的版本', () => withFixture((fixture) => {
  const invalid = run(fixture, { args: ['0.0.3;touch x'] });
  assert.notEqual(invalid.result.status, 0);
  assert.match(invalid.result.stderr, /版本号格式无效/);
  assert.equal(invalid.curl.length + invalid.gh.length, 0);

  const missing = run(fixture, { args: ['9.9.9'] });
  assert.notEqual(missing.result.status, 0);
  assert.match(missing.result.stderr, /没有把 pi-extension\/package.json 版本改为 9.9.9 的提交/);
  assert.equal(missing.gh.length, 0);
}));
