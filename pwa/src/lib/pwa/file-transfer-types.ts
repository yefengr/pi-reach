import type { ClientFrame, FileErrorCode, PublishedFileDescriptor, ServerFrame } from "@pi-reach/protocol/session";

export type FileTransferIntent = "auto" | "view" | "download";
export type FileTransferPhase = "idle" | "opening" | "manual" | "reading" | "ready" | "error";
export type FileTransferErrorCode = FileErrorCode | "cancelled" | "disconnected" | "timeout"
  | "unsupported" | "invalid_message" | "integrity_mismatch" | "invalid_text" | "no_space";
export type FileOpened = Extract<ServerFrame, { type: "file_opened" }>;
export type FileTransferResult = { blob: Blob; url: string; text?: string };
export type PublishedFileState = {
  phase: FileTransferPhase;
  descriptor: PublishedFileDescriptor;
  current?: FileOpened;
  receivedBytes: number;
  intent: FileTransferIntent;
  result?: FileTransferResult;
  error?: FileTransferErrorCode;
};
export type FileTransferSnapshot = {
  /** 页面内缓存所有权身份；短断线与传输进度不改变它。 */
  readonly scopeToken: object;
  active: boolean;
  files: ReadonlyMap<string, PublishedFileState>;
};
export type FileTransferRequest = Extract<ClientFrame, { type: "file_open" | "file_read" }>;
export type FileTransferResponse = Extract<ServerFrame, { type: "file_opened" | "file_chunk" }>;
export type FileTransferTimers = {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};
export type FileTransferOptions = {
  requestId?: () => string;
  crypto?: Pick<Crypto, "subtle">;
  URL?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  timers?: FileTransferTimers;
  /** 测试可收紧预算；生产默认 64 MiB，活读取预留也计入。 */
  cacheBytes?: number;
};

export class FileTransferError extends Error {
  constructor(readonly code: FileTransferErrorCode) { super(code); }
}
