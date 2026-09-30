import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import WebSocket from "ws";

export const DEFAULT_TIMEOUT_MS = 1_000;
export const ABSENCE_TIMEOUT_MS = 150;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class Peer {
  #events = [];
  #waiters = new Set();

  constructor(socket) {
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#record({ kind: "binary" });
        return;
      }
      try {
        this.#record({ kind: "json", value: JSON.parse(Buffer.from(data).toString("utf8")) });
      } catch {
        this.#record({ kind: "invalid_json" });
      }
    });
    socket.on("close", () => this.#record({ kind: "close" }));
    socket.on("error", () => this.#record({ kind: "error" }));
  }

  cursor() {
    return this.#events.length;
  }

  async sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  async sendText(text) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("websocket is not open");
    await new Promise((resolve, reject) => {
      this.socket.send(text, (error) => {
        if (error) reject(new Error("websocket send failed"));
        else resolve();
      });
    });
  }

  async waitForJson(predicate, after = this.cursor(), timeoutMs = DEFAULT_TIMEOUT_MS, label = "relay JSON frame") {
    const event = await this.waitFor(
      (candidate) => candidate.kind === "json" && predicate(candidate.value),
      after,
      timeoutMs,
      label,
    );
    return event.value;
  }

  async waitForClose(after = this.cursor(), timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.waitFor((candidate) => candidate.kind === "close", after, timeoutMs, "websocket close");
  }

  async expectNoJson(predicate, after = this.cursor(), timeoutMs = ABSENCE_TIMEOUT_MS) {
    await this.expectNo(
      (candidate) => candidate.kind === "json" && predicate(candidate.value),
      after,
      timeoutMs,
      "unexpected relay JSON frame",
    );
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
      const changed = await this.#waitForChange(remaining);
      if (!changed && Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    }
  }

  async expectNo(predicate, after, timeoutMs, label) {
    let cursor = after;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      for (let index = cursor; index < this.#events.length; index += 1) {
        if (predicate(this.#events[index])) throw new Error(label);
      }
      cursor = this.#events.length;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const changed = await this.#waitForChange(remaining);
      if (!changed && Date.now() >= deadline) return;
    }
  }

  async closeGracefully(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const after = this.cursor();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    try {
      await this.waitForClose(after, timeoutMs);
    } catch {
      this.socket.terminate();
      await this.waitForClose(after, timeoutMs).catch(() => undefined);
    }
  }

  async dispose() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const after = this.cursor();
    this.socket.terminate();
    await this.waitForClose(after, 250).catch(() => undefined);
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
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.#waiters.add(wake);
    });
  }
}

export async function connectPeer(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let peer;
    try {
      const socket = new WebSocket(url);
      peer = new Peer(socket);
      const rejectOpen = () => {
        if (settled) return;
        settled = true;
        reject(new Error("websocket connection failed"));
      };
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        socket.off("error", rejectOpen);
        resolve(peer);
      });
      socket.once("error", rejectOpen);
    } catch {
      reject(new Error("websocket connection failed"));
    }
  });
}

export function createIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  if (!der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX) || der.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new Error("unexpected Ed25519 SPKI encoding");
  }
  return { id: der.subarray(ED25519_SPKI_PREFIX.length).toString("base64"), privateKey };
}

export function nonCanonicalId(identityId) {
  return identityId
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function ownerHello(identity, overrides = {}) {
  return {
    type: "hello",
    protocol_version: 2,
    role: "owner",
    pubkey: identity.id,
    ...overrides,
  };
}

export function hostHello(identity, options = {}) {
  const endpointId = options.endpointId ?? randomUUID();
  const runtimeId = options.runtimeId ?? randomUUID();
  return {
    type: "hello",
    protocol_version: 2,
    role: "host",
    pubkey: identity.id,
    endpoint_id: endpointId,
    runtime_instance_id: runtimeId,
    metadata: options.metadata ?? defaultMetadata(),
    authorized_owner_ids: options.authorizedOwnerIds ?? [],
  };
}

export function defaultMetadata(overrides = {}) {
  return { kind: "daemon", name: "blackbox", pid: 7, ...overrides };
}

export function routeFrame({ deviceId, endpointId, runtimeId, purpose = "session", targetOwnerId, sourceOwnerId, ct }) {
  const frame = {
    type: "route",
    purpose,
    device_id: deviceId,
    endpoint_id: endpointId,
    runtime_instance_id: runtimeId,
    ct,
  };
  if (targetOwnerId !== undefined) frame.target_owner_id = targetOwnerId;
  if (sourceOwnerId !== undefined) frame.source_owner_id = sourceOwnerId;
  return frame;
}

export function subscriptionFrame(deviceIds) {
  return { type: "subscribe_endpoints", device_ids: deviceIds };
}

export function endpointUpdateFrame({ metadata, authorizedOwnerIds }) {
  const frame = { type: "endpoint_update" };
  if (metadata !== undefined) frame.metadata = metadata;
  if (authorizedOwnerIds !== undefined) frame.authorized_owner_ids = authorizedOwnerIds;
  return frame;
}

export function pairingOfferFrame({ code, endpointId, runtimeId, expiresAt }) {
  return {
    type: "pairing_offer",
    code,
    endpoint_id: endpointId,
    runtime_instance_id: runtimeId,
    expires_at: expiresAt,
  };
}

export function resolvePairingCodeFrame(requestId, code) {
  return { type: "resolve_pairing_code", request_id: requestId, code };
}

export function randomPairingCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(8)].map((byte) => alphabet[byte & 0x1f]).join("");
}

export async function beginAuthentication(url, hello) {
  const peer = await connectPeer(url);
  try {
    const after = peer.cursor();
    await peer.sendJson(hello);
    const challenge = await peer.waitForJson(
      (frame) => isRecord(frame) && frame.type === "challenge" && typeof frame.nonce === "string",
      after,
    );
    const nonce = decodeChallengeNonce(challenge.nonce);
    return { peer, nonce };
  } catch (error) {
    await peer.dispose();
    throw error;
  }
}

export async function authenticate(url, identity, hello) {
  const { peer, nonce } = await beginAuthentication(url, hello);
  try {
    await peer.sendJson({ type: "auth", sig: sign(null, nonce, identity.privateKey).toString("base64") });
    // auth 没有应用层确认；同一连接的后续 Ping/Pong 为跨连接操作建立顺序屏障。
    await new Promise((resolve, reject) => {
      const marker = randomBytes(16);
      const cleanup = () => {
        clearTimeout(timer);
        peer.socket.off("pong", onPong);
        peer.socket.off("close", onClose);
      };
      const onPong = (payload) => { if (payload.equals(marker)) { cleanup(); resolve(); } };
      const onClose = () => { cleanup(); reject(new Error("authentication connection closed")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("authentication barrier timed out")); }, DEFAULT_TIMEOUT_MS);
      peer.socket.on("pong", onPong);
      peer.socket.once("close", onClose);
      peer.socket.ping(marker, (error) => { if (error) { cleanup(); reject(new Error("authentication barrier failed")); } });
    });
    return peer;
  } catch (error) {
    await peer.dispose();
    throw error;
  }
}

export function signNonce(identity, nonce) {
  return sign(null, nonce, identity.privateKey).toString("base64");
}

export async function disposePeers(peers) {
  await Promise.allSettled([...peers].reverse().map((peer) => peer.dispose()));
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeChallengeNonce(encoded) {
  const nonce = Buffer.from(encoded, "base64");
  if (nonce.length !== 32 || nonce.toString("base64") !== encoded) throw new Error("invalid challenge nonce");
  return nonce;
}
