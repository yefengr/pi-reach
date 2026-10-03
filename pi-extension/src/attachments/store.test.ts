import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_COUNT } from "@pi-reach/protocol/session";
import { AttachmentStore, AttachmentStoreError, type AttachmentBeginInput, type AttachmentScope,
  type AttachmentStoreOptions, type AttachmentStoreTestHooks } from "./store.js";

const roots: string[] = [];
const stores: AttachmentStore[] = [];
const children: ChildProcess[] = [];

async function setup(options: Partial<AttachmentStoreOptions> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-reach-attachments-"));
  roots.push(root);
  const rootDir = join(root, "store");
  const store = new AttachmentStore({ rootDir, runtimeId: "test-runtime", minFreeBytes: 2, ...options });
  stores.push(store);
  const scope = { ownerId: "owner", sessionId: "session", uploadScope: store.scopeFor("session") };
  return { root, rootDir, store, scope };
}

function input(uploadId: string, contents = "test", extra: Partial<AttachmentBeginInput> = {}): AttachmentBeginInput {
  return { uploadId, fileName: "../display-only.bin", mimeType: "application/octet-stream",
    byteLength: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"), ...extra };
}

async function complete(store: AttachmentStore, scope: AttachmentScope, uploadId: string, contents = "test") {
  await store.begin(scope, input(uploadId, contents));
  if (contents.length) await store.write(scope, uploadId, 0, Buffer.from(contents));
  const done = await store.finish(scope, uploadId);
  expect(done.status).toBe("complete");
  return done.attachment!.attachment_id;
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return { release, started, block: async () => { entered(); await waiting; } };
}

async function message(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clear(); reject(new Error(`Fixture ${type} timeout`)); }, 15_000);
    const onMessage = (value: unknown) => {
      if (typeof value === "object" && value !== null && "type" in value && value.type === type) {
        clear(); resolve(value as Record<string, unknown>);
      }
    };
    const onExit = () => { clear(); reject(new Error("Fixture exited before response")); };
    function clear() { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); }
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function startChild(root: string, available = 6, unit = 1, byteLength = 4) {
  const child = fork(fileURLToPath(new URL("./reservation.fixture.ts", import.meta.url)),
    [root, String(available), String(unit), String(byteLength)], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  await message(child, "ready");
  return child;
}

async function killChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) await killChild(child);
  for (const store of stores.splice(0)) await store.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("attachment safe receiving store", () => {
  test("preserves exact originals, private modes, random paths and immutable descriptors", async () => {
    const { store, scope, rootDir } = await setup();
    const id = await complete(store, scope, "one", "原件\u0000contents");
    const [{ path, descriptor }] = store.resolve(scope, [id]);
    expect(await readFile(path)).toEqual(Buffer.from("原件\u0000contents"));
    expect(dirname(path)).toBe(join(rootDir, createHash("sha256").update("session").digest("hex")));
    expect(path).not.toContain("display-only");
    expect(descriptor.file_name).toBe("../display-only.bin");
    expect(Object.isFrozen(descriptor)).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
    }
  });

  test("zero files finish and begin/finish/identical chunks are idempotent", async () => {
    const { store, scope } = await setup();
    const emptyId = await complete(store, scope, "empty", "");
    expect((await stat(store.resolve(scope, [emptyId])[0].path)).size).toBe(0);
    const one = input("one");
    expect(await store.begin(scope, one)).toEqual(await store.begin(scope, one));
    const writing = await store.write(scope, "one", 0, Buffer.from("test"));
    expect(await store.write(scope, "one", 0, Buffer.from("test"))).toEqual(writing);
    const done = await store.finish(scope, "one");
    expect(await store.finish(scope, "one")).toEqual(done);
    expect(await store.write(scope, "one", 0, Buffer.from("test"))).toEqual(done);
    expect(await store.status(scope, "one")).toEqual(done);
  });

  test("rejects incorrect offsets, overlap, differing repetitions and changed begin metadata", async () => {
    const { store, scope } = await setup();
    await store.begin(scope, input("one", "abcdef"));
    await expect(store.write(scope, "one", 1, Buffer.from("a"))).rejects.toMatchObject({ code: "offset_mismatch" });
    await store.write(scope, "one", 0, Buffer.from("abc"));
    await expect(store.write(scope, "one", 2, Buffer.from("cd"))).rejects.toMatchObject({ code: "offset_mismatch" });
    await expect(store.write(scope, "one", 0, Buffer.from("abd"))).rejects.toMatchObject({ code: "integrity_mismatch" });
    await expect(store.begin(scope, input("one", "abcdef", { fileName: "changed" }))).rejects.toMatchObject({ code: "invalid_upload" });
    await store.write(scope, "one", 3, Buffer.from("def"));
    expect((await store.finish(scope, "one")).status).toBe("complete");
  });

  test("enforces declared size, chunk bounds, invalid metadata and digest", async () => {
    const { store, scope } = await setup();
    for (const extra of [{ byteLength: -1 }, { byteLength: 1.5 }, { fileName: "bad\nname" }, { sha256: "A".repeat(64) }]) {
      await expect(store.begin(scope, input("invalid", "", extra))).rejects.toMatchObject({ code: "invalid_upload" });
    }
    await expect(store.begin(scope, input("large", "", { byteLength: ATTACHMENT_MAX_FILE_BYTES + 1 })))
      .rejects.toMatchObject({ code: "too_large" });
    await store.begin(scope, input("one"));
    await expect(store.write(scope, "one", 0, Buffer.alloc(0))).rejects.toMatchObject({ code: "invalid_upload" });
    await expect(store.write(scope, "one", 0, Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1))).rejects.toMatchObject({ code: "invalid_upload" });
    await expect(store.write(scope, "one", 0, Buffer.from("tests"))).rejects.toMatchObject({ code: "too_large" });
    await expect(store.finish(scope, "one")).rejects.toMatchObject({ code: "integrity_mismatch" });
    await store.write(scope, "one", 0, Buffer.from("nope"));
    await expect(store.finish(scope, "one")).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  test("same contents receive distinct IDs, owner and scope ownership cannot be crossed", async () => {
    const { store, scope } = await setup();
    const first = await complete(store, scope, "same");
    const second = await complete(store, scope, "another");
    expect(first).not.toBe(second);
    const other = { ...scope, ownerId: "other" };
    await expect(store.status(other, "same")).rejects.toMatchObject({ code: "not_found" });
    expect(() => store.resolve(other, [first])).toThrowError(AttachmentStoreError);
    const otherId = await complete(store, other, "same");
    expect(otherId).not.toBe(first);
    await expect(store.status({ ...scope, uploadScope: "stale" }, "same")).rejects.toMatchObject({ code: "invalid_scope" });
    expect(() => store.resolve(scope, [first, first])).toThrowError(AttachmentStoreError);
  });

  test("retains atomically without partial marking, cancel intent wins over later retain", async () => {
    const { store, scope } = await setup();
    const first = await complete(store, scope, "one");
    const path = store.resolve(scope, [first])[0].path;
    expect(() => store.retain(scope, [first, "missing"])).toThrowError(AttachmentStoreError);
    await store.cancel(scope, "one");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await complete(store, scope, "two");
    const cancelling = store.cancel(scope, "two");
    expect(() => store.retain(scope, [second])).toThrowError(AttachmentStoreError);
    await cancelling;
  });

  test("completed and retained originals close handles promptly while retries and resolve remain valid", async () => {
    const handles: FileHandle[] = [];
    const { store, scope } = await setup({ testHooks: { write: async (handle, bytes, position) => {
      handles.push(handle);
      return (await handle.write(bytes, 0, bytes.length, position)).bytesWritten;
    } } });
    const id = await complete(store, scope, "one");
    expect(handles[0].fd).toBe(-1);
    const resolved = store.resolve(scope, [id]);
    store.retain(scope, [id]);
    expect(handles[0].fd).toBe(-1);
    const done = await store.status(scope, "one");
    expect(await store.begin(scope, input("one"))).toEqual(done);
    expect(await store.finish(scope, "one")).toEqual(done);
    expect(await store.cancel(scope, "one")).toEqual(done);
    for (let i = 0; i < 8; i++) {
      expect(await store.write(scope, "one", 0, Buffer.from("test"))).toEqual(done);
    }
    await expect(store.write(scope, "one", 0, Buffer.from("nope"))).rejects.toMatchObject({ code: "integrity_mismatch" });
    expect(store.resolve(scope, [id])).toEqual(resolved);
    const unretained = await complete(store, scope, "two");
    const path = store.resolve(scope, [unretained])[0].path;
    expect(handles[1].fd).toBe(-1);
    await store.cancel(scope, "two");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("permanent originals survive cancel, scope reset, dispose and fresh instances", async () => {
    const { store, scope, rootDir } = await setup();
    const id = await complete(store, scope, "one");
    const path = store.resolve(scope, [id])[0].path;
    store.retain(scope, [id]);
    expect((await store.cancel(scope, "one")).status).toBe("complete");
    expect(store.scopeFor("session")).toBe(scope.uploadScope);
    store.resetScope("session");
    expect(() => store.resolve(scope, [id])).toThrowError(AttachmentStoreError);
    await store.dispose();
    const fresh = new AttachmentStore({ rootDir, runtimeId: "new-runtime" });
    stores.push(fresh);
    fresh.scopeFor("new-session");
    await fresh.dispose();
    expect(await readFile(path, "utf8")).toBe("test");
  });

  test("disconnect/channel reconstruction has no storage side effect; session changes invalidate leases", async () => {
    const { store, scope } = await setup();
    await store.begin(scope, input("one"));
    await store.write(scope, "one", 0, Buffer.from("te"));
    const reconnected = { ...scope, uploadScope: store.scopeFor("session") };
    expect((await store.status(reconnected, "one")).receivedBytes).toBe(2);
    await store.write(reconnected, "one", 2, Buffer.from("st"));
    const done = await store.finish(reconnected, "one");
    const path = store.resolve(reconnected, [done.attachment!.attachment_id])[0].path;
    store.scopeFor("another-session");
    await expect(store.status(scope, "one")).rejects.toMatchObject({ code: "invalid_scope" });
    await store.dispose();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cancel is an idempotent tombstone even before begin", async () => {
    const { store, scope } = await setup();
    const cancelled = await store.cancel(scope, "one");
    expect(await store.cancel(scope, "one")).toEqual(cancelled);
    expect(await store.begin(scope, input("one"))).toEqual(cancelled);
    expect(await store.write(scope, "one", 0, Buffer.from("test"))).toEqual(cancelled);
    expect(await store.finish(scope, "one")).toEqual(cancelled);
  });

  test("bounded queue copies buffers and cancel/finish cannot resurrect an in-flight write", async () => {
    const blocked = gate();
    const { store, scope, rootDir } = await setup({ testHooks: { beforeWrite: blocked.block } });
    await store.begin(scope, input("one", "ab"));
    const buffer = Buffer.from("a");
    const first = store.write(scope, "one", 0, buffer);
    buffer.fill(120);
    await blocked.started;
    const second = store.write(scope, "one", 1, Buffer.from("b"));
    await expect(store.status(scope, "one")).rejects.toMatchObject({ code: "busy", retryable: true });
    const cancel = store.cancel(scope, "one");
    blocked.release();
    expect((await first).status).toBe("cancelled");
    expect((await second).status).toBe("cancelled");
    await cancel;
    expect((await store.finish(scope, "one")).status).toBe("cancelled");
    expect(await readdir(join(rootDir, createHash("sha256").update("session").digest("hex")))).toEqual([]);
  });

  test("copy at enqueue preserves bytes and per-upload queue serializes writes", async () => {
    const blocked = gate();
    const { store, scope } = await setup({ testHooks: { beforeWrite: blocked.block } });
    await store.begin(scope, input("one", "ab"));
    const buffer = Buffer.from("a");
    const first = store.write(scope, "one", 0, buffer);
    buffer.fill(120);
    await blocked.started;
    const second = store.write(scope, "one", 1, Buffer.from("b"));
    blocked.release();
    await Promise.all([first, second]);
    const done = await store.finish(scope, "one");
    expect(await readFile(store.resolve(scope, [done.attachment!.attachment_id])[0].path, "utf8")).toBe("ab");
  });

  test("scope reset and dispose wait for started filesystem writes before removing files", async () => {
    for (const reset of [true, false]) {
      const blocked = gate();
      const hooks: AttachmentStoreTestHooks = {
        write: async (handle, bytes, position) => {
          await blocked.block();
          return (await handle.write(bytes, 0, bytes.length, position)).bytesWritten;
        },
      };
      const { store, scope, rootDir } = await setup({ testHooks: hooks });
      await store.begin(scope, input("one"));
      const writing = store.write(scope, "one", 0, Buffer.from("test"));
      const failed = expect(writing).rejects.toMatchObject({ code: "invalid_scope" });
      await blocked.started;
      if (reset) store.resetScope("session");
      const disposing = store.dispose();
      const directory = join(rootDir, createHash("sha256").update("session").digest("hex"));
      expect((await readdir(directory)).length).toBe(1);
      blocked.release();
      await failed;
      await disposing;
      expect(await readdir(directory)).toEqual([]);
    }
  });

  test("finish/cancel competition never publishes a cancelled attachment", async () => {
    const { store, scope } = await setup();
    await store.begin(scope, input("one"));
    await store.write(scope, "one", 0, Buffer.from("test"));
    const finishing = store.finish(scope, "one");
    const cancelling = store.cancel(scope, "one");
    expect((await finishing).status).toBe("cancelled");
    expect((await cancelling).status).toBe("cancelled");
  });

  test("limits unretained resources but never applies cumulative quota to retained files", async () => {
    const { store, scope } = await setup();
    for (let i = 0; i < ATTACHMENT_MAX_COUNT + 2; i++) {
      const id = await complete(store, scope, `retained-${i}`, "");
      store.retain(scope, [id]);
    }
    for (let i = 0; i < ATTACHMENT_MAX_COUNT; i++) await store.begin(scope, input(`active-${i}`, ""));
    await expect(store.begin(scope, input("too-many", ""))).rejects.toMatchObject({ code: "too_large" });
    await store.cancel(scope, "active-0");
    await store.begin(scope, input("replacement", ""));
  });

  test("enforces owner total declared bytes and message resolved total", async () => {
    const { store, scope } = await setup({ testHooks: { availableBytes: () => 1024n * 1024n * 1024n } });
    await store.begin(scope, input("large-1", "", { byteLength: ATTACHMENT_MAX_FILE_BYTES }));
    await store.begin(scope, input("large-2", "", { byteLength: ATTACHMENT_MAX_FILE_BYTES }));
    await expect(store.begin(scope, input("over", "x"))).rejects.toMatchObject({ code: "too_large" });
    expect(() => store.resolve(scope, [])).toThrowError(AttachmentStoreError);
    expect(() => store.resolve(scope, Array.from({ length: 11 }, () => randomUUID()))).toThrowError(AttachmentStoreError);
  });

  test("rejects pre-existing root, session and reservation symlinks without changing targets", async () => {
    for (const target of ["root", "session", "ledger"]) {
      const { root, rootDir, store, scope } = await setup();
      const outside = join(root, "outside");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(outside);
      if (target === "root") await symlink(outside, rootDir);
      else {
        await mkdir(rootDir);
        const internal = target === "session" ? createHash("sha256").update("session").digest("hex") : ".reservations";
        await symlink(outside, join(rootDir, internal));
      }
      await expect(store.begin(scope, input("one"))).rejects.toMatchObject({ code: "invalid_upload" });
      expect(await readdir(outside)).toEqual([]);
    }
  });

  test("resolve rejects a replaced original symlink with a sanitized store error", async () => {
    const { root, store, scope } = await setup();
    const id = await complete(store, scope, "one");
    const path = store.resolve(scope, [id])[0].path;
    const moved = join(root, "moved-original");
    const { rename } = await import("node:fs/promises");
    await rename(path, moved);
    await symlink(moved, path);
    expect(() => store.resolve(scope, [id])).toThrowError(AttachmentStoreError);
    await rm(path);
    await rename(moved, path);
  });
});

describe("optimistic cross-process disk reservations", () => {
  test("checks floor at begin and each write, releasing credits only after writing", async () => {
    let available = 6n;
    const { store, scope, rootDir } = await setup({ testHooks: {
      availableBytes: () => available, afterWrite: (bytes) => { available -= BigInt(bytes); },
    } });
    await store.begin(scope, input("one"));
    available = 5n;
    await expect(store.write(scope, "one", 0, Buffer.from("test"))).rejects.toMatchObject({ code: "no_space", retryable: true });
    expect((await store.status(scope, "one")).receivedBytes).toBe(0);
    available = 6n;
    await store.write(scope, "one", 0, Buffer.from("test"));
    const names = (await readdir(join(rootDir, ".reservations"))).filter((name) => name.endsWith(".json"));
    const record = JSON.parse(await readFile(join(rootDir, ".reservations", names[0]), "utf8"));
    expect(record.remainingBytes).toBe(0);
    await expect(store.begin(scope, input("two", "x"))).rejects.toMatchObject({ code: "no_space" });
    await store.finish(scope, "one");
    expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
  });

  test("allocation credits round tiny files and release only after allocated blocks are written", async () => {
    let available = 8194n;
    const blocked = gate();
    const { store, scope, rootDir } = await setup({ testHooks: {
      allocationUnitBytes: 4096, availableBytes: () => available,
      afterWrite: async () => { available -= 4096n; await blocked.block(); },
    } });
    await store.begin(scope, input("one", "x"));
    const ledger = join(rootDir, ".reservations");
    const [name] = await readdir(ledger);
    const readCredits = async () => JSON.parse(await readFile(join(ledger, name), "utf8")).remainingBytes;
    expect(await readCredits()).toBe(4096);
    const writing = store.write(scope, "one", 0, Buffer.from("x"));
    await blocked.started;
    expect(await readCredits()).toBe(4096);
    blocked.release();
    await writing;
    expect(await readCredits()).toBe(0);
    await store.begin(scope, input("two", "y"));
    await expect(store.begin(scope, input("third", "z"))).rejects.toMatchObject({ code: "no_space" });
    await store.write(scope, "two", 0, Buffer.from("y"));
    expect(available).toBe(2n);
    await expect(store.begin(scope, input("fourth", "z"))).rejects.toMatchObject({ code: "no_space" });
  });

  test("already allocated partial blocks need no duplicate credits; rounded maximum remains valid and strict", async () => {
    let available = 4098n;
    let writes = 0;
    const { store, scope, rootDir } = await setup({ testHooks: {
      allocationUnitBytes: 4096, availableBytes: () => available,
      afterWrite: () => { if (++writes === 1) available -= 4096n; },
    } });
    await store.begin(scope, input("partial", "ab"));
    await store.write(scope, "partial", 0, Buffer.from("a"));
    await store.write(scope, "partial", 1, Buffer.from("b"));
    await store.finish(scope, "partial");
    await store.cancel(scope, "partial");
    const other = new AttachmentStore({ rootDir, runtimeId: "rounded", minFreeBytes: 2,
      testHooks: { allocationUnitBytes: 3000, availableBytes: () => 1024n * 1024n * 1024n } });
    stores.push(other);
    const otherScope = { ...scope, uploadScope: other.scopeFor("session") };
    await other.begin(otherScope, input("maximum", "", { byteLength: ATTACHMENT_MAX_FILE_BYTES }));
    const ledger = join(rootDir, ".reservations");
    const [name] = await readdir(ledger);
    const recordPath = join(ledger, name);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    expect(record.remainingBytes).toBe(Math.ceil(ATTACHMENT_MAX_FILE_BYTES / 3000) * 3000);
    const original = record.remainingBytes;
    await writeFile(recordPath, JSON.stringify({ ...record, remainingBytes: original + 1 }));
    await expect(other.begin(otherScope, input("invalid"))).rejects.toMatchObject({ code: "io_error" });
    await writeFile(recordPath, JSON.stringify({ ...record, remainingBytes: original }));
  });

  test("two processes cannot reserve two single-byte files against one 4KiB allocation unit", async () => {
    const { rootDir } = await setup();
    const [first, second] = await Promise.all([startChild(rootDir, 4098, 4096, 1), startChild(rootDir, 4098, 4096, 1)]);
    const responses = [message(first, "result"), message(second, "result")];
    first.send("begin");
    second.send("begin");
    const results = await Promise.all(responses);
    expect(results.filter((result) => result.accepted).length).toBeLessThanOrEqual(1);
    expect(results.every((result) => result.accepted || result.code === "no_space")).toBe(true);
  }, 30_000);

  test("proven dead records above the activity limit do not block uploads or delete historical originals", async () => {
    const { store, scope, rootDir, root } = await setup({ testHooks: { availableBytes: () => 6n } });
    await store.begin(scope, input("initial", ""));
    await store.cancel(scope, "initial");
    const ledger = join(rootDir, ".reservations");
    const originalPath = join(root, "historical-original");
    await writeFile(originalPath, "historical");
    const deadPid = process.pid + 1_000_000;
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return kill(pid, signal);
    });
    const body = JSON.stringify({ pid: deadPid, runtimeId: "dead", uploadId: "dead", remainingBytes: 4 });
    for (let offset = 0; offset < 4096; offset += 64) {
      await Promise.all(Array.from({ length: 64 }, () => writeFile(join(ledger, `${randomUUID()}.json`), body)));
    }
    await store.begin(scope, input("new"));
    await store.cancel(scope, "new");
    expect((await readdir(ledger)).length).toBe(4096);
    expect(await readFile(originalPath, "utf8")).toBe("historical");
    spy.mockImplementation((pid, signal) => {
      if (pid === deadPid) throw Object.assign(new Error("not proven dead"), { code: "EPERM" });
      return kill(pid, signal);
    });
    await expect(store.begin(scope, input("conservative"))).rejects.toMatchObject({ code: "no_space" });
  }, 30_000);

  test("maps ENOSPC and partial write failures without counting incomplete bytes", async () => {
    let calls = 0;
    const { store, scope } = await setup({ testHooks: { write: async (handle, bytes, position) => {
      if (++calls === 1) return (await handle.write(bytes, 0, 1, position)).bytesWritten;
      throw Object.assign(new Error("sensitive local path"), { code: "ENOSPC" });
    } } });
    await store.begin(scope, input("one"));
    await expect(store.write(scope, "one", 0, Buffer.from("test")))
      .rejects.toMatchObject({ code: "no_space", retryable: true, message: "Attachment operation failed (no_space)." });
    expect((await store.status(scope, "one")).receivedBytes).toBe(0);
  });

  test("two instances share credits and cancellation returns its own reservation", async () => {
    const { rootDir, store, scope } = await setup({ testHooks: { availableBytes: () => 6n } });
    const other = new AttachmentStore({ rootDir, runtimeId: "other", minFreeBytes: 2,
      testHooks: { availableBytes: () => 6n } });
    stores.push(other);
    const otherScope = { ...scope, uploadScope: other.scopeFor("session") };
    const results = await Promise.allSettled([store.begin(scope, input("one")), other.begin(otherScope, input("two"))]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
    await store.cancel(scope, "one");
    await other.cancel(otherScope, "two");
    await store.begin(scope, input("fresh"));
  });

  test("two independent processes cannot over-admit; killed holder does not block future uploads", async () => {
    const { rootDir, store, scope } = await setup({ testHooks: { availableBytes: () => 6n } });
    const [first, second] = await Promise.all([startChild(rootDir), startChild(rootDir)]);
    const responses = [message(first, "result"), message(second, "result")];
    first.send("begin");
    second.send("begin");
    const results = await Promise.all(responses);
    expect(results.filter((result) => result.accepted).length).toBeLessThanOrEqual(1);
    expect(results.every((result) => result.accepted || result.code === "no_space")).toBe(true);
    await Promise.all([killChild(first), killChild(second)]);
    const oldNames = await readdir(join(rootDir, ".reservations"));
    await store.begin(scope, input("after-death"));
    for (const name of oldNames) expect(await stat(join(rootDir, ".reservations", name))).toBeDefined();
    await store.cancel(scope, "after-death");
    expect(await readdir(join(rootDir, ".reservations"))).toEqual(oldNames);
  }, 30_000);

  test("unknown/invalid/bounded JSON and reservation symlinks fail closed", async () => {
    const { store, scope, rootDir, root } = await setup();
    await store.begin(scope, input("one", ""));
    const ledger = join(rootDir, ".reservations");
    const invalid = join(ledger, `${randomUUID()}.json`);
    for (const body of ["{", " ".repeat(4097), JSON.stringify({ pid: process.pid, remainingBytes: -1 })]) {
      await writeFile(invalid, body);
      await expect(store.begin(scope, input("bad"))).rejects.toMatchObject({ code: "io_error" });
      await rm(invalid);
    }
    const outside = join(root, "outside-record");
    await writeFile(outside, "unrelated");
    await symlink(outside, invalid);
    await expect(store.begin(scope, input("symlink"))).rejects.toMatchObject({ code: "invalid_upload" });
    expect(await readFile(outside, "utf8")).toBe("unrelated");
    await rm(invalid);
  });

  test("EPERM records count conservatively and cannot be ignored as dead", async () => {
    const { store, scope } = await setup({ testHooks: { availableBytes: () => 6n } });
    await store.begin(scope, input("one"));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("unknown pid"), { code: "EPERM" }); });
    await expect(store.begin(scope, input("two", "x"))).rejects.toMatchObject({ code: "no_space" });
  });
});
