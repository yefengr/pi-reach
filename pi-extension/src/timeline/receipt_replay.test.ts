import { describe, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClientFrame, V2IdempotencyRecord } from "../protocol/v2/index.js";
import { encodeServerFrameV2 } from "../protocol/v2/index.js";
import { MAX_RECEIPT_REPLAY, receiptReplayFrames } from "./receipt_replay.js";
import { TimelineRuntime, type Correlation } from "./runtime.js";
import { TimelineV2Service } from "./v2_service.js";
import { decodeServerFrameV2 as decodePwaServerFrameV2 } from "../../../pwa/src/lib/pi-reach/protocol-v2/codec.ts";
import { TimelineRuntime as PwaTimelineRuntime, type TimelineScope as PwaTimelineScope } from "../../../pwa/src/lib/pwa/timeline-runtime.ts";

function hello(channelId = "channel-1", id = "hello-1"): Extract<ClientFrame, { type: "session_hello" }> {
  return { protocol_version: 2, type: "session_hello", id, channel_id: channelId };
}

function user(leafId: string | null, overrides: Partial<Extract<ClientFrame, { type: "user_message" }>> = {}): Extract<ClientFrame, { type: "user_message" }> {
  return { protocol_version: 2, type: "user_message", id: "wire-1", channel_id: "channel-1", leaf_id: leafId, client_request_id: "request-1", text: "hello", ...overrides };
}

/** 发出用户消息并让 Pi 开始处理；返回的 started 帧模拟 PWA 断线期间丢失。 */
function startedService() {
  const session = SessionManager.inMemory(process.cwd());
  const runtime = new TimelineRuntime();
  let correlation: Correlation | undefined;
  const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", extensionVersion: "1.2.3", runtime,
    onUserMessage: vi.fn((_frame: unknown, value: Correlation) => { correlation = value; return true; }) });
  service.handle(hello());
  service.handle(user(service.leafId));
  runtime.onAgentStart();
  const started = runtime.runWithCorrelation(correlation!, () => runtime.onMessageStart({ role: "user", content: "hello", timestamp: 1 }, session))!;
  const lost = service.started(started);
  return { session, runtime, service, started, lost };
}

function statusFrames(frames: readonly { type: string }[]) {
  return frames.filter((frame) => frame.type === "user_message_status");
}

function record(index: number, overrides: Partial<V2IdempotencyRecord> = {}): V2IdempotencyRecord {
  return { key: `key-${index}`, sessionId: "session-1", leafId: null, senderRef: "owner-1", clientRequestId: `request-${index}`, fingerprint: "f",
    status: "accepted", attemptId: `wire-${index}`, messageId: `message-${index}`, touchedAt: index, ...overrides };
}

describe("receipt replay on session_hello", () => {
  test("re-sends the started confirmation to the same channel with the original attempt id", () => {
    const { service, started, lost } = startedService();
    expect(lost[0]).toMatchObject({ type: "user_message_status", status: "accepted", in_reply_to: "wire-1" });

    const frames = service.handle(hello("channel-1", "hello-2"));
    expect(frames[0]).toMatchObject({ type: "session_ready", in_reply_to: "hello-2" });
    expect(statusFrames(frames)).toEqual([{
      protocol_version: 2, type: "user_message_status", target_channel_id: "channel-1", in_reply_to: "wire-1",
      session_id: service.sessionId, leaf_id: service.leafId, client_request_id: "request-1", status: "accepted",
      message_id: started.eventId, group_id: started.groupId,
    }]);
    expect(() => encodeServerFrameV2(statusFrames(frames)[0] as never)).not.toThrow();
  });

  test("replays a committed request as accepted until the PWA reports the formal message", () => {
    const { session, service } = startedService();
    const messageId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 } as never);
    expect(service.commit("request-1", messageId)[0]).toMatchObject({ status: "committed" });
    expect(statusFrames(service.handle(hello("channel-1", "hello-2")))).toEqual([
      expect.objectContaining({ status: "accepted", message_id: messageId, in_reply_to: "wire-1" }),
    ]);

    service.handle({ protocol_version: 2, type: "user_message_observed", id: "observed-1", channel_id: "channel-1",
      session_id: service.sessionId, leaf_id: service.leafId, client_request_id: "request-1", message_id: messageId, status: "committed" });
    expect(statusFrames(service.handle(hello("channel-1", "hello-3")))).toEqual([]);
  });

  test("does not replay to another channel or before Pi starts the message", () => {
    const { service } = startedService();
    expect(statusFrames(service.handle(hello("channel-2", "hello-2")))).toEqual([]);

    const session = SessionManager.inMemory(process.cwd());
    const waiting = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", extensionVersion: "1.2.3", runtime: new TimelineRuntime(), onUserMessage: () => true });
    waiting.handle(hello());
    expect(waiting.handle(user(waiting.leafId))[0]).toMatchObject({ status: "received" });
    expect(statusFrames(waiting.handle(hello("channel-1", "hello-2")))).toEqual([]);
  });

  test("bounds one handshake to the most recent confirmations of this sender", () => {
    const records = [
      ...Array.from({ length: MAX_RECEIPT_REPLAY + 3 }, (_, index) => record(index)),
      record(100, { senderRef: "owner-2" }),
      record(101, { status: "received", messageId: undefined }),
      record(102, { status: "rejected" }),
    ];
    const frames = receiptReplayFrames(records, { senderRef: "owner-1", channelId: "channel-1", sessionId: "session-1", leafId: null }, () => "channel-1");
    expect(frames).toHaveLength(MAX_RECEIPT_REPLAY);
    expect(frames[0]).toMatchObject({ client_request_id: `request-${MAX_RECEIPT_REPLAY + 2}`, in_reply_to: `wire-${MAX_RECEIPT_REPLAY + 2}` });
    expect(frames.map((frame) => "client_request_id" in frame ? frame.client_request_id : "")).not.toContain("request-0");
    expect(frames).not.toContainEqual(expect.objectContaining({ client_request_id: "request-100" }));
  });

  test("lets a reconnected PWA runtime confirm the message without a status query", () => {
    const { session, runtime, service, started } = startedService();
    const ready = service.handle(hello())[0]!;
    if (ready.type !== "session_ready") throw new Error("session_ready expected");
    const scope: PwaTimelineScope = { deviceId: "device-1", endpointId: "endpoint-1", runtimeInstanceId: "runtime-1",
      sessionId: ready.session_id, leafId: ready.leaf_id, selfSenderRef: ready.self_sender_ref, channelId: "channel-1" };
    const pwa = new PwaTimelineRuntime();
    pwa.setScope(scope);
    expect(pwa.sendUser("hello", undefined, { clientRequestId: "request-1", requestId: "wire-1" })).not.toBeNull();

    // 重新握手：本地消息先转为未确认，随后只收到补推，不发查询。
    const rehello = service.handle(hello("channel-1", "hello-2"));
    const resumed = rehello[0]!;
    if (resumed.type !== "session_ready") throw new Error("session_ready expected");
    pwa.prepareLive({ ...scope, leafId: resumed.leaf_id }, resumed.head_seq);
    expect(pwa.replacing).toBe(false);
    expect(pwa.pendingItems).toEqual([expect.objectContaining({ clientRequestId: "request-1", delivery: "unknown_delivery" })]);
    for (const frame of statusFrames(rehello)) pwa.receive(decodePwaServerFrameV2(encodeServerFrameV2(frame as never)));
    expect(pwa.pendingItems).toEqual([expect.objectContaining({ clientRequestId: "request-1", messageId: started.eventId, delivery: "accepted" })]);

    // 正式事件沿用 started 写入的 marker ID；到达后按 message_id 合并并回报已看到。
    session.appendMessage({ role: "user", content: "hello", timestamp: 1 } as never);
    const event = runtime.recover(session).find((candidate) => candidate.event_id === started.eventId)!;
    expect(event).toMatchObject({ kind: "user" });
    const committed = pwa.receive(decodePwaServerFrameV2(encodeServerFrameV2(service.publish(event)!)));
    expect(pwa.pendingItems).toEqual([]);
    expect(committed.observed).toEqual([expect.objectContaining({ type: "user_message_observed", client_request_id: "request-1", message_id: started.eventId })]);
  });
});
