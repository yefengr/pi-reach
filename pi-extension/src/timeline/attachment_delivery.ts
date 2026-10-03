import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ATTACHMENT_METADATA_TYPE, ATTACHMENT_MESSAGE_TYPE,
  attachmentMetadataSchema, attachmentMessageBindingSchema,
  type AttachmentMetadata,
} from "@pi-reach/protocol/session";
import { AttachmentStore, type AttachmentScope } from "../attachments/store.js";
import type { ClientFrame, ServerFrame } from "../protocol/v2/index.js";
import type { Correlation, TimelineRuntime, TimelineStarted } from "./runtime.js";
import { attachmentContent, attachmentDisplayBlocks, attachmentQueueDisplay } from "./attachment_content.js";
import { MAX_USER_DELIVERY_BYTES } from "./user_delivery.js";

export const MAX_ATTACHMENT_DELIVERY_RECORDS = 4096;
export const MAX_ATTACHMENT_DELIVERY_BYTES = MAX_USER_DELIVERY_BYTES;
// 两个 native ID 和 byte 计数变化的预留，压缩后也继续计入预算。
const JOURNAL_RECORD_RESERVE_BYTES = 256;

type Frame = Extract<ClientFrame, { type: "user_message" }>;
type Record = {
  fingerprint: string;
  scope: AttachmentScope;
  ids: readonly string[];
  requestId: string;
  metadataEntryId?: string;
  heavy?: { metadata: AttachmentMetadata; content: string };
  mayHaveDelivered: boolean;
  messageId?: string;
  bytes: number;
};
export type AttachmentReplay = { status: "unknown_delivery" } | { status: "committed"; messageId: string; groupId?: string } | "conflict" | null;

export function attachmentReplayFrames(frame: Frame, query: ((frame: Frame) => AttachmentReplay) | undefined,
  sessionId: string, leafId: string | null): ServerFrame[] | null {
  const invalidSteer = frame.attachment_ids && frame.streaming_behavior === "steer";
  const replay = invalidSteer ? "conflict" : query?.(frame);
  if (replay === "conflict") return [{ protocol_version: 2, type: "protocol_error", target_channel_id: frame.channel_id,
    in_reply_to: frame.id, code: "invalid_message",
    message: invalidSteer ? "Attachments cannot be submitted as steer." : "client_request_id payload conflict" }];
  if (!replay) return null;
  const base = { protocol_version: 2 as const, type: "user_message_status" as const,
    target_channel_id: frame.channel_id, in_reply_to: frame.id,
    session_id: sessionId, leaf_id: leafId, client_request_id: frame.client_request_id };
  if (replay.status === "unknown_delivery") return [{ ...base, status: "unknown_delivery" }];
  return [{ ...base, status: "committed", message_id: replay.messageId,
    ...(replay.groupId ? { group_id: replay.groupId } : {}) }];
}

/** 与 store 同寿命；保护记录不逐出，耗尽预算后拒绝新请求而非允许重复投递。 */
export class AttachmentDelivery {
  private readonly journal = new Map<string, Record>();
  private journalBytes = 0;
  constructor(readonly store: AttachmentStore) {}

  replay(frame: Frame, ownerId: string, manager: SessionManager, runtime: TimelineRuntime): AttachmentReplay {
    const record = this.journal.get(this.key(ownerId, frame.client_request_id, manager));
    if (!record) return null;
    if (record.fingerprint !== this.fingerprint(frame)) return "conflict";
    if (!record.mayHaveDelivered) return null;
    const event = record.messageId && runtime.recover(manager).find((event) =>
      event.kind === "user" && event.event_id === record.messageId && event.sender_ref === ownerId);
    return event ? { status: "committed", messageId: event.event_id, groupId: event.group_id }
      : { status: "unknown_delivery" };
  }

  prepare(frame: Frame, ownerId: string, manager: SessionManager, runtime: TimelineRuntime) {
    if (!frame.attachment_ids || frame.streaming_behavior === "steer") throw new Error("invalid attachment message");
    const key = this.key(ownerId, frame.client_request_id, manager);
    const existing = this.journal.get(key);
    if (existing) {
      if (existing.fingerprint !== this.fingerprint(frame) || existing.mayHaveDelivered) throw new Error("attachment replay required");
      if (existing.heavy) return this.prepared(key, existing, existing.heavy);
    } else if (this.journal.size >= MAX_ATTACHMENT_DELIVERY_RECORDS) return null;

    const scope = { ownerId, sessionId: manager.getSessionId(), uploadScope: this.store.scopeFor(manager.getSessionId()) };
    const files = this.store.resolve(scope, frame.attachment_ids);
    const metadata = existing ? this.nativeMetadata(existing, manager) : attachmentMetadataSchema.parse({
      version: 1, client_request_id: frame.client_request_id, sender_ref: ownerId,
      text: frame.text, attachments: files.map((file) => file.descriptor),
    });
    if (!metadata) throw new Error("attachment metadata is unavailable on current branch");
    const heavy = { metadata, content: attachmentContent(frame.text, files) };
    const record: Record = existing ?? { fingerprint: this.fingerprint(frame), scope, ids: [...frame.attachment_ids],
      requestId: frame.client_request_id, mayHaveDelivered: false, bytes: 0 };
    // 在 append 前核算完整正文、preview、路径和保护 token；为两个后续 native ID 预留空间。
    const bytes = this.recordBytes(key, { ...record, heavy }) + JOURNAL_RECORD_RESERVE_BYTES;
    if (this.journalBytes - record.bytes + bytes > MAX_ATTACHMENT_DELIVERY_BYTES) return null;
    if (!existing) record.metadataEntryId = runtime.appendDeferredCustom(manager, ATTACHMENT_METADATA_TYPE, metadata);
    this.journalBytes += bytes - record.bytes;
    record.bytes = bytes;
    record.heavy = heavy;
    this.journal.set(key, record);
    return this.prepared(key, record, heavy);
  }

  beforeSend(correlation: Correlation, manager: SessionManager): void {
    const record = this.find(correlation, manager);
    if (!record) return;
    if (record.mayHaveDelivered) throw new Error("attachment delivery is uncertain");
    this.store.retain(record.scope, record.ids);
    // 必须在调用 Pi 前置位；同步抛错也无法证明未投递。
    record.mayHaveDelivered = true;
    this.release(this.key(record.scope.ownerId, record.requestId, manager), record);
  }

  started(started: TimelineStarted, manager: SessionManager, runtime: TimelineRuntime): TimelineStarted {
    if (started.role !== "user") return started;
    const record = this.find(started.correlation, manager);
    if (!record || !record.mayHaveDelivered) return started;
    const metadata = this.nativeMetadata(record, manager);
    if (!metadata) throw new Error("attachment metadata is unavailable on current branch");
    if (!record.messageId) {
      const binding = attachmentMessageBindingSchema.parse({ version: 1, client_request_id: record.requestId,
        sender_ref: record.scope.ownerId, message_id: started.eventId });
      runtime.appendDeferredCustom(manager, ATTACHMENT_MESSAGE_TYPE, binding);
      record.messageId = started.eventId;
    }
    return { ...started, blocks: attachmentDisplayBlocks(metadata) };
  }

  reset(): void { this.journal.clear(); this.journalBytes = 0; }

  private prepared(key: string, record: Record, heavy: NonNullable<Record["heavy"]>) {
    return { content: heavy.content, payload: { text: heavy.metadata.text,
      attachment_ids: [...record.ids], attachment_metadata: heavy.metadata, display_text: attachmentQueueDisplay(heavy.metadata),
      on_release: () => this.release(key, record) } };
  }

  private release(key: string, record: Record): void {
    if (this.journal.get(key) !== record || !record.heavy) return;
    record.heavy = undefined;
    const bytes = this.recordBytes(key, record) + JOURNAL_RECORD_RESERVE_BYTES;
    this.journalBytes += bytes - record.bytes;
    record.bytes = bytes;
  }

  private nativeMetadata(record: Record, manager: SessionManager): AttachmentMetadata | null {
    const entry = manager.getBranch().find((entry) => entry.id === record.metadataEntryId
      && entry.type === "custom" && entry.customType === ATTACHMENT_METADATA_TYPE);
    if (!entry || entry.type !== "custom") return null;
    const parsed = attachmentMetadataSchema.safeParse(entry.data);
    return parsed.success && parsed.data.sender_ref === record.scope.ownerId
      && parsed.data.client_request_id === record.requestId ? parsed.data : null;
  }

  private recordBytes(key: string, record: Record): number {
    return Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(record), "utf8");
  }

  private find(correlation: Correlation, manager: SessionManager): Record | undefined {
    if (!correlation.senderRef || !correlation.clientRequestId) return undefined;
    return this.journal.get(this.key(correlation.senderRef, correlation.clientRequestId, manager));
  }

  private key(ownerId: string, requestId: string, manager: SessionManager): string {
    return JSON.stringify([manager.getSessionId(), this.store.scopeFor(manager.getSessionId()), ownerId, requestId]);
  }

  private fingerprint(frame: Frame): string {
    return createHash("sha256").update(JSON.stringify([
      frame.text, [...(frame.attachment_ids ?? [])].sort(), frame.streaming_behavior ?? null,
    ])).digest("hex");
  }
}
