import assert from 'node:assert/strict';
import test from 'node:test';
import { smoke, runtimeRelay, publicUrl, websocketChallenge } from './deploy-smoke.mjs';

const pwaUrl = 'https://test-pwa.example/app';
const relayUrl = 'https://test-relay.example';
const html = `<html><head><meta name="pi-reach-default-relay-url" content="${relayUrl}"><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head></html>`;

function fixture(overrides = {}) {
  const calls = [];
  return { calls, fetcher: async (input) => {
    const url = new URL(input);
    calls.push(url.href);
    const pathname = url.pathname;
    let body = html;
    let status = 200;
    let headers = { 'content-type': 'text/html', 'cache-control': 'no-cache' };
    if (pathname === '/health') body = 'OK';
    else if (pathname === '/sw.js') { body = 'self.__SW_MANIFEST = []'; headers['content-type'] = 'application/javascript'; }
    else if (pathname === '/manifest.webmanifest') { body = JSON.stringify({ start_url: '/app', scope: '/app' }); headers['content-type'] = 'application/manifest+json'; }
    else if (pathname === '/assets/app.js' || pathname === '/assets/app.css') { body = 'asset'; headers['cache-control'] = 'public, max-age=31536000, immutable'; }
    else if (!['/app', '/app/settings'].includes(pathname)) { status = 404; body = 'not found'; }
    const override = overrides[pathname] ?? {};
    return new Response(override.body ?? body, { status: override.status ?? status, headers: override.headers ?? headers });
  } };
}

test('full smoke checks routes, actual runtime environment, resources, cache, 404 and WebSocket separately', async () => {
  const h = fixture();
  let connected;
  const result = await smoke({ pwaUrl, relayUrl, fetcher: h.fetcher, challenge: async (url) => { connected = url.href; } });
  assert.equal(connected, `${relayUrl}/`);
  assert.ok(result.checks.includes('WebSocket'));
  for (const path of ['/app', '/app/settings', '/sw.js', '/manifest.webmanifest', '/assets/app.js', '/assets/app.css', '/.env', '/assets/pi-reach-smoke-missing.js']) {
    assert.ok(h.calls.includes(`https://test-pwa.example${path}`));
  }
  assert.ok(h.calls.includes(`${relayUrl}/health`));
});

for (const [name, overrides] of [
  ['production Relay metadata', { '/app': { body: html.replace(relayUrl, 'https://production-relay.example') } }],
  ['route metadata drift', { '/app/settings': { body: html.replace(relayUrl, 'https://other-relay.example') } }],
  ['missing worker', { '/sw.js': { status: 404 } }],
  ['worker cached immutably', { '/sw.js': { headers: { 'content-type': 'application/javascript', 'cache-control': 'max-age=31536000, immutable' } } }],
  ['worker fallback HTML', { '/sw.js': { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } } }],
  ['missing resources fallback to entry', { '/assets/pi-reach-smoke-missing.js': { status: 200 } }],
  ['wrong manifest scope', { '/manifest.webmanifest': { body: '{"scope":"/","start_url":"/"}' } }],
  ['wrong Relay response', { '/health': { body: 'upstream HTML' } }],
  ['redirect to another domain', { '/app': { status: 302 } }],
]) {
  test(`smoke rejects ${name}`, async () => {
    const h = fixture(overrides);
    await assert.rejects(() => smoke({ pwaUrl, relayUrl, fetcher: h.fetcher, challenge: async () => {} }));
  });
}

test('health success alone cannot satisfy the WebSocket check', async () => {
  await assert.rejects(() => smoke({ pwaUrl, relayUrl, fetcher: fixture().fetcher, challenge: async () => { throw new Error('WS unavailable'); } }), /WS unavailable/);
});

test('public endpoint and HTML metadata validation fail closed', () => {
  for (const input of ['', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/#x', 'https://example.com/?secret=x']) assert.throws(() => publicUrl(input, 'URL'));
  assert.throws(() => runtimeRelay('<html></html>'));
  assert.throws(() => runtimeRelay(html + html));
  assert.equal(runtimeRelay(html), relayUrl);
});

function fakeSocket(frame, closed) {
  return class {
    constructor(url) {
      assert.equal(url.protocol, 'wss:');
      queueMicrotask(() => { if (closed) this.onclose(); else this.onmessage({ data: JSON.stringify(frame) }); });
    }
    close() {}
  };
}

test('WebSocket smoke validates a real-shaped challenge and never authenticates', async () => {
  await websocketChallenge(relayUrl, fakeSocket({ type: 'challenge', nonce: Buffer.alloc(32).toString('base64') }));
  for (const frame of [{ type: 'relay_info' }, { type: 'challenge', nonce: 'wrong' }]) {
    await assert.rejects(() => websocketChallenge(relayUrl, fakeSocket(frame)), /valid challenge/);
  }
  await assert.rejects(() => websocketChallenge(relayUrl, fakeSocket({}, true)), /closed/);
});
