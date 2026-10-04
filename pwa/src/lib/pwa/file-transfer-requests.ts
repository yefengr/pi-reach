import {
  clientFrameSchema, fileChunkFrameSchema, fileErrorFrameSchema, fileOpenedFrameSchema,
  protocolErrorFrameSchema, type ServerFrame,
} from "@pi-reach/protocol/session";
import {
  FileTransferError, type FileOpened, type FileTransferErrorCode, type FileTransferRequest,
  type FileTransferResponse, type FileTransferTimers,
} from "./file-transfer-types";

const REQUEST_TIMEOUT_MS = 15_000;
const RETIRED_OPEN_LIMIT = 8;
const LOCAL_PROTOCOL_ERRORS: Readonly<Record<string, FileTransferErrorCode>> = {
  unsupported_type: "unsupported", invalid_message: "invalid_message", too_large: "too_large", internal_error: "io_error",
};
type Pending = {
  request: FileTransferRequest;
  resolve: (frame: FileTransferResponse) => void;
  reject: (error: FileTransferError) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RetiredOpen = {
  request: Extract<FileTransferRequest, { type: "file_open" }>;
  settle: (frame: FileOpened) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 单活请求；退休 open 槽只用于有界清理，不能恢复任务。 */
export class FileTransferRequests {
  private pending?: Pending;
  private readonly retired = new Map<string, RetiredOpen>();
  constructor(private readonly timers: FileTransferTimers) {}

  request(frame: FileTransferRequest, send: (frame: FileTransferRequest) => void,
    onTimeout: () => void): Promise<FileTransferResponse> {
    if (this.pending || !clientFrameSchema.safeParse(frame).success) {
      return Promise.reject(new FileTransferError("invalid_message"));
    }
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(onTimeout, REQUEST_TIMEOUT_MS);
      this.pending = { request: frame, resolve, reject, timer };
      try { send(frame); } catch { this.cancel("disconnected"); }
    });
  }

  receive(input: ServerFrame): boolean {
    const pending = this.pending;
    if (!("in_reply_to" in input)) return false;
    if (!pending || input.in_reply_to !== pending.request.id) return this.receiveRetired(input);
    const request = pending.request;
    if (input.type === "protocol_error") {
      const code = LOCAL_PROTOCOL_ERRORS[input.code];
      // 身份、session、branch 恢复错误保留给父运行态，不用文件局部失败吞掉。
      if (!code || !protocolErrorFrameSchema.safeParse(input).success
        || ("target_channel_id" in input && input.target_channel_id !== request.channel_id)) return false;
      this.cancel(code);
      return true;
    }
    if (input.type !== "file_opened" && input.type !== "file_chunk" && input.type !== "file_error") return false;
    if (input.target_channel_id !== request.channel_id || input.session_id !== request.session_id) return false;
    if (input.type === "file_error") {
      if (!fileErrorFrameSchema.safeParse(input).success) return false;
      if (request.type === "file_open" ? input.transfer_id !== undefined : input.transfer_id !== request.transfer_id) return false;
      this.cancel(input.code);
      return true;
    }
    if (request.type === "file_open") {
      if (input.type !== "file_opened" || input.publication_id !== request.publication_id
        || !fileOpenedFrameSchema.safeParse(input).success) return false;
    } else if (input.type !== "file_chunk" || input.transfer_id !== request.transfer_id
      || input.offset !== request.offset || !fileChunkFrameSchema.safeParse(input).success) return false;
    this.pending = undefined;
    this.timers.clearTimeout(pending.timer);
    pending.resolve(input);
    return true;
  }

  retireOpen(request: RetiredOpen["request"], settle: RetiredOpen["settle"]): void {
    if (this.retired.has(request.id)) return;
    if (this.retired.size >= RETIRED_OPEN_LIMIT) this.settleOpen(this.retired.keys().next().value!);
    const timer = this.timers.setTimeout(() => this.settleOpen(request.id), REQUEST_TIMEOUT_MS);
    this.retired.set(request.id, { request, settle, timer });
  }

  settleOpen(id: string): void {
    const retired = this.retired.get(id);
    if (!retired) return;
    this.retired.delete(id);
    this.timers.clearTimeout(retired.timer);
  }

  clearRetired(): void {
    for (const id of this.retired.keys()) this.settleOpen(id);
  }

  private receiveRetired(input: ServerFrame): boolean {
    if (input.type !== "file_opened") return false;
    const retired = this.retired.get(input.in_reply_to);
    if (!retired || input.target_channel_id !== retired.request.channel_id
      || input.session_id !== retired.request.session_id || input.publication_id !== retired.request.publication_id
      || !fileOpenedFrameSchema.safeParse(input).success) return false;
    this.settleOpen(input.in_reply_to);
    retired.settle(input);
    return true;
  }

  cancel(code: FileTransferErrorCode): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    this.timers.clearTimeout(pending.timer);
    pending.reject(new FileTransferError(code));
  }
}
