import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IN_FLIGHT, ATTACHMENT_MAX_MESSAGE_BYTES,
  attachmentDescriptorSchema, attachmentIdsSchema, idSchema,
  type AttachmentDescriptor,
} from "@pi-reach/protocol/session";
import { DiskReservation } from "./reservations.js";
import { assertDirectories, assertRegularFile, createPrivateFile, ensurePrivateDirectory } from "./safe-files.js";
import {
  AttachmentStoreError, nodeErrorHasCode, storeError,
  type AttachmentBeginInput, type AttachmentScope, type AttachmentStoreOptions, type AttachmentUploadState,
} from "./types.js";

export { AttachmentStoreError } from "./types.js";
export type {
  AttachmentBeginInput, AttachmentScope, AttachmentStoreOptions, AttachmentStoreTestHooks, AttachmentUploadState,
} from "./types.js";

const DEFAULT_FREE_BYTES = 64 * 1024 * 1024;
const MAX_OWNER_PENDING = ATTACHMENT_MAX_COUNT * ATTACHMENT_MAX_IN_FLIGHT;
const MAX_METADATA_RECORDS = 4096;
// 包括已失效租约尚未完成清理的资源，避免快速 reset 堆积磁盘任务。
const MAX_GLOBAL_ACTIVE = MAX_OWNER_PENDING;

interface Tombstone {
  attachmentId?: string;
  scope: AttachmentScope;
  cancelled: true;
  received: number;
}

type RecordEntry = Upload | Tombstone;

function isUpload(entry: RecordEntry): entry is Upload {
  return "tail" in entry;
}

interface Upload {
  key: string;
  scope: AttachmentScope;
  input?: AttachmentBeginInput;
  descriptor?: AttachmentDescriptor;
  path?: string;
  handle?: FileHandle;
  inode?: number;
  device?: number;
  reservation?: DiskReservation;
  hash: Hash;
  received: number;
  complete: boolean;
  cancelled: boolean;
  retained: boolean;
  failure?: AttachmentStoreError;
  tail: Promise<void>;
  pending: number;
  cleanupTask?: Promise<void>;
  cleanupFailure?: AttachmentStoreError;
}

function freezeDescriptor(descriptor: AttachmentDescriptor): AttachmentDescriptor {
  if (descriptor.preview) Object.freeze(descriptor.preview);
  return Object.freeze(descriptor);
}

export class AttachmentStore {
  private readonly root: string;
  private readonly floor: bigint;
  private uploads = new Map<string, RecordEntry>();
  private byAttachment = new Map<string, Upload>();
  private readonly resources = new Set<Upload>();
  private readonly metadataLimit: number;
  private readonly ownerPending = new Map<string, number>();
  private readonly cleanups = new Set<Promise<void>>();
  private sessionId?: string;
  private lease?: string;
  private disposed = false;
  private disposing?: Promise<void>;

  constructor(private readonly options: AttachmentStoreOptions) {
    if (!idSchema.safeParse(options.runtimeId).success ||
        !Number.isSafeInteger(options.minFreeBytes ?? DEFAULT_FREE_BYTES) ||
        (options.minFreeBytes ?? DEFAULT_FREE_BYTES) < 0) throw new AttachmentStoreError("invalid_upload");
    this.root = resolvePath(options.rootDir ?? join(homedir(), ".pi", "pi-reach", "attachments"));
    this.floor = BigInt(options.minFreeBytes ?? DEFAULT_FREE_BYTES);
    this.metadataLimit = options.testHooks?.metadataLimit ?? MAX_METADATA_RECORDS;
    if (!Number.isSafeInteger(this.metadataLimit) || this.metadataLimit < 1 || this.metadataLimit > MAX_METADATA_RECORDS) {
      throw new AttachmentStoreError("invalid_upload");
    }
  }

  scopeFor(sessionId: string): string {
    if (this.disposed || !idSchema.safeParse(sessionId).success) throw new AttachmentStoreError("invalid_scope");
    if (this.sessionId !== sessionId) this.resetScope(sessionId);
    return this.lease!;
  }

  resetScope(sessionId: string): void {
    if (this.disposed || !idSchema.safeParse(sessionId).success) throw new AttachmentStoreError("invalid_scope");
    this.sessionId = sessionId;
    this.lease = randomUUID();
    this.uploads = new Map();
    this.byAttachment = new Map();
    // 索引只覆盖当前租约；此前失败的清理仍在资源集合中，后续 reset 也须重试。
    for (const entry of this.resources) {
      if (entry.retained) continue;
      entry.cancelled = true;
      void this.scheduleCleanup(entry).catch(() => undefined);
    }
    // 旧 retained / 墓碑立即释放；原件仅留磁盘。活资源清理后释放最后引用。
  }

  private validScope(scope: AttachmentScope): boolean {
    return !this.disposed && idSchema.safeParse(scope.ownerId).success &&
      scope.sessionId === this.sessionId && scope.uploadScope === this.lease;
  }

  private checkScope(scope: AttachmentScope): void {
    if (!this.validScope(scope)) throw new AttachmentStoreError("invalid_scope");
  }

  private key(scope: AttachmentScope, uploadId: string): string {
    this.checkScope(scope);
    if (!idSchema.safeParse(uploadId).success) throw new AttachmentStoreError("invalid_upload");
    return JSON.stringify([scope.ownerId, scope.sessionId, scope.uploadScope, uploadId]);
  }

  private newUpload(key: string, scope: AttachmentScope): Upload {
    return {
      key, scope: { ...scope }, hash: createHash("sha256"), received: 0, complete: false,
      cancelled: false, retained: false, tail: Promise.resolve(), pending: 0,
    };
  }

  private checkMetadataBudget(scope: AttachmentScope): void {
    const ownerCount = [...this.uploads.values()].filter((entry) => entry.scope.ownerId === scope.ownerId).length;
    if (this.uploads.size >= this.metadataLimit || ownerCount >= this.metadataLimit) {
      throw new AttachmentStoreError("busy", true);
    }
  }

  /** 仅测试观察数量，不包含路径、元信息或原始错误。 */
  debugCounts(): { records: number; attachments: number; resources: number; cleanups: number; pending: number } {
    return { records: this.uploads.size, attachments: this.byAttachment.size, resources: this.resources.size,
      cleanups: this.cleanups.size, pending: [...this.ownerPending.values()].reduce((sum, count) => sum + count, 0) };
  }

  private state(upload: RecordEntry, uploadId: string): AttachmentUploadState {
    if (!isUpload(upload) || (upload.cancelled && !upload.retained)) {
      return { uploadId, receivedBytes: upload.received, status: "cancelled" };
    }
    return {
      uploadId, receivedBytes: upload.received, status: upload.complete ? "complete" : "receiving",
      ...(upload.complete ? { attachment: upload.descriptor } : {}),
    };
  }

  private enqueue<T>(upload: Upload, operation: () => Promise<T>, internal = false): Promise<T> {
    const owner = upload.scope.ownerId;
    const pending = this.ownerPending.get(owner) ?? 0;
    if (!internal && (upload.pending >= ATTACHMENT_MAX_IN_FLIGHT || pending >= MAX_OWNER_PENDING)) {
      return Promise.reject(new AttachmentStoreError("busy", true));
    }
    upload.pending++;
    this.ownerPending.set(owner, pending + 1);
    const task = upload.tail.then(async () => {
      if (!internal) this.checkScope(upload.scope);
      try { return await operation(); } catch (error) { throw storeError(error); }
    });
    upload.tail = task.then(() => undefined, () => undefined).finally(() => {
      upload.pending--;
      const remaining = (this.ownerPending.get(owner) ?? 1) - 1;
      if (remaining) this.ownerPending.set(owner, remaining);
      else this.ownerPending.delete(owner);
    });
    return task;
  }

  private get(scope: AttachmentScope, uploadId: string): RecordEntry {
    const upload = this.uploads.get(this.key(scope, uploadId));
    if (!upload) throw new AttachmentStoreError("not_found");
    return upload;
  }

  private assertFile(upload: Upload, finished = false): void {
    try {
      if (!upload.path) throw new AttachmentStoreError("invalid_upload");
      assertDirectories(dirname(upload.path));
      const stat = assertRegularFile(upload.path);
      if (stat.ino !== upload.inode || stat.dev !== upload.device || stat.nlink !== 1 ||
          (finished && stat.size !== upload.input?.byteLength)) throw new AttachmentStoreError("invalid_upload");
    } catch (error) { throw storeError(error); }
  }

  private checkedState(upload: Upload, uploadId: string): AttachmentUploadState {
    this.checkScope(upload.scope);
    if (upload.failure && !upload.cancelled) throw upload.failure;
    return this.state(upload, uploadId);
  }

  async begin(scope: AttachmentScope, input: AttachmentBeginInput): Promise<AttachmentUploadState> {
    const key = this.key(scope, input.uploadId);
    if (Number.isFinite(input.byteLength) && input.byteLength > ATTACHMENT_MAX_FILE_BYTES) {
      throw new AttachmentStoreError("too_large");
    }
    const parsed = attachmentDescriptorSchema.safeParse({
      attachment_id: randomUUID(), file_name: input.fileName, mime_type: input.mimeType,
      byte_length: input.byteLength, sha256: input.sha256, ...(input.preview ? { preview: input.preview } : {}),
    });
    if (!parsed.success) throw new AttachmentStoreError("invalid_upload");
    const normalized: AttachmentBeginInput = {
      uploadId: input.uploadId, fileName: parsed.data.file_name, mimeType: parsed.data.mime_type,
      byteLength: parsed.data.byte_length, sha256: parsed.data.sha256,
      ...(parsed.data.preview ? { preview: parsed.data.preview } : {}),
    };
    const existing = this.uploads.get(key);
    if (existing) {
      if (!isUpload(existing) || existing.cancelled) return this.state(existing, input.uploadId);
      if (JSON.stringify(existing.input) !== JSON.stringify(normalized)) throw new AttachmentStoreError("invalid_upload");
      return this.enqueue(existing, async () => this.checkedState(existing, input.uploadId));
    }
    this.checkMetadataBudget(scope);
    if (this.resources.size >= MAX_GLOBAL_ACTIVE || (this.ownerPending.get(scope.ownerId) ?? 0) >= MAX_OWNER_PENDING) {
      throw new AttachmentStoreError("busy", true);
    }
    const active = [...this.resources].filter((upload) => upload.scope.ownerId === scope.ownerId);
    if (active.length >= ATTACHMENT_MAX_COUNT ||
        active.reduce((sum, upload) => sum + (upload.input?.byteLength ?? 0), 0) + input.byteLength > ATTACHMENT_MAX_MESSAGE_BYTES) {
      throw new AttachmentStoreError("too_large");
    }
    const upload = this.newUpload(key, scope);
    upload.input = normalized;
    upload.descriptor = freezeDescriptor(parsed.data);
    this.uploads.set(key, upload);
    this.resources.add(upload);
    return this.enqueue(upload, async () => {
      if (upload.cancelled) return this.state(upload, input.uploadId);
      try {
        ensurePrivateDirectory(this.root);
        const sessionDirectory = join(this.root, createHash("sha256").update(scope.sessionId).digest("hex"));
        ensurePrivateDirectory(sessionDirectory);
        upload.reservation = new DiskReservation(this.root, this.options.runtimeId, input.uploadId,
          input.byteLength, this.floor, this.options.testHooks);
        await upload.reservation.publish();
        if (upload.cancelled || !this.validScope(scope)) {
          await this.cleanup(upload);
          return this.checkedState(upload, input.uploadId);
        }
        const path = join(sessionDirectory, `${parsed.data.attachment_id}.bin`);
        upload.handle = await (this.options.testHooks?.createFile ?? createPrivateFile)(path);
        // 成功独占创建后才记录路径；失败不得触碰预先存在的文件。
        upload.path = path;
        const stat = await upload.handle.stat();
        upload.inode = stat.ino;
        upload.device = stat.dev;
        await this.options.testHooks?.afterCreate?.(upload.handle);
        this.byAttachment.set(parsed.data.attachment_id, upload);
        return this.checkedState(upload, input.uploadId);
      } catch (error) {
        const failure = storeError(error);
        upload.failure = failure;
        try { await this.cleanup(upload); } catch { upload.cancelled = true; }
        if (!upload.cancelled && this.uploads.get(key) === upload) this.uploads.delete(key);
        throw failure;
      }
    });
  }

  async write(scope: AttachmentScope, uploadId: string, offset: number, bytes: Uint8Array): Promise<AttachmentUploadState> {
    const upload = this.get(scope, uploadId);
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.byteLength < 1 || bytes.byteLength > ATTACHMENT_CHUNK_BYTES) {
      throw new AttachmentStoreError("invalid_upload");
    }
    if (!isUpload(upload)) return this.state(upload, uploadId);
    // 请求入队时复制，调用方不可在等待期间修改同一 ArrayBuffer。
    const data = Buffer.from(bytes);
    return this.enqueue(upload, async () => {
      if (upload.cancelled) return this.state(upload, uploadId);
      if (upload.failure) throw upload.failure;
      this.assertFile(upload);
      if (offset < upload.received) {
        if (offset + data.length > upload.received) throw new AttachmentStoreError("offset_mismatch");
        await this.compareChunk(upload, offset, data);
        return this.checkedState(upload, uploadId);
      }
      if (offset !== upload.received) throw new AttachmentStoreError("offset_mismatch");
      if (upload.received + data.length > upload.input!.byteLength) throw new AttachmentStoreError("too_large");
      await upload.reservation!.check();
      await this.options.testHooks?.beforeWrite?.();
      if (upload.cancelled || !this.validScope(scope)) return this.checkedState(upload, uploadId);
      this.assertFile(upload);
      let written = 0;
      try {
        while (written < data.length) {
          const chunk = data.subarray(written);
          const count = this.options.testHooks?.write ?
            await this.options.testHooks.write(upload.handle!, chunk, offset + written) :
            (await upload.handle!.write(chunk, 0, chunk.length, offset + written)).bytesWritten;
          if (!Number.isSafeInteger(count) || count <= 0 || count > chunk.length) throw new AttachmentStoreError("io_error", true);
          written += count;
        }
      } catch (error) {
        try { await upload.handle!.truncate(upload.received); } catch {
          upload.cancelled = true;
          this.scheduleCleanup(upload);
        }
        throw error;
      }
      upload.hash.update(data);
      upload.received += data.length;
      await this.options.testHooks?.afterWrite?.(data.length);
      // 整块确实落盘后才减少预留；失败时旧账本仍保守占预算。
      await upload.reservation!.reduce(upload.input!.byteLength - upload.received);
      return this.checkedState(upload, uploadId);
    });
  }

  private async compareChunk(upload: Upload, offset: number, data: Buffer): Promise<void> {
    const temporary = !upload.handle;
    const handle = upload.handle ?? await open(upload.path!, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== upload.inode || stat.dev !== upload.device || stat.nlink !== 1) {
        throw new AttachmentStoreError("invalid_upload");
      }
      const previous = Buffer.alloc(data.length);
      let read = 0;
      while (read < previous.length) {
        const result = await handle.read(previous, read, previous.length - read, offset + read);
        if (!result.bytesRead) throw new AttachmentStoreError("io_error", true);
        read += result.bytesRead;
      }
      if (!previous.equals(data)) throw new AttachmentStoreError("integrity_mismatch");
    } finally {
      if (temporary) await handle.close();
    }
  }

  async finish(scope: AttachmentScope, uploadId: string): Promise<AttachmentUploadState> {
    const upload = this.get(scope, uploadId);
    if (!isUpload(upload)) return this.state(upload, uploadId);
    return this.enqueue(upload, async () => {
      if (upload.cancelled || upload.complete) return this.checkedState(upload, uploadId);
      if (upload.received !== upload.input!.byteLength ||
          upload.hash.copy().digest("hex") !== upload.input!.sha256) throw new AttachmentStoreError("integrity_mismatch");
      this.assertFile(upload, true);
      if (upload.handle) {
        await upload.handle.sync();
        await upload.handle.close();
        upload.handle = undefined;
      }
      await upload.reservation!.remove();
      this.checkScope(scope);
      if (!upload.cancelled) upload.complete = true;
      return this.state(upload, uploadId);
    });
  }

  async status(scope: AttachmentScope, uploadId: string): Promise<AttachmentUploadState> {
    const upload = this.get(scope, uploadId);
    if (!isUpload(upload)) return this.state(upload, uploadId);
    return this.enqueue(upload, async () => this.checkedState(upload, uploadId));
  }

  async cancel(scope: AttachmentScope, uploadId: string): Promise<AttachmentUploadState> {
    const key = this.key(scope, uploadId);
    let upload = this.uploads.get(key);
    if (!upload) {
      this.checkMetadataBudget(scope);
      upload = { scope: { ...scope }, cancelled: true, received: 0 };
      this.uploads.set(key, upload);
    }
    if (!isUpload(upload) || upload.retained) return this.state(upload, uploadId);
    upload.cancelled = true;
    await this.scheduleCleanup(upload);
    return this.checkedState(upload, uploadId);
  }

  async discard(scope: AttachmentScope, attachmentId: string): Promise<"cancelled" | "retained"> {
    this.checkScope(scope);
    if (!idSchema.safeParse(attachmentId).success) throw new AttachmentStoreError("invalid_upload");
    const upload = this.byAttachment.get(attachmentId);
    if (!upload) {
      // 墓碑沿用有界 uploads 账本，不另存可无限增长的附件 ID 索引。
      const cancelled = [...this.uploads.values()].some((entry) => !isUpload(entry) && entry.attachmentId === attachmentId &&
        entry.scope.ownerId === scope.ownerId && entry.scope.sessionId === scope.sessionId && entry.scope.uploadScope === scope.uploadScope);
      if (cancelled) return "cancelled";
      throw new AttachmentStoreError("not_found");
    }
    if (upload.scope.ownerId !== scope.ownerId || upload.scope.sessionId !== scope.sessionId ||
        upload.scope.uploadScope !== scope.uploadScope) throw new AttachmentStoreError("not_found");
    if (upload.retained) return "retained";
    await this.cancel(scope, upload.input!.uploadId);
    return "cancelled";
  }

  resolve(scope: AttachmentScope, attachmentIds: readonly string[]): ReadonlyArray<{ descriptor: AttachmentDescriptor; path: string }> {
    this.checkScope(scope);
    if (!attachmentIdsSchema.safeParse(attachmentIds).success) throw new AttachmentStoreError("invalid_upload");
    let total = 0;
    const resolved = attachmentIds.map((id) => {
      const upload = this.byAttachment.get(id);
      if (!upload || upload.scope.ownerId !== scope.ownerId || upload.scope.sessionId !== scope.sessionId ||
          upload.scope.uploadScope !== scope.uploadScope) throw new AttachmentStoreError("not_found");
      if (upload.cancelled || !upload.complete) throw new AttachmentStoreError(upload.cancelled ? "cancelled" : "invalid_upload");
      this.assertFile(upload, true);
      total += upload.descriptor!.byte_length;
      return Object.freeze({ descriptor: upload.descriptor!, path: upload.path! });
    });
    if (total > ATTACHMENT_MAX_MESSAGE_BYTES) throw new AttachmentStoreError("too_large");
    return Object.freeze(resolved);
  }

  retain(scope: AttachmentScope, attachmentIds: readonly string[]): void {
    const resolved = this.resolve(scope, attachmentIds);
    // 同步先完成全部校验再标记；cancel/dispose 无法在中间插入。
    for (const item of resolved) {
      const upload = this.byAttachment.get(item.descriptor.attachment_id)!;
      upload.retained = true;
      this.resources.delete(upload);
    }
  }

  private async cleanup(upload: Upload): Promise<void> {
    if (upload.retained) return;
    let failure: AttachmentStoreError | undefined;
    const attempt = async (operation: () => Promise<void>) => {
      try { await operation(); } catch (error) { failure ??= storeError(error); }
    };
    try {
      // stat 初始化失败仍必须关句柄；只有能证明 inode 所有权时才删除路径。
      if (upload.handle && upload.inode === undefined) {
        await attempt(async () => {
          const stat = await upload.handle!.stat();
          upload.inode = stat.ino;
          upload.device = stat.dev;
        });
      }
      if (upload.path) {
        await attempt(async () => {
          if (upload.inode === undefined) throw new AttachmentStoreError("invalid_upload");
          try {
            assertDirectories(dirname(upload.path!));
            const stat = assertRegularFile(upload.path!);
            if (stat.ino !== upload.inode || stat.dev !== upload.device || stat.nlink !== 1) {
              throw new AttachmentStoreError("invalid_upload");
            }
            await unlink(upload.path!);
          } catch (error) {
            if (!nodeErrorHasCode(error, "ENOENT")) throw error;
          }
          upload.path = undefined;
        });
      }
    } finally {
      if (upload.handle) {
        await attempt(async () => {
          await upload.handle!.close();
          upload.handle = undefined;
        });
      }
      await attempt(async () => {
        await upload.reservation?.remove();
        upload.reservation = undefined;
      });
    }
    // 失败仍占有界资源预算；仅完整释放后提交成功墓碑并撤销该资源的旧错误。
    upload.cleanupFailure = failure;
    if (failure) throw failure;
    this.resources.delete(upload);
    if (upload.descriptor && this.byAttachment.get(upload.descriptor.attachment_id) === upload) {
      this.byAttachment.delete(upload.descriptor.attachment_id);
    }
    if (upload.cancelled && this.uploads.get(upload.key) === upload) {
      this.uploads.set(upload.key, { scope: upload.scope, cancelled: true, received: upload.received,
        ...(upload.descriptor ? { attachmentId: upload.descriptor.attachment_id } : {}) });
    }
  }

  private scheduleCleanup(upload: Upload): Promise<void> {
    if (upload.cleanupTask) return upload.cleanupTask;
    const task = this.enqueue(upload, () => this.cleanup(upload), true)
      .finally(() => { upload.cleanupTask = undefined; });
    upload.cleanupTask = task;
    const observed = task.catch(() => undefined);
    this.cleanups.add(observed);
    void observed.then(() => this.cleanups.delete(observed));
    return task;
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    for (const upload of this.resources) {
      upload.cancelled = true;
      void this.scheduleCleanup(upload).catch(() => undefined);
    }
    this.disposing = (async () => {
      await Promise.all([...this.cleanups]);
      const failure = [...this.resources].find((upload) => upload.cleanupFailure)?.cleanupFailure;
      if (failure) throw failure;
      this.uploads.clear();
      this.byAttachment.clear();
    })();
    return this.disposing;
  }
}
