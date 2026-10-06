import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const entry = new URL('./deploy-ci.mjs', import.meta.url).pathname;
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-ssh-'));
  const bin = join(root, 'bin'), runner = join(root, 'runner');
  mkdirSync(bin); mkdirSync(runner);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const key = args[args.indexOf('-i') + 1];
    fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({args: args.filter((_, index) => index !== args.indexOf('-i') + 1), keyMode: fs.statSync(key).mode & 511, directoryMode: fs.statSync(require('node:path').dirname(key)).mode & 511}));
    if (process.env.FAKE_SSH_FAIL) { console.error('credential-marker-must-not-leak'); process.exit(1); }
    console.log('{}');
  `;
  writeFileSync(join(bin, 'ssh'), source); chmodSync(join(bin, 'ssh'), 0o755);
  const result = spawnSync(process.execPath, [entry, 'staging'], { encoding: 'utf8', env: { ...process.env,
    PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, FAKE_LOG: join(root, 'calls'),
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), IMAGE_PREFIX: 'ghcr.io/example', SELECT_PWA: 'true', SELECT_RELAY: 'false',
    PWA_URL: 'https://test-pwa.example/app', RELAY_URL: 'https://test-relay.example',
    DEPLOY_HOST: 'server.example', DEPLOY_USER: 'deploy', DEPLOY_PORT: '22',
    DEPLOY_SSH_KEY: 'fixture-private-marker', DEPLOY_KNOWN_HOSTS: 'fixture-hostkey-marker', ...extra } });
  return { root, runner, ...result };
}

for (const fail of [false, true]) {
  test(`SSH failure/invalid snapshot cleans credentials and never prints private material (${fail})`, (t) => {
    const result = fixture(t, fail ? { FAKE_SSH_FAIL: '1' } : {});
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(result.runner), []);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-marker|fixture-hostkey-marker|credential-marker/);
    const call = JSON.parse(readFileSync(join(result.root, 'calls'), 'utf8'));
    assert.equal(call.keyMode, 0o600);
    assert.equal(call.directoryMode, 0o700);
    assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(call.args.includes('IdentitiesOnly=yes'));
    assert.ok(call.args.includes('BatchMode=yes'));
    assert.equal(call.args.at(-1), 'snapshot production');
  });
}

test('missing credentials fail before creating temporary SSH material', (t) => {
  const result = fixture(t, { DEPLOY_KNOWN_HOSTS: '' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(result.runner), []);
  assert.match(result.stderr, /missing DEPLOY_KNOWN_HOSTS/);
});

test('non-main requests fail before credentials are written', (t) => {
  const result = fixture(t, { GITHUB_REF: 'refs/heads/test' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(result.runner), []);
  assert.match(result.stderr, /main commit/);
});
