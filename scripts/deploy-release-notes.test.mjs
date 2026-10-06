import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(REPO_ROOT, 'scripts/deploy-release.sh'), 'utf8');
const releaseFunction = source.match(/^release\(\) \{\n[\s\S]*?^\}\n/m)?.[0];
assert.ok(releaseFunction, '正式 Release helper 必须包含 release 函数');

function generateNotes(component, url) {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-release-notes-'));
  try {
    // 直接运行模板真源；替身阻止 GitHub 写入，也不依赖仓库标签或提交历史。
    const result = spawnSync('bash', ['-eu', '-c', `
      git() {
        case "$1" in
          describe) printf '%s\\n' 'previous-v0.0.1' ;;
          log) printf '%s\\n' '- fix: 示例修复' ;;
          *) return 1 ;;
        esac
      }
      gh() {
        case "$2" in
          */git/ref/tags/*|*/releases/tags/*) echo 'HTTP 404' >&2; return 1 ;;
          *) printf '%s\\n' 'fake-tag-sha' ;;
        esac
      }
      ${releaseFunction}
      release "$COMPONENT" "$COMPONENT" 1.2.3 "ghcr.io/example/pi-reach-$COMPONENT:v1.2.3" sha256:example "$ONLINE_URL" "$COMPONENT"
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COMPONENT: component,
        ONLINE_URL: url,
        RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'example/pi-reach',
        GITHUB_SHA: 'example-commit',
        RUN_URL: 'https://github.com/example/pi-reach/actions/runs/123',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(join(root, `${component}-v1.2.3.md`), 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const component of ['pwa', 'relay']) {
  test(`${component} Release 分开展示明确链接与可复制的镜像引用`, () => {
    const url = `https://${component}.example.com/app`;
    const notes = generateNotes(component, url);
    assert.ok(notes.includes(`线上地址：[${url}](${url})\n\n`));
    assert.ok(notes.includes(`镜像：[\`ghcr.io/example/pi-reach-${component}:v1.2.3\`](https://github.com/example/pi-reach/pkgs/container/pi-reach-${component})\n\n`));
    assert.ok(notes.includes('镜像摘要：`sha256:example`\n\n'));
    assert.ok(notes.includes('部署记录：[查看工作流](https://github.com/example/pi-reach/actions/runs/123)\n\n'));
    assert.ok(notes.endsWith('## 变更\n\n- fix: 示例修复\n'));
  });
}

test('未配置线上地址时不生成空链接，仍提供镜像页面', () => {
  const notes = generateNotes('pwa', '');
  assert.ok(notes.startsWith('线上地址：未配置\n\n'));
  assert.ok(notes.includes('/pkgs/container/pi-reach-pwa)'));
  assert.ok(!notes.includes('[]()'));
});
