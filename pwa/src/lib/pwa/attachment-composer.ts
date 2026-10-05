import {
  ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_MESSAGE_BYTES,
  attachmentDescriptorSchema, attachmentFileNameSchema,
  type AttachmentDescriptor,
} from "@pi-reach/protocol/session";
import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineScope } from "./timeline-runtime";
import type { AttachmentCapability, AttachmentUploadProgress } from "./attachment-upload-types";

export type AttachmentUploadPort = {
  connect(scope: TimelineScope, send: (frame: ClientFrame) => boolean): void;
  disconnect(): void;
  receive(frame: ServerFrame): boolean;
  upload(file: File, uploadId: string, progress: (value: AttachmentUploadProgress) => void, signal?: AbortSignal): Promise<AttachmentDescriptor>;
  cancel(uploadId: string): Promise<void>;
  cancelAttachment(attachmentId: string, uploadScope: string): Promise<void>;
  release(uploadId: string): void;
  dispose(): void;
};
export type AttachmentComposerIssue = "too_many" | "too_large" | "total_too_large" | "invalid_file" |
  "unsupported" | "failed" | "disconnected" | "send_failed";
export type AttachmentDraftItem = {
  id: string;
  fileName: string;
  byteLength: number;
  status: "draft" | "preparing" | "uploading" | "paused" | "complete" | "failed";
  receivedBytes: number;
  attachment?: AttachmentDescriptor;
  errorCode?: string;
};
export type AttachmentComposerSnapshot = {
  target: string | null;
  capability: AttachmentCapability;
  items: readonly AttachmentDraftItem[];
  active: boolean;
  committing: boolean;
  issue?: AttachmentComposerIssue;
};
export type AttachmentSendContext = { draftKey: string; draftVersion: number };
export type AttachmentReadyMessage = {
  target: string;
  clientRequestId: string;
  text: string;
  attachments: readonly AttachmentDescriptor[];
  context: AttachmentSendContext;
};
type DraftEntry = AttachmentDraftItem & {
  file?: File;
  uploadId?: string;
  uploadScope?: string;
  revision: number;
  abort?: AbortController;
};
type Batch = { id: string; text: string; context: AttachmentSendContext; committing: boolean };
type TargetDraft = {
  key: string;
  scope: TimelineScope;
  client: AttachmentUploadPort;
  capability: AttachmentCapability;
  items: Map<string, DraftEntry>;
  batch?: Batch;
  issue?: AttachmentComposerIssue;
};
type ComposerOptions = {
  createClient(onCapability: (value: AttachmentCapability) => void): AttachmentUploadPort;
  onChange(): void;
  /** true 表示所有权已交给普通消息生命周期，包含发送回执未知的情形。 */
  onReady(message: AttachmentReadyMessage): boolean;
};

export function attachmentTargetKey(scope: TimelineScope): string {
  return JSON.stringify([scope.deviceId, scope.endpointId, scope.runtimeInstanceId, scope.sessionId, scope.selfSenderRef]);
}
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : "io_error";
}

/** File 草稿只在本页内按实际 Pi 会话保存；切换从不把原件转移到新目标。 */
export class AttachmentComposer {
  private readonly drafts = new Map<string, TargetDraft>();
  private current: TargetDraft | null = null;
  private connected = false;
  private disposed = false;

  constructor(private readonly options: ComposerOptions) {}

  snapshot(): AttachmentComposerSnapshot {
    const current = this.current;
    return {
      target: current?.key ?? null,
      capability: current?.capability ?? { status: "unknown" },
      items: [...(current?.items.values() ?? [])].map(({ id, fileName, byteLength, status, receivedBytes, attachment, errorCode }) =>
        ({ id, fileName, byteLength, status, receivedBytes, ...(attachment ? { attachment } : {}), ...(errorCode ? { errorCode } : {}) })),
      active: current?.batch !== undefined,
      committing: current?.batch?.committing ?? false,
      ...(current?.issue ? { issue: current.issue } : {}),
    };
  }

  /** 仅提供全部目标草稿的当前 ID，供调用方清理孤儿预览。 */
  previewItemIds(): readonly string[] {
    return [...this.drafts.values()].flatMap((draft) => [...draft.items.keys()]);
  }

  connect(scope: TimelineScope, send: (frame: ClientFrame) => boolean): void {
    if (this.disposed) return;
    const key = attachmentTargetKey(scope);
    if (this.current && this.current.key !== key) {
      this.stop(this.current, true);
      this.current.client.disconnect();
    }
    let draft = this.drafts.get(key);
    if (!draft) {
      const client = this.options.createClient((capability) => this.capabilityChanged(key, capability));
      draft = { key, scope, client, capability: { status: "unknown" }, items: new Map() };
      this.drafts.set(key, draft);
    }
    const wasConnected = this.connected && this.current === draft;
    this.current = draft;
    draft.scope = scope;
    this.connected = true;
    draft.client.connect(scope, send);
    if (!wasConnected) this.options.onChange();
  }

  disconnect(): void {
    this.connected = false;
    this.current?.client.disconnect();
    if (this.current?.batch) this.current.issue = "disconnected";
    this.options.onChange();
  }

  receive(frame: ServerFrame): boolean { return this.current?.client.receive(frame) ?? false; }

  addFiles(files: readonly File[]): AttachmentComposerIssue | null {
    const draft = this.current;
    if (!draft || draft.batch || !this.connected || draft.capability.status !== "supported") return "unsupported";
    const total = [...draft.items.values()].reduce((sum, item) => sum + item.byteLength, 0);
    const issue = draft.items.size + files.length > ATTACHMENT_MAX_COUNT ? "too_many"
      : files.some((file) => file.size > ATTACHMENT_MAX_FILE_BYTES) ? "too_large"
        : total + files.reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_MAX_MESSAGE_BYTES ? "total_too_large"
          : files.some((file) => !attachmentFileNameSchema.safeParse(file.name).success) ? "invalid_file" : null;
    if (issue) { draft.issue = issue; this.options.onChange(); return issue; }
    for (const file of files) {
      const id = crypto.randomUUID();
      draft.items.set(id, { id, file, uploadId: crypto.randomUUID(), fileName: file.name, byteLength: file.size,
        status: "draft", receivedBytes: 0, revision: 0 });
    }
    draft.issue = undefined;
    this.options.onChange();
    return null;
  }

  restoreAttachments(attachments: readonly AttachmentDescriptor[]): boolean {
    const draft = this.current;
    if (!draft || draft.batch || draft.capability.status !== "supported") return false;
    if (draft.items.size + attachments.length > ATTACHMENT_MAX_COUNT ||
        [...draft.items.values()].reduce((sum, item) => sum + item.byteLength, 0) +
        attachments.reduce((sum, item) => sum + item.byte_length, 0) > ATTACHMENT_MAX_MESSAGE_BYTES ||
        attachments.some((item) => !attachmentDescriptorSchema.safeParse(item).success)) return false;
    for (const attachment of attachments) {
      if ([...draft.items.values()].some((item) => item.attachment?.attachment_id === attachment.attachment_id)) continue;
      const id = crypto.randomUUID();
      draft.items.set(id, { id, fileName: attachment.file_name, byteLength: attachment.byte_length,
        status: "draft", receivedBytes: attachment.byte_length, attachment, uploadScope: draft.capability.uploadScope, revision: 0 });
    }
    this.options.onChange();
    return true;
  }

  start(text: string, context: AttachmentSendContext): boolean {
    const draft = this.current;
    if (!draft || draft.batch || !this.connected || draft.capability.status !== "supported" || draft.items.size === 0) return false;
    draft.batch = { id: crypto.randomUUID(), text, context, committing: false };
    draft.issue = undefined;
    for (const item of draft.items.values()) {
      if (item.attachment && item.uploadScope === draft.capability.uploadScope) item.status = "complete";
      else if (item.file) this.startItem(draft, item);
      else { item.status = "failed"; item.errorCode = "invalid_scope"; draft.issue = "failed"; }
    }
    this.options.onChange();
    this.maybeReady(draft);
    return true;
  }

  remove(id: string): void {
    const draft = this.current;
    const item = draft?.items.get(id);
    if (!draft || !item || draft.batch?.committing) return;
    item.revision++;
    draft.items.delete(id);
    // 先移出发送集合再做远端清理，清理回执不能重新加入本次消息。
    this.discardItem(draft, item);
    this.refreshIssue(draft);
    this.options.onChange();
    this.maybeReady(draft);
  }

  retry(id: string): void {
    const draft = this.current;
    const item = draft?.items.get(id);
    if (!draft?.batch || draft.batch.committing || !item || item.status !== "failed" || !item.file) return;
    if (["integrity_mismatch", "cancelled", "aborted"].includes(item.errorCode ?? "")) {
      if (item.uploadId) void draft.client.cancel(item.uploadId).catch(() => undefined);
      item.uploadId = crypto.randomUUID();
    }
    this.startItem(draft, item);
    this.refreshIssue(draft);
    this.options.onChange();
  }

  /** 取消整次意图与逐文件移除不同：始终保留原目标草稿，绝不自动发送文字。 */
  cancelIntent(): void {
    if (!this.current || this.current.batch?.committing) return;
    this.stop(this.current);
    this.options.onChange();
  }

  private capabilityChanged(key: string, capability: AttachmentCapability): void {
    const draft = this.drafts.get(key);
    if (!draft || this.disposed) return;
    const previous = draft.capability;
    // checking/断线不清除最后租约，恢复后仍须与它比对。
    if (capability.status === "supported" && previous.uploadScope && previous.uploadScope !== capability.uploadScope) {
      this.stop(draft, true, draft.batch ? "send_failed" : undefined);
    }
    draft.capability = { ...capability, ...(capability.uploadScope ? {} : previous.uploadScope ? { uploadScope: previous.uploadScope } : {}) };
    if (capability.status === "unsupported") draft.issue = "unsupported";
    else if (capability.status === "supported") this.refreshIssue(draft);
    if (draft === this.current) this.options.onChange();
    if (capability.status === "supported") this.maybeReady(draft);
  }

  private startItem(draft: TargetDraft, item: DraftEntry): void {
    const batch = draft.batch;
    const file = item.file;
    if (!batch || !file) return;
    const revision = ++item.revision;
    const abort = new AbortController();
    item.abort = abort;
    item.status = "preparing";
    item.errorCode = undefined;
    const current = () => !this.disposed && draft.batch === batch && draft.items.get(item.id) === item && item.revision === revision;
    item.uploadId ??= crypto.randomUUID();
    void draft.client.upload(file, item.uploadId, (progress) => {
      if (!current()) return;
      item.status = progress.status;
      item.receivedBytes = progress.receivedBytes;
      this.refreshIssue(draft);
      if (draft === this.current) this.options.onChange();
    }, abort.signal).then((attachment) => {
      if (!current()) return;
      item.attachment = attachment;
      item.uploadScope = draft.capability.uploadScope;
      item.status = "complete";
      item.receivedBytes = attachment.byte_length;
      this.refreshIssue(draft);
      if (draft === this.current) this.options.onChange();
      this.maybeReady(draft);
    }, (error: unknown) => {
      if (!current()) return;
      item.status = "failed";
      item.errorCode = errorCode(error);
      draft.issue = "failed";
      if (draft === this.current) this.options.onChange();
    });
  }

  private maybeReady(draft: TargetDraft): void {
    const batch = draft.batch;
    if (!batch || batch.committing || this.current !== draft || !this.connected ||
        draft.capability.status !== "supported" || !draft.capability.uploadScope) return;
    if ([...draft.items.values()].some((item) => item.status !== "complete")) return;
    if ([...draft.items.values()].some((item) => item.uploadScope !== draft.capability.uploadScope)) {
      this.stop(draft, true, "send_failed");
      this.options.onChange();
      return;
    }
    if (!batch.text.trim() && draft.items.size === 0) {
      draft.batch = undefined;
      draft.issue = undefined;
      this.options.onChange();
      return;
    }
    // 同步锁提交点：ready回调内的取消/连点不能改变已经交给timeline的集合。
    batch.committing = true;
    this.options.onChange();
    let accepted = false;
    try {
      accepted = this.options.onReady({ target: draft.key, clientRequestId: batch.id, text: batch.text,
        attachments: [...draft.items.values()].map((item) => item.attachment!), context: batch.context });
    } catch {
      accepted = false;
    } finally {
      draft.batch = undefined;
      if (accepted) {
        for (const item of draft.items.values()) if (item.uploadId) draft.client.release(item.uploadId);
        draft.items.clear();
        draft.issue = undefined;
      } else {
        for (const item of draft.items.values()) item.status = "draft";
        draft.issue = "send_failed";
      }
      this.options.onChange();
    }
  }

  private refreshIssue(draft: TargetDraft): void {
    if (draft.batch) draft.issue = !this.connected ? "disconnected"
      : [...draft.items.values()].some((item) => item.status === "failed") ? "failed" : undefined;
    else if (draft.issue === "disconnected" || draft.issue === "unsupported") draft.issue = undefined;
  }

  private discardItem(draft: TargetDraft, item: DraftEntry): void {
    if (item.attachment && item.uploadScope) {
      void draft.client.cancelAttachment(item.attachment.attachment_id, item.uploadScope).catch(() => undefined);
      if (item.uploadId) draft.client.release(item.uploadId);
    } else if (item.uploadId) void draft.client.cancel(item.uploadId).catch(() => undefined);
    item.abort?.abort();
  }

  private stop(draft: TargetDraft, invalidateAttachments = false, issue?: AttachmentComposerIssue): void {
    draft.batch = undefined;
    draft.issue = issue;
    for (const item of draft.items.values()) {
      item.revision++;
      // 取消发送不是放弃原件：已完成（含恢复）的描述符仍可在同租约重发。
      if (!invalidateAttachments && item.attachment) { item.status = "draft"; item.errorCode = undefined; continue; }
      this.discardItem(draft, item);
      item.uploadId = item.file ? crypto.randomUUID() : undefined;
      item.attachment = undefined;
      item.uploadScope = undefined;
      item.receivedBytes = 0;
      item.status = item.file ? "draft" : "failed";
      item.errorCode = item.file ? undefined : "invalid_scope";
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const draft of this.drafts.values()) { this.stop(draft, true); draft.client.dispose(); }
    this.drafts.clear();
    this.current = null;
  }
}
