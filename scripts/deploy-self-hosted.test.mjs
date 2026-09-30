import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'deploy-self-hosted.sh');
const COMPOSE = join(REPO_ROOT, 'docker-compose.yml');
const SECRET_MARKER = 'deploy-env-secret-must-not-leak';
const REMOTE_PATH = '/srv/pi-reach';
const UP_COMMAND = 'docker-compose up -d --pull never ';
const PWA_URL = `https://pwa.example.invalid/app?token=${SECRET_MARKER}`;
const RELAY_HEALTH_URL = 'https://relay.example.invalid/health';
const RELAY_REPO = 'example.invalid/team/pi-reach-relay';
const SITE_REPO = 'example.invalid/team/pi-reach-site';

const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const logFile = process.env.FAKE_CLI_LOG;
const remoteDir = process.env.FAKE_REMOTE_DIR;
const lockDir = path.join(remoteDir, '.pi-reach-deploy-lock');
const composeFile = path.join(remoteDir, 'docker-compose.yml');
// Each host (local machine or server) has its own fake image store for pruning.
const host = process.env.FAKE_HOST || 'local';
const storeFile = path.join(process.env.FAKE_STATE_DIR, 'images-' + host + '.json');

function loadStore() {
  return fs.existsSync(storeFile)
    ? JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    : { images: [], containers: [] };
}

function saveStore(store) {
  fs.writeFileSync(storeFile, JSON.stringify(store));
}

function record(entry) {
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

function readStdin() {
  const input = fs.readFileSync(0);
  record({ name: name + ':stdin', stdin: input.toString('utf8') });
  return input;
}

record({ name, args });

function fail(message, code = 91) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

if (name === 'docker') {
  const operation = args.join(' ');
  if (process.env.FAKE_DOCKER_ERROR && operation.includes(process.env.FAKE_DOCKER_ERROR)) {
    fail('injected fake docker failure', 37);
  }
  if (args[0] === 'save') {
    process.stdout.write('fake-image-archive');
    process.exit(0);
  }
  if (args[0] === 'buildx' || (args[0] === 'image' && args[1] === 'inspect')) {
    process.exit(0);
  }
  const store = loadStore();
  if (args[0] === 'ps' && args[1] === '-aq') {
    for (const container of store.containers) process.stdout.write(container.id + '\n');
    process.exit(0);
  }
  if (args[0] === 'inspect' && args[1] === '--format') {
    for (const id of args.slice(3)) {
      const container = store.containers.find((candidate) => candidate.id === id);
      if (container) process.stdout.write(container.image + '\n');
    }
    process.exit(0);
  }
  if (args[0] === 'images' && args.includes('--quiet')) {
    const label = args.find((arg) => arg.startsWith('label=')).slice('label='.length);
    for (const image of store.images) {
      if (image.tags.length === 0 && label in (image.labels || {})) process.stdout.write(image.id + '\n');
    }
    process.exit(0);
  }
  if (args[0] === 'images') {
    const repo = args[args.length - 1];
    for (const image of store.images) {
      for (const ref of image.tags) {
        const separator = ref.lastIndexOf(':');
        if (ref.slice(0, separator) === repo) {
          process.stdout.write(image.created + '|' + ref.slice(separator + 1) + '|' + image.id + '\n');
        }
      }
    }
    process.exit(0);
  }
  if (args[0] === 'rmi') {
    const target = args[1];
    const tagged = store.images.find((image) => image.tags.includes(target));
    const untagged = store.images.find((image) => image.id === target && image.tags.length === 0);
    if (tagged) {
      tagged.tags = tagged.tags.filter((ref) => ref !== target);
      if (tagged.tags.length === 0) store.images = store.images.filter((image) => image !== tagged);
    } else if (untagged) {
      store.images = store.images.filter((image) => image !== untagged);
    } else {
      fail('fake rmi target cannot be removed: ' + target, 54);
    }
    saveStore(store);
    process.exit(0);
  }
  fail('unhandled fake docker invocation: ' + operation);
}

if (name === 'gzip') {
  process.stdout.write(readStdin());
  process.exit(0);
}

if (name === 'scp') {
  const source = args[args.length - 2];
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.copyFileSync(source, composeFile);
  process.exit(0);
}

if (name === 'curl') {
  if (process.env.FAKE_CURL_ERROR) fail('injected fake curl failure', 38);
  process.exit(0);
}

if (name !== 'ssh') {
  fail('unexpected fake command: ' + name);
}

const command = args[args.length - 1];
if (command === 'gzip -dc | docker load') {
  readStdin();
  process.exit(0);
}
if (command.includes('.pi-reach-deploy-lock') && command.startsWith('mkdir ')) {
  if (process.env.FAKE_DEPLOY_LOCKED || fs.existsSync(lockDir)) {
    fail('fake remote deployment lock already exists', 50);
  }
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.mkdirSync(lockDir);
  process.exit(0);
}
if (command.includes('.pi-reach-deploy-lock') && command.startsWith('rmdir ')) {
  if (!fs.existsSync(lockDir)) fail('fake remote deployment lock is missing', 51);
  fs.rmdirSync(lockDir);
  process.exit(0);
}
if (command === 'uname -m') {
  process.stdout.write('x86_64\n');
  process.exit(0);
}
if (command.includes('docker info') && command.includes('docker-compose version')) {
  process.exit(0);
}
if (command.startsWith('mkdir -p ')) {
  fs.mkdirSync(remoteDir, { recursive: true });
  process.exit(0);
}
if (command.includes('docker image inspect --format')) {
  const match = command.match(/docker image inspect --format '[^']+' '([^']+)'/);
  if (!match) fail('unable to parse image inspect command');
  process.stdout.write('sha256:' + crypto.createHash('sha256').update(match[1]).digest('hex') + '\n');
  process.exit(0);
}
if (command.includes('for attempt in $(seq 1 30)')) {
  if (process.env.FAKE_HEALTH_ERROR) fail('injected health failure', 49);
  process.exit(0);
}
if (command.includes('docker-compose config --quiet')) {
  if (process.env.FAKE_CONFIG_ERROR) fail('injected compose config parse failure', 47);
  if (!fs.existsSync(composeFile)) fail('remote compose file is missing', 48);
  process.exit(0);
}
if (command.includes('docker-compose up -d --pull never ')) {
  process.exit(0);
}
if (command.includes('docker-compose ps ')) {
  process.exit(0);
}
if (command.startsWith('bash -s -- ')) {
  // Run the pruning program the way the server would, against the server's fake image store.
  const program = readStdin();
  if (process.env.FAKE_REMOTE_PRUNE_ERROR) fail('injected remote prune failure', 53);
  const result = require('node:child_process').spawnSync(
    'bash',
    ['-s', '--', ...command.slice('bash -s -- '.length).split(' ')],
    { input: program, encoding: 'utf8', env: { ...process.env, FAKE_HOST: 'remote' } },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

fail('unhandled fake ssh command: ' + command);
`;

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-deploy-test-'));
  const scriptsDir = join(root, 'scripts');
  const fakeBin = join(root, 'fake-bin');
  const remoteDir = join(root, 'remote');
  const logFile = join(root, 'fake-cli.jsonl');
  const configFile = join(root, 'deploy.env');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(root, 'relay'), { recursive: true });
  mkdirSync(join(root, 'pwa'), { recursive: true });
  mkdirSync(remoteDir, { recursive: true });
  copyFileSync(SCRIPT, join(scriptsDir, 'deploy-self-hosted.sh'));
  copyFileSync(COMPOSE, join(root, 'docker-compose.yml'));
  chmodSync(join(scriptsDir, 'deploy-self-hosted.sh'), 0o755);
  writeFileSync(join(root, 'relay', 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(root, 'pwa', 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(logFile, '');
  writeFileSync(
    configFile,
    [
      'DEPLOY_SSH=fake-host',
      'DEPLOY_USER=fake-user',
      `REMOTE_DIR=${REMOTE_PATH}`,
      'IMAGE_NAMESPACE=example.invalid/team',
      'RELAY_VERSION=relay-v1',
      'SITE_VERSION=site-v1',
      'PUBLISH_IMAGES=0',
      'KEEP_IMAGE_ARCHIVE=0',
      `PWA_URL=${PWA_URL}`,
      'RELAY_URL=https://relay.example.invalid/',
      'SCOPE=relay',
      'BUILDER=config-builder',
      'DEPLOY_CONFIG=/must/not/replace/explicit/config',
      `UNUSED_SECRET=${SECRET_MARKER}`,
      '',
    ].join('\n'),
  );

  for (const command of ['docker', 'ssh', 'scp', 'gzip', 'curl']) {
    const target = join(fakeBin, command);
    writeFileSync(target, FAKE_CLI);
    chmodSync(target, 0o755);
  }

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    script: join(scriptsDir, 'deploy-self-hosted.sh'),
    fakeBin,
    remoteDir,
    lockDir: join(remoteDir, '.pi-reach-deploy-lock'),
    composeFile: join(remoteDir, 'docker-compose.yml'),
    logFile,
    configFile,
  };
}

function runDeploy(fixture, args = [], extraEnv = {}) {
  return spawnSync('/bin/bash', [fixture.script, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      DEPLOY_CONFIG: fixture.configFile,
      BUILDER: 'cli-builder',
      FAKE_CLI_LOG: fixture.logFile,
      FAKE_REMOTE_DIR: fixture.remoteDir,
      FAKE_STATE_DIR: fixture.root,
      ...extraEnv,
    },
  });
}

function records(fixture) {
  const text = readFileSync(fixture.logFile, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
}

function sshCommands(fixture) {
  return records(fixture)
    .filter((record) => record.name === 'ssh')
    .map((record) => record.args.at(-1));
}

function dockerCalls(fixture, ...prefix) {
  return records(fixture).filter(
    (record) =>
      record.name === 'docker' &&
      prefix.every((part, index) => record.args[index] === part),
  );
}

function curlTargets(fixture) {
  return records(fixture)
    .filter((record) => record.name === 'curl')
    .map((record) => record.args.at(-1));
}

function assertSuccessful(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function upServices(fixture) {
  const command = sshCommands(fixture).find((value) => value.includes(UP_COMMAND));
  assert.ok(command, 'expected a compose up command');
  return command.split(UP_COMMAND)[1];
}

// Deployed tags relay-v1/site-v1 are the newest; relay-0 and orphan-in-use belong to containers.
function imageStore() {
  const image = (id, day, tags, labels) => ({
    id: `sha256:${id}`,
    created: `2026-09-${day} 10:00:00 +0800 CST`,
    tags,
    ...(labels ? { labels } : {}),
  });
  return {
    images: [
      image('relay-new', '30', [`${RELAY_REPO}:relay-v1`], { 'pi-reach.image': 'relay' }),
      image('relay-3', '29', [`${RELAY_REPO}:v3`]),
      image('relay-2', '28', [`${RELAY_REPO}:v2`, `${RELAY_REPO}:v2-alias`]),
      image('relay-1', '27', [`${RELAY_REPO}:v1`]),
      image('relay-0', '26', [`${RELAY_REPO}:v0`]),
      image('site-new', '30', [`${SITE_REPO}:site-v1`], { 'pi-reach.image': 'site' }),
      image('site-old', '20', [`${SITE_REPO}:old`]),
      image('orphan', '25', [], { 'pi-reach.image': 'site' }),
      image('orphan-in-use', '24', [], { 'pi-reach.image': 'relay' }),
      image('unrelated-orphan', '23', []),
      image('couchdb', '01', ['couchdb:3.5.0']),
    ],
    containers: [
      { id: 'c-relay-0', image: 'sha256:relay-0' },
      { id: 'c-orphan', image: 'sha256:orphan-in-use' },
    ],
  };
}

function writeImageStore(fixture, host, store) {
  writeFileSync(join(fixture.root, `images-${host}.json`), JSON.stringify(store));
}

function readImageStore(fixture, host) {
  return JSON.parse(readFileSync(join(fixture.root, `images-${host}.json`), 'utf8'));
}

function pruneCommands(fixture) {
  return sshCommands(fixture).filter((command) => command.startsWith('bash -s'));
}

test('default command deploys both services and preserves CLI-owned settings', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture);
  assertSuccessful(result);

  assert.match(result.stdout, /Deployment scope=both/);
  assert.match(result.stdout, /Deployment completed for scope both/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET_MARKER));
  const builds = dockerCalls(fixture, 'buildx', 'build');
  assert.equal(builds.length, 2);
  assert.deepEqual(
    builds.map((record) => record.args[record.args.indexOf('--label') + 1]),
    ['pi-reach.image=relay', 'pi-reach.image=site'],
  );
  assert.deepEqual(dockerCalls(fixture, 'buildx', 'inspect')[0].args, [
    'buildx',
    'inspect',
    'cli-builder',
  ]);

  const save = dockerCalls(fixture, 'save')[0].args;
  assert.ok(save.includes('example.invalid/team/pi-reach-relay:relay-v1'));
  assert.ok(save.includes('example.invalid/team/pi-reach-site:site-v1'));
  assert.equal(upServices(fixture), 'relay site');
  const stdinRecords = records(fixture).filter((record) => record.name.endsWith(':stdin'));
  assert.ok(stdinRecords.some((record) => record.stdin === 'fake-image-archive'));
  assert.deepEqual(readdirSync(fixture.remoteDir), ['docker-compose.yml']);
  assert.deepEqual(curlTargets(fixture), [RELAY_HEALTH_URL, PWA_URL]);
});

test('remote deployment lock surrounds build, transfer, and compose up', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['relay']);
  assertSuccessful(result);

  const lockPath = `${REMOTE_PATH}/.pi-reach-deploy-lock`;
  const entries = records(fixture);
  const acquireCommand = `mkdir -p '${REMOTE_PATH}' && mkdir '${lockPath}'`;
  const acquireIndex = entries.findIndex(
    (record) => record.name === 'ssh' && record.args.at(-1) === acquireCommand,
  );
  const buildIndex = entries.findIndex(
    (record) => record.name === 'docker' && record.args[0] === 'buildx' && record.args[1] === 'build',
  );
  const transferIndex = entries.findIndex((record) => record.name === 'scp');
  const upIndex = entries.findIndex(
    (record) => record.name === 'ssh' && record.args.at(-1).includes(UP_COMMAND),
  );
  const releaseIndex = entries.findIndex(
    (record) => record.name === 'ssh' && record.args.at(-1) === `rmdir '${lockPath}'`,
  );

  assert.ok(acquireIndex >= 0, 'expected the remote lock to be acquired');
  assert.ok(acquireIndex < buildIndex, 'lock must be acquired before local build');
  assert.ok(acquireIndex < transferIndex, 'lock must be acquired before transfer');
  assert.ok(acquireIndex < upIndex, 'lock must be acquired before compose up');
  assert.ok(releaseIndex > upIndex, 'lock must be released after deployment work');
  assert.ok(!existsSync(fixture.lockDir));
});

test('existing remote deployment lock rejects work before build, transfer, or compose up', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['both'], {
    FAKE_DEPLOY_LOCKED: '1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Concurrent deployment rejected/);
  assert.match(result.stderr, /stale lock/);
  assert.equal(dockerCalls(fixture).length, 0);
  assert.equal(records(fixture).filter((record) => record.name === 'scp').length, 0);
  assert.equal(records(fixture).filter((record) => record.name === 'gzip').length, 0);

  const commands = sshCommands(fixture);
  assert.ok(commands.some((command) => command.includes('.pi-reach-deploy-lock')));
  assert.ok(!commands.includes('uname -m'));
  assert.ok(!commands.some((command) => command.includes(UP_COMMAND)));
  assert.ok(!commands.some((command) => command.startsWith('rmdir ')));
});

test('failed build releases its remote lock without updating services', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['relay'], {
    FAKE_DOCKER_ERROR: 'buildx build',
  });

  assert.equal(result.status, 37);
  assert.match(result.stderr, /injected fake docker failure/);
  assert.ok(!existsSync(fixture.lockDir));
  assert.equal(records(fixture).filter((record) => record.name === 'scp').length, 0);

  const commands = sshCommands(fixture);
  assert.ok(
    commands.some(
      (command) => command.startsWith('rmdir ') && command.includes('.pi-reach-deploy-lock'),
    ),
  );
  assert.ok(!commands.some((command) => command.includes(UP_COMMAND)));
});

test('pwa scope builds, transfers, and updates only the PWA', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['pwa']);
  assertSuccessful(result);

  const builds = dockerCalls(fixture, 'buildx', 'build');
  assert.equal(builds.length, 1);
  assert.ok(builds[0].args.includes('example.invalid/team/pi-reach-site:site-v1'));
  assert.equal(upServices(fixture), 'site');

  const commands = sshCommands(fixture);
  const configCommand = commands.find((command) => command.includes('docker-compose config --quiet'));
  assert.match(configCommand, /RELAY_IMAGE='invalid\.invalid\/pi-reach-relay-unselected:never'/);
  assert.ok(commands.some((command) => command.includes("'pi-reach-site'")));
  assert.doesNotMatch(records(fixture).map(JSON.stringify).join('\n'), /pi-reach-relay:relay-v1/);
  assert.deepEqual(curlTargets(fixture), [PWA_URL]);
});

test('relay scope builds, transfers, and updates only the Relay', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['relay']);
  assertSuccessful(result);

  const builds = dockerCalls(fixture, 'buildx', 'build');
  assert.equal(builds.length, 1);
  assert.ok(builds[0].args.includes('example.invalid/team/pi-reach-relay:relay-v1'));
  assert.equal(upServices(fixture), 'relay');

  const commands = sshCommands(fixture);
  const configCommand = commands.find((command) => command.includes('docker-compose config --quiet'));
  assert.match(configCommand, /SITE_IMAGE='invalid\.invalid\/pi-reach-site-unselected:never'/);
  assert.ok(commands.some((command) => command.includes("'pi-reach-relay'")));
  assert.doesNotMatch(records(fixture).map(JSON.stringify).join('\n'), /pi-reach-site:site-v1/);
  assert.deepEqual(curlTargets(fixture), [RELAY_HEALTH_URL]);
});

test('Compose parse failures stop before any service is updated', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['relay'], {
    FAKE_CONFIG_ERROR: '1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to parse the remote Compose configuration/);
  assert.ok(!sshCommands(fixture).some((command) => command.includes(UP_COMMAND)));
  assert.ok(!existsSync(fixture.lockDir));
});

test('unhealthy services fail the deployment before public checks', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['both'], {
    FAKE_HEALTH_ERROR: '1',
  });

  assert.equal(result.status, 49);
  assert.match(result.stderr, /injected health failure/);
  assert.doesNotMatch(result.stdout, /Deployment completed/);
  assert.deepEqual(curlTargets(fixture), []);
  assert.ok(!existsSync(fixture.lockDir));

  const healthCommand = sshCommands(fixture).find((command) =>
    command.includes('for attempt in $(seq 1 30)'),
  );
  assert.match(healthCommand, /export RELAY_IMAGE='[^']+' SITE_IMAGE='[^']+' && docker-compose logs --tail=80/);
  assert.deepEqual(pruneCommands(fixture), []);
});

test('successful deployment prunes older images locally and on the server', (t) => {
  const fixture = makeFixture(t);
  for (const host of ['local', 'remote']) writeImageStore(fixture, host, imageStore());

  const result = runDeploy(fixture);
  assertSuccessful(result);
  assert.match(result.stdout, /Server: removed 3 old image\(s\)/);
  assert.match(result.stdout, /Local: removed 3 old image\(s\)/);
  assert.deepEqual(pruneCommands(fixture), [
    `bash -s -- 3 ${RELAY_REPO}:relay-v1 ${SITE_REPO}:site-v1`,
  ]);

  for (const host of ['local', 'remote']) {
    const store = readImageStore(fixture, host);
    assert.deepEqual(
      store.images.flatMap((image) => image.tags).sort(),
      [
        'couchdb:3.5.0',
        `${RELAY_REPO}:relay-v1`,
        `${RELAY_REPO}:v0`,
        `${RELAY_REPO}:v2`,
        `${RELAY_REPO}:v3`,
        `${SITE_REPO}:old`,
        `${SITE_REPO}:site-v1`,
      ],
      host,
    );
    assert.deepEqual(
      store.images.map((image) => image.id.slice('sha256:'.length)).sort(),
      ['couchdb', 'orphan-in-use', 'relay-0', 'relay-2', 'relay-3', 'relay-new', 'site-new', 'site-old', 'unrelated-orphan'],
      host,
    );
  }
});

test('KEEP_IMAGE_VERSIONS=0 disables image pruning', (t) => {
  const fixture = makeFixture(t);
  for (const host of ['local', 'remote']) writeImageStore(fixture, host, imageStore());

  const result = runDeploy(fixture, ['both'], { KEEP_IMAGE_VERSIONS: '0' });
  assertSuccessful(result);
  assert.doesNotMatch(result.stdout, /Pruning/);
  assert.deepEqual(pruneCommands(fixture), []);
  for (const host of ['local', 'remote']) assert.deepEqual(readImageStore(fixture, host), imageStore());
});

test('image pruning failures are reported without failing a live deployment', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['relay'], {
    FAKE_REMOTE_PRUNE_ERROR: '1',
  });

  assertSuccessful(result);
  assert.match(result.stderr, /Server image pruning failed/);
  assert.match(result.stdout, /Local: removed 0 old image\(s\)/);
  assert.match(result.stdout, /Deployment completed for scope relay/);
});

test('invalid KEEP_IMAGE_VERSIONS is rejected before any remote work', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['both'], { KEEP_IMAGE_VERSIONS: 'three' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /KEEP_IMAGE_VERSIONS must be a non-negative integer/);
  assert.equal(records(fixture).length, 0);
});

test('public URL check failures fail the deployment and release the lock', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['pwa'], {
    FAKE_CURL_ERROR: '1',
  });

  assert.equal(result.status, 38);
  assert.doesNotMatch(result.stdout, /Deployment completed/);
  assert.ok(!existsSync(fixture.lockDir));
});

test('help prints usage without loading the deployment config', (t) => {
  const fixture = makeFixture(t);
  const result = runDeploy(fixture, ['--help'], { DEPLOY_CONFIG: join(fixture.root, 'missing.env') });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.equal(records(fixture).length, 0);
});

test('invalid or removed CLI values are rejected before any remote work', (t) => {
  const fixture = makeFixture(t);
  for (const args of [['invalid'], ['test'], ['promote', 'both'], ['both', 'extra']]) {
    const result = runDeploy(fixture, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage:/);
    assert.equal(records(fixture).length, 0);
  }
});
