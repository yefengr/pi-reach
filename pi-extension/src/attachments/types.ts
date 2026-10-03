import type { AttachmentDescriptor, AttachmentPreview } from "@pi-reach/protocol/session";
import type { FileHandle } from "node:fs/promises";

export type AttachmentErrorCode = "invalid_scope" | "not_found" | "invalid_upload" | "too_large" |
  "busy" | "no_space" | "io_error" | "integrity_mismatch" | "offset_mismatch" | "cancelled";

export class AttachmentStoreError extends Error {
  constructor(readonly code: AttachmentErrorCode, readonly retryable = false) {
    super(`Attachment operation failed (${code}).`);
    this.name = "AttachmentStoreError";
  }
}

export interface AttachmentScope {
  ownerId: string;
  sessionId: string;
  uploadScope: string;
}

export interface AttachmentBeginInput {
  uploadId: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  preview?: AttachmentPreview;
}

export interface AttachmentUploadState {
  uploadId: string;
  receivedBytes: number;
  status: "receiving" | "complete" | "cancelled";
  attachment?: AttachmentDescriptor;
}

/** 仅用于隔离测试；生产默认始终使用真实 statfs 和 FileHandle.write。 */
export interface AttachmentStoreTestHooks {
  availableBytes?: () => bigint | Promise<bigint>;
  /** 假磁盘默认按字节分配；真实磁盘始终取 statfs.bsize。 */
  allocationUnitBytes?: number;
  /** 仅原件创建的故障注入；账本仍使用真实独占创建。 */
  createFile?: (path: string) => Promise<FileHandle>;
  afterCreate?: (handle: FileHandle) => void | Promise<void>;
  metadataLimit?: number;
  beforeWrite?: () => void | Promise<void>;
  write?: (handle: FileHandle, bytes: Uint8Array, position: number) => Promise<number>;
  afterWrite?: (byteLength: number) => void | Promise<void>;
}

export interface AttachmentStoreOptions {
  rootDir?: string;
  runtimeId: string;
  minFreeBytes?: number;
  testHooks?: AttachmentStoreTestHooks;
}

export function storeError(error: unknown): AttachmentStoreError {
  if (error instanceof AttachmentStoreError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new AttachmentStoreError(code === "ENOSPC" ? "no_space" : "io_error", true);
}

export function nodeErrorHasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
