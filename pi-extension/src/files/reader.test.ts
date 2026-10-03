import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, serverFrameSchema, type ClientFrame, type ServerFrame } from "@pi-reach/protocol/session";
import { FileReaderRuntime, type FileScope } from "./reader.js";
import { FileAccessError, openSourceFile } from "./safe-open.js";
import { inspectFile } from "./content-type.js";

vi.mock("./safe-open.js", async (original) => {
  const actual = await original<typeof import("./safe-open.js")>();
  return { ...actual, openSourceFile: vi.fn(actual.openSourceFile) };
});
vi.mock("./content-type.js", async (original) => {
  const actual = await original<typeof import("./content-type.js")>();
  return { ...actual, inspectFile: vi.fn(actual.inspectFile) };
});
const actualOpen = (await vi.importActual<typeof import("./safe-open.js")>("./safe-open.js")).openSourceFile;
const actualInspect = (await vi.importActual<typeof import("./content-type.js")>("./content-type.js")).inspectFile;
const scope: FileScope = { ownerId: "owner", channelId: "channel", runtimeId: "runtime", sessionId: "session", generation: 1 };
type Opened = Extract<ServerFrame, { type: "file_opened" }>;
let directory: string;
let path: string;
let handles: FileHandle[];
let runtimes: FileReaderRuntime[];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((success) => { resolve = success; });
  return { promise, resolve };
}
function runtime(options: Partial<ConstructorParameters<typeof FileReaderRuntime>[0]> = {}) {
  const reader = new FileReaderRuntime({ resolve: () => ({ sourcePath: path }), isCurrent: () => true, ...options });
  runtimes.push(reader);
  return reader;
}
function openFrame(id = "open", publicationId = "publication", target = scope): Extract<ClientFrame, { type: "file_open" }> {
  return { protocol_version: 2, type: "file_open", id, channel_id: target.channelId, session_id: target.sessionId, publication_id: publicationId };
}
function readFrame(opened: Opened, offset = 0): Extract<ClientFrame, { type: "file_read" }> {
  return { protocol_version: 2, type: "file_read", id: `read-${offset}`, channel_id: scope.channelId,
    session_id: scope.sessionId, transfer_id: opened.transfer_id, offset };
}
function closeFrame(opened: Opened): Extract<ClientFrame, { type: "file_close" }> {
  return { protocol_version: 2, type: "file_close", id: "close", channel_id: scope.channelId,
    session_id: scope.sessionId, transfer_id: opened.transfer_id };
}
async function opened(reader: FileReaderRuntime, id = "open", target = scope): Promise<Opened> {
  const result = await reader.handle(openFrame(id, "publication", target), target);
  expect(result.type).toBe("file_opened");
  return result as Opened;
}
async function drained(reader: FileReaderRuntime) {
  await vi.waitFor(() => expect(reader.resourceCount).toBe(0), { timeout: 5000, interval: 10 });
}

beforeEach(async () => {
  vi.mocked(openSourceFile).mockReset();
  vi.mocked(inspectFile).mockReset().mockImplementation(actualInspect);
  handles = []; runtimes = [];
  vi.mocked(openSourceFile).mockImplementation(async (input, options) => {
    const result = await actualOpen(input, options);
    handles.push(result.handle);
    return result;
  });
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pi-reach-reader-")));
  path = join(directory, "file.md");
  await fs.writeFile(path, "hello");
});
afterEach(async () => {
  for (const reader of runtimes) await reader.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const handle of handles) { try { await handle.close(); } catch { /* fixture teardown */ } }
  await fs.rm(directory, { recursive: true, force: true });
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))("FileReaderRuntime", () => {
  it.each([0, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES + 7, FILE_MAX_BYTES])("streams %i bytes with continuous offsets, canonical frames, and final digest", async (length) => {
    const bytes = Buffer.alloc(length, 0x61);
    await fs.writeFile(path, bytes);
    const reader = runtime();
    const initial = await opened(reader);
    expect(initial).toMatchObject({ file_name: "file.md", mime_type: "text/markdown", byte_length: length, preview: { kind: "text" } });
    expect(serverFrameSchema.safeParse(initial).success).toBe(true);
    const hash = createHash("sha256");
    let offset = 0;
    for (;;) {
      const chunk = await reader.handle(readFrame(initial, offset), scope);
      expect(chunk.type).toBe("file_chunk");
      if (chunk.type !== "file_chunk") break;
      expect(serverFrameSchema.safeParse(chunk).success).toBe(true);
      expect(chunk.offset).toBe(offset);
      const received = Buffer.from(chunk.data_base64, "base64");
      expect(received.length).toBe(Math.min(FILE_CHUNK_BYTES, length - offset));
      hash.update(received); offset += received.length;
      if (!chunk.final) { expect("sha256" in chunk).toBe(false); continue; }
      expect(chunk.total_bytes).toBe(length);
      expect(chunk.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(chunk.sha256).toBe(hash.digest("hex"));
      break;
    }
    expect(offset).toBe(length);
    expect(reader.resourceCount).toBe(0);
    expect(openSourceFile).toHaveBeenCalledTimes(1);
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(await reader.handle(readFrame(initial, offset), scope)).toMatchObject({ type: "file_error", code: "invalid_transfer" });
  }, 60_000);

  it("rejects oversized originals before inspection and does not modify them", async () => {
    const handle = await fs.open(path, "r+");
    await handle.truncate(FILE_MAX_BYTES + 1); await handle.close();
    const reader = runtime();
    expect(await reader.handle(openFrame(), scope)).toMatchObject({ type: "file_error", code: "too_large" });
    await drained(reader);
    expect(inspectFile).not.toHaveBeenCalled();
    expect((await fs.stat(path)).size).toBe(FILE_MAX_BYTES + 1);
  });

  it("binds responses, replay keys and transfers to all five scope components", async () => {
    const reader = runtime();
    const original = await opened(reader);
    expect(original).toMatchObject({ in_reply_to: "open", target_channel_id: "channel", session_id: "session" });
    expect(await reader.handle(openFrame(), scope)).toEqual(original);
    expect(openSourceFile).toHaveBeenCalledTimes(1);
    expect(await reader.handle(openFrame("open", "other-publication"), scope)).toMatchObject({ code: "invalid_transfer" });
    const variants: FileScope[] = [
      { ...scope, ownerId: "other" }, { ...scope, channelId: "other" }, { ...scope, runtimeId: "other" },
      { ...scope, sessionId: "other" }, { ...scope, generation: 2 },
    ];
    for (const changed of variants) {
      expect(await reader.handle(readFrame(original), changed)).toMatchObject({ code: "invalid_transfer", target_channel_id: changed.channelId, session_id: changed.sessionId });
      const separate = await opened(reader, "open", changed);
      expect(separate.transfer_id).not.toBe(original.transfer_id);
    }
    expect(reader.resourceCount).toBe(6);
  });

  it("reuses a pending open, rejects conflicts and shares eight slots with publication inspection", async () => {
    const gate = deferred(); const started = deferred();
    vi.mocked(inspectFile).mockImplementation(async (...args) => { started.resolve(); await gate.promise; return actualInspect(...args); });
    const reader = runtime();
    const first = reader.handle(openFrame(), scope);
    await started.promise;
    const replay = reader.handle(openFrame(), scope);
    expect(await reader.handle(openFrame("open", "conflict"), scope)).toMatchObject({ code: "invalid_transfer" });
    const publications = Array.from({ length: 7 }, () => reader.inspectForPublication(path));
    expect(reader.resourceCount).toBe(8);
    expect(await reader.handle(openFrame("ninth"), scope)).toMatchObject({ code: "busy" });
    await expect(reader.inspectForPublication(path)).rejects.toMatchObject({ message: "busy" });
    gate.resolve();
    expect(await replay).toEqual(await first);
    expect((await Promise.all(publications)).every((entry) => entry.sourcePath === path)).toBe(true);
    expect(reader.resourceCount).toBe(1);
    expect(openSourceFile).toHaveBeenCalledTimes(8);
  });

  it.each(["closeWhere", "dispose", "idle"] as const)("%s invalidates opening without awaiting I/O and closes a late handle", async (action) => {
    const gate = deferred(); const started = deferred();
    vi.mocked(openSourceFile).mockImplementationOnce(async (...args) => {
      const result = await actualOpen(...args); handles.push(result.handle);
      started.resolve(); await gate.promise; return result;
    });
    const reader = runtime({ idleMs: action === "idle" ? 50 : 30_000 });
    const pending = reader.handle(openFrame(), scope);
    await started.promise;
    if (action === "closeWhere") await reader.closeWhere(() => true);
    if (action === "dispose") await reader.dispose();
    expect(await pending).toMatchObject({ type: "file_error", code: "invalid_transfer" });
    expect(reader.resourceCount).toBe(1);
    gate.resolve(); await drained(reader);
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("cancels a pending replay whose publication resolution is stalled", async () => {
    const reader = runtime(); await opened(reader);
    const gate = deferred<{ sourcePath: string }>(); const started = deferred();
    const resolve = vi.fn(async () => { started.resolve(); return gate.promise; });
    // options 对象也是实际调用契约的一部分，可在资格解析边界注入阻塞。
    const blocked = runtime({ resolve });
    const pending = blocked.handle(openFrame(), scope);
    await started.promise;
    const replay = blocked.handle(openFrame(), scope);
    await blocked.closeWhere(() => true);
    expect(await pending).toMatchObject({ code: "invalid_transfer" });
    expect(await replay).toMatchObject({ code: "invalid_transfer" });
    gate.resolve({ sourcePath: path }); await drained(blocked);
  });

  it("allows one read at a time, refuses non-continuous offsets, and cancels a delayed read", async () => {
    await fs.writeFile(path, Buffer.alloc(FILE_CHUNK_BYTES + 1, 0x61));
    const reader = runtime(); const initial = await opened(reader);
    expect(await reader.handle(readFrame(initial, 1), scope)).toMatchObject({ code: "offset_mismatch" });
    const gate = deferred(); const started = deferred();
    const actualRead = handles[0]!.read.bind(handles[0]!);
    vi.spyOn(handles[0]!, "read").mockImplementationOnce(async (...args: Parameters<FileHandle["read"]>) => {
      started.resolve(); await gate.promise; return actualRead(...args);
    });
    const pending = reader.handle(readFrame(initial), scope); await started.promise;
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ code: "busy" });
    await reader.closeWhere(() => true);
    expect(await pending).toMatchObject({ code: "invalid_transfer" });
    expect(reader.resourceCount).toBe(1);
    gate.resolve(); await drained(reader);
  });

  it.each(["delete", "replace", "modify", "symlink"])("rejects source %s after open", async (change) => {
    const reader = runtime(); const initial = await opened(reader);
    if (change === "delete") await fs.unlink(path);
    if (change === "replace") { await fs.rename(path, `${path}.old`); await fs.writeFile(path, "hello"); }
    if (change === "modify") await fs.writeFile(path, "other");
    if (change === "symlink") { await fs.rename(path, `${path}.old`); await fs.symlink(`${path}.old`, path); }
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ type: "file_error", code: "file_changed" });
    await drained(reader);
  });

  it.each(["missing", "path", "scope"])("rechecks publication/scope after an awaited read: %s", async (change) => {
    let publication: { sourcePath: string } | null = { sourcePath: path }; let current = true;
    const reader = runtime({ resolve: () => publication, isCurrent: () => current });
    const initial = await opened(reader);
    const actualRead = handles[0]!.read.bind(handles[0]!);
    vi.spyOn(handles[0]!, "read").mockImplementationOnce(async (...args: Parameters<FileHandle["read"]>) => {
      const result = await actualRead(...args);
      if (change === "missing") publication = null;
      if (change === "path") publication = { sourcePath: `${path}.different` };
      if (change === "scope") current = false;
      return result;
    });
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ type: "file_error",
      code: change === "missing" ? "not_available" : change === "path" ? "file_changed" : "invalid_transfer" });
    await drained(reader);
  });

  it("does not emit a final chunk before a successful close and retains failed closes for retry", async () => {
    const reader = runtime(); const initial = await opened(reader);
    const close = vi.spyOn(handles[0]!, "close").mockRejectedValueOnce(new Error("private error"));
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ type: "file_error", code: "io_error" });
    expect(reader.resourceCount).toBe(1);
    expect((await handles[0]!.stat()).size).toBe(5);
    expect(await reader.handle(closeFrame(initial), scope)).toMatchObject({ type: "file_closed" });
    expect(close).toHaveBeenCalledTimes(2);
    expect(reader.resourceCount).toBe(0);
  });

  it("counts close failures against the global limit and retries them on dispose", async () => {
    const reader = runtime(); const initial = await opened(reader);
    const close = vi.spyOn(handles[0]!, "close").mockRejectedValueOnce(new Error("close failure"));
    expect(await reader.handle(closeFrame(initial), scope)).toMatchObject({ code: "io_error" });
    for (let index = 0; index < 7; index++) await opened(reader, `open-${index}`);
    expect(reader.resourceCount).toBe(8);
    expect(await reader.handle(openFrame("overflow"), scope)).toMatchObject({ code: "busy" });
    await reader.dispose();
    expect(close).toHaveBeenCalledTimes(2);
    expect(reader.resourceCount).toBe(0);
    expect(await reader.handle(openFrame(), scope)).toMatchObject({ code: "invalid_transfer" });
  });

  it("takes ownership of safe-open failure handles, retaining them until an explicit retry", async () => {
    const owned = await fs.open(path, "r"); handles.push(owned);
    const failure = new FileAccessError("file_changed"); failure.handle = owned;
    vi.spyOn(owned, "close").mockRejectedValueOnce(new Error("close failure"));
    vi.mocked(openSourceFile).mockRejectedValueOnce(failure);
    const reader = runtime();
    expect(await reader.handle(openFrame(), scope)).toMatchObject({ code: "file_changed" });
    expect(reader.resourceCount).toBe(1);
    await reader.dispose(); expect(reader.resourceCount).toBe(1);
    await reader.dispose(); expect(reader.resourceCount).toBe(0);
  });

  it("inspects linked publication paths using the same quota and returns only after close", async () => {
    const link = join(directory, "link"); await fs.symlink(path, link);
    const reader = runtime();
    expect(await reader.inspectForPublication(link)).toEqual({ sourcePath: path, fileName: "file.md", mimeType: "text/markdown", byteLength: 5 });
    expect(openSourceFile).toHaveBeenLastCalledWith(link, { resolveLinks: true, maxBytes: FILE_MAX_BYTES });
    expect(reader.resourceCount).toBe(0);
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
    vi.mocked(inspectFile).mockImplementationOnce(async (...args) => {
      vi.spyOn(args[0], "close").mockRejectedValueOnce(new Error("close failure"));
      return actualInspect(...args);
    });
    await expect(reader.inspectForPublication(path)).rejects.toThrow("io_error");
    expect(reader.resourceCount).toBe(1);
    await reader.dispose(); expect(reader.resourceCount).toBe(0);
  });

  it("disposes a pending publication inspection and reclaims a late inspection handle", async () => {
    const gate = deferred(); const started = deferred();
    vi.mocked(inspectFile).mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return actualInspect(...args); });
    const reader = runtime();
    const pending = reader.inspectForPublication(path); await started.promise;
    await reader.dispose();
    await expect(pending).rejects.toMatchObject({ message: "invalid_transfer" });
    expect(reader.resourceCount).toBe(1);
    gate.resolve(); await drained(reader);
  });

  it("keeps a final chunk pending until close succeeds and rechecks scope after close", async () => {
    let current = true;
    const reader = runtime({ isCurrent: () => current }); const initial = await opened(reader);
    const gate = deferred(); const started = deferred();
    const actualClose = handles[0]!.close.bind(handles[0]!);
    vi.spyOn(handles[0]!, "close").mockImplementationOnce(async () => {
      started.resolve(); await gate.promise; await actualClose(); current = false;
    });
    let settled = false;
    const pending = reader.handle(readFrame(initial), scope).then((response) => { settled = true; return response; });
    await started.promise;
    expect(settled).toBe(false); expect(reader.resourceCount).toBe(1);
    gate.resolve();
    expect(await pending).toMatchObject({ type: "file_error", code: "invalid_transfer" });
    await drained(reader);
  });

  it("rejects content changed by an awaited read before sending even a non-final chunk", async () => {
    await fs.writeFile(path, Buffer.alloc(FILE_CHUNK_BYTES + 1, 0x61));
    const reader = runtime(); const initial = await opened(reader);
    const actualRead = handles[0]!.read.bind(handles[0]!);
    vi.spyOn(handles[0]!, "read").mockImplementationOnce(async (...args: Parameters<FileHandle["read"]>) => {
      const result = await actualRead(...args); await fs.writeFile(path, Buffer.alloc(FILE_CHUNK_BYTES + 1, 0x62)); return result;
    });
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ type: "file_error", code: "file_changed" });
    await drained(reader);
  });

  it("invalidates a live replay when the publication becomes unavailable", async () => {
    let available = true;
    const reader = runtime({ resolve: () => available ? { sourcePath: path } : null });
    await opened(reader); available = false;
    expect(await reader.handle(openFrame(), scope)).toMatchObject({ type: "file_error", code: "not_available" });
    await drained(reader);
  });

  it("disposes publication inspection while safe-open is pending and owns the late handle", async () => {
    const gate = deferred(); const started = deferred();
    vi.mocked(openSourceFile).mockImplementationOnce(async (...args) => {
      const result = await actualOpen(...args); handles.push(result.handle); started.resolve(); await gate.promise; return result;
    });
    const reader = runtime(); const pending = reader.inspectForPublication(path); await started.promise;
    await reader.dispose();
    await expect(pending).rejects.toMatchObject({ message: "invalid_transfer" });
    expect(reader.resourceCount).toBe(1);
    gate.resolve(); await drained(reader);
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("shares the eight-resource ceiling across instances while preserving local limits", async () => {
    const first = runtime({ maxResources: 3 }); const second = runtime();
    for (let index = 0; index < 3; index++) await opened(first, `first-${index}`);
    expect(await first.handle(openFrame("local-overflow"), scope)).toMatchObject({ code: "busy" });
    for (let index = 0; index < 5; index++) await opened(second, `second-${index}`);
    expect(first.resourceCount + second.resourceCount).toBe(8);
    expect(await second.handle(openFrame("process-overflow"), scope)).toMatchObject({ code: "busy" });
    await expect(second.inspectForPublication(path)).rejects.toThrow("busy");
    await first.dispose();
    await opened(second, "released-slot");
    expect(second.resourceCount).toBe(6);
  });

  it("keeps failed disposal leases across module reload and restores capacity only after close", async () => {
    const previous = runtime(); await opened(previous);
    const close = vi.spyOn(handles[0]!, "close").mockRejectedValueOnce(new Error("close failure"));
    await previous.dispose(); expect(previous.resourceCount).toBe(1);
    vi.resetModules();
    const { FileReaderRuntime: ReloadedReader } = await import("./reader.js");
    const next = new ReloadedReader({ resolve: () => ({ sourcePath: path }), isCurrent: () => true });
    runtimes.push(next);
    for (let index = 0; index < 7; index++) await opened(next, `next-${index}`);
    expect(await next.handle(openFrame("reload-overflow"), scope)).toMatchObject({ code: "busy" });
    expect(previous.resourceCount + next.resourceCount).toBe(8);
    await previous.dispose();
    expect(close).toHaveBeenCalledTimes(2); expect(previous.resourceCount).toBe(0);
    await opened(next, "recovered-slot"); expect(next.resourceCount).toBe(8);
  });

  it("reclaims exactly thirty seconds after the last chunk, not at the next periodic tick", async () => {
    await fs.writeFile(path, Buffer.alloc(FILE_CHUNK_BYTES * 3, 0x61));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(0);
    const reader = runtime(); const initial = await opened(reader);
    const close = vi.spyOn(handles[0]!, "close");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ type: "file_chunk", final: false });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(Date.now()).toBe(58_999); expect(reader.resourceCount).toBe(1); expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(59_000); expect(close).toHaveBeenCalledTimes(1);
    expect(await reader.handle(readFrame(initial, FILE_CHUNK_BYTES), scope)).toMatchObject({ code: "invalid_transfer" });
    await reader.closeWhere(() => true); expect(reader.resourceCount).toBe(0);
  });

  it.each(["open", "read"] as const)("expires pending %s at its idle deadline but holds its process lease until late I/O completes", async (kind) => {
    await fs.writeFile(path, Buffer.alloc(FILE_CHUNK_BYTES * 2, 0x61));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(0);
    const reader = runtime(); const other = runtime(); const gate = deferred(); const started = deferred();
    let pending: Promise<ServerFrame>; let settled = false;
    if (kind === "open") {
      vi.mocked(openSourceFile).mockImplementationOnce(async (...args) => {
        const result = await actualOpen(...args); handles.push(result.handle); started.resolve(); await gate.promise; return result;
      });
      pending = reader.handle(openFrame(), scope);
    } else {
      const initial = await opened(reader);
      const actualRead = handles[0]!.read.bind(handles[0]!);
      vi.spyOn(handles[0]!, "read").mockImplementationOnce(async (...args: Parameters<FileHandle["read"]>) => {
        started.resolve(); await gate.promise; return actualRead(...args);
      });
      pending = reader.handle(readFrame(initial), scope);
    }
    void pending.then(() => { settled = true; });
    await started.promise;
    for (let index = 0; index < 7; index++) await opened(other, `other-${index}`);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false); expect(reader.resourceCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ type: "file_error", code: "invalid_transfer" });
    expect(reader.resourceCount).toBe(1);
    // 其他资源也到期，但显式等待其关闭，迟到任务仍必须单独占额。
    await other.dispose();
    for (let index = 0; index < 7; index++) await opened(runtime(), `fresh-${index}`);
    const newcomer = runtime();
    expect(await newcomer.handle(openFrame("late-overflow"), scope)).toMatchObject({ code: "busy" });
    gate.resolve();
    vi.useRealTimers(); await drained(reader);
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
    await opened(newcomer, "late-reclaimed");
  });

  it("uses a bounded retry deadline after idle close failure without a zero-delay loop", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(0);
    const reader = runtime(); await opened(reader);
    const close = vi.spyOn(handles[0]!, "close").mockRejectedValueOnce(new Error("close failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(close).toHaveBeenCalledTimes(1); expect(reader.resourceCount).toBe(1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999); expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(close).toHaveBeenCalledTimes(2);
    await reader.closeWhere(() => true); expect(reader.resourceCount).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("idle reclaims opened resources and retries close failures without making tombstones", async () => {
    const reader = runtime({ idleMs: 50 }); const initial = await opened(reader);
    vi.spyOn(handles[0]!, "close").mockRejectedValueOnce(new Error("close failure"));
    await drained(reader);
    expect(await reader.handle(readFrame(initial), scope)).toMatchObject({ code: "invalid_transfer" });
    const next = await opened(reader);
    expect(next.transfer_id).not.toBe(initial.transfer_id);
  });
});
