import { expect, test, vi } from "vitest";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_FRAME_BYTES, decodeServerFrameV2, type ClientFrame, type ServerFrame } from "../protocol/v2/index.js";
import { TimelineRuntime } from "./runtime.js";
import { TimelineV2Service } from "./v2_service.js";
import { UserDeliveryBinding } from "./user_delivery_binding.js";

function harness(idle = false) {
  const manager = SessionManager.inMemory(process.cwd());
  const runtime = new TimelineRuntime();
  const send = vi.fn();
  let service!: TimelineV2Service;
  const binding = new UserDeliveryBinding({
    isIdle: () => idle, canAcceptNormal: () => true,
    getPi: () => ({ sendUserMessage: send }) as unknown as ExtensionAPI,
    getTimeline: () => runtime, getCurrentSessionId: () => manager.getSessionId(),
    getCurrentLeafId: () => manager.getLeafId() ?? null, findTarget: (owner) => owner === "owner" ? { service, sessionId: manager.getSessionId(), leafId: manager.getLeafId() ?? null } : null,
    sendFrames: vi.fn(),
  });
  service = new TimelineV2Service({
    sessionManager: manager, runtime, senderRef: "owner",
    onUserMessage: (frame, correlation) => binding.submit(frame, correlation, { ownerId: "owner", sessionId: manager.getSessionId(), leafId: manager.getLeafId() ?? null, service, clientRequestId: frame.client_request_id }),
    onQueueSnapshot: () => binding.snapshot("owner", service),
    onQueuedMessageClear: (target) => binding.clearQueued("owner", service, target),
    onQueuedMessageSteer: (target) => binding.steerQueued("owner", service, target).kind,
  });
  return { service, send, binding };
}
const hello: ClientFrame = { protocol_version: 2, type: "session_hello", id: "hello", channel_id: "c" };
const user: Extract<ClientFrame, { type: "user_message" }> = { protocol_version: 2, type: "user_message", id: "wire", client_request_id: "q", channel_id: "c", leaf_id: null, text: "later", images: [{ mime: "image/png", data: "abc" }] };
const steer: Extract<ClientFrame, { type: "queued_message_steer" }> = { protocol_version: 2, type: "queued_message_steer", id: "insert", target_id: "q", channel_id: "c", leaf_id: null };
function lastSnapshot(frames: ServerFrame[]) { return frames.findLast((frame) => frame.type === "queued_message_state"); }

test("hello synchronizes the queue and promotion preserves attachments without resending the original request", () => {
  const { service, send } = harness();
  expect(service.handle(hello).map((frame) => frame.type)).toEqual(["session_ready", "queued_message_state"]);
  expect(lastSnapshot(service.handle(user))).toMatchObject({ items: [{ id: "q", images: user.images, editable: true }] });
  expect(lastSnapshot(service.handle({ ...hello, id: "hello-again" }))).toMatchObject({ items: [{ id: "q" }] });
  expect(lastSnapshot(service.handle(steer))).toMatchObject({ items: [] });
  expect(send).toHaveBeenCalledExactlyOnceWith([{ type: "image", data: "abc", mimeType: "image/png" }, { type: "text", text: "later" }], { deliverAs: "steer" });
  expect(service.handle({ ...steer, id: "again" })[0]).toMatchObject({ type: "protocol_error", in_reply_to: "again" });
  expect(service.handle(user)[0]).toMatchObject({ type: "user_message_status", status: "unknown_delivery" });
  expect(send).toHaveBeenCalledTimes(1);
});

test("queue actions enforce the channel/generation gate and cancellation cannot revive a request", () => {
  const { service, send } = harness();
  expect(service.handle(steer)[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel" });
  service.handle(hello); service.handle(user);
  expect(service.handle({ ...steer, leaf_id: "old" })[0]).toMatchObject({ type: "reset" });
  expect(lastSnapshot(service.handle({ ...hello, id: "verify" }))).toMatchObject({ items: [{ id: "q" }] });
  const cancel: ClientFrame = { ...steer, type: "queued_message_clear", id: "cancel" };
  expect(lastSnapshot(service.handle(cancel))).toMatchObject({ items: [] });
  expect(lastSnapshot(service.handle(cancel))).toMatchObject({ items: [] });
  expect(service.handle(user)[0]).toMatchObject({ type: "user_message_status", status: "unknown_delivery" });
  expect(send).not.toHaveBeenCalled();
  expect(service.handle({ protocol_version: 2, type: "queued_message_set", id: "unused", channel_id: "c", leaf_id: null, text: "unused" })[0]).toMatchObject({ code: "unsupported_type" });
});

test("a cancel racing normal delivery returns an error and the in-flight snapshot", async () => {
  const { service, send, binding } = harness(true);
  service.handle(hello); service.handle(user);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(send).toHaveBeenCalledTimes(1);
  const frames = service.handle({ ...steer, type: "queued_message_clear", id: "cancel-race" });
  expect(frames[0]).toMatchObject({ type: "protocol_error", in_reply_to: "cancel-race", code: "invalid_message" });
  expect(lastSnapshot(frames)).toMatchObject({ items: [{ id: "q", editable: false }] });
  expect(send).toHaveBeenCalledTimes(1);
  binding.clearAll();
});

test("snapshot chunks fit the wire limit including image payloads and framing overhead", () => {
  const { service } = harness();
  const base = { id: "q", text: "", images: [{ mime: "image/png" as const, data: "a".repeat(1_100_000) }], editable: true, sender_ref: "owner", created_at: 1 };
  const frames = service.queueSnapshot([base, { ...base, id: "q2" }, { ...base, id: "q3" }]);
  expect(frames).toHaveLength(3);
  frames.forEach((frame, index) => {
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(decodeServerFrameV2(frame)).toMatchObject({ snapshot_id: (frames[0] as { snapshot_id: string }).snapshot_id, chunk_index: index, final: index === 2 });
  });
  expect(service.canQueueItem(base)).toBe(true);
  expect(service.canQueueItem({ ...base, images: [{ mime: "image/png", data: "a".repeat(MAX_FRAME_BYTES) }] })).toBe(false);
});
