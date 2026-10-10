import { expect, test } from "vitest";
import { PendingCapacityError, TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import type { ServerFrame } from "../pi-reach/protocol-v2/frames";
import { ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_MESSAGE_BYTES, type AttachmentDescriptor, type TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { pendingPayloadBytes } from "./timeline-pending";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime-a", sessionId: "session", leafId: "generation", selfSenderRef: "self", channelId: "channel" };
function userEvent(messageId: string): Extract<TimelineEvent, { kind: "user" }> { return { event_id: messageId, message_id: messageId, session_id: scope.sessionId, leaf_id: scope.leafId, timestamp: 2, group_id: "group", kind: "user", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal", status: "committed" }; }
function partial(kind: "assistant" | "thinking", partialId: string): Extract<ServerFrame, { type: "timeline_partial" }> { return { protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, leaf_id: scope.leafId, group_id: "group", partial_id: partialId, kind, status: "delta", delta: "streaming" }; }
function toolPartial(toolCallId: string): Extract<ServerFrame, { type: "timeline_partial" }> { return { protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, leaf_id: scope.leafId, group_id: "group", partial_id: `tool:${toolCallId}`, kind: "tool", tool_call_id: toolCallId, tool: "read", status: "running", args: { path: `${toolCallId}.txt` } }; }
function toolEvent(toolCallId: string): Extract<TimelineEvent, { kind: "tool" }> { return { event_id: `event:${toolCallId}`, session_id: scope.sessionId, leaf_id: scope.leafId, timestamp: 3, group_id: "group", kind: "tool", tool_call_id: toolCallId, tool: "read", args: { path: `${toolCallId}.txt` }, truncated: false, status: "complete", result: "ok" }; }
function numberedUserEvents(start: number, end: number): Extract<TimelineEvent, { kind: "user" }>[] {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const sequence = start + index;
    return { ...userEvent(`event-${sequence}`), event_seq: sequence, timestamp: sequence };
  });
}

test("advances the branch tip within one session without losing pending or streaming state", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const sent = runtime.sendUser("hello")!;
  const markerLeaf = "marker-leaf";
  runtime.receive({
    protocol_version: 2, type: "user_message_started", target_channel_id: scope.channelId,
    in_reply_to: sent.frame.id, session_id: scope.sessionId, leaf_id: markerLeaf,
    message: { id: "pi-marker-entry", group_id: "group", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal" },
  });
  runtime.receive({ ...partial("assistant", "pi-marker-entry:assistant:0"), leaf_id: markerLeaf });
  const finalLeaf = "message-leaf";
  const event = { ...userEvent("pi-marker-entry"), event_seq: 1, leaf_id: finalLeaf };
  const change = runtime.receive({ protocol_version: 2, type: "timeline_event", session_id: scope.sessionId, leaf_id: finalLeaf, event });
  expect(runtime.currentScope?.leafId).toBe(finalLeaf);
  expect(change.items.filter((item) => item.kind === "pending")).toEqual([]);
  expect(change.items).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({ event_id: "pi-marker-entry" }) }));
  expect(change.observed).toEqual([expect.objectContaining({ session_id: scope.sessionId, leaf_id: finalLeaf, message_id: "pi-marker-entry" })]);
  expect(runtime.sendUser("next")?.frame).toMatchObject({ session_id: scope.sessionId, leaf_id: finalLeaf });
});

test("keeps the current tip for partials and replaces them when a formal event advances the leaf", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  runtime.receive({ ...partial("assistant", "pi-entry:assistant:0"), leaf_id: "stream-leaf" });
  expect(runtime.currentScope?.leafId).toBe(scope.leafId);
  const formal = { event_id: "pi-entry", event_seq: 1, session_id: scope.sessionId, leaf_id: "formal-leaf", timestamp: 3, group_id: "group", kind: "assistant" as const, status: "complete" as const, blocks: [{ type: "text" as const, text: "done" }] };
  const changed = runtime.receive({ protocol_version: 2, type: "timeline_event", session_id: scope.sessionId, leaf_id: "formal-leaf", event: formal });
  expect(changed.items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(runtime.currentScope?.leafId).toBe("formal-leaf");
  runtime.receive({ ...partial("assistant", "foreign:assistant:0"), session_id: "other-session", leaf_id: "other-leaf" });
  expect(runtime.currentScope?.leafId).toBe("formal-leaf");
});

test("late old-leaf receipts and partials do not move the current tip backward", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const sent = runtime.sendUser("pending")!;
  const advanced = { ...userEvent("other-message"), event_seq: 1, leaf_id: "next-leaf" };
  runtime.commit(advanced);

  runtime.receive({
    protocol_version: 2,
    type: "user_message_status",
    target_channel_id: scope.channelId,
    in_reply_to: sent.frame.id,
    session_id: scope.sessionId,
    leaf_id: scope.leafId,
    client_request_id: sent.frame.client_request_id,
    status: "accepted",
  });
  runtime.receive({ ...partial("assistant", "late:assistant:0"), leaf_id: scope.leafId });

  expect(runtime.currentScope?.leafId).toBe("next-leaf");
  expect(runtime.pendingItems).toContainEqual(expect.objectContaining({ clientRequestId: sent.frame.client_request_id, delivery: "accepted" }));
});

test("overwrites a formal event revision without reporting new live output", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const original = { ...userEvent("stable-id"), event_seq: 2, blocks: [{ type: "text" as const, text: "original" }] };
  runtime.commit(original);
  const revised = { ...original, blocks: [{ type: "text" as const, text: "revised" }] };
  const stale = { ...original, event_seq: 1, blocks: [{ type: "text" as const, text: "stale" }] };

  const changed = runtime.commit(revised);

  expect(changed.newLiveEvent).toBeUndefined();
  expect(changed.committed).toEqual([revised]);
  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "event", event: revised }));
  expect(runtime.commit(stale).items).toContainEqual(expect.objectContaining({ kind: "event", event: revised }));
});

test("rejects a new pending message without changing existing pending state when capacity is exhausted", () => {
  const runtime = new TimelineRuntime({ maxEntries: 1, maxPayloadBytes: 1024 });
  runtime.setScope(scope);
  expect(runtime.sendUser("first")).toBeTruthy();
  expect(() => runtime.sendUser("second")).toThrow(PendingCapacityError);
  expect(runtime.pendingItems).toHaveLength(1);
  expect(runtime.pendingItems[0]?.text).toBe("first");
});

test("replaces pending output with a formal event in the matching live endpoint scope", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello"); expect(sent).toBeTruthy();
  const started: ServerFrame = { protocol_version: 2, type: "user_message_started", target_channel_id: scope.channelId, in_reply_to: sent!.frame.id, session_id: scope.sessionId, leaf_id: scope.leafId, message: { id: "message", group_id: "group", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal" } };
  runtime.receive(started);
  const changed = runtime.replaceHistory([userEvent("message")]);
  expect(changed.items.some((item) => item.kind === "pending")).toBe(false);
  expect(changed.observed.map((frame) => frame.type)).toEqual(["user_message_observed"]);
});

test.each(["accepted", "started", "committed"] as const)("reconciles a late %s receipt after unknown delivery without merging identical requests", (receipt) => {
  const runtime = new TimelineRuntime(); runtime.beginLive(scope, 0);
  const first = runtime.sendUser("hello")!;
  const second = runtime.sendUser("hello")!;
  const base = { protocol_version: 2 as const, target_channel_id: scope.channelId, in_reply_to: first.frame.id, session_id: scope.sessionId, leaf_id: scope.leafId, client_request_id: first.frame.client_request_id };
  runtime.receive({ ...base, type: "user_message_status", status: "accepted" });
  runtime.receive({ ...base, type: "user_message_status", status: "unknown_delivery" });
  const formal = { ...userEvent("late-message"), event_seq: 1 };
  // 覆盖正式事件先到和确认先到，两者都必须保留另一次同文发送。
  if (receipt === "committed") runtime.commit(formal);
  const received = runtime.receive(receipt === "started"
    ? { ...base, type: "user_message_started", message: { id: formal.message_id, group_id: formal.group_id, blocks: formal.blocks, origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal" } }
    : { ...base, type: "user_message_status", status: receipt, message_id: formal.message_id });
  expect(received.unknown).toEqual([]);
  const changed = receipt === "committed" ? received : runtime.commit(formal);
  expect(changed.items.filter((item) => item.kind === "pending").map((item) => item.clientRequestId)).toEqual([second.frame.client_request_id]);
  expect(changed.items.filter((item) => item.kind === "event")).toHaveLength(1);
  expect(changed.observed).toEqual([expect.objectContaining({ client_request_id: first.frame.client_request_id, message_id: formal.message_id })]);
  expect(runtime.receive({ ...base, type: "user_message_status", status: "committed", message_id: formal.message_id }).observed).toEqual([]);
});

test("does not attach an unknown request from another endpoint to a late receipt", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  runtime.setScope({ ...scope, endpointId: "other-endpoint" });
  const changed = runtime.receive({ protocol_version: 2, type: "user_message_status", target_channel_id: scope.channelId, in_reply_to: sent.frame.id, session_id: scope.sessionId, leaf_id: scope.leafId, client_request_id: sent.frame.client_request_id, status: "committed", message_id: "other-message" });
  expect(changed.unknown).toHaveLength(1);
  expect(changed.unknown[0].messageId).toBeUndefined();
  expect(changed.observed).toEqual([]);
});

test("replaces assistant and thinking partials with a provider error", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.receive(partial("assistant", "error:assistant:1"));
  runtime.receive(partial("thinking", "error:thinking:0"));
  const changed = runtime.receive({
    protocol_version: 2,
    type: "timeline_event",
    session_id: scope.sessionId,
    leaf_id: scope.leafId,
    event: { event_id: "error", session_id: scope.sessionId, leaf_id: scope.leafId, timestamp: 3, group_id: "group", kind: "provider_error", message: "failed" },
  });
  expect(changed.items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({ kind: "provider_error" }) }));
});

test("completing one tool keeps other tool partials in the same group", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.receive(toolPartial("call-a"));
  runtime.receive(toolPartial("call-b"));
  const changed = runtime.receive({
    protocol_version: 2,
    type: "timeline_event",
    session_id: scope.sessionId,
    leaf_id: scope.leafId,
    event: toolEvent("call-a"),
  });

  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({ tool_call_id: "call-a" }) }));
  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "partial", partial: expect.objectContaining({ tool_call_id: "call-b" }) }));
  expect(changed.items).not.toContainEqual(expect.objectContaining({ kind: "partial", partial: expect.objectContaining({ tool_call_id: "call-a" }) }));
});

test("resets transient live state when a runtime is taken over", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope); runtime.sendUser("hello");
  const changed = runtime.setScope({ ...scope, runtimeInstanceId: "runtime-b" });
  expect(changed.items.some((item) => item.kind === "pending" && item.delivery === "unknown_delivery")).toBe(false);
  expect(runtime.currentScope?.runtimeInstanceId).toBe("runtime-b");
});

test.each(["deviceId", "endpointId", "runtimeInstanceId", "sessionId", "selfSenderRef"] as const)("scopes unknown delivery when %s changes", (key) => {
  const runtime = new TimelineRuntime();
  runtime.prepareLive(scope, 0);
  runtime.commitReplacement();
  const sent = runtime.sendUser("Only for the original conversation")!;
  runtime.markDisconnected();
  const changed = runtime.prepareLive({ ...scope, [key]: "other" }, 0);
  expect(changed.change.items.filter((item) => item.kind === "pending")).toEqual([]);
  expect(runtime.retryUnknown(sent.frame.client_request_id)).toBeNull();
  runtime.invalidateScope();
  expect(runtime.retryUnknown(sent.frame.client_request_id)).toBeNull();
  runtime.prepareLive({ ...scope, channelId: "new-channel" }, 0);
  const returned = runtime.commitReplacement();
  const retained = key === "deviceId" || key === "endpointId";
  expect(returned.items.filter((item) => item.kind === "pending")).toHaveLength(retained ? 1 : 0);
  expect(runtime.retryUnknown(sent.frame.client_request_id)?.frame.channel_id ?? null).toBe(retained ? "new-channel" : null);
});

test("retains unknown delivery when the same session advances to another leaf", () => {
  const runtime = new TimelineRuntime();
  runtime.prepareLive(scope, 0);
  const sent = runtime.sendUser("Only for this session")!;
  runtime.markDisconnected();

  const nextLeaf = { ...scope, leafId: "next-leaf", channelId: "next-channel" };
  const prepared = runtime.prepareLive(nextLeaf, 0);
  expect(prepared.change.items).toContainEqual(expect.objectContaining({ kind: "pending", clientRequestId: sent.frame.client_request_id }));
  expect(runtime.retryUnknown(sent.frame.client_request_id)?.frame).toMatchObject({ leaf_id: nextLeaf.leafId, channel_id: nextLeaf.channelId });
});

test("a successful reconnect starts an empty live view and retains unknown delivery", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 10);
  runtime.commit({ ...userEvent("old"), event_seq: 11 });
  runtime.sendUser("unsure");
  runtime.markDisconnected();
  const resumed = runtime.beginLive(scope, 15);
  expect(resumed.items.filter((item) => item.kind === "event")).toEqual([]);
  expect(resumed.unknown).toHaveLength(1);
  expect(runtime.commit({ ...userEvent("delayed"), event_seq: 15 }).items.some((item) => item.kind === "event")).toBe(false);
  expect(runtime.commit({ ...userEvent("new"), event_seq: 16 }).items.filter((item) => item.kind === "event")).toHaveLength(1);
});

test("history prepends before concurrent live events by sequence even when clocks disagree", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 81);
  runtime.commit({ ...userEvent("live"), event_seq: 82, timestamp: 0 });
  const page = Array.from({ length: 80 }, (_, index) => ({ ...userEvent(`history-${index}`), event_seq: index + 2, timestamp: 1000 - index }));
  const result = runtime.prependHistory([...page].reverse());
  expect(result.items.flatMap((item) => item.kind === "event" ? [item.event.event_seq] : [])).toEqual(Array.from({ length: 81 }, (_, index) => index + 2));
  expect(runtime.isNewLiveEvent({ ...userEvent("live"), event_seq: 82 })).toBe(false);
});

test("unindexed local records remain readable but cannot enter a new live connection", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  expect(runtime.commit(userEvent("old-cache")).items).toEqual([]);
  expect(runtime.prependHistory([userEvent("old-cache")]).items).toHaveLength(1);
});

test("prepares a same-scope reconnect by preserving contiguous events and filling a 30-event gap", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.prependHistory(numberedUserEvents(1, 10));
  runtime.receive(partial("assistant", "partial-before-reconnect"));
  runtime.sendUser("unconfirmed");

  const prepared = runtime.prepareLive({ ...scope, channelId: "replacement-channel" }, 40);
  expect(prepared.plan).toEqual({ mode: "append", startSeq: 11, endSeq: 40, earliestSeq: 1 });
  expect(prepared.change.items.filter((item) => item.kind === "event").map((item) => item.event.event_seq)).toEqual(numberedUserEvents(1, 10).map((event) => event.event_seq));
  expect(prepared.change.items.some((item) => item.kind === "partial")).toBe(false);
  expect(prepared.change.unknown).toHaveLength(1);
  expect(runtime.currentScope?.channelId).toBe("replacement-channel");

  expect(runtime.commit({ ...userEvent("event-40"), event_seq: 40, timestamp: 40 }).items.filter((item) => item.kind === "event")).toHaveLength(10);
  runtime.prependHistory([...numberedUserEvents(11, 40)].reverse());
  const live = runtime.commit({ ...userEvent("event-41"), event_seq: 41, timestamp: 41 });
  expect(live.items.filter((item) => item.kind === "event").map((item) => item.event.event_seq)).toEqual(Array.from({ length: 41 }, (_, index) => index + 1));

  expect(runtime.prepareLive(scope, 41).plan).toEqual({ mode: "append", startSeq: null, endSeq: 41, earliestSeq: 1 });
});

test("uses a replacement plan for initial heads at zero, below the recent limit, and above it", () => {
  expect(new TimelineRuntime().prepareLive(scope, 0).plan).toEqual({ mode: "append", startSeq: null, endSeq: 0, earliestSeq: null });
  expect(new TimelineRuntime().prepareLive(scope, 7).plan).toEqual({ mode: "replace", startSeq: 1, endSeq: 7, earliestSeq: 1 });
  expect(new TimelineRuntime().prepareLive(scope, 30).plan).toEqual({ mode: "replace", startSeq: 1, endSeq: 30, earliestSeq: 1 });
  expect(new TimelineRuntime().prepareLive(scope, 31).plan).toEqual({ mode: "replace", startSeq: 2, endSeq: 31, earliestSeq: 2 });
});

test("falls back to replacement for large gaps, scope changes, and unsafe formal sequences", () => {
  const largeGap = new TimelineRuntime();
  largeGap.setScope(scope);
  largeGap.prependHistory(numberedUserEvents(1, 10));
  expect(largeGap.prepareLive(scope, 41).plan).toEqual({ mode: "replace", startSeq: 12, endSeq: 41, earliestSeq: 12 });

  const changedScope = new TimelineRuntime();
  changedScope.setScope(scope);
  changedScope.prependHistory(numberedUserEvents(1, 10));
  changedScope.sendUser("unconfirmed");
  const scopeReplacement = changedScope.prepareLive({ ...scope, runtimeInstanceId: "runtime-b" }, 10);
  expect(scopeReplacement.plan).toEqual({ mode: "replace", startSeq: 1, endSeq: 10, earliestSeq: 1 });
  expect(scopeReplacement.change.items.filter((item) => item.kind === "event")).toHaveLength(10);
  expect(scopeReplacement.change.unknown).toHaveLength(0);

  const nonContiguous = new TimelineRuntime();
  nonContiguous.setScope(scope);
  nonContiguous.prependHistory([numberedUserEvents(1, 1)[0], numberedUserEvents(3, 3)[0]]);
  expect(nonContiguous.prepareLive(scope, 3).plan.mode).toBe("replace");

  const unsequenced = new TimelineRuntime();
  unsequenced.setScope(scope);
  unsequenced.prependHistory([userEvent("legacy")]);
  expect(unsequenced.prepareLive(scope, 1).plan.mode).toBe("replace");

  const staleHead = new TimelineRuntime();
  staleHead.setScope(scope);
  staleHead.prependHistory(numberedUserEvents(1, 5));
  expect(staleHead.prepareLive(scope, 4).plan.mode).toBe("replace");
});

function attachment(attachmentId: string, overrides: Partial<AttachmentDescriptor> = {}): AttachmentDescriptor {
  return { attachment_id: attachmentId, file_name: `${attachmentId}.png`, mime_type: "image/png", byte_length: 4, sha256: "a".repeat(64), ...overrides };
}
function imagePreview(): AttachmentDescriptor["preview"] {
  return { mime_type: "image/jpeg", data: "aGk=", byte_length: 2, width: 8, height: 8 };
}

test("sends only attachment ids on the wire while keeping previews out of the frame", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const descriptors = [attachment("attachment-1", { preview: imagePreview() }), attachment("attachment-2", { byte_length: 8 })];
  const sent = runtime.sendUserWithAttachments("", descriptors, { clientRequestId: "req-1", requestId: "send-1" });
  expect(sent).toBeTruthy();
  expect(sent!.frame).toMatchObject({ text: "", client_request_id: "req-1", id: "send-1", attachment_ids: ["attachment-1", "attachment-2"] });
  expect(sent!.frame).not.toHaveProperty("images");
  const wire = JSON.stringify(sent!.frame);
  expect(wire).not.toContain("preview");
  expect(wire).not.toContain("byte_length");
  expect(wire).not.toContain("sha256");
  const pending = runtime.pendingItems.find((item) => item.clientRequestId === "req-1");
  expect(pending).toMatchObject({ text: "", attachments: descriptors, senderRef: scope.selfSenderRef });
  expect(pending?.attachments?.[0]?.preview).toEqual(imagePreview());
});

test("rejects attachment messages that break count, per-file, total, uniqueness, or descriptor rules", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const tooMany = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => attachment(`attachment-${index}`));
  const tooLargeTotal = [
    attachment("attachment-1", { byte_length: ATTACHMENT_MAX_FILE_BYTES }),
    attachment("attachment-2", { byte_length: ATTACHMENT_MAX_FILE_BYTES }),
    attachment("attachment-3", { byte_length: ATTACHMENT_MAX_MESSAGE_BYTES - ATTACHMENT_MAX_FILE_BYTES * 2 + 1 }),
  ];
  expect(runtime.sendUserWithAttachments("x", [])).toBeNull();
  expect(runtime.sendUserWithAttachments("x", tooMany)).toBeNull();
  expect(runtime.sendUserWithAttachments("x", [attachment("attachment-1"), attachment("attachment-1")])).toBeNull();
  expect(runtime.sendUserWithAttachments("x", [attachment("attachment-1", { file_name: "bad\nname.png" })])).toBeNull();
  expect(runtime.sendUserWithAttachments("x", [attachment("attachment-1", { byte_length: ATTACHMENT_MAX_FILE_BYTES + 1 })])).toBeNull();
  expect(runtime.sendUserWithAttachments("x", tooLargeTotal)).toBeNull();
  expect(runtime.sendUserWithAttachments("x", [{ ...attachment("attachment-1"), extra: true } as unknown as AttachmentDescriptor])).toBeNull();
  expect(runtime.pendingItems).toEqual([]);
});

test("counts display previews against the pending payload budget", () => {
  const plain = attachment("attachment-1");
  const withPreview = attachment("attachment-1", { preview: imagePreview() });
  expect(pendingPayloadBytes({ text: "", attachments: [withPreview] })).toBeGreaterThan(pendingPayloadBytes({ text: "", attachments: [plain] }));
  const rejecting = new TimelineRuntime({ maxPayloadBytes: pendingPayloadBytes({ text: "", attachments: [plain] }) });
  rejecting.setScope(scope);
  expect(() => rejecting.sendUserWithAttachments("", [withPreview])).toThrow(PendingCapacityError);
  expect(rejecting.pendingItems).toEqual([]);
  const allowing = new TimelineRuntime({ maxPayloadBytes: pendingPayloadBytes({ text: "", attachments: [withPreview] }) });
  allowing.setScope(scope);
  expect(allowing.sendUserWithAttachments("", [withPreview])).toBeTruthy();
});

test("retries unknown image and attachment deliveries with their original request correlation", () => {
  const imageRuntime = new TimelineRuntime(); imageRuntime.setScope(scope);
  const images = [{ mime: "image/png" as const, data: "abc" }];
  expect(imageRuntime.sendUser("caption", images, { clientRequestId: "img", requestId: "img-send" })).toBeTruthy();
  imageRuntime.markUnknownDelivery("img");
  const imageRetried = imageRuntime.retryUnknown("img")!;
  expect(imageRetried.frame).toMatchObject({ client_request_id: "img", images });
  expect(imageRetried.frame.id).not.toBe("img-send");
  expect(imageRetried.frame).not.toHaveProperty("attachment_ids");

  const attachmentRuntime = new TimelineRuntime(); attachmentRuntime.setScope(scope);
  const descriptor = attachment("attachment-1", { preview: imagePreview() });
  const attachmentSent = attachmentRuntime.sendUserWithAttachments("", [descriptor], { clientRequestId: "req-1", requestId: "send-1" })!;
  expect(attachmentSent.frame.attachment_ids).toEqual(["attachment-1"]);
  attachmentRuntime.markUnknownDelivery("req-1");
  const retried = attachmentRuntime.retryUnknown("req-1")!;
  expect(retried.frame).toMatchObject({ client_request_id: "req-1", attachment_ids: ["attachment-1"] });
  expect(retried.frame.id).not.toBe("send-1");
  expect(retried.frame).not.toHaveProperty("images");
  expect(attachmentRuntime.pendingItems[0]).toMatchObject({ clientRequestId: "req-1", attachments: [descriptor] });
});

const previewTarget = { deviceId: scope.deviceId, endpointId: scope.endpointId, sessionId: scope.sessionId };

test("switching Pi drops the previous projection at once and keeps its unknown delivery for a return", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.prependHistory(numberedUserEvents(1, 3));
  const sent = runtime.sendUser("unsure")!;
  expect(runtime.detachLive().items).toEqual([]);
  expect(runtime.currentScope).toBeNull();
  const other = runtime.prepareLive({ ...scope, endpointId: "other-endpoint", runtimeInstanceId: "runtime-other", sessionId: "other-session" }, 0);
  expect(other.change.items).toEqual([]);

  runtime.detachLive();
  runtime.prepareLive({ ...scope, channelId: "return-channel" }, 0);
  runtime.commitReplacement();
  expect(runtime.retryUnknown(sent.frame.client_request_id)?.frame.channel_id).toBe("return-channel");
});

test("a local preview of the same session becomes the retained projection for an incremental handshake", () => {
  const runtime = new TimelineRuntime();
  const shown = runtime.showPreview(previewTarget, numberedUserEvents(1, 10));
  expect(shown?.items.filter((item) => item.kind === "event")).toHaveLength(10);
  expect(runtime.previewing).toBe(true);
  expect(runtime.sendUser("before the handshake")).toBeNull();

  const prepared = runtime.prepareLive(scope, 12);
  expect(prepared.plan).toEqual({ mode: "append", startSeq: 11, endSeq: 12, earliestSeq: 1 });
  expect(prepared.change.items.filter((item) => item.kind === "event")).toHaveLength(10);
  expect(runtime.previewing).toBe(false);
});

test("a local preview of another session is dropped before the new session loads", () => {
  const runtime = new TimelineRuntime();
  runtime.showPreview(previewTarget, numberedUserEvents(1, 10));
  const prepared = runtime.prepareLive({ ...scope, sessionId: "new-session" }, 5);
  expect(prepared.plan).toEqual({ mode: "replace", startSeq: 1, endSeq: 5, earliestSeq: 1 });
  expect(prepared.change.items).toEqual([]);
  expect(runtime.previewing).toBe(false);
});

test("ignores a late or empty preview and drops it when the timeline is cleared", () => {
  const live = new TimelineRuntime();
  live.prepareLive(scope, 0);
  expect(live.showPreview(previewTarget, numberedUserEvents(1, 2))).toBeNull();
  expect(new TimelineRuntime().showPreview(previewTarget, [])).toBeNull();

  const cleared = new TimelineRuntime();
  cleared.showPreview(previewTarget, numberedUserEvents(1, 2));
  expect(cleared.clear().items).toEqual([]);
  expect(cleared.previewing).toBe(false);
});
