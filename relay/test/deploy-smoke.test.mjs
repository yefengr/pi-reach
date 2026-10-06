import assert from 'node:assert/strict';
import test from 'node:test';

import { websocketChallenge } from '../../scripts/deploy-smoke.mjs';
import { startRelay } from '../dist/server.js';

const TEST_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

// 只替换隔离测试的传输协议；握手及所有服务端帧均来自真实 Relay。
test('deployment smoke sends only hello to a real local Relay and closes after its challenge', { timeout: TEST_TIMEOUT_MS }, async () => {
  const events = [];
  const relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    limits: { helloTimeoutMs: HANDSHAKE_TIMEOUT_MS, authTimeoutMs: HANDSHAKE_TIMEOUT_MS },
    logger: (event) => events.push(event),
  });
  const sockets = [];
  const closed = [];
  const sentTypes = [];
  class LocalWebSocket extends WebSocket {
    constructor(input) {
      const url = new URL(input);
      assert.equal(url.protocol, 'wss:');
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(url.port, String(relay.port));
      url.protocol = 'ws:';
      super(url);
      sockets.push(this);
      closed.push(new Promise((resolve) => this.addEventListener('close', resolve, { once: true })));
    }

    send(data) {
      sentTypes.push(JSON.parse(data).type);
      super.send(data);
    }
  }

  try {
    await websocketChallenge(`https://127.0.0.1:${relay.port}`, LocalWebSocket);
    assert.deepEqual(sentTypes, ['hello']);
    assert.equal(sockets.length, 1);
    assert.ok([WebSocket.CLOSING, WebSocket.CLOSED].includes(sockets[0].readyState), 'smoke must close after the challenge');
    await Promise.all(closed);
    assert.ok(!events.some((event) => event.event === 'authenticated'), 'smoke must not authenticate');
    assert.ok(!events.some((event) => event.event === 'connection_rejected'), 'Relay must accept the hello');
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
    await Promise.all(closed);
  }
});
