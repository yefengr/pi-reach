import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ATTACHMENT_METADATA_TYPE, ATTACHMENT_MESSAGE_TYPE,
  attachmentMetadataSchema, attachmentMessageBindingSchema,
  MAX_TEXT_CHARS, MAX_ARRAY_ITEMS, type AttachmentMetadata,
} from "@pi-reach/protocol/session";
import type { ClientFrame, JsonValue, TimelineEvent } from "../protocol/v2/index.js";

export function userContentBlocks(content: unknown): JsonValue[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  return content.flatMap((part): JsonValue[] => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      return [{ type: "image", mime_type: item.mimeType, data: item.data, byte_length: Buffer.from(item.data, "base64").byteLength }];
    }
    return [];
  });
}

export function userMessageIdempotencyPayload(frame: Extract<ClientFrame, { type: "user_message" }>): unknown {
  return { text: frame.text, images: frame.images ?? [],
    attachment_ids: frame.attachment_ids ? [...frame.attachment_ids].sort() : [],
    streaming_behavior: frame.streaming_behavior ?? null };
}

export function attachmentDisplay(metadata: AttachmentMetadata): string {
  return [metadata.text, ...metadata.attachments.map((file) => file.file_name)].filter(Boolean).join("\n");
}

export function attachmentDisplayBlocks(metadata: AttachmentMetadata): { type: "text"; text: string }[] {
  const text = attachmentDisplay(metadata);
  const blocks: { type: "text"; text: string }[] = [];
  for (let offset = 0; offset < text.length; offset += MAX_TEXT_CHARS) {
    blocks.push({ type: "text", text: text.slice(offset, offset + MAX_TEXT_CHARS) });
  }
  if (blocks.length > MAX_ARRAY_ITEMS) throw new Error("attachment display exceeds block limit");
  return blocks;
}

/** 旧 queue shape 只有一段文字；原文优先，完整名称由 sidecar 提供。 */
export function attachmentQueueDisplay(metadata: AttachmentMetadata): string {
  return attachmentDisplay(metadata).slice(0, MAX_TEXT_CHARS);
}

export function attachmentContent(text: string, files: readonly { descriptor: AttachmentMetadata["attachments"][number]; path: string }[]): string {
  return [text, ...files.map(({ descriptor, path }) => JSON.stringify({
    file_name: descriptor.file_name, mime_type: descriptor.mime_type, byte_length: descriptor.byte_length, path,
  }))].filter(Boolean).join("\n");
}

/** 仅关联当前 branch 中先于 binding 的合法元信息；路径从不进入展示投影。 */
export function attachmentRecords(manager: SessionManager): Map<string, AttachmentMetadata> {
  const metadata = new Map<string, AttachmentMetadata>();
  const messages = new Map<string, AttachmentMetadata>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === ATTACHMENT_METADATA_TYPE) {
      const parsed = attachmentMetadataSchema.safeParse(entry.data);
      if (parsed.success) metadata.set(recordKey(parsed.data), parsed.data);
    } else if (entry.customType === ATTACHMENT_MESSAGE_TYPE) {
      const parsed = attachmentMessageBindingSchema.safeParse(entry.data);
      if (!parsed.success) continue;
      const value = metadata.get(recordKey(parsed.data));
      if (value && !messages.has(parsed.data.message_id)) messages.set(parsed.data.message_id, value);
    }
  }
  return messages;
}

export function normalizeAttachmentEvents(events: TimelineEvent[], manager: SessionManager): TimelineEvent[] {
  const messages = attachmentRecords(manager);
  return events.map((event) => {
    if (event.kind !== "user") return event;
    const metadata = messages.get(event.message_id);
    if (!metadata || metadata.sender_ref !== event.sender_ref) return event;
    return { ...event, blocks: attachmentDisplayBlocks(metadata) };
  });
}

function recordKey(value: { sender_ref: string; client_request_id: string }): string {
  return JSON.stringify([value.sender_ref, value.client_request_id]);
}
