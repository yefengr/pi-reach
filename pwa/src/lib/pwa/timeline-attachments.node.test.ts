import { expect, test } from "vitest";
import {
  ATTACHMENT_MESSAGE_TYPE,
  ATTACHMENT_METADATA_TYPE,
  type AttachmentDescriptor,
  type AttachmentMetadata,
  type TimelineEvent,
} from "../pi-reach/protocol-v2/schema";
import { attachmentMessageKey, attachmentRequestKey, projectAttachmentMetadata } from "./timeline-attachments";
import type { TimelineViewItem } from "./timeline-runtime";

function descriptor(attachmentId: string, fileName = `${attachmentId}.png`): AttachmentDescriptor {
  return { attachment_id: attachmentId, file_name: fileName, mime_type: "image/png", byte_length: 4, sha256: "a".repeat(64) };
}
function metadata(clientRequestId: string, senderRef: string, text: string, attachments: AttachmentDescriptor[]): AttachmentMetadata {
  return { version: 1, client_request_id: clientRequestId, sender_ref: senderRef, text, attachments };
}
function customItem(eventId: string, sessionId: string, leafId: string, payload: unknown): TimelineViewItem {
  const event: TimelineEvent = { event_id: eventId, session_id: sessionId, leaf_id: leafId, timestamp: 1, kind: "custom", payload: payload as TimelineEvent extends { payload: infer P } ? P : never, truncated: false };
  return { kind: "event", event };
}
function metadataItem(eventId: string, sessionId: string, leafId: string, value: AttachmentMetadata): TimelineViewItem {
  return customItem(eventId, sessionId, leafId, { custom_type: ATTACHMENT_METADATA_TYPE, data: value });
}
function bindingItem(eventId: string, sessionId: string, leafId: string, clientRequestId: string, senderRef: string, messageId: string): TimelineViewItem {
  return customItem(eventId, sessionId, leafId, { custom_type: ATTACHMENT_MESSAGE_TYPE, data: { version: 1, client_request_id: clientRequestId, sender_ref: senderRef, message_id: messageId } });
}
function userItem(sessionId: string, messageId: string, senderRef: string | undefined, leafId = "leaf"): TimelineViewItem {
  const event: TimelineEvent = {
    event_id: messageId, message_id: messageId, session_id: sessionId, leaf_id: leafId, timestamp: 2, group_id: "group", kind: "user",
    blocks: [{ type: "text", text: messageId }], origin: senderRef ? "pwa" : "extension", delivery: "normal", status: "committed",
    ...(senderRef ? { sender_ref: senderRef } : {}),
  };
  return { kind: "event", event };
}

test("encodes request and message keys as session-scoped tuples", () => {
  expect(attachmentRequestKey("s", "owner", "req")).toBe(JSON.stringify(["s", "owner", "req"]));
  expect(attachmentMessageKey("s", "m")).toBe(JSON.stringify(["s", "m"]));
  expect(attachmentRequestKey("s1", "owner", "req")).not.toBe(attachmentRequestKey("s2", "owner", "req"));
  expect(attachmentRequestKey("s", "owner", "req")).not.toBe(attachmentRequestKey("s", "other", "req"));
});

test("projects metadata to messages through a valid binding without requiring the same leaf", () => {
  const value = metadata("req", "owner", "hello", [descriptor("a1")]);
  const items = [
    metadataItem("meta", "s", "metadata-leaf", value),
    bindingItem("binding", "s", "binding-leaf", "req", "owner", "m1"),
    userItem("s", "m1", "owner", "message-leaf"),
  ];
  const projection = projectAttachmentMetadata(items);
  expect(projection.requests.get(attachmentRequestKey("s", "owner", "req"))).toEqual(value);
  expect(projection.messages.get(attachmentMessageKey("s", "m1"))).toEqual(value);
});

test("keeps metadata available without a binding and ignores bindings without a matching user event", () => {
  const value = metadata("req", "owner", "hello", [descriptor("a1")]);
  const onlyMetadata = projectAttachmentMetadata([metadataItem("meta", "s", "leaf", value)]);
  expect(onlyMetadata.requests.size).toBe(1);
  expect(onlyMetadata.messages.size).toBe(0);

  const orphanBinding = projectAttachmentMetadata([metadataItem("meta", "s", "leaf", value), bindingItem("binding", "s", "leaf", "req", "owner", "m1")]);
  expect(orphanBinding.messages.size).toBe(0);

  const mismatchedSender = projectAttachmentMetadata([
    metadataItem("meta", "s", "leaf", value),
    bindingItem("binding", "s", "leaf", "req", "owner", "m1"),
    userItem("s", "m1", "other-owner"),
  ]);
  expect(mismatchedSender.messages.size).toBe(0);
});

test("isolates identical ids across sessions and owners", () => {
  const ownValue = metadata("req", "owner", "owner text", [descriptor("owner-file")]);
  const foreignValue = metadata("req", "other", "other text", [descriptor("other-file")]);
  const otherSessionValue = metadata("req", "owner", "session text", [descriptor("session-file")]);
  const projection = projectAttachmentMetadata([
    metadataItem("own", "s", "leaf", ownValue),
    metadataItem("foreign", "s", "leaf", foreignValue),
    metadataItem("other-session", "s2", "leaf", otherSessionValue),
    bindingItem("bind-own", "s", "leaf", "req", "owner", "m1"),
    bindingItem("bind-foreign", "s", "leaf", "req", "other", "m2"),
    bindingItem("bind-other-session", "s2", "leaf", "req", "owner", "m1"),
    userItem("s", "m1", "owner"),
    userItem("s", "m2", "other"),
    userItem("s2", "m1", "owner"),
  ]);
  expect(projection.messages.get(attachmentMessageKey("s", "m1"))?.text).toBe("owner text");
  expect(projection.messages.get(attachmentMessageKey("s", "m2"))?.text).toBe("other text");
  expect(projection.messages.get(attachmentMessageKey("s2", "m1"))?.text).toBe("session text");
  expect(projection.messages.size).toBe(3);
});

test("fails closed on conflicting or malformed metadata and bindings", () => {
  const first = metadata("req", "owner", "first", [descriptor("a1")]);
  const second = metadata("req", "owner", "second", [descriptor("a2")]);
  const conflict = projectAttachmentMetadata([
    metadataItem("meta-1", "s", "leaf", first),
    metadataItem("meta-2", "s", "leaf", second),
    bindingItem("binding", "s", "leaf", "req", "owner", "m1"),
    userItem("s", "m1", "owner"),
  ]);
  expect(conflict.requests.size).toBe(0);
  expect(conflict.messages.size).toBe(0);

  const malformed = projectAttachmentMetadata([
    customItem("bad-meta", "s", "leaf", { custom_type: ATTACHMENT_METADATA_TYPE, data: { version: 1 } }),
    customItem("bad-binding", "s", "leaf", { custom_type: ATTACHMENT_MESSAGE_TYPE, data: { version: 2 } }),
    customItem("ignored", "s", "leaf", { custom_type: "third-party:metadata", data: { value: 1 } }),
  ]);
  expect(malformed.requests.size).toBe(0);
  expect(malformed.messages.size).toBe(0);
});

test("returns empty projections for legacy timelines without any attachment sidecar", () => {
  const legacy = projectAttachmentMetadata([userItem("s", "m1", "owner"), userItem("s", "m2", undefined)]);
  expect(legacy.requests.size).toBe(0);
  expect(legacy.messages.size).toBe(0);
});
