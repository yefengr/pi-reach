import { createHash, randomUUID, type Hash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, parse } from "node:path";
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, type ClientFrame, type FileErrorCode, type ServerFrame } from "@pi-reach/protocol/session";
import { inspectFile } from "./content-type.js";
import { FileAccessError, openSourceFile } from "./safe-open.js";

export type FileScope = { ownerId: string; channelId: string; runtimeId: string; sessionId: string; generation: number };
type Request = Extract<ClientFrame, { type: "file_open" | "file_read" | "file_close" }>;
type Response = Extract<ServerFrame, { type: "file_opened" | "file_chunk" | "file_closed" | "file_error" }>;
type Opened = Extract<Response, { type: "file_opened" }>;
type Options = {
  resolve: (scope: FileScope, publicationId: string) => { sourcePath: string } | null | Promise<{ sourcePath: string } | null>;
  isCurrent: (scope: FileScope) => boolean;
  idleMs?: number;
  maxResources?: number;
};
type Resource = {
  scope?: FileScope; key?: string; publicationId?: string; transferId: string; lease: symbol;
  path?: string; stat?: BigIntStats; handle?: FileHandle; hash: Hash; offset: number;
  invalid: boolean; active: boolean; lastUsed: number; opened?: Opened; pending?: Promise<Response>;
  cancelled: Promise<never>; cancel: (code: FileErrorCode) => void; closing?: Promise<void>; closeFailed?: boolean; retryAt?: number;
};
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_MAX_RESOURCES = 8;
// reload 后仍持有的资源继续占额；共享账本只存租约，不复用实例回调或 scope。
const RESOURCE_LEDGER = Symbol.for("pi-reach:file-reader:resource-leases");
const processState = globalThis as typeof globalThis & { [key: symbol]: Set<symbol> | undefined };
const processLeases = processState[RESOURCE_LEDGER] ??= new Set<symbol>();

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function errorCode(error: unknown): FileErrorCode {
  return error instanceof FileAccessError ? error.code : "io_error";
}
function scopeKey(scope: FileScope): string {
  return JSON.stringify([scope.ownerId, scope.channelId, scope.runtimeId, scope.sessionId, scope.generation]);
}

/** 所有异步任务共享额度；失效不等于内核 I/O 已停止或句柄已关闭。 */
export class FileReaderRuntime {
  private readonly resources = new Set<Resource>();
  private readonly opens = new Map<string, Resource>();
  private readonly idleMs: number;
  private readonly maxResources: number;
  private timer?: ReturnType<typeof setTimeout>;
  private timerDeadline?: number;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0 || !Number.isInteger(this.maxResources)
      || this.maxResources < 1 || this.maxResources > DEFAULT_MAX_RESOURCES) throw new Error("invalid reader limits");
  }

  get resourceCount(): number { return this.resources.size; }

  private reserve(scope?: FileScope, key?: string, publicationId?: string): Resource {
    if (this.disposed) throw new FileAccessError("not_available");
    if (this.resources.size >= this.maxResources || processLeases.size >= DEFAULT_MAX_RESOURCES) throw new ReaderError("busy");
    let reject!: (error: Error) => void;
    const cancelled = new Promise<never>((_, failure) => { reject = failure; });
    // 没有请求等待的 idle 取消也不能制造 unhandled rejection。
    void cancelled.catch(() => undefined);
    const resource: Resource = {
      scope: scope && { ...scope }, key, publicationId, transferId: randomUUID(), lease: Symbol(), hash: createHash("sha256"),
      offset: 0, invalid: false, active: true, lastUsed: Date.now(), cancelled,
      cancel: (code) => reject(new ReaderError(code)),
    };
    processLeases.add(resource.lease);
    this.resources.add(resource);
    if (key) this.opens.set(key, resource);
    this.schedule();
    return resource;
  }

  private schedule(): void {
    const deadline = this.resources.size ? Math.min(...[...this.resources].map((resource) => resource.invalid
      ? resource.retryAt! : resource.lastUsed + this.idleMs)) : undefined;
    if (this.timer && this.timerDeadline === deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDeadline = deadline;
    if (deadline === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDeadline = undefined;
      const now = Date.now();
      for (const resource of this.resources) {
        if (resource.invalid ? resource.retryAt! <= now : resource.lastUsed + this.idleMs <= now) {
          this.invalidate(resource);
          // 失效且底层 I/O 未结束或关闭失败时，不能按已过期 idle deadline 忙循环。
          resource.retryAt = now + this.idleMs;
          if (!resource.active) void this.cleanup(resource);
        }
      }
      this.schedule();
    }, Math.max(1, deadline - Date.now()));
    this.timer.unref?.();
  }

  private invalidate(resource: Resource, code: FileErrorCode = "invalid_transfer"): void {
    resource.invalid = true;
    resource.retryAt ??= Date.now() + this.idleMs;
    resource.cancel(code);
  }

  private assertCurrent(resource: Resource): void {
    if (resource.invalid || this.disposed || (resource.scope && !this.options.isCurrent(resource.scope))) {
      throw new ReaderError("invalid_transfer");
    }
  }

  private async eligible(resource: Resource): Promise<void> {
    this.assertCurrent(resource);
    if (!resource.scope || !resource.publicationId) return;
    const publication = await this.options.resolve(resource.scope, resource.publicationId);
    this.assertCurrent(resource);
    if (!publication) throw new FileAccessError("not_available");
    if (resource.path && publication.sourcePath !== resource.path) throw new FileAccessError("file_changed");
    if (!resource.path) resource.path = publication.sourcePath;
  }

  private async checked<T>(resource: Resource, operation: () => Promise<T>): Promise<T> {
    await this.eligible(resource);
    this.assertCurrent(resource);
    const result = await operation();
    this.assertCurrent(resource);
    await this.eligible(resource);
    return result;
  }

  private release(resource: Resource): void {
    if (resource.active || resource.handle || resource.closing) return;
    if (this.resources.delete(resource)) processLeases.delete(resource.lease);
    if (resource.key && this.opens.get(resource.key) === resource) this.opens.delete(resource.key);
    this.schedule();
  }

  private async closeHandle(resource: Resource): Promise<void> {
    if (resource.closing) return resource.closing;
    if (!resource.handle) return;
    const handle = resource.handle;
    resource.closing = handle.close().then(() => { resource.handle = undefined; });
    try { await resource.closing; resource.closeFailed = false; }
    catch (error) {
      resource.closeFailed = true;
      resource.retryAt = Date.now() + this.idleMs;
      if (resource.invalid) this.schedule();
      throw error;
    }
    finally { resource.closing = undefined; }
  }

  private async cleanup(resource: Resource): Promise<void> {
    try { await this.closeHandle(resource); } catch { /* 保留真实句柄和额度，下次取消/idle/dispose 重试。 */ }
    this.release(resource);
    this.schedule();
  }

  private async finish(resource: Resource): Promise<void> {
    resource.active = false;
    resource.lastUsed = Date.now();
    if (resource.invalid && !resource.closeFailed) await this.cleanup(resource);
    else this.release(resource);
    this.schedule();
  }

  private reply(frame: Request, scope: FileScope) {
    return { protocol_version: 2 as const, target_channel_id: scope.channelId, session_id: scope.sessionId, in_reply_to: frame.id };
  }

  private failure(frame: Request, scope: FileScope, error: unknown): Response {
    const code = error instanceof ReaderError ? error.code : errorCode(error);
    return { ...this.reply(frame, scope), type: "file_error", code,
      ...("transfer_id" in frame ? { transfer_id: frame.transfer_id } : {}) };
  }

  async handle(frame: Request, suppliedScope: FileScope): Promise<Response> {
    const scope = { ...suppliedScope };
    try {
      if (this.disposed || !this.options.isCurrent(scope)) throw new ReaderError("invalid_transfer");
      if (frame.type === "file_open") return await this.open(frame, scope);
      const resource = [...this.resources].find((item) => item.transferId === frame.transfer_id
        && item.scope && scopeKey(item.scope) === scopeKey(scope));
      if (!resource) throw new ReaderError("invalid_transfer");
      if (frame.type === "file_close") {
        this.invalidate(resource);
        if (resource.active) throw new ReaderError("busy");
        await this.closeHandle(resource);
        this.release(resource);
        if (this.disposed || !this.options.isCurrent(scope)) throw new ReaderError("invalid_transfer");
        return { ...this.reply(frame, scope), type: "file_closed", transfer_id: frame.transfer_id };
      }
      this.assertCurrent(resource);
      if (resource.active) throw new ReaderError("busy");
      if (frame.offset !== resource.offset) throw new ReaderError("offset_mismatch");
      resource.active = true;
      resource.lastUsed = Date.now();
      this.schedule();
      const response = await Promise.race([this.readTask(resource, frame, scope), resource.cancelled]);
      if (response.type !== "file_error") this.assertCurrent(resource);
      return response;
    } catch (error) { return this.failure(frame, scope, error); }
  }

  private async open(frame: Extract<Request, { type: "file_open" }>, scope: FileScope): Promise<Response> {
    const key = `${scopeKey(scope)}:${JSON.stringify(frame.id)}`;
    const existing = this.opens.get(key);
    if (existing) {
      if (existing.publicationId !== frame.publication_id) throw new ReaderError("invalid_transfer");
      this.assertCurrent(existing);
      const replay = async () => {
        await this.eligible(existing);
        return existing.opened ?? await existing.pending!;
      };
      return this.openResponse(existing, replay());
    }
    const resource = this.reserve(scope, key, frame.publication_id);
    resource.pending = this.openTask(resource, frame, scope);
    return this.openResponse(resource, resource.pending);
  }

  private async openResponse(resource: Resource, pending: Promise<Response>): Promise<Response> {
    try {
      const response = await Promise.race([pending, resource.cancelled]);
      if (response.type !== "file_error") {
        await Promise.race([this.eligible(resource), resource.cancelled]);
        this.assertCurrent(resource);
      }
      resource.lastUsed = Date.now();
      this.schedule();
      return response;
    } catch (error) {
      this.invalidate(resource, error instanceof ReaderError ? error.code : errorCode(error));
      if (!resource.active && !resource.closeFailed) void this.cleanup(resource);
      throw error;
    }
  }

  private async openTask(resource: Resource, frame: Extract<Request, { type: "file_open" }>, scope: FileScope): Promise<Response> {
    try {
      await this.eligible(resource);
      this.assertCurrent(resource);
      const opened = await openSourceFile(resource.path!, { resolveLinks: false, maxBytes: FILE_MAX_BYTES });
      // 迟到句柄必须先入账，再检查失效，不能由 Promise.race 丢失所有权。
      resource.handle = opened.handle; resource.stat = opened.stat;
      this.assertCurrent(resource);
      await this.eligible(resource);
      const fileName = basename(opened.path);
      if (!fileName || fileName.length > 255 || /\p{Cc}/u.test(fileName)) throw new FileAccessError("not_available");
      const inspection = await this.checked(resource, () => inspectFile(opened.handle, Number(opened.stat.size), fileName));
      await this.verify(resource);
      this.assertCurrent(resource);
      resource.opened = { ...this.reply(frame, scope), type: "file_opened", publication_id: frame.publication_id,
        transfer_id: resource.transferId, file_name: fileName, byte_length: Number(opened.stat.size),
        mime_type: inspection.mimeType, preview: inspection.preview };
      return resource.opened;
    } catch (error) {
      if (error instanceof FileAccessError && error.handle) { resource.handle = error.handle; resource.closeFailed = true; }
      this.invalidate(resource, error instanceof ReaderError ? error.code : errorCode(error));
      return this.failure(frame, scope, error);
    } finally { await this.finish(resource); }
  }

  private async verify(resource: Resource): Promise<void> {
    const current = await this.checked(resource, () => resource.handle!.stat({ bigint: true }));
    if (!sameFile(resource.stat!, current)) throw new FileAccessError("file_changed");
    // 对父路径逐层拒绝后来引入的链接；同一句柄属性检查不能替代路径身份检查。
    let parent = dirname(resource.path!);
    const root = parse(parent).root;
    while (true) {
      const stat = await this.checked(resource, () => lstat(parent, { bigint: true }));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileAccessError("file_changed");
      if (parent === root) break;
      parent = dirname(parent);
    }
    try {
      const atPath = await this.checked(resource, () => lstat(resource.path!, { bigint: true }));
      if (atPath.isSymbolicLink() || !sameFile(resource.stat!, atPath)) throw new FileAccessError("file_changed");
      const canonical = await this.checked(resource, () => realpath(resource.path!));
      if (canonical !== resource.path) throw new FileAccessError("file_changed");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) {
        throw new FileAccessError("file_changed");
      }
      throw error;
    }
  }

  private async readTask(resource: Resource, frame: Extract<Request, { type: "file_read" }>, scope: FileScope): Promise<Response> {
    try {
      const response = await this.read(resource, frame, scope);
      if (response.type !== "file_error") await this.eligible(resource);
      return response;
    } catch (error) {
      this.invalidate(resource, error instanceof ReaderError ? error.code : errorCode(error));
      return this.failure(frame, scope, error);
    } finally { await this.finish(resource); }
  }

  private async read(resource: Resource, frame: Extract<Request, { type: "file_read" }>, scope: FileScope): Promise<Response> {
    try {
      await this.verify(resource);
      const total = Number(resource.stat!.size);
      const data = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, total - resource.offset));
      let count = 0;
      while (count < data.length) {
        const result = await this.checked(resource, () => resource.handle!.read(data, count, data.length - count, resource.offset + count));
        if (!result.bytesRead) throw new FileAccessError("file_changed");
        count += result.bytesRead;
      }
      await this.verify(resource);
      resource.hash.update(data);
      resource.offset += data.length;
      const common = { ...this.reply(frame, scope), type: "file_chunk" as const, transfer_id: resource.transferId,
        offset: frame.offset, data_base64: data.toString("base64") };
      if (resource.offset !== total) return { ...common, final: false };
      const sha256 = resource.hash.digest("hex");
      await this.checked(resource, () => this.closeHandle(resource));
      this.assertCurrent(resource);
      return { ...common, final: true, total_bytes: total, sha256 };
    } catch (error) {
      this.invalidate(resource, error instanceof ReaderError ? error.code : errorCode(error));
      return this.failure(frame, scope, error);
    }
  }

  async inspectForPublication(path: string): Promise<{ sourcePath: string; fileName: string; mimeType: string; byteLength: number }> {
    const resource = this.reserve();
    const task = this.inspectTask(resource, path);
    return Promise.race([task, resource.cancelled]);
  }

  private async inspectTask(resource: Resource, path: string) {
    try {
      this.assertCurrent(resource);
      const opened = await openSourceFile(path, { resolveLinks: true, maxBytes: FILE_MAX_BYTES });
      resource.handle = opened.handle; resource.path = opened.path; resource.stat = opened.stat;
      this.assertCurrent(resource);
      const fileName = basename(opened.path);
      if (!fileName || fileName.length > 255 || /\p{Cc}/u.test(fileName)) throw new FileAccessError("not_available");
      const inspection = await this.checked(resource, () => inspectFile(opened.handle, Number(opened.stat.size), fileName));
      await this.verify(resource);
      await this.checked(resource, () => this.closeHandle(resource));
      return { sourcePath: opened.path, fileName, mimeType: inspection.mimeType, byteLength: Number(opened.stat.size) };
    } catch (error) {
      if (error instanceof FileAccessError && error.handle) { resource.handle = error.handle; resource.closeFailed = true; }
      this.invalidate(resource, error instanceof ReaderError ? error.code : errorCode(error));
      throw error;
    } finally { await this.finish(resource); }
  }

  async closeWhere(predicate: (scope: FileScope) => boolean): Promise<void> {
    const matches = [...this.resources].filter((resource) => resource.scope && predicate({ ...resource.scope }));
    for (const resource of matches) this.invalidate(resource);
    await Promise.all(matches.filter((resource) => !resource.active).map((resource) => this.cleanup(resource)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const resources = [...this.resources];
    for (const resource of resources) this.invalidate(resource);
    await Promise.all(resources.filter((resource) => !resource.active).map((resource) => this.cleanup(resource)));
  }
}

class ReaderError extends Error {
  constructor(readonly code: FileErrorCode) { super(code); }
}
