import {
  FILE_AUTO_IMAGE_BYTES, FILE_MAX_BYTES, publishedFileDescriptorSchema,
  type ClientFrame, type PublishedFileDescriptor, type ServerFrame,
} from "@pi-reach/protocol/session";
import type { TimelineScope } from "./timeline-runtime";
import { textFilePreview } from "./file-preview";
import { FILE_CACHE_BYTES, FileTransferCache } from "./file-transfer-cache";
import { FileTransferRequests } from "./file-transfer-requests";
import {
  FileTransferError, type FileOpened, type FileTransferErrorCode, type FileTransferIntent,
  type FileTransferOptions, type FileTransferRequest, type FileTransferResult, type FileTransferSnapshot,
  type PublishedFileState,
} from "./file-transfer-types";

export type {
  FileOpened, FileTransferErrorCode, FileTransferIntent, FileTransferOptions, FileTransferPhase,
  FileTransferResult, FileTransferSnapshot, PublishedFileState,
} from "./file-transfer-types";

type Task = {
  descriptor: PublishedFileDescriptor;
  intent: FileTransferIntent;
  scope: TimelineScope;
  send: (frame: ClientFrame) => void;
  valid: boolean;
  generation: number;
  openRequest?: Extract<FileTransferRequest, { type: "file_open" }>;
  closeAttempted?: boolean;
  current?: FileOpened;
  bytes?: Uint8Array<ArrayBuffer>;
  received: number;
  promise: Promise<void>;
};
function sameTarget(left: TimelineScope | undefined, right: TimelineScope): boolean {
  return !!left && left.deviceId === right.deviceId && left.endpointId === right.endpointId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.sessionId === right.sessionId
    && left.selfSenderRef === right.selfSenderRef;
}
function previewAllowed(current: FileOpened, intent: FileTransferIntent): boolean {
  if (intent === "download") return true;
  if (current.preview.kind === "image") return intent === "view" || current.byte_length <= FILE_AUTO_IMAGE_BYTES;
  return intent === "view" && current.preview.kind === "text";
}
function decodeChunk(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class FileTransferController {
  private scope?: TimelineScope;
  private send?: (frame: ClientFrame) => void;
  private task?: Task;
  private disposed = false;
  private generation = 0;
  private state: FileTransferSnapshot = { active: false, files: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly requests: FileTransferRequests;
  private readonly cache: FileTransferCache;
  private readonly requestId: () => string;
  private readonly crypto: Pick<Crypto, "subtle">;
  private readonly urls: NonNullable<FileTransferOptions["URL"]>;

  constructor(options: FileTransferOptions = {}) {
    this.requestId = options.requestId ?? (() => globalThis.crypto.randomUUID());
    this.crypto = options.crypto ?? globalThis.crypto;
    this.urls = options.URL ?? URL;
    this.requests = new FileTransferRequests(options.timers ?? {
      // 浏览器原生计时器需要 Window receiver，不能以 timers 对象作为 this 调用。
      setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const budget = options.cacheBytes ?? FILE_CACHE_BYTES;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > FILE_CACHE_BYTES) throw new RangeError("cacheBytes");
    this.cache = new FileTransferCache(budget, (url) => this.urls.revokeObjectURL(url), (id) => {
      const entry = this.state.files.get(id);
      if (entry) this.replace(id, { ...entry, phase: "idle", result: undefined, receivedBytes: 0 });
    });
  }

  readonly snapshot = (): FileTransferSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  pin(id: string): void { if (!this.disposed) this.cache.pin(id); }
  unpin(id: string): void { this.cache.unpin(id); }

  connect(scope: TimelineScope, send: (frame: ClientFrame) => void): void {
    if (this.disposed) return;
    if (this.scope && !sameTarget(this.scope, scope)) this.reset();
    else if (this.scope && this.scope.channelId !== scope.channelId) this.disconnect();
    this.scope = { ...scope };
    this.send = send;
  }
  disconnect(): void {
    this.send = undefined;
    this.stop("disconnected");
    this.requests.clearRetired();
    this.generation++;
  }
  reset(): void {
    this.scope = undefined;
    this.send = undefined;
    this.stop("cancelled");
    this.requests.cancel("cancelled");
    this.requests.clearRetired();
    this.generation++;
    this.cache.reset();
    this.state = { active: false, files: new Map() };
    this.notify();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.listeners.clear();
  }
  receive(frame: ServerFrame): boolean { return !this.disposed && this.requests.receive(frame); }
  cancel(): void { this.stop("cancelled"); }
  /** 解码失败后的明确重试从原件重新获取，不循环复用损坏的 Blob。 */
  retry(descriptor: PublishedFileDescriptor, intent: FileTransferIntent): Promise<void> {
    if (this.disposed || !publishedFileDescriptorSchema.safeParse(descriptor).success) return Promise.resolve();
    if (!this.scope || !this.send) return Promise.resolve();
    this.cache.drop(descriptor.publication_id);
    return this.open(descriptor, intent);
  }

  /** 失败在 snapshot 中呈现；Promise 在成功、manual、取消或错误时均结束，无自动重试。 */
  open(descriptor: PublishedFileDescriptor, intent: FileTransferIntent): Promise<void> {
    if (this.disposed || !publishedFileDescriptorSchema.safeParse(descriptor).success) return Promise.resolve();
    const existing = this.state.files.get(descriptor.publication_id);
    if (existing?.phase === "ready") {
      this.cache.touch(descriptor.publication_id);
      if (existing.intent !== intent) this.publish(descriptor.publication_id, { ...existing, intent });
      return Promise.resolve();
    }
    if (this.task?.descriptor.publication_id === descriptor.publication_id) return this.task.promise;
    if (intent === "auto" && (this.task || existing?.phase === "error" || existing?.phase === "manual")) return Promise.resolve();
    this.stop("cancelled");
    if (!this.scope || !this.send) {
      this.publish(descriptor.publication_id, { descriptor, intent, phase: "error", receivedBytes: 0, error: "disconnected" });
      return Promise.resolve();
    }
    const task: Task = {
      descriptor: { ...descriptor }, intent, scope: { ...this.scope }, send: this.send,
      valid: true, generation: this.generation, received: 0, promise: Promise.resolve(),
    };
    this.task = task;
    task.promise = Promise.resolve().then(() => this.run(task));
    this.publish(descriptor.publication_id, { descriptor: task.descriptor, intent, phase: "opening", receivedBytes: 0 });
    return task.promise;
  }

  private async run(task: Task): Promise<void> {
    try {
      if (!this.isCurrent(task)) return;
      const opened = await this.request(task, { type: "file_open", publication_id: task.descriptor.publication_id });
      if (opened.type !== "file_opened") return;
      task.current = opened;
      if (task.openRequest) this.requests.settleOpen(task.openRequest.id);
      // receive 已 resolve、但 run 尚未恢复时取消，也必须保住句柄的清理机会。
      if (!this.isCurrent(task)) { this.close(task); return; }
      if (!previewAllowed(opened, task.intent)) {
        this.complete(task, { ...this.taskState(task), phase: "manual" });
        this.close(task);
        return;
      }
      if (opened.byte_length > FILE_MAX_BYTES || !this.cache.reserve(opened.byte_length)) throw new FileTransferError("no_space");
      task.bytes = new Uint8Array(opened.byte_length);
      this.publish(task.descriptor.publication_id, { ...this.taskState(task), phase: "reading" });
      await this.read(task);
    } catch (error) {
      if (!this.isCurrent(task)) return;
      const code = error instanceof FileTransferError ? error.code : "io_error";
      this.stop(code);
    }
  }

  private async read(task: Task): Promise<void> {
    while (this.isCurrent(task) && task.current && task.bytes) {
      const chunk = await this.request(task, { type: "file_read", transfer_id: task.current.transfer_id, offset: task.received });
      if (!this.isCurrent(task) || chunk.type !== "file_chunk" || !task.bytes) return;
      const bytes = decodeChunk(chunk.data_base64);
      if (task.received + bytes.byteLength > task.bytes.byteLength) throw new FileTransferError("integrity_mismatch");
      task.bytes.set(bytes, task.received);
      task.received += bytes.byteLength;
      if (chunk.final) {
        if (chunk.total_bytes !== task.bytes.byteLength || task.received !== task.bytes.byteLength) {
          throw new FileTransferError("integrity_mismatch");
        }
        this.publish(task.descriptor.publication_id, { ...this.taskState(task), phase: "reading" });
        if (this.isCurrent(task)) await this.finish(task, chunk.sha256);
        return;
      }
      if (task.received >= task.bytes.byteLength) throw new FileTransferError("integrity_mismatch");
      this.publish(task.descriptor.publication_id, { ...this.taskState(task), phase: "reading" });
    }
  }

  private async finish(task: Task, expected: string): Promise<void> {
    if (!task.bytes || !task.current) return;
    const digest = await this.crypto.subtle.digest("SHA-256", task.bytes);
    if (!this.isCurrent(task) || !task.bytes) return;
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== expected) throw new FileTransferError("integrity_mismatch");
    let text: string | undefined;
    if (task.current.preview.kind === "text") {
      const preview = textFilePreview(task.bytes);
      if (!preview && task.intent === "view") throw new FileTransferError("invalid_text");
      text = preview?.text;
    }
    // URL 仅供下载或合格的栅格图像；none/text 不使用服务器 MIME 激活 HTML/SVG。
    const mime = task.current.preview.kind === "image" && /^(?:image\/(?:png|jpeg|gif|webp))$/u.test(task.current.mime_type)
      ? task.current.mime_type : "application/octet-stream";
    const blob = new Blob([task.bytes], { type: mime });
    const url = this.urls.createObjectURL(blob);
    if (!this.isCurrent(task)) { this.urls.revokeObjectURL(url); return; }
    const result: FileTransferResult = { blob, url, ...(text !== undefined ? { text } : {}) };
    this.cache.commit(task.descriptor.publication_id, result);
    task.bytes = undefined;
    this.complete(task, { ...this.taskState(task), phase: "ready", result });
    this.close(task);
  }

  private request(task: Task, operation: { type: "file_open"; publication_id: string }
    | { type: "file_read"; transfer_id: string; offset: number }) {
    const frame: FileTransferRequest = {
      protocol_version: 2, id: this.requestId(), channel_id: task.scope.channelId, session_id: task.scope.sessionId, ...operation,
    };
    return this.requests.request(frame, (sent) => {
      if (sent.type === "file_open") task.openRequest = sent;
      task.send(sent);
    }, () => { if (this.isCurrent(task)) this.stop("timeout"); });
  }
  private close(task: Task): void {
    if (!task.current || task.closeAttempted || task.generation !== this.generation) return;
    task.closeAttempted = true;
    try {
      task.send({ protocol_version: 2, type: "file_close", id: this.requestId(), channel_id: task.scope.channelId,
        session_id: task.scope.sessionId, transfer_id: task.current.transfer_id });
    } catch { /* 正常切换不等待关闭响应；远端 idle timeout 兜底。 */ }
  }
  private stop(code: FileTransferErrorCode): void {
    const task = this.task;
    if (!task) return;
    task.valid = false;
    this.task = undefined;
    if (!task.current && task.openRequest && (code === "cancelled" || code === "timeout")) {
      this.requests.retireOpen(task.openRequest, (opened) => { task.current = opened; this.close(task); });
    }
    this.requests.cancel(code);
    this.cache.release();
    task.bytes = undefined;
    this.publish(task.descriptor.publication_id, { ...this.taskState(task), phase: "error", error: code });
    this.close(task);
  }
  private complete(task: Task, state: PublishedFileState): void {
    task.valid = false;
    this.task = undefined;
    this.publish(task.descriptor.publication_id, state);
  }
  private isCurrent(task: Task): boolean { return task.valid && this.task === task && !this.disposed; }
  private taskState(task: Task): PublishedFileState {
    return { descriptor: task.descriptor, intent: task.intent, phase: "reading", current: task.current, receivedBytes: task.received };
  }
  private replace(id: string, entry: PublishedFileState): void {
    const files = new Map(this.state.files);
    files.set(id, entry);
    this.state = { active: !!this.task, files };
  }
  private publish(id: string, entry: PublishedFileState): void { this.replace(id, entry); this.notify(); }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
