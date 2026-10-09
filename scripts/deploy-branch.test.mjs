import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
