import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/deploy-from-ci.sh');
const PREFIX = 'ghcr.io/example';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD_ID = `sha256:${'b'.repeat(64)}`;
const RELAY_ID = `sha256:${'c'.repeat(64)}`;
const REPO = `${PREFIX}/pi-reach-pwa`;
const REQUEST = `deploy pwa ${REPO}:v0.0.4@${DIGEST}`;
const IMMUTABLE = `${REPO}@${DIGEST}`;
const STAGING_ENV = {
  PI_REACH_DEPLOY_ENVIRONMENT: 'staging',
  PI_REACH_STAGING_RELAY_CPUS: '1',
  PI_REACH_STAGING_RELAY_MEMORY: '256m',
  PI_REACH_STAGING_RELAY_PIDS_LIMIT: '100',
  PI_REACH_STAGING_PWA_CPUS: '1',
  PI_REACH_STAGING_PWA_MEMORY: '256m',
  PI_REACH_STAGING_PWA_PIDS_LIMIT: '100',
  PI_REACH_DEFAULT_RELAY_URL: 'https://staging-relay.example.invalid',
};

// No real Docker writes. The config substitute compares the full fixture model including extra fields.
// Real Compose normalization is verified separately by the coordinating agent.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, cwd: process.cwd(), relay: process.env.RELAY_IMAGE, pwa: process.env.PWA_IMAGE,
  productionLocked: fs.existsSync(path.join(process.env.PI_REACH_DEPLOY_ENVIRONMENT === 'staging' ? process.env.PI_REACH_PRODUCTION_DIR : process.env.PI_REACH_REMOTE_DIR, '.pi-reach-deploy-lock')),
  stagingLocked: fs.existsSync(path.join(process.env.PI_REACH_REMOTE_DIR, '.pi-reach-deploy-lock')) }) + '\n');
if (name === 'docker-compose') {
  if (args.includes('config')) {
    if (process.env.FAKE_CONFIG_FAIL) process.exit(1);
    const file = args[args.indexOf('-f') + 1];
    const vars = { ...process.env };
    const envFile = path.join(process.cwd(), '.env');
    if (!args.includes('--env-file') && fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0 && !(line.slice(0, at) in vars)) vars[line.slice(0, at)] = line.slice(at + 1);
    }
    const text = fs.readFileSync(file, 'utf8').replace(/\$\{([^}:]+)(?::\?[^}]*)?\}/g, (_, key) => {
      if (!vars[key]) process.exit(1);
      return vars[key];
    });
    process.stdout.write(JSON.stringify(text.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => line.trim())));
  }
  if (args.includes('up')) {
    const service = args.at(-1);
    const project = process.env.PI_REACH_DEPLOY_ENVIRONMENT === 'staging' ? 'pi-reach-staging' : 'pi-reach';
    state.current[project + '-' + service] = process.env[service.toUpperCase() + '_IMAGE'];
    save();
    if (process.env.FAKE_UP_FAIL && !process.env[service.toUpperCase() + '_IMAGE'].startsWith('sha256:')) process.exit(42);
  }
  process.exit(0);
}
if (args[0] === 'inspect') {
  const format = args[2], container = args[3];
  if (format.includes('.State.Health')) process.stdout.write(state.healthy.includes(state.current[container]) ? 'healthy' : 'unhealthy');
  else if (format === '{{.Image}}') {
    for (const name of args.slice(3)) {
      const current = state.current[name];
      if (!current) process.exit(1);
      process.stdout.write(current + '\n');
    }
  } else throw Error('Unexpected inspect: ' + format);
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const format = args[3], id = args[4];
  if (!id.startsWith('sha256:') && !id.includes('@sha256:')) throw Error('Mutable image metadata inspection');
  if (format.includes('pi-reach.runtime-config')) process.stdout.write(process.env.FAKE_RUNTIME_CONFIG ?? '1');
  else if (format.includes('RepoDigests')) process.stdout.write(process.env.FAKE_DIGESTS || (process.env.PI_REACH_IMAGE_PREFIX + '/pi-reach-' + (id === 'sha256:' + 'c'.repeat(64) ? 'relay' : 'pwa') + '@sha256:' + 'a'.repeat(64)));
  else if (format.includes('image.version')) process.stdout.write(process.env.FAKE_VERSION ?? '0.0.4');
  else if (format.includes('image.revision')) process.stdout.write(process.env.FAKE_REVISION ?? 'd'.repeat(40));
  process.exit(0);
}
if (args[0] === 'tag') { state.tags.push(args[2]); state.images.push({ ref: args[2], created: '2026-10-01', id: 'sha256:' + 'e'.repeat(64) }); save(); }
if (args[0] === 'ps') for (const container of Object.keys(state.current)) process.stdout.write(container + '\n');
if (args[0] === 'images' && !args.includes('--quiet')) {
  const repository = args.at(-1);
  for (const image of state.images) if (image.ref.startsWith(repository + ':')) process.stdout.write(image.created + '|' + image.ref.split(':').at(-1) + '|' + image.id + '\n');
}
if (args[0] === 'rmi') { state.images = state.images.filter(image => image.ref !== args[1]); save(); }
process.exit(0);
`;

function fixture(t, { staging = false, current, healthy, images = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-reach-ci-')));
  const remote = join(root, 'remote'), production = join(root, 'production'), bin = join(root, 'bin');
  for (const dir of [remote, production, bin]) mkdirSync(dir);
  copyFileSync(join(ROOT, staging ? 'docker/staging/compose.yml' : 'docker-compose.yml'), join(remote, 'docker-compose.yml'));
  for (const name of ['docker', 'docker-compose']) { writeFileSync(join(bin, name), FAKE); chmodSync(join(bin, name), 0o755); }
  const stateFile = join(root, 'state.json'), log = join(root, 'log');
  writeFileSync(stateFile, JSON.stringify({ current: current ?? { [(staging ? 'pi-reach-staging' : 'pi-reach') + '-pwa']: OLD_ID }, healthy: healthy ?? [IMMUTABLE, OLD_ID], tags: [], images }));
  writeFileSync(log, '');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, remote, production, bin, stateFile, log, staging };
}
function run(f, request = REQUEST, env = {}) {
  writeFileSync(f.log, '');
  const result = spawnSync('/bin/bash', [SCRIPT], { encoding: 'utf8', env: {
    PATH: `${f.bin}:${process.env.PATH}`, FAKE_STATE: f.stateFile, FAKE_LOG: f.log,
    PI_REACH_REMOTE_DIR: f.remote, PI_REACH_PRODUCTION_DIR: f.production, PI_REACH_IMAGE_PREFIX: PREFIX,
    PI_REACH_HEALTH_ATTEMPTS: '2', PI_REACH_HEALTH_INTERVAL: '0', SSH_ORIGINAL_COMMAND: request,
    ...(f.staging ? STAGING_ENV : {}), ...env,
  } });
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...result, calls, state: JSON.parse(readFileSync(f.stateFile, 'utf8')) };
}
const ups = r => r.calls.filter(c => c.name === 'docker-compose' && c.args.includes('up'));
const writes = r => r.calls.filter(c => c.name === 'docker' && ['pull', 'tag', 'rmi'].includes(c.args[0]) || c.name === 'docker-compose' && c.args.includes('up'));
const lock = dir => join(dir, '.pi-reach-deploy-lock');

test('strict requests and unknown environments are rejected without Docker calls', t => {
  for (const request of ['', 'deploy', REQUEST + ' extra', REQUEST + '\nreboot', REQUEST + '\r', REQUEST.replace('deploy', 'run'), REQUEST.replace('pwa ', 'site '), REQUEST.replace(PREFIX, 'ghcr.io/other'), REQUEST.replace('v0.0.4', 'latest'), REQUEST.replace('@' + DIGEST, ''), REQUEST + ';reboot', 'snapshot unknown', 'snapshot production extra']) {
    const f = fixture(t), r = run(f, request);
    assert.notEqual(r.status, 0, request); assert.match(r.stderr, /Rejected request/); assert.deepEqual(r.calls, []);
  }
  const f = fixture(t), r = run(f, REQUEST, { PI_REACH_DEPLOY_ENVIRONMENT: 'unknown' });
  assert.notEqual(r.status, 0); assert.deepEqual(r.calls, []);
});

test('production default matches trusted root template and uses digest only for runtime', t => {
  const f = fixture(t), r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ups(r).length, 1); assert.equal(ups(r)[0].pwa, IMMUTABLE);
  assert.equal(ups(r)[0].relay, 'invalid.invalid/pi-reach-relay-unselected:never');
  assert.equal(ups(r)[0].args.at(-1), 'pwa');
  assert.ok(r.calls.some(c => c.name === 'docker' && c.args.join(' ') === `pull --quiet ${IMMUTABLE}`));
  assert.ok(r.calls.filter(c => c.name === 'docker-compose' && c.args.includes('config')).every(c => c.args.includes('--format') && c.args.includes('json')));
  assert.equal(existsSync(lock(f.remote)), false);
});

test('relay uses immutable RELAY_IMAGE and never updates PWA', t => {
  const target = `${PREFIX}/pi-reach-relay@${DIGEST}`;
  const f = fixture(t, { current: {}, healthy: [target] }), r = run(f, `deploy relay ${PREFIX}/pi-reach-relay:v0.0.4@${DIGEST}`);
  assert.equal(r.status, 0, r.stderr); assert.equal(ups(r)[0].relay, target); assert.equal(ups(r)[0].args.at(-1), 'relay');
});

test('staging template matches, holds production then staging locks, and never prunes', t => {
  const f = fixture(t, { staging: true }), r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.every(c => c.productionLocked && c.stagingLocked));
  assert.equal(r.state.current['pi-reach-staging-pwa'], IMMUTABLE);
  assert.ok(!r.calls.some(c => c.name === 'docker' && ['images', 'ps', 'rmi'].includes(c.args[0])));
  assert.equal(existsSync(lock(f.production)), false); assert.equal(existsSync(lock(f.remote)), false);
});

test('staging refuses an old PWA image before starting any PWA container', t => {
  const f = fixture(t, { staging: true }), r = run(f, REQUEST, { FAKE_RUNTIME_CONFIG: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /runtime-config-capable candidate/);
  assert.equal(ups(r).length, 0);
  assert.ok(!r.calls.some(c => c.name === 'docker' && c.args[0] === 'tag'));
});

test('every binding or unexpected volume is rejected before Docker writes without config logging', t => {
  const mutations = [s => s.replace('pi-reach-staging\n', 'pi-reach\n'), s => s.replace('pi-reach-staging-pwa', 'pi-reach-pwa'), s => s.replace('127.0.0.1:3003', '127.0.0.1:3001'), s => s.replace('127.0.0.1:3002', '0.0.0.0:3002'), s => s + '\nvolumes:\n  unexpected-secret-marker: {}\n', s => s.replace('PORT: "3000"', 'PORT: "4000"'), s => s.replace('restart: unless-stopped', 'restart: always')];
  for (const mutate of mutations) {
    const f = fixture(t, { staging: true }), file = join(f.remote, 'docker-compose.yml');
    writeFileSync(file, mutate(readFileSync(file, 'utf8')));
    const r = run(f); assert.notEqual(r.status, 0); assert.match(r.stderr, /configuration does not match/);
    assert.deepEqual(writes(r), []); assert.doesNotMatch(r.stdout + r.stderr, /unexpected-secret-marker|PORT:|services:/);
  }
});

test('ambient Compose overrides and .env cannot mask the fixed contract', t => {
  const f = fixture(t, { staging: true });
  writeFileSync(join(f.remote, '.env'), 'COMPOSE_PROJECT_NAME=pi-reach\nCOMPOSE_FILE=/not/allowed\n');
  const r = run(f, REQUEST, { COMPOSE_PROJECT_NAME: 'pi-reach', COMPOSE_FILE: '/not/allowed' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.filter(c => c.name === 'docker-compose').every(c => c.args.includes('--env-file') && c.args.includes('/dev/null')));
});

test('missing staging public configuration and limits fail before writes', t => {
  for (const key of Object.keys(STAGING_ENV).filter(k => k !== 'PI_REACH_DEPLOY_ENVIRONMENT')) {
    const f = fixture(t, { staging: true }), r = run(f, REQUEST, { [key]: '' });
    assert.notEqual(r.status, 0, key); assert.deepEqual(writes(r), []);
  }
});

test('staging refuses production Compose and aliased production directory', t => {
  const f = fixture(t, { staging: true }); copyFileSync(join(ROOT, 'docker-compose.yml'), join(f.remote, 'docker-compose.yml'));
  assert.deepEqual(writes(run(f)), []);
  const r = run(f, REQUEST, { PI_REACH_PRODUCTION_DIR: f.remote + '/../remote' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /must differ/); assert.deepEqual(r.calls, []);
});

test('both lock conflicts refuse work and a staging conflict releases only acquired production lock', t => {
  for (const which of ['production', 'remote']) {
    const f = fixture(t, { staging: true }); mkdirSync(lock(f[which]));
    const r = run(f); assert.notEqual(r.status, 0); assert.match(r.stderr, /Concurrent deployment rejected/); assert.deepEqual(r.calls, []);
    assert.equal(existsSync(lock(f[which])), true);
    if (which === 'remote') assert.equal(existsSync(lock(f.production)), false);
  }
  const f = fixture(t); mkdirSync(lock(f.remote)); assert.deepEqual(run(f).calls, []);
});

test('health or up failure restores actual old ID even when version tag was overwritten', t => {
  for (const env of [{}, { FAKE_UP_FAIL: '1' }]) {
    const f = fixture(t, { healthy: [OLD_ID] }), r = run(f, REQUEST, env);
    assert.equal(r.status, 1); assert.match(r.stderr, /restored to sha256:/);
    assert.deepEqual(ups(r).map(c => c.pwa), [IMMUTABLE, OLD_ID]); assert.equal(r.state.current['pi-reach-pwa'], OLD_ID);
    assert.equal(existsSync(lock(f.remote)), false);
  }
});

test('failed restore and missing previous image are reported distinctly', t => {
  const f = fixture(t, { healthy: [] }), r = run(f); assert.match(r.stderr, /did not become healthy/);
  const empty = fixture(t, { current: {}, healthy: [] }); assert.match(run(empty).stderr, /no earlier image/);
});

test('snapshot of either fixed environment emits only complete JSON and inspects actual IDs', t => {
  const current = {}, healthy = [OLD_ID, RELAY_ID];
  for (const project of ['pi-reach', 'pi-reach-staging']) { current[project + '-pwa'] = OLD_ID; current[project + '-relay'] = RELAY_ID; }
  for (const staging of [false, true]) for (const target of ['production', 'staging']) {
    const f = fixture(t, { staging, current, healthy }), r = run(f, 'snapshot ' + target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { relay: { image: `${PREFIX}/pi-reach-relay:v0.0.4@${DIGEST}`, revision: 'd'.repeat(40) }, pwa: { image: `${REPO}:v0.0.4@${DIGEST}`, revision: 'd'.repeat(40) } });
    assert.deepEqual(writes(r), []); assert.ok(r.calls.every(c => c.productionLocked));
    assert.ok(r.calls.filter(c => c.name === 'docker' && c.args[0] === 'inspect').every(c => c.args[3].startsWith(target === 'production' ? 'pi-reach-' : 'pi-reach-staging-')));
  }
});

test('snapshot fails closed on incomplete/unhealthy or unverifiable metadata without partial stdout', t => {
  const current = { 'pi-reach-pwa': OLD_ID, 'pi-reach-relay': RELAY_ID };
  for (const env of [{ FAKE_VERSION: 'latest' }, { FAKE_VERSION: '' }, { FAKE_REVISION: 'secret-marker"' }, { FAKE_DIGESTS: `ghcr.io/other/pi-reach-pwa@${DIGEST}` }]) {
    const f = fixture(t, { current, healthy: [OLD_ID, RELAY_ID] }), r = run(f, 'snapshot production', env);
    assert.notEqual(r.status, 0); assert.equal(r.stdout, ''); assert.deepEqual(writes(r), []); assert.doesNotMatch(r.stderr, /secret-marker/);
  }
  const f = fixture(t), r = run(f, 'snapshot production'); assert.notEqual(r.status, 0); assert.equal(r.stdout, '');
});

test('production retains deployed tag and newest tags while protecting any environment container', t => {
  const images = ['v0.0.0', 'v0.0.1', 'v0.0.2', 'v0.0.3'].map((tag, index) => ({ ref: `${REPO}:${tag}`, created: `2026-09-2${index}`, id: index === 0 ? OLD_ID : `sha256:${String(index).repeat(64)}` }));
  const f = fixture(t, { images, current: { 'pi-reach-pwa': OLD_ID, 'pi-reach-staging-pwa': OLD_ID } }), r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.images.map(image => image.ref).sort(), ['v0.0.0', 'v0.0.2', 'v0.0.3', 'v0.0.4'].map(tag => `${REPO}:${tag}`));
  assert.match(r.stderr, /Removed 1 old image/);
});

test('missing or unparsable Compose cannot pull images and releases locks', t => {
  const f = fixture(t); rmSync(join(f.remote, 'docker-compose.yml')); assert.deepEqual(run(f).calls, []);
  const broken = fixture(t), r = run(broken, REQUEST, { FAKE_CONFIG_FAIL: '1' });
  assert.notEqual(r.status, 0); assert.deepEqual(writes(r), []); assert.equal(existsSync(lock(broken.remote)), false);
});
