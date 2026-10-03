import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_IN_FLIGHT,
  attachmentFileNameSchema, idSchema, imageMimeSchema,
  type AttachmentDescriptor, type ClientFrame, type ServerFrame,
} from "@pi-reach/protocol/session";
import type { TimelineScope } from "./timeline-runtime";
import { attachmentBytesToBase64, prepareAttachmentFile } from "./attachment-upload-prepare";
import { AttachmentRequests } from "./attachment-upload-requests";
import {
  AttachmentUploadError, sameAttachmentTarget,
  type AttachmentCapability, type AttachmentUploadClientOptions, type AttachmentUploadProgress,
  type PreparedAttachment, type SendAttachmentFrame, type UploadState,
} from "./attachment-upload-types";

export { AttachmentUploadError } from "./attachment-upload-types";
export type { AttachmentCapability, AttachmentUploadClientOptions, AttachmentUploadProgress } from "./attachment-upload-types";
export { prepareAttachmentFile } from "./attachment-upload-prepare";

type UploadTask = {
  id: string;
  file: File;
  mime: string;
  target: TimelineScope;
  uploadScope?: string;
  prepared?: PreparedAttachment;
  preparation?: Promise<PreparedAttachment>;
  descriptor?: AttachmentDescriptor;
  promise?: Promise<AttachmentDescriptor>;
  progress: (progress: AttachmentUploadProgress) => void;
  received: number;
  controller: AbortController;
  error?: AttachmentUploadError;
};
type CancelIntent = { id: string; target: TimelineScope; uploadScope?: string; cancellation?: Promise<void> };
type UploadOperation = "attachment_begin" | "attachment_chunk" | "attachment_status_request" | "attachment_finish";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class AttachmentUploadClient {
  private scope?: TimelineScope;
  private send?: SendAttachmentFrame;
  private capability: AttachmentCapability = { status: "unknown" };
  private readonly tasks = new Map<string, UploadTask>();
  private readonly cancellations = new Map<string, CancelIntent>();
  private readonly requests: AttachmentRequests;
  private readonly waiters = new Set<() => void>();
  private connectionVersion = 0;
  private chunksInFlight = 0;
  private disposed = false;

  constructor(private readonly options: AttachmentUploadClientOptions = {}) {
    this.requests = new AttachmentRequests(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  connect(scope: TimelineScope, send: SendAttachmentFrame): void {
    if (this.disposed) return;
    const sameTarget = this.scope && sameAttachmentTarget(this.scope, scope);
    const sameConnection = sameTarget && this.send && this.scope?.channelId === scope.channelId;
    if (!sameTarget) {
      for (const task of this.tasks.values()) this.failScope(task);
      this.tasks.clear();
      // 新目标不具备清理旧目标的权限，只放弃本页的远端清理意图。
      this.cancellations.clear();
    }
    this.scope = { ...scope };
    this.send = send;
    if (sameConnection) return; // 普通 leaf 推进不打断上传。
    const version = ++this.connectionVersion;
    this.requests.reset();
    this.setCapability({ status: "checking" });
    if (version !== this.connectionVersion || this.disposed || !this.send) return;
    void this.queryCapability(version);
  }

  disconnect(): void {
    if (this.disposed) return;
    this.send = undefined;
    ++this.connectionVersion;
    this.requests.reset();
    this.setCapability({ status: "unknown" });
    for (const task of this.tasks.values()) {
      if (task.promise && !task.error && !task.descriptor) this.report(task, "paused");
    }
  }

  receive(frame: ServerFrame): boolean {
    return !this.disposed && this.requests.receive(frame);
  }

  upload(file: File, uploadId: string, onProgress: (progress: AttachmentUploadProgress) => void,
    signal?: AbortSignal): Promise<AttachmentDescriptor> {
    if (this.disposed || !this.scope) return Promise.reject(new AttachmentUploadError("disconnected", true));
    if (!idSchema.safeParse(uploadId).success || !attachmentFileNameSchema.safeParse(file.name).success
      || !imageMimeSchema.safeParse(file.type || "application/octet-stream").success) {
      return Promise.reject(new AttachmentUploadError("invalid_upload"));
    }
    if (file.size > ATTACHMENT_MAX_FILE_BYTES) return Promise.reject(new AttachmentUploadError("too_large"));
    let task = this.tasks.get(uploadId);
    if (task && task.file !== file) return Promise.reject(new AttachmentUploadError("invalid_upload"));
    if (!task) {
      task = {
        id: uploadId, file, mime: file.type || "application/octet-stream", target: { ...this.scope },
        uploadScope: this.capability.status === "supported" ? this.capability.uploadScope : undefined,
        progress: onProgress, received: 0, controller: new AbortController(),
      };
      this.tasks.set(uploadId, task);
    }
    task.progress = onProgress;
    if (task.error) return Promise.reject(task.error);
    const abort = () => { void this.cancel(uploadId); };
    if (signal?.aborted) {
      abort();
      return Promise.reject(new AttachmentUploadError("aborted"));
    }
    if (task.promise) return task.promise;
    signal?.addEventListener("abort", abort, { once: true });
    const activeTask = task;
    const promise = this.run(activeTask).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (activeTask.promise === promise) activeTask.promise = undefined;
    });
    activeTask.promise = promise;
    return promise;
  }

  cancel(uploadId: string): Promise<void> {
    const task = this.tasks.get(uploadId);
    if (!task || this.disposed) return Promise.resolve();
    if (task.error?.code === "invalid_scope") {
      this.tasks.delete(uploadId);
      return Promise.resolve();
    }
    const intent: CancelIntent = { id: task.id, target: task.target, uploadScope: task.uploadScope };
    this.cancellations.set(task.id, intent);
    this.tasks.delete(task.id);
    task.error = new AttachmentUploadError("aborted");
    task.controller.abort();
    this.wake();
    // 离线只保留轻量清理上下文；移除的原件与摘要不再由客户端索引持有。
    return this.flushCancel(intent);
  }

  release(uploadId: string): void {
    const task = this.tasks.get(uploadId);
    this.cancellations.delete(uploadId);
    if (!task) return;
    task.error = new AttachmentUploadError("aborted");
    task.controller.abort();
    this.tasks.delete(uploadId);
    this.wake();
  }

  dispose(): void {
    if (this.disposed) return;
    // 仅当前可确认目标上的未释放文件可发 cancel；retain 的远端文件由服务端保护。
    for (const task of this.tasks.values()) void this.cancel(task.id);
    this.disposed = true;
    this.send = undefined;
    ++this.connectionVersion;
    this.requests.reset();
    this.tasks.clear();
    this.cancellations.clear();
    this.wake();
  }

  private async queryCapability(version: number): Promise<void> {
    const scope = this.scope;
    const send = this.send;
    if (!scope || !send) return;
    try {
      const response = await this.requests.request({
        protocol_version: 2, type: "attachment_capabilities_request", id: crypto.randomUUID(),
        channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId,
      }, send);
      if (version !== this.connectionVersion || this.disposed) return;
      if (response.type !== "attachment_capabilities") return;
      for (const task of this.tasks.values()) {
        if (task.uploadScope && task.uploadScope !== response.upload_scope) {
          this.failScope(task);
          this.tasks.delete(task.id);
        }
      }
      this.setCapability({ status: "supported", uploadScope: response.upload_scope });
      if (version !== this.connectionVersion || this.disposed) return;
      for (const intent of this.cancellations.values()) {
        if (intent.uploadScope && intent.uploadScope !== response.upload_scope) this.cancellations.delete(intent.id);
        else void this.flushCancel(intent);
      }
    } catch {
      if (version === this.connectionVersion && !this.disposed) this.setCapability({ status: "unsupported" });
    }
  }

  private setCapability(capability: AttachmentCapability): void {
    this.capability = capability;
    this.wake();
    this.options.onCapabilityChange?.({ ...capability });
  }

  private failScope(task: UploadTask): void {
    task.error = new AttachmentUploadError("invalid_scope");
    task.controller.abort();
    this.wake();
  }

  private assertActive(task: UploadTask): void {
    if (task.error) throw task.error;
    if (this.disposed) throw new AttachmentUploadError("aborted");
    if (!this.scope || !sameAttachmentTarget(task.target, this.scope)) throw new AttachmentUploadError("invalid_scope");
  }

  private report(task: UploadTask, status: AttachmentUploadProgress["status"]): void {
    if (task.error) return;
    task.progress({ status, receivedBytes: task.received });
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private wait(task: UploadTask): Promise<void> {
    this.assertActive(task);
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        task.controller.signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      task.controller.signal.addEventListener("abort", done, { once: true });
    });
  }

  private async ready(task: UploadTask): Promise<void> {
    while (true) {
      this.assertActive(task);
      if (this.send && this.capability.status === "supported") {
        const uploadScope = this.capability.uploadScope;
        if (!uploadScope || (task.uploadScope && task.uploadScope !== uploadScope)) {
          throw new AttachmentUploadError("invalid_scope");
        }
        task.uploadScope = uploadScope;
        return;
      }
      if (this.send && this.capability.status === "unsupported") throw new AttachmentUploadError("unsupported");
      this.report(task, "paused");
      this.assertActive(task);
      await this.wait(task);
    }
  }

  private async prepare(task: UploadTask): Promise<void> {
    if (task.prepared) return;
    this.report(task, "preparing");
    this.assertActive(task);
    task.preparation ??= prepareAttachmentFile(task.file);
    const signal = task.controller.signal;
    task.prepared = await new Promise<PreparedAttachment>((resolve, reject) => {
      const abort = () => reject(task.error ?? new AttachmentUploadError("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      void task.preparation!.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    this.assertActive(task);
  }

  private async request(task: UploadTask, type: UploadOperation,
    extra: Record<string, unknown> = {}): Promise<UploadState> {
    this.assertActive(task);
    const scope = this.scope;
    if (!scope || !this.send || this.capability.status !== "supported") throw new AttachmentUploadError("disconnected", true);
    const frame = {
      protocol_version: 2, type, id: crypto.randomUUID(), channel_id: scope.channelId,
      session_id: scope.sessionId, upload_scope: task.uploadScope, upload_id: task.id, ...extra,
    } as Extract<ClientFrame, { type: UploadOperation }>;
    const version = this.connectionVersion;
    let response;
    try {
      response = await this.requests.request(frame, this.send, task.controller.signal);
    } catch (error) {
      this.assertActive(task);
      if (version !== this.connectionVersion) throw new AttachmentUploadError("disconnected", true);
      if (error instanceof AttachmentUploadError && error.code === "disconnected") this.disconnect();
      throw error;
    }
    this.assertActive(task);
    if (version !== this.connectionVersion) throw new AttachmentUploadError("disconnected", true);
    if (response.type !== "attachment_state") throw new AttachmentUploadError("invalid_upload");
    if (response.received_bytes > task.file.size) throw new AttachmentUploadError("invalid_upload");
    if (response.status === "complete") {
      const descriptor = response.attachment;
      if (descriptor.byte_length !== task.file.size || descriptor.sha256 !== task.prepared?.sha256
        || descriptor.file_name !== task.file.name || descriptor.mime_type !== task.mime) {
        throw new AttachmentUploadError("integrity_mismatch");
      }
    }
    if (response.status === "cancelled") throw new AttachmentUploadError("cancelled");
    task.received = response.received_bytes;
    return response;
  }

  private async acquireChunk(task: UploadTask): Promise<void> {
    while (this.chunksInFlight >= ATTACHMENT_MAX_IN_FLIGHT) {
      await this.wait(task);
      this.assertActive(task);
    }
    this.assertActive(task);
    ++this.chunksInFlight;
  }

  private async chunk(task: UploadTask): Promise<UploadState> {
    const version = this.connectionVersion;
    await this.acquireChunk(task);
    try {
      this.assertActive(task);
      if (version !== this.connectionVersion) throw new AttachmentUploadError("disconnected", true);
      const offset = task.received;
      const bytes = new Uint8Array(await task.file.slice(offset, offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer());
      this.assertActive(task);
      // 读取分片期间换 channel：先重新确认 offset，不能沿用旧连接的状态。
      if (version !== this.connectionVersion) throw new AttachmentUploadError("disconnected", true);
      const state = await this.request(task, "attachment_chunk", { offset, data_base64: attachmentBytesToBase64(bytes) });
      if (state.status !== "complete" && state.received_bytes !== offset + bytes.byteLength) {
        throw new AttachmentUploadError("offset_mismatch", true);
      }
      return state;
    } finally {
      --this.chunksInFlight;
      this.wake();
    }
  }

  private async beginOrStatus(task: UploadTask): Promise<UploadState> {
    try {
      return await this.request(task, "attachment_status_request");
    } catch (error) {
      this.assertActive(task);
      if (!(error instanceof AttachmentUploadError) || error.code !== "not_found") throw error;
      return this.request(task, "attachment_begin", {
        file_name: task.file.name, mime_type: task.mime, byte_length: task.file.size, ...task.prepared,
      });
    }
  }

  private async run(task: UploadTask): Promise<AttachmentDescriptor> {
    try {
      await this.ready(task);
      this.assertActive(task);
      if (task.descriptor) return task.descriptor;
      await this.prepare(task);
      this.assertActive(task);
      while (true) {
        await this.ready(task);
        this.assertActive(task);
        const version = this.connectionVersion;
        const checkConnection = () => {
          this.assertActive(task);
          if (version !== this.connectionVersion) throw new AttachmentUploadError("disconnected", true);
        };
        try {
          let state = await this.beginOrStatus(task);
          checkConnection();
          this.report(task, "uploading");
          checkConnection();
          while (state.status !== "complete" && task.received < task.file.size) {
            state = await this.chunk(task);
            checkConnection();
            this.report(task, "uploading");
            checkConnection();
          }
          if (state.status !== "complete") state = await this.request(task, "attachment_finish");
          this.assertActive(task);
          if (state.status !== "complete") throw new AttachmentUploadError("invalid_upload");
          task.descriptor = state.attachment;
          return state.attachment;
        } catch (error) {
          this.assertActive(task);
          if (!(error instanceof AttachmentUploadError) || error.code !== "disconnected") throw error;
          // 短断线保留文件与摘要，恢复后始终从电脑 status 确认的 offset 继续。
        }
      }
    } catch (error) {
      if (task.error) throw task.error;
      throw error instanceof AttachmentUploadError ? error : new AttachmentUploadError("prepare_failed");
    }
  }

  private flushCancel(task: CancelIntent): Promise<void> {
    if (task.cancellation) return task.cancellation;
    if (this.cancellations.get(task.id) !== task || !this.send || this.capability.status !== "supported" || !this.scope
      || !sameAttachmentTarget(task.target, this.scope)) return Promise.resolve();
    const uploadScope = this.capability.uploadScope;
    if (!uploadScope || (task.uploadScope && task.uploadScope !== uploadScope)) return Promise.resolve();
    task.uploadScope = uploadScope;
    const cancellation = this.requests.request({
      protocol_version: 2, type: "attachment_cancel", id: crypto.randomUUID(), channel_id: this.scope.channelId,
      session_id: this.scope.sessionId, upload_scope: uploadScope, upload_id: task.id,
    }, this.send).then(() => {
      if (this.cancellations.get(task.id) === task) this.cancellations.delete(task.id);
      // complete 可能是已 retain 文件；不宣称远端删除成功。
    }).catch(() => {
      // 保留精确目标/租约上的清理意图，下一次连接能力确认后再尝试。
    }).finally(() => { task.cancellation = undefined; });
    task.cancellation = cancellation;
    return cancellation;
  }
}
