import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";

import WebSocket from "ws";

import {
  DEFAULT_TIMEOUT_MS,
  Peer,
  authenticate,
  createIdentity,
  defaultMetadata,
  hostHello,
  isRecord,
  ownerHello,
  signNonce,
  subscriptionFrame,
} from "./helpers.mjs";

export const RESOURCE_TIMEOUT_MS = 2_000;

export async function withLocalRelay(options, callback) {
  const { startRelay } = await import("../dist/server.js");
  const relay = await startRelay({ ...options, host: "127.0.0.1", port: 0 });
  try {
    return await callback({ relay, url: `ws://127.0.0.1:${relay.port}` });
  } finally {
    await relay.close().catch(() => undefined);
  }
}

export async function withPeers(callback) {
  const peers = [];
  const track = (peer) => {
    peers.push(peer);
    return peer;
  };
  try {
    return await callback(track);
  } finally {
    await Promise.allSettled([...peers].reverse().map((peer) => peer.dispose()));
  }
}

export async function openSocket(url, options = {}) {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.off("open", onOpen);
      socket.off("error", onError);
      callback(value);
    };
    const onOpen = () => finish(resolve, socket);
    const onError = (error) => finish(reject, error);
    socket.once("open", onOpen);
    socket.once("error", onError);
    // Later asynchronous errors are observed by the close-oriented test helpers.
    socket.on("error", () => undefined);
  }), RESOURCE_TIMEOUT_MS, "WebSocket open");
}

export async function openPeer(url, options = {}) {
  return new Peer(await openSocket(url, options));
}

export async function authenticatePeer(url, identity, hello, options = {}) {
  if (Object.keys(options).length === 0) return authenticate(url, identity, hello);

  const peer = await openPeer(url, options);
  try {
    const after = peer.cursor();
    await peer.sendJson(hello);
    const challenge = await peer.waitForJson(
      (frame) => isRecord(frame) && frame.type === "challenge" && typeof frame.nonce === "string",
      after,
      RESOURCE_TIMEOUT_MS,
      "authentication challenge",
    );
    const nonce = Buffer.from(challenge.nonce, "base64");
    if (nonce.length !== 32 || nonce.toString("base64") !== challenge.nonce) {
      throw new Error("relay emitted an invalid authentication challenge");
    }
    await peer.sendJson({ type: "auth", sig: signNonce(identity, nonce) });
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
    const timer = setTimeout(() => finish(new Error("authentication barrier timed out")), RESOURCE_TIMEOUT_MS);
    peer.socket.on("pong", onPong);
    peer.socket.once("close", onClose);
    peer.socket.ping(marker, (error) => {
      if (error) finish(new Error("authentication barrier failed"));
    });
  });
}

export async function openOwner(url, track, identity = createIdentity()) {
  return { identity, peer: track(await authenticate(url, identity, ownerHello(identity))) };
}

export async function openHost(url, track, options = {}) {
  const identity = options.identity ?? createIdentity();
  const endpointId = options.endpointId ?? randomUUID();
  const runtimeId = options.runtimeId ?? randomUUID();
  const peer = track(await authenticate(
    url,
    identity,
    hostHello(identity, {
      endpointId,
      runtimeId,
      metadata: options.metadata ?? defaultMetadata(),
      authorizedOwnerIds: options.authorizedOwnerIds ?? [],
    }),
  ));
  return { identity, peer, endpointId, runtimeId };
}

export async function subscribe(owner, deviceIds) {
  const after = owner.peer.cursor();
  await owner.peer.sendJson(subscriptionFrame(deviceIds));
  return owner.peer.waitForJson(
    (frame) => isRecord(frame) && frame.type === "endpoints",
    after,
    RESOURCE_TIMEOUT_MS,
    "endpoint snapshot",
  );
}

export function sendSocket(socket, data, options) {
  return new Promise((resolve, reject) => {
    socket.send(data, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function waitForSocketClose(socket, timeoutMs = RESOURCE_TIMEOUT_MS) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: Buffer.alloc(0) });
  return withTimeout(new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason }));
  }), timeoutMs, "WebSocket close");
}

export async function disposeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = waitForSocketClose(socket, 500).catch(() => undefined);
  socket.terminate();
  await closed;
}

export async function expectUpgradeStatus(url, expectedStatus) {
  await withTimeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners("open");
      socket.removeAllListeners("unexpected-response");
      if (error) reject(error);
      else resolve();
    };
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      if (status !== expectedStatus) {
        finish(new Error(`expected HTTP ${expectedStatus} during WebSocket upgrade, got ${status}`));
        return;
      }
      finish();
    });
    socket.once("open", () => {
      socket.terminate();
      finish(new Error(`expected HTTP ${expectedStatus} during WebSocket upgrade, but connection opened`));
    });
    socket.once("error", (error) => finish(error));
  }), RESOURCE_TIMEOUT_MS, `HTTP ${expectedStatus} WebSocket rejection`);
}

export async function openTcpSocket(port) {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      callback(value);
    };
    const onConnect = () => finish(resolve, socket);
    const onError = (error) => finish(reject, error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.on("error", () => undefined);
  }), RESOURCE_TIMEOUT_MS, "TCP open");
}

export function waitForTcpClose(socket, timeoutMs = RESOURCE_TIMEOUT_MS) {
  if (socket.destroyed) return Promise.resolve();
  return withTimeout(new Promise((resolve) => socket.once("close", resolve)), timeoutMs, "TCP close");
}

export async function assertPortClosed(port) {
  await withTimeout(new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const fail = () => {
      socket.destroy();
      reject(new Error("relay port remained reachable after child exit"));
    };
    socket.once("connect", fail);
    socket.once("error", () => resolve());
  }), RESOURCE_TIMEOUT_MS, "closed relay port");
}

export async function waitForCondition(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS, label = "operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
