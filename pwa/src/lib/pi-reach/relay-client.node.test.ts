import { expect, test, vi } from "vitest";
import { generateOwnerKeyPair } from "./crypto";
import * as crypto from "./crypto";
import { encodeBase64, encodeUtf8 } from "./encoding";
import { RELAY_CONNECTION_TIMEOUT_MS, RelayClient, type WebSocketLike } from "./relay-client";

class FakeWebSocket implements WebSocketLike {
  readonly readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  throwOnSend = false;
  throwOnClose = false;
  private resolveAuthSent!: () => void;
  readonly authSent = new Promise<void>((resolve) => { this.resolveAuthSent = resolve; });

  send(data: string): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(data);
    if (JSON.parse(data).type === "auth") this.resolveAuthSent();
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.throwOnClose) throw new Error("close failed");
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }
}

async function createClient(socket: FakeWebSocket): Promise<RelayClient> {
  const identity = await generateOwnerKeyPair();
  return new RelayClient({
    relayUrl: "https://relay.example.test",
    identity,
    webSocketFactory: () => socket,
  });
}

function challenge(): string {
  return JSON.stringify({ type: "challenge", nonce: encodeBase64(new Uint8Array(32)) });
}

test("keeps auth pending with its original deadline until Relay registration is confirmed", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  vi.useFakeTimers();
  try {
    let settled = false;
    const connection = client.connect();
    const rejected = connection.catch((error: unknown) => error);
    void connection.then(() => { settled = true; }, () => { settled = true; });
    vi.advanceTimersByTime(6_000);
    socket.open();
    socket.message(challenge());
    await socket.authSent;
    await Promise.resolve();
    expect(client.state).toBe("authenticating");
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(false);
    expect(client.sendRoute({ type: "route", purpose: "session", device_id: "device", endpoint_id: "endpoint", runtime_instance_id: "runtime", ct: "" })).toBe(false);
    vi.advanceTimersByTime(3_999);
    expect(client.state).toBe("authenticating");
    vi.advanceTimersByTime(1);
    expect(await rejected).toEqual(expect.objectContaining({ message: "Relay connection timed out" }));
    expect(client.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  } finally { client.close(); vi.useRealTimers(); }
});

function relayInfo(version = "1.2.3"): string {
  return JSON.stringify({ type: "relay_info", version });
}

async function confirmAuthentication(socket: FakeWebSocket, version?: string): Promise<void> {
  await socket.authSent;
  socket.message(relayInfo(version));
}

test.each(["connecting", "authenticating", "confirmation"])("times out a stalled %s connection and permits a fresh socket", async (state) => {
  const identity = await generateOwnerKeyPair();
  const sockets: FakeWebSocket[] = [];
  const client = new RelayClient({ relayUrl: "https://relay.example.test", identity, webSocketFactory: () => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket;
  } });
  vi.useFakeTimers();
  try {
    const first = client.connect();
    const rejected = first.catch((error: unknown) => error);
    if (state !== "connecting") {
      vi.advanceTimersByTime(6_000);
      sockets[0]!.open();
      if (state === "confirmation") {
        sockets[0]!.message(challenge());
        await sockets[0]!.authSent;
      }
    }
    vi.advanceTimersByTime(state !== "connecting" ? 3_999 : 9_999);
    expect(client.state).toBe(state === "confirmation" ? "authenticating" : state);
    vi.advanceTimersByTime(1);
    expect(client.state).toBe("closed");
    expect(await rejected).toEqual(expect.objectContaining({ message: "Relay connection timed out" }));
    expect(RELAY_CONNECTION_TIMEOUT_MS).toBe(10_000);
    expect(sockets[0]!.closeCalls).toHaveLength(1);
    const second = client.connect();
    expect(sockets).toHaveLength(2);
    sockets[0]!.open();
    sockets[0]!.error();
    sockets[0]!.onclose?.(new Event("close") as CloseEvent);
    sockets[1]!.open();
    sockets[1]!.message(challenge());
    sockets[0]!.message(relayInfo("stale"));
    expect(vi.getTimerCount()).toBe(1);
    await confirmAuthentication(sockets[1]!);
    await second;
    vi.advanceTimersByTime(20_000);
    expect(client.state).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

test("clears the pending deadline on close and merges concurrent connection requests", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  vi.useFakeTimers();
  try {
    const first = client.connect();
    const second = client.connect();
    const rejected = Promise.all([expect(first).rejects.toThrow(/closed by client/), expect(second).rejects.toThrow(/closed by client/)]);
    expect(vi.getTimerCount()).toBe(1);
    client.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.closeCalls).toHaveLength(1);
  } finally { client.close(); vi.useRealTimers(); }
});

test("cleans up when the WebSocket factory throws synchronously", async () => {
  const identity = await generateOwnerKeyPair();
  const client = new RelayClient({
    relayUrl: "https://relay.example.test",
    identity,
    webSocketFactory: () => { throw new Error("factory failed"); },
  });

  await expect(client.connect()).rejects.toThrow(/factory failed/);
  expect(client.state).toBe("closed");
  expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(false);
});

test("closes with an application code and a UTF-8 byte-limited reason on invalid challenge", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.message(JSON.stringify({ type: "unexpected" }));
  await expect(connection).rejects.toThrow(/Expected Relay challenge/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
  expect((socket.closeCalls[0]?.reason ? new TextEncoder().encode(socket.closeCalls[0].reason).length : 0) <= 123).toBe(true);
});

test("cleans up when hello send fails", async () => {
  const socket = new FakeWebSocket();
  socket.throwOnSend = true;
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  await expect(connection).rejects.toThrow(/send failed/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
  expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(false);
});

test("cleans up when an unauthenticated socket errors", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.error();
  await expect(connection).rejects.toThrow(/Relay WebSocket error/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
});

test("does not mark authentication complete when auth send fails", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.throwOnSend = true;
  socket.message(challenge());
  await expect(connection).rejects.toThrow(/send failed/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
});

test("truncates a multibyte close reason without splitting UTF-8", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  client.connect().catch(() => {});
  client.close(1002, "界".repeat(100));
  const reason = socket.closeCalls[0]?.reason ?? "";
  expect(new TextEncoder().encode(reason).length <= 123).toBe(true);
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(encodeUtf8(reason))).not.toThrow();
  expect(socket.closeCalls[0]?.code).not.toBe(1002);
});

test("ignores delayed callbacks from an old socket after a new connection starts", async () => {
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  const identity = await generateOwnerKeyPair();
  const sockets = [first, second];
  const client = new RelayClient({
    relayUrl: "https://relay.example.test",
    identity,
    webSocketFactory: () => sockets.shift() ?? second,
  });
  const firstConnection = client.connect();
  first.open();
  first.message(challenge());
  await confirmAuthentication(first);
  await firstConnection;

  client.close();
  const secondConnection = client.connect();
  second.open();
  first.error();
  first.onclose?.(new Event("close") as CloseEvent);
  second.message(challenge());
  await confirmAuthentication(second);
  await secondConnection;

  expect(client.state).toBe("open");
  expect(client.sendControl({ type: "subscribe_endpoints", device_ids: ["device"] })).toBe(true);
  expect(first.sent.filter((frame) => frame.includes("subscribe_endpoints"))).toHaveLength(0);
});

test("forwards only valid Relay versions from the current authenticated socket", async () => {
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  const sockets = [first, second];
  const identity = await generateOwnerKeyPair();
  const client = new RelayClient({ relayUrl: "https://relay.example.test", identity, webSocketFactory: () => sockets.shift() ?? second });
  const versions: string[] = [];
  client.on("control", (frame) => { if (frame.type === "relay_info") versions.push(frame.version); });
  const connected = client.connect();
  first.open();
  first.message(challenge());
  await confirmAuthentication(first);
  await connected;
  first.message(JSON.stringify({ type: "relay_info", version: "bad", extra: true }));
  await Promise.resolve();
  expect(versions).toEqual(["1.2.3"]);

  client.close();
  const reconnected = client.connect();
  second.open();
  second.message(challenge());
  await confirmAuthentication(second, "2.3.4");
  await reconnected;
  first.message(JSON.stringify({ type: "relay_info", version: "old-socket" }));
  await Promise.resolve();
  expect(versions).toEqual(["1.2.3", "2.3.4"]);
  client.close();
});

test.each(["1.2.3", "development build"])("confirms registration with version %s and forwards the first info exactly once", async (version) => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const authenticated = vi.fn();
  const control = vi.fn();
  const routed = vi.fn();
  client.on("authenticated", authenticated);
  client.on("control", control);
  client.on("route", routed);
  vi.useFakeTimers();
  try {
    const first = client.connect();
    const second = client.connect();
    socket.open();
    socket.message(challenge());
    await socket.authSent;
    expect(authenticated).not.toHaveBeenCalled();
    await confirmAuthentication(socket, version);
    await Promise.all([first, second]);
    expect(client.state).toBe("open");
    expect(authenticated).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledExactlyOnceWith({ type: "relay_info", version });
    expect(vi.getTimerCount()).toBe(0);
    const route = { type: "route", purpose: "session", device_id: "device", endpoint_id: "00000000-0000-4000-8000-000000000001", runtime_instance_id: "00000000-0000-4000-8000-000000000002", ct: "" } as const;
    expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(true);
    expect(client.sendRoute(route)).toBe(true);
    socket.message(JSON.stringify(route));
    socket.message(JSON.stringify({ type: "endpoints", device_id: "device", endpoints: [] }));
    socket.message(relayInfo(version));
    await Promise.resolve();
    expect(routed).toHaveBeenCalledExactlyOnceWith(route);
    expect(control).toHaveBeenCalledTimes(3);
    expect(authenticated).toHaveBeenCalledTimes(1);
  } finally { client.close(); vi.useRealTimers(); }
});

test.each([
  "not json",
  JSON.stringify({ type: "relay_info", version: "" }),
  JSON.stringify({ type: "relay_info", version: "v".repeat(257) }),
  JSON.stringify({ type: "relay_info", version: 123 }),
  JSON.stringify({ type: "relay_info", version: "valid", extra: true }),
  JSON.stringify({ type: "endpoints", device_id: "device", endpoints: [] }),
  challenge(),
])("fails closed on an invalid registration confirmation (%#)", async (message) => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const authenticated = vi.fn();
  const control = vi.fn();
  client.on("authenticated", authenticated);
  client.on("control", control);
  vi.useFakeTimers();
  try {
    const connection = client.connect();
    const rejected = expect(connection).rejects.toThrow(/Expected Relay registration confirmation/);
    socket.open();
    socket.message(challenge());
    await socket.authSent;
    socket.message(message);
    await rejected;
    socket.message(relayInfo());
    await Promise.resolve();
    expect(client.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    expect(authenticated).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "auth")).toHaveLength(1);
  } finally { client.close(); vi.useRealTimers(); }
});

test("rejects relay_info before any challenge", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.message(relayInfo());
  await expect(connection).rejects.toThrow(/Expected Relay challenge/);
  expect(client.state).toBe("closed");
  expect(socket.sent).toHaveLength(1);
});

test.each(["client close", "socket close", "socket error"])("cleans up %s while awaiting registration confirmation", async (action) => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const authenticated = vi.fn();
  client.on("authenticated", authenticated);
  vi.useFakeTimers();
  try {
    const connection = client.connect();
    const rejected = expect(connection).rejects.toThrow(/closed|WebSocket error/);
    socket.open();
    socket.message(challenge());
    await socket.authSent;
    if (action === "client close") client.close();
    else if (action === "socket close") socket.onclose?.(new Event("close") as CloseEvent);
    else socket.error();
    await rejected;
    socket.message(relayInfo());
    await Promise.resolve();
    expect(client.state).toBe("closed");
    expect(authenticated).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(false);
  } finally { client.close(); vi.useRealTimers(); }
});

test.each(["duplicate challenge", "early relay_info"])("rejects %s during signing and ignores the late signature after reconnect", async (message) => {
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  const sockets = [first, second];
  const identity = await generateOwnerKeyPair();
  const client = new RelayClient({ relayUrl: "https://relay.example.test", identity, webSocketFactory: () => sockets.shift() ?? second });
  let finishSigning!: (signature: string) => void;
  let startedSigning!: () => void;
  const signing = new Promise<string>((resolve) => { finishSigning = resolve; });
  const started = new Promise<void>((resolve) => { startedSigning = resolve; });
  const sign = vi.spyOn(crypto, "signChallenge").mockImplementationOnce(() => { startedSigning(); return signing; });
  vi.useFakeTimers();
  try {
    const connection = client.connect();
    const rejected = expect(connection).rejects.toThrow(/Unexpected Relay authentication message/);
    first.open();
    first.message(challenge());
    await started;
    first.message(message === "duplicate challenge" ? challenge() : relayInfo());
    await rejected;
    expect(sign).toHaveBeenCalledTimes(1);
    const reconnected = client.connect();
    second.open();
    finishSigning("late signature");
    first.message(relayInfo("old socket"));
    await Promise.resolve();
    await Promise.resolve();
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect(client.state).toBe("authenticating");
    expect(vi.getTimerCount()).toBe(1);
    second.message(challenge());
    await confirmAuthentication(second);
    await reconnected;
    expect(client.state).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
  } finally { client.close(); vi.useRealTimers(); sign.mockRestore(); }
});
