import { expect, test, vi } from "vitest";
import { DELIVERY_STATUS_QUERY_TIMEOUT_MS, USER_MESSAGE_CONFIRMATION_TIMEOUT_MS, PendingCapacityError, TimelineRuntime, type TimelineScope } from "./timeline-runtime";
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
  const streaming = runtime.receive({ ...partial("assistant", "pi-marker-entry:assistant:0"), leaf_id: markerLeaf });
  expect(streaming.items).toContainEqual(expect.objectContaining({ kind: "partial", partial: expect.objectContaining({ delta: "streaming" }) }));
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
  const streaming = runtime.receive({ ...partial("assistant", "pi-entry:assistant:0"), leaf_id: "stream-leaf" });
  expect(streaming.items).toContainEqual(expect.objectContaining({ kind: "partial", partial: expect.objectContaining({ partial_id: "pi-entry:assistant:0", delta: "streaming" }) }));
  expect(runtime.currentScope?.leafId).toBe(scope.leafId);
  const formal = { event_id: "pi-entry", event_seq: 1, session_id: scope.sessionId, leaf_id: "formal-leaf", timestamp: 3, group_id: "group", kind: "assistant" as const, status: "complete" as const, blocks: [{ type: "text" as const, text: "done" }] };
  const changed = runtime.receive({ protocol_version: 2, type: "timeline_event", session_id: scope.sessionId, leaf_id: "formal-leaf", event: formal });
  expect(changed.items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(runtime.currentScope?.leafId).toBe("formal-leaf");
  expect(runtime.receive({ ...partial("assistant", "pi-entry:assistant:0"), leaf_id: "stream-leaf" }).items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(runtime.receive({ ...partial("assistant", "foreign:assistant:0"), session_id: "other-session", leaf_id: "other-leaf" }).items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(runtime.currentScope?.leafId).toBe("formal-leaf");
});

test.each(["assistant", "thinking", "tool"] as const)("receives %s partials across moving leaves without advancing the formal tip", (kind) => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const frame = kind === "tool" ? toolPartial("moving-tool") : partial(kind, `moving-message:${kind}:0`);
  const first = runtime.receive({ ...frame, leaf_id: "marker-leaf" });
  expect(first.items.filter((item) => item.kind === "partial")).toHaveLength(1);
  const second = runtime.receive({ ...frame, leaf_id: "next-marker-leaf" });
  expect(second.items).toContainEqual(expect.objectContaining({ kind: "partial", partial: expect.objectContaining({ kind, leaf_id: "next-marker-leaf", ...(kind === "tool" ? {} : { delta: "streamingstreaming" }) }) }));
  expect(runtime.currentScope?.leafId).toBe(scope.leafId);

  const event: TimelineEvent = kind === "tool"
    ? { ...toolEvent("moving-tool"), event_seq: 1, leaf_id: "formal-leaf" }
    : { event_id: "moving-message", event_seq: 1, session_id: scope.sessionId, leaf_id: "formal-leaf", timestamp: 3, group_id: "group", kind: "assistant", status: "complete", blocks: [{ type: kind === "thinking" ? "thinking" : "text", text: "streamingstreaming" }] };
  const completed = runtime.commit(event);
  expect(completed.items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(runtime.receive({ ...frame, leaf_id: "next-marker-leaf" }).items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(runtime.currentScope?.leafId).toBe("formal-leaf");
});

test.each(["branch reset", "session change", "runtime takeover", "reconnect"] as const)("clears moving-leaf partials on %s", (boundary) => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const frame = { ...partial("assistant", "before-boundary:assistant:0"), leaf_id: "marker-leaf" };
  expect(runtime.receive(frame).items.filter((item) => item.kind === "partial")).toHaveLength(1);

  if (boundary === "branch reset") {
    runtime.receive({ protocol_version: 2, type: "reset", target_channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: "new-branch-leaf", reason: "branch_changed" });
    expect(runtime.receive(frame).items.filter((item) => item.kind === "partial")).toEqual([]);
    runtime.beginLive({ ...scope, leafId: "new-branch-leaf" }, 0);
  } else if (boundary === "session change") {
    runtime.beginLive({ ...scope, sessionId: "other-session" }, 0);
    expect(runtime.receive(frame).items.filter((item) => item.kind === "partial")).toEqual([]);
  } else if (boundary === "runtime takeover") {
    runtime.beginLive({ ...scope, runtimeInstanceId: "other-runtime" }, 0);
  } else {
    runtime.markDisconnected();
    runtime.beginLive({ ...scope, channelId: "new-channel" }, 0);
  }
  expect(runtime.commitReplacement().items.filter((item) => item.kind === "partial")).toEqual([]);
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
  // 旧目标的未确认内容保留为只读，不能转投新 runtime。
  expect(changed.items.find((item) => item.kind === "pending")).toMatchObject({ delivery: "unknown_delivery", scopeInvalid: true });
  expect(runtime.currentScope?.runtimeInstanceId).toBe("runtime-b");
});

test.each(["deviceId", "endpointId", "runtimeInstanceId", "sessionId", "selfSenderRef"] as const)("retains unknown delivery read-only when %s changes", (key) => {
  const runtime = new TimelineRuntime();
  runtime.prepareLive(scope, 0);
  runtime.commitReplacement();
  const sent = runtime.sendUser("Only for the original conversation")!;
  runtime.markDisconnected();
  runtime.prepareLive({ ...scope, [key]: "other" }, 0);
  if (key === "deviceId" || key === "endpointId") {
    // 切换到另一个 Pi 只撤下投影；原目标内容保留，切回时仍可核对。
    expect(runtime.pendingItems).toHaveLength(0);
    expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)).toBeNull();
    runtime.prepareLive({ ...scope, channelId: "new-channel" }, 0);
    const returned = runtime.commitReplacement();
    expect(returned.items.filter((item) => item.kind === "pending")).toHaveLength(1);
    expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)?.frame.channel_id).toBe("new-channel");
    return;
  }
  // runtime／session／Owner 变化代表原目标失效：内容只读保留，不能再次发送或核对。
  expect(runtime.pendingItems.filter((item) => item.kind === "pending")).toHaveLength(1);
  expect(runtime.pendingItems.find((item) => item.kind === "pending")).toMatchObject({ scopeInvalid: true });
  expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)).toBeNull();
  runtime.invalidateScope();
  expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)).toBeNull();
  runtime.prepareLive({ ...scope, channelId: "new-channel" }, 0);
  const returned = runtime.commitReplacement();
  expect(returned.items.filter((item) => item.kind === "pending")).toHaveLength(1);
  expect(returned.items.find((item) => item.kind === "pending")).toMatchObject({ scopeInvalid: true });
  expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)).toBeNull();
});

test("retains unknown delivery when the same session advances to another leaf", () => {
  const runtime = new TimelineRuntime();
  runtime.prepareLive(scope, 0);
  const sent = runtime.sendUser("Only for this session")!;
  runtime.markDisconnected();

  const nextLeaf = { ...scope, leafId: "next-leaf", channelId: "next-channel" };
  const prepared = runtime.prepareLive(nextLeaf, 0);
  expect(prepared.change.items).toContainEqual(expect.objectContaining({ kind: "pending", clientRequestId: sent.frame.client_request_id }));
  expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)?.frame).toMatchObject({ type: "user_message_status_request", leaf_id: nextLeaf.leafId, channel_id: nextLeaf.channelId });
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

test("flags a same-session head below the retained projection as a sequence regression", () => {
  const regressed = new TimelineRuntime();
  regressed.setScope(scope);
  regressed.prependHistory(numberedUserEvents(1, 10));
  const lower = regressed.prepareLive({ ...scope, runtimeInstanceId: "runtime-b" }, 5);
  expect(lower.plan.mode).toBe("replace");
  expect(lower.sequenceRegressed).toBe(true);

  const otherSession = new TimelineRuntime();
  otherSession.setScope(scope);
  otherSession.prependHistory(numberedUserEvents(1, 10));
  expect(otherSession.prepareLive({ ...scope, sessionId: "session-b" }, 5).sequenceRegressed).toBe(false);
});

test("falls back to replacement for large gaps, scope changes, and unsafe formal sequences", () => {
  const largeGap = new TimelineRuntime();
  largeGap.setScope(scope);
  largeGap.prependHistory(numberedUserEvents(1, 10));
  const largeGapPreparation = largeGap.prepareLive(scope, 41);
  expect(largeGapPreparation.plan).toEqual({ mode: "replace", startSeq: 12, endSeq: 41, earliestSeq: 12 });
  expect(largeGapPreparation.sequenceRegressed).toBe(false);

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

test("retries explicitly failed image and attachment deliveries with their original request correlation", () => {
  const imageRuntime = new TimelineRuntime(); imageRuntime.setScope(scope);
  const images = [{ mime: "image/png" as const, data: "abc" }];
  expect(imageRuntime.sendUser("caption", images, { clientRequestId: "img", requestId: "img-send" })).toBeTruthy();
  imageRuntime.markDeliveryFailed("img", "transport_unavailable", true);
  const imageRetried = imageRuntime.retryFailed("img")!;
  expect(imageRetried.frame).toMatchObject({ client_request_id: "img", images });
  expect(imageRetried.frame.id).not.toBe("img-send");
  expect(imageRetried.frame).not.toHaveProperty("attachment_ids");

  const attachmentRuntime = new TimelineRuntime(); attachmentRuntime.setScope(scope);
  const descriptor = attachment("attachment-1", { preview: imagePreview() });
  const attachmentSent = attachmentRuntime.sendUserWithAttachments("", [descriptor], { clientRequestId: "req-1", requestId: "send-1" })!;
  expect(attachmentSent.frame.attachment_ids).toEqual(["attachment-1"]);
  attachmentRuntime.markDeliveryFailed("req-1", "transport_unavailable", true);
  const retried = attachmentRuntime.retryFailed("req-1")!;
  expect(retried.frame).toMatchObject({ client_request_id: "req-1", attachment_ids: ["attachment-1"] });
  expect(retried.frame.id).not.toBe("send-1");
  expect(retried.frame).not.toHaveProperty("images");
  expect(attachmentRuntime.pendingItems[0]).toMatchObject({ clientRequestId: "req-1", attachments: [descriptor] });
});

function deliveryReply(frame: { id: string; client_request_id: string }) {
  return { protocol_version: 2 as const, type: "user_message_status" as const, target_channel_id: scope.channelId,
    in_reply_to: frame.id, client_request_id: frame.client_request_id, session_id: scope.sessionId, leaf_id: scope.leafId };
}

test("normal sends have no failure and only explicit retryable failures can retry with the same identity", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("original")!;
  const pending = runtime.pendingItems[0];
  expect(pending.deliveryFailure).toBeUndefined();
  expect(runtime.retryFailed(pending.clientRequestId)).toBeNull();
  runtime.markDeliveryFailed(pending.clientRequestId, "transport_unavailable", true);
  expect(runtime.pendingItems[0]).toBe(pending);
  expect(pending).toMatchObject({ delivery: "failed", deliveryFailure: { code: "transport_unavailable", retryable: true } });
  const retry = runtime.retryFailed(pending.clientRequestId)!;
  expect(runtime.pendingItems).toEqual([pending]);
  expect(retry.frame).toMatchObject({ client_request_id: sent.frame.client_request_id, text: "original" });
  expect(retry.frame.id).not.toBe(sent.frame.id);
  expect(pending.deliveryFailure).toBeUndefined();
  expect(pending.delivery).toBe("pending");
  expect(runtime.retryFailed(pending.clientRequestId)).toBeNull();
  runtime.receive({ ...deliveryReply(sent.frame), status: "rejected", code: "queue_full", retryable: true });
  expect(pending.delivery).toBe("pending");
  runtime.markDeliveryFailed(pending.clientRequestId, "invalid_target", false);
  expect(runtime.retryFailed(pending.clientRequestId)).toBeNull();
});

test("queries are read-only, synchronously deduplicate, and expire without enabling a resend", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("unsure")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const pending = runtime.pendingItems[0];
  const query = runtime.requestDeliveryStatus(pending.clientRequestId)!;
  expect(query.frame).toMatchObject({ type: "user_message_status_request", client_request_id: pending.clientRequestId });
  expect(query.frame).not.toHaveProperty("text");
  expect(runtime.requestDeliveryStatus(pending.clientRequestId)).toBeNull();
  const deadline = pending.statusQuery!.requestedAt + DELIVERY_STATUS_QUERY_TIMEOUT_MS;
  runtime.expireDeliveryStatusQueries(deadline - 1);
  expect(pending.statusQuery).toBeDefined();
  runtime.expireDeliveryStatusQueries(deadline);
  expect(pending.statusQuery).toBeUndefined();
  expect(pending.delivery).toBe("unknown_delivery");
  expect(runtime.retryFailed(pending.clientRequestId)).toBeNull();
  expect(runtime.requestDeliveryStatus(pending.clientRequestId)).not.toBeNull();
  expect(runtime.pendingItems).toEqual([pending]);
});

test("confirmation expires at 30 seconds and received starts a new bounded window", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const runtime = new TimelineRuntime(); runtime.setScope(scope);
    const sent = runtime.sendUser("hello")!;
    const pending = runtime.pendingItems[0];
    runtime.expireDeliveryConfirmations(1_000 + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS - 1);
    expect(pending.delivery).toBe("pending");
    clock.mockReturnValue(20_000);
    runtime.receive({ ...deliveryReply(sent.frame), status: "received" });
    runtime.expireDeliveryConfirmations(1_000 + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS);
    expect(pending.delivery).toBe("received");
    runtime.expireDeliveryConfirmations(20_000 + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS);
    expect(pending.delivery).toBe("unknown_delivery");
    expect(runtime.pendingItems[0]).toBe(pending);
    expect(pending.deliveryFailure).toBeUndefined();
  } finally { clock.mockRestore(); }
});

test("active queries defer confirmation expiry without creating new pending", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  const pending = runtime.pendingItems[0];
  runtime.requestDeliveryStatus(sent.frame.client_request_id);
  runtime.expireDeliveryConfirmations(pending.createdAt + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS);
  expect(pending.delivery).toBe("pending");
  runtime.clearDeliveryStatusQuery(pending.clientRequestId);
  runtime.expireDeliveryConfirmations(pending.createdAt + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS);
  expect(pending.delivery).toBe("unknown_delivery");
  expect(runtime.pendingItems).toEqual([pending]);
});

test("disconnect marks unconfirmed sends unknown but preserves started, committed and explicit failure evidence", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const unconfirmed = runtime.sendUser("unconfirmed")!;
  const started = runtime.sendUser("started")!;
  const committed = runtime.sendUser("committed")!;
  const failed = runtime.sendUser("failed")!;
  runtime.receive({ ...deliveryReply(started.frame), status: "accepted", message_id: "started-message" });
  runtime.receive({ ...deliveryReply(committed.frame), status: "committed", message_id: "committed-message" });
  runtime.markDeliveryFailed(failed.frame.client_request_id, "transport_unavailable", true);
  runtime.requestDeliveryStatus(unconfirmed.frame.client_request_id);
  runtime.markDisconnected();
  expect(runtime.findPendingOrUnknown(unconfirmed.frame.client_request_id)).toMatchObject({ delivery: "unknown_delivery", text: "unconfirmed" });
  expect(runtime.findPendingOrUnknown(unconfirmed.frame.client_request_id)?.statusQuery).toBeUndefined();
  expect(runtime.findPendingOrUnknown(started.frame.client_request_id)).toMatchObject({ delivery: "accepted", messageId: "started-message" });
  expect(runtime.findPendingOrUnknown(committed.frame.client_request_id)).toMatchObject({ delivery: "committed", messageId: "committed-message" });
  expect(runtime.findPendingOrUnknown(failed.frame.client_request_id)?.delivery).toBe("failed");
});

test.each(["received", "accepted", "committed"] as const)("query %s replies recover the original unknown object", (status) => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const pending = runtime.pendingItems[0];
  const query = runtime.requestDeliveryStatus(pending.clientRequestId)!;
  runtime.receive(status === "committed"
    ? { ...deliveryReply(query.frame), status, message_id: "committed-message" }
    : { ...deliveryReply(query.frame), status });
  expect(runtime.pendingItems).toEqual([pending]);
  expect(pending.delivery).toBe(status);
  expect(pending.statusQuery).toBeUndefined();
  expect(runtime.clearDeliveryStatusQuery(pending.clientRequestId).unknown).toEqual([]);
});

test.each(["accepted", "committed", "started"] as const)("%s evidence cannot be downgraded by late receipts or queries", (evidence) => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  const query = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  if (evidence === "started") runtime.receive({ protocol_version: 2, type: "user_message_started", target_channel_id: scope.channelId,
    in_reply_to: sent.frame.id, session_id: scope.sessionId, leaf_id: scope.leafId,
    message: { id: "formal", group_id: "group", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal" } });
  else runtime.receive({ ...deliveryReply(sent.frame), status: evidence, message_id: "formal" });
  const expected = evidence === "committed" ? "committed" : "accepted";
  for (const frame of [sent.frame, query.frame]) {
    runtime.receive({ ...deliveryReply(frame), status: "received" });
    runtime.receive({ ...deliveryReply(frame), status: "unknown_delivery" });
    runtime.receive({ ...deliveryReply(frame), status: "not_found" });
    runtime.receive({ ...deliveryReply(frame), status: "rejected", code: "queue_full", retryable: true });
    runtime.receive({ ...deliveryReply(frame), status: "cancelled" });
  }
  expect(runtime.pendingItems[0]).toMatchObject({ messageId: "formal", delivery: expected });
  expect(runtime.pendingItems[0].statusQuery).toBeUndefined();
  runtime.commit(userEvent("formal"));
  runtime.receive({ ...deliveryReply(query.frame), status: "received" });
  runtime.receive({ ...deliveryReply(sent.frame), status: "not_found" });
  expect(runtime.pendingItems).toEqual([]);
});

test("not_found never opens retries and stale query failures cannot undo newer acceptance", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const query = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  runtime.receive({ ...deliveryReply(query.frame), status: "not_found" });
  expect(runtime.pendingItems[0].delivery).toBe("unknown_delivery");
  expect(runtime.pendingItems[0].statusQuery).toBeUndefined();
  expect(runtime.retryFailed(sent.frame.client_request_id)).toBeNull();
  const nextQuery = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  runtime.receive({ ...deliveryReply(sent.frame), status: "accepted" });
  runtime.receive({ ...deliveryReply(nextQuery.frame), status: "rejected", code: "queue_full", retryable: true });
  expect(runtime.pendingItems[0].delivery).toBe("accepted");
});

test("rejected query results become explicit failures and cancelled only settles queued messages once", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  const query = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  runtime.receive({ ...deliveryReply(query.frame), status: "rejected", code: "queue_full", retryable: true });
  expect(runtime.pendingItems[0]).toMatchObject({ delivery: "failed", deliveryFailure: { code: "queue_full", retryable: true } });
  runtime.receive({ ...deliveryReply(sent.frame), status: "cancelled" });
  expect(runtime.pendingItems).toHaveLength(1);
  runtime.receive({ protocol_version: 2, type: "queued_message_state", session_id: scope.sessionId, leaf_id: scope.leafId,
    snapshot_id: "queued", chunk_index: 0, final: true,
    items: [{ id: sent.frame.client_request_id, sender_ref: scope.selfSenderRef, text: "hello", editable: true, created_at: 1 }] });
  runtime.actOnQueued(sent.frame.client_request_id, "cancel");
  const cancellation = runtime.receive({ ...deliveryReply(sent.frame), status: "cancelled" });
  expect(cancellation.cancelledQueued).toEqual([expect.objectContaining({ clientRequestId: sent.frame.client_request_id, text: "hello" })]);
  expect(runtime.receive({ ...deliveryReply(sent.frame), status: "cancelled" }).cancelledQueued).toBeUndefined();
  expect(runtime.pendingItems).toEqual([expect.objectContaining({ delivery: "cancelled", clientRequestId: sent.frame.client_request_id })]);
  expect(runtime.confirmCancelledRestore([sent.frame.client_request_id]).items.filter((item) => item.kind === "pending")).toEqual([]);
});

test("a reconnected target can check status again after an old extension reported unsupported", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const query = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: query.frame.id,
    target_channel_id: scope.channelId, code: "protocol_upgrade_required", message: "Protocol v2 is required" });
  expect(runtime.pendingItems[0].statusQueryUnsupported).toBe(true);
  runtime.markDisconnected();
  runtime.setScope({ ...scope, channelId: "reconnected" });
  expect(runtime.pendingItems[0].statusQueryUnsupported).toBeUndefined();
  expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)).not.toBeNull();
});

test("old-extension query errors retain unknown without clearing the current scope", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const query = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  runtime.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId,
    in_reply_to: "unrelated", code: "protocol_upgrade_required", message: "Update required" });
  expect(runtime.pendingItems[0].statusQuery).toBeDefined();
  runtime.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId,
    in_reply_to: query.frame.id, code: "protocol_upgrade_required", message: "Update required" });
  expect(runtime.pendingItems[0]).toMatchObject({ delivery: "unknown_delivery", statusQueryUnsupported: true });
  expect(runtime.pendingItems[0].statusQuery).toBeUndefined();
  expect(runtime.currentScope).toEqual(scope);
  expect(runtime.retryFailed(sent.frame.client_request_id)).toBeNull();
});

function queryError(requestId: string): Extract<ServerFrame, { type: "protocol_error" }> {
  return { protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId,
    in_reply_to: requestId, code: "protocol_upgrade_required", message: "Update required" };
}

function expiredQuery(runtime: TimelineRuntime) {
  runtime.setScope(scope);
  const sent = runtime.sendUser("keep this message")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const query = runtime.requestDeliveryStatus(sent.frame.client_request_id)!;
  runtime.expireDeliveryStatusQueries(runtime.pendingItems[0].statusQuery!.requestedAt + DELIVERY_STATUS_QUERY_TIMEOUT_MS);
  return { sent, query, pending: runtime.pendingItems[0] };
}

test("delivery query late upgrade errors still update the current unknown after timeout", () => {
  const runtime = new TimelineRuntime();
  const { query, pending } = expiredQuery(runtime);
  runtime.receive(queryError(query.frame.id));
  expect(pending).toMatchObject({ delivery: "unknown_delivery", statusQueryUnsupported: true });
  expect(runtime.currentScope).toEqual(scope);
});

test("delivery query old errors do not clear a newer query even in the same millisecond", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const runtime = new TimelineRuntime();
    const { query, pending } = expiredQuery(runtime);
    const next = runtime.requestDeliveryStatus(pending.clientRequestId)!;
    expect(runtime.consumeDeliveryStatusError(queryError(query.frame.id))).not.toBeNull();
    expect(pending.statusQuery?.requestId).toBe(next.frame.id);
    expect(pending.statusQueryUnsupported).toBeUndefined();
    runtime.receive(queryError(query.frame.id));
    expect(pending.statusQuery?.requestId).toBe(next.frame.id);
  } finally { clock.mockRestore(); }
});

test.each(["attempt", "accepted", "not_found", "queue", "cancelled", "started", "formal"] as const)("delivery query late errors cannot overwrite newer %s evidence in the same millisecond", (evidence) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const runtime = new TimelineRuntime();
    const { sent, query, pending } = expiredQuery(runtime);
    if (evidence === "attempt") {
      runtime.markDeliveryFailed(pending.clientRequestId, "transport_unavailable", true);
      runtime.retryFailed(pending.clientRequestId);
      runtime.markUnknownDelivery(pending.clientRequestId);
    } else if (evidence === "queue") {
      runtime.receive(ownQueueSnapshot("new-evidence", [{ id: pending.clientRequestId, text: pending.text,
        sender_ref: scope.selfSenderRef, editable: true, created_at: 1 }]));
      runtime.markUnknownDelivery(pending.clientRequestId);
    } else if (evidence === "started" || evidence === "formal") {
      runtime.receive({ ...deliveryReply(sent.frame), type: "user_message_started", message: {
        id: "formal", group_id: "group", blocks: [{ type: "text", text: pending.text }],
        origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal",
      } });
      if (evidence === "formal") runtime.commit(userEvent("formal"));
    } else {
      runtime.receive({ ...deliveryReply(sent.frame), status: evidence });
      if (evidence === "accepted") runtime.markUnknownDelivery(pending.clientRequestId);
    }
    const before = JSON.stringify(pending);
    expect(runtime.consumeDeliveryStatusError(queryError(query.frame.id))).not.toBeNull();
    expect(JSON.stringify(pending)).toBe(before);
  } finally { clock.mockRestore(); }
});

test.each(["disconnect", "clear", "handshake", "reset", "session", "owner"] as const)("delivery query associations clear on %s", (boundary) => {
  const runtime = new TimelineRuntime();
  const { query } = expiredQuery(runtime);
  if (boundary === "disconnect") runtime.markDisconnected();
  if (boundary === "clear") runtime.clear();
  if (boundary === "handshake") runtime.setScope(scope);
  if (boundary === "reset") runtime.invalidateScope();
  if (boundary === "session") runtime.setScope({ ...scope, sessionId: "next" });
  if (boundary === "owner") runtime.setScope({ ...scope, selfSenderRef: "next" });
  expect(runtime.consumeDeliveryStatusError(queryError(query.frame.id))).toBeNull();
});

test("delivery query associations are bounded by capacity and TTL and ignore unrelated errors", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const runtime = new TimelineRuntime();
    const { query, pending } = expiredQuery(runtime);
    expect(runtime.consumeDeliveryStatusError(queryError("unrelated"))).toBeNull();
    expect(runtime.consumeDeliveryStatusError({ ...queryError(query.frame.id), target_channel_id: "other" })).toBeNull();
    for (let index = 0; index < 128; index++) {
      runtime.requestDeliveryStatus(pending.clientRequestId);
      runtime.expireDeliveryStatusQueries(1_000 + DELIVERY_STATUS_QUERY_TIMEOUT_MS);
    }
    expect(runtime.consumeDeliveryStatusError(queryError(query.frame.id))).toBeNull();
    const latest = runtime.requestDeliveryStatus(pending.clientRequestId)!;
    clock.mockReturnValue(61_000);
    expect(runtime.consumeDeliveryStatusError(queryError(latest.frame.id))).toBeNull();
  } finally { clock.mockRestore(); }
});

test("delivery query associations survive ordinary leaf advancement", () => {
  const runtime = new TimelineRuntime();
  const { query, pending } = expiredQuery(runtime);
  runtime.commit({ ...userEvent("other"), event_seq: 1, leaf_id: "next-leaf" });
  expect(runtime.consumeDeliveryStatusError(queryError(query.frame.id))).not.toBeNull();
  expect(pending.statusQueryUnsupported).toBe(true);
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
  expect(runtime.requestDeliveryStatus(sent.frame.client_request_id)?.frame.channel_id).toBe("return-channel");
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
  expect(prepared.previewMatched).toBe(true);
  expect(runtime.previewing).toBe(false);
});

test("a local preview of another session is dropped before the new session loads", () => {
  const runtime = new TimelineRuntime();
  runtime.showPreview(previewTarget, numberedUserEvents(1, 10));
  const prepared = runtime.prepareLive({ ...scope, sessionId: "new-session" }, 5);
  expect(prepared.plan).toEqual({ mode: "replace", startSeq: 1, endSeq: 5, earliestSeq: 1 });
  expect(prepared.change.items).toEqual([]);
  expect(prepared.previewMatched).toBe(false);
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

test("a read-only history shows saved records with gaps and accepts nothing live", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope({ ...scope, runtimeInstanceId: "runtime-old" });
  runtime.sendUser("unsure");
  // 同一个 Pi 的会话被接管后，旧消息只读保留；它不属于历史，不能显示在历史里。
  runtime.setScope(scope);
  const saved = [...numberedUserEvents(1, 2), ...numberedUserEvents(7, 8)];
  const shown = runtime.showReadOnly(saved);
  expect(shown.items.map((item) => item.kind === "event" ? item.event.event_seq : item.kind)).toEqual([1, 2, 7, 8]);
  expect(runtime.readOnlyView).toBe(true);
  expect(runtime.currentScope).toBeNull();
  expect(runtime.sendUser("from history")).toBeNull();

  const live = { ...userEvent("live"), event_seq: 9 };
  const frames: ServerFrame[] = [
    { protocol_version: 2, type: "timeline_event", session_id: scope.sessionId, leaf_id: scope.leafId, event: live },
    partial("assistant", "streaming"),
    { protocol_version: 2, type: "reset", target_channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: "other", reason: "branch_changed" },
  ];
  for (const frame of frames) {
    expect(runtime.acceptsTimelineFrame(frame)).toBe(false);
    expect(runtime.receive(frame).items).toHaveLength(4);
  }
  expect(runtime.commit(live).items).toHaveLength(4);

  // 向前展开的页并入同一只读投影。
  expect(runtime.prependHistory(numberedUserEvents(3, 4)).items).toHaveLength(6);
});

test("leaving a read-only history never reuses it as the live baseline", () => {
  const runtime = new TimelineRuntime();
  runtime.showReadOnly(numberedUserEvents(1, 10));
  const prepared = runtime.prepareLive(scope, 12);
  expect(prepared.plan).toEqual({ mode: "replace", startSeq: 1, endSeq: 12, earliestSeq: 1 });
  expect(prepared.change.items).toEqual([]);
  expect(runtime.readOnlyView).toBe(false);

  const detached = new TimelineRuntime();
  detached.showReadOnly(numberedUserEvents(1, 3));
  expect(detached.detachLive().items).toEqual([]);
  expect(detached.readOnlyView).toBe(false);
  expect(detached.showPreview(previewTarget, numberedUserEvents(1, 2))?.items).toHaveLength(2);
});

function ownQueueSnapshot(snapshotId: string, items: Extract<ServerFrame, { type: "queued_message_state" }>["items"], channel = scope): Extract<ServerFrame, { type: "queued_message_state" }> {
  return { protocol_version: 2, type: "queued_message_state", session_id: channel.sessionId, leaf_id: channel.leafId, snapshot_id: snapshotId, chunk_index: 0, final: true, items };
}

test("disconnecting during an unfinished replacement keeps restored queue content checkable on the same target", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const image = [{ mime: "image/png", data: "abc" }];
  runtime.sendUser("queued while offline", image, { clientRequestId: "own", requestId: "send" });
  runtime.markDisconnected();
  const reconnect = { ...scope, channelId: "second" };
  expect(runtime.prepareLive(reconnect, 5).plan.mode).toBe("replace");
  runtime.receive(ownQueueSnapshot("during-replacement", [{ id: "own", text: "queued while offline", images: image, sender_ref: scope.selfSenderRef, editable: true, created_at: 1 }], reconnect));
  expect(runtime.replacing).toBe(true);
  // 替换未完成就断线只是投影放弃，不能证明目标失效，更不能丢掉正文与图片。
  runtime.markDisconnected();
  const third = { ...scope, channelId: "third" };
  runtime.prepareLive(third, 5);
  const restored = runtime.commitReplacement().items.filter((item) => item.kind === "pending");
  expect(restored).toEqual([expect.objectContaining({ clientRequestId: "own", text: "queued while offline", images: image, delivery: "unknown_delivery" })]);
  expect(restored[0]).not.toHaveProperty("scopeInvalid");
  expect(runtime.requestDeliveryStatus("own")?.frame).toMatchObject({ type: "user_message_status_request", channel_id: "third", client_request_id: "own" });
});

test("a reset during an unfinished replacement keeps unconfirmed content read-only instead of clearing it", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  runtime.sendUser("before reset", undefined, { clientRequestId: "own", requestId: "send" });
  runtime.markDisconnected();
  runtime.prepareLive({ ...scope, channelId: "second" }, 5);
  runtime.receive({ protocol_version: 2, type: "reset", target_channel_id: "second", session_id: scope.sessionId, leaf_id: scope.leafId, reason: "branch_changed" });
  runtime.prepareLive({ ...scope, channelId: "third" }, 5);
  const items = runtime.commitReplacement().items.filter((item) => item.kind === "pending");
  expect(items).toEqual([expect.objectContaining({ clientRequestId: "own", text: "before reset", scopeInvalid: true })]);
  expect(runtime.requestDeliveryStatus("own")).toBeNull();
});

test("read-only content of an invalid target stays under its own Pi and never shows in another conversation", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  runtime.sendUser("for the old runtime", undefined, { clientRequestId: "old", requestId: "send" });
  runtime.markDisconnected();
  runtime.prepareLive({ ...scope, runtimeInstanceId: "runtime-b" }, 0);
  expect(runtime.pendingItems).toEqual([expect.objectContaining({ clientRequestId: "old", scopeInvalid: true })]);
  const otherPi = { ...scope, endpointId: "other-endpoint", runtimeInstanceId: "runtime-x", sessionId: "other-session" };
  runtime.detachLive();
  expect(runtime.pendingItems).toEqual([]);
  expect(runtime.prepareLive(otherPi, 0).change.items.filter((item) => item.kind === "pending")).toEqual([]);
  // 直接切换（不经 detach）同样不串台。
  runtime.prepareLive({ ...otherPi, sessionId: "third-session" }, 0);
  expect(runtime.pendingItems).toEqual([]);
  runtime.detachLive();
  runtime.prepareLive({ ...scope, runtimeInstanceId: "runtime-b", channelId: "back" }, 0);
  expect(runtime.pendingItems).toEqual([expect.objectContaining({ clientRequestId: "old", scopeInvalid: true })]);
});

test("read-only content of an invalid target does not block a new queue snapshot", () => {
  const runtime = new TimelineRuntime({ maxEntries: 1, maxPayloadBytes: 1024 });
  runtime.beginLive(scope, 0);
  runtime.sendUser("stale", undefined, { clientRequestId: "stale", requestId: "send" });
  runtime.markDisconnected();
  const next = { ...scope, runtimeInstanceId: "runtime-b" };
  runtime.prepareLive(next, 0);
  expect(runtime.pendingItems).toEqual([expect.objectContaining({ clientRequestId: "stale", scopeInvalid: true })]);
  // 准入与快照共用活动容量口径：只读保留项不占用新会话的队列预算。
  const change = runtime.receive(ownQueueSnapshot("fresh", [{ id: "queued", text: "fresh", sender_ref: "peer", editable: false, created_at: 1 }], next));
  expect(change.pendingCapacityExceeded).toBeUndefined();
  expect(runtime.pendingItems.map((pending) => pending.clientRequestId).sort()).toEqual(["queued", "stale"]);
});

test("the delivery timer deadline uses local evidence time, not a future host timestamp", () => {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const future = Date.now() + 60 * 60 * 1000;
  runtime.receive(ownQueueSnapshot("future", [{ id: "flight", text: "x", sender_ref: "peer", editable: false, created_at: future }]));
  const pending = runtime.pendingItems[0]!;
  const local = Math.max(pending.confirmationStartedAt!, pending.lastEvidenceAt!);
  expect(runtime.nextDeliveryDeadline()).toBe(local + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS);
  runtime.expireDeliveryConfirmations(runtime.nextDeliveryDeadline()!);
  expect(pending.delivery).toBe("unknown_delivery");
  expect(runtime.nextDeliveryDeadline()).toBeNull();
  const query = runtime.requestDeliveryStatus("flight");
  expect(query).toBeNull(); // 其他 Owner 的消息不能由本端核对
  const own = runtime.sendUser("mine", undefined, { clientRequestId: "mine", requestId: "mine-send" })!;
  runtime.expireDeliveryConfirmations(Number.MAX_SAFE_INTEGER);
  const ownQuery = runtime.requestDeliveryStatus(own.frame.client_request_id)!;
  expect(runtime.nextDeliveryDeadline()).toBe(runtime.pendingItems.find((item) => item.clientRequestId === "mine")!.statusQuery!.requestedAt + DELIVERY_STATUS_QUERY_TIMEOUT_MS);
  expect(ownQuery.frame.type).toBe("user_message_status_request");
});
