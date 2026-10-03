import type { AttachmentDescriptor, ClientFrame, ServerFrame } from "@pi-reach/protocol/session";
import type { TimelineScope } from "./timeline-runtime";

export type AttachmentCapability = {
  status: "unknown" | "checking" | "supported" | "unsupported";
  uploadScope?: string;
};
export type AttachmentUploadProgress = {
  status: "preparing" | "uploading" | "paused";
  receivedBytes: number;
};
export type AttachmentUploadClientOptions = {
  onCapabilityChange?: (capability: AttachmentCapability) => void;
  requestTimeoutMs?: number;
};
export type AttachmentUploadErrorCode = Extract<ServerFrame, { type: "attachment_error" }>["code"]
  | "unsupported" | "disconnected" | "timeout" | "prepare_failed" | "aborted";
export class AttachmentUploadError extends Error {
  constructor(public readonly code: AttachmentUploadErrorCode, public readonly retryable = false) {
    super(`Attachment upload: ${code}`);
    this.name = "AttachmentUploadError";
  }
}
export type UploadState = Extract<ServerFrame, { type: "attachment_state" }>;
export type UploadResponse = UploadState | Extract<ServerFrame, { type: "attachment_capabilities" }>;
export type SendAttachmentFrame = (frame: ClientFrame) => boolean;
export type PreparedAttachment = Pick<AttachmentDescriptor, "sha256" | "preview">;
export function sameAttachmentTarget(a: TimelineScope, b: TimelineScope): boolean {
  return a.deviceId === b.deviceId && a.endpointId === b.endpointId
    && a.runtimeInstanceId === b.runtimeInstanceId && a.sessionId === b.sessionId
    && a.selfSenderRef === b.selfSenderRef;
}
