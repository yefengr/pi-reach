import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runLauncher } from './pi-dev/launcher.mjs';
import { parseOptions, PARENT_PID_ENV, readRequest, REQUEST_FILE, resumeOptions, STATE_DIR_ENV, validateRequest } from './pi-dev/protocol.mjs';
import { registerRestart } from './pi-dev/restart-extension.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_BASE = join(REPO_ROOT, '.pi/tmp');
const EXTENSION = pathToFileURL(join(REPO_ROOT, 'scripts/pi-dev/restart-extension.mjs')).href;

function fixture(t) {
  mkdirSync(TEMP_BASE, { recursive: true });
  const root = mkdtempSync(join(TEMP_BASE, 'pi-dev-test-'));
  const cwd = join(root, '项目 with spaces');
  const stateDir = join(root, 'control');
  mkdirSync(cwd);
  mkdirSync(stateDir, { mode: 0o700 });
  const sessionFile = join(cwd, '会话 with spaces.jsonl');
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"test-only"}\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd, stateDir, sessionFile };
}

function requestFor(f, pid = 1234) {
  return { version: 1, pid, cwd: f.cwd, sessionFile: f.sessionFile,
    provider: 'test-provider', model: 'current-model', thinking: 'high' };
}

function extensionHarness(t, overrides = {}) {
  const f = fixture(t);
  const handlers = new Map();
  const notices = [];
  let shutdowns = 0;
  let command;
  let tool;
  const dispatched = [];
  const messages = [];
  let thinking = 'high';
  const runtime = { pid: 1234, ppid: 5678, getuid: () => process.getuid(), cwd: () => f.cwd,
    env: { [PARENT_PID_ENV]: '5678', [STATE_DIR_ENV]: f.stateDir } };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => {
      assert.equal(name, 'dev-restart');
      command = definition.handler;
    },
    getThinkingLevel: () => thinking,
    registerTool: (definition) => { tool = definition; },
    sendUserMessage: (text, options) => {
      messages.push({ text, options });
      assert.equal(options.expandPromptTemplates, true, 'must dispatch a command rather than prompt the model');
      dispatched.push(command('', ctx));
    },
  };
  const ctx = {
    mode: 'tui', cwd: f.cwd, model: { provider: 'test-provider', id: 'current-model' },
    ui: { notify: (message, level) => notices.push({ message, level }) },
    sessionManager: { getSessionFile: () => f.sessionFile },
    waitForIdle: async () => {}, isIdle: () => true, hasPendingMessages: () => false,
    shutdown: () => { shutdowns++; }, ...overrides,
  };
  registerRestart(pi, runtime);
  return { ...f, runtime, ctx, notices, handlers, tool, dispatched, messages,
    invoke: (args = '') => command(args, ctx),
    invokeTool: (signal) => {
      const { waitForIdle: _waitForIdle, ...toolCtx } = ctx;
      return tool.execute('restart-call', {}, signal, undefined, toolCtx);
    },
    setThinking: (value) => { thinking = value; }, shutdowns: () => shutdowns };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

function fakePiFile(f) {
  const path = join(f.root, 'fake-pi.mjs');
  writeFileSync(path, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerRestart } from ${JSON.stringify(EXTENSION)};
const env = process.env;
const calls = readFileSync(env.TEST_CALLS, 'utf8').trim().split('\\n').filter(Boolean).length;
appendFileSync(env.TEST_CALLS, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), directory: env.PI_REACH_DEV_STATE_DIR }) + '\\n');
if (calls > 0) process.exit(0);
const mode = env.TEST_MODE;
if (mode === 'quit') process.exit(0);
if (mode === 'crash') process.exit(7);
let command;
let requested = false;
registerRestart({ on() {}, registerTool() {}, registerCommand(_name, def) { command = def.handler; }, getThinkingLevel() { return 'xhigh'; } });
const context = {
  mode: 'tui', cwd: process.cwd(), model: { provider: 'live-provider', id: 'live-model' },
  ui: { notify() {} }, sessionManager: { getSessionFile() { return env.TEST_SESSION; } },
  async waitForIdle() {}, isIdle() { return true; }, hasPendingMessages() { return false; },
  shutdown() { requested = true; },
};
await command('', context);
if (!requested) process.exit(42);
const requestPath = join(env.PI_REACH_DEV_STATE_DIR, 'restart.json');
if (mode === 'corrupt') writeFileSync(requestPath, '{broken');
if (mode === 'wrong-pid') {
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  request.pid++;
  writeFileSync(requestPath, JSON.stringify(request));
}
if (mode === 'request-then-crash') process.exit(9);
if (mode === 'request-then-signal') process.kill(process.pid, 'SIGTERM');
else if (mode === 'hold') {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));
  process.on('message', () => {});
  process.send('ready');
} else process.exit(0);
`);
  return path;
}

function launcherHarness(t, mode = 'restart') {
  const f = fixture(t);
  const callsFile = join(f.root, 'calls.jsonl');
  const tempBase = join(f.root, 'launcher-temp');
  const fake = fakePiFile(f);
  writeFileSync(callsFile, '');
  const errors = [];
  const messages = [];
  const children = [];
  const signals = new EventEmitter();
  const options = {
    cwd: f.cwd, isTTY: true, tempBase, signals,
    env: { ...process.env, TEST_MODE: mode, TEST_CALLS: callsFile, TEST_SESSION: f.sessionFile },
    reportError: (message) => errors.push(message), log: (message) => messages.push(message),
    spawnPi: (args, spawnOptions) => {
      if (children.length >= 3) throw new Error('unexpected restart loop');
      const child = spawn(process.execPath, [fake, ...args], {
        ...spawnOptions, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child.stderr.on('data', (data) => errors.push(data.toString()));
      children.push(child);
      return child;
    },
  };
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const assertClean = () => {
    if (existsSync(tempBase)) assert.deepEqual(readdirSync(tempBase), []);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0);
  };
  return { ...f, options, errors, messages, calls, assertClean, children, signals };
}

test('supported startup options are retained without replaying selectors, names or old model', () => {
  const args = ['--session', '/old file.jsonl', '--name', 'old name', '--model', 'old-model', '--provider', 'old',
    '--thinking', 'low', '--session-dir', '/session dir', '-e', '/extension path', '-ne', '--offline'];
  const parsed = parseOptions(args);
  assert.deepEqual(parsed.initial, args);
  assert.deepEqual(parsed.retained, ['--session-dir', '/session dir', '-e', '/extension path', '-ne', '--offline']);
  assert.deepEqual(resumeOptions(parsed.retained, { sessionFile: '/exact session', provider: 'p', model: 'm', thinking: 'max' }),
    [...parsed.retained, '--session', '/exact session', '--provider', 'p', '--model', 'm', '--thinking', 'max']);
  for (const selector of ['--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r']) {
    const values = ['--session', '--session-id', '--fork'].includes(selector) ? ['value'] : [];
    assert.deepEqual(parseOptions([selector, ...values]).retained, []);
  }
});

test('unsafe or ambiguous CLI arguments fail before launching', () => {
  for (const args of [['--print'], ['--mode', 'rpc'], ['--no-session'], ['prompt text'], ['@file'],
    ['--model'], ['--model', '--offline'], ['--session=x'], ['--resume', '-c'], ['--fork', 'id', '--session-id', 'id']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('request validation rejects stale, malformed, unknown, missing and cross-directory state', (t) => {
  const f = fixture(t);
  const identity = { pid: 1234, cwd: f.cwd };
  const valid = requestFor(f);
  assert.equal(validateRequest(valid, identity), valid);
  for (const request of [null, [], {}, { ...valid, extra: true }, { ...valid, version: 2 },
    { ...valid, pid: 1 }, { ...valid, cwd: f.root }, { ...valid, sessionFile: 'relative' },
    { ...valid, sessionFile: f.root }, { ...valid, sessionFile: join(f.cwd, 'absent') },
    { ...valid, model: '-p' }, { ...valid, provider: '' }, { ...valid, thinking: 'unknown' }]) {
    assert.throws(() => validateRequest(request, identity));
  }
  assert.equal(readRequest(f.stateDir, identity), undefined);
  writeFileSync(join(f.stateDir, REQUEST_FILE), '{bad');
  assert.throws(() => readRequest(f.stateDir, identity));
  writeFileSync(join(f.stateDir, REQUEST_FILE), ' '.repeat(65537));
  assert.throws(() => readRequest(f.stateDir, identity), /文件无效/);
  rmSync(join(f.stateDir, REQUEST_FILE));
  symlinkSync(f.sessionFile, join(f.stateDir, REQUEST_FILE));
  assert.throws(() => readRequest(f.stateDir, identity), /文件无效/);
});

test('command waits for idle, captures latest model and writes private state before shutdown', async (t) => {
  const idle = deferred();
  const h = extensionHarness(t, { waitForIdle: () => idle.promise });
  const running = h.invoke();
  assert.equal(h.shutdowns(), 0);
  assert.equal(existsSync(join(h.stateDir, REQUEST_FILE)), false);
  await h.invoke();
  assert.match(h.notices.at(-1).message, /勿重复/);
  h.ctx.model = { provider: 'changed-provider', id: 'changed-model' };
  h.setThinking('max');
  idle.resolve();
  await running;
  assert.equal(h.shutdowns(), 1);
  assert.deepEqual(readRequest(h.stateDir, { pid: h.runtime.pid, cwd: h.cwd }), {
    ...requestFor(h), provider: 'changed-provider', model: 'changed-model', thinking: 'max',
  });
  assert.equal(statSync(join(h.stateDir, REQUEST_FILE)).mode & 0o777, 0o600);
  assert.equal(existsSync(join(h.stateDir, 'restart.tmp')), false);
  await h.invoke();
  assert.equal(h.shutdowns(), 1);
  assert.match(h.notices.at(-1).message, /勿重复/);
});

for (const reason of ['reload', 'resume', 'new', 'quit', 'fork']) {
  test(`session ${reason} cancels an idle wait without using stale context`, async (t) => {
    const idle = deferred();
    const h = extensionHarness(t, { waitForIdle: () => idle.promise });
    const running = h.invoke();
    h.handlers.get('session_shutdown')({ reason });
    Object.defineProperty(h.ctx, 'ui', { get() { throw new Error('stale context'); } });
    idle.resolve();
    await running;
    assert.equal(h.shutdowns(), 0);
    assert.equal(existsSync(join(h.stateDir, REQUEST_FILE)), false);
  });
}

for (const [name, alter] of [
  ['RPC mode', (h) => { h.ctx.mode = 'rpc'; }],
  ['nested process', (h) => { h.runtime.ppid++; }],
  ['unmanaged process', (h) => { delete h.runtime.env[STATE_DIR_ENV]; }],
  ['public control directory', (h) => { chmodSync(h.stateDir, 0o755); }],
  ['ephemeral session', (h) => { h.ctx.sessionManager.getSessionFile = () => undefined; }],
  ['missing persisted session', (h) => { rmSync(h.sessionFile); }],
  ['queued messages', (h) => { h.ctx.hasPendingMessages = () => true; }],
  ['new active run', (h) => { h.ctx.isIdle = () => false; }],
  ['missing model', (h) => { h.ctx.model = undefined; }],
  ['changed cwd', (h) => { h.ctx.cwd = h.root; }],
  ['shutdown failure', (h) => { h.ctx.shutdown = () => { throw new Error('shutdown rejected'); }; }],
  ['write failure', (h) => { mkdirSync(join(h.stateDir, 'restart.tmp')); }],
]) {
  test(`command refuses ${name} without shutting down`, async (t) => {
    const h = extensionHarness(t);
    alter(h);
    await h.invoke();
    assert.equal(h.shutdowns(), 0);
    assert.equal(existsSync(join(h.stateDir, REQUEST_FILE)), false);
    assert.equal(h.notices.at(-1).level, 'error');
  });
}

test('session file changing while waiting cancels restart', async (t) => {
  const idle = deferred();
  const h = extensionHarness(t, { waitForIdle: () => idle.promise });
  const running = h.invoke();
  h.ctx.sessionManager.getSessionFile = () => '/another-session';
  idle.resolve();
  await running;
  assert.equal(h.shutdowns(), 0);
  assert.match(h.notices.at(-1).message, /已切换/);
});

test('command rejects arguments and permits a new request after a failed idle wait', async (t) => {
  const h = extensionHarness(t);
  await h.invoke('extra');
  assert.equal(h.notices.at(-1).level, 'warning');
  h.ctx.waitForIdle = async () => { throw new Error('wait failed'); };
  await h.invoke();
  assert.equal(h.shutdowns(), 0);
  h.ctx.waitForIdle = async () => {};
  await h.invoke();
  assert.equal(h.shutdowns(), 1);
});

test('real fake-Pi processes restart once with exact session and current settings, then quit', { timeout: 15000 }, async (t) => {
  const h = launcherHarness(t);
  const code = await runLauncher(['--resume', '--model', 'original-model', '--name', 'original name', '--offline', '-e', '/extra extension'], h.options);
  assert.equal(code, 0, h.errors.join('\n'));
  const calls = h.calls();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].pid, calls[1].pid);
  assert.equal(calls[1].cwd, h.cwd);
  assert.equal(calls[0].args[0], '--resume');
  assert.deepEqual(calls[1].args.slice(0, -2), ['--offline', '-e', '/extra extension',
    '--session', h.sessionFile, '--provider', 'live-provider', '--model', 'live-model', '--thinking', 'xhigh']);
  assert.match(calls[1].args.at(-1), /restart-extension\.mjs$/);
  assert.notEqual(calls[0].directory, calls[1].directory);
  assert.equal(h.messages.length, 1);
  h.assertClean();
});

for (const [mode, expected] of [['quit', 0], ['crash', 7], ['request-then-crash', 9], ['request-then-signal', 143], ['corrupt', 1], ['wrong-pid', 1]]) {
  test(`launcher does not restart on ${mode}`, { timeout: 15000 }, async (t) => {
    const h = launcherHarness(t, mode);
    assert.equal(await runLauncher([], h.options), expected);
    assert.equal(h.calls().length, 1);
    assert.equal(h.messages.length, 0);
    h.assertClean();
  });
}

for (const signal of ['SIGTERM', 'SIGHUP']) {
  test(`launcher forwards ${signal} only to its child and never resumes even with a request`, { timeout: 15000 }, async (t) => {
    const h = launcherHarness(t, 'hold');
    const spawnPi = h.options.spawnPi;
    h.options.spawnPi = (...args) => {
      const child = spawnPi(...args);
      child.once('message', () => {
        h.signals.emit('SIGINT');
        assert.equal(h.signals.listenerCount('SIGINT'), 1);
        h.signals.emit(signal);
      });
      return child;
    };
    assert.equal(await runLauncher([], h.options), signal === 'SIGTERM' ? 143 : 129);
    assert.equal(h.calls().length, 1);
    h.assertClean();
  });
}

test('launcher rejects non-TTY, unsupported platform and invalid args before spawn; help is noninteractive', async (t) => {
  const h = launcherHarness(t);
  for (const options of [{ isTTY: false }, { platform: 'win32' }]) {
    assert.equal(await runLauncher([], { ...h.options, ...options }), 1);
  }
  assert.equal(await runLauncher(['prompt'], h.options), 1);
  assert.equal(h.calls().length, 0);
  assert.equal(await runLauncher(['--help'], { ...h.options, isTTY: false }), 0);
  assert.match(h.messages.at(-1), /dev-restart/);
  h.assertClean();
});

test('missing Pi executable stops and cleans up rather than looping', async (t) => {
  const h = launcherHarness(t);
  h.options.spawnPi = (_args, options) => spawn(join(h.root, 'missing-pi'), [], options);
  assert.equal(await runLauncher([], h.options), 1);
  assert.match(h.errors.join('\n'), /ENOENT/);
  h.assertClean();
});

test('Agent tool returns before idle, dispatches native command once, then resumes safely', async (t) => {
  const idle = deferred();
  const h = extensionHarness(t, { waitForIdle: () => idle.promise, isIdle: () => false });
  assert.equal(h.tool.name, 'dev_restart');
  assert.deepEqual(h.tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  const result = await h.invokeTool();
  assert.equal(result.details.status, 'requested');
  assert.equal(h.shutdowns(), 0);
  assert.equal(existsSync(join(h.stateDir, REQUEST_FILE)), false);
  assert.deepEqual(h.messages, [{ text: '/dev-restart', options: { deliverAs: 'followUp', expandPromptTemplates: true } }]);
  assert.equal((await h.invokeTool()).details.status, 'already_requested');
  assert.equal(h.messages.length, 1);
  h.ctx.model = { provider: 'latest-provider', id: 'latest-model' };
  h.ctx.isIdle = () => true;
  idle.resolve();
  await Promise.all(h.dispatched);
  assert.equal(h.shutdowns(), 1);
  assert.equal(readRequest(h.stateDir, { pid: h.runtime.pid, cwd: h.cwd }).model, 'latest-model');
});

for (const [name, alter] of [
  ['unmanaged process', (h) => { delete h.runtime.env[STATE_DIR_ENV]; }],
  ['nested process', (h) => { h.runtime.ppid++; }],
  ['non-TUI mode', (h) => { h.ctx.mode = 'rpc'; }],
  ['ephemeral session', (h) => { h.ctx.sessionManager.getSessionFile = () => undefined; }],
  ['missing session file', (h) => { rmSync(h.sessionFile); }],
  ['missing model', (h) => { h.ctx.model = undefined; }],
  ['queued messages', (h) => { h.ctx.hasPendingMessages = () => true; }],
]) {
  test(`Agent tool rejects ${name} without scheduling a command`, async (t) => {
    const h = extensionHarness(t);
    alter(h);
    await assert.rejects(h.invokeTool());
    assert.equal(h.messages.length, 0);
    assert.equal(h.shutdowns(), 0);
  });
}

test('cancelled Agent tool does not schedule a restart', async (t) => {
  const h = extensionHarness(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(h.invokeTool(abort.signal), /已取消/);
  assert.equal(h.messages.length, 0);
});

test('Agent tool request is cancelled if runtime reloads while the run finishes', async (t) => {
  const idle = deferred();
  const h = extensionHarness(t, { waitForIdle: () => idle.promise });
  await h.invokeTool();
  h.handlers.get('session_shutdown')({ reason: 'reload' });
  idle.resolve();
  await Promise.all(h.dispatched);
  assert.equal(h.shutdowns(), 0);
  assert.equal(existsSync(join(h.stateDir, REQUEST_FILE)), false);
});

test('shell entrypoint resolves itself outside repo without changing the working directory', (t) => {
  const f = fixture(t);
  const result = spawnSync('bash', [join(REPO_ROOT, 'scripts/pi-dev.sh'), '--help'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dev-restart/);
  const nonTTY = spawnSync('bash', [join(REPO_ROOT, 'scripts/pi-dev.sh')], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(nonTTY.status, 1);
  assert.match(nonTTY.stderr, /交互式终端/);
});
