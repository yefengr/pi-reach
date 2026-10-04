import { beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { renderPwa } from "@/test/browser/render";
import { generateOwnerKeyPair } from "@/lib/pi-reach/crypto";
import { encodeBase64 } from "@/lib/pi-reach/encoding";
import type { ClientFrame } from "@/lib/pi-reach/protocol-v2";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_IN_FLIGHT, ATTACHMENT_MAX_MESSAGE_BYTES, PUBLISHED_FILE_TYPE, fileChunkFrameSchema, fileOpenedFrameSchema, type AttachmentDescriptor } from "@pi-reach/protocol/session";
import { toStoredKey } from "@/lib/pwa/runtime";
import { listTimelineSessions, loadTimeline, mergeTimelineEvents, TimelineStoreConflictError } from "@/lib/pwa/timeline-store";
import { PendingCapacityError, TimelineRuntime } from "@/lib/pwa/timeline-runtime";
import { makePwaDeviceId, makePwaEndpointId, openPwaDatabase } from "@/lib/pwa/db";
import { PwaApp } from "./pwa-app";
import { connectionBannerTiming } from "./pwa-app-actions";

const relayHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    state: string;
    closeCalls: number;
    connectCalls: number;
    subscriptions: string[][];
    controlFrames: Array<{ type: string; request_id?: string; code?: string }>;
    stateListeners: Array<(state: string) => void>;
    errorListeners: Array<(error: Error) => void>;
    controlListeners: Array<(frame: unknown) => void>;
    emitState: (state: string) => void;
    emitControl: (frame: unknown) => void;
    emitError: (error: Error) => void;
    connectRejects: number;
  }>,
  nextConnectRejects: 0,
  rejectConnect: null as ((error: Error) => void) | null,
}));
const channelHarness = vi.hoisted(() => ({
  channels: [] as Array<{
    channelId: string;
    frames: ClientFrame[];
    emit: (frame: unknown) => void;
    emitMalformed: (message: string) => void;
    closeCalls: number;
  }>,
  nextSendResults: [] as boolean[],
  supportsAttachments: true,
  holdFinish: false,
  failNextChunk: false,
  finishReplies: [] as Array<() => void>,
  uploads: new Map<string, { descriptor: AttachmentDescriptor; received: number; complete: boolean }>(),
}));

vi.mock("@/lib/pwa/timeline-store", { spy: true });

vi.mock("@/lib/pi-reach/relay-client", () => ({
  RelayClient: class {
    state = "idle";
    closeCalls = 0;
    connectCalls = 0;
    subscriptions: string[][] = [];
    controlFrames: Array<{ type: string; request_id?: string; code?: string }> = [];
    stateListeners: Array<(state: string) => void> = [];
    errorListeners: Array<(error: Error) => void> = [];
    controlListeners: Array<(frame: unknown) => void> = [];
    connectRejects = relayHarness.nextConnectRejects;

    constructor() {
      relayHarness.nextConnectRejects = 0;
      relayHarness.rejectConnect = null;
      relayHarness.instances.push(this);
    }

    on(event: string, callback: (value: unknown) => void) {
      if (event === "state") this.stateListeners.push(callback as (state: string) => void);
      if (event === "error") this.errorListeners.push(callback as (error: Error) => void);
      if (event === "control") this.controlListeners.push(callback);
      return () => undefined;
    }

    async connect() {
      this.connectCalls += 1;
      if (this.connectRejects > 0) {
        this.connectRejects -= 1;
        this.state = "closed";
        await new Promise<void>((_, reject) => {
          relayHarness.rejectConnect = () => reject(new Error("connect rejected"));
        });
      }
      this.state = "open";
    }

    subscribeEndpoints(deviceIds: string[]) {
      this.subscriptions.push([...deviceIds]);
      return this.state === "open";
    }

    sendControl(frame: { type: string; request_id?: string; code?: string }) {
      if (this.state !== "open") return false;
      this.controlFrames.push(frame);
      return true;
    }

    sendRoute() {
      return this.state === "open";
    }

    emitState(state: string) {
      this.state = state;
      for (const listener of this.stateListeners) listener(state);
    }

    emitError(error: Error) {
      for (const listener of this.errorListeners) listener(error);
    }

    emitControl(frame: unknown) {
      for (const listener of this.controlListeners) listener(frame);
    }

    close() {
      this.closeCalls += 1;
      this.emitState("closed");
    }
  },
}));

vi.mock("@/lib/pi-reach/peer-channel", () => ({
  PeerChannel: class {
    readonly channelId: string;
    readonly frames: ClientFrame[] = [];
    closeCalls = 0;
    private readonly onFrame?: (frame: unknown) => void;

    constructor(options: {
      endpoint: { endpointId: string };
      channelId?: string;
      onFrame?: (frame: unknown) => void;
      onMalformed?: (message: string) => void;
      onPairOk?: (frame: {
        protocol_version: 2;
        type: "pair_ok";
        in_reply_to: string;
        session_name: string;
        session_started_at: number;
        endpoint_id: string;
        hostname: string;
      }) => void;
    }) {
      this.channelId = options.channelId ?? `pairing-channel-${channelHarness.channels.length}`;
      this.onFrame = options.onFrame;
      channelHarness.channels.push({ channelId: this.channelId, frames: this.frames, emit: (frame) => this.onFrame?.(frame), emitMalformed: (message) => options.onMalformed?.(message), closeCalls: 0 });
      this.options = options;
    }
    private readonly options: {
      endpoint: { endpointId: string };
      onPairOk?: (frame: {
        protocol_version: 2;
        type: "pair_ok";
        in_reply_to: string;
        session_name: string;
        session_started_at: number;
        endpoint_id: string;
        hostname: string;
      }) => void;
    };

    send(frame: ClientFrame) {
      this.frames.push(frame);
      const sendResult = channelHarness.nextSendResults.shift() ?? true;
      if (!sendResult) return false;
      if (frame.type === "attachment_capabilities_request") {
        queueMicrotask(() => this.onFrame?.(channelHarness.supportsAttachments ? {
          protocol_version: 2, type: "attachment_capabilities", target_channel_id: this.channelId, in_reply_to: frame.id,
          session_id: frame.session_id, upload_scope: `uploads-${frame.session_id}`,
          max_file_bytes: ATTACHMENT_MAX_FILE_BYTES, max_message_bytes: ATTACHMENT_MAX_MESSAGE_BYTES,
          max_attachments: ATTACHMENT_MAX_COUNT, chunk_bytes: ATTACHMENT_CHUNK_BYTES, max_in_flight: ATTACHMENT_MAX_IN_FLIGHT,
        } : { protocol_version: 2, type: "protocol_error", target_channel_id: this.channelId, in_reply_to: frame.id, code: "unsupported_type", message: "legacy" }));
      }
      if (frame.type === "attachment_begin" || frame.type === "attachment_chunk" || frame.type === "attachment_status_request" || frame.type === "attachment_finish" || frame.type === "attachment_cancel") {
        if (frame.type === "attachment_chunk" && channelHarness.failNextChunk) {
          channelHarness.failNextChunk = false;
          queueMicrotask(() => this.onFrame?.({ protocol_version: 2, type: "attachment_error", target_channel_id: this.channelId, in_reply_to: frame.id, session_id: frame.session_id, upload_scope: frame.upload_scope, upload_id: frame.upload_id, code: "no_space", retryable: true }));
          return true;
        }
        if (frame.type === "attachment_begin") channelHarness.uploads.set(frame.upload_id, {
          descriptor: { attachment_id: `file-${frame.upload_id}`, file_name: frame.file_name, mime_type: frame.mime_type, byte_length: frame.byte_length, sha256: frame.sha256, ...(frame.preview ? { preview: frame.preview } : {}) }, received: 0, complete: false,
        });
        const upload = channelHarness.uploads.get(frame.upload_id);
        if (upload && frame.type === "attachment_chunk") upload.received = frame.offset + atob(frame.data_base64).length;
        if (upload && frame.type === "attachment_finish") upload.complete = true;
        const reply = () => this.onFrame?.({ protocol_version: 2, target_channel_id: this.channelId, in_reply_to: frame.id,
          session_id: frame.session_id, upload_scope: frame.upload_scope, upload_id: frame.upload_id,
          ...(upload ? { type: "attachment_state", received_bytes: upload.received, status: frame.type === "attachment_cancel" ? "cancelled" : upload.complete ? "complete" : "receiving", ...(upload.complete && frame.type !== "attachment_cancel" ? { attachment: upload.descriptor } : {}) }
            : { type: "attachment_error", code: "not_found", retryable: false }),
        });
        if (frame.type === "attachment_finish" && channelHarness.holdFinish) channelHarness.finishReplies.push(reply);
        else queueMicrotask(reply);
      }
      if (frame.type === "attachment_discard") {
        const entry = [...channelHarness.uploads].find(([, item]) => item.descriptor.attachment_id === frame.attachment_id);
        if (entry) channelHarness.uploads.delete(entry[0]);
        queueMicrotask(() => this.onFrame?.({ protocol_version: 2, type: "attachment_discarded", target_channel_id: this.channelId,
          in_reply_to: frame.id, session_id: frame.session_id, upload_scope: frame.upload_scope,
          attachment_id: frame.attachment_id, status: "cancelled" }));
      }
      if (frame.type === "pair_request") {
        queueMicrotask(() => this.options.onPairOk?.({
          protocol_version: 2,
          type: "pair_ok",
          in_reply_to: frame.id,
          session_name: "test-session",
          session_started_at: Date.now(),
          endpoint_id: this.options.endpoint.endpointId,
          hostname: "paired-host",
        }));
      }
      return true;
    }

    sendPairRequest(frame: Extract<ClientFrame, { type: "pair_request" }>) {
      return this.send(frame);
    }

    close() {
      this.closeCalls += 1;
      const record = channelHarness.channels.find((channel) => channel.frames === this.frames);
      if (record) record.closeCalls += 1;
    }
  },
}));

beforeEach(async () => {
  // 连接提示条默认在断线 10 秒后出现；集成测试立即显示，延迟本身由 use-delayed-visibility 测试覆盖。
  connectionBannerTiming.delayMs = 0;
  vi.mocked(loadTimeline).mockClear();
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  await page.viewport(1280, 900);
  relayHarness.instances.length = 0;
  relayHarness.nextConnectRejects = 0;
  relayHarness.rejectConnect = null;
  channelHarness.channels.length = 0;
  channelHarness.nextSendResults.length = 0;
  channelHarness.supportsAttachments = true;
  channelHarness.holdFinish = false;
  channelHarness.failNextChunk = false;
  channelHarness.finishReplies.length = 0;
  channelHarness.uploads.clear();
  const db = await openPwaDatabase();
  await db.transaction("rw", [db.identities, db.devices, db.endpoints, db.events, db.sessions, db.settings], async () => {
    await Promise.all([
      db.identities.clear(),
      db.devices.clear(),
      db.endpoints.clear(),
      db.events.clear(),
      db.sessions.clear(),
      db.settings.clear(),
    ]);
  });
  const identity = await generateOwnerKeyPair();
  const deviceId = "owner-device-key";
  const endpointId = "daemon-endpoint";
  await Promise.all([
    db.identities.put({ id: "owner", publicKey: toStoredKey(identity.publicKey), secretKey: toStoredKey(identity.privateKey), createdAt: Date.now() }),
    db.devices.put({ id: makePwaDeviceId(deviceId), deviceId, relayUrl: "https://relay.example.test", pairedAt: "2026-08-30T00:00:00.000Z", hostname: "test-host" }),
    db.endpoints.put({ id: makePwaEndpointId(deviceId, endpointId), deviceId, endpointId, runtimeInstanceId: "runtime-1", kind: "interactive", cwd: "/workspace", updatedAt: Date.now() }),
    db.settings.put({ key: `active_endpoint:${makePwaDeviceId(deviceId)}`, value: endpointId }),
  ]);
});

test("keeps the Owner Relay alive while endpoint discovery is still checking", async () => {
  const screen = await renderPwa(<PwaApp />);

  await expect.element(screen.getByText("Checking for running Pi...", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Loading…", { exact: true })).toBeInTheDocument();
  expect(relayHarness.instances).toHaveLength(1);
  expect(relayHarness.instances[0]?.closeCalls).toBe(0);
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function renderWorkspaceApp() {
  // 使用生产层级，避免辅助 renderPwa 的额外 .pwa-root 改变 Portal 和高度行为。
  return render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaApp /></PwaAppShell></PwaUiProvider>);
}

async function renderOnlineApp(renderApp = () => renderPwa(<PwaApp />)) {
  const deviceId = "owner-device-key";
  const screen = await renderApp();
  await vi.waitFor(() => expect(relayHarness.instances).toHaveLength(1));
  const relay = relayHarness.instances[0];
  await vi.waitFor(() => expect(relay?.state).toBe("open"));
  relay?.emitControl({
    type: "endpoints",
    device_id: deviceId,
    endpoints: [{
      endpoint_id: "daemon-endpoint",
      runtime_instance_id: "runtime-1",
      metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" },
    }],
  });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(1));
  return screen;
}

test.each([1280, 390])("focuses only a new empty desktop session, without opening the mobile keyboard at %ipx", async (width) => {
  await page.viewport(width, 844);
  const screen = await renderOnlineApp(() => renderPwa(<PwaApp />));
  try {
    const channel = channelHarness.channels[0]!;
    const action = screen.getByRole("button", { name: "Session actions" });
    action.element().focus();
    channel.emit(readyFrame(channel, "empty-session"));
    const input = screen.getByRole("textbox", { name: /Message your agent/i });
    await expect.element(input).toBeVisible();
    if (width === 1280) await expect.element(input).toHaveFocus();
    else await expect.element(action).toHaveFocus();
    await expect.element(screen.getByText("Send a message to Pi to begin.")).toBeVisible();
  } finally { await screen.unmount(); }
});

test("does not focus the composer when opening a session with saved records", async () => {
  const screen = await renderOnlineApp();
  try {
    const channel = channelHarness.channels[0]!;
    const action = screen.getByRole("button", { name: "Session actions" });
    action.element().focus();
    channel.emit(readyFrame(channel, "existing-session", 2));
    await expect.element(screen.getByRole("textbox", { name: /Message your agent/i })).toBeVisible();
    await expect.element(action).toHaveFocus();
  } finally { await screen.unmount(); }
});

test("focuses a new empty desktop session after its confirmation dialog exits", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  try {
    await issueOperation(context, "session_new");
    expect(document.querySelector(".pwa-confirm-dialog")).not.toBeNull();
    channel.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "session_replaced" });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    channelHarness.channels[1]!.emit(readyFrame(channelHarness.channels[1]!, "fresh-empty-session"));
    const input = screen.getByRole("textbox", { name: /Message your agent/i });
    await expect.element(input).toBeVisible();
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    await expect.element(input).toHaveFocus();
  } finally { await screen.unmount(); }
});

function readyFrame(channel: { channelId: string; frames: Array<{ type: string; id: string; channel_id?: string }> }, sessionId: string, headSeq = 0) {
  return {
    protocol_version: 2 as const,
    type: "session_ready" as const,
    target_channel_id: channel.channelId,
    in_reply_to: channel.frames.find((frame) => frame.type === "session_hello")?.id ?? "missing-hello",
    session_id: sessionId,
    leaf_id: `generation-${sessionId}`,
    self_sender_ref: `sender-${sessionId}`,
    head_seq: headSeq,
  };
}

function extensionInfoFrame(channel: { channelId: string; frames: Array<{ type: string; id: string }> }, version: string) {
  return {
    protocol_version: 2 as const,
    type: "extension_info" as const,
    target_channel_id: channel.channelId,
    in_reply_to: channel.frames.filter((frame) => frame.type === "extension_info_request").at(-1)?.id ?? "missing-request",
    version,
  };
}

async function renderReadyTimeline(renderApp = () => renderPwa(<PwaApp />)) {
  const screen = await renderOnlineApp(renderApp);
  const channel = channelHarness.channels[0];
  if (!channel) throw new Error("Expected a session channel.");
  channel.emit(readyFrame(channel, "session-1"));
  await flushMicrotasks();
  await expect.poll(() => document.querySelector<HTMLButtonElement>('[aria-label="Add attachments"]')?.disabled).toBe(!channelHarness.supportsAttachments);
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list");
  if (!list) throw new Error("Expected the message list.");
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 600 },
  });
  const scrollTo = vi.fn();
  Object.defineProperty(list, "scrollTo", { configurable: true, value: scrollTo });
  return { channel, list, screen, scrollTo };
}

test("keeps queued messages beside the composer and inserts the original item only once", async () => {
  const { screen, channel, list } = await renderReadyTimeline(renderWorkspaceApp);
  const queued = { protocol_version: 2, type: "queued_message_state", session_id: "session-1", leaf_id: "generation-session-1", snapshot_id: "queue", chunk_index: 0, final: true, items: [{ id: "queued-1", text: "Follow up after this task", sender_ref: "sender-session-1", editable: true, created_at: 1 }] };
  channel.emit(queued);
  await expect.element(screen.getByText("Follow up after this task", { exact: true })).toBeVisible();
  expect(list.textContent).not.toContain("Follow up after this task");
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  expect(composer.textContent).toContain("Follow up after this task");
  const insert = screen.getByRole("button", { name: /Insert into conversation/ });
  await expect.element(insert).toBeEnabled();
  const button = insert.element();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(channel.frames.filter((frame) => frame.type === "queued_message_steer")).toHaveLength(1);
  const request = channel.frames.find((frame) => frame.type === "queued_message_steer")!;
  expect(request).toMatchObject({ target_id: "queued-1" });
  expect(channel.frames.filter((frame) => frame.type === "user_message")).toHaveLength(0);
  await expect.element(insert).toBeDisabled();
  channel.emit({ ...queued, items: [] });
  await expect.element(screen.getByText("Insertion requested · awaiting confirmation", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Insert into conversation/ })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: /Cancel queued message/ })).toBeDisabled();
  channel.emit({ protocol_version: 2, type: "user_message_status", target_channel_id: channel.channelId, in_reply_to: request.id, client_request_id: "queued-1", session_id: "session-1", leaf_id: "generation-session-1", status: "accepted", message_id: "message-1" });
  await expect.element(screen.getByRole("heading", { name: "Queued messages" })).not.toBeInTheDocument();
  await screen.unmount();
});

function operationFeedback(): HTMLElement {
  const feedback = document.querySelector<HTMLElement>("#pwa-operation-feedback.pwa-operation-notification");
  if (!feedback) throw new Error("Expected operation feedback.");
  return feedback;
}

type OperationHarness = Awaited<ReturnType<typeof renderReadyTimeline>>;
type TestedAction = "session_new" | "session_compact" | "model_set" | "thinking_set";
const rawOperationError = "WebSocket Relay endpoint_id=550e8400-e29b-41d4-a716-446655440000";

async function issueOperation({ screen, channel }: OperationHarness, action: TestedAction, sendResult = true) {
  const previousRequests = channel.frames.filter((frame) => frame.type === action).length;
  if (action === "model_set") {
    const current = { id: "text-model", provider: "test", name: "Text model", reasoning: false, context_window: 200_000, vision: false };
    const vision = { ...current, id: "vision-model", name: "Vision model", vision: true };
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: channel.frames.findLast((frame) => frame.type === "list_models")?.id, models: [current, vision], current });
    await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
  }
  if (action === "model_set") {
    // 模型从输入区的模型标签进入，菜单直接打开模型列表。
    await screen.getByRole("button", { name: /^Change model, current/ }).click();
    channelHarness.nextSendResults.push(sendResult);
    await screen.getByRole("menuitem", { name: /test \/ Vision model/ }).click();
  } else if (action === "thinking_set") {
    // 思考级别从输入区的「/」菜单进入；会话菜单不再重复这两项。
    await screen.getByRole("button", { name: "Pi commands" }).click();
    await screen.getByRole("menuitem", { name: /\/thinking/ }).click();
    channelHarness.nextSendResults.push(sendResult);
    await screen.getByRole("menuitem", { name: "high", exact: true }).click();
  } else {
    await screen.getByRole("button", { name: "Session actions" }).click();
    if (action === "session_new") {
      await screen.getByRole("menuitem", { name: "New session", exact: true }).click();
      channelHarness.nextSendResults.push(sendResult);
      await screen.getByRole("button", { name: "Start fresh session", exact: true }).click();
    } else {
      channelHarness.nextSendResults.push(sendResult);
      await screen.getByRole("menuitem", { name: "Compact context", exact: true }).click();
    }
  }
  // 菜单动作在退出淡化结束后才交接，请求随之异步发出。
  await expect.poll(() => channel.frames.filter((frame) => frame.type === action).length, { message: `Missing ${action} request` }).toBeGreaterThan(previousRequests);
  return channel.frames.findLast((frame) => frame.type === action)!;
}

function replyOperation(channel: OperationHarness["channel"], request: ClientFrame, success = false) {
  channel.emit({ protocol_version: 2, type: success ? "action_ok" : "action_error", target_channel_id: channel.channelId, in_reply_to: request.id, action: request.type, error: rawOperationError });
}

test.each([
  ["session_new", "Could not start a new session. Try again."],
  ["session_compact", "Could not compact the conversation. Try again."],
  ["model_set", "Could not change the model. Try again."],
  ["thinking_set", "Could not change the thinking level. Try again."],
] as const)("reports %s failures in one safe notification and ignores stale replies", async (action, message) => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  try {
    const request = await issueOperation(context, action);
    if (action === "session_new") await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    if (action === "model_set") await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    replyOperation(channel, { ...request, id: "obsolete-request" });
    await flushMicrotasks();
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
    replyOperation(channel, request);
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
    expect(operationFeedback().textContent).not.toMatch(/WebSocket|Relay|endpoint_id|550e8400/);
    expect(document.querySelector(".pwa-toast")).toBeNull();
    expect(document.querySelectorAll(".pwa-operation-notification")).toHaveLength(1);
    if (action === "model_set") await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    await screen.getByRole("button", { name: "Dismiss operation notification" }).click();
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
    replyOperation(channel, request);
    await flushMicrotasks();
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
    const retry = await issueOperation(context, action);
    if (action === "session_new") await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    replyOperation(channel, retry);
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
    const card = operationFeedback();
    const finalRetry = await issueOperation(context, action);
    if (action === "session_new") await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    expect(operationFeedback()).toBe(card);
    replyOperation(channel, finalRetry, true);
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
    expect(channelHarness.channels).toHaveLength(1);
  } finally { await screen.unmount(); }
});

test.each(["session_compact", "model_set", "thinking_set"] as const)("shows the %s send failure without a raw transport error", async (action) => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  try {
    await issueOperation(context, action, false);
    await expect.poll(() => document.querySelector(".pwa-operation-notification")?.textContent).toContain("Check the connection and try again.");
    expect(operationFeedback().textContent).not.toMatch(/Relay|WebSocket/);
    expect(document.querySelector(".pwa-toast")).toBeNull();
    const retry = await issueOperation(context, action);
    expect(operationFeedback()).toBeTruthy();
    replyOperation(context.channel, retry, true);
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { await context.screen.unmount(); }
});

test("keeps a rejected new-session send only in its still-open confirmation", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  try {
    await issueOperation(context, "session_new", false);
    await expect.element(context.screen.getByRole("dialog", { name: "Start a fresh session?" })).toBeVisible();
    await expect.element(context.screen.getByText("Could not start a fresh session. Check the connection and try again.")).toBeVisible();
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
    expect(document.querySelector(".pwa-toast")).toBeNull();
  } finally { await context.screen.unmount(); }
});

test("keeps stop failure until a matching cancelled response arrives", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    relayHarness.instances[0].emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace", working: true } });
    const stop = screen.getByRole("button", { name: "Stop current task", exact: true });
    await expect.element(stop).toBeEnabled();
    channelHarness.nextSendResults.push(false);
    await stop.click();
    await expect.element(screen.getByText("Could not send the stop request. Check the connection and try again.")).toBeVisible();
    await stop.click();
    const request = channel.frames.findLast((frame) => frame.type === "cancel")!;
    expect(operationFeedback()).toBeTruthy();
    channel.emit({ protocol_version: 2, type: "cancelled", in_reply_to: "old-request" });
    await flushMicrotasks();
    expect(operationFeedback()).toBeTruthy();
    channel.emit({ protocol_version: 2, type: "cancelled", in_reply_to: request.id });
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { await screen.unmount(); }
});

test("registry failure replaces an action error and survives an unrelated success", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const db = await openPwaDatabase();
  const put = vi.spyOn(db.endpoints, "put");
  try {
    const first = await issueOperation(context, "session_compact");
    replyOperation(context.channel, first);
    await expect.element(context.screen.getByText("Could not compact the conversation. Try again.")).toBeVisible();
    const retry = await issueOperation(context, "session_compact");
    put.mockRejectedValueOnce(new Error(rawOperationError));
    relayHarness.instances[0].emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Updated Pi", cwd: "/workspace" } });
    const message = context.screen.getByText("Could not save Pi details on this device. Refresh the app to try again.");
    await expect.element(message).toBeVisible();
    replyOperation(context.channel, retry, true);
    await flushMicrotasks();
    await expect.element(message).toBeVisible();
    expect(document.querySelectorAll(".pwa-operation-notification")).toHaveLength(1);
    expect(document.querySelector(".pwa-toast")).toBeNull();
    expect(operationFeedback().textContent).not.toContain(rawOperationError);
  } finally { put.mockRestore(); await context.screen.unmount(); }
});

test("entering saved history revokes session feedback and ignores old channel replies", async () => {
  await seedArchivedSession();
  const context = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const request = await issueOperation(context, "session_compact");
    replyOperation(context.channel, request);
    await expect.element(context.screen.getByText("Could not compact the conversation. Try again.")).toBeVisible();
    await expect.poll(() => document.querySelector(".pwa-history-row")?.textContent).toContain("Archived note");
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await expect.element(context.screen.getByRole("heading", { name: "Archived note", exact: true })).toBeVisible();
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
    replyOperation(context.channel, request);
    await flushMicrotasks();
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { await context.screen.unmount(); }
});

test("marks the open history row with the neutral selected background, also while hovered", async () => {
  await seedArchivedSession();
  const context = await renderReadyTimeline(renderWorkspaceApp);
  try {
    await expect.poll(() => document.querySelector(".pwa-history-row")?.textContent).toContain("Archived note");
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await expect.element(context.screen.getByRole("heading", { name: "Archived note", exact: true })).toBeVisible();
    const row = document.querySelector<HTMLElement>(".pwa-history-row[data-active]")!;
    const probe = document.createElement("span");
    probe.style.cssText = "color: var(--pwa-ink); background: var(--pwa-selected)";
    row.append(probe);
    const [ink, selected] = [getComputedStyle(probe).color, getComputedStyle(probe).backgroundColor];
    probe.remove();
    // 点击后指针仍停在该行上，当前项不能被悬停底覆盖。
    expect(row.matches(":hover")).toBe(true);
    await expect.poll(() => getComputedStyle(row).backgroundColor).toBe(selected);
    expect(getComputedStyle(row).color).toBe(ink);
  } finally { await context.screen.unmount(); }
});

test("saves session names, follows renames, and keeps replaced sessions separate", async () => {
  await seedTimeline(numberedEvents(1));
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  const relay = relayHarness.instances[0];
  const summaries = () => listTimelineSessions("owner-device-key");
  const updateName = (name: string) => relay.emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name, cwd: "/workspace" } });
  try {
    await expect.poll(async () => (await summaries())[0]?.name).toBe("Test Pi");
    updateName("Renamed session");
    await expect.poll(async () => (await summaries())[0]?.name).toBe("Renamed session");
    // 在线会话只出现在「在线 Pi」分组，本地历史不重复列出。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigationHistoryRows().some((text) => text.includes("Renamed session"))).toBe(false);

    channel.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "session_replaced" });
    updateName("Second session");
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const nextChannel = channelHarness.channels[1];
    nextChannel.emit(readyFrame(nextChannel, "session-2"));
    await seedTimeline([{ ...numberedEvents(1)[0], event_id: "second-event", session_id: "session-2", leaf_id: "generation-session-2", timestamp: Date.now() + 1 }]);
    await expect.poll(async () => (await summaries()).find((entry) => entry.sessionId === "session-2")?.name).toBe("Second session");
    expect((await summaries()).find((entry) => entry.sessionId === "session-1")?.name).toBe("Renamed session");

    updateName("Second renamed");
    await expect.poll(async () => (await summaries()).find((entry) => entry.sessionId === "session-2")?.name).toBe("Second renamed");
    // 被替换的会话不再在线，回到本地历史；当前的 session-2 不列出。
    await expect.poll(() => navigationHistoryRows().some((text) => text.startsWith("Renamed session"))).toBe(true);
    expect(navigationHistoryRows().some((text) => text.startsWith("Second renamed"))).toBe(false);
    const oldHistory = page.elementLocator([...document.querySelectorAll<HTMLElement>(".pwa-history-row")].find((row) => row.textContent?.startsWith("Renamed session"))!);
    await oldHistory.click();
    await expect.element(screen.getByRole("heading", { name: "Renamed session", exact: true })).toBeVisible();
    updateName("Live name while reading history");
    await flushMicrotasks();
    await expect.element(screen.getByRole("heading", { name: "Renamed session", exact: true })).toBeVisible();
    expect((await summaries()).find((entry) => entry.sessionId === "session-1")?.name).toBe("Renamed session");
  } finally { await screen.unmount(); }
});

test.each([
  ["invalid_leaf", "This session is out of date. Reconnect and try again."],
  ["too_large", "This message is too large to send."],
  ["internal_error", "Pi could not process this request. Try again."],
])("shows safe protocol feedback for %s without rendering the remote message", async (code, message) => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    channel.emit({ protocol_version: 2, type: "protocol_error", target_channel_id: channel.channelId, code, message: rawOperationError });
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(rawOperationError);
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { await screen.unmount(); }
});

test.each([
  [new Error("IndexedDB INTERNAL_TOKEN"), "Could not update local history."],
  [new TimelineStoreConflictError("Conflicting event INTERNAL_TOKEN"), "This conversation changed elsewhere. Reconnect and try again."],
])("keeps local persistence errors distinct from protocol and send errors: %s", async (failure, message) => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    vi.mocked(mergeTimelineEvents).mockRejectedValueOnce(failure);
    emitEvent(channel, numberedEvents(1)[0]);
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("INTERNAL_TOKEN");
    expect(document.body.textContent).not.toContain("Could not update the conversation. Reconnect and try again.");
    await expect.element(screen.getByText("Record 1", { exact: true }).last()).toBeVisible();
  } finally { await screen.unmount(); }
});

test.each([
  [new Error(rawOperationError), "Could not send this message. Try again."],
  [new PendingCapacityError(), "Too many unconfirmed messages or attachments. Wait for delivery confirmation before sending more."],
])("reports message preparation failure without losing the draft: %s", async (failure, message) => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  const sendUser = vi.spyOn(TimelineRuntime.prototype, "sendUser").mockImplementationOnce(() => { throw failure; });
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Keep my unsent draft");
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
    await expect.element(input).toHaveValue("Keep my unsent draft");
    expect(channel.frames.filter((frame) => frame.type === "user_message")).toHaveLength(0);
    expect(document.body.textContent).not.toContain(rawOperationError);
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { sendUser.mockRestore(); await screen.unmount(); }
});

test("clears a stale Toast only when sending starts and preserves operation feedback", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  try {
    replyOperation(channel, await issueOperation(context, "session_compact"));
    await expect.element(screen.getByText("Could not compact the conversation. Try again.")).toBeVisible();
    const notice = operationFeedback();
    channel.emit({ protocol_version: 2, type: "protocol_error", target_channel_id: channel.channelId, code: "too_large", message: rawOperationError });
    const stale = screen.getByText("This message is too large to send.", { exact: true });
    await expect.element(stale).toBeVisible();
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("A new message");
    await expect.element(stale).toBeVisible();
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.element(stale).not.toBeInTheDocument();
    await expect.element(input).toHaveValue("");
    expect(channel.frames.filter((frame) => frame.type === "user_message")).toHaveLength(1);
    expect(operationFeedback()).toBe(notice);
    expect(notice.textContent).toContain("Could not compact the conversation. Try again.");
  } finally { await screen.unmount(); }
});

test.each([true, false])("clears a stale Toast when session_new starts (send=%s) without clearing operation feedback", async (sendResult) => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  try {
    replyOperation(channel, await issueOperation(context, "session_compact"));
    await expect.element(screen.getByText("Could not compact the conversation. Try again.")).toBeVisible();
    const notice = operationFeedback();
    channel.emitMalformed(rawOperationError);
    const stale = screen.getByText("Pi could not process this request. Try again.", { exact: true });
    await expect.element(stale).toBeVisible();
    await issueOperation(context, "session_new", sendResult);
    await expect.element(stale).not.toBeInTheDocument();
    expect(operationFeedback()).toBe(notice);
    expect(notice.textContent).toContain("Could not compact the conversation. Try again.");
    if (!sendResult) await expect.element(screen.getByText("Could not start a fresh session. Check the connection and try again.")).toBeVisible();
  } finally { await screen.unmount(); }
});

test("keeps current handshake protocol feedback after the matching session_ready reply", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const channel = channelHarness.channels[0];
  try {
    channel.emitMalformed(rawOperationError);
    const feedback = screen.getByText("Pi could not process this request. Try again.", { exact: true });
    await expect.element(feedback).toBeVisible();
    expect(document.body.textContent).not.toContain(rawOperationError);
    channel.emit({ ...readyFrame(channel, "stale-session"), in_reply_to: "stale-hello" });
    await flushMicrotasks();
    await expect.element(feedback).toBeVisible();
    channel.emit(readyFrame(channel, "session-1"));
    await expect.element(screen.getByPlaceholder("Message your agent…")).toBeEnabled();
    await expect.element(feedback).toBeVisible();
  } finally { await screen.unmount(); }
});

test("message send failure keeps draft and delivery feedback out of global notifications", async () => {
  const { screen } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Keep my draft");
    channelHarness.nextSendResults.push(false);
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.element(screen.getByText("Message could not be sent. Check the connection and try again.", { exact: true })).toBeVisible();
    await expect.element(input).toHaveValue("Keep my draft");
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.element(screen.getByText("Message could not be sent. Check the connection and try again.", { exact: true })).not.toBeInTheDocument();
    await expect.element(input).toHaveValue("");
  } finally { await screen.unmount(); }
});

test("confirms leaving an attachment send, preserves the original draft and rejects late completion", async () => {
  await seedArchivedSession();
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const model = { id: "vision-model", provider: "test", name: "Vision model", reasoning: false, context_window: 200_000, vision: true };
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: channel.frames.findLast((frame) => frame.type === "list_models")?.id, models: [model], current: model });
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Keep scope-bound image draft");
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([Uint8Array.of(137, 80, 78, 71)], "scope-image.png", { type: "image/png" }));
    input.element().dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    await expect.element(screen.getByText("scope-image.png", { exact: true })).toBeVisible();
    channelHarness.holdFinish = true;
    const send = screen.getByRole("button", { name: "Send message", exact: true }).element();
    send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    await expect.poll(() => document.querySelector<HTMLButtonElement>(".pwa-history-row")).not.toBeNull();
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await expect.element(screen.getByRole("button", { name: "Keep sending", exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Keep sending", exact: true }).click();
    await expect.element(input).toHaveValue("Keep scope-bound image draft");
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await screen.getByRole("button", { name: "Stop and switch", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Archived note", exact: true })).toBeVisible();
    channelHarness.finishReplies[0]?.();
    await flushMicrotasks();
    expect(channel.frames.filter((frame) => frame.type === "user_message")).toHaveLength(0);
    await screen.getByRole("button", { name: "Back to live session", exact: true }).click();
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const resumedChannel = channelHarness.channels[1];
    if (!resumedChannel) throw new Error("Expected a replacement session channel.");
    resumedChannel.emit(readyFrame(resumedChannel, "session-1"));
    const resumedInput = screen.getByPlaceholder("Message your agent…");
    await expect.element(resumedInput).toHaveValue("Keep scope-bound image draft");
    expect(resumedChannel.frames.filter((frame) => frame.type === "user_message")).toHaveLength(0);
  } finally { await screen.unmount(); }
});

const publishedReportBytes = new TextEncoder().encode("Complete published report");
type FileOpenRequest = Extract<ClientFrame, { type: "file_open" }>;
type FileReadRequest = Extract<ClientFrame, { type: "file_read" }>;

function publishedReportEvent(publicationId = "published-report"): TimelineEvent & { kind: "custom" } {
  return {
    event_id: publicationId, event_seq: 1, session_id: "session-1", leaf_id: "generation-session-1",
    timestamp: 1, group_id: "published-group", kind: "custom", truncated: false,
    payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: "report.txt", mime_type: "text/plain", byte_length: publishedReportBytes.byteLength, tool_call_id: "publish-report-tool" } },
  };
}

async function beginPublishedReport({ channel, screen }: OperationHarness): Promise<FileOpenRequest> {
  emitEvent(channel, publishedReportEvent());
  await expect.element(screen.getByText("report.txt", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Download", exact: true }).click();
  await expect.poll(() => channel.frames.filter(frame => frame.type === "file_open").length).toBe(1);
  const request = channel.frames.findLast((frame): frame is FileOpenRequest => frame.type === "file_open")!;
  expect(request).toMatchObject({ channel_id: channel.channelId, session_id: "session-1", publication_id: "published-report" });
  return request;
}

function publishedReportOpened(request: FileOpenRequest) {
  const frame = {
    protocol_version: 2 as const, type: "file_opened" as const, target_channel_id: request.channel_id,
    in_reply_to: request.id, session_id: request.session_id, publication_id: request.publication_id,
    transfer_id: `transfer-${request.id}`, file_name: "report.txt", mime_type: "text/plain",
    byte_length: publishedReportBytes.byteLength, preview: { kind: "text" as const },
  };
  expect(fileOpenedFrameSchema.safeParse(frame).success).toBe(true);
  return frame;
}

async function acceptPublishedReportOpen(channel: OperationHarness["channel"], request: FileOpenRequest): Promise<FileReadRequest> {
  const opened = publishedReportOpened(request);
  channel.emit(opened);
  await expect.poll(() => channel.frames.some(frame => frame.type === "file_read" && frame.transfer_id === opened.transfer_id)).toBe(true);
  return channel.frames.findLast((frame): frame is FileReadRequest => frame.type === "file_read" && frame.transfer_id === opened.transfer_id)!;
}

async function completePublishedReport(context: OperationHarness) {
  const request = await beginPublishedReport(context);
  const read = await acceptPublishedReportOpen(context.channel, request);
  const digest = await crypto.subtle.digest("SHA-256", publishedReportBytes);
  const chunk = {
    protocol_version: 2 as const, type: "file_chunk" as const, target_channel_id: read.channel_id,
    in_reply_to: read.id, session_id: read.session_id, transfer_id: read.transfer_id, offset: read.offset,
    data_base64: encodeBase64(publishedReportBytes), final: true as const, total_bytes: publishedReportBytes.byteLength,
    sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
  };
  expect(fileChunkFrameSchema.safeParse(chunk).success).toBe(true);
  context.channel.emit(chunk);
  await expect.element(context.screen.getByRole("link", { name: "Save file", exact: true })).toBeVisible();
  return context.screen.getByRole("link", { name: "Save file", exact: true }).element().getAttribute("href")!;
}

test("published files: nearby images automatically fetch one at a time without losing the deferred image", async () => {
  await page.viewport(1280, 1800);
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII="), char => char.charCodeAt(0));
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  try {
    for (const [index, id] of ["near-image-a", "near-image-b"].entries()) emitEvent(channel, {
      ...publishedReportEvent(id), event_seq: index + 1,
      payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: `${id}.png`, mime_type: "image/png", byte_length: bytes.byteLength, tool_call_id: id } },
    });
    for (let index = 0; index < 2; index++) {
      await expect.poll(() => channel.frames.filter(frame => frame.type === "file_open").length, { timeout: 5000 }).toBe(index + 1);
      const request = channel.frames.findLast((frame): frame is FileOpenRequest => frame.type === "file_open")!;
      const opened = { protocol_version: 2 as const, type: "file_opened" as const, target_channel_id: request.channel_id, in_reply_to: request.id,
        session_id: request.session_id, publication_id: request.publication_id, transfer_id: `transfer-${request.id}`,
        file_name: `${request.publication_id}.png`, mime_type: "image/png", byte_length: bytes.byteLength, preview: { kind: "image" as const, width: 1, height: 1 } };
      channel.emit(opened);
      await expect.poll(() => channel.frames.some(frame => frame.type === "file_read" && frame.transfer_id === opened.transfer_id), { timeout: 5000 }).toBe(true);
      const read = channel.frames.findLast((frame): frame is FileReadRequest => frame.type === "file_read" && frame.transfer_id === opened.transfer_id)!;
      channel.emit({ protocol_version: 2, type: "file_chunk", target_channel_id: read.channel_id, in_reply_to: read.id, session_id: read.session_id,
        transfer_id: read.transfer_id, offset: 0, data_base64: encodeBase64(bytes), final: true, total_bytes: bytes.byteLength, sha256 });
    }
    await expect.poll(() => document.querySelectorAll('.pwa-published-file a[download]').length, { timeout: 5000 }).toBe(2);
    expect(channel.frames.filter(frame => frame.type === "file_open")).toHaveLength(2);
    await expect.element(screen.getByRole("img", { name: "near-image-b.png", exact: true })).toBeVisible();
  } finally { await screen.unmount(); }
});

test.each(["opening", "reading"] as const)("published files: history confirms %s, stays active and rejects late replies after switching", async phase => {
  await seedArchivedSession();
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { channel, screen } = context;
  try {
    const request = await beginPublishedReport(context);
    const read = phase === "reading" ? await acceptPublishedReportOpen(channel, request) : undefined;
    await expect.poll(() => document.querySelector<HTMLButtonElement>(".pwa-history-row")).not.toBeNull();
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await expect.element(screen.getByRole("heading", { name: "Cancel file fetching?", exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Stay", exact: true }).click();
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    expect(channel.frames.some(frame => frame.type === "file_close")).toBe(false);
    expect(channel.closeCalls).toBe(0);
    if (read) {
      const chunk = { protocol_version: 2 as const, type: "file_chunk" as const, target_channel_id: read.channel_id, in_reply_to: read.id,
        session_id: read.session_id, transfer_id: read.transfer_id, offset: 0, data_base64: encodeBase64(publishedReportBytes.slice(0, 4)), final: false as const };
      expect(fileChunkFrameSchema.safeParse(chunk).success).toBe(true);
      channel.emit(chunk);
      await expect.poll(() => channel.frames.filter(frame => frame.type === "file_read").length).toBe(2);
      expect(channel.frames.findLast(frame => frame.type === "file_read")).toMatchObject({ offset: 4, transfer_id: read.transfer_id });
    }
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await screen.getByRole("button", { name: "Cancel and switch", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Archived note", exact: true })).toBeVisible();
    const readCount = channel.frames.filter(frame => frame.type === "file_read").length;
    channel.emit(publishedReportOpened(request));
    await flushMicrotasks();
    expect(channel.frames.filter(frame => frame.type === "file_read")).toHaveLength(readCount);
    expect(document.querySelector(".pwa-published-file")).toBeNull();
    if (read) expect(channel.frames.filter(frame => frame.type === "file_close")).toEqual([expect.objectContaining({ transfer_id: read.transfer_id })]);
    await screen.getByRole("button", { name: "Back to live session", exact: true }).click();
    await expect.poll(() => channelHarness.channels.length).toBe(2);
    const resumed = channelHarness.channels[1]!;
    resumed.emit(readyFrame(resumed, "session-1", 1));
    await expect.element(screen.getByText("report.txt", { exact: true })).toBeVisible();
    expect(resumed.frames.some(frame => frame.type === "file_open" || frame.type === "file_read")).toBe(false);
    expect(screen.getByRole("link", { name: "Save file", exact: true }).query()).toBeNull();
  } finally { await screen.unmount(); }
});

test("published files: upload and fetching share one mixed leave confirmation", async () => {
  await seedArchivedSession();
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { channel, screen } = context;
  try {
    const request = await beginPublishedReport(context);
    const read = await acceptPublishedReportOpen(channel, request);
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Keep the original upload draft");
    pasteAttachments(input.element(), new File(["upload body"], "mixed-upload.txt", { type: "text/plain" }));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    await expect.poll(() => document.querySelector<HTMLButtonElement>(".pwa-history-row")).not.toBeNull();
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await expect.element(screen.getByRole("heading", { name: "Stop file transfers?", exact: true })).toBeVisible();
    expect(document.querySelectorAll('.pwa-confirm-dialog[role="dialog"]')).toHaveLength(1);
    await screen.getByRole("button", { name: "Stay", exact: true }).click();
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    expect(channel.frames.some(frame => frame.type === "attachment_cancel" || frame.type === "file_close")).toBe(false);
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-history-row")!);
    await screen.getByRole("button", { name: "Cancel and switch", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Archived note", exact: true })).toBeVisible();
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    expect(channel.frames.filter(frame => frame.type === "attachment_cancel")).toHaveLength(1);
    expect(channel.frames.filter(frame => frame.type === "file_close")).toEqual([expect.objectContaining({ transfer_id: read.transfer_id })]);
    channelHarness.finishReplies[0]?.();
    channel.emit(publishedReportOpened(request));
    await flushMicrotasks();
    expect(channel.frames.some(frame => frame.type === "user_message")).toBe(false);
    await screen.getByRole("button", { name: "Back to live session", exact: true }).click();
    await expect.poll(() => channelHarness.channels.length).toBe(2);
    channelHarness.channels[1]!.emit(readyFrame(channelHarness.channels[1]!, "session-1", 1));
    await expect.element(screen.getByPlaceholder("Message your agent…")).toHaveValue("Keep the original upload draft");
  } finally { await screen.unmount(); }
});

test("published files: current computer, current Pi and settings do not cancel fetching", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  try {
    const request = await beginPublishedReport(context);
    await acceptPublishedReportOpen(channel, request);
    await screen.getByRole("button", { name: "Choose computer, current test-host" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
    await page.elementLocator(document.querySelector(".pwa-computer-select")!).click();
    await expect.poll(() => document.querySelector(".pwa-device-panel")).toBeNull();
    await page.elementLocator(document.querySelector('.pwa-nav-session[aria-current="true"]')!).click();
    await screen.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect.element(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    expect(document.querySelector(".pwa-confirm-dialog")).toBeNull();
    expect(channel.frames.some(frame => frame.type === "file_close")).toBe(false);
    expect(channel.closeCalls).toBe(0);
    expect(channelHarness.channels).toHaveLength(1);
    await screen.getByRole("button", { name: "Back to workspace", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    expect(channel.frames.filter(frame => frame.type === "file_open")).toHaveLength(1);
  } finally { window.history.replaceState(null, "", "/app"); await screen.unmount(); }
});

test("published files: verified ready result survives a short disconnect without an automatic download", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
  try {
    const url = await completePublishedReport(context);
    expect(url).toMatch(/^blob:/);
    expect(await (await fetch(url)).text()).toBe(new TextDecoder().decode(publishedReportBytes));
    expect(anchorClick).not.toHaveBeenCalled();
    const save = screen.getByRole("link", { name: "Save file", exact: true });
    expect(save.element().getAttribute("download")).toBe("report.txt");
    relayHarness.instances[0]!.emitState("closed");
    await expect.poll(() => screen.getByLabelText("Connected", { exact: true }).query()).toBeNull();
    await expect.element(save).toBeVisible();
    expect(save.element().getAttribute("href")).toBe(url);
    await screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "report.txt", exact: true })).toBeVisible();
    await expect.element(screen.getByText("Complete published report", { exact: true })).toBeVisible();
    expect(channel.frames.filter(frame => frame.type === "file_open")).toHaveLength(1);
    expect(channel.frames.filter(frame => frame.type === "file_read")).toHaveLength(1);
    expect(anchorClick).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Close file reader", exact: true }).click();
    await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
    const relay = relayHarness.instances[0]!;
    relay.emitState("open");
    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [{ endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" } }] });
    await expect.poll(() => channelHarness.channels.length).toBe(2);
    const resumed = channelHarness.channels[1]!;
    resumed.emit(readyFrame(resumed, "session-1", 1));
    await expect.element(screen.getByLabelText("Connected", { exact: true })).toBeVisible();
    await expect.element(save).toBeVisible();
    expect(save.element().getAttribute("href")).toBe(url);
    expect(resumed.frames.some(frame => frame.type === "file_open" || frame.type === "file_read")).toBe(false);
    expect(anchorClick).not.toHaveBeenCalled();
  } finally { anchorClick.mockRestore(); await screen.unmount(); }
});

test("published files: a rejected new-session action preserves the verified result until actual replacement", async () => {
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen, channel } = context;
  try {
    const url = await completePublishedReport(context);
    const request = await issueOperation(context, "session_new");
    replyOperation(channel, request);
    await expect.element(screen.getByText("Could not start a new session. Try again.", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Save file", exact: true })).toBeVisible();
    expect(screen.getByRole("link", { name: "Save file", exact: true }).element().getAttribute("href")).toBe(url);
    await screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(screen.getByText("Complete published report", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Close file reader", exact: true }).click();
    await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
    expect(channel.frames.filter(frame => frame.type === "file_open")).toHaveLength(1);
    channel.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "session_replaced" });
    await expect.poll(() => channelHarness.channels.length).toBe(2);
    channelHarness.channels[1]!.emit(readyFrame(channelHarness.channels[1]!, "session-2"));
    await expect.element(screen.getByText("Send a message to Pi to begin.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Save file", exact: true }).query()).toBeNull();
    expect(document.querySelector(".pwa-published-file")).toBeNull();
  } finally { await screen.unmount(); }
});

function partialFrame(partialId: string, groupId: string, delta: string) {
  return {
    protocol_version: 2 as const,
    type: "timeline_partial" as const,
    session_id: "session-1",
    leaf_id: "generation-session-1",
    group_id: groupId,
    partial_id: `${partialId}:assistant:0`,
    kind: "assistant" as const,
    status: "delta" as const,
    delta,
  };
}

function longAssistantEvents(sessionId: string, leafId: string, marker: string): TimelineEvent[] {
  const transcript = Array.from({ length: 220 }, (_, index) => `Transcript line ${index + 1}: ${"remote timeline output ".repeat(8)}`).join("\n");
  return [
    {
      event_id: `${marker}-body`, event_seq: 1,
      session_id: sessionId,
      leaf_id: leafId,
      timestamp: 1,
      group_id: `${marker}-body`,
      kind: "assistant",
      status: "complete",
      blocks: [{ type: "text", text: transcript }],
    },
    {
      event_id: `${marker}-latest`, event_seq: 2,
      session_id: sessionId,
      leaf_id: leafId,
      timestamp: 2,
      group_id: `${marker}-latest`,
      kind: "assistant",
      status: "complete",
      blocks: [{ type: "text", text: marker }],
    },
  ];
}

async function seedTimeline(events: TimelineEvent[]) {
  if (events.length === 0) return;
  await mergeTimelineEvents({
    deviceId: "owner-device-key",
    endpointId: "daemon-endpoint",
    sessionId: events[0]!.session_id,
    leafId: events[0]!.leaf_id,
  }, events);
}

function recentHistoryFrame(
  channel: { channelId: string; frames: ClientFrame[] },
  sessionId: string,
  events: TimelineEvent[],
) {
  return {
    protocol_version: 2 as const,
    type: "session_history_chunk" as const,
    target_channel_id: channel.channelId,
    in_reply_to: channel.frames.findLast((frame) => frame.type === "session_sync")?.id ?? "missing-history-request",
    session_id: sessionId,
    leaf_id: `generation-${sessionId}`,
    chunk_index: 0,
    events,
    fragments: [],
    final_chunk: true,
    ...(events.length && events[0].event_seq! > 1 ? { eos: false, next_before: events[0].event_seq } : { eos: true }),
  };
}

function numberedEvents(count: number, first = 1): TimelineEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    event_id: `event-${first + index}`, event_seq: first + index, session_id: "session-1", leaf_id: "generation-session-1",
    timestamp: first + index, group_id: `group-${first + index}`, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Record ${first + index}` }],
  }));
}
function emitEvent(channel: { emit: (frame: unknown) => void }, event: TimelineEvent) {
  channel.emit({ protocol_version: 2, type: "timeline_event", session_id: event.session_id, leaf_id: event.leaf_id, event });
}

async function timelineTextElement(list: HTMLDivElement, text: string): Promise<HTMLElement> {
  await expect.poll(() => [...list.querySelectorAll<HTMLElement>("p")].some((element) => element.textContent === text)).toBe(true);
  const element = [...list.querySelectorAll<HTMLElement>("p")].find((candidate) => candidate.textContent === text);
  if (!element) throw new Error(`Expected timeline text: ${text}`);
  return element;
}

async function expectTimelineAtBottom(list: HTMLDivElement, latest: HTMLElement) {
  await expect.poll(() => list.scrollHeight > list.clientHeight).toBe(true);
  await expect.poll(() => list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
  await expect.poll(() => {
    const listBounds = list.getBoundingClientRect();
    const latestBounds = latest.getBoundingClientRect();
    return latestBounds.top >= listBounds.top - 1 && latestBounds.bottom <= listBounds.bottom + 1;
  }).toBe(true);
}

test("ignores stale timeline frames before persistence, history merging, and unread tracking", async () => {
  const { channel, list, screen, scrollTo } = await renderReadyTimeline();
  const db = await openPwaDatabase();
  list.scrollTop = 500;
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.element(screen.getByRole("button", { name: "Latest" })).toBeVisible();
  const event = { event_id: "stale-event", event_seq: 1, kind: "assistant", session_id: "session-1", leaf_id: "stale-generation", group_id: "stale-group", timestamp: Date.now(), status: "complete", blocks: [{ type: "text", text: "stale output" }] };
  // 真实故障的外层 scope 正确，但 inner event 来自另一个历史代次。
  channel.emit({ protocol_version: 2, type: "timeline_event", session_id: "session-1", leaf_id: "generation-session-1", event });
  channel.emit({ protocol_version: 2, type: "timeline_event", session_id: "old-session", leaf_id: "old-generation", event: { ...event, session_id: "session-1", leaf_id: "generation-session-1" } });
  channel.emit({ ...partialFrame("stale-partial", "stale-group", "stale partial"), leaf_id: "stale-generation" });
  await flushMicrotasks();
  await expect.element(screen.getByText("Could not update local history.", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /new output/ })).not.toBeInTheDocument();
  expect(await db.events.count()).toBe(0);
  expect(scrollTo).not.toHaveBeenCalled();
  const historyRequest = channel.frames.find((frame) => frame.type === "session_sync");
  channel.emit({ protocol_version: 2, type: "session_history_chunk", target_channel_id: channel.channelId, in_reply_to: historyRequest?.id, session_id: "session-1", leaf_id: "generation-session-1", chunk_index: 0, final: true, events: [], eos: true });
  await flushMicrotasks();
  await expect.element(screen.getByText("Could not update local history.", { exact: true })).not.toBeInTheDocument();
  expect(await db.events.count()).toBe(0);

  channel.emit({ protocol_version: 2, type: "timeline_event", session_id: "session-1", leaf_id: "generation-session-1", event: { ...event, event_id: "current-event", leaf_id: "generation-session-1", blocks: [{ type: "text", text: "current output" }] } });
  await vi.waitFor(async () => expect(await db.events.count()).toBe(1));
  await expect.element(screen.getByText("current output", { exact: true }).last()).toBeVisible();
  await screen.unmount();
});

test("shows Latest after scrolling away and preserves position while unread realtime output arrives", async () => {
  const { channel, list, screen, scrollTo } = await renderReadyTimeline();
  list.scrollTop = 500;
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.element(screen.getByRole("button", { name: "Latest" })).toBeVisible();

  channel.emit(partialFrame("partial-1", "group-1", "first"));
  channel.emit(partialFrame("partial-1", "group-1", " second"));
  await expect.element(screen.getByRole("button", { name: "1 new output" })).toBeVisible();
  expect(scrollTo).not.toHaveBeenCalled();

  scrollTo.mockImplementation((options: ScrollToOptions) => {
    list.scrollTop = options.behavior === "smooth" ? 500 : list.scrollHeight - list.clientHeight;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await screen.getByRole("button", { name: "1 new output" }).click();
  expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  await expect.element(screen.getByRole("button", { name: "Latest" })).not.toBeInTheDocument();

  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1100 });
  channel.emit(partialFrame("partial-2", "group-2", "during smooth scroll"));
  await expect.element(screen.getByText("during smooth scroll")).toBeVisible();
  expect(scrollTo).toHaveBeenCalledTimes(1);
  // 模拟 Latest 抵达原目标，随后跟随期间新增的高度。
  list.scrollTop = 600;
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "auto" });
  await expect.element(screen.getByRole("button", { name: /new output/ })).not.toBeInTheDocument();
  await screen.unmount();
});

test("follows realtime output at the bottom without showing Latest", async () => {
  const { channel, list, screen, scrollTo } = await renderReadyTimeline();

  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1100 });
  channel.emit(partialFrame("partial-1", "group-1", "first"));
  await expect.poll(() => scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "auto" });
  await expect.element(screen.getByRole("button", { name: "Latest" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /new output/ })).not.toBeInTheDocument();
  await screen.unmount();
});

test.each([
  { headSeq: 0, expected: 0, first: null, hasEarlier: false },
  { headSeq: 30, expected: 30, first: "Record 1", hasEarlier: false },
  { headSeq: 31, expected: 30, first: "Record 2", hasEarlier: true },
])("automatically opens the recent numbered window at head $headSeq", async ({ headSeq, expected, first, hasEarlier }) => {
  await seedTimeline(numberedEvents(headSeq));
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const channel = channelHarness.channels[0];
    channel.emit(readyFrame(channel, "session-1", headSeq));
    await expect.poll(() => document.querySelectorAll(".pwa-message-list article").length).toBe(expected);
    expect(channel.frames.some((frame) => frame.type === "session_sync")).toBe(false);
    expect(vi.mocked(loadTimeline)).toHaveBeenCalledTimes(headSeq === 0 ? 0 : 1);
    if (first) await expect.element(screen.getByText(first, { exact: true }).first()).toBeVisible();
    if (hasEarlier) await expect.element(screen.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
    else await expect.element(screen.getByRole("button", { name: "Load more", exact: true })).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});

test("keeps a scrolled-back reader in place when live content changes", async () => {
  await page.viewport(390, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const channel = channelHarness.channels[0];
    if (!channel) throw new Error("Expected a session channel.");
    channel.emit(readyFrame(channel, "session-1"));
    const list = document.querySelector<HTMLDivElement>(".pwa-message-list");
    if (!list) throw new Error("Expected the message list.");
    const initialMarker = "Initial scroll position output";
    for (const event of longAssistantEvents("session-1", "generation-session-1", initialMarker)) emitEvent(channel, event);
    const latest = await timelineTextElement(list, initialMarker);
    await expectTimelineAtBottom(list, latest);

    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    await expect.element(screen.getByRole("button", { name: "Latest" })).toBeVisible();
    const beforeUpdate = list.scrollTop;
    const marker = "Live output while reading earlier history";
    channel.emit({
      protocol_version: 2,
      type: "timeline_event",
      session_id: "session-1",
      leaf_id: "generation-session-1",
      event: {
        event_id: "reader-position-event", event_seq: 3,
        session_id: "session-1",
        leaf_id: "generation-session-1",
        timestamp: 3,
        group_id: "reader-position-group",
        kind: "assistant",
        status: "complete",
        blocks: [{ type: "text", text: marker }],
      },
    });
    await timelineTextElement(list, marker);
    expect(list.scrollTop).toBe(beforeUpdate);
    await expect.element(screen.getByRole("button", { name: "1 new output" })).toBeVisible();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("reconnecting keeps a small-gap live view mounted and catches up in place", async () => {
  await page.viewport(390, 844);
  await seedTimeline(numberedEvents(80));
  const screen = await renderOnlineApp(renderWorkspaceApp);
  let fakeTimers = false;
  try {
    const relay = relayHarness.instances[0];
    const firstChannel = channelHarness.channels[0];
    if (!relay || !firstChannel) throw new Error("Expected an initial Relay and session channel.");
    firstChannel.emit(readyFrame(firstChannel, "session-1", 80));
    await expect.poll(() => document.querySelectorAll(".pwa-message-list article").length).toBe(30);
    emitEvent(firstChannel, numberedEvents(1, 81)[0]);
    await expect.poll(() => document.querySelectorAll(".pwa-message-list article").length).toBe(31);
    const listBeforeReconnect = document.querySelector(".pwa-message-list");
    await vi.waitFor(async () => expect(await (await openPwaDatabase()).events.count()).toBe(81));

    vi.useFakeTimers();
    fakeTimers = true;
    relay.emitState("closed");
    await flushMicrotasks();
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    relay.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [{
        endpoint_id: "daemon-endpoint",
        runtime_instance_id: "runtime-1",
        metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" },
      }],
    });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    vi.useRealTimers();
    fakeTimers = false;

    const resumedChannel = channelHarness.channels[1];
    if (!resumedChannel) throw new Error("Expected the reconnected session channel.");
    expect(document.querySelector(".pwa-message-list")).toBe(listBeforeReconnect);
    resumedChannel.emit(readyFrame(resumedChannel, "session-1", 81));
    await expect.poll(() => document.querySelectorAll(".pwa-message-list article").length).toBe(31);
    expect(document.querySelector(".pwa-message-list")).toBe(listBeforeReconnect);
    expect(resumedChannel.frames.some((frame) => frame.type === "session_sync")).toBe(false);
    emitEvent(resumedChannel, numberedEvents(1, 82)[0]);
    await expect.poll(() => document.querySelectorAll(".pwa-message-list article").length).toBe(32);
    const contents = document.querySelector(".pwa-message-list")!.textContent;
    expect(contents).toContain("Record 51");
    expect(contents).toContain("Record 82");
    expect(await (await openPwaDatabase()).events.count()).toBe(82);
  } finally {
    if (fakeTimers) vi.useRealTimers();
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test.each([[1280, 900], [390, 844]])("fills recent and earlier missing ranges without overlapping loads at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const all = numberedEvents(160);
  await seedTimeline(all.filter((event) => ![81, 115, 159, 160].includes(event.event_seq!)));
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const channel = channelHarness.channels[0];
    channel.emit(readyFrame(channel, "session-1", 160));
    emitEvent(channel, numberedEvents(1, 161)[0]);
    const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
    await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "session_sync")).toHaveLength(1));
    const recentRequest = channel.frames.find((frame): frame is Extract<ClientFrame, { type: "session_sync" }> => frame.type === "session_sync")!;
    expect([recentRequest.before, recentRequest.limit]).toEqual([161, 2]);
    channel.emit(recentHistoryFrame(channel, "session-1", numberedEvents(2, 159)));
    await expect.poll(() => list.querySelectorAll("article").length).toBe(31);
    const live = await timelineTextElement(list, "Record 161");
    const button = screen.getByRole("button", { name: "Load more", exact: true });
    button.element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const expected of [[82, 1], [116, 1]] as const) {
      await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "session_sync")).toHaveLength(expected[0] === 82 ? 2 : 3));
      const request = channel.frames.filter((frame): frame is Extract<ClientFrame, { type: "session_sync" }> => frame.type === "session_sync").at(-1)!;
      expect([request.before, request.limit]).toEqual(expected);
      channel.emit(recentHistoryFrame(channel, "session-1", all.filter((event) => event.event_seq! < request.before! && event.event_seq! >= request.before! - request.limit!)));
    }
    await expect.poll(() => list.querySelectorAll("article").length).toBe(111);
    await expect.poll(() => live.getBoundingClientRect().bottom).toBeGreaterThan(list.getBoundingClientRect().top);
    await button.click();
    await expect.poll(() => list.querySelectorAll("article").length).toBe(161);
    expect(channel.frames.filter((frame) => frame.type === "session_sync")).toHaveLength(3);
    await expect.element(button).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});

test("a failed recent-window request releases loading and retries the same range", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const channel = channelHarness.channels[0];
    channel.emit(readyFrame(channel, "session-1", 80));
    await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "session_sync")).toHaveLength(1));
    const first = channel.frames.find((frame) => frame.type === "session_sync")!;
    channel.emit({ protocol_version: 2, type: "protocol_error", target_channel_id: channel.channelId, in_reply_to: first.id, code: "internal_error", message: "History unavailable" });
    await expect.element(screen.getByRole("button", { name: "Load more", exact: true })).toBeEnabled();
    expect(document.querySelectorAll(".pwa-message-list article")).toHaveLength(0);
    await expect.element(screen.getByText("Could not load the conversation. Try again.")).toBeVisible();
    await screen.getByRole("button", { name: "Load more", exact: true }).click();
    await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "session_sync")).toHaveLength(2));
    const requests = channel.frames.filter((frame) => frame.type === "session_sync");
    expect(requests.map((frame) => [frame.before, frame.limit])).toEqual([[81, 30], [81, 30]]);
    channel.emit(recentHistoryFrame(channel, "session-1", numberedEvents(30, 51)));
    await expect.poll(() => document.querySelectorAll(".pwa-message-list article").length).toBe(30);
  } finally { await screen.unmount(); }
});

test("waits for the endpoint after Owner Relay recovery before rebuilding the stable channel", async () => {
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  expect(relay).toBeDefined();
  const initialCalls = relay?.connectCalls ?? 0;
  vi.useFakeTimers();
  try {
    relay?.emitState("closed");
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(initialCalls);
    expect(channelHarness.channels).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(relay?.connectCalls).toBe(initialCalls);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(initialCalls + 1);
    expect(relay?.subscriptions.at(-1)).toEqual(["owner-device-key"]);
    expect(channelHarness.channels).toHaveLength(1);

    relay?.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [{
        endpoint_id: "daemon-endpoint",
        runtime_instance_id: "runtime-1",
        metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" },
      }],
    });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    expect(channelHarness.channels[1]?.channelId).toBe(channelHarness.channels[0]?.channelId);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("manual retry skips backoff and synchronously rejects a double submit", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const relay = relayHarness.instances[0];
  const channel = channelHarness.channels[0];
  if (!relay || !channel) throw new Error("Expected the connected Relay and session channel.");
  channel.emit(readyFrame(channel, "session-1"));
  vi.useFakeTimers();
  try {
    const initialCalls = relay.connectCalls;
    relay.emitState("closed");
    await flushMicrotasks();
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeEnabled();
    const button = retry.element();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(relay.connectCalls).toBe(initialCalls + 1);
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(relay.connectCalls).toBe(initialCalls + 1);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("keeps Relay feedback aligned until the recovered live session is ready", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  let fakeTimers = false;
  try {
    const relay = relayHarness.instances[0];
    const initialChannel = channelHarness.channels[0];
    if (!relay || !initialChannel) throw new Error("Expected an initial Relay and session channel.");
    initialChannel.emit(readyFrame(initialChannel, "session-1"));
    await flushMicrotasks();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();

    vi.useFakeTimers();
    fakeTimers = true;
    relay.emitError(new Error());
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).toBeVisible();
    await expect.element(screen.getByLabelText("Reconnecting…")).toBeVisible();
    await expect.element(screen.getByLabelText("Connected")).not.toBeInTheDocument();
    expect(document.querySelector(".pwa-toast")).toBeNull();

    relay.emitState("closed");
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();
    relay.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [{
        endpoint_id: "daemon-endpoint",
        runtime_instance_id: "runtime-1",
        metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" },
      }],
    });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const recoveredChannel = channelHarness.channels[1];
    if (!recoveredChannel) throw new Error("Expected a recovered session channel.");

    initialChannel.emit(readyFrame(initialChannel, "stale-session"));
    await flushMicrotasks();
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).toBeVisible();

    recoveredChannel.emit({
      ...readyFrame(recoveredChannel, "session-2"),
      in_reply_to: "stale-session-hello",
    });
    await flushMicrotasks();
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).toBeVisible();

    recoveredChannel.emit(readyFrame(recoveredChannel, "session-2"));
    await flushMicrotasks();
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();
    // 提示条出现过，恢复后以 Toast 提示一次「连接已恢复」。
    await expect.element(screen.getByText("Connection restored", { exact: true })).toBeVisible();
  } finally {
    if (fakeTimers) vi.useRealTimers();
    await screen.unmount();
  }
});

test("changes network feedback to reconnecting when the browser returns online", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const relay = relayHarness.instances[0];
    const initialChannel = channelHarness.channels[0];
    if (!relay || !initialChannel) throw new Error("Expected an initial Relay and session channel.");
    initialChannel.emit(readyFrame(initialChannel, "session-1"));
    await flushMicrotasks();

    window.dispatchEvent(new Event("offline"));
    await expect.element(screen.getByText("Network unavailable. Check your connection.", { exact: true })).toBeVisible();
    await expect.element(screen.getByLabelText("No network")).toBeVisible();

    window.dispatchEvent(new Event("online"));
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Network unavailable. Check your connection.", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("No network")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

test("counts error and close from one Owner Relay failure as one retry", async () => {
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  expect(relay).toBeDefined();
  vi.useFakeTimers();
  try {
    relay?.emitError(new Error("socket error"));
    relay?.emitState("closed");
    await flushMicrotasks();
    vi.advanceTimersByTime(999);
    expect(relay?.connectCalls).toBe(1);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(2);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("shows readable connection feedback when the Owner Relay rejects a connection", async () => {
  relayHarness.nextConnectRejects = 1;
  const screen = await renderPwa(<PwaApp />);
  try {
    await vi.waitFor(() => expect(relayHarness.instances[0]?.connectCalls).toBe(1));
    relayHarness.rejectConnect?.(new Error("connect rejected"));
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("connect rejected", { exact: true })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

test("backs off a rejected Owner Relay connection and cleanup cancels recovery", async () => {
  relayHarness.nextConnectRejects = 1;
  const screen = await renderPwa(<PwaApp />);
  await vi.waitFor(() => expect(relayHarness.instances[0]?.connectCalls).toBe(1));
  await flushMicrotasks();
  const relay = relayHarness.instances[0];
  expect(relay?.connectCalls).toBe(1);
  vi.useFakeTimers();
  try {
    relayHarness.rejectConnect?.(new Error("connect rejected"));
    await flushMicrotasks();
    vi.advanceTimersByTime(999);
    expect(relay?.connectCalls).toBe(1);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(2);
    const callsAfterRecovery = relay?.connectCalls ?? 0;
    await screen.unmount();
    relay?.emitState("closed");
    vi.advanceTimersByTime(30_000);
    expect(relay?.connectCalls).toBe(callsAfterRecovery);
  } finally {
    vi.useRealTimers();
  }
});

test("does not reconnect after a session channel failure closes Relay intentionally", async () => {
  channelHarness.nextSendResults.push(false);
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  expect(relay?.connectCalls).toBe(1);
  vi.useFakeTimers();
  try {
    await expect.element(screen.getByText("Loading…", { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText("Test Pi", { exact: true })).not.toBeInTheDocument();
    vi.advanceTimersByTime(30_000);
    expect(relay?.connectCalls).toBe(1);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("routes session actions through the live channel with current model and thinking context", async () => {
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const model = { id: "test-sonnet", provider: "anthropic", name: "Test Sonnet", reasoning: true, context_window: 200_000, vision: true };
    const initialModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: initialModelRequest?.id, models: [model], current: model });

    const actions = screen.getByRole("button", { name: "Session actions" });
    await actions.click();
    expect(channel.frames.filter((frame) => frame.type === "list_models")).toHaveLength(2);
    await screen.getByRole("menuitem", { name: "Compact context" }).click();
    await vi.waitFor(() => expect(channel.frames.at(-1)).toMatchObject({ type: "session_compact", leaf_id: "generation-session-1" }));
    const compact = channel.frames.at(-1);
    channel.emit({ protocol_version: 2, type: "action_ok", target_channel_id: channel.channelId, in_reply_to: compact?.id, action: "session_compact" });

    // 模型从输入区的模型标签进入，思考级别从「/」菜单进入；会话菜单不再重复这两项。
    await screen.getByRole("button", { name: /^Change model, current Test Sonnet/ }).click();
    await screen.getByRole("menuitem", { name: /anthropic \/ Test Sonnet/ }).click();
    await vi.waitFor(() => expect(channel.frames.at(-1)).toMatchObject({ type: "model_set", provider: "anthropic", model_id: "test-sonnet" }));
    const modelSet = channel.frames.at(-1);
    channel.emit({ protocol_version: 2, type: "action_ok", target_channel_id: channel.channelId, in_reply_to: modelSet?.id, action: "model_set" });

    await screen.getByRole("button", { name: "Pi commands" }).click();
    await screen.getByRole("menuitem", { name: /\/thinking/ }).click();
    await screen.getByRole("menuitem", { name: "high", exact: true }).click();
    await vi.waitFor(() => expect(channel.frames.at(-1)).toMatchObject({ type: "thinking_set", level: "high" }));
  } finally {
    await screen.unmount();
  }
});

test("keeps attachment capability independent of switching to a vision model", async () => {
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const textOnlyModel = { id: "text-model", provider: "test", name: "Text model", reasoning: false, context_window: 200_000, vision: false };
    const visionModel = { id: "vision-model", provider: "test", name: "Vision model", reasoning: false, context_window: 200_000, vision: true };
    const initialModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: initialModelRequest?.id, models: [textOnlyModel, visionModel], current: textOnlyModel });

    const addImage = screen.getByRole("button", { name: "Add attachments" });
    await expect.element(addImage).toBeEnabled();
    await screen.getByRole("button", { name: /^Change model, current Text model/ }).click();
    await screen.getByRole("menuitem", { name: /test \/ Vision model/ }).click();
    await vi.waitFor(() => expect(channel.frames.at(-1)).toMatchObject({ type: "model_set", provider: "test", model_id: "vision-model" }));
    const modelSet = channel.frames.at(-1);
    await expect.element(addImage).toBeEnabled();

    channel.emit({ protocol_version: 2, type: "action_ok", target_channel_id: channel.channelId, in_reply_to: modelSet?.id, action: "model_set" });
    await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "list_models")).toHaveLength(3));
    const refreshedModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    const staleModelRequest = channel.frames.filter((frame) => frame.type === "list_models").at(-2);
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: staleModelRequest?.id, models: [textOnlyModel, visionModel], current: textOnlyModel });
    await expect.element(addImage).toBeEnabled();
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: refreshedModelRequest?.id, models: [textOnlyModel, visionModel], current: visionModel });
    await expect.element(addImage).toBeEnabled();
  } finally {
    await screen.unmount();
  }
});

test("keeps attachment capability independent of external endpoint model updates", async () => {
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const textOnlyModel = { id: "text-model", provider: "test", name: "Text model", reasoning: false, context_window: 200_000, vision: false };
    const visionModel = { id: "vision-model", provider: "test", name: "Vision model", reasoning: false, context_window: 200_000, vision: true };
    const initialModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: initialModelRequest?.id, models: [textOnlyModel, visionModel], current: textOnlyModel });

    const addImage = screen.getByRole("button", { name: "Add attachments" });
    await expect.element(addImage).toBeEnabled();
    relayHarness.instances[0]?.emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace", model: "vision-model" } });
    await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "list_models")).toHaveLength(2));
    expect(channelHarness.channels).toHaveLength(1);
    const refreshedModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: refreshedModelRequest?.id, models: [textOnlyModel, visionModel], current: visionModel });
    await expect.element(addImage).toBeEnabled();
  } finally {
    await screen.unmount();
  }
});

test("uses the endpoint model as a unique capability fallback when current is omitted", async () => {
  const { channel, screen } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const textOnlyModel = { id: "text-model", provider: "test", name: "Text model", reasoning: false, context_window: 200_000, vision: false };
    const visionModel = { id: "vision-model", provider: "test", name: "Vision model", reasoning: false, context_window: 200_000, vision: true };
    const initialModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: initialModelRequest?.id, models: [textOnlyModel, visionModel], current: textOnlyModel });

    const addImage = screen.getByRole("button", { name: "Add attachments" });
    await expect.element(addImage).toBeEnabled();
    relayHarness.instances[0]?.emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace", model: "vision-model" } });
    await vi.waitFor(() => expect(channel.frames.filter((frame) => frame.type === "list_models")).toHaveLength(2));
    const refreshedModelRequest = channel.frames.findLast((frame) => frame.type === "list_models");
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: refreshedModelRequest?.id, models: [textOnlyModel, visionModel] });
    await expect.element(addImage).toBeEnabled();
  } finally {
    await screen.unmount();
  }
});

test.each([
  [1280, "Session actions"], [390, "Session actions"],
  [1280, "Pi commands"], [390, "Pi commands"],
] as const)("closes commands before confirmation and restores the trigger at %ipx from %s", async (width, entry) => {
  await page.viewport(width, 844);
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    // 桌面空会话会异步聚焦输入框；先等初始化完成，避免它抢走菜单键盘操作的焦点。
    if (width === 1280) await expect.element(screen.getByRole("textbox", { name: /Message your agent/i })).toHaveFocus();
    const actions = screen.getByRole("button", { name: entry });
    await expect.element(actions).toBeEnabled();
    actions.element().focus();
    await expect.element(actions).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    const newSession = screen.getByRole("menuitem", { name: entry === "Pi commands" ? /\/new/ : "New session" });
    await expect.element(newSession).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const confirmation = screen.getByRole("dialog", { name: "Start a fresh session?" });
    await expect.element(confirmation).toBeVisible();
    await expect.element(screen.getByRole("menu", { name: entry })).not.toBeInTheDocument();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
    expect(confirmation.element().contains(document.activeElement)).toBe(true);
    expect(confirmation.element().closest(".pwa-root")).not.toBeNull();
    expect(channel.frames.filter((frame) => frame.type === "session_new")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    await expect.element(actions).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(newSession).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(actions).toHaveFocus();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("keeps saved history read-only through endpoint updates and returns to the same live Pi", async () => {
  await mergeTimelineEvents({ deviceId: "owner-device-key", endpointId: "daemon-endpoint", sessionId: "saved-session", leafId: "saved-generation" }, [{
    event_id: "saved-event",
    session_id: "saved-session",
    leaf_id: "saved-generation",
    timestamp: Date.now() - 60_000,
    group_id: "saved-group",
    kind: "assistant",
    blocks: [{ type: "text", text: "Saved session note" }],
    status: "complete",
  }]);
  await page.viewport(390, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    await screen.getByRole("button", { name: "Open navigation" }).click();
    const navigation = screen.getByRole("dialog", { name: /Workspace/ });
    await expect.element(navigation.getByText("Online Pi", { exact: true })).toBeVisible();
    await expect.element(navigation.getByText("Local history", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: "History" })).not.toBeInTheDocument();
    await navigation.getByRole("button", { name: /Saved session note/ }).click();
    await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
    // 移动顶栏在会话名上方标出「本地历史 · 只读」；输入区换为只读说明条，「更多」只含信息区。
    const historyTrigger = screen.getByRole("button", { name: "Open navigation" });
    await expect.element(historyTrigger).toHaveTextContent("Local history · Read only");
    await expect.element(historyTrigger).toHaveTextContent("Saved session note");
    await expect.element(screen.getByRole("note")).toHaveTextContent("This is a read-only record saved in this browser.");
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Session actions" }).click();
    await expect.element(screen.getByRole("group", { name: "Session details" })).toBeVisible();
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
    await userEvent.keyboard("{Escape}");

    relayHarness.instances[0]?.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [{
        endpoint_id: "daemon-endpoint",
        runtime_instance_id: "runtime-1",
        metadata: { kind: "interactive", name: "Renamed live Pi", cwd: "/workspace" },
      }],
    });
    await expect.element(screen.getByRole("button", { name: "Open navigation" })).toHaveTextContent("Saved session note");

    await screen.getByRole("button", { name: "Open navigation" }).click();
    await expect.element(navigation.getByText("Online Pi", { exact: true })).toBeVisible();
    await expect.element(navigation.getByText("Local history", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: "History" })).not.toBeInTheDocument();
    const originalChannel = channelHarness.channels[0];
    // 点击在线 Pi 即退出本地历史，回到同一个 Pi。
    await navigation.getByRole("button", { name: /Renamed live Pi/ }).click();
    await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    expect(channelHarness.channels[1]?.channelId).toBe(originalChannel?.channelId);
    await expect.element(screen.getByRole("button", { name: "Open navigation" })).toHaveTextContent("Renamed live Pi");
    await expect.element(screen.getByRole("textbox")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Session actions" })).toBeVisible();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("hides live connection feedback while reading local history", async () => {
  await seedTimeline([{
    event_id: "saved-offline-event", event_seq: 1, session_id: "saved-offline-session", leaf_id: "saved-offline-generation",
    timestamp: Date.now() - 60_000, group_id: "saved-offline-group", kind: "assistant", status: "complete",
    blocks: [{ type: "text", text: "Offline history note" }],
  }]);
  await page.viewport(390, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    window.dispatchEvent(new Event("offline"));
    await expect.element(screen.getByText("Network unavailable. Check your connection.", { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Open navigation" }).click();
    await screen.getByRole("button", { name: /Offline history note/ }).click();
    await expect.element(screen.getByRole("button", { name: "Open navigation" })).toHaveTextContent("Local history · Read only");
    await expect.element(screen.getByText("Network unavailable. Check your connection.", { exact: true })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("closes mobile navigation before opening the rename dialog", async () => {
  await page.viewport(390, 844);
  const screen = await renderOnlineApp();
  try {
    const navigationTrigger = screen.getByRole("button", { name: "Open navigation" });
    await navigationTrigger.click();
    await screen.getByRole("button", { name: "Choose computer, current test-host" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
    await screen.getByRole("button", { name: "Computer actions for test-host" }).click();
    await screen.getByRole("menuitem", { name: "Rename test-host" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Rename pairing" })).toBeVisible();
    expect(document.querySelector(".pwa-session-sheet")).toBeNull();
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(navigationTrigger).toHaveFocus();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("opens pairing above mobile navigation and restores focus after Escape", async () => {
  await page.viewport(390, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const navigationTrigger = screen.getByRole("button", { name: "Open navigation" });
    navigationTrigger.element().focus();
    await navigationTrigger.click();
    await screen.getByRole("button", { name: "Choose computer, current test-host" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
    const pairButton = screen.getByRole("dialog", { name: "Choose computer" }).getByRole("button", { name: "Pair a computer", exact: true });
    pairButton.element().focus();
    await pairButton.click();

    const pairingDialog = screen.getByRole("dialog", { name: "Pair a computer" });
    await expect.element(pairingDialog).toBeVisible();
    expect(document.querySelector(".pwa-session-sheet")).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(pairingDialog.element().closest(".pwa-root")).toBe(document.querySelector(".pwa-root"));
    expect(Number(getComputedStyle(pairingDialog.element().parentElement!).zIndex)).toBeGreaterThanOrEqual(300);

    await userEvent.keyboard("{Escape}");

    await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).toBeNull();
    await expect.element(navigationTrigger).toHaveFocus();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("preserves the session, draft, attachment, tool state and reader across layout breakpoints", async () => {
  const { channel, list, screen, scrollTo } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const relay = relayHarness.instances[0];
    const model = { id: "vision-model", provider: "test", name: "Vision model", reasoning: false, context_window: 200_000, vision: true };
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: channel.frames.find((frame) => frame.type === "list_models")?.id, models: [model], current: model });
    const input = screen.getByRole("textbox");
    await input.fill("Keep this draft across layouts");
    await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    const clipboard = new DataTransfer();
    const canvas = document.createElement("canvas");
    canvas.width = 10; canvas.height = 10;
    canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
    clipboard.items.add(new File([png], "layout-image.png", { type: "image/png" }));
    input.element().dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    const image = screen.getByRole("img", { name: "layout-image.png" });
    await expect.element(image).toBeVisible();
    const imageUrl = image.element().getAttribute("src");
    const originalInput = input.element();

    list.scrollTop = 500;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    await expect.element(screen.getByRole("button", { name: "Latest" })).toBeVisible();
    channel.emit({ protocol_version: 2, type: "timeline_event", session_id: "session-1", leaf_id: "generation-session-1", event: {
      event_id: "layout-tool", event_seq: 1, session_id: "session-1", leaf_id: "generation-session-1", timestamp: 0,
      group_id: "layout-group", kind: "tool", tool_call_id: "layout-tool", tool: "read", args: { path: "README.md" },
      truncated: false, status: "complete", result: Array.from({ length: 45 }, (_, index) => `Reading line ${index + 1}`).join("\n"),
    } });
    await screen.getByRole("button", { name: "Expand read tool" }).click();
    const expandedTool = screen.getByRole("button", { name: "Collapse read tool" }).element();
    await expect.element(screen.getByRole("button", { name: /^View all/ })).toBeVisible();
    const subscriptions = relay.subscriptions.length;
    const frames = channel.frames.length;
    const assertSessionUnchanged = () => {
      expect(relayHarness.instances).toHaveLength(1);
      expect(relay.connectCalls).toBe(1);
      expect(relay.closeCalls).toBe(0);
      expect(relay.subscriptions).toHaveLength(subscriptions);
      expect(channelHarness.channels).toEqual([channel]);
      expect(channel.closeCalls).toBe(0);
      expect(channel.frames).toHaveLength(frames);
      expect(document.querySelectorAll(".pwa-root")).toHaveLength(1);
      expect(document.querySelectorAll("main.pwa-main")).toHaveLength(1);
      expect(document.querySelector(".pwa-message-list")).toBe(list);
      expect(document.querySelector(".pwa-composer-input")).toBe(originalInput);
      // 响应式布局允许锚点补偿 scrollTop；不能重新开启底部跟随。
      expect(scrollTo).not.toHaveBeenCalled();
    };
    for (const width of [766, 767, 768, 390, 1280]) {
      await page.viewport(width, 900);
      await expect.element(input).toHaveValue("Keep this draft across layouts");
      expect(image.element().getAttribute("src")).toBe(imageUrl);
      expect(screen.getByRole("button", { name: "Collapse read tool" }).element()).toBe(expandedTool);
      await expect.element(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
      assertSessionUnchanged();
    }
    await screen.getByRole("button", { name: /^View all/ }).click();
    const reader = screen.getByRole("dialog").element();
    for (const width of [390, 1280]) {
      await page.viewport(width, 900);
      expect(screen.getByRole("dialog").element()).toBe(reader);
      assertSessionUnchanged();
    }
    await screen.getByRole("button", { name: "Close tool details" }).click();
    await expect.element(page.elementLocator(reader)).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^View all/ })).toHaveFocus();
    assertSessionUnchanged();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test.each(["protocol_upgrade_required", "unsupported_type", "internal_error"])('keeps the original handshake and message sending independent of a version query error (%s)', async (code) => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const channel = channelHarness.channels[0]!;
  try {
    expect(channel.frames.some((frame) => frame.type === "extension_info_request")).toBe(false);
    const ready = readyFrame(channel, "session-1");
    expect(ready).not.toHaveProperty("extension_version");
    channel.emit(ready);
    const infoRequest = channel.frames.find((frame) => frame.type === "extension_info_request");
    expect(infoRequest).toMatchObject({ channel_id: channel.channelId, session_id: "session-1", leaf_id: "generation-session-1" });
    channel.emit({ protocol_version: 2, type: "protocol_error", target_channel_id: channel.channelId, in_reply_to: infoRequest?.id, code, message: "diagnostic failure" });
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();
    expect(document.querySelector(".pwa-status-toast")).toBeNull();
    const input = screen.getByPlaceholder("Message your agent…");
    await expect.element(input).toBeEnabled();
    await input.fill("Version lookup must not block sending");
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    expect(channel.frames.some((frame) => frame.type === "user_message")).toBe(true);
    await screen.getByRole("button", { name: "Open settings" }).click();
    await expect.poll(() => document.querySelector('[data-version="extension"]')?.textContent).toBe("Version unavailable");
    expect(channelHarness.channels).toHaveLength(1);
    channel.emit(extensionInfoFrame(channel, "late-version"));
    await flushMicrotasks();
    expect(document.querySelector('[data-version="extension"]')?.textContent).toBe("Version unavailable");
  } finally {
    window.history.replaceState(null, "", "/app");
    await screen.unmount();
  }
});

test("does not hide an unrelated protocol error while an extension version query is pending", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const channel = channelHarness.channels[0]!;
  try {
    channel.emit(readyFrame(channel, "session-1"));
    channel.emit({ protocol_version: 2, type: "protocol_error", target_channel_id: channel.channelId, in_reply_to: "unrelated-request", code: "too_large", message: "too large" });
    await expect.element(screen.getByText("This message is too large to send.", { exact: true })).toBeVisible();
    channel.emit(extensionInfoFrame(channel, "3.4.5"));
    await expect.element(screen.getByText("This message is too large to send.", { exact: true })).toBeVisible();
  } finally { await screen.unmount(); }
});

test("preserves the extension version when reselecting the current computer and Pi", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const channel = channelHarness.channels[0]!;
  try {
    channel.emit(readyFrame(channel, "session-1"));
    channel.emit(extensionInfoFrame(channel, "3.4.5"));
    await screen.getByRole("button", { name: "Choose computer, current test-host" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
    await page.elementLocator(document.querySelector(".pwa-computer-select")!).click();
    await expect.poll(() => document.querySelector(".pwa-device-panel")).toBeNull();
    await page.elementLocator(document.querySelector('.pwa-nav-session[aria-current="true"]')!).click();
    await screen.getByRole("button", { name: "Open settings" }).click();
    await expect.element(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    await expect.poll(() => document.querySelector('[data-version="extension"]')?.textContent).toBe("3.4.5");
    expect(channelHarness.channels).toHaveLength(1);
    expect(channel.frames.filter((frame) => frame.type === "session_hello")).toHaveLength(1);
  } finally {
    window.history.replaceState(null, "", "/app");
    await screen.unmount();
  }
});

test.each([1280, 390])("shows live versions in settings and clears them across Relay reconnects at %ipx", async (width) => {
  await page.viewport(width, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const relay = relayHarness.instances[0]!;
  const channel = channelHarness.channels[0]!;
  const version = (component: string) => document.querySelector(`[data-version="${component}"]`)?.textContent;
  try {
    relay.emitControl({ type: "relay_info", version: "2.3.4" });
    channel.emit({ ...readyFrame(channel, "session-1"), in_reply_to: "wrong-hello" });
    expect(channel.frames.filter((frame) => frame.type === "extension_info_request")).toHaveLength(0);
    channel.emit(readyFrame(channel, "session-1"));
    channel.emit({ ...extensionInfoFrame(channel, "9.9.9"), in_reply_to: "wrong-version-request" });
    channel.emit(extensionInfoFrame(channel, "3.4.5"));
    if (width < 768) await screen.getByRole("button", { name: "Open navigation" }).click();
    await screen.getByRole("button", { name: "Open settings" }).click();
    await expect.element(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    await expect.poll(() => version("relay")).toBe("2.3.4");
    await expect.poll(() => version("extension")).toBe("3.4.5");
    expect(relayHarness.instances).toHaveLength(1);
    expect(channelHarness.channels).toHaveLength(1);
    expect(relay.closeCalls).toBe(0);

    relay.emitState("closed");
    await expect.poll(() => version("extension")).toBe("No online Pi selected");
    await expect.poll(() => version("relay")).not.toBe("2.3.4");
    await vi.waitFor(() => expect(relay.connectCalls).toBe(2));
    relay.emitControl({ type: "relay_info", version: "2.3.5" });
    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [{ endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-2", metadata: { kind: "interactive", name: "New Pi", cwd: "/workspace" } }] });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    channel.emit(readyFrame(channel, "stale-session"));
    const newChannel = channelHarness.channels[1]!;
    newChannel.emit(readyFrame(newChannel, "new-session"));
    channel.emit(extensionInfoFrame(channel, "9.9.9"));
    newChannel.emit(extensionInfoFrame(newChannel, "3.4.6"));
    await expect.poll(() => version("relay")).toBe("2.3.5");
    await expect.poll(() => version("extension")).toBe("3.4.6");
    await expect.element(screen.getByText("Current Pi: test-host · New Pi")).toBeInTheDocument();
  } finally {
    window.history.replaceState(null, "", "/app");
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("ignores version callbacks from a replaced Relay while saving settings", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  const relay = relayHarness.instances[0]!;
  try {
    relay.emitControl({ type: "relay_info", version: "2.3.4" });
    channelHarness.channels[0]!.emit(readyFrame(channelHarness.channels[0]!, "session-1"));
    await screen.getByRole("button", { name: "Open settings" }).click();
    await expect.element(screen.getByRole("main", { name: "Settings" })).toBeVisible();
    await screen.getByRole("textbox", { name: "Relay URL" }).fill("https://relay.changed.test");
    await screen.getByRole("button", { name: "Save settings" }).click();
    await vi.waitFor(() => expect(relayHarness.instances).toHaveLength(2));
    const replacement = relayHarness.instances[1]!;
    await vi.waitFor(() => expect(replacement.state).toBe("open"));
    replacement.emitControl({ type: "relay_info", version: "4.5.6" });
    relay.emitControl({ type: "relay_info", version: "9.9.9" });
    await expect.poll(() => document.querySelector('[data-version="relay"]')?.textContent).toBe("4.5.6");
    await expect.poll(() => document.querySelector('[data-version="extension"]')?.textContent).toBe("Getting version…");
  } finally {
    window.history.replaceState(null, "", "/app");
    await screen.unmount();
  }
});

test.each([1280, 390])("keeps the settings page beneath confirmation and restores focus at %ipx", async (width) => {
  await page.viewport(width, 844);
  const context = await renderReadyTimeline(renderWorkspaceApp);
  const { screen } = context;
  try {
    const request = await issueOperation(context, "session_compact");
    replyOperation(context.channel, request);
    await expect.element(screen.getByText("Could not compact the conversation. Try again.")).toBeVisible();
    const notice = operationFeedback();
    if (width < 768) await screen.getByRole("button", { name: "Open navigation" }).click();
    const settingsTrigger = screen.getByRole("button", { name: "Open settings" });
    settingsTrigger.element().focus();
    await settingsTrigger.click();
    const settings = screen.getByRole("main", { name: "Settings" });
    await expect.element(settings).toBeVisible();
    await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toHaveFocus();
    await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
    const clear = screen.getByRole("button", { name: "Clear local data", exact: true });
    clear.element().focus();
    await clear.click();
    const confirmation = screen.getByRole("dialog", { name: /Clear this browser/ });
    await expect.element(confirmation).toBeVisible();
    expect(confirmation.element().closest(".pwa-root")).toBe(document.querySelector(".pwa-root"));
    await userEvent.keyboard("{Escape}");
    // Role 查询会在退出动画中提前排除 hidden 节点；等待实际卸载才算确认门禁释放。
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    await expect.element(settings).toBeVisible();
    await expect.element(clear).toHaveFocus();
    await screen.getByRole("button", { name: width < 768 ? "Back to navigation" : "Back to workspace" }).click();
    await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
    const restoredTrigger = width < 768 ? screen.getByRole("dialog", { name: /Workspace/ }).getByRole("button", { name: "Open settings" }) : settingsTrigger;
    await expect.element(restoredTrigger).toHaveFocus();
    expect(await (await openPwaDatabase()).devices.count()).toBe(1);
    expect(operationFeedback()).toBe(notice);
  } finally {
    window.history.replaceState(null, "");
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("keeps mobile navigation behind deletion confirmation and restores management focus", async () => {
  await page.viewport(390, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    trigger.element().focus();
    await trigger.click();
    await screen.getByRole("button", { name: "Choose computer, current test-host" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
    const computerActions = screen.getByRole("button", { name: "Computer actions for test-host" });
    await computerActions.click();
    const remove = screen.getByRole("menuitem", { name: "Remove test-host" });
    await remove.click();
    const confirmation = screen.getByRole("dialog", { name: "Delete pairing for test-host?" });
    await expect.element(confirmation).toBeVisible();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).not.toBeInTheDocument();
    await expect.element(computerActions).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Choose computer, current test-host" })).toHaveFocus();
    expect(await (await openPwaDatabase()).devices.count()).toBe(1);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("keeps a stable session channel across reset and session replacement, with terminal bye requiring Retry", async () => {
  const screen = await renderOnlineApp();
  await expect.element(screen.getByRole("heading", { name: "Test Pi" })).toBeVisible();
  const firstChannel = channelHarness.channels[0];
  expect(firstChannel?.frames[0]?.type).toBe("session_hello");
  firstChannel?.emit(readyFrame(firstChannel, "session-1"));
  await flushMicrotasks();

  firstChannel?.emit({ protocol_version: 2, type: "reset", target_channel_id: firstChannel.channelId, session_id: "session-1", leaf_id: "generation-session-2", reason: "branch_changed" });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
  const secondChannel = channelHarness.channels[1];
  expect(secondChannel?.channelId).toBe(firstChannel?.channelId);
  expect(secondChannel?.frames[0]?.type).toBe("session_hello");

  secondChannel?.emit(readyFrame(secondChannel, "session-2"));
  await flushMicrotasks();
  secondChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "peer_stop" });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(2);
  secondChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-2", leaf_id: "generation-session-2", reason: "session_replaced" });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(3));
  const thirdChannel = channelHarness.channels[2];
  expect(thirdChannel?.channelId).toBe(firstChannel?.channelId);
  expect(thirdChannel?.frames[0]?.type).toBe("session_hello");

  thirdChannel?.emit(readyFrame(thirdChannel, "session-3"));
  await flushMicrotasks();
  thirdChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-3", leaf_id: "generation-session-3", reason: "peer_stop" });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(3);
  await expect.element(screen.getByLabelText("Offline")).toBeVisible();
  const modelRequestsBeforeRetry = thirdChannel?.frames.filter((frame) => frame.type === "list_models").length ?? 0;
  await screen.getByRole("button", { name: "Session actions" }).click();
  await expect.element(screen.getByRole("menuitem", { name: "New session" })).toBeDisabled();
  expect(thirdChannel?.frames.filter((frame) => frame.type === "list_models")).toHaveLength(modelRequestsBeforeRetry);
  await screen.getByRole("menuitem", { name: "Retry connection" }).click();
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(4));
  expect(channelHarness.channels[3]?.channelId).toBe(firstChannel?.channelId);
  await screen.unmount();
});

test("does not rebuild the session channel for metadata-only endpoint updates or stale callbacks", async () => {
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  const firstChannel = channelHarness.channels[0];
  expect(firstChannel).toBeDefined();
  relay?.emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Renamed Pi", cwd: "/workspace", working: true } });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(1);

  firstChannel?.emit(readyFrame(firstChannel, "session-1"));
  await flushMicrotasks();
  firstChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "session_replaced" });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
  const secondChannel = channelHarness.channels[1];
  secondChannel?.emit(readyFrame(secondChannel, "session-2"));
  await flushMicrotasks();
  secondChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "peer_stop" });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(2);
  await screen.unmount();
});

test("synchronizes live session titles from registry metadata without replacing history or navigation behavior", async () => {
  await page.viewport(390, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await expect.poll(() => document.querySelector(".pwa-composer-input")).not.toBeNull();
    const composerNode = document.querySelector(".pwa-composer-input");
    // 移动顶栏：菜单图标与会话名共同构成导航入口，只显示会话名，点击高度不低于 44px。
    const initialName = trigger.element().querySelector<HTMLElement>(".pwa-session-trigger-title")!;
    expect(initialName.textContent).toBe("Test Pi");
    expect(trigger.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(initialName.scrollWidth).toBeLessThanOrEqual(initialName.clientWidth + 1);
    expect(trigger.element().querySelector(".pwa-brand-mark")).toBeNull();
    trigger.element().focus();
    await trigger.click();
    const navigation = screen.getByRole("dialog", { name: /Workspace/ });
    await expect.element(navigation.getByRole("button", { name: /Test Pi/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveFocus();
    expect(document.querySelector(".pwa-composer-input")).toBe(composerNode);

    relayHarness.instances[0]?.emitControl({
      type: "endpoint_updated",
      device_id: "owner-device-key",
      endpoint_id: "daemon-endpoint",
      runtime_instance_id: "runtime-1",
      metadata: { kind: "interactive", name: "Renamed session", cwd: "C:\\Users\\pi\\Code\\project\\" },
    });
    await expect.poll(() => trigger.element().querySelector(".pwa-session-trigger-title")?.textContent).toBe("Renamed session");
    const renamedName = trigger.element().querySelector<HTMLElement>(".pwa-session-trigger-title")!;
    expect(renamedName.scrollWidth).toBeLessThanOrEqual(renamedName.clientWidth + 1);
    expect(channelHarness.channels).toHaveLength(1);
    await trigger.click();
    const renamedPi = navigation.getByRole("button", { name: /Renamed session/ });
    await expect.element(renamedPi).toBeVisible();
    // 在线 Pi 行只显示工作目录最后一级。
    expect(renamedPi.element().textContent).toContain("project");
    expect(renamedPi.element().textContent).not.toContain("C:\\Users");
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveFocus();
    await page.screenshot({ path: "../../../.vitest/screenshots/pwa-live-session-title-mobile.png" });

    await page.viewport(1280, 900);
    const desktopTitle = document.querySelector<HTMLElement>(".pwa-title-bar-name")!;
    await expect.poll(() => desktopTitle.querySelector(".pwa-title-bar-title")?.textContent).toBe("Renamed session");
    expect(desktopTitle.querySelector(".pwa-title-bar-prefix")?.textContent).toBe("project · ");
    expect(getComputedStyle(desktopTitle).display).not.toBe("none");

    await page.viewport(390, 844);
    relayHarness.instances[0]?.emitControl({
      type: "endpoint_updated",
      device_id: "owner-device-key",
      endpoint_id: "daemon-endpoint",
      runtime_instance_id: "runtime-1",
      metadata: { kind: "interactive" },
    });
    await expect.poll(() => trigger.element().querySelector(".pwa-session-trigger-title")?.textContent).toBe("Untitled session");
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("keeps an invalid manual pairing code visible with its error inside the dialog", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    await screen.getByRole("button", { name: "Pair a computer", exact: true }).first().click();
    const input = screen.getByRole("textbox", { name: "Pairing code" });
    await input.fill("K7MP");
    await screen.getByRole("button", { name: "Pair", exact: true }).click();

    await expect.element(screen.getByText("Enter the 8-character pairing code from Pi.", { exact: true })).toBeVisible();
    // 失败说明留在弹窗内输入框下方，不使用 Toast。
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
    expect(document.querySelector(".pwa-toast")).toBeNull();
    await expect.element(input).toHaveValue("K7MP");
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    await expect.element(screen.getByRole("dialog", { name: "Pair a computer" })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

test("persists the pairing and selects a newly announced Pi after remount", async () => {
  const db = await openPwaDatabase();
  await Promise.all([
    db.devices.clear(),
    db.endpoints.clear(),
    db.settings.clear(),
  ]);
  const deviceBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const normalizedDeviceId = encodeBase64(deviceBytes, "standard");
  const endpointId = "123e4567-e89b-42d3-a456-426614174001";
  const runtimeInstanceId = "123e4567-e89b-42d3-a456-426614174002";
  const pairingCode = "K7MP-4Q2D";
  const firstRender = await renderPwa(<PwaApp />);

  await firstRender.getByRole("button", { name: "Start pairing" }).first().click();
  // 输满 8 位有效字符后自动提交。
  await firstRender.getByRole("textbox", { name: "Pairing code" }).fill(pairingCode);
  const relay = relayHarness.instances[0];
  await vi.waitFor(() => expect(relay?.controlFrames).toHaveLength(1));
  const resolve = relay?.controlFrames[0];
  relay?.emitControl({ type: "pairing_target", in_reply_to: resolve?.request_id ?? "missing-request", code: "K7MP4Q2D", device_id: normalizedDeviceId, endpoint_id: endpointId, runtime_instance_id: runtimeInstanceId });
  // 桌面：电脑选择入口显示新配对的电脑名（移动导航入口此时隐藏）。
  await expect.element(firstRender.getByRole("button", { name: "Choose computer, current paired-host" })).toBeVisible();
  // 成功后关闭弹窗并以 Toast 提示「已与〈主机名〉配对」。
  await expect.element(firstRender.getByText("Paired with paired-host", { exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).toBeNull();

  const activeEndpointKey = `active_endpoint:${makePwaDeviceId(normalizedDeviceId)}`;
  expect((await db.settings.get(activeEndpointKey))?.value).toBe(endpointId);
  await db.endpoints.put({
    id: makePwaEndpointId(normalizedDeviceId, endpointId),
    deviceId: normalizedDeviceId,
    endpointId,
    runtimeInstanceId,
    kind: "interactive",
    name: "Stale cached Pi",
    cwd: "/workspace",
    updatedAt: Date.now(),
  });

  await firstRender.unmount();
  const secondRender = await renderPwa(<PwaApp />);
  await vi.waitFor(() => expect(relayHarness.instances.at(-1)?.state).toBe("open"));
  relayHarness.instances.at(-1)?.emitControl({
    type: "endpoints",
    device_id: normalizedDeviceId,
    endpoints: [{
      endpoint_id: "new-process-endpoint",
      runtime_instance_id: "new-process-runtime",
      metadata: { kind: "interactive", name: "Restored Pi", cwd: "/workspace" },
    }],
  });
  await expect.element(secondRender.getByRole("heading", { name: "Restored Pi" })).toBeVisible();
});

test("returns to the live session when the same Pi runtime reappears after a Relay snapshot without it", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const relay = relayHarness.instances[0]!;
    const initialChannel = channelHarness.channels[0]!;
    initialChannel.emit(readyFrame(initialChannel, "session-1"));
    await flushMicrotasks();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();

    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [] });
    await expect.element(screen.getByText("This Pi has exited. The conversation is saved in local history.")).toBeVisible();

    relay.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [{ endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" } }],
    });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const recovered = channelHarness.channels[1]!;
    recovered.emit(readyFrame(recovered, "session-1"));
    await flushMicrotasks();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();
    await expect.element(screen.getByText("This Pi has exited. The conversation is saved in local history.")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

test("keeps an exited Pi in place when a new runtime appears for the same endpoint", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const relay = relayHarness.instances[0]!;
    const initialChannel = channelHarness.channels[0]!;
    initialChannel.emit(readyFrame(initialChannel, "session-1"));
    await flushMicrotasks();
    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [] });
    await expect.element(screen.getByText("This Pi has exited. The conversation is saved in local history.")).toBeVisible();
    relay.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [{ endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-2", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" } }],
    });
    await flushMicrotasks();
    await expect.element(screen.getByText("This Pi has exited. The conversation is saved in local history.")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

test("shows the Relay status instead of a connection failure while no Pi is online", async () => {
  const screen = await renderWorkspaceApp();
  try {
    await vi.waitFor(() => expect(relayHarness.instances[0]?.state).toBe("open"));
    const relay = relayHarness.instances[0]!;
    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [] });
    await expect.element(screen.getByRole("heading", { name: "No Pi online" })).toBeVisible();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();
    // 提示条延迟在测试中为 0；等待一轮计时器后仍不应出现 Relay 故障提示。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".pwa-connection-banner")).toBeNull();
    expect(document.querySelector(".pwa-title-bar .pwa-connection.offline")).toBeNull();

    // 真正的 Relay 断线仍按原规则提示。
    relay.emitState("closed");
    await expect.element(screen.getByText("Can't reach Relay. Retrying…", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

test("shows the Relay status while waiting for the user to choose a Pi", async () => {
  const db = await openPwaDatabase();
  await db.settings.delete(`active_endpoint:${makePwaDeviceId("owner-device-key")}`);
  const screen = await renderWorkspaceApp();
  try {
    await vi.waitFor(() => expect(relayHarness.instances[0]?.state).toBe("open"));
    relayHarness.instances[0]!.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [
        { endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "First Pi", cwd: "/workspace/first" } },
        { endpoint_id: "second-endpoint", runtime_instance_id: "runtime-2", metadata: { kind: "interactive", name: "Second Pi", cwd: "/workspace/second" } },
      ],
    });
    await expect.element(screen.getByRole("heading", { name: "2 Pi online" })).toBeVisible();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".pwa-title-bar .pwa-connection.connecting")).toBeNull();
    expect(document.querySelector(".pwa-connection-banner")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

function navigationHistoryRows(): string[] {
  return [...document.querySelectorAll("#pwa-desktop-navigation .pwa-history-row")].map((row) => row.textContent ?? "");
}

function savedAssistantEvent(endpointSession: string, text: string, timestamp: number): TimelineEvent {
  return { event_id: `${endpointSession}-event`, event_seq: 1, session_id: endpointSession, leaf_id: `generation-${endpointSession}`, timestamp, group_id: `${endpointSession}-group`, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] };
}

test("keeps the online session out of local history until its Pi exits", async () => {
  const now = Date.now();
  await mergeTimelineEvents({ deviceId: "owner-device-key", endpointId: "old-endpoint", sessionId: "old-session", leafId: "generation-old-session" }, [savedAssistantEvent("old-session", "Older offline record", now - 60_000)]);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const relay = relayHarness.instances[0]!;
    const channel = channelHarness.channels[0]!;
    channel.emit(readyFrame(channel, "session-1"));
    await flushMicrotasks();
    const liveEvent = savedAssistantEvent("session-1", "Live session record", now - 1_000);
    channel.emit({ protocol_version: 2, type: "timeline_event", session_id: "session-1", leaf_id: "generation-session-1", event: liveEvent });
    await expect.element(screen.getByText("Live session record", { exact: true })).toBeVisible();
    // 实时会话已写入本地存储，但对应 Pi 在线时只出现在「在线 Pi」分组。
    await expect.poll(async () => (await listTimelineSessions("owner-device-key")).some((session) => session.sessionId === "session-1")).toBe(true);
    await expect.poll(() => navigationHistoryRows().some((text) => text.includes("Older offline record"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigationHistoryRows()).toHaveLength(1);

    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [] });
    await expect.element(screen.getByText("This Pi has exited. The conversation is saved in local history.")).toBeVisible();
    await expect.poll(() => navigationHistoryRows()).toHaveLength(2);
  } finally {
    await screen.unmount();
  }
});

test("hides only the latest local record of another online Pi", async () => {
  const now = Date.now();
  const scope = { deviceId: "owner-device-key", endpointId: "other-endpoint" };
  await mergeTimelineEvents({ ...scope, sessionId: "other-older", leafId: "generation-other-older" }, [savedAssistantEvent("other-older", "Other older record", now - 60_000)]);
  await mergeTimelineEvents({ ...scope, sessionId: "other-latest", leafId: "generation-other-latest" }, [savedAssistantEvent("other-latest", "Other latest record", now - 1_000)]);
  const screen = await renderWorkspaceApp();
  try {
    await vi.waitFor(() => expect(relayHarness.instances[0]?.state).toBe("open"));
    relayHarness.instances[0]!.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [
        { endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" } },
        { endpoint_id: "other-endpoint", runtime_instance_id: "runtime-other", metadata: { kind: "interactive", name: "Other Pi", cwd: "/workspace/other" } },
      ],
    });
    await expect.poll(() => [...document.querySelectorAll("#pwa-desktop-navigation .pwa-nav-session")].some((row) => row.textContent?.includes("Other Pi"))).toBe(true);
    await expect.poll(() => navigationHistoryRows().some((text) => text.includes("Other older record"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigationHistoryRows().some((text) => text.includes("Other latest record"))).toBe(false);
  } finally {
    await screen.unmount();
  }
});

async function seedArchivedSession(text = "Archived note") {
  await mergeTimelineEvents({ deviceId: "owner-device-key", endpointId: "daemon-endpoint", sessionId: "archived-session", leafId: "generation-archived-session" }, [savedAssistantEvent("archived-session", text, Date.now() - 60_000)]);
}

test("uses the product name as the mobile title before any computer is paired", async () => {
  await page.viewport(390, 844);
  const db = await openPwaDatabase();
  await db.devices.clear();
  const screen = await renderWorkspaceApp();
  try {
    await expect.element(screen.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
    await expect.poll(() => document.querySelector(".pwa-session-trigger-title")?.textContent).toBe("Pi Reach");
  } finally {
    await screen.unmount();
  }
});

function queuedStateFrame(items: Array<{ id: string; text: string }>, snapshotId: string) {
  return { protocol_version: 2, type: "queued_message_state", session_id: "session-1", leaf_id: "generation-session-1", snapshot_id: snapshotId, chunk_index: 0, final: true, items: items.map((item) => ({ ...item, sender_ref: "sender-session-1", editable: true, created_at: 1 })) };
}

test("returns a cancelled queued message to the composer once the cancellation is confirmed", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    channel.emit(queuedStateFrame([{ id: "queued-1", text: "Check landscape mode next" }], "queue-1"));
    await expect.element(screen.getByText("Check landscape mode next", { exact: true })).toBeVisible();
    const input = screen.getByRole("textbox");
    await input.fill("Draft in progress");
    await screen.getByRole("button", { name: /^Cancel queued message 1/ }).click();
    expect(channel.frames.filter((frame) => frame.type === "queued_message_clear")).toHaveLength(1);
    // 取消尚未确认时不回填。
    await expect.element(input).toHaveValue("Draft in progress");
    channel.emit(queuedStateFrame([], "queue-2"));
    await expect.element(input).toHaveValue("Draft in progress\nCheck landscape mode next");
  } finally {
    await screen.unmount();
  }
});

test("does not return a queued message that Pi already read", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    channel.emit(queuedStateFrame([{ id: "queued-1", text: "Already consumed message" }], "queue-1"));
    await expect.element(screen.getByText("Already consumed message", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: /^Cancel queued message 1/ }).click();
    const request = channel.frames.findLast((frame) => frame.type === "queued_message_clear")!;
    // Pi 在取消到达前已读取这条消息：先回执进入对话，再给出不含它的快照。
    channel.emit({ protocol_version: 2, type: "user_message_status", target_channel_id: channel.channelId, in_reply_to: request.id, client_request_id: "queued-1", session_id: "session-1", leaf_id: "generation-session-1", status: "accepted", message_id: "message-1" });
    channel.emit(queuedStateFrame([], "queue-2"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(screen.getByRole("textbox")).toHaveValue("");
  } finally {
    await screen.unmount();
  }
});

test.each([[1280, false], [390, true]])("shows the connected state as a dot only on phones at %ipx", async (width, dotOnly) => {
  await page.viewport(width, 844);
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const channel = channelHarness.channels[0]!;
    channel.emit(readyFrame(channel, "session-1"));
    await flushMicrotasks();
    await expect.element(screen.getByLabelText("Connected")).toBeVisible();
    const label = document.querySelector<HTMLElement>(".pwa-title-bar .pwa-connection.online .pwa-connection-label")!;
    // 手机上已连接时只显示圆点，文字仅供读屏；桌面保持圆点＋文字。
    if (dotOnly) expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    else expect(label.getBoundingClientRect().width).toBeGreaterThan(20);
  } finally {
    await screen.unmount();
  }
});

test("lists running Pis first as bordered rows while waiting for a choice", async () => {
  const db = await openPwaDatabase();
  await db.settings.delete(`active_endpoint:${makePwaDeviceId("owner-device-key")}`);
  const screen = await renderWorkspaceApp();
  try {
    await vi.waitFor(() => expect(relayHarness.instances[0]?.state).toBe("open"));
    relayHarness.instances[0]!.emitControl({
      type: "endpoints",
      device_id: "owner-device-key",
      endpoints: [
        { endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Alpha idle Pi", cwd: "/workspace/alpha" } },
        { endpoint_id: "second-endpoint", runtime_instance_id: "runtime-2", metadata: { kind: "interactive", name: "Zulu running Pi", cwd: "/workspace/zulu", working: true } },
      ],
    });
    await expect.element(screen.getByRole("heading", { name: "2 Pi online" })).toBeVisible();
    const rows = [...document.querySelectorAll<HTMLElement>(".pwa-choose-pi-list .pwa-nav-session")];
    expect(rows.map((row) => row.textContent ?? "")).toEqual([expect.stringContaining("Zulu running Pi"), expect.stringContaining("Alpha idle Pi")]);
    for (const row of rows) {
      expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(56);
      expect(getComputedStyle(row).borderTopWidth).toBe("1px");
      expect(row.querySelector(".pwa-nav-link-section svg")).not.toBeNull();
    }
  } finally {
    await screen.unmount();
  }
});

function pasteAttachments(input: Element, ...files: File[]) {
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected the composer textarea.");
  const clipboard = new DataTransfer();
  for (const file of files) clipboard.items.add(file);
  input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
}

test("legacy capability failure disables attachments but keeps text and vision models working", async () => {
  channelHarness.supportsAttachments = false;
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const model = { id: "vision-model", provider: "test", name: "Vision model", reasoning: false, context_window: 200_000, vision: true };
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: channel.frames.findLast((frame) => frame.type === "list_models")?.id, models: [model], current: model });
    await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeDisabled();
    await expect.element(screen.getByText("Upgrade the computer's extension to upload attachments.", { exact: true })).toBeVisible();
    await screen.getByPlaceholder("Message your agent…").fill("Legacy text works");
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    expect(channel.frames.findLast((frame) => frame.type === "user_message")).toMatchObject({ text: "Legacy text works" });
    expect(document.querySelector(".pwa-toast")).toBeNull();
  } finally { await screen.unmount(); }
});

test.each([false, true])("uploads originals and retains readonly text until IDs handoff, including unknown delivery=%s", async (unknownDelivery) => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    await input.fill("Please review the original file");
    const bytes = Uint8Array.from({ length: ATTACHMENT_CHUNK_BYTES + 17 }, (_, index) => index % 251);
    pasteAttachments(input.element(), new File([bytes], "original.bin", { type: "application/octet-stream" }));
    await expect.element(screen.getByText("original.bin", { exact: true })).toBeVisible();
    expect(channel.frames.some((frame) => frame.type === "attachment_begin")).toBe(false);
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    await expect.element(input).toHaveAttribute("readonly");
    await expect.element(input).toBeEnabled();
    await expect.element(input).toHaveValue("Please review the original file");
    expect(channel.frames.some((frame) => frame.type === "user_message")).toBe(false);
    expect(channel.frames.filter((frame) => frame.type === "attachment_chunk").map((frame) => frame.type === "attachment_chunk" ? atob(frame.data_base64).length : 0)).toEqual([ATTACHMENT_CHUNK_BYTES, 17]);
    if (unknownDelivery) channelHarness.nextSendResults.push(false);
    channelHarness.finishReplies[0]?.();
    await expect.poll(() => channel.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    const message = channel.frames.findLast((frame) => frame.type === "user_message");
    expect(message).toMatchObject({ text: "Please review the original file", attachment_ids: [expect.any(String)] });
    expect(message).not.toHaveProperty("images");
    expect(message).not.toHaveProperty("attachments");
    await expect.element(input).not.toHaveAttribute("readonly");
    await expect.element(input).toHaveValue("");
    await expect.poll(() => document.querySelectorAll(".pwa-composer .pwa-attachment-card").length).toBe(0);
    if (unknownDelivery) {
      await expect.element(screen.getByText("Message could not be sent. Check the connection and try again.", { exact: true })).toBeVisible();
      await screen.getByRole("button", { name: "Retry delivery" }).click();
      const retry = channel.frames.findLast((frame) => frame.type === "user_message");
      expect(retry).toMatchObject({ client_request_id: message?.type === "user_message" ? message.client_request_id : "", attachment_ids: message?.type === "user_message" ? message.attachment_ids : [] });
      expect(channel.frames.filter((frame) => frame.type === "attachment_begin")).toHaveLength(1);
    }
  } finally { await screen.unmount(); }
});

test.each(["Keep text", ""])("removing all active files sends only remaining text (%s)", async (text) => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill(text);
    await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    pasteAttachments(input.element(), new File(["keep-original"], "cancel-me.txt", { type: "text/plain" }));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    await screen.getByRole("button", { name: "Cancel cancel-me.txt", exact: true }).click();
    await expect.element(input).toBeEnabled();
    channelHarness.finishReplies[0]?.();
    await flushMicrotasks();
    const messages = channel.frames.filter((frame) => frame.type === "user_message");
    expect(messages).toHaveLength(text ? 1 : 0);
    if (text) { expect(messages[0]).toMatchObject({ text }); expect(messages[0]).not.toHaveProperty("attachment_ids"); }
  } finally { await screen.unmount(); }
});

test("removing one active file does not cancel the remaining attachment", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Two originals");
    pasteAttachments(input.element(), new File(["one"], "one.txt"), new File(["two"], "two.txt"));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(2);
    await screen.getByRole("button", { name: "Cancel one.txt", exact: true }).click();
    for (const reply of channelHarness.finishReplies) reply();
    await expect.poll(() => channel.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    const message = channel.frames.findLast((frame) => frame.type === "user_message");
    const remaining = [...channelHarness.uploads.values()].find((item) => item.descriptor.file_name === "two.txt")!;
    expect(message).toMatchObject({ text: "Two originals", attachment_ids: [remaining.descriptor.attachment_id] });
    expect(channel.frames.filter((frame) => frame.type === "attachment_cancel")).toHaveLength(1);
    await expect.element(input).toHaveValue("");
  } finally { await screen.unmount(); }
});

test("settings and ordinary leaf updates keep an active upload on one channel", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    pasteAttachments(input.element(), new File(["body"], "settings.txt"));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    await screen.getByRole("button", { name: "Open settings", exact: true }).click();
    expect(document.querySelector(".pwa-confirm-dialog")).toBeNull();
    const leaf = "new-leaf";
    channel.emit({ protocol_version: 2, type: "timeline_event", session_id: "session-1", leaf_id: leaf, event: { ...numberedEvents(1)[0], leaf_id: leaf, event_seq: 1 } });
    channelHarness.finishReplies[0]?.();
    await expect.poll(() => channel.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    expect(channel.frames.findLast((frame) => frame.type === "user_message")).toMatchObject({ leaf_id: leaf });
    expect(channel.frames.filter((frame) => frame.type === "attachment_capabilities_request")).toHaveLength(1);
    expect(channelHarness.channels).toHaveLength(1);
    await screen.getByRole("button", { name: "Back to workspace", exact: true }).click();
  } finally { await screen.unmount(); }
});

test("deleting an unrelated computer pairing does not stop the active attachment send", async () => {
  const db = await openPwaDatabase();
  await db.devices.put({ id: makePwaDeviceId("other-computer"), deviceId: "other-computer", relayUrl: "https://relay.example.test", pairedAt: "2000-01-01T00:00:00.000Z", hostname: "other-host" });
  await db.settings.put({ key: "active_device", value: makePwaDeviceId("owner-device-key") });
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    pasteAttachments(screen.getByPlaceholder("Message your agent…").element(), new File(["keep"], "unrelated-pairing.txt"));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    await screen.getByRole("button", { name: "Choose computer, current test-host" }).click();
    await screen.getByRole("button", { name: "Computer actions for other-host" }).click();
    await screen.getByRole("menuitem", { name: "Remove other-host", exact: true }).click();
    await screen.getByRole("button", { name: "Delete pairing", exact: true }).click();
    await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
    expect(channel.frames.some((frame) => frame.type === "attachment_cancel")).toBe(false);
    channelHarness.finishReplies[0]?.();
    await expect.poll(() => channel.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    expect(channelHarness.channels).toHaveLength(1);
  } finally { await screen.unmount(); }
});

test("a persisted pagehide and pageshow keep attachment selection and sending usable", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    pasteAttachments(screen.getByPlaceholder("Message your agent…").element(), new File(["restored"], "bfcache.txt"));
    await expect.element(screen.getByText("bfcache.txt", { exact: true })).toBeVisible();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    // 既有 pageshow 恢复会重新握手；模拟当前 Pi 的真实 ready/能力响应。
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const restored = channelHarness.channels[1]!;
    restored.emit(readyFrame(restored, "session-1"));
    await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    await expect.element(screen.getByText("bfcache.txt", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => restored.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    expect(channel.frames.some((frame) => frame.type === "user_message")).toBe(false);
  } finally { await screen.unmount(); }
});

test("queued cancellation restores a released descriptor and removal discards the actual uploaded original", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Restore then remove");
    pasteAttachments(input.element(), new File(["original"], "restored.txt", { type: "text/plain" }));
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channel.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    const message = channel.frames.findLast((frame) => frame.type === "user_message")!;
    if (message.type !== "user_message") throw new Error("missing attachment handoff");
    const attachmentId = message.attachment_ids![0];
    expect(channelHarness.uploads.size).toBe(1);
    await expect.poll(() => document.querySelectorAll(".pwa-composer .pwa-attachment-card").length).toBe(0);
    channel.emit(queuedStateFrame([{ id: message.client_request_id, text: message.text }], "queue-before-cancel"));
    await screen.getByRole("button", { name: /^Cancel queued message 1/ }).click();
    channel.emit(queuedStateFrame([], "queue-after-cancel"));
    await expect.element(input).toHaveValue("Restore then remove");
    await expect.poll(() => document.querySelectorAll(".pwa-composer .pwa-attachment-card").length).toBe(1);
    await screen.getByRole("button", { name: "Remove restored.txt", exact: true }).click();
    await expect.poll(() => channelHarness.uploads.size).toBe(0);
    expect(channel.frames.filter((frame) => frame.type === "attachment_discard")).toEqual([expect.objectContaining({
      attachment_id: attachmentId, session_id: "session-1", upload_scope: "uploads-session-1",
    })]);
    expect(channel.frames.some((frame) => frame.type === "attachment_cancel")).toBe(false);
    expect(channel.frames.filter((frame) => frame.type === "attachment_begin")).toHaveLength(1);
    await expect.poll(() => document.querySelectorAll(".pwa-composer .pwa-attachment-card").length).toBe(0);
  } finally { await screen.unmount(); }
});

test("failed upload offers a safe retry without dropping the original File or text", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Retry my original");
    pasteAttachments(input.element(), new File(["original bytes"], "retry.txt"));
    channelHarness.failNextChunk = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.element(screen.getByText("Not enough space on the computer.", { exact: true })).toBeVisible();
    await expect.element(input).toHaveValue("Retry my original");
    await expect.element(input).toHaveAttribute("readonly");
    await expect.element(input).toBeEnabled();
    expect(channel.frames.some((frame) => frame.type === "user_message")).toBe(false);
    await screen.getByRole("button", { name: "Retry retry.txt", exact: true }).click();
    await expect.poll(() => channel.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    expect(channel.frames.filter((frame) => frame.type === "attachment_begin")).toHaveLength(1);
    expect(channel.frames.filter((frame) => frame.type === "attachment_status_request")).toHaveLength(2);
    await expect.element(input).toHaveValue("");
  } finally { await screen.unmount(); }
});

test("short disconnect resumes the same attachment batch through a new capability query", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Resume on original Pi");
    pasteAttachments(input.element(), new File(["resume body"], "resume.txt"));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    const relay = relayHarness.instances[0]!;
    relay.emitState("closed");
    await expect.element(screen.getByText("Connection lost. Uploads will resume after reconnecting.", { exact: true })).toBeVisible();
    await expect.element(input).toHaveValue("Resume on original Pi");
    await expect.element(input).toHaveAttribute("readonly");
    await expect.element(input).toBeEnabled();
    relay.emitState("open");
    relay.emitControl({ type: "endpoints", device_id: "owner-device-key", endpoints: [{ endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "interactive", name: "Test Pi", cwd: "/workspace" } }] });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const resumed = channelHarness.channels[1]!;
    resumed.emit(readyFrame(resumed, "session-1"));
    await expect.poll(() => resumed.frames.filter((frame) => frame.type === "user_message").length).toBe(1);
    expect(resumed.frames.some((frame) => frame.type === "attachment_status_request")).toBe(true);
    expect(resumed.frames.some((frame) => frame.type === "attachment_begin" || frame.type === "attachment_chunk")).toBe(false);
    expect(resumed.frames.findLast((frame) => frame.type === "user_message")).toMatchObject({ text: "Resume on original Pi", attachment_ids: [expect.any(String)] });
    channelHarness.finishReplies[0]?.();
    await flushMicrotasks();
    expect(channel.frames.some((frame) => frame.type === "user_message")).toBe(false);
  } finally { await screen.unmount(); }
});

test("session replacement preserves old text and File without automatically sending to the new session", async () => {
  const { screen, channel } = await renderReadyTimeline(renderWorkspaceApp);
  try {
    const input = screen.getByPlaceholder("Message your agent…");
    await input.fill("Only original session");
    pasteAttachments(input.element(), new File(["old"], "old-session.txt"));
    channelHarness.holdFinish = true;
    await screen.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => channelHarness.finishReplies.length).toBe(1);
    channel.emit({ protocol_version: 2, type: "bye", session_id: "session-1", leaf_id: "generation-session-1", reason: "session_replaced" });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const next = channelHarness.channels[1]!;
    next.emit(readyFrame(next, "session-2"));
    await expect.element(screen.getByPlaceholder("Message your agent…")).toHaveValue("");
    channelHarness.finishReplies[0]?.();
    await flushMicrotasks();
    expect(next.frames.some((frame) => frame.type === "user_message")).toBe(false);
    await expect.element(screen.getByText("old-session.txt", { exact: true })).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});

test("shows the directory and model under the empty-session hint", async () => {
  const screen = await renderOnlineApp(renderWorkspaceApp);
  try {
    const channel = channelHarness.channels[0]!;
    channel.emit(readyFrame(channel, "empty-session"));
    await expect.element(screen.getByText("Send a message to Pi to begin.")).toBeVisible();
    await expect.poll(() => document.querySelector(".pwa-chat-empty-context")?.textContent).toBe("workspace");
    const model = { id: "text-model", provider: "test", name: "Text model", reasoning: false, context_window: 200_000, vision: false };
    channel.emit({ protocol_version: 2, type: "models_list", in_reply_to: channel.frames.findLast((frame) => frame.type === "list_models")?.id, models: [model], current: model });
    await expect.poll(() => document.querySelector(".pwa-chat-empty-context")?.textContent).toBe("workspace · Text model");
  } finally {
    await screen.unmount();
  }
});
