import { expect, test } from "vitest";
import { QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS, TimelineRuntime, type TimelinePending, type TimelineScope } from "./timeline-runtime";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import { pendingPayloadBytes } from "./timeline-pending";
import type { ServerFrame } from "../pi-reach/protocol-v2/frames";
import { ATTACHMENT_METADATA_TYPE, type AttachmentDescriptor, type TimelineEvent } from "../pi-reach/protocol-v2/schema";

const scope: TimelineScope = { deviceId: "d", endpointId: "e", runtimeInstanceId: "r", sessionId: "s", leafId: "g", selfSenderRef: "owner", channelId: "c" };
type QueueFrame = Extract<ServerFrame, { type: "queued_message_state" }>;
const item: QueueFrame["items"][number] = { id: "q", text: "later", images: [{ mime: "image/png", data: "abc" }], sender_ref: "owner", editable: true, created_at: 1 };
function snapshot(items: QueueFrame["items"], extra: Partial<QueueFrame> = {}): QueueFrame {
  return { protocol_version: 2, type: "queued_message_state", session_id: "s", leaf_id: "g", snapshot_id: "snapshot", chunk_index: 0, final: true, items, ...extra };
}
function queuedRuntime() {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.sendUser("later", item.images, { clientRequestId: "q", requestId: "send" });
  runtime.receive(snapshot([item]));
  return runtime;
}
function queuedPending(runtime: TimelineRuntime): TimelinePending {
  const pending = runtime.pendingItems.find((candidate) => candidate.clientRequestId === "q");
  if (!pending) throw new Error("Expected queued message.");
  return pending;
}
function requestInsertion(runtime: TimelineRuntime) {
  const action = runtime.actOnQueued("q", "insert");
  if (!action) throw new Error("Expected insertion request.");
  return action;
}

test("queue snapshots preserve content, honor ownership/editability, and publish only complete chunks", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  expect(runtime.receive(snapshot([item], { final: false })).items).toEqual([]);
  runtime.receive(snapshot([{ ...item, id: "other", sender_ref: "other" }, { ...item, id: "flight", editable: false }], { chunk_index: 1 }));
  expect(runtime.pendingItems).toHaveLength(3);
  expect(runtime.pendingItems[0]).toMatchObject({ queued: true, cancelable: true, images: item.images });
  expect(runtime.actOnQueued("other", "insert")).toBeNull();
  expect(runtime.actOnQueued("flight", "cancel")).toBeNull();
  runtime.receive(snapshot([], { leaf_id: "stale" }));
  expect(runtime.pendingItems).toHaveLength(3);
});

test.each(["insert", "cancel"] as const)("%s targets the original queue id and synchronously prevents duplicate actions", (action) => {
  const runtime = queuedRuntime();
  const result = runtime.actOnQueued("q", action)!;
  expect(result.frame).toMatchObject({ type: action === "insert" ? "queued_message_steer" : "queued_message_clear", target_id: "q", channel_id: "c", leaf_id: "g" });
  expect(result.frame).not.toHaveProperty("text");
  expect(runtime.actOnQueued("q", action)).toBeNull();
  expect(runtime.actOnQueued("q", action === "insert" ? "cancel" : "insert")).toBeNull();
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: result.frame.id, target_channel_id: "c", code: "internal_error", message: "Try again" });
  // 拒绝插入后仍需等待错误之后的权威快照，不能凭点击前的队列状态解锁。
  if (action === "insert") expect(runtime.actOnQueued("q", action)).toBeNull();
  runtime.receive(snapshot([item]));
  expect(runtime.pendingItems[0]).toMatchObject({ delivery: "accepted", queued: true });
  expect(runtime.actOnQueued("q", action)).not.toBeNull();
  const removed = runtime.receive(snapshot([]));
  if (action === "insert") expect(removed.items).toEqual([expect.objectContaining({ insertionStatus: "waiting", queued: false, cancelable: false })]);
  else expect(removed.items).toEqual([]);
});

test.each(["insert", "cancel"] as const)("a repeated queue snapshot keeps a pending %s action locked", (action) => {
  const runtime = queuedRuntime();
  runtime.actOnQueued("q", action);
  const requestedAt = queuedPending(runtime).insertionRequestedAt;
  runtime.receive(snapshot([item]));
  runtime.receive(snapshot([item]));
  expect(queuedPending(runtime)).toMatchObject({ queued: true, cancelable: true, queuedAction: action });
  expect(runtime.actOnQueued("q", action)).toBeNull();
  if (action === "insert") {
    expect(queuedPending(runtime)).toMatchObject({ insertionStatus: "waiting", insertionRequestedAt: requestedAt });
    expect(runtime.receive(snapshot([])).items).toEqual([expect.objectContaining({ insertionStatus: "waiting", insertionRequestedAt: requestedAt, queued: false })]);
  } else {
    expect(runtime.receive(snapshot([])).items).toEqual([]);
  }
});

test.each(["insert", "cancel"] as const)("an in-flight %s rejection releases its lock without restoring editability", (action) => {
  const runtime = queuedRuntime();
  const request = runtime.actOnQueued("q", action)!;
  runtime.receive(snapshot([{ ...item, editable: false }]));
  expect(queuedPending(runtime)).toMatchObject({ queued: true, cancelable: false, queuedAction: action });
  if (action === "insert") expect(queuedPending(runtime)).toMatchObject({ insertionStatus: "waiting" });
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: request.frame.id, target_channel_id: "c", code: "invalid_message", message: "Already sending" });
  runtime.receive(snapshot([{ ...item, editable: false }]));
  expect(queuedPending(runtime)).toMatchObject({ queued: true, cancelable: false });
  expect(queuedPending(runtime).queuedAction).toBeUndefined();
  if (action === "insert") expect(queuedPending(runtime).insertionStatus).toBeUndefined();
  expect(runtime.actOnQueued("q", action)).toBeNull();
});

test("a failed transport send releases the action while a disconnect never enables a blind resend", () => {
  const runtime = queuedRuntime();
  const action = runtime.actOnQueued("q", "insert")!;
  runtime.releaseQueuedAction(action.frame.id);
  expect(runtime.actOnQueued("q", "insert")).not.toBeNull();
  runtime.markDisconnected();
  runtime.setScope({ ...scope, channelId: "reconnected" });
  expect(runtime.pendingItems[0]).toMatchObject({ queued: false, delivery: "unknown_delivery", insertionStatus: "unconfirmed" });
  expect(runtime.retryUnknown("q")).toBeNull();
  expect(runtime.actOnQueued("q", "insert")).toBeNull();
  runtime.receive(snapshot([]));
  expect(runtime.pendingItems).toEqual([expect.objectContaining({ insertionStatus: "unconfirmed", queued: false })]);
});

test("started receipt moves a queued message into the conversation and reconciles its exact formal event", () => {
  const runtime = queuedRuntime();
  runtime.receive({ protocol_version: 2, type: "user_message_started", target_channel_id: "c", in_reply_to: "send", session_id: "s", leaf_id: "g", message: { id: "m", group_id: "group", blocks: [{ type: "text", text: "later" }], origin: "pwa", sender_ref: "owner", delivery: "normal" } });
  runtime.receive(snapshot([]));
  expect(runtime.pendingItems[0]).toMatchObject({ messageId: "m", queued: false, cancelable: false });
  expect(runtime.actOnQueued("q", "insert")).toBeNull();
  const result = runtime.commit({ event_id: "m", message_id: "m", event_seq: 1, session_id: "s", leaf_id: "g", group_id: "group", timestamp: 2, kind: "user", blocks: [{ type: "text", text: "later" }], origin: "pwa", sender_ref: "owner", delivery: "normal", status: "committed" });
  expect(result.items.map((value) => value.kind)).toEqual(["event"]);
  expect(result.observed).toHaveLength(1);
});

test("a delivery timeout remains visible after the server removes it from the queue", () => {
  const runtime = queuedRuntime();
  runtime.receive({ protocol_version: 2, type: "user_message_status", target_channel_id: "c", in_reply_to: "send", client_request_id: "q", session_id: "s", leaf_id: "g", status: "unknown_delivery" });
  const changed = runtime.receive(snapshot([]));
  expect(changed.items).toEqual([expect.objectContaining({ clientRequestId: "q", delivery: "unknown_delivery", queued: false })]);
});

test("an explicit unknown-delivery receipt turns an insertion into an unconfirmed notice", () => {
  const runtime = queuedRuntime();
  requestInsertion(runtime);
  const changed = runtime.receive({ protocol_version: 2, type: "user_message_status", target_channel_id: "c", in_reply_to: "send", client_request_id: "q", session_id: "s", leaf_id: "g", status: "unknown_delivery" });
  expect(changed.items).toEqual([expect.objectContaining({ clientRequestId: "q", delivery: "unknown_delivery", insertionStatus: "unconfirmed", queued: false, cancelable: false })]);
  expect(runtime.retryUnknown("q")).toBeNull();
});

test.each(["endpointId", "runtimeInstanceId", "sessionId", "selfSenderRef"] as const)("disconnecting then changing %s scopes insertion state", (scopeKey) => {
  const runtime = queuedRuntime();
  requestInsertion(runtime);
  const requestedAt = queuedPending(runtime).insertionRequestedAt;
  runtime.markDisconnected();
  runtime.setScope({ ...scope, [scopeKey]: `other-${scopeKey}` });
  expect(runtime.expireQueuedInsertions((requestedAt ?? 0) + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS).items).toEqual([]);
  expect(runtime.dismissQueuedInsertionNotice("q").items).toEqual([]);
  runtime.setScope(scope);
  if (scopeKey !== "endpointId") {
    expect(runtime.pendingItems).toEqual([]);
    return;
  }
  const restored = queuedPending(runtime);
  expect(restored).toMatchObject({ insertionStatus: "unconfirmed", insertionRequestedAt: requestedAt, queued: false });
  expect(restored.insertionNoticeDismissed).toBeUndefined();
  expect(runtime.retryUnknown("q")).toBeNull();
});

test("disconnecting then advancing the leaf retains insertion state", () => {
  const runtime = queuedRuntime();
  requestInsertion(runtime);
  const requestedAt = queuedPending(runtime).insertionRequestedAt;
  runtime.markDisconnected();
  runtime.setScope({ ...scope, leafId: "next-leaf" });
  expect(runtime.expireQueuedInsertions((requestedAt ?? 0) + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS).items).toEqual([expect.objectContaining({ clientRequestId: "q", insertionStatus: "unconfirmed" })]);
});

test("display buffer renders insertion metadata changes without requiring new text", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const buffer = new StreamDisplayBuffer();
  const sent = runtime.sendUser("later", undefined, { clientRequestId: "q", requestId: "send" })!;
  buffer.ingest(sent.change.items);
  expect(buffer.ingest(runtime.receive(snapshot([item])).items).shouldRender).toBe(true);
  const action = requestInsertion(runtime);
  const busy = buffer.ingest(action.change.items);
  expect(busy.shouldRender).toBe(true);
  expect(busy.items[0]).toMatchObject({ queued: true, queuedAction: "insert", insertionStatus: "waiting" });
  const awaiting = buffer.ingest(runtime.receive(snapshot([])).items);
  expect(awaiting.shouldRender).toBe(true);
  expect(awaiting.items[0]).toMatchObject({ queued: false, insertionStatus: "waiting" });
  expect(buffer.ingest(runtime.expireQueuedInsertions(Date.now() + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS).items).shouldRender).toBe(true);
});

test("an inserted queued message survives repeated empty snapshots with its text and image", () => {
  const runtime = queuedRuntime();
  const action = requestInsertion(runtime);
  const requestedAt = queuedPending(runtime).insertionRequestedAt;
  expect(requestedAt).toEqual(expect.any(Number));
  runtime.receive(snapshot([]));
  runtime.receive(snapshot([]));
  expect(queuedPending(runtime)).toMatchObject({
    text: "later",
    images: item.images,
    queued: false,
    cancelable: false,
    insertionStatus: "waiting",
    insertionRequestedAt: requestedAt,
  });
  expect(runtime.actOnQueued("q", "insert")).toBeNull();
  expect(runtime.retryUnknown("q")).toBeNull();
  expect(action.frame.type).toBe("queued_message_steer");
});

test("an insertion becomes unconfirmed at its fixed deadline and after disconnect", () => {
  const runtime = queuedRuntime();
  const action = requestInsertion(runtime);
  const requestedAt = queuedPending(runtime).insertionRequestedAt!;
  expect(runtime.expireQueuedInsertions(requestedAt + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS - 1).items[0]).toMatchObject({ insertionStatus: "waiting" });
  expect(runtime.expireQueuedInsertions(requestedAt + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS).items[0]).toMatchObject({ insertionStatus: "unconfirmed", queued: false, cancelable: false });
  expect(runtime.retryUnknown("q")).toBeNull();

  const disconnected = queuedRuntime();
  requestInsertion(disconnected);
  disconnected.markDisconnected();
  disconnected.setScope({ ...scope, channelId: "reconnected" });
  expect(queuedPending(disconnected)).toMatchObject({ insertionStatus: "unconfirmed", queued: false, cancelable: false, delivery: "unknown_delivery" });
  disconnected.receive(snapshot([]));
  expect(queuedPending(disconnected)).toMatchObject({ insertionStatus: "unconfirmed", queued: false });
  disconnected.receive(snapshot([item]));
  expect(queuedPending(disconnected)).toMatchObject({ queued: true, cancelable: true });
  expect(queuedPending(disconnected).insertionStatus).toBeUndefined();
  expect(action.frame.type).toBe("queued_message_steer");
});

test.each(["started", "status"] as const)("only an exact %s receipt ends an insertion notice", (receipt) => {
  const runtime = queuedRuntime();
  requestInsertion(runtime);
  runtime.receive(snapshot([]));
  runtime.commit({ event_id: "unrelated", message_id: "unrelated", event_seq: 1, session_id: "s", leaf_id: "g", group_id: "unrelated", timestamp: 2, kind: "user", blocks: [{ type: "text", text: "later" }], origin: "pwa", sender_ref: "owner", delivery: "normal", status: "committed" });
  expect(queuedPending(runtime)).toMatchObject({ insertionStatus: "waiting" });
  if (receipt === "started") {
    runtime.receive({ protocol_version: 2, type: "user_message_started", target_channel_id: "c", in_reply_to: "send", session_id: "s", leaf_id: "g", message: { id: "m", group_id: "group", blocks: [{ type: "text", text: "later" }], origin: "pwa", sender_ref: "owner", delivery: "normal" } });
  } else {
    runtime.receive({ protocol_version: 2, type: "user_message_status", target_channel_id: "c", in_reply_to: "send", client_request_id: "q", session_id: "s", leaf_id: "g", status: "accepted", message_id: "m" });
  }
  expect(queuedPending(runtime)).toMatchObject({ messageId: "m", queued: false, cancelable: false });
  expect(queuedPending(runtime).insertionStatus).toBeUndefined();
  runtime.commit({ event_id: "m", message_id: "m", event_seq: 2, session_id: "s", leaf_id: "g", group_id: "group", timestamp: 3, kind: "user", blocks: [{ type: "text", text: "later" }], origin: "pwa", sender_ref: "owner", delivery: "normal", status: "committed" });
  expect(runtime.pendingItems).toEqual([]);
});

test("queue operation failures only restore editability while the original queue item remains authoritative", () => {
  const runtime = queuedRuntime();
  const first = requestInsertion(runtime);
  runtime.releaseQueuedAction(first.frame.id);
  expect(queuedPending(runtime)).toMatchObject({ queued: true, cancelable: true });
  expect(queuedPending(runtime).insertionStatus).toBeUndefined();

  const late = requestInsertion(runtime);
  runtime.receive(snapshot([]));
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: late.frame.id, target_channel_id: "c", code: "internal_error", message: "late operation error" });
  expect(queuedPending(runtime)).toMatchObject({ insertionStatus: "unconfirmed", queued: false, cancelable: false });
  expect(runtime.actOnQueued("q", "insert")).toBeNull();
  expect(runtime.retryUnknown("q")).toBeNull();
});

test.each(["empty", "editable", "in-flight"] as const)("an insertion error followed by a %s snapshot keeps content until the outcome is known", (outcome) => {
  const runtime = queuedRuntime();
  const action = requestInsertion(runtime);
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: action.frame.id, target_channel_id: "c", code: "invalid_message", message: "No longer available to steer" });
  expect(queuedPending(runtime)).toMatchObject({ insertionStatus: "unconfirmed", text: item.text, images: item.images });
  expect(runtime.actOnQueued("q", "insert")).toBeNull();
  const changed = runtime.receive(snapshot(outcome === "empty" ? [] : [{ ...item, editable: outcome === "editable" }]));
  expect(changed.items).toHaveLength(1);
  expect(queuedPending(runtime)).toMatchObject({ text: item.text, images: item.images });
  if (outcome === "empty") {
    expect(queuedPending(runtime)).toMatchObject({ insertionStatus: "unconfirmed", queued: false });
    expect(runtime.retryUnknown("q")).toBeNull();
    expect(runtime.receive(snapshot([])).items).toHaveLength(1);
  } else {
    expect(queuedPending(runtime)).toMatchObject({ queued: true, cancelable: outcome === "editable" });
    expect(queuedPending(runtime).insertionStatus).toBeUndefined();
    expect(runtime.actOnQueued("q", "insert") !== null).toBe(outcome === "editable");
  }
});

test("a rejection after the insertion timeout still reconciles the following queue snapshot", () => {
  const runtime = queuedRuntime();
  const action = requestInsertion(runtime);
  runtime.expireQueuedInsertions(queuedPending(runtime).insertionRequestedAt! + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS);
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: action.frame.id, target_channel_id: "c", code: "invalid_message", message: "Not inserted" });
  runtime.receive(snapshot([item]));
  expect(queuedPending(runtime).insertionStatus).toBeUndefined();
  expect(runtime.actOnQueued("q", "insert")).not.toBeNull();
});

test("cancelling a queued message retains its existing empty-snapshot behavior", () => {
  const runtime = queuedRuntime();
  runtime.actOnQueued("q", "cancel");
  expect(runtime.receive(snapshot([])).items).toEqual([]);
});

test("dismissing an unconfirmed insertion is local and keeps it out of retry delivery", () => {
  const runtime = queuedRuntime();
  requestInsertion(runtime);
  runtime.markDisconnected();
  runtime.setScope({ ...scope, channelId: "reconnected" });
  const changed = runtime.dismissQueuedInsertionNotice("q");
  expect(changed.items[0]).toMatchObject({ insertionStatus: "unconfirmed", insertionNoticeDismissed: true });
  expect(changed.observed).toEqual([]);
  expect(runtime.retryUnknown("q")).toBeNull();
});

test("reports a confirmed cancellation with its text and image when the snapshot removes a queued cancel", () => {
  const runtime = queuedRuntime();
  runtime.actOnQueued("q", "cancel");
  const change = runtime.receive(snapshot([], { snapshot_id: "after-cancel" }));
  expect(change.cancelledQueued).toEqual([{ clientRequestId: "q", text: "later", images: item.images }]);
  expect(runtime.pendingItems.some((candidate) => candidate.clientRequestId === "q")).toBe(false);
});

test("does not report a cancellation that the host rejected before the snapshot", () => {
  const runtime = queuedRuntime();
  const request = runtime.actOnQueued("q", "cancel")!;
  // 已开始发送时，错误回执先到并释放取消；随后的快照不再包含它，也不算撤回。
  runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: request.frame.id, target_channel_id: "c", code: "invalid_message", message: "Already sending" });
  expect(runtime.receive(snapshot([], { snapshot_id: "after-error" })).cancelledQueued).toBeUndefined();
});

test("does not report a queued message that leaves the queue without a local cancel", () => {
  const runtime = queuedRuntime();
  expect(runtime.receive(snapshot([], { snapshot_id: "consumed" })).cancelledQueued).toBeUndefined();
});

function attachmentDescriptor(attachmentId: string): AttachmentDescriptor {
  return { attachment_id: attachmentId, file_name: `${attachmentId}.png`, mime_type: "image/png", byte_length: 4, sha256: "a".repeat(64), preview: { mime_type: "image/jpeg", data: "aGk=", byte_length: 2, width: 8, height: 8 } };
}
function metadataEvent(eventId: string, clientRequestId: string, senderRef: string, text: string, attachments: AttachmentDescriptor[]): TimelineEvent & { kind: "custom" } {
  return { event_id: eventId, session_id: "s", leaf_id: "g", timestamp: 10, kind: "custom", payload: { custom_type: ATTACHMENT_METADATA_TYPE, data: { version: 1, client_request_id: clientRequestId, sender_ref: senderRef, text, attachments } }, truncated: false };
}

test("late attachment metadata backfills a queued message's text and display previews", () => {
  const runtime = queuedRuntime();
  expect(queuedPending(runtime).attachments).toBeUndefined();
  const changed = runtime.commit(metadataEvent("meta", "q", "owner", "later with files", [attachmentDescriptor("attachment-1")]));
  expect(queuedPending(runtime)).toMatchObject({ text: "later with files", attachments: [attachmentDescriptor("attachment-1")], queued: true, cancelable: true, images: item.images });
  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "pending", clientRequestId: "q", attachments: [attachmentDescriptor("attachment-1")] }));
});

test("attachment metadata bindings do not leak across senders when the queue snapshot arrives later", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.commit(metadataEvent("meta-self", "q", "owner", "self text", [attachmentDescriptor("attachment-1")]));
  runtime.commit(metadataEvent("meta-other", "other", "other", "other text", [attachmentDescriptor("attachment-2")]));
  runtime.sendUser("later", item.images, { clientRequestId: "q", requestId: "send" });
  runtime.receive(snapshot([item, { ...item, id: "other", sender_ref: "other" }]));

  const self = runtime.pendingItems.find((pending) => pending.clientRequestId === "q")!;
  const foreign = runtime.pendingItems.find((pending) => pending.clientRequestId === "other")!;
  expect(self).toMatchObject({ text: "self text", attachments: [attachmentDescriptor("attachment-1")], senderRef: "owner", cancelable: true, images: item.images });
  expect(foreign).toMatchObject({ text: "other text", attachments: [attachmentDescriptor("attachment-2")], senderRef: "other", cancelable: false });
});

test.each(["conflict", "removed", "sender"] as const)("sidecar projection is withdrawn on %s before queued cancellation", (invalidation) => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.receive(snapshot([item]));
  runtime.commit(metadataEvent("meta-a", "q", "owner", "remote A", [attachmentDescriptor("a")]));
  expect(queuedPending(runtime)).toMatchObject({ text: "remote A", attachments: [attachmentDescriptor("a")] });
  if (invalidation === "conflict") runtime.commit(metadataEvent("meta-b", "q", "owner", "remote B", [attachmentDescriptor("b")]));
  else if (invalidation === "removed") runtime.replaceHistory([]);
  else {
    runtime.receive(snapshot([{ ...item, sender_ref: "other" }]));
    expect(queuedPending(runtime).attachments).toBeUndefined();
    runtime.receive(snapshot([item]));
    runtime.replaceHistory([metadataEvent("foreign", "q", "other", "foreign", [attachmentDescriptor("foreign")])]);
  }
  expect(queuedPending(runtime)).toMatchObject({ text: item.text, images: item.images });
  expect(queuedPending(runtime).attachments).toBeUndefined();
  expect(runtime.actOnQueued("q", "cancel")).not.toBeNull();
  expect(runtime.receive(snapshot([])).cancelledQueued).toEqual([{ clientRequestId: "q", text: item.text, images: item.images }]);
});

test.each(["explicit", "disconnect", "protocol-error"] as const)("local original attachment IDs and text survive %s unknown delivery and conflicting sidecars", (unknown) => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const original = attachmentDescriptor("local");
  const sent = runtime.sendUserWithAttachments("original text", [original], { clientRequestId: "q", requestId: "send" })!;
  runtime.commit(metadataEvent("meta-a", "q", "owner", "remote A", [attachmentDescriptor("a")]));
  if (unknown === "explicit") runtime.markUnknownDelivery("q");
  else if (unknown === "disconnect") { runtime.markDisconnected(); runtime.setScope({ ...scope, channelId: "new" }); }
  else runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: sent.frame.id, target_channel_id: "c", code: "internal_error", message: "Failed" });
  expect(queuedPending(runtime)).toMatchObject({ text: "original text", attachments: [original], delivery: "unknown_delivery" });
  runtime.commit(metadataEvent("meta-b", "q", "owner", "remote B", [attachmentDescriptor("b")]));
  expect(runtime.retryUnknown("q")?.frame).toMatchObject({ text: "original text", attachment_ids: ["local"], client_request_id: "q" });
  runtime.receive(snapshot([{ ...item, text: "server fallback", images: undefined }]));
  expect(queuedPending(runtime)).toMatchObject({ text: "original text", attachments: [original] });
  runtime.actOnQueued("q", "cancel");
  expect(runtime.receive(snapshot([])).cancelledQueued).toEqual([{ clientRequestId: "q", text: "original text", attachments: [original] }]);
});

test("retry uses original legacy content, never attachment IDs borrowed from a sidecar", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.sendUser("original", item.images, { clientRequestId: "q", requestId: "send" });
  runtime.commit(metadataEvent("meta-a", "q", "owner", "derived", [attachmentDescriptor("a")]));
  runtime.markUnknownDelivery("q");
  const retry = runtime.retryUnknown("q")!.frame;
  expect(retry).toMatchObject({ text: "original", images: item.images });
  expect(retry).not.toHaveProperty("attachment_ids");
});

test("sidecar budget includes retained fallback and legacy images, and oversized projections are not kept", () => {
  const base = { text: item.text, images: item.images };
  const derived = { text: "derived", images: item.images, attachments: [attachmentDescriptor("a")] };
  const runtime = new TimelineRuntime({ maxPayloadBytes: pendingPayloadBytes(base) + pendingPayloadBytes(derived) - 1 });
  runtime.setScope(scope);
  runtime.receive(snapshot([item]));
  expect(runtime.commit(metadataEvent("meta-a", "q", "owner", "derived", [attachmentDescriptor("a")])).pendingCapacityExceeded).toBe(true);
  expect(queuedPending(runtime)).toMatchObject(base);
  expect(queuedPending(runtime).attachments).toBeUndefined();
});

test("a confirmed cancellation returns the queued message with its attachment previews", () => {
  const runtime = queuedRuntime();
  runtime.commit(metadataEvent("meta", "q", "owner", "later with files", [attachmentDescriptor("attachment-1")]));
  expect(runtime.actOnQueued("q", "cancel")).not.toBeNull();
  const change = runtime.receive(snapshot([], { snapshot_id: "after-cancel" }));
  expect(change.cancelledQueued).toEqual([{ clientRequestId: "q", text: "later with files", images: item.images, attachments: [attachmentDescriptor("attachment-1")] }]);
  expect(runtime.pendingItems).toEqual([]);
});
