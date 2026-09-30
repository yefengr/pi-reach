import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { decodeServerFrameV2 } from "./protocol/v2/index.js";

const owners = [{ name: "test-owner", remote_epk: Buffer.alloc(32, 7).toString("base64"), paired_at: "now" }];
const relays: TestRelay[] = [];
class TestRelay extends EventEmitter {
  open = true;
  connect = vi.fn(async () => {});
  send = vi.fn();
  sendControl = vi.fn(() => true);
  close = vi.fn(() => { this.open = false; });
  isOpen = () => this.open;
  constructor() { super(); relays.push(this); }
}
vi.mock("./transport/relay_client.js", async (original) => ({ ...(await original<typeof import("./transport/relay_client.js")>()), RelayClient: TestRelay }));
vi.mock("./pairing/storage.js", async (original) => ({
  ...(await original<typeof import("./pairing/storage.js")>()),
  getOrCreateEd25519Keypair: async () => ({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }),
  listPeers: async () => [...owners],
}));
vi.mock("./session/local_config.js", async (original) => ({ ...(await original<typeof import("./session/local_config.js")>()), loadLocalConfig: () => ({}) }));
const { default: extension, processEndpointIdentity } = await import("./index.js");

type SdkSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  return { promise: new Promise<T>((resolvePromise) => { resolve = resolvePromise; }), resolve };
}

async function createSession(
  modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>,
  parentSession?: string,
  observers: ExtensionFactory[] = [],
): Promise<SdkSession> {
  const manager = SessionManager.inMemory(process.cwd());
  if (parentSession) manager.newSession({ parentSession });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
    extensionFactories: [extension, ...observers], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const model = modelRuntime.getModels("anthropic")[0]!;
  const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(), modelRuntime, model, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
  session.agent.streamFunction = () => {
    const message = {
      role: "assistant" as const, content: [{ type: "text" as const, text: "local SDK reply" }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const, timestamp: Date.now(),
    };
    return {
      async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: "stop", message }; },
      async result() { return message; },
    } as unknown as Awaited<ReturnType<SdkSession["agent"]["streamFunction"]>>;
  };
  await session.bindExtensions({});
  return session;
}

async function dispose(session: SdkSession | undefined): Promise<void> {
  if (!session) return;
  await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}


test("real SDK child lifecycle cannot steal the primary Relay or its remote message destination", async () => {
  const modelRuntime = await ModelRuntime.create({ authPath: join(tmpdir(), "pi-reach-owner-sdk-no-auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels("anthropic")[0]!;
  await modelRuntime.setRuntimeApiKey(model.provider, "local-sdk-test-key");
  const extensionInputs: string[] = [];
  const inputTransformer: ExtensionFactory = (pi) => {
    pi.on("input", (event) => {
      if (event.source !== "extension") return;
      extensionInputs.push(event.text);
      if (event.text === "before transform") return { action: "transform", text: "after transform" };
    });
  };
  let primary: SdkSession | undefined;
  let child: SdkSession | undefined;
  let releaseGate: Deferred<void> | undefined;
  try {
    primary = await createSession(modelRuntime, undefined, [inputTransformer]);
    await vi.waitFor(() => expect(relays).toHaveLength(1));
    const relay = relays[0]!;
    const identity = processEndpointIdentity();
    const send = (inner: unknown) => relay.emit("message", JSON.stringify({ type: "route", purpose: "session", device_id: Buffer.alloc(32, 1).toString("base64"), endpoint_id: identity.endpointId, runtime_instance_id: identity.runtimeInstanceId, source_owner_id: owners[0]!.remote_epk, ct: Buffer.from(JSON.stringify(inner)).toString("base64") }));
    const frames = () => relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from(JSON.parse(line).ct, "base64").toString("utf8")));
    send({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "primary-channel" });
    await vi.waitFor(() => expect(frames().some((frame) => frame.type === "session_ready")).toBe(true));
    const ready = frames().find((frame) => frame.type === "session_ready")!;
    child = await createSession(modelRuntime, primary.sessionManager.getSessionId());
    await child.prompt("child-only input");
    await dispose(child);
    child = undefined;
    expect(relays).toHaveLength(1);
    expect(relay.close).not.toHaveBeenCalled();
    expect(frames().some((frame) => frame.type === "bye")).toBe(false);

    const currentLeaf = () => primary!.sessionManager.getLeafId() ?? null;
    send({ protocol_version: 2, type: "user_message", id: "remote-wire", client_request_id: "remote-request", channel_id: "primary-channel", session_id: ready.session_id, leaf_id: currentLeaf(), text: "primary remote probe" });
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "timeline_event", event: expect.objectContaining({ kind: "assistant", session_id: ready.session_id, leaf_id: expect.any(String) }) })));
    const messages = primary.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => JSON.stringify(entry.message));
    expect(messages.some((message) => message.includes("primary remote probe"))).toBe(true);
    expect(messages.some((message) => message.includes("child-only input"))).toBe(false);
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "user_message_status", client_request_id: "remote-request", status: "committed" })));

    const gateStarted = deferred<void>();
    releaseGate = deferred<void>();
    let streamCount = 0;
    primary.agent.streamFunction = () => {
      streamCount += 1;
      const message = {
        role: "assistant" as const, content: [{ type: "text" as const, text: `local SDK reply ${streamCount}` }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: Date.now(),
      };
      const waitForRelease = streamCount === 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (waitForRelease) {
            gateStarted.resolve(undefined);
            await releaseGate!.promise;
          }
          yield { type: "start", partial: message };
          yield { type: "done", reason: "stop", message };
        },
        async result() { return message; },
      } as unknown as Awaited<ReturnType<SdkSession["agent"]["streamFunction"]>>;
    };
    const rootPrompt = primary.prompt("root streaming request");
    await gateStarted.promise;
    send({ protocol_version: 2, type: "user_message", id: "wire-first", client_request_id: "same-text-first", channel_id: "primary-channel", session_id: ready.session_id, leaf_id: currentLeaf(), text: "identical queued text" });
    send({ protocol_version: 2, type: "user_message", id: "wire-first-retry", client_request_id: "same-text-first", channel_id: "primary-channel", session_id: ready.session_id, leaf_id: currentLeaf(), text: "identical queued text" });
    send({ protocol_version: 2, type: "user_message", id: "wire-second", client_request_id: "same-text-second", channel_id: "primary-channel", session_id: ready.session_id, leaf_id: currentLeaf(), text: "identical queued text" });
    releaseGate.resolve(undefined);
    await rootPrompt;

    await vi.waitFor(() => {
      const committed = frames().filter((frame) => frame.type === "user_message_status" && (frame.client_request_id === "same-text-first" || frame.client_request_id === "same-text-second") && frame.status === "committed");
      expect(committed).toHaveLength(2);
    });
    await primary.waitForIdle();
    const committed = frames().filter((frame) => frame.type === "user_message_status" && (frame.client_request_id === "same-text-first" || frame.client_request_id === "same-text-second") && frame.status === "committed");
    expect(committed.map((frame) => frame.client_request_id).sort()).toEqual(["same-text-first", "same-text-second"]);
    const committedIds = committed.map((frame) => frame.message_id);
    expect(new Set(committedIds).size).toBe(2);
    const formalUsers = frames().filter((frame) => frame.type === "timeline_event" && frame.event.kind === "user" && frame.event.origin === "pwa");
    expect(formalUsers.filter((frame) => committedIds.includes(frame.event.message_id))).toHaveLength(2);
    const assistantIds = new Set(frames().filter((frame) => frame.type === "timeline_event" && frame.event.kind === "assistant").map((frame) => frame.event.event_id));
    expect(committedIds.some((messageId) => assistantIds.has(messageId))).toBe(false);
    expect(frames().filter((frame) => frame.type === "user_message_started" && (frame.in_reply_to === "wire-first" || frame.in_reply_to === "wire-second")).map((frame) => frame.in_reply_to).sort()).toEqual(["wire-first", "wire-second"]);
    expect(extensionInputs.filter((text) => text === "identical queued text")).toHaveLength(2);

    send({ protocol_version: 2, type: "user_message", id: "wire-transform", client_request_id: "transform-request", channel_id: "primary-channel", session_id: ready.session_id, leaf_id: currentLeaf(), text: "before transform" });
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "user_message_status", client_request_id: "transform-request", status: "committed" })));
    await primary.waitForIdle();
    const transformCommit = frames().find((frame) => frame.type === "user_message_status" && frame.client_request_id === "transform-request" && frame.status === "committed")!;
    expect(frames()).toContainEqual(expect.objectContaining({ type: "timeline_event", event: expect.objectContaining({ kind: "user", origin: "pwa", message_id: transformCommit.message_id, blocks: [{ type: "text", text: "after transform" }] }) }));
    expect(extensionInputs).toContain("before transform");
  } finally {
    releaseGate?.resolve(undefined);
    await dispose(child);
    await dispose(primary);
  }
});
