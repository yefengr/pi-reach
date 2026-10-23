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
    sessionManager: manager, runtime, senderRef: "owner", extensionVersion: "1.2.3",
    onUserMessage: (frame, correlation) => binding.submit(frame, correlation, { ownerId: "owner", sessionId: manager.getSessionId(), leafId: manager.getLeafId() ?? null, service, clientRequestId: frame.client_request_id }),
    onQueueSnapshot: () => binding.snapshot("owner", service),
    onDeliveryStage: (id) => binding.lookup("owner", service, id),
    onQueuedMessageClear: (target) => binding.clearQueued("owner", service, target),
    onQueuedMessageSteer: (target) => binding.steerQueued("owner", service, target).kind,
  });
  return { service, send, binding, manager };
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

test.each(["late", "start", "commit", "commit-only"] as const)("throwing insertion preserves %s evidence and never calls the SDK twice", async (evidence) => {
  const { service, send, binding, manager } = harness();
  const outbound: ServerFrame[] = [];
  // 模拟 SDK 在同一次同步调用内发布事件后抛错。
  service.handle(hello); service.handle(user);
  send.mockImplementation(() => {
    const request = { origin: "pwa" as const, delivery: "normal" as const, senderRef: "owner",
      clientRequestId: "q", requestId: "wire", channelId: "c" };
    if (evidence === "start" || evidence === "commit") outbound.push(...service.started({ eventId: "message", groupId: "group",
      role: "user", correlation: request, blocks: [] }));
    if (evidence === "commit" || evidence === "commit-only") outbound.push(...service.commit("q", "message", "group"));
    throw new Error("delivery may already have happened");
  });
  try {
    const response = service.handle(steer);
    expect(response.some((frame) => frame.type === "protocol_error")).toBe(false);
    expect(lastSnapshot(response)).toMatchObject({ items: [] });
    expect(service.handle({ ...user, id: "retry" })[0]).toMatchObject({ status:
      evidence === "late" ? "unknown_delivery" : evidence === "start" ? "accepted" : "committed" });
    expect(service.handle({ ...steer, type: "queued_message_clear", id: "cancel" })
      .some((frame) => frame.type === "user_message_status" && frame.status === "cancelled")).toBe(false);
    manager.appendThinkingLevelChange("high");
    binding.scheduleDrain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    service.handle({ ...user, id: "again", leaf_id: service.leafId });
    expect(send).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveLength(evidence === "late" ? 0 : evidence === "commit" ? 3 : evidence === "start" ? 2 : 1);
  } finally { binding.clearAll(); }
});

test("rejection history replays A after B and fails closed at the attempt cap before SDK admission", async () => {
  const { service, send, binding } = harness(true);
  const submit = vi.spyOn(binding, "submit").mockReturnValue({ kind: "rejected", code: "unavailable", retryable: true });
  try {
    service.handle(hello);
    expect(service.handle({ ...user, id: "a0" })[0]).toMatchObject({ status: "rejected" });
    expect(service.handle({ ...user, id: "a1" })[0]).toMatchObject({ status: "rejected" });
    expect(service.handle({ ...user, id: "a0" })[0]).toMatchObject({ status: "rejected" });
    expect(submit).toHaveBeenCalledTimes(2);
    for (let index = 2; index < 128; index++) {
      service.handle({ ...user, id: `a${index}` });
      service.handle({ ...user, id: `a${index}` });
    }
    expect(submit).toHaveBeenCalledTimes(128);
    submit.mockRestore();
    expect(service.handle({ ...user, id: "over", text: "changed" })[0]).toMatchObject({ type: "protocol_error" });
    for (const id of ["over", "a0", "a127", "another"]) expect(service.handle({ ...user, id })[0])
      .toMatchObject({ status: "rejected", code: "unavailable", retryable: false, in_reply_to: id });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();
    expect(binding.lookup("owner", service, "q")).toBeNull();
  } finally { submit.mockRestore(); binding.clearAll(); }
});

test("a sent insertion leaves the request unknown even after an ordinary leaf advance", () => {
  const { service, manager } = harness();
  service.handle(hello); service.handle(user);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "progress" }], timestamp: 1 } as never);
  expect(lastSnapshot(service.handle(steer))).toMatchObject({ items: [] });
  expect(service.handle({ protocol_version: 2, type: "user_message_status_request", id: "query", channel_id: "c",
    session_id: service.sessionId, leaf_id: service.leafId, client_request_id: "q" })[0])
    .toMatchObject({ status: "unknown_delivery", in_reply_to: "query" });
});

test("queue actions enforce the channel/generation gate and cancellation cannot revive a request", () => {
  const { service, send } = harness();
  expect(service.handle(steer)[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel" });
  service.handle(hello); service.handle(user);
  expect(service.handle({ ...steer, leaf_id: "old" })[0]).toMatchObject({ type: "reset" });
  expect(lastSnapshot(service.handle({ ...hello, id: "verify" }))).toMatchObject({ items: [{ id: "q" }] });
  const cancel: ClientFrame = { ...steer, type: "queued_message_clear", id: "cancel" };
  const cleared = service.handle(cancel);
  // 定向取消回执先于快照，PWA 不必把快照缺席当作未知再查询。
  expect(cleared.map((frame) => frame.type)).toEqual(["user_message_status", "queued_message_state"]);
  expect(cleared[0]).toMatchObject({ status: "cancelled", in_reply_to: "cancel", client_request_id: "q", target_channel_id: "c" });
  expect(lastSnapshot(cleared)).toMatchObject({ items: [] });
  const repeated = service.handle(cancel);
  expect(repeated.some((frame) => frame.type === "user_message_status")).toBe(false);
  expect(lastSnapshot(repeated)).toMatchObject({ items: [] });
  expect(service.handle(user)[0]).toMatchObject({ type: "user_message_status", status: "cancelled" });
  expect(service.handle({ protocol_version: 2, type: "user_message_status_request", id: "query", channel_id: "c",
    session_id: service.sessionId, leaf_id: service.leafId, client_request_id: user.client_request_id })[0])
    .toMatchObject({ status: "cancelled", in_reply_to: "query" });
  expect(send).not.toHaveBeenCalled();
  expect(service.handle({ protocol_version: 2, type: "queued_message_set", id: "unused", channel_id: "c", leaf_id: null, text: "unused" })[0]).toMatchObject({ code: "unsupported_type" });
});

test.each(["expired", "evicted"] as const)("successful clear retains fresh cancellation after the original record is %s", (reason) => {
  let now = 1;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const { service, send, binding } = harness();
  const query = () => service.handle({ protocol_version: 2, type: "user_message_status_request", id: "query",
    channel_id: "c", session_id: service.sessionId, leaf_id: service.leafId, client_request_id: "q" })[0];
  try {
    service.handle(hello); service.handle(user);
    if (reason === "expired") now += 10 * 60 * 1000;
    else for (let index = 0; index < 512; index++) {
      service.handle({ ...user, id: `wire-${index}`, client_request_id: `other-${index}` });
    }
    expect(binding.lookup("owner", service, "q")).toBe("queued");
    expect(query()).toMatchObject({ status: "accepted" });
    expect(lastSnapshot(service.handle({ ...steer, type: "queued_message_clear", id: "clear" })))
      .not.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: "q" })]) });
    expect(query()).toMatchObject({ status: "cancelled" });
    now += 10 * 60 * 1000 - 1;
    expect(query()).toMatchObject({ status: "cancelled" });
    expect(service.handle({ ...user, id: "new-attempt", text: "arbitrary replacement" })[0])
      .toMatchObject({ type: "user_message_status", status: "cancelled" });
    expect(binding.lookup("owner", service, "q")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    now++;
    expect(query()).toMatchObject({ status: "not_found" });
  } finally { binding.clearAll(); clock.mockRestore(); }
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

test("binding lookup tracks queued/in-flight only and queries never drain the queue", async () => {
  const { service, send, binding, manager } = harness(true);
  try {
    service.handle(hello); service.handle(user);
    expect(binding.lookup("owner", service, "q")).toBe("queued");
    expect(binding.lookup("other", service, "q")).toBeNull();
    expect(binding.lookup("owner", {} as TimelineV2Service, "q")).toBeNull();
    const query = () => ({ protocol_version: 2 as const, type: "user_message_status_request" as const, id: "query", channel_id: "c",
      session_id: service.sessionId, leaf_id: service.leafId, client_request_id: "q" });
    expect(service.handle(query())[0]).toMatchObject({ status: "accepted" });
    expect(send).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.appendThinkingLevelChange("high");
    expect(binding.lookup("owner", service, "q")).toBe("in_flight");
    expect(service.handle(query())[0]).toMatchObject({ status: "accepted" });
    expect(send).toHaveBeenCalledTimes(1);
    binding.clearAll();
    expect(binding.lookup("owner", service, "q")).toBeNull();
  } finally { binding.clearAll(); }
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
