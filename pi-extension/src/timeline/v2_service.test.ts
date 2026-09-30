import { describe, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClientFrame } from "../protocol/v2/index.js";
import { encodeServerFrameV2 } from "../protocol/v2/index.js";
import { TimelineRuntime } from "./runtime.js";
import { TimelineV2Service } from "./v2_service.js";
import { decodeServerFrameV2 as decodePwaServerFrameV2 } from "../../../pwa/src/lib/pi-reach/protocol-v2/codec.ts";
import { TimelineRuntime as PwaTimelineRuntime, type TimelineScope as PwaTimelineScope } from "../../../pwa/src/lib/pwa/timeline-runtime.ts";

function hello(channelId = "channel-1"): Extract<ClientFrame, { type: "session_hello" }> {
  return { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: channelId };
}

function user(
  leafId: string | null,
  overrides: Partial<Extract<ClientFrame, { type: "user_message" }>> = {},
): Extract<ClientFrame, { type: "user_message" }> {
  return {
    protocol_version: 2,
    type: "user_message",
    id: "wire-1",
    channel_id: "channel-1",
    leaf_id: leafId,
    client_request_id: "request-1",
    text: "hello",
    ...overrides,
  };
}

describe("TimelineV2Service", () => {
  test("requires hello and returns direct ready with server-derived sender ref", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime, onUserMessage: () => false });
    expect(service.handle(user(service.leafId))[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel", target_channel_id: "channel-1" });
    expect(service.handle(hello())[0]).toMatchObject({
      type: "session_ready",
      target_channel_id: "channel-1",
      self_sender_ref: "owner-1",
      session_id: session.getSessionId(),
      leaf_id: service.leafId,
    });
  });

  test("tracks the SessionManager leaf and resets stale requests after branch changes", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      runtime: new TimelineRuntime(),
      onUserMessage: () => false,
    });
    const initialLeaf = service.leafId;
    expect(service.handle(hello())[0]).toMatchObject({ leaf_id: initialLeaf });
    expect(service.handle({
      protocol_version: 2,
      type: "ping",
      id: "ping-1",
      channel_id: "channel-1",
      leaf_id: initialLeaf,
    })[0]).toMatchObject({ type: "pong" });
    expect(service.leafId).toBe(initialLeaf);

    session.appendMessage({ role: "user", content: "branch", timestamp: 1 } as never);
    expect(service.refreshScope()).toBe(true);
    expect(service.leafId).not.toBe(initialLeaf);
    expect(service.handle({
      protocol_version: 2,
      type: "ping",
      id: "ping-old",
      channel_id: "channel-1",
      leaf_id: initialLeaf,
    })[0]).toMatchObject({
      type: "reset",
      reason: "branch_changed",
      leaf_id: service.leafId,
      target_channel_id: "channel-1",
    });
    expect(service.handle(user(initialLeaf))[0]).toMatchObject({
      type: "reset",
      reason: "branch_changed",
      leaf_id: service.leafId,
      target_channel_id: "channel-1",
    });
  });

  test("does not broadcast or fragment an event from a different session or leaf", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => false });
    const event = { kind: "assistant" as const, event_id: "event-1", event_seq: 1, group_id: "group-1", session_id: session.getSessionId(), leaf_id: service.leafId, timestamp: 1, status: "complete" as const, blocks: [{ type: "text", text: "current" }] };
    expect(service.publishFrames(event)).toHaveLength(1);
    expect(service.publishFrames({ ...event, session_id: "another-session" })).toEqual([]);
    expect(service.publishFrames({ ...event, leaf_id: "stale-leaf" })).toEqual([]);
    expect(service.publishFrames({ ...event, leaf_id: "stale-leaf", blocks: [{ type: "text", text: "x".repeat(300_000) }] })).toEqual([]);
  });

  test.each([
    ["invalid_event", { event_seq: 0 }],
    ["missing_event_seq", { event_seq: undefined }],
    ["session_mismatch", { session_id: "another-session" }],
    ["leaf_mismatch", { leaf_id: "stale-leaf" }],
  ] as const)("diagnoses a rejected run_end without bypassing validation (%s)", (reason, overrides) => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => false });
    const event = { kind: "run_end" as const, event_id: "run-end", event_seq: 1, group_id: "group", session_id: session.getSessionId(), leaf_id: service.leafId, timestamp: 1, status: "complete" as const };
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(service.publishFrames(event)).toHaveLength(1);
      expect(diagnostic).not.toHaveBeenCalled();
      const rejected = { ...event, ...overrides };
      expect(service.publishFrames(rejected)).toEqual([]);
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[pi-reach] run_end publication rejected", {
        reason, event_id: rejected.event_id, group_id: rejected.group_id, event_seq: rejected.event_seq,
        event_scope: { session_id: rejected.session_id, leaf_id: rejected.leaf_id },
        service_scope: { session_id: service.sessionId, leaf_id: service.leafId },
      });
    } finally { diagnostic.mockRestore(); }
  });

  test("lists the current vision model only after hello and generation validation", () => {
    const session = SessionManager.inMemory(process.cwd());
    const onListModels = vi.fn(() => ({
      models: [{ id: "vision-1", name: "Vision", provider: "test", reasoning: false, context_window: 1000, vision: true }],
      current: { id: "vision-1", name: "Vision", provider: "test", reasoning: false, context_window: 1000, vision: true },
    }));
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => false, onListModels });
    const request = {
      protocol_version: 2 as const,
      type: "list_models" as const,
      id: "models-1",
      channel_id: "channel-1",
      leaf_id: service.leafId,
    };
    expect(service.handle(request)[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel" });
    service.handle(hello());
    expect(service.handle({ ...request, leaf_id: "old" })[0]).toMatchObject({ type: "reset", reason: "branch_changed" });
    expect(service.handle(request)[0]).toMatchObject({
      type: "models_list",
      target_channel_id: "channel-1",
      in_reply_to: "models-1",
      current: { id: "vision-1", vision: true },
    });
    expect(onListModels).toHaveBeenCalledTimes(1);
  });

  test("accepts typed actions only after hello and generation validation", () => {
    const session = SessionManager.inMemory(process.cwd());
    const onAction = vi.fn();
    const service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      runtime: new TimelineRuntime(),
      onUserMessage: () => false,
      onAction,
    });
    const actions: ClientFrame[] = [
      { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", leaf_id: service.leafId },
      { protocol_version: 2, type: "session_compact", id: "compact-1", channel_id: "channel-1", leaf_id: service.leafId },
      { protocol_version: 2, type: "model_set", id: "model-1", channel_id: "channel-1", leaf_id: service.leafId, provider: "test", model_id: "model" },
      { protocol_version: 2, type: "thinking_set", id: "thinking-1", channel_id: "channel-1", leaf_id: service.leafId, level: "high" },
    ];

    expect(service.handle(actions[0]!)[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel" });
    service.handle(hello());
    expect(service.handle({ ...actions[0]!, leaf_id: "old" } as ClientFrame)[0]).toMatchObject({ type: "reset", reason: "branch_changed" });
    for (const action of actions) expect(service.handle(action)).toEqual([]);
    expect(onAction.mock.calls.map(([action]) => action.type)).toEqual([
      "session_new",
      "session_compact",
      "model_set",
      "thinking_set",
    ]);
  });

  test("redacts list-model failures from directed protocol errors", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      runtime: new TimelineRuntime(),
      onUserMessage: () => false,
      onListModels: () => { throw new Error("/private/models.json contains a secret"); },
    });
    service.handle(hello());
    expect(service.handle({
      protocol_version: 2,
      type: "list_models",
      id: "models-1",
      channel_id: "channel-1",
      leaf_id: service.leafId,
    })[0]).toMatchObject({
      type: "protocol_error",
      code: "internal_error",
      message: "Could not list available models.",
      target_channel_id: "channel-1",
    });
  });

  test("rejects old generation after hello", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => false });
    service.handle(hello());
    expect(service.handle(user("old"))[0]).toMatchObject({ type: "reset", reason: "branch_changed", target_channel_id: "channel-1" });
  });

  test("keeps queued delivery accepted across idempotent retries", () => {
    const session = SessionManager.inMemory(process.cwd());
    const onUserMessage = vi.fn(() => "queued" as const);
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage });
    service.handle(hello());
    expect(service.handle(user(service.leafId))[0]).toMatchObject({
      type: "user_message_status",
      status: "accepted",
      client_request_id: "request-1",
    });
    expect(service.canDrain("request-1")).toBe(true);
    expect(service.handle(user(service.leafId, { id: "wire-2" }))[0]).toMatchObject({
      type: "user_message_status",
      status: "accepted",
      client_request_id: "request-1",
    });
    expect(onUserMessage).toHaveBeenCalledTimes(1);
  });

  test("accepts reliable user once and replays idempotent status without a second SDK call", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    let correlation: Parameters<TimelineRuntime["runWithCorrelation"]>[0] | undefined;
    const send = vi.fn((_frame: unknown, value: Parameters<TimelineRuntime["runWithCorrelation"]>[0]) => {
      correlation = value;
      return true;
    });
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime, onUserMessage: send });
    service.handle(hello());
    const first = service.handle(user(service.leafId));
    expect(first).toEqual([expect.objectContaining({ type: "user_message_status", status: "received" })]);
    expect(service.canDrain("request-1")).toBe(true);
    const message = { role: "user", content: "hello", timestamp: 1 };
    runtime.onAgentStart();
    const started = runtime.runWithCorrelation(correlation!, () => runtime.onMessageStart(message, session));
    expect(service.started(started!)[1]).toMatchObject({
      type: "user_message_started",
      message: { origin: "pwa", sender_ref: "owner-1", delivery: "normal" },
    });
    expect(service.canDrain("request-1")).toBe(false);
    const replay = service.handle(user(service.leafId, { id: "wire-2" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(replay[0]).toMatchObject({ type: "user_message_status", status: "accepted" });
  });

  test("rejects same id with different payload and keeps unknown delivery idempotent", () => {
    const session = SessionManager.inMemory(process.cwd());
    const send = vi.fn(() => false);
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: send });
    service.handle(hello());
    const frame = user(service.leafId, {
      streaming_behavior: "steer",
      images: [{ data: "QUJD", mime: "image/png" }],
    });
    expect(service.handle(frame)[0]).toMatchObject({
      type: "user_message_status",
      in_reply_to: "request-1",
      client_request_id: "request-1",
      status: "unknown_delivery",
    });
    expect(service.handle({ ...frame, id: "wire-2" })[0]).toMatchObject({
      type: "user_message_status",
      in_reply_to: "request-1",
      client_request_id: "request-1",
      status: "unknown_delivery",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(service.handle(user(service.leafId, {
      id: "wire-3",
      streaming_behavior: "steer",
      images: [{ data: "REVG", mime: "image/png" }],
    }))[0]).toMatchObject({ type: "protocol_error", code: "invalid_message" });
  });

  test("cancel invokes a parameterless callback and returns a direct acknowledgement", () => {
    const session = SessionManager.inMemory(process.cwd());
    const onCancel = vi.fn(() => true);
    const service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      runtime: new TimelineRuntime(),
      onUserMessage: () => false,
      onCancel,
    });
    service.handle(hello());
    const [response] = service.handle({
      protocol_version: 2,
      type: "cancel",
      id: "cancel-1",
      channel_id: "channel-1",
      leaf_id: service.leafId,
    });
    expect(onCancel).toHaveBeenCalledWith();
    expect(response).toMatchObject({
      type: "cancelled",
      target_channel_id: "channel-1",
      in_reply_to: "cancel-1",
    });
    expect(response).not.toHaveProperty("target_id");
  });

  test("cancel callback failures remain direct internal errors", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      runtime: new TimelineRuntime(),
      onUserMessage: () => false,
      onCancel: () => { throw new Error("abort failed"); },
    });
    service.handle(hello());
    expect(service.handle({
      protocol_version: 2,
      type: "cancel",
      id: "cancel-1",
      channel_id: "channel-1",
      leaf_id: service.leafId,
    })[0]).toMatchObject({
      type: "protocol_error",
      target_channel_id: "channel-1",
      in_reply_to: "cancel-1",
      code: "internal_error",
      message: expect.stringContaining("abort failed"),
    });
  });

  test("observed clears the idempotency record after commit", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => true });
    service.handle(hello());
    service.handle(user(service.leafId));
    const observed = service.handle({
      protocol_version: 2,
      type: "user_message_observed",
      id: "observed-1",
      channel_id: "channel-1",
      leaf_id: service.leafId,
      client_request_id: "request-1",
      message_id: "message-1",
      status: "committed",
    });
    expect(observed).toEqual([]);
    expect(service.handle(user(service.leafId, { id: "wire-2" }))[0]).toMatchObject({ type: "user_message_status", status: "received" });
  });

  test("observed clears a committed request after an ordinary append advances the leaf", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => true });
    service.handle(hello());
    const sendingLeaf = service.leafId;
    expect(service.handle(user(sendingLeaf))[0]).toMatchObject({ type: "user_message_status", status: "received" });

    const messageId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 } as never);
    expect(service.leafId).not.toBe(sendingLeaf);
    expect(service.commit("request-1", messageId)[0]).toMatchObject({ type: "user_message_status", status: "committed" });
    expect(service.handle({
      protocol_version: 2,
      type: "user_message_observed",
      id: "observed-1",
      channel_id: "channel-1",
      session_id: service.sessionId,
      leaf_id: service.leafId,
      client_request_id: "request-1",
      message_id: messageId,
      status: "committed",
    })).toEqual([]);
    expect(service.handle(user(service.leafId, { id: "wire-2" }))[0]).toMatchObject({ type: "user_message_status", status: "received" });
  });

  test("propagates an ordinary SessionManager append through the Extension frame into the PWA runtime", () => {
    const session = SessionManager.inMemory(process.cwd());
    const extensionRuntime = new TimelineRuntime();
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: extensionRuntime, onUserMessage: () => false });
    const ready = service.handle(hello())[0]!;
    expect(ready.type).toBe("session_ready");
    if (ready.type !== "session_ready") throw new Error("session_ready expected");

    const pwa = new PwaTimelineRuntime();
    const pwaScope: PwaTimelineScope = {
      deviceId: "device-1",
      endpointId: "endpoint-1",
      runtimeInstanceId: "runtime-1",
      sessionId: ready.session_id,
      leafId: ready.leaf_id,
      selfSenderRef: ready.self_sender_ref,
      channelId: ready.target_channel_id,
    };
    pwa.setScope(pwaScope);

    const messageId = session.appendMessage({ role: "user", content: "ordinary append", timestamp: 1 } as never);
    expect(session.getLeafId()).not.toBe(ready.leaf_id);
    const event = extensionRuntime.recover(session).find((candidate) => candidate.event_id === messageId)!;
    const broadcast = service.publish(event);
    expect(broadcast).toMatchObject({ type: "timeline_event", session_id: ready.session_id, leaf_id: session.getLeafId() });
    if (!broadcast) throw new Error("timeline broadcast expected");

    const relayed = decodePwaServerFrameV2(encodeServerFrameV2(broadcast));
    const received = pwa.receive(relayed);
    expect(pwa.currentScope).toMatchObject({ sessionId: ready.session_id, leafId: session.getLeafId() });
    expect(received.items).toEqual([expect.objectContaining({ kind: "event", event: expect.objectContaining({ event_id: messageId, leaf_id: session.getLeafId() }) })]);
  });

  test("serves branch history as direct v2 chunks and broadcasts formal events without channel id", () => {
    const session = SessionManager.inMemory(process.cwd());
    const messageId = session.appendMessage({ role: "user", content: "legacy", timestamp: 1 } as never);
    const runtime = new TimelineRuntime();
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime, onUserMessage: () => false });
    service.handle(hello());
    const frames = service.handle({
      protocol_version: 2,
      type: "session_sync",
      id: "sync-1",
      channel_id: "channel-1",
      leaf_id: service.leafId,
      before: null,
    });
    expect(frames[0]).toMatchObject({ type: "session_history_chunk", target_channel_id: "channel-1", final_chunk: true, eos: true });
    const event = runtime.recover(session)[0]!;
    expect(event.event_id).toBe(messageId);
    const broadcast = service.publish(event);
    expect(broadcast).toMatchObject({ type: "timeline_event", session_id: session.getSessionId() });
    expect(broadcast).not.toHaveProperty("target_channel_id");
  });
});
