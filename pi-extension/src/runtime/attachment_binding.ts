import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IN_FLIGHT, ATTACHMENT_MAX_MESSAGE_BYTES,
} from "@pi-reach/protocol/session";
import { AttachmentStore, AttachmentStoreError } from "../attachments/store.js";
import type { ClientFrame, ServerFrame } from "../protocol/v2/index.js";
import type { TimelineV2Service } from "../timeline/v2_service.js";
import { AttachmentDelivery } from "../timeline/attachment_delivery.js";

export class AttachmentRuntime {
  current: AttachmentDelivery | null = null;
  constructor(private readonly runtimeId: string) {}
  get(): AttachmentDelivery {
    return this.current ??= new AttachmentDelivery(new AttachmentStore({ runtimeId: this.runtimeId }));
  }
  reset(sessionId: string): void {
    if (!this.current) return;
    this.current.store.resetScope(sessionId);
    this.current.reset();
  }
  close(): void {
    const previous = this.current;
    this.current = null;
    if (previous) void previous.store.dispose().catch(() => undefined);
  }
}

export type AttachmentFrame = Extract<ClientFrame, { type:
  "attachment_capabilities_request" | "attachment_begin" | "attachment_chunk" |
  "attachment_finish" | "attachment_status_request" | "attachment_cancel" | "attachment_discard" }>;

export function isAttachmentFrame(frame: ClientFrame): frame is AttachmentFrame {
  return frame.type.startsWith("attachment_");
}

export async function handleAttachmentFrame(store: AttachmentStore, service: TimelineV2Service, ownerId: string,
  frame: AttachmentFrame): Promise<ServerFrame[]> {
  const invalid = service.validateRequest(frame);
  if (invalid) return [invalid];
  if (frame.type === "attachment_capabilities_request") return [{
    protocol_version: 2, type: "attachment_capabilities", target_channel_id: frame.channel_id, in_reply_to: frame.id,
    session_id: service.sessionId, upload_scope: store.scopeFor(service.sessionId),
    max_file_bytes: ATTACHMENT_MAX_FILE_BYTES, max_message_bytes: ATTACHMENT_MAX_MESSAGE_BYTES,
    max_attachments: ATTACHMENT_MAX_COUNT, chunk_bytes: ATTACHMENT_CHUNK_BYTES, max_in_flight: ATTACHMENT_MAX_IN_FLIGHT,
  }];
  const scope = { ownerId, sessionId: frame.session_id, uploadScope: frame.upload_scope };
  try {
    if (frame.type === "attachment_discard") return [{
      protocol_version: 2, type: "attachment_discarded", target_channel_id: frame.channel_id, in_reply_to: frame.id,
      session_id: frame.session_id, upload_scope: frame.upload_scope, attachment_id: frame.attachment_id,
      status: await store.discard(scope, frame.attachment_id),
    }];
    const state = await (() => {
      switch (frame.type) {
        case "attachment_begin": return store.begin(scope, { uploadId: frame.upload_id, fileName: frame.file_name,
          mimeType: frame.mime_type, byteLength: frame.byte_length, sha256: frame.sha256, preview: frame.preview });
        case "attachment_chunk": return store.write(scope, frame.upload_id, frame.offset, Buffer.from(frame.data_base64, "base64"));
        case "attachment_finish": return store.finish(scope, frame.upload_id);
        case "attachment_status_request": return store.status(scope, frame.upload_id);
        case "attachment_cancel": return store.cancel(scope, frame.upload_id);
      }
    })();
    return [{ protocol_version: 2, type: "attachment_state", target_channel_id: frame.channel_id, in_reply_to: frame.id,
      session_id: frame.session_id, upload_scope: frame.upload_scope, upload_id: state.uploadId,
      received_bytes: state.receivedBytes, status: state.status, ...(state.attachment ? { attachment: state.attachment } : {}) } as ServerFrame];
  } catch (error) {
    const safe = error instanceof AttachmentStoreError ? error : new AttachmentStoreError("io_error", true);
    return [{ protocol_version: 2, type: "attachment_error", target_channel_id: frame.channel_id, in_reply_to: frame.id,
      session_id: frame.session_id, upload_scope: frame.upload_scope,
      ...(frame.type === "attachment_discard" ? { attachment_id: frame.attachment_id } : { upload_id: frame.upload_id }),
      code: safe.code, retryable: safe.retryable }];
  }
}
