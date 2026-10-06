import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const env = { ...process.env, RELAY_IMAGE: `ghcr.io/example/pi-reach-relay@sha256:${'a'.repeat(64)}`, PWA_IMAGE: `ghcr.io/example/pi-reach-pwa@sha256:${'b'.repeat(64)}`,
  PI_REACH_STAGING_RELAY_CPUS: '1', PI_REACH_STAGING_RELAY_MEMORY: '256m', PI_REACH_STAGING_RELAY_PIDS_LIMIT: '100',
  PI_REACH_STAGING_PWA_CPUS: '1', PI_REACH_STAGING_PWA_MEMORY: '256m', PI_REACH_STAGING_PWA_PIDS_LIMIT: '100', PI_REACH_DEFAULT_RELAY_URL: 'https://test-relay.example' };

function normalized(file, directory, environment = env) {
  const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', '--project-directory', directory, '-f', file, 'config', '--format', 'json'], { encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, 'Real Compose must parse the deployment contract');
  return JSON.parse(result.stdout);
}

for (const environment of ['production', 'staging']) {
  test(`real Compose normalization matches the trusted ${environment} contract`, { skip: !composeAvailable }, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-reach-compose-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const script = readFileSync(join(root, 'scripts/deploy-from-ci.sh'), 'utf8');
    const functionText = script.match(/^trusted_compose\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(functionText);
    const project = environment === 'production' ? 'pi-reach' : 'pi-reach-staging';
    const output = spawnSync('/bin/bash', ['-eu', '-c', `${functionText}\ntrusted_compose`], { encoding: 'utf8', env: { ...env, ENVIRONMENT: environment, PROJECT: project } });
    assert.equal(output.status, 0);
    const template = join(directory, 'trusted.yml');
    writeFileSync(template, output.stdout);
    const actualFile = join(root, environment === 'production' ? 'docker-compose.yml' : 'docker/staging/compose.yml');
    const actual = normalized(actualFile, directory);
    assert.deepEqual(actual, normalized(template, directory));
    assert.equal(actual.name, project);
    for (const component of ['relay', 'pwa']) {
      assert.equal(actual.services[component].container_name, `${project}-${component}`);
      assert.equal(actual.services[component].ports[0].host_ip, '127.0.0.1');
    }
    if (environment === 'staging') {
      assert.equal(actual.services.pwa.environment.PI_REACH_DEFAULT_RELAY_URL, env.PI_REACH_DEFAULT_RELAY_URL);
      for (const key of ['PI_REACH_DEFAULT_RELAY_URL', 'PI_REACH_STAGING_RELAY_CPUS', 'PI_REACH_STAGING_PWA_MEMORY']) {
        const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-f', actualFile, 'config', '--quiet'], { encoding: 'utf8', env: { ...env, [key]: '' } });
        assert.notEqual(result.status, 0, `${key} must not silently default`);
      }
    } else {
      const localScript = readFileSync(join(root, 'scripts/deploy-self-hosted.sh'), 'utf8');
      const localFunction = localScript.match(/^production_compose_contract\(\) \{[\s\S]*?^\}/m)?.[0];
      assert.ok(localFunction);
      const local = spawnSync('/bin/bash', ['-eu', '-c', `${localFunction}\nproduction_compose_contract`], { encoding: 'utf8', env });
      assert.equal(local.status, 0);
      const localFile = join(directory, 'local.yml');
      writeFileSync(localFile, local.stdout);
      assert.deepEqual(normalized(localFile, directory), actual);
    }
  });
}
