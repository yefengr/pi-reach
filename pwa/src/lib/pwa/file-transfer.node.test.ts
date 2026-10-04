import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILE_AUTO_IMAGE_BYTES, FILE_CHUNK_BYTES, FILE_MAX_BYTES,
  type ClientFrame, type FilePreview, type PublishedFileDescriptor, type ServerFrame,
} from "@pi-reach/protocol/session";
import { FileTransferController, type FileOpened, type FileTransferOptions } from "./file-transfer";
import type { TimelineScope } from "./timeline-runtime";
import { FILE_TEXT_PREVIEW_BYTES, FILE_TEXT_RENDER_CHARACTERS } from "./file-preview";
import { publishedFilesView } from "../../components/pwa/published-files-bridge";

const scope: TimelineScope = {
  deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session",
  channelId: "channel", leafId: "leaf", selfSenderRef: "sender",
};
const descriptor = (id = "publication"): PublishedFileDescriptor => ({
  publication_id: id, file_name: "original.txt", mime_type: "text/plain", byte_length: 99, tool_call_id: "tool",
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const drain = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const bytes = new TextEncoder().encode("hello");

function harness(options: FileTransferOptions = {}) {
  let nextId = 0;
  let nextUrl = 0;
  const frames: ClientFrame[] = [];
  const create = vi.fn(() => `blob:test-${++nextUrl}`);
  const revoke = vi.fn();
  const controller = new FileTransferController({
    crypto: webcrypto as unknown as Crypto, requestId: () => `request-${++nextId}`,
    URL: { createObjectURL: create, revokeObjectURL: revoke }, ...options,
  });
  controller.connect(scope, (frame) => { frames.push(frame); });
  function last<T extends ClientFrame["type"]>(type: T): Extract<ClientFrame, { type: T }> {
    const frame = [...frames].reverse().find((value) => value.type === type);
    if (!frame) throw new Error(`missing ${type}`);
    return frame as Extract<ClientFrame, { type: T }>;
  }
  function opened(length = bytes.byteLength, preview: FilePreview = { kind: "text" }, patch: Partial<FileOpened> = {}) {
    const request = last("file_open");
    const response: FileOpened = {
      protocol_version: 2, type: "file_opened", in_reply_to: request.id, target_channel_id: request.channel_id,
      session_id: request.session_id, publication_id: request.publication_id, transfer_id: `transfer-${request.id}`,
      file_name: "current.txt", mime_type: "text/plain", byte_length: length, preview, ...patch,
    };
    return response;
  }
  function chunk(data = bytes, final = true, patch: Record<string, unknown> = {}) {
    const request = last("file_read");
    const common = {
      protocol_version: 2 as const, type: "file_chunk" as const, in_reply_to: request.id,
      target_channel_id: request.channel_id, session_id: request.session_id,
      transfer_id: request.transfer_id, offset: request.offset, data_base64: Buffer.from(data).toString("base64"),
    };
    return { ...common, ...(final ? { final: true, total_bytes: request.offset + data.byteLength, sha256: digest(data) }
      : { final: false }), ...patch } as ServerFrame;
  }
  async function acquire(id = "publication", data = bytes, intent: "view" | "download" = "download",
    preview: FilePreview = { kind: "text" }) {
    const promise = controller.open(descriptor(id), intent);
    await drain();
    expect(controller.receive(opened(data.byteLength, preview))).toBe(true);
    await drain();
    for (let offset = 0; offset < data.byteLength || offset === 0; offset += FILE_CHUNK_BYTES) {
      const part = data.subarray(offset, offset + FILE_CHUNK_BYTES);
      const final = offset + part.byteLength === data.byteLength;
      expect(controller.receive(chunk(part, final, final ? { sha256: digest(data) } : {}))).toBe(true);
      if (final) break;
      await drain();
    }
    await promise;
    return controller.snapshot().files.get(id)!;
  }
  return { controller, frames, create, revoke, last, opened, chunk, acquire };
}

afterEach(() => { vi.useRealTimers(); });

describe("FileTransferController", () => {
  it("publishes synchronous stable snapshots, verifies bytes/hash, and exposes bounded safe text", async () => {
    const h = harness();
    const initial = h.controller.snapshot();
    expect(h.controller.snapshot()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = h.controller.subscribe(listener);
    const operation = h.controller.open(descriptor(), "view");
    expect(h.controller.snapshot().active).toBe(true);
    expect(h.controller.snapshot().files.get("publication")?.phase).toBe("opening");
    expect(listener).toHaveBeenCalledTimes(1);
    await drain();
    expect(h.controller.receive(h.opened())).toBe(true);
    await drain();
    expect(h.last("file_read").offset).toBe(0);
    expect(h.controller.receive(h.chunk())).toBe(true);
    await operation;
    const state = h.controller.snapshot();
    const file = state.files.get("publication")!;
    expect(state.active).toBe(false);
    expect(file.phase).toBe("ready");
    expect(file.current?.file_name).toBe("current.txt");
    expect(file.descriptor.file_name).toBe("original.txt");
    expect(file.receivedBytes).toBe(bytes.byteLength);
    expect(file.result?.text).toBe("hello");
    expect(file.result?.blob.type).toBe("application/octet-stream");
    expect(new Uint8Array(await file.result!.blob.arrayBuffer())).toEqual(bytes);
    expect(h.controller.snapshot()).toBe(state);
    const count = h.frames.length;
    await h.controller.open(descriptor(), "download");
    expect(h.frames).toHaveLength(count);
    unsubscribe();
    h.controller.dispose();
    expect(h.revoke).toHaveBeenCalledWith(file.result!.url);
  });

  it.each([
    ["auto", FILE_AUTO_IMAGE_BYTES + 1, { kind: "image", width: 1, height: 1 }],
    ["auto", 2, { kind: "none" }],
    ["auto", 2, { kind: "text" }],
    ["view", 2, { kind: "none" }],
  ] as const)("%s uses current metadata and closes manual-only content (%s)", async (intent, size, preview) => {
    const h = harness();
    const promise = h.controller.open(descriptor(), intent);
    await drain();
    expect(h.controller.receive(h.opened(size, preview))).toBe(true);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.phase).toBe("manual");
    expect(h.frames.map((frame) => frame.type)).toEqual(["file_open", "file_close"]);
    await h.controller.open(descriptor(), "auto");
    expect(h.frames).toHaveLength(2);
    h.controller.dispose();
  });

  it.each([
    ["image/png", "auto"], ["image/png", "view"],
    ["image/gif", "auto"], ["image/gif", "view"],
    ["image/webp", "auto"], ["image/webp", "view"],
  ] as const)("keeps server-denied %s out of %s preview while downloading the unchanged original", async (mime, intent) => {
    const h = harness();
    const file = { ...descriptor(), mime_type: mime, file_name: "animation.bin", byte_length: bytes.length };
    try {
      const preview = h.controller.open(file, intent);
      await drain();
      expect(h.controller.receive(h.opened(bytes.length, { kind: "none" }, { mime_type: mime, file_name: file.file_name }))).toBe(true);
      await preview;
      expect(h.frames.map(frame => frame.type)).toEqual(["file_open", "file_close"]);
      expect(h.controller.snapshot().files.get(file.publication_id)?.phase).toBe("manual");
      expect(h.create).not.toHaveBeenCalled();

      const download = h.controller.open(file, "download");
      await drain();
      expect(h.controller.receive(h.opened(bytes.length, { kind: "none" }, { mime_type: mime, file_name: file.file_name }))).toBe(true);
      await drain();
      expect(h.controller.receive(h.chunk())).toBe(true);
      await download;
      const result = h.controller.snapshot().files.get(file.publication_id)!;
      expect(result.phase).toBe("ready");
      expect(result.current?.mime_type).toBe(mime);
      expect(result.result?.blob.type).toBe("application/octet-stream");
      expect(result.result?.text).toBeUndefined();
      expect(new Uint8Array(await result.result!.blob.arrayBuffer())).toEqual(bytes);
    } finally { h.controller.dispose(); }
  });

  it("automatically fetches only schema-qualified small images, not historical image metadata", async () => {
    const h = harness();
    const promise = h.controller.open(descriptor(), "auto");
    await drain();
    expect(h.controller.receive(h.opened(bytes.length, { kind: "image", width: 5000, height: 5000 }))).toBe(false);
    expect(h.frames).toHaveLength(1);
    expect(h.controller.receive(h.opened(bytes.length, { kind: "image", width: 2, height: 2 }, { mime_type: "image/png" }))).toBe(true);
    await drain();
    expect(h.controller.receive(h.chunk())).toBe(true);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.result?.blob.type).toBe("image/png");
    h.controller.dispose();
  });

  it("manually reads images above 10 MiB while automatic reads remain disabled", async () => {
    const h = harness();
    const data = new Uint8Array(FILE_AUTO_IMAGE_BYTES + 1).fill(65);
    const preview: FilePreview = { kind: "image", width: 2, height: 2 };
    const automatic = h.controller.open(descriptor("large-image"), "auto");
    await drain();
    h.controller.receive(h.opened(data.length, preview));
    await automatic;
    expect(h.controller.snapshot().files.get("large-image")?.phase).toBe("manual");
    expect(h.frames.some((frame) => frame.type === "file_read")).toBe(false);
    const file = await h.acquire("large-image", data, "view", preview);
    expect(file.phase).toBe("ready");
    expect(file.result?.blob.size).toBe(data.length);
    expect(digest(new Uint8Array(await file.result!.blob.arrayBuffer()))).toBe(digest(data));
    h.controller.dispose();
  });

  it("manually previews large text within render limits while retaining the complete original download", async () => {
    const h = harness();
    const data = new Uint8Array(FILE_TEXT_PREVIEW_BYTES + 1).fill(65);
    const file = await h.acquire("large-text", data, "view");
    expect(file.phase).toBe("ready");
    expect(file.result?.blob.size).toBe(data.byteLength);
    expect(file.result?.text).toBe("A".repeat(FILE_TEXT_RENDER_CHARACTERS));
    expect(digest(new Uint8Array(await file.result!.blob.arrayBuffer()))).toBe(digest(data));
    const count = h.frames.length;
    await h.controller.open(descriptor("large-text"), "download");
    expect(h.frames).toHaveLength(count);
    expect(h.controller.snapshot().files.get("large-text")?.result?.blob.size).toBe(data.byteLength);
    const reads = h.frames.filter((frame) => frame.type === "file_read");
    expect(reads.map((frame) => frame.offset)).toEqual(Array.from({ length: reads.length }, (_, index) => index * FILE_CHUNK_BYTES));
    h.controller.dispose();
  });

  it("rejects unknown, wrong-channel/session/publication/request/transfer/offset and malformed replies", async () => {
    const h = harness();
    const promise = h.controller.open(descriptor(), "view");
    await drain();
    for (const patch of [{ in_reply_to: "unknown" }, { target_channel_id: "other" }, { session_id: "other" }, { publication_id: "other" }]) {
      expect(h.controller.receive(h.opened(5, { kind: "text" }, patch))).toBe(false);
    }
    expect(h.controller.receive(h.opened())).toBe(true);
    await drain();
    for (const patch of [{ in_reply_to: "unknown" }, { target_channel_id: "other" }, { session_id: "other" },
      { transfer_id: "other" }, { offset: 1 }, { data_base64: "AB==" }, { unexpected: true }]) {
      expect(h.controller.receive(h.chunk(bytes, true, patch))).toBe(false);
    }
    const reply = h.chunk();
    expect(h.controller.receive(reply)).toBe(true);
    expect(h.controller.receive(reply)).toBe(false);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.phase).toBe("ready");
    h.controller.dispose();
  });

  it("leaves recovery protocol errors to the parent, but consumes matching local errors only", async () => {
    const h = harness();
    const promise = h.controller.open(descriptor(), "download");
    await drain();
    const reply = { protocol_version: 2 as const, type: "protocol_error" as const,
      in_reply_to: h.last("file_open").id, target_channel_id: "channel", message: "fixed" };
    for (const code of ["reset_required", "invalid_channel", "invalid_leaf", "invalid_cursor", "protocol_upgrade_required"] as const) {
      expect(h.controller.receive({ ...reply, code })).toBe(false);
    }
    expect(h.controller.receive({ ...reply, code: "unsupported_type", in_reply_to: "other" })).toBe(false);
    expect(h.controller.receive({ ...reply, code: "unsupported_type", target_channel_id: "other" })).toBe(false);
    expect(h.controller.receive({ ...reply, code: "unsupported_type" })).toBe(true);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("unsupported");
    await h.controller.open(descriptor(), "auto");
    expect(h.frames).toHaveLength(1);
    h.controller.dispose();
  });

  it("does not settle file errors for a wrong transfer, and allows a manual retry", async () => {
    const h = harness();
    const promise = h.controller.open(descriptor(), "download");
    await drain();
    h.controller.receive(h.opened());
    await drain();
    const request = h.last("file_read");
    const error = { protocol_version: 2 as const, type: "file_error" as const, in_reply_to: request.id,
      target_channel_id: "channel", session_id: "session", code: "file_changed" as const };
    expect(h.controller.receive({ ...error, transfer_id: "wrong" })).toBe(false);
    expect(h.controller.receive(error)).toBe(false);
    expect(h.controller.receive({ ...error, transfer_id: request.transfer_id })).toBe(true);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("file_changed");
    const state = await h.acquire();
    expect(state.phase).toBe("ready");
    h.controller.dispose();
  });

  it.each(["hash", "length", "overflow", "non-final-end"] as const)("rejects %s integrity errors before creating URLs", async (mode) => {
    const h = harness();
    const promise = h.controller.open(descriptor(), "download");
    await drain();
    h.controller.receive(h.opened(mode === "length" ? 6 : mode === "overflow" ? 4 : 5));
    await drain();
    const response = h.chunk(bytes, mode !== "non-final-end", mode === "hash" ? { sha256: "0".repeat(64) } : {});
    expect(h.controller.receive(response)).toBe(true);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("integrity_mismatch");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.last("file_close").transfer_id).toBe(h.last("file_read").transfer_id);
    h.controller.dispose();
  });

  it("invalidates cancellation before best-effort close, and never waits for close to start the next file", async () => {
    const h = harness();
    const promise = h.controller.open(descriptor(), "download");
    await drain();
    h.controller.receive(h.opened());
    await drain();
    const late = h.chunk();
    h.controller.cancel();
    expect(h.controller.snapshot().active).toBe(false);
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("cancelled");
    expect(h.controller.receive(late)).toBe(false);
    await promise;
    await h.controller.open(descriptor(), "auto");
    expect(h.frames.filter((frame) => frame.type === "file_open")).toHaveLength(1);
    expect((await h.acquire("next")).phase).toBe("ready");
    h.controller.dispose();
  });

  it.each(["cancel", "timeout"] as const)("settles a late opened after %s without restoring state or reading", async (mode) => {
    vi.useFakeTimers();
    const h = harness({ timers: { setTimeout, clearTimeout } });
    const operation = h.controller.open(descriptor(), "download");
    await drain();
    const opened = h.opened();
    if (mode === "cancel") h.controller.cancel(); else await vi.advanceTimersByTimeAsync(15_000);
    await operation;
    const stopped = h.controller.snapshot();
    expect(stopped.files.get("publication")?.error).toBe(mode === "cancel" ? "cancelled" : "timeout");
    for (const patch of [{ in_reply_to: "other" }, { target_channel_id: "other" }, { session_id: "other" },
      { publication_id: "other" }, { unexpected: true }]) {
      expect(h.controller.receive({ ...opened, ...patch } as ServerFrame)).toBe(false);
    }
    expect(h.controller.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: opened.in_reply_to,
      target_channel_id: "channel", code: "invalid_channel", message: "fixed" })).toBe(false);
    expect(h.controller.receive(opened)).toBe(true);
    expect(h.controller.receive(opened)).toBe(false);
    expect(h.controller.snapshot()).toBe(stopped);
    expect(h.frames.map((frame) => frame.type)).toEqual(["file_open", "file_close"]);
    expect(h.last("file_close")).toMatchObject({ transfer_id: opened.transfer_id, channel_id: "channel", session_id: "session" });
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it("closes an opened resolved just before cancellation without affecting the next task", async () => {
    const h = harness();
    const previous = h.controller.open(descriptor(), "download");
    await drain();
    const opened = h.opened();
    expect(h.controller.receive(opened)).toBe(true);
    h.controller.cancel();
    const next = h.controller.open(descriptor("next"), "download");
    await drain();
    await previous;
    expect(h.last("file_close").transfer_id).toBe(opened.transfer_id);
    expect(h.frames.filter((frame) => frame.type === "file_read")).toHaveLength(0);
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("cancelled");
    expect(h.controller.snapshot().files.get("next")?.phase).toBe("opening");
    h.controller.receive(h.opened());
    await drain();
    h.controller.receive(h.chunk());
    await next;
    expect(h.controller.snapshot().files.get("next")?.phase).toBe("ready");
    h.controller.dispose();
  });

  it("bounds retired opens to eight slots and expires them after 15 seconds", async () => {
    vi.useFakeTimers();
    const h = harness({ timers: { setTimeout, clearTimeout } });
    const late: FileOpened[] = [];
    for (let index = 0; index < 9; index++) {
      const operation = h.controller.open(descriptor(`cancel-${index}`), "download");
      await drain();
      late.push(h.opened());
      h.controller.cancel();
      await operation;
    }
    expect(vi.getTimerCount()).toBe(8);
    expect(h.controller.receive(late[0])).toBe(false);
    expect(h.controller.receive(late[1])).toBe(true);
    expect(vi.getTimerCount()).toBe(7);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.controller.receive(late[8])).toBe(false);
    expect(h.frames.filter((frame) => frame.type === "file_close")).toHaveLength(1);
    h.controller.dispose();
  });

  it.each(["disconnect", "reset", "dispose", "channel"] as const)("clears late-open slots on %s, including resolved microtasks", async (action) => {
    vi.useFakeTimers();
    const h = harness({ timers: { setTimeout, clearTimeout } });
    const retired = h.controller.open(descriptor("retired"), "download");
    await drain();
    const late = h.opened();
    h.controller.cancel();
    await retired;
    const resolved = h.controller.open(descriptor("resolved"), "download");
    await drain();
    expect(h.controller.receive(h.opened())).toBe(true);
    if (action === "channel") h.controller.connect({ ...scope, channelId: "new-channel" }, (frame) => { h.frames.push(frame); });
    else h.controller[action]();
    await resolved;
    expect(h.controller.receive(late)).toBe(false);
    expect(h.frames.some((frame) => frame.type === "file_read" || frame.type === "file_close")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it("treats a failed late close as best effort, not success or a retry loop", async () => {
    vi.useFakeTimers();
    const h = harness({ timers: { setTimeout, clearTimeout } });
    const close = vi.fn(() => { throw new Error("offline"); });
    h.controller.connect(scope, (frame) => { if (frame.type === "file_close") close(); else h.frames.push(frame); });
    const operation = h.controller.open(descriptor(), "download");
    await drain();
    const late = h.opened();
    h.controller.cancel();
    await operation;
    const stopped = h.controller.snapshot();
    expect(h.controller.receive(late)).toBe(true);
    expect(h.controller.snapshot()).toBe(stopped);
    expect(h.controller.receive(late)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("cancelled");
    h.controller.dispose();
  });

  it("does not create cleanup slots when cancelled before file_open is sent", async () => {
    vi.useFakeTimers();
    const h = harness({ timers: { setTimeout, clearTimeout } });
    const operation = h.controller.open(descriptor(), "download");
    h.controller.cancel();
    await operation;
    expect(h.frames).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it("settles an older open while a different file is waiting without disturbing its request", async () => {
    const h = harness();
    const previous = h.controller.open(descriptor("previous"), "download");
    await drain();
    const late = h.opened();
    h.controller.cancel();
    await previous;
    const next = h.controller.open(descriptor("next"), "download");
    await drain();
    const current = h.opened();
    const opening = h.controller.snapshot();
    expect(h.controller.receive(late)).toBe(true);
    expect(h.controller.snapshot()).toBe(opening);
    expect(h.last("file_close").transfer_id).toBe(late.transfer_id);
    expect(h.controller.receive(current)).toBe(true);
    await drain();
    expect(h.last("file_read").transfer_id).toBe(current.transfer_id);
    h.controller.receive(h.chunk());
    await next;
    expect(h.controller.snapshot().files.get("next")?.phase).toBe("ready");
    expect(h.controller.snapshot().files.get("previous")?.error).toBe("cancelled");
    h.controller.dispose();
  });

  it("times out after 15 seconds, sends close when known, and never retries automatically", async () => {
    vi.useFakeTimers();
    const h = harness({ timers: { setTimeout, clearTimeout } });
    const promise = h.controller.open(descriptor(), "download");
    await drain();
    h.controller.receive(h.opened());
    await drain();
    const late = h.chunk();
    await vi.advanceTimersByTimeAsync(15_000);
    await promise;
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("timeout");
    expect(h.controller.receive(late)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.frames.map((frame) => frame.type)).toEqual(["file_open", "file_read", "file_close"]);
    h.controller.dispose();
  });

  it("keeps ready files across disconnect/channel changes and ignores leaf changes during reads", async () => {
    const h = harness();
    const ready = await h.acquire("ready");
    const active = h.controller.open(descriptor("active"), "download");
    await drain();
    h.controller.connect({ ...scope, leafId: "later-leaf" }, (frame) => { h.frames.push(frame); });
    expect(h.controller.receive(h.opened())).toBe(true);
    await drain();
    const late = h.chunk();
    h.controller.disconnect();
    await active;
    expect(h.controller.receive(late)).toBe(false);
    expect(h.controller.snapshot().files.get("ready")?.result).toBe(ready.result);
    expect(h.revoke).not.toHaveBeenCalled();
    h.controller.connect({ ...scope, channelId: "new-channel" }, (frame) => { h.frames.push(frame); });
    expect((await h.acquire("new")).phase).toBe("ready");
    expect(h.last("file_read").channel_id).toBe("new-channel");
    h.controller.connect({ ...scope, runtimeInstanceId: "different-runtime" }, (frame) => { h.frames.push(frame); });
    expect(h.controller.snapshot().files.size).toBe(0);
    expect(h.revoke).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });

  it("resets branch state and releases ready URLs and active buffers, with late replies ignored", async () => {
    const h = harness();
    await h.acquire("ready");
    const promise = h.controller.open(descriptor("active"), "download");
    await drain();
    h.controller.receive(h.opened());
    await drain();
    const late = h.chunk();
    h.controller.reset();
    expect(h.controller.snapshot()).toEqual({ active: false, files: new Map() });
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.controller.receive(late)).toBe(false);
    await promise;
    h.controller.dispose();
  });

  it("uses current byte sizes for cache admission, LRU eviction, and pin accounting", async () => {
    const h = harness({ cacheBytes: 10 });
    const first = await h.acquire("first");
    await h.acquire("second");
    h.controller.pin("first");
    const third = await h.acquire("third");
    expect(third.phase).toBe("ready");
    expect(h.controller.snapshot().files.get("first")?.result).toBe(first.result);
    expect(h.controller.snapshot().files.get("second")?.phase).toBe("idle");
    expect(h.revoke).toHaveBeenCalledWith("blob:test-2");
    h.controller.pin("third");
    h.controller.pin("blocked");
    const operation = h.controller.open(descriptor("blocked"), "download");
    await drain();
    h.controller.receive(h.opened());
    await operation;
    expect(h.controller.snapshot().files.get("blocked")?.error).toBe("no_space");
    expect(h.frames.filter((frame) => frame.type === "file_read")).toHaveLength(3);
    h.controller.unpin("first");
    expect((await h.acquire("blocked")).phase).toBe("ready");
    expect(h.controller.snapshot().files.get("first")?.phase).toBe("idle");
    h.controller.dispose();
  });

  it("manually retries just one cached item with a new complete URL through the real stale-snapshot bridge", async () => {
    const h = harness({ cacheBytes: 10 });
    const original = await h.acquire("retry");
    const other = await h.acquire("other");
    const oldSnapshot = h.controller.snapshot();
    const view = publishedFilesView(h.controller, oldSnapshot, true, () => true, vi.fn());
    h.controller.pin("retry");
    h.controller.pin("other");
    const operation = view.retry!(descriptor("retry"), "view");
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith(original.result!.url);
    expect(view.getState("retry")?.phase).toBe("opening");
    expect(oldSnapshot.files.get("retry")?.result).toBe(original.result);
    await drain();
    expect(h.frames.filter((frame) => frame.type === "file_open")).toHaveLength(3);
    expect(h.last("file_open").publication_id).toBe("retry");
    const replacement = new TextEncoder().encode("world");
    h.controller.receive(h.opened(replacement.length));
    await drain();
    h.controller.receive(h.chunk(replacement));
    await operation;
    const refreshed = h.controller.snapshot().files.get("retry")!;
    expect(view.getState("retry")).toMatchObject({ phase: "ready", text: "world", url: refreshed.result!.url });
    expect(refreshed.result!.url).not.toBe(original.result!.url);
    expect(new Uint8Array(await refreshed.result!.blob.arrayBuffer())).toEqual(replacement);
    expect(h.controller.snapshot().files.get("other")?.result).toBe(other.result);
    expect(h.revoke).toHaveBeenCalledTimes(1);
    // drop 保留 pin；第三项不得逐出重试结果或绕过字节预算。
    const blocked = h.controller.open(descriptor("blocked"), "download");
    await drain();
    h.controller.receive(h.opened());
    await blocked;
    expect(h.controller.snapshot().files.get("blocked")?.error).toBe("no_space");
    expect(h.controller.snapshot().files.get("retry")?.result).toBe(refreshed.result);
    expect(h.revoke).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it("does not loop retries or bypass a pinned budget when the replacement grows", async () => {
    const h = harness({ cacheBytes: 10 });
    const original = await h.acquire("retry");
    const other = await h.acquire("other");
    h.controller.pin("retry");
    h.controller.pin("other");
    const operation = h.controller.retry(descriptor("retry"), "download");
    await drain();
    h.controller.receive(h.opened(6));
    await operation;
    expect(h.controller.snapshot().files.get("retry")?.error).toBe("no_space");
    expect(h.controller.snapshot().files.get("other")?.result).toBe(other.result);
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith(original.result!.url);
    await h.controller.open(descriptor("retry"), "auto");
    await drain();
    expect(h.frames.filter((frame) => frame.type === "file_open")).toHaveLength(3);
    expect(h.frames.filter((frame) => frame.type === "file_read")).toHaveLength(2);
    h.controller.dispose();
  });

  it("reads the controller's completed state through a bridge created before opening", async () => {
    const h = harness();
    const initial = h.controller.snapshot();
    const view = publishedFilesView(h.controller, initial, true, () => true, vi.fn());
    const operation = view.open(descriptor(), "download");
    await drain();
    h.controller.receive(h.opened());
    await drain();
    h.controller.receive(h.chunk());
    await operation;
    expect(initial.files.size).toBe(0);
    expect(view.getState("publication")).toMatchObject({ phase: "ready", url: "blob:test-1", text: "hello" });
    h.controller.dispose();
  });

  it("fails closed above the pinned budget without evicting unrelated cache on failed admission", async () => {
    const h = harness({ cacheBytes: 10 });
    const first = await h.acquire("first");
    await h.acquire("second");
    h.controller.pin("first");
    const promise = h.controller.open(descriptor("huge"), "download");
    await drain();
    h.controller.receive(h.opened(FILE_MAX_BYTES));
    await promise;
    expect(h.controller.snapshot().files.get("huge")?.error).toBe("no_space");
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.controller.snapshot().files.get("first")?.result).toBe(first.result);
    expect(h.controller.snapshot().files.get("second")?.phase).toBe("ready");
    h.controller.dispose();
  });

  it("bounds empty-file URLs even when byte usage is zero, and verifies empty hashes", async () => {
    const h = harness({ cacheBytes: 0 });
    for (let index = 0; index < 65; index++) expect((await h.acquire(`empty-${index}`, new Uint8Array())).phase).toBe("ready");
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect([...h.controller.snapshot().files.values()].filter((file) => file.phase === "ready")).toHaveLength(64);
    h.controller.dispose();
    expect(h.revoke).toHaveBeenCalledTimes(65);
  });

  it("drops cancelled hashing results and does not create late object URLs", async () => {
    let finishHash!: (value: ArrayBuffer) => void;
    const crypto = { subtle: { digest: vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finishHash = resolve; })) } } as unknown as Crypto;
    const h = harness({ crypto });
    const operation = h.controller.open(descriptor(), "download");
    await drain();
    h.controller.receive(h.opened());
    await drain();
    h.controller.receive(h.chunk());
    await drain();
    expect(crypto.subtle.digest).toHaveBeenCalledTimes(1);
    h.controller.cancel();
    finishHash(new Uint8Array(Buffer.from(digest(bytes), "hex")).buffer);
    await operation;
    expect(h.create).not.toHaveBeenCalled();
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("cancelled");
    h.controller.dispose();
  });

  it("does not expose invalid UTF-8 preview text or activate HTML/SVG MIME types", async () => {
    const h = harness();
    const operation = h.controller.open(descriptor(), "view");
    await drain();
    h.controller.receive(h.opened(1, { kind: "text" }, { mime_type: "text/html" }));
    await drain();
    expect(h.controller.receive(h.chunk(new Uint8Array([255])))).toBe(true);
    await operation;
    expect(h.controller.snapshot().files.get("publication")?.error).toBe("invalid_text");
    expect(h.create).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});
