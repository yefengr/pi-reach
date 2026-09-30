import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import WebSocket from "ws";

import {
  createIdentity,
  hostHello,
  isRecord,
  ownerHello,
  signNonce,
} from "./helpers.mjs";

const TEST_TIMEOUT_MS = 2_000;
const U64_MAX = "18446744073709551615";
const I64_MIN = "-9223372036854775808";
const UNSAFE_INTEGER = "9007199254740993";
const externalUrl = process.env.RELAY_TEST_URL?.trim();

class RawPeer {
  #events = [];
  #waiters = new Set();

  constructor(socket) {
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#record({ kind: "binary" });
        return;
      }
      this.#record({ kind: "text", text: Buffer.from(data).toString("utf8") });
    });
    socket.on("close", (code, reason) => this.#record({ kind: "close", code, reason: Buffer.from(reason).toString("utf8") }));
    socket.on("error", (error) => this.#record({ kind: "error", error }));
  }

  cursor() {
    return this.#events.length;
  }

  async sendText(text) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("websocket is not open");
    await new Promise((resolve, reject) => {
      this.socket.send(text, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async waitForText(predicate, after = this.cursor(), timeoutMs = TEST_TIMEOUT_MS, label = "text frame") {
    const event = await this.waitFor(
      (candidate) => candidate.kind === "text" && predicate(candidate.text),
      after,
      timeoutMs,
      label,
    );
    return event.text;
  }

  async waitForClose(after = this.cursor(), timeoutMs = TEST_TIMEOUT_MS) {
    return this.waitFor((candidate) => candidate.kind === "close", after, timeoutMs, "WebSocket close");
  }

  async waitFor(predicate, after, timeoutMs, label) {
    let cursor = after;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      for (let index = cursor; index < this.#events.length; index += 1) {
        const event = this.#events[index];
        if (predicate(event)) return event;
      }
      cursor = this.#events.length;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${label}`);
      await this.#waitForChange(remaining);
    }
  }

  async dispose() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = this.waitForClose(this.cursor(), 300).catch(() => undefined);
    this.socket.terminate();
    await closed;
  }

  #record(event) {
    this.#events.push(event);
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  #waitForChange(timeoutMs) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.#waiters.add(wake);
    });
  }
}

async function connectRaw(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const peer = new RawPeer(socket);
    let settled = false;
    const complete = (callback) => (value) => {
      if (settled) return;
      settled = true;
      socket.off("open", onOpen);
      socket.off("error", onError);
      callback(value);
    };
    const onOpen = complete(() => resolve(peer));
    const onError = complete(reject);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function authenticateRaw(url, identity, helloText) {
  const peer = await connectRaw(url);
  try {
    const challengeAfter = peer.cursor();
    await peer.sendText(helloText);
    const challengeText = await peer.waitForText((text) => {
      try {
        const frame = JSON.parse(text);
        return isRecord(frame) && frame.type === "challenge" && typeof frame.nonce === "string";
      } catch {
        return false;
      }
    }, challengeAfter, TEST_TIMEOUT_MS, "authentication challenge");
    const challenge = JSON.parse(challengeText);
    const nonce = Buffer.from(challenge.nonce, "base64");
    assert.equal(nonce.length, 32, "challenge nonce must have 32 bytes");
    assert.equal(nonce.toString("base64"), challenge.nonce, "challenge nonce must be canonical base64");
    await peer.sendText(JSON.stringify({ type: "auth", sig: signNonce(identity, nonce) }));
    await waitForAuthenticationBarrier(peer);
    return peer;
  } catch (error) {
    await peer.dispose();
    throw error;
  }
}

async function waitForAuthenticationBarrier(peer) {
  await new Promise((resolve, reject) => {
    const marker = randomBytes(16);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.socket.off("pong", onPong);
      peer.socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onPong = (payload) => {
      if (Buffer.from(payload).equals(marker)) finish();
    };
    const onClose = () => finish(new Error("authentication connection closed"));
    const timer = setTimeout(() => finish(new Error("authentication barrier timed out")), TEST_TIMEOUT_MS);
    peer.socket.on("pong", onPong);
    peer.socket.once("close", onClose);
    peer.socket.ping(marker, (error) => {
      if (error) finish(new Error("authentication barrier failed"));
    });
  });
}

function rawHostHello(identity, { pid, startedAt, name = "numeric-host", authorizedOwnerIds = [] } = {}) {
  const endpointId = randomUUID();
  const runtimeId = randomUUID();
  const hello = hostHello(identity, {
    endpointId,
    runtimeId,
    metadata: {
      kind: "daemon",
      name,
      pid: "__PID_LITERAL__",
      started_at: "__STARTED_AT_LITERAL__",
    },
    authorizedOwnerIds,
  });
  return {
    endpointId,
    runtimeId,
    text: JSON.stringify(hello)
      .replace('"__PID_LITERAL__"', pid)
      .replace('"__STARTED_AT_LITERAL__"', startedAt),
  };
}

function rawMetadataUpdate({ pid, startedAt, name = "numeric-update" }) {
  return JSON.stringify({
    type: "endpoint_update",
    metadata: {
      kind: "daemon",
      name,
      pid: "__PID_LITERAL__",
      started_at: "__STARTED_AT_LITERAL__",
    },
  })
    .replace('"__PID_LITERAL__"', pid)
    .replace('"__STARTED_AT_LITERAL__"', startedAt);
}

function rawFrameType(text, type) {
  return new RegExp(`"type"\\s*:\\s*"${type}"`).test(text);
}

function assertNumericLiteral(text, field, literal) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(text, new RegExp(`"${field}"\\s*:\\s*${escaped}(?=,|})`), `${field} must retain numeric token ${literal}`);
}

async function readyBarrier(url) {
  const identity = createIdentity();
  const peer = await authenticateRaw(url, identity, JSON.stringify(ownerHello(identity)));
  try {
    const after = peer.cursor();
    await peer.sendText(JSON.stringify({ type: "subscribe_endpoints", device_ids: [identity.id] }));
    const snapshot = await peer.waitForText((text) => rawFrameType(text, "endpoints"), after, TEST_TIMEOUT_MS, "ready endpoint snapshot");
    assert.match(snapshot, /"endpoints"\s*:\s*\[\s*\]/, "fresh owner must reach a usable ready state");
  } finally {
    await peer.dispose();
  }
}

async function expectHandshakeRejection(url, helloText, label) {
  const peer = await connectRaw(url);
  try {
    const after = peer.cursor();
    await peer.sendText(helloText);
    await peer.waitForClose(after, TEST_TIMEOUT_MS);
  } finally {
    await peer.dispose();
  }
  await readyBarrier(url);
}

async function expectDuplicateAuthRejection(url) {
  const identity = createIdentity();
  const peer = await connectRaw(url);
  try {
    const challengeAfter = peer.cursor();
    await peer.sendText(JSON.stringify(ownerHello(identity)));
    const challengeText = await peer.waitForText((text) => rawFrameType(text, "challenge"), challengeAfter, TEST_TIMEOUT_MS, "authentication challenge");
    const nonce = Buffer.from(JSON.parse(challengeText).nonce, "base64");
    const signature = signNonce(identity, nonce);
    const after = peer.cursor();
    await peer.sendText(`{"type":"auth","sig":"${signature}","sig":"${signature}"}`);
    await peer.waitForClose(after, TEST_TIMEOUT_MS);
  } finally {
    await peer.dispose();
  }
  await readyBarrier(url);
}

test("Relay numeric ingress remains lossless over real WebSockets", { concurrency: false, timeout: 45_000 }, async (t) => {
  let handle;
  let url = externalUrl;
  if (url === undefined || url.length === 0) {
    const { startRelay } = await import("../dist/server.js");
    handle = await startRelay({ host: "127.0.0.1", port: 0 });
    url = `ws://127.0.0.1:${handle.port}`;
  }

  try {
    await t.test("forwards u64, i64, and unsafe integer metadata tokens without JSON number rounding", async () => {
      const ownerIdentity = createIdentity();
      const hostIdentity = createIdentity();
      const hostHelloFrame = rawHostHello(hostIdentity, {
        pid: U64_MAX,
        startedAt: I64_MIN,
        authorizedOwnerIds: [ownerIdentity.id],
      });
      const host = await authenticateRaw(url, hostIdentity, hostHelloFrame.text);
      const owner = await authenticateRaw(url, ownerIdentity, JSON.stringify(ownerHello(ownerIdentity)));
      try {
        const snapshotAfter = owner.cursor();
        await owner.sendText(JSON.stringify({ type: "subscribe_endpoints", device_ids: [hostIdentity.id] }));
        const snapshot = await owner.waitForText((text) => rawFrameType(text, "endpoints"), snapshotAfter, TEST_TIMEOUT_MS, "endpoint snapshot");
        assertNumericLiteral(snapshot, "pid", U64_MAX);
        assertNumericLiteral(snapshot, "started_at", I64_MIN);

        const updateAfter = owner.cursor();
        await host.sendText(rawMetadataUpdate({ pid: UNSAFE_INTEGER, startedAt: "1" }));
        const update = await owner.waitForText((text) => rawFrameType(text, "endpoint_updated"), updateAfter, TEST_TIMEOUT_MS, "endpoint update");
        assertNumericLiteral(update, "pid", UNSAFE_INTEGER);

        const hostBarrierAfter = host.cursor();
        await owner.sendText(JSON.stringify({
          type: "route",
          purpose: "pairing",
          device_id: hostIdentity.id,
          endpoint_id: hostHelloFrame.endpointId,
          runtime_instance_id: hostHelloFrame.runtimeId,
          ct: "numeric-ready-barrier",
        }));
        await host.waitForText((text) => rawFrameType(text, "route") && text.includes("numeric-ready-barrier"), hostBarrierAfter, TEST_TIMEOUT_MS, "post-numeric route barrier");
      } finally {
        await Promise.allSettled([host.dispose(), owner.dispose()]);
      }
    });

    await t.test("rejects invalid numeric grammar and bounds, then frees the connection for a valid peer", async (t) => {
      const invalidCases = [
        ["u64 overflow", rawHostHello(createIdentity(), { pid: "18446744073709551616", startedAt: "0" }).text],
        ["i64 underflow", rawHostHello(createIdentity(), { pid: "1", startedAt: "-9223372036854775809" }).text],
        ["exponent", rawHostHello(createIdentity(), { pid: "1e3", startedAt: "0" }).text],
        ["fraction", rawHostHello(createIdentity(), { pid: "1.5", startedAt: "0" }).text],
        ["negative zero", rawHostHello(createIdentity(), { pid: "-0", startedAt: "0" }).text],
      ];
      for (const [label, helloText] of invalidCases) {
        await t.test(label, async () => expectHandshakeRejection(url, helloText, label));
      }
    });

    await t.test("rejects duplicate auth fields and preserves a later valid barrier", async () => {
      await expectDuplicateAuthRejection(url);
    });
  } finally {
    await handle?.close();
  }
});
