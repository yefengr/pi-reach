import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IN_FLIGHT, ATTACHMENT_MAX_MESSAGE_BYTES, clientFrameSchema,
  type AttachmentDescriptor, type ClientFrame, type ServerFrame,
} from "@pi-reach/protocol/session";
import { AttachmentUploadClient, AttachmentUploadError } from "./attachment-upload";
import type { TimelineScope } from "./timeline-runtime";
import type { AttachmentCapability } from "./attachment-upload-types";

type AttachmentRequest = Extract<ClientFrame, { type: `attachment_${string}` }>;
const scope: TimelineScope = {
  deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session",
  selfSenderRef: "sender", channelId: "channel", leafId: "leaf",
};
const clients: AttachmentUploadClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.restoreAllMocks();
});
function file(size: number, name = "file.bin"): File {
  return new File([new Uint8Array(size).fill(123)], name);
}
class Transport {
  frames: AttachmentRequest[] = [];
  held: AttachmentRequest[] = [];
  hold = new Set<string>();
  uploadScope = "lease";
  states = new Map<string, { bytes: number; descriptor: AttachmentDescriptor; complete: boolean; cancelled: boolean }>();
  error?: { type: string; code: "no_space" | "io_error" | "offset_mismatch"; retryable: boolean };
  capability: AttachmentCapability = { status: "unknown" };
  inFlight = 0;
  maxInFlight = 0;
  client = new AttachmentUploadClient({ onCapabilityChange: (value) => { this.capability = value; }, requestTimeoutMs: 2000 });
  constructor() { clients.push(this.client); }
  send = (input: ClientFrame): boolean => {
    expect(clientFrameSchema.safeParse(input).success).toBe(true);
    const frame = input as AttachmentRequest;
    this.frames.push(frame);
    if (frame.type === "attachment_chunk") {
      ++this.inFlight;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    }
    if (this.hold.has(frame.type)) this.held.push(frame);
    else queueMicrotask(() => this.answer(frame));
    return true;
  };
  replyBase(frame: AttachmentRequest) {
    return { protocol_version: 2 as const, in_reply_to: frame.id, target_channel_id: frame.channel_id,
      session_id: frame.session_id, upload_scope: this.uploadScope };
  }
  answer(frame: AttachmentRequest): ServerFrame {
    const base = this.replyBase(frame);
    let response: ServerFrame;
    if (frame.type === "attachment_capabilities_request") {
      response = { ...base, type: "attachment_capabilities", max_file_bytes: ATTACHMENT_MAX_FILE_BYTES,
        max_message_bytes: ATTACHMENT_MAX_MESSAGE_BYTES, max_attachments: ATTACHMENT_MAX_COUNT,
        chunk_bytes: ATTACHMENT_CHUNK_BYTES, max_in_flight: ATTACHMENT_MAX_IN_FLIGHT };
    } else {
      if (frame.type === "attachment_chunk") --this.inFlight;
      const upload_id = frame.upload_id;
      if (this.error?.type === frame.type) {
        const error = this.error;
        this.error = undefined;
        response = { ...base, type: "attachment_error", upload_id, code: error.code, retryable: error.retryable };
      } else {
        if (frame.type === "attachment_begin") {
          this.states.set(upload_id, { bytes: 0, complete: false, cancelled: false, descriptor: {
            attachment_id: `attachment-${upload_id}`, file_name: frame.file_name, mime_type: frame.mime_type,
            byte_length: frame.byte_length, sha256: frame.sha256, ...(frame.preview ? { preview: frame.preview } : {}),
          } });
        }
        const state = this.states.get(upload_id);
        if (!state) response = { ...base, type: "attachment_error", upload_id, code: "not_found", retryable: false };
        else {
          if (frame.type === "attachment_chunk") {
            expect(frame.offset).toBe(state.bytes);
            state.bytes += atob(frame.data_base64).length;
          }
          if (frame.type === "attachment_finish") state.complete = true;
          if (frame.type === "attachment_cancel") state.cancelled = true;
          response = state.cancelled
            ? { ...base, type: "attachment_state", upload_id, status: "cancelled", received_bytes: state.bytes }
            : state.complete
              ? { ...base, type: "attachment_state", upload_id, status: "complete", received_bytes: state.bytes, attachment: state.descriptor }
              : { ...base, type: "attachment_state", upload_id, status: "receiving", received_bytes: state.bytes };
        }
      }
    }
    this.client.receive(response);
    return response;
  }
  async connect(nextScope = scope) {
    this.client.connect(nextScope, this.send);
    await vi.waitFor(() => expect(this.capability.status).toBe("supported"));
  }
  async heldFrame(type: string, id?: string) {
    await vi.waitFor(() => expect(this.held.some((frame) => frame.type === type && (!id || ("upload_id" in frame && frame.upload_id === id)))).toBe(true));
    const index = this.held.findIndex((frame) => frame.type === type && (!id || ("upload_id" in frame && frame.upload_id === id)));
    return this.held.splice(index, 1)[0];
  }
}
function rejection<T>(promise: Promise<T>): Promise<unknown> { return promise.catch((error: unknown) => error); }

describe("AttachmentUploadClient", () => {
  it("uploads chunks from confirmed offsets, preserves canonical encoding, and finishes empty files", async () => {
    const transport = new Transport();
    await transport.connect();
    const source = file(ATTACHMENT_CHUNK_BYTES * 2 + 7);
    const progress = vi.fn();
    const descriptor = await transport.client.upload(source, "one", progress);
    expect(descriptor.byte_length).toBe(source.size);
    expect(descriptor.mime_type).toBe("application/octet-stream");
    const chunks = transport.frames.filter((frame) => frame.type === "attachment_chunk");
    expect(chunks.map((frame) => frame.offset)).toEqual([0, ATTACHMENT_CHUNK_BYTES, 2 * ATTACHMENT_CHUNK_BYTES]);
    for (const chunk of chunks) expect(btoa(atob(chunk.data_base64))).toBe(chunk.data_base64);
    expect(progress).toHaveBeenLastCalledWith({ status: "uploading", receivedBytes: source.size });
    expect((await transport.client.upload(file(0), "empty", vi.fn())).byte_length).toBe(0);
    expect(transport.frames.some((frame) => frame.type === "attachment_chunk" && frame.upload_id === "empty")).toBe(false);
  });

  it("enforces global two-chunk backpressure and one chunk per file", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const uploads = ["one", "two", "three"].map((id) => transport.client.upload(file(ATTACHMENT_CHUNK_BYTES + 1), id, vi.fn()));
    await vi.waitFor(() => expect(transport.held).toHaveLength(2));
    expect(new Set(transport.held.map((frame) => "upload_id" in frame && frame.upload_id)).size).toBe(2);
    transport.hold.clear();
    transport.held.splice(0).forEach((frame) => transport.answer(frame));
    await Promise.all(uploads);
    expect(transport.maxInFlight).toBe(2);
  });

  it("strictly matches requests, channel, session, upload id and scope", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_status_request");
    const upload = transport.client.upload(file(1), "one", vi.fn());
    const request = await transport.heldFrame("attachment_status_request");
    const response = { ...transport.replyBase(request), type: "attachment_error" as const,
      upload_id: "one", code: "not_found" as const, retryable: false };
    for (const mutation of [{ in_reply_to: "unrelated" }, { target_channel_id: "other" },
      { session_id: "other" }, { upload_scope: "other" }, { upload_id: "other" }, { unexpected: true }]) {
      expect(transport.client.receive({ ...response, ...mutation } as ServerFrame)).toBe(false);
    }
    transport.hold.clear();
    expect(transport.client.receive(response)).toBe(true);
    expect(transport.client.receive(response)).toBe(false);
    await upload;
  });

  it("keeps files across disconnect and resumes after a lost chunk acknowledgement by status", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const source = file(ATTACHMENT_CHUNK_BYTES + 4);
    const hash = vi.spyOn(source, "arrayBuffer");
    const upload = transport.client.upload(source, "one", vi.fn());
    const lost = await transport.heldFrame("attachment_chunk");
    transport.client.disconnect();
    transport.answer(lost); // 电脑已写入，旧 channel 回执不能消费。
    transport.hold.clear();
    await transport.connect({ ...scope, channelId: "channel-new", leafId: "leaf-new" });
    await upload;
    expect(hash).toHaveBeenCalledTimes(1);
    const chunks = transport.frames.filter((frame) => frame.type === "attachment_chunk");
    expect(chunks.map((frame) => frame.offset)).toEqual([0, ATTACHMENT_CHUNK_BYTES]);
    expect(transport.frames.filter((frame) => frame.type === "attachment_begin")).toHaveLength(1);
  });

  it("does not interrupt on leaf changes or reupload complete local/remote files", async () => {
    const transport = new Transport();
    await transport.connect();
    const source = file(3);
    const complete = await transport.client.upload(source, "one", vi.fn());
    const count = transport.frames.length;
    transport.client.connect({ ...scope, leafId: "next" }, transport.send);
    expect(await transport.client.upload(source, "one", vi.fn())).toEqual(complete);
    expect(transport.frames).toHaveLength(count);
    transport.client.release("one");
    expect(await transport.client.upload(source, "one", vi.fn())).toEqual(complete);
    expect(transport.frames.filter((frame) => frame.type === "attachment_chunk")).toHaveLength(1);
    expect(transport.frames.filter((frame) => frame.type === "attachment_cancel")).toHaveLength(0);
  });

  it("rejects reuse of an upload id with a different File and validates file metadata", async () => {
    const transport = new Transport();
    await transport.connect();
    await transport.client.upload(file(1), "one", vi.fn());
    await expect(transport.client.upload(file(1), "one", vi.fn())).rejects.toMatchObject({ code: "invalid_upload" });
    await expect(transport.client.upload(file(1, "bad\nname"), "bad", vi.fn())).rejects.toMatchObject({ code: "invalid_upload" });
    const huge = file(0);
    Object.defineProperty(huge, "size", { value: ATTACHMENT_MAX_FILE_BYTES + 1 });
    await expect(transport.client.upload(huge, "large", vi.fn())).rejects.toMatchObject({ code: "too_large" });
  });

  it("cancels one file synchronously while another continues and ignores a late finish", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_finish");
    const first = rejection(transport.client.upload(file(1), "one", vi.fn()));
    const finish = await transport.heldFrame("attachment_finish", "one");
    await transport.client.cancel("one");
    expect(await first).toMatchObject({ code: "aborted" });
    const late = transport.answer(finish);
    expect(transport.client.receive(late)).toBe(false);
    transport.hold.clear();
    expect((await transport.client.upload(file(1), "two", vi.fn())).byte_length).toBe(1);
    const count = transport.frames.length;
    await transport.client.cancel("unknown");
    expect(transport.frames).toHaveLength(count);
  });

  it("checks cancellation after hash and before finish including reentrant progress callbacks", async () => {
    const transport = new Transport();
    await transport.connect();
    const source = file(1);
    let resolveHash!: (value: ArrayBuffer) => void;
    const hash = vi.spyOn(source, "arrayBuffer").mockImplementation(() => new Promise((resolve) => { resolveHash = resolve; }));
    const upload = rejection(transport.client.upload(source, "one", vi.fn()));
    await vi.waitFor(() => expect(hash).toHaveBeenCalled());
    await transport.client.cancel("one");
    expect(await upload).toMatchObject({ code: "aborted" });
    resolveHash(new ArrayBuffer(1));
    await expect(transport.client.upload(file(1), "two", (progress) => {
      if (progress.status === "uploading" && progress.receivedBytes === 1) void transport.client.cancel("two");
    })).rejects.toMatchObject({ code: "aborted" });
    expect(transport.frames.some((frame) => frame.type === "attachment_begin" && frame.upload_id === "one")).toBe(false);
    expect(transport.frames.some((frame) => frame.type === "attachment_finish" && frame.upload_id === "two")).toBe(false);
  });

  it("retains offline cancellation intentions only for the same target and lease", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const upload = rejection(transport.client.upload(file(1), "one", vi.fn()));
    await transport.heldFrame("attachment_chunk");
    transport.client.disconnect();
    await transport.client.cancel("one");
    expect(await upload).toMatchObject({ code: "aborted" });
    expect(transport.frames.some((frame) => frame.type === "attachment_cancel")).toBe(false);
    await transport.connect({ ...scope, channelId: "new" });
    await vi.waitFor(() => expect(transport.frames.some((frame) => frame.type === "attachment_cancel" && frame.channel_id === "new")).toBe(true));
  });

  it.each(["runtimeInstanceId", "sessionId", "deviceId", "endpointId", "selfSenderRef"] as const)("never retargets live uploads after changing %s", async (key) => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const upload = rejection(transport.client.upload(file(1), "one", vi.fn()));
    await transport.heldFrame("attachment_chunk");
    await transport.connect({ ...scope, [key]: "different", channelId: "new" });
    expect(await upload).toMatchObject({ code: "invalid_scope" });
    await transport.client.cancel("one");
    expect(transport.frames.filter((frame) => frame.channel_id === "new").every((frame) => frame.type === "attachment_capabilities_request")).toBe(true);
  });

  it("invalidates an old lease even on the same target", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const upload = rejection(transport.client.upload(file(1), "one", vi.fn()));
    await transport.heldFrame("attachment_chunk");
    transport.client.disconnect();
    transport.uploadScope = "new-lease";
    await transport.connect({ ...scope, channelId: "new" });
    expect(await upload).toMatchObject({ code: "invalid_scope" });
    expect(transport.frames.filter((frame) => frame.channel_id === "new")).toHaveLength(1);
  });

  it.each(["no_space", "io_error", "offset_mismatch"] as const)("exposes fixed %s errors and retries through status with the cached hash", async (code) => {
    const transport = new Transport();
    await transport.connect();
    const source = file(1);
    const hash = vi.spyOn(source, "arrayBuffer");
    transport.error = { type: "attachment_chunk", code, retryable: true };
    const error = await rejection(transport.client.upload(source, "one", vi.fn()));
    expect(error).toBeInstanceOf(AttachmentUploadError);
    expect(error).toMatchObject({ code, retryable: true, message: `Attachment upload: ${code}` });
    await transport.client.upload(source, "one", vi.fn());
    expect(hash).toHaveBeenCalledTimes(1);
    expect(transport.frames.filter((frame) => frame.type === "attachment_status_request")).toHaveLength(2);
  });

  it("times out safely and confirms a lost finish before returning the already complete descriptor", async () => {
    const transport = new Transport();
    transport.client.dispose();
    transport.client = new AttachmentUploadClient({ requestTimeoutMs: 25, onCapabilityChange: (value) => { transport.capability = value; } });
    clients.push(transport.client);
    await transport.connect();
    transport.hold.add("attachment_finish");
    const source = file(1);
    const upload = rejection(transport.client.upload(source, "one", vi.fn()));
    const finish = await transport.heldFrame("attachment_finish");
    expect(await upload).toMatchObject({ code: "timeout", retryable: true });
    transport.answer(finish);
    transport.hold.clear();
    await transport.client.upload(source, "one", vi.fn());
    expect(transport.frames.filter((frame) => frame.type === "attachment_chunk")).toHaveLength(1);
    expect(transport.frames.filter((frame) => frame.type === "attachment_finish")).toHaveLength(1);
  });

  it.each(["protocol_error", "timeout"])("downgrades legacy capability %s without consuming unrelated errors", async (mode) => {
    const capabilities: AttachmentCapability[] = [];
    const client = new AttachmentUploadClient({ requestTimeoutMs: 25, onCapabilityChange: (value) => capabilities.push(value) });
    clients.push(client);
    let request!: AttachmentRequest;
    client.connect(scope, (frame) => { request = frame as AttachmentRequest; return true; });
    expect(client.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: "unrelated", code: "unsupported_type", message: "legacy" })).toBe(false);
    if (mode === "protocol_error") {
      expect(client.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: request.id, code: "unsupported_type", message: "legacy" })).toBe(true);
    }
    await vi.waitFor(() => expect(capabilities.at(-1)).toEqual({ status: "unsupported" }));
    await expect(client.upload(file(1), "one", vi.fn())).rejects.toMatchObject({ code: "unsupported" });
  });

  it("rejects complete descriptors that do not match begin metadata", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_finish");
    const upload = rejection(transport.client.upload(file(1), "one", vi.fn()));
    const finish = await transport.heldFrame("attachment_finish");
    const stored = transport.states.get("one")!;
    stored.descriptor.file_name = "different.bin";
    transport.answer(finish);
    expect(await upload).toMatchObject({ code: "integrity_mismatch" });
  });

  it("rechecks status when a progress callback replaces the channel before the next chunk", async () => {
    const transport = new Transport();
    await transport.connect();
    let replaced = false;
    await transport.client.upload(file(1), "one", (progress) => {
      if (progress.status === "uploading" && !replaced) {
        replaced = true;
        transport.client.connect({ ...scope, channelId: "new" }, transport.send);
      }
    });
    const newFrames = transport.frames.filter((frame) => frame.channel_id === "new");
    expect(newFrames.map((frame) => frame.type)).toEqual([
      "attachment_capabilities_request", "attachment_status_request", "attachment_chunk", "attachment_finish",
    ]);
  });

  it("rejects an already resolved old-channel acknowledgement before its continuation runs", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const upload = transport.client.upload(file(ATTACHMENT_CHUNK_BYTES + 1), "one", vi.fn());
    const chunk = await transport.heldFrame("attachment_chunk");
    transport.answer(chunk);
    transport.client.disconnect();
    transport.hold.clear();
    await transport.connect({ ...scope, channelId: "new" });
    await upload;
    const frames = transport.frames.filter((frame) => frame.channel_id === "new");
    expect(frames[1].type).toBe("attachment_status_request");
    expect(frames.filter((frame) => frame.type === "attachment_chunk").map((frame) => frame.offset)).toEqual([ATTACHMENT_CHUNK_BYTES]);
  });

  it("does not forward queued cancellation after changing targets and releases local state without cancel", async () => {
    const transport = new Transport();
    await transport.connect();
    transport.hold.add("attachment_chunk");
    const upload = rejection(transport.client.upload(file(1), "one", vi.fn()));
    await transport.heldFrame("attachment_chunk");
    transport.client.disconnect();
    await transport.client.cancel("one");
    expect(await upload).toMatchObject({ code: "aborted" });
    await transport.connect({ ...scope, runtimeInstanceId: "new-runtime", channelId: "new" });
    expect(transport.frames.filter((frame) => frame.type === "attachment_cancel")).toHaveLength(0);
    transport.client.release("one");
    transport.hold.clear();
    await transport.client.upload(file(1), "one", vi.fn());
    expect(transport.frames.filter((frame) => frame.type === "attachment_cancel")).toHaveLength(0);
  });

  it("sequences full-file reads and abort affects only its own file", async () => {
    const transport = new Transport();
    await transport.connect();
    const first = file(1);
    const second = file(1);
    const order: string[] = [];
    let resolveFirst!: (value: ArrayBuffer) => void;
    vi.spyOn(first, "arrayBuffer").mockImplementation(() => {
      order.push("first");
      return new Promise((resolve) => { resolveFirst = resolve; });
    });
    vi.spyOn(second, "arrayBuffer").mockImplementation(async () => { order.push("second"); return new ArrayBuffer(1); });
    const controller = new AbortController();
    const firstUpload = rejection(transport.client.upload(first, "one", vi.fn(), controller.signal));
    const secondUpload = transport.client.upload(second, "two", vi.fn());
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    controller.abort();
    expect(await firstUpload).toMatchObject({ code: "aborted" });
    resolveFirst(new ArrayBuffer(1));
    await secondUpload;
    expect(order).toEqual(["first", "second"]);
  });
});
