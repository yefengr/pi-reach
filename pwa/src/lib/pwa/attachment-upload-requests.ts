import { clientFrameSchema, serverFrameSchema, type ClientFrame, type ServerFrame } from "@pi-reach/protocol/session";
import { AttachmentUploadError, type SendAttachmentFrame, type UploadResponse } from "./attachment-upload-types";

type RequestFrame = Extract<ClientFrame, { type: `attachment_${string}` }>;
type PendingRequest = {
  frame: RequestFrame;
  resolve: (frame: UploadResponse) => void;
  reject: (error: AttachmentUploadError) => void;
  cleanup: () => void;
};

export class AttachmentRequests {
  private readonly pending = new Map<string, PendingRequest>();
  constructor(private readonly timeoutMs: number) {}

  request(frame: RequestFrame, send: SendAttachmentFrame, signal?: AbortSignal): Promise<UploadResponse> {
    if (signal?.aborted) return Promise.reject(new AttachmentUploadError("aborted"));
    if (!clientFrameSchema.safeParse(frame).success) return Promise.reject(new AttachmentUploadError("invalid_upload"));
    return new Promise((resolve, reject) => {
      const settle = (error: AttachmentUploadError) => {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        entry.cleanup();
        reject(error);
      };
      const timer = setTimeout(() => settle(new AttachmentUploadError("timeout", true)), this.timeoutMs);
      const abort = () => settle(new AttachmentUploadError("aborted"));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(frame.id, { frame, resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!send(frame)) settle(new AttachmentUploadError("disconnected", true));
      } catch {
        settle(new AttachmentUploadError("disconnected", true));
      }
    });
  }

  receive(input: ServerFrame): boolean {
    if (!("in_reply_to" in input) || !input.in_reply_to) return false;
    const entry = this.pending.get(input.in_reply_to);
    if (!entry) return false;
    if (input.type !== "attachment_capabilities" && input.type !== "attachment_state"
      && input.type !== "attachment_error" && input.type !== "protocol_error") return false;
    const parsed = serverFrameSchema.safeParse(input);
    if (!parsed.success) return false;
    const frame = parsed.data;
    const request = entry.frame;
    if ("target_channel_id" in frame && frame.target_channel_id !== request.channel_id) return false;
    const isCapability = request.type === "attachment_capabilities_request";
    if (frame.type === "protocol_error") {
      if (!isCapability) return false;
    } else if (frame.type === "attachment_capabilities" || frame.type === "attachment_state" || frame.type === "attachment_error") {
      if (frame.session_id !== request.session_id) return false;
      if (isCapability) {
        if (frame.type !== "attachment_capabilities") return false;
      } else {
        if (frame.type === "attachment_capabilities" || frame.upload_scope !== request.upload_scope
          || frame.upload_id !== request.upload_id) return false;
      }
    } else return false;
    this.pending.delete(request.id);
    entry.cleanup();
    if (frame.type === "protocol_error") entry.reject(new AttachmentUploadError("unsupported"));
    else if (frame.type === "attachment_error") entry.reject(new AttachmentUploadError(frame.code, frame.retryable));
    else entry.resolve(frame);
    return true;
  }

  reset(): void {
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(new AttachmentUploadError("disconnected", true));
    }
    this.pending.clear();
  }
}
