import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'deploy-from-ci.sh');
const PREFIX = 'ghcr.io/example';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const PWA_REPO = `${PREFIX}/pi-reach-pwa`;
const RELAY_REPO = `${PREFIX}/pi-reach-relay`;
const PWA_TARGET = `${PWA_REPO}:v0.0.4`;
const PWA_REQUEST = `deploy pwa ${PWA_TARGET}@${DIGEST}`;
const PREVIOUS_PWA = `${PWA_REPO}:v0.0.3`;

// docker 与 docker-compose 的替身：记录调用，并在状态文件里维护容器当前镜像、健康镜像与本地镜像列表。
const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  name, args, cwd: process.cwd(), relayImage: process.env.RELAY_IMAGE, pwaImage: process.env.PWA_IMAGE,
}) + '\n');

if (name === 'docker-compose') {
  if (args[0] === 'config' && process.env.FAKE_COMPOSE_CONFIG_FAIL) process.exit(1);
  if (args[0] === 'up') {
    const service = args[args.length - 1];
    state.current['pi-reach-' + service] = service === 'relay' ? process.env.RELAY_IMAGE : process.env.PWA_IMAGE;
    save();
  }
  process.exit(0);
}

if (args[0] === 'inspect' && args[2] === '{{.Config.Image}}') {
  const image = state.current[args[3]];
  if (!image) process.exit(1);
  process.stdout.write(image + '\n');
  process.exit(0);
}
if (args[0] === 'inspect' && args[2].includes('.State.Health')) {
  process.stdout.write((state.healthy.includes(state.current[args[3]]) ? 'healthy' : 'unhealthy') + '\n');
  process.exit(0);
}
if (args[0] === 'tag') {
  state.images.push({ ref: args[2], created: '2026-10-01 12:00:00', id: 'sha256:new' });
  save();
  process.exit(0);
}
if (args[0] === 'images' && !args.includes('--quiet')) {
  const repo = args[args.length - 1];
  for (const image of state.images) {
    const separator = image.ref.lastIndexOf(':');
    if (image.ref.slice(0, separator) === repo) process.stdout.write(image.created + '|' + image.ref.slice(separator + 1) + '|' + image.id + '\n');
  }
  process.exit(0);
}
if (args[0] === 'rmi') {
  state.images = state.images.filter((image) => image.ref !== args[1]);
  save();
}
process.exit(0);
`;

function setup({ current = { 'pi-reach-pwa': PREVIOUS_PWA }, healthy = [PWA_TARGET, PREVIOUS_PWA], images = [] } = {}) {
  // macOS 的临时目录经过符号链接，取真实路径以便与子进程的工作目录比较。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-reach-deploy-from-ci-')));
  const bin = join(root, 'bin');
  const remoteDir = join(root, 'remote');
  mkdirSync(bin);
  mkdirSync(remoteDir);
  for (const name of ['docker', 'docker-compose']) {
    writeFileSync(join(bin, name), FAKE_CLI);
    chmodSync(join(bin, name), 0o755);
  }
  copyFileSync(join(REPO_ROOT, 'docker-compose.yml'), join(remoteDir, 'docker-compose.yml'));
  const stateFile = join(root, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ current, healthy, images }));
  const logFile = join(root, 'calls.log');
  writeFileSync(logFile, '');
  return { root, remoteDir, stateFile, logFile, bin };
}

function run(context, request, env = {}) {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${context.bin}:${process.env.PATH}`,
      FAKE_STATE: context.stateFile,
      FAKE_LOG: context.logFile,
      PI_REACH_REMOTE_DIR: context.remoteDir,
      PI_REACH_IMAGE_PREFIX: PREFIX,
      PI_REACH_HEALTH_ATTEMPTS: '2',
      PI_REACH_HEALTH_INTERVAL: '0',
      SSH_ORIGINAL_COMMAND: request,
      ...env,
    },
  });
  const calls = readFileSync(context.logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, calls, state: JSON.parse(readFileSync(context.stateFile, 'utf8')) };
}

const lockDir = (context) => join(context.remoteDir, '.pi-reach-deploy-lock');
const composeUps = (calls) => calls.filter((call) => call.name === 'docker-compose' && call.args[0] === 'up');

test('rejects any request other than one versioned image by digest, before touching Docker or the lock', () => {
  const requests = [
    '',
    'deploy',
    `deploy pwa`,
    `${PWA_REQUEST} extra`,
    `run pwa ${PWA_TARGET}@${DIGEST}`,
    `deploy web ${PWA_TARGET}@${DIGEST}`,
    `deploy site ${PWA_TARGET}@${DIGEST}`,
    `deploy site ${PREFIX}/pi-reach-site:v0.0.4@${DIGEST}`,
    `deploy relay ${PWA_TARGET}@${DIGEST}`,
    `deploy pwa ghcr.io/other/pi-reach-pwa:v0.0.4@${DIGEST}`,
    `deploy pwa ${PWA_REPO}:latest@${DIGEST}`,
    `deploy pwa ${PWA_TARGET}`,
    `deploy pwa ${PWA_TARGET}@sha256:${'A'.repeat(64)}`,
    `deploy pwa ${PWA_TARGET}@${DIGEST};reboot`,
    `deploy pwa ${PWA_TARGET}@${DIGEST}@${DIGEST}`,
    `deploy pwa $(reboot)`,
  ];
  for (const request of requests) {
    const context = setup();
    try {
      const result = run(context, request);
      assert.notEqual(result.status, 0, request);
      assert.match(result.stderr, /Rejected request/, request);
      assert.deepEqual(result.calls, [], request);
      assert.equal(existsSync(lockDir(context)), false, request);
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  }
});

test('pulls the PWA image by digest and updates only the PWA service', () => {
  const context = setup();
  try {
    const result = run(context, PWA_REQUEST);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✓ Deployed pwa ghcr\.io\/example\/pi-reach-pwa:v0\.0\.4/);
    const docker = result.calls.filter((call) => call.name === 'docker').map((call) => call.args.join(' '));
    assert.ok(docker.includes(`pull --quiet ${PWA_REPO}@${DIGEST}`));
    assert.ok(docker.includes(`tag ${PWA_REPO}@${DIGEST} ${PWA_TARGET}`));
    const [up] = composeUps(result.calls);
    assert.deepEqual(up.args, ['up', '-d', '--pull', 'never', '--remove-orphans', 'pwa']);
    assert.equal(up.pwaImage, PWA_TARGET);
    assert.equal(up.relayImage, 'invalid.invalid/pi-reach-relay-unselected:never');
    assert.equal(up.cwd, context.remoteDir);
    assert.equal(result.state.current['pi-reach-pwa'], PWA_TARGET);
    assert.equal(existsSync(lockDir(context)), false);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('deploys the relay through RELAY_IMAGE', () => {
  const target = `${RELAY_REPO}:v0.0.3`;
  const context = setup({ current: { 'pi-reach-relay': `${RELAY_REPO}:v0.0.2` }, healthy: [target] });
  try {
    const result = run(context, `deploy relay ${target}@${DIGEST}`);
    assert.equal(result.status, 0, result.stderr);
    const [up] = composeUps(result.calls);
    assert.deepEqual(up.args.slice(-1), ['relay']);
    assert.equal(up.relayImage, target);
    assert.equal(up.pwaImage, 'invalid.invalid/pi-reach-pwa-unselected:never');
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('restores the previous image and fails when the new image never becomes healthy', () => {
  const context = setup({ healthy: [PREVIOUS_PWA] });
  try {
    const result = run(context, PWA_REQUEST);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restored to ghcr\.io\/example\/pi-reach-pwa:v0\.0\.3/);
    assert.deepEqual(composeUps(result.calls).map((call) => call.pwaImage), [PWA_TARGET, PREVIOUS_PWA]);
    assert.equal(result.state.current['pi-reach-pwa'], PREVIOUS_PWA);
    assert.equal(existsSync(lockDir(context)), false);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('reports a failed restore distinctly so the server gets checked', () => {
  const context = setup({ healthy: [] });
  try {
    const result = run(context, PWA_REQUEST);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restoring .* did not become healthy/);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('refuses to run while another deployment holds the shared lock', () => {
  const context = setup();
  try {
    mkdirSync(lockDir(context));
    const result = run(context, PWA_REQUEST);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Concurrent deployment rejected/);
    assert.deepEqual(result.calls, []);
    assert.equal(existsSync(lockDir(context)), true);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('stops before pulling when the server has no Compose file', () => {
  const context = setup();
  try {
    rmSync(join(context.remoteDir, 'docker-compose.yml'));
    const result = run(context, PWA_REQUEST);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run a local deployment once/);
    assert.deepEqual(result.calls, []);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('keeps the deployed tag plus the newest older tags of the same repository', () => {
  const images = ['v0.0.1', 'v0.0.2', 'v0.0.3'].map((tag, index) => ({ ref: `${PWA_REPO}:${tag}`, created: `2026-09-2${index} 12:00:00`, id: `sha256:${tag}` }));
  const context = setup({ images });
  try {
    const result = run(context, PWA_REQUEST);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Removed 1 old image/);
    assert.deepEqual(result.state.images.map((image) => image.ref).sort(), [`${PWA_REPO}:v0.0.2`, PREVIOUS_PWA, PWA_TARGET]);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});
