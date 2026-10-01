import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { connect as connectTcp, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { startRelay, type RelayHandle, type RelayLogEvent } from "./server.js";
import { PeerRegistry } from "./registry.js";
import { BoundedTransport } from "./transport.js";
import { RELAY_VERSION } from "./version.js";

const openRelays: RelayHandle[] = [];
const openSockets: WebSocket[] = [];
const openTcpSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  for (const socket of openTcpSockets.splice(0)) socket.destroy();
  await Promise.all(openRelays.splice(0).map((relay) => relay.close()));
  vi.restoreAllMocks();
});

function keyPair(): { id: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { id: der.subarray(-32).toString("base64"), privateKey };
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  openSockets.push(socket);
  await once(socket, "open");
  return socket;
}

async function invalidUpgrade(port: number): Promise<void> {
  const socket = connectTcp(port, "127.0.0.1");
  openTcpSockets.push(socket);
  await once(socket, "connect");
  const finished = Promise.race([once(socket, "end"), once(socket, "close")]);
  socket.resume();
  socket.write([
    "GET / HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: invalid",
    "",
    "",
  ].join("\r\n"));
  await finished;
  socket.destroy();
}

async function authenticateOwner(socket: WebSocket, owner: { id: string; privateKey: KeyObject }): Promise<void> {
  socket.send(JSON.stringify({ type: "hello", protocol_version: 2, role: "owner", pubkey: owner.id }));
  await sendAuth(socket, owner.privateKey);
  const [raw] = await once(socket, "message") as [RawData, boolean];
  expect(JSON.parse(raw.toString())).toEqual({ type: "relay_info", version: RELAY_VERSION });
}

async function authenticateHost(
  socket: WebSocket,
  host: { id: string; privateKey: KeyObject },
  ownerId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  socket.send(JSON.stringify({
    type: "hello",
    protocol_version: 2,
    role: "host",
    pubkey: host.id,
    endpoint_id: "11111111-1111-4111-8111-111111111111",
    runtime_instance_id: "22222222-2222-4222-8222-222222222222",
    metadata,
    authorized_owner_ids: [ownerId],
  }));
  await sendAuth(socket, host.privateKey);
}

async function sendAuth(socket: WebSocket, privateKey: KeyObject): Promise<void> {
  const [raw] = await once(socket, "message") as [RawData, boolean];
  const challenge = JSON.parse(raw.toString()) as { nonce: string };
  const sig = sign(null, Buffer.from(challenge.nonce, "base64"), privateKey).toString("base64");
  socket.send(JSON.stringify({ type: "auth", sig }));
}

describe("startRelay", () => {
  it("serves only health HTTP and authenticates a real Ed25519 owner", async () => {
    const events: RelayLogEvent[] = [];
    const relay = await startRelay({ port: 0, logger: (event) => events.push(event) });
    openRelays.push(relay);
    expect(await (await fetch(`http://127.0.0.1:${relay.port}/health`)).text()).toBe("OK");
    expect((await fetch(`http://127.0.0.1:${relay.port}/missing`)).status).toBe(404);

    const socket = await connect(relay.port);
    const owner = keyPair();
    await authenticateOwner(socket, owner);
    socket.send(JSON.stringify({ type: "subscribe_endpoints", device_ids: [] }));
    await vi.waitFor(() => expect(events).toContainEqual({ event: "authenticated", role: "owner" }));
  });

  it("sends Relay info once after Owner auth, never to Hosts or rejected peers", async () => {
    const events: RelayLogEvent[] = [];
    const relay = await startRelay({ port: 0, logger: (event) => events.push(event) });
    openRelays.push(relay);
    const identity = keyPair();
    const owner = await connect(relay.port);
    const ownerFrames: Array<{ type: string }> = [];
    owner.on("message", (raw: RawData) => ownerFrames.push(JSON.parse(raw.toString()) as { type: string }));
    await authenticateOwner(owner, identity);
    const snapshot = once(owner, "message");
    owner.send(JSON.stringify({ type: "auth", sig: "invalid repeated auth" }));
    owner.send(JSON.stringify({ type: "subscribe_endpoints", device_ids: [identity.id] }));
    await snapshot;
    expect(ownerFrames.map((frame) => frame.type)).toEqual(["challenge", "relay_info", "endpoints"]);

    const host = await connect(relay.port);
    const hostFrames: Array<{ type: string }> = [];
    host.on("message", (raw: RawData) => hostFrames.push(JSON.parse(raw.toString()) as { type: string }));
    await authenticateHost(host, keyPair(), identity.id, { kind: "interactive" });
    await vi.waitFor(() => expect(events).toContainEqual({ event: "authenticated", role: "host" }));
    expect(hostFrames.map((frame) => frame.type)).toEqual(["challenge"]);

    const rejected = await connect(relay.port);
    const rejectedFrames: Array<{ type: string }> = [];
    rejected.on("message", (raw: RawData) => rejectedFrames.push(JSON.parse(raw.toString()) as { type: string }));
    const challenge = once(rejected, "message");
    rejected.send(JSON.stringify({ type: "hello", protocol_version: 2, role: "owner", pubkey: identity.id }));
    await challenge;
    expect(rejectedFrames.map((frame) => frame.type)).toEqual(["challenge"]);
    const closed = once(rejected, "close");
    rejected.send(JSON.stringify({ type: "auth", sig: "invalid" }));
    await closed;
    expect(rejectedFrames.map((frame) => frame.type)).toEqual(["challenge"]);
  });

  it.each(["returned_false", "synchronous_failure"] as const)("deactivates Owner registration when Relay info delivery fails (%s)", async (failure) => {
    const events: RelayLogEvent[] = [];
    const unregister = vi.spyOn(PeerRegistry.prototype, "unregisterOwner");
    const send = BoundedTransport.prototype.send;
    vi.spyOn(BoundedTransport.prototype, "send").mockImplementation(function (this: BoundedTransport, line: string) {
      if (JSON.parse(line).type !== "relay_info") return send.call(this, line);
      if (failure === "synchronous_failure") this.evict();
      return failure === "synchronous_failure";
    });
    const relay = await startRelay({ port: 0, logger: (event) => events.push(event) });
    openRelays.push(relay);
    const socket = await connect(relay.port);
    const identity = keyPair();
    socket.send(JSON.stringify({ type: "hello", protocol_version: 2, role: "owner", pubkey: identity.id }));
    await sendAuth(socket, identity.privateKey);
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledExactlyOnceWith(identity.id, expect.any(Number)));
    expect(events).not.toContainEqual({ event: "authenticated", role: "owner" });
  });

  it("releases pending-auth capacity immediately when a timed-out peer starts closing", async () => {
    const relay = await startRelay({
      port: 0,
      limits: { maxConnections: 2, maxPendingAuth: 1, helloTimeoutMs: 30, authTimeoutMs: 30, shutdownTimeoutMs: 100 },
    });
    openRelays.push(relay);
    const first = await connect(relay.port);
    const closePromise = once(first, "close");
    await closePromise;

    const second = await connect(relay.port);
    await authenticateOwner(second, keyPair());
    second.send(JSON.stringify({ type: "subscribe_endpoints", device_ids: [] }));
    expect(second.readyState).toBe(WebSocket.OPEN);
  });

  it("releases reservations after repeated invalid WebSocket upgrades", async () => {
    const relay = await startRelay({
      port: 0,
      limits: { maxConnections: 1, maxPendingAuth: 1, helloTimeoutMs: 100, authTimeoutMs: 100, shutdownTimeoutMs: 100 },
    });
    openRelays.push(relay);
    await invalidUpgrade(relay.port);
    await invalidUpgrade(relay.port);
    const socket = await connect(relay.port);
    await authenticateOwner(socket, keyPair());
    socket.send(JSON.stringify({ type: "subscribe_endpoints", device_ids: [] }));
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("bounds and times out raw HTTP sockets", async () => {
    const relay = await startRelay({
      port: 0,
      limits: { maxConnections: 1, maxPendingAuth: 1, helloTimeoutMs: 30, authTimeoutMs: 30, shutdownTimeoutMs: 100 },
    });
    openRelays.push(relay);
    const first = connectTcp(relay.port, "127.0.0.1");
    const second = connectTcp(relay.port, "127.0.0.1");
    const third = connectTcp(relay.port, "127.0.0.1");
    openTcpSockets.push(first, second, third);
    first.resume();
    second.resume();
    third.resume();
    const firstClosed = once(first, "close");
    const thirdClosed = once(third, "close");
    await Promise.all([once(first, "connect"), once(second, "connect"), once(third, "connect")]);
    await expect(Promise.race([
      thirdClosed.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ])).resolves.toBe("closed");
    await expect(Promise.race([
      firstClosed.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("closed");
  });

  it("rejects discovery-capacity host authentication without disturbing the existing host", async () => {
    const events: RelayLogEvent[] = [];
    const relay = await startRelay({
      port: 0,
      limits: { maxSubscriptions: 1, maxDiscoveryBytes: 260, shutdownTimeoutMs: 100 },
      logger: (event) => events.push(event),
    });
    openRelays.push(relay);
    const ownerIdentity = keyPair();
    const hostIdentity = keyPair();
    const first = await connect(relay.port);
    await authenticateHost(first, hostIdentity, ownerIdentity.id, { kind: "daemon" });
    await vi.waitFor(() => expect(events).toContainEqual({ event: "authenticated", role: "host" }));

    const replacement = await connect(relay.port);
    await authenticateHost(replacement, hostIdentity, ownerIdentity.id, { kind: "daemon", name: "超".repeat(30) });
    const [code] = await once(replacement, "close") as [number, Buffer];
    expect(code).toBe(1008);
    expect(events).toContainEqual({ event: "connection_rejected", outcome: "discovery_capacity" });

    const owner = await connect(relay.port);
    await authenticateOwner(owner, ownerIdentity);
    const snapshotPromise = once(owner, "message") as Promise<[RawData, boolean]>;
    owner.send(JSON.stringify({ type: "subscribe_endpoints", device_ids: [hostIdentity.id] }));
    const [raw] = await snapshotPromise;
    const snapshot = JSON.parse(raw.toString()) as { endpoints: Array<{ metadata: Record<string, unknown> }> };
    expect(snapshot.endpoints).toHaveLength(1);
    expect(snapshot.endpoints[0]?.metadata).toEqual({ kind: "daemon" });
  });

  it("closes discovery-capacity updates with a distinct outcome", async () => {
    const events: RelayLogEvent[] = [];
    const relay = await startRelay({
      port: 0,
      limits: { maxSubscriptions: 1, maxDiscoveryBytes: 260, shutdownTimeoutMs: 100 },
      logger: (event) => events.push(event),
    });
    openRelays.push(relay);
    const ownerIdentity = keyPair();
    const hostIdentity = keyPair();
    const host = await connect(relay.port);
    await authenticateHost(host, hostIdentity, ownerIdentity.id, { kind: "daemon" });
    await vi.waitFor(() => expect(events).toContainEqual({ event: "authenticated", role: "host" }));
    const closed = once(host, "close");
    host.send(JSON.stringify({ type: "endpoint_update", metadata: { kind: "daemon", name: "超".repeat(30) } }));
    const [code] = await closed as [number, Buffer];
    expect(code).toBe(1008);
    expect(events).toContainEqual({ event: "frame_dropped", role: "host", outcome: "discovery_capacity" });
  });

  it("closes declared subscription overflow with policy violation", async () => {
    const relay = await startRelay({ port: 0, limits: { maxSubscriptions: 1, shutdownTimeoutMs: 100 } });
    openRelays.push(relay);
    const socket = await connect(relay.port);
    await authenticateOwner(socket, keyPair());
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "subscribe_endpoints", device_ids: [Buffer.alloc(32, 1).toString("base64"), Buffer.alloc(32, 2).toString("base64")] }));
    const [code] = await closed as [number, Buffer];
    expect(code).toBe(1008);
  });
});
