import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPONENT_INPUTS, branchComponents } from './deploy-branch.mjs';

test('component selection follows each Dockerfile build input', () => {
  assert.deepEqual(branchComponents(['pwa/src/App.tsx']), { relay: false, pwa: true });
  assert.deepEqual(branchComponents(['relay/src/server.ts']), { relay: true, pwa: false });
  assert.deepEqual(branchComponents(['pi-extension/install.sh']), { relay: false, pwa: true });
  for (const shared of ['packages/protocol/src/index.ts', 'pnpm-lock.yaml', 'package.json', 'pi-extension/package.json']) {
    assert.deepEqual(branchComponents([shared]), { relay: true, pwa: true });
  }
});

test('files outside build inputs select nothing', () => {
  assert.deepEqual(branchComponents([]), { relay: false, pwa: false });
  assert.deepEqual(branchComponents(['docs/DEPLOYMENT.md', 'pi-extension/src/index.ts', 'pwa-notes.md', 'relay.md']), { relay: false, pwa: false });
});

test('workflow push paths cover exactly the component inputs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8');
  const paths = workflow.split('    paths:\n')[1].split('  workflow_dispatch:')[0]
    .split('\n').filter((line) => line.trim().startsWith('- ')).map((line) => line.trim().slice(2));
  const inputs = [...new Set(Object.values(COMPONENT_INPUTS).flat())].map((input) => (input.endsWith('/') ? `${input}**` : input));
  assert.deepEqual([...paths].sort(), inputs.sort());
});

test('moving a file out of a component directory still selects that component', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-deploy-branch-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-q');
    mkdirSync(join(root, 'relay'));
    writeFileSync(join(root, 'relay', 'server.ts'), 'export const port = 3000;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    mkdirSync(join(root, 'docs'));
    git('mv', 'relay/server.ts', 'docs/server.ts');
    git('commit', '-qm', 'move');
    const output = join(root, 'output');
    const script = fileURLToPath(new URL('./deploy-branch.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'relay=true\npwa=false\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
