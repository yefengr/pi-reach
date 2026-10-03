import {
  ATTACHMENT_MESSAGE_TYPE,
  ATTACHMENT_METADATA_TYPE,
  attachmentMessageBindingSchema,
  attachmentMetadataSchema,
  type AttachmentMetadata,
} from "../pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";

/** 会话内同一 sender/request 的附件元信息键；跨会话与跨 Owner 天然隔离。 */
export function attachmentRequestKey(sessionId: string, senderRef: string, clientRequestId: string): string {
  return JSON.stringify([sessionId, senderRef, clientRequestId]);
}

/** 会话内 message_id 的展示映射键；binding 与 metadata 通过该键连接到 user event。 */
export function attachmentMessageKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId, messageId]);
}

export type TimelineAttachmentProjection = {
  requests: ReadonlyMap<string, AttachmentMetadata>;
  messages: ReadonlyMap<string, AttachmentMetadata>;
};

type BindingRecord = {
  messageKey: string;
  requestKey: string;
  senderRef: string;
};

/**
 * 从当前完整 formal 集合读取附件 custom 数据。
 * 只由传入的 timeline 集合决定 branch；不跨会话/Owner 关联，也不要求同一 leaf。
 * 冲突（同键不同内容、同 message 指向不同元信息）一律 fail closed，不降级硬转。
 */
export function projectAttachmentMetadata(items: readonly TimelineViewItem[]): TimelineAttachmentProjection {
  const requests = new Map<string, AttachmentMetadata>();
  const conflictedRequests = new Set<string>();
  const bindings: BindingRecord[] = [];
  const userSenders = new Map<string, string | undefined>();

  for (const item of items) {
    if (item.kind !== "event") continue;
    const event = item.event;
    if (event.kind === "user") {
      userSenders.set(attachmentMessageKey(event.session_id, event.message_id), event.sender_ref);
      continue;
    }
    if (event.kind !== "custom") continue;
    const payload = readCustomPayload(event.payload);
    if (!payload) continue;
    if (payload.custom_type === ATTACHMENT_METADATA_TYPE) {
      const parsed = attachmentMetadataSchema.safeParse(payload.data);
      if (!parsed.success) continue;
      const key = attachmentRequestKey(event.session_id, parsed.data.sender_ref, parsed.data.client_request_id);
      const existing = requests.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(parsed.data)) {
        requests.delete(key);
        conflictedRequests.add(key);
      } else if (!conflictedRequests.has(key)) {
        requests.set(key, parsed.data);
      }
    } else if (payload.custom_type === ATTACHMENT_MESSAGE_TYPE) {
      const parsed = attachmentMessageBindingSchema.safeParse(payload.data);
      if (!parsed.success) continue;
      bindings.push({
        messageKey: attachmentMessageKey(event.session_id, parsed.data.message_id),
        requestKey: attachmentRequestKey(event.session_id, parsed.data.sender_ref, parsed.data.client_request_id),
        senderRef: parsed.data.sender_ref,
      });
    }
  }

  const messages = new Map<string, AttachmentMetadata>();
  const conflictedMessages = new Set<string>();
  for (const binding of bindings) {
    if (conflictedMessages.has(binding.messageKey)) continue;
    // 只有存在对应合法 user event、且 sender_ref 与元信息一致的 binding 才生成映射。
    if (userSenders.get(binding.messageKey) !== binding.senderRef) continue;
    const metadata = requests.get(binding.requestKey);
    if (!metadata || metadata.sender_ref !== binding.senderRef) continue;
    const existing = messages.get(binding.messageKey);
    if (existing && JSON.stringify(existing) !== JSON.stringify(metadata)) {
      messages.delete(binding.messageKey);
      conflictedMessages.add(binding.messageKey);
      continue;
    }
    messages.set(binding.messageKey, metadata);
  }
  return { requests, messages };
}

function readCustomPayload(payload: unknown): { custom_type: string; data: unknown } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.custom_type === "string" ? { custom_type: candidate.custom_type, data: candidate.data } : null;
}
