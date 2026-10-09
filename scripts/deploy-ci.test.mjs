import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deployStage, imageRef, snapshotJson } from './deploy-ci.mjs';

const prefix = 'ghcr.io/example';
const sha = 'a'.repeat(40);
const image = (component, digit, version = '1.0.0') => `${prefix}/pi-reach-${component}:v${version}@sha256:${digit.repeat(64)}`;
const baseline = { relay: { image: image('relay', '1'), revision: 'b'.repeat(40) }, pwa: { image: image('pwa', '2'), revision: 'c'.repeat(40) } };
const env = { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, IMAGE_PREFIX: prefix, SELECT_RELAY: 'false', SELECT_PWA: 'true', PWA_IMAGE: image('pwa', '3', '1.0.1'), PWA_URL: 'https://test-pwa.example/app', RELAY_URL: 'https://test-relay.example' };
const tested = { ...baseline, pwa: { image: env.PWA_IMAGE, revision: sha } };
const prodEnv = { ...env, BASELINE: JSON.stringify(baseline), TESTED: JSON.stringify(tested), STAGING_TARGET: JSON.stringify({ pwaUrl: env.PWA_URL, relayUrl: env.RELAY_URL }), PWA_URL: 'https://pwa.example/app', RELAY_URL: 'https://relay.example' };

function harness({ current = baseline, staging = tested, failDeploy, failSmoke = false, tagged = false } = {}) {
  const calls = [];
  let production = structuredClone(current);
  let stage = structuredClone(staging);
  const remote = async (request) => {
    calls.push(request);
    if (request === 'snapshot production') return JSON.stringify(production);
    if (request === 'snapshot staging') return JSON.stringify(stage);
    const [, component, ref] = request.split(' ');
    if (failDeploy === component) throw new Error('deployment failure');
    const destination = calls.mode === 'staging' ? stage : production;
    destination[component] = { image: ref, revision: ref === baseline[component].image ? baseline[component].revision : sha };
    return 'deployed';
  };
  return { calls, remote, runSmoke: async (options) => { calls.push(`smoke ${options.pwaUrl}`); if (failSmoke) throw new Error('smoke failed'); }, published: () => tagged };
}

function stage(options = {}, extraEnv = {}) {
  const h = harness(options);
  h.calls.mode = 'staging';
  const outputs = {};
  return { ...h, outputs, run: () => deployStage({ ...h, mode: 'staging', env: { ...env, ...extraEnv }, output: (key, value) => { outputs[key] = value; } }) };
}
function production(options = {}, extraEnv = {}) {
  const h = harness(options);
  return { ...h, run: () => deployStage({ ...h, mode: 'production', env: { ...prodEnv, ...extraEnv } }) };
}

test('single-component staging aligns the unselected component with actual production digest', async () => {
  const h = stage();
  await h.run();
  assert.deepEqual(h.calls.slice(0, 4), ['snapshot production', `deploy relay ${baseline.relay.image}`, `deploy pwa ${tested.pwa.image}`, 'snapshot staging']);
  assert.deepEqual(JSON.parse(h.outputs.baseline), baseline);
  assert.deepEqual(JSON.parse(h.outputs.tested), tested);
});

test('both selection deploys Relay then PWA and records both candidate digests', async () => {
  const h = stage({}, { SELECT_RELAY: 'true', RELAY_IMAGE: image('relay', '4', '1.0.1') });
  await h.run();
  assert.equal(h.calls[1], `deploy relay ${image('relay', '4', '1.0.1')}`);
  assert.equal(JSON.parse(h.outputs.tested).relay.revision, sha);
});

for (const failure of [{ failDeploy: 'relay' }, { failDeploy: 'pwa' }, { failSmoke: true }]) {
  test(`staging failure ${JSON.stringify(failure)} emits no successful receipt`, async () => {
    const h = stage(failure);
    await assert.rejects(h.run);
    assert.deepEqual(h.outputs, {});
  });
}

test('approval promotes exactly the build digest, without rebuilding or touching unselected service', async () => {
  const h = production();
  await h.run();
  assert.deepEqual(h.calls, ['snapshot production', 'snapshot staging', `deploy pwa ${tested.pwa.image}`, 'snapshot production', 'smoke https://pwa.example/app']);
});

test('production rejects staging smoke mistakenly pointed at production origins', async () => {
  const h = production({}, { STAGING_TARGET: JSON.stringify({ pwaUrl: prodEnv.PWA_URL, relayUrl: prodEnv.RELAY_URL }) });
  await assert.rejects(h.run, /distinct origins/);
  assert.equal(h.calls.length, 0);
});

test('production rejects a replaced staging candidate before any write', async () => {
  const h = production({ staging: { ...tested, pwa: { ...tested.pwa, image: image('pwa', '5', '1.0.1') } } });
  await assert.rejects(h.run, /drifted/);
  assert.ok(h.calls.every((request) => !request.startsWith('deploy ')));
});

test('production rejects an unselected component changed during approval', async () => {
  const h = production({ current: { ...baseline, relay: { ...baseline.relay, image: image('relay', '5') } } });
  await assert.rejects(h.run, /drifted/);
  assert.ok(h.calls.every((request) => !request.startsWith('deploy ')));
});

test('same version from a repaired source/digest cannot reuse the previous receipt', async () => {
  const h = production({}, { GITHUB_SHA: 'd'.repeat(40), PWA_IMAGE: image('pwa', '6', '1.0.1') });
  await assert.rejects(h.run, /drifted/);
  assert.equal(h.calls.length, 0);
});

test('rerun after a successful update rechecks the exact live image without restarting it', async () => {
  const h = production({ current: tested });
  await h.run();
  assert.ok(!h.calls.some((request) => request.startsWith('deploy ')));
  assert.ok(h.calls.includes('snapshot staging'));
});

test('Release-only repair requires verified tags plus the exact live combination and never deploys', async () => {
  const h = production({ current: tested, tagged: true, staging: baseline });
  await h.run();
  assert.ok(!h.calls.some((request) => request.startsWith('deploy ') || request === 'snapshot staging'));
  assert.ok(h.calls.some((request) => request.startsWith('smoke ')));
  await assert.rejects(production({ tagged: true }).run, /drifted/);
});

test('public failure remains a failure even if images are already live', async () => {
  const h = production({ failSmoke: true });
  await assert.rejects(h.run, /smoke failed/);
});

for (const values of [{ GITHUB_REF: 'refs/heads/test' }, { RELAY_URL: '' }, { PWA_URL: '' }, { SELECT_PWA: '' }, { PWA_IMAGE: 'ghcr.io/example/pi-reach-pwa:v1.0.1' }]) {
  test(`invalid context fails before SSH: ${Object.keys(values).join(',')}`, async () => {
    const h = stage({}, values);
    await assert.rejects(h.run);
    assert.ok(!h.calls.some((request) => request.startsWith('deploy ')));
  });
}

test('snapshot and image input fail closed for unknown fields, repositories and mutable tags', () => {
  for (const invalid of ['', '{}', JSON.stringify({ ...baseline, extra: true }), JSON.stringify({ ...baseline, pwa: { ...baseline.pwa, secret: 'not-allowed' } })]) {
    assert.throws(() => snapshotJson(invalid, prefix));
  }
  assert.throws(() => imageRef(image('relay', '1'), prefix, 'pwa'));
  assert.throws(() => imageRef('ghcr.io/example/pi-reach-pwa:latest', prefix, 'pwa'));
});

test('workflow wires mandatory staging dependency, environment permissions, immutable outputs and cleanup', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const build = workflow.split('  build:\n')[1].split('  staging:\n')[0];
  const staging = workflow.split('  staging:\n')[1].split('  production:\n')[0];
  const production = workflow.split('  production:\n')[1];
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /run: test "\$REF" = refs\/heads\/main/);
  assert.match(staging, /needs: \[plan, build\]/);
  assert.match(staging, /name: staging/);
  assert.match(staging, /contents: read/);
  assert.doesNotMatch(staging, /contents: write|deploy-release|always\(\).*needs/);
  assert.match(production, /needs: \[plan, build, staging\]/);
  assert.match(production, /name: production/);
  assert.doesNotMatch(production, /continue-on-error|if: always\(\)[\s\S]*environment:/);
  assert.match(production, /TESTED: \$\{\{ needs.staging.outputs.tested \}\}/);
  assert.match(production, /needs.build.outputs.pwa-digest/);
  assert.match(build, /subject-digest: \$\{\{ steps.pwa.outputs.digest \}\}/);
  assert.doesNotMatch(staging + production, /docker\/build-push-action/);
  for (const job of [staging, production]) assert.match(job, /if: always\(\)\n        run: rm -rf "\$RUNNER_TEMP"\/pi-reach-deploy-\*/);
  assert.ok(production.indexOf('deploy-ci.mjs production') < production.indexOf('deploy-release.sh'));
});

const branchEnv = { GITHUB_REF: 'refs/heads/bugfix/261009-example' };

test('branch staging deploys the same aligned combination but emits no promotion evidence', async () => {
  const h = stage({}, branchEnv);
  const notes = [];
  await deployStage({ ...h, mode: 'staging-branch', env: { ...env, ...branchEnv }, note: (message) => notes.push(message), output: (key, value) => { h.outputs[key] = value; } });
  assert.deepEqual([...h.calls], ['snapshot production', `deploy relay ${baseline.relay.image}`, `deploy pwa ${tested.pwa.image}`, 'snapshot staging', `smoke ${env.PWA_URL}`]);
  assert.deepEqual(h.outputs, {});
  assert.ok(notes.some((message) => message.includes('bugfix/261009-example') && message.includes('not a release candidate')));
});

for (const ref of ['refs/heads/main', 'refs/heads/dependabot/npm/x', 'refs/heads/bugfix/a/b', 'refs/heads/feature/', 'refs/tags/feature/x']) {
  test(`branch staging rejects ${ref} before SSH`, async () => {
    const h = stage({}, { GITHUB_REF: ref });
    await assert.rejects(deployStage({ ...h, mode: 'staging-branch', env: { ...env, GITHUB_REF: ref } }), /bugfix\/\* or feature\/\*/);
    assert.equal(h.calls.length, 0);
  });
}

test('release staging and production still accept only main', async () => {
  await assert.rejects(stage({}, branchEnv).run, /main commit/);
  const h = production({}, branchEnv);
  await assert.rejects(h.run, /main commit/);
  assert.equal(h.calls.length, 0);
});

test('branch staging workflow is owner-only, staging-only, digest-only and never cancels a running deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8');
  const build = workflow.split('  build:\n')[1].split('  staging:\n')[0];
  const staging = workflow.split('  staging:\n')[1];
  const ownerOnly = /github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner/;
  assert.match(build, ownerOnly);
  assert.match(staging, ownerOnly);
  assert.match(build, /group: staging-branch-build\n      cancel-in-progress: true/);
  assert.doesNotMatch(staging, /needs\.build\.outputs\.(relay|pwa) ==/);
  assert.match(staging, /group: deploy-staging-branch\n      cancel-in-progress: false/);
  assert.match(staging, /name: staging\n/);
  assert.doesNotMatch(workflow, /name: production|contents: write|deploy-release|^\s+tags:/m);
  assert.equal(build.match(/push-by-digest=true/g)?.length, 2);
  assert.match(staging, /run: node scripts\/deploy-ci\.mjs staging-branch/);
  assert.match(staging, /if: always\(\)\n        run: rm -rf "\$RUNNER_TEMP"\/pi-reach-deploy-\*/);
});

test('branch staging with no component difference realigns staging with production', async () => {
  const noneEnv = { ...branchEnv, SELECT_PWA: 'false', SELECT_RELAY: 'false' };
  const h = stage({ staging: tested }, noneEnv);
  const notes = [];
  const result = await deployStage({ ...h, mode: 'staging-branch', env: { ...env, ...noneEnv }, note: (message) => notes.push(message) });
  assert.deepEqual(result, baseline);
  assert.deepEqual([...h.calls].slice(0, 4), ['snapshot production', `deploy relay ${baseline.relay.image}`, `deploy pwa ${baseline.pwa.image}`, 'snapshot staging']);
  assert.ok(notes.includes('no component differs from main; staging is aligned with production'));
});

test('release staging and production still require a selected component', async () => {
  const none = { SELECT_PWA: 'false', SELECT_RELAY: 'false' };
  await assert.rejects(stage({}, none).run, /No selected components/);
  await assert.rejects(production({}, none).run, /No selected components/);
});
