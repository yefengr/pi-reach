import { fork, type ChildProcess } from "node:child_process";
import { lstatSync, rmdirSync, type PathLike } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_COUNT } from "@pi-reach/protocol/session";
import { AttachmentStore, AttachmentStoreError, type AttachmentBeginInput, type AttachmentScope,
  type AttachmentStoreOptions, type AttachmentStoreTestHooks } from "./store.js";
import { DiskReservation } from "./reservations.js";
import { createPrivateFile } from "./safe-files.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), rmdirSync: vi.fn(actual.rmdirSync) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

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

function localDateDirectory(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
  vi.useRealTimers();
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
    expect(dirname(path)).toBe(join(rootDir, localDateDirectory(new Date()), id));
    expect(basename(path)).toBe(".._display-only.bin");
    expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(descriptor.sha256);
    expect(descriptor.file_name).toBe("../display-only.bin");
    expect(Object.isFrozen(descriptor)).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(dirname(path)))).mode & 0o777).toBe(0o700);
      expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
    }
  });

  test("new uploads, reset and dispose leave legacy session-hash originals at their existing paths", async () => {
    const { store, scope, rootDir } = await setup();
    const directory = join(rootDir, createHash("sha256").update(scope.sessionId).digest("hex"));
    const legacyPath = join(directory, `${randomUUID()}.bin`);
    const bytes = Buffer.from("旧原件\u0000保持原位");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(legacyPath, bytes);
    const original = await stat(legacyPath);
    const id = await complete(store, scope, "new-upload");
    const newPath = store.resolve(scope, [id])[0].path;
    expect(dirname(newPath)).not.toBe(directory);
    expect(await readdir(directory)).toEqual([basename(legacyPath)]);
    expect(await readFile(legacyPath)).toEqual(bytes);
    store.resetScope(scope.sessionId);
    await store.dispose();
    await expect(stat(newPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([basename(legacyPath)]);
    expect(await readFile(legacyPath)).toEqual(bytes);
    expect(await stat(legacyPath)).toMatchObject({ ino: original.ino, dev: original.dev, size: bytes.length });
  });

  test("preserves ordinary names and extensions with identical names isolated by attachment ID", async () => {
    const { store, scope, rootDir } = await setup();
    const fileName = "项目 原件.v1.tar.gz";
    const ids: string[] = [];
    for (const uploadId of ["first-name", "same-name"]) {
      await store.begin(scope, input(uploadId, "原始字节\u0000", { fileName }));
      await store.write(scope, uploadId, 0, Buffer.from("原始字节\u0000"));
      ids.push((await store.finish(scope, uploadId)).attachment!.attachment_id);
    }
    const files = store.resolve(scope, ids);
    expect(files[0].path).not.toBe(files[1].path);
    for (const { path, descriptor } of files) {
      expect(path).toBe(join(rootDir, localDateDirectory(new Date()), descriptor.attachment_id, fileName));
      expect(descriptor.file_name).toBe(fileName);
      expect(await readFile(path)).toEqual(Buffer.from("原始字节\u0000"));
    }
    const longName = `${"长".repeat(100)}.jpeg`;
    await store.begin(scope, input("long-name", "", { fileName: longName }));
    const done = await store.finish(scope, "long-name");
    const path = store.resolve(scope, [done.attachment!.attachment_id])[0].path;
    expect(Buffer.byteLength(basename(path))).toBeLessThanOrEqual(240);
    expect(basename(path)).toMatch(/^长+\.jpeg$/u);
    expect(done.attachment!.file_name).toBe(longName);
    expect((await stat(path)).size).toBe(0);
  });

  test("first begin freezes local date even while queued and repeated across midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const firstDay = new Date(2026, 9, 3, 23, 59, 59);
    vi.setSystemTime(firstDay);
    const { store, scope, rootDir } = await setup();
    const file = input("midnight", "", { fileName: "空文件.txt" });
    const beginning = store.begin(scope, file);
    vi.setSystemTime(new Date(2026, 9, 4, 0, 0, 1));
    await beginning;
    await store.begin(scope, file);
    const done = await store.finish(scope, file.uploadId);
    const [{ path }] = store.resolve(scope, [done.attachment!.attachment_id]);
    expect(path).toBe(join(rootDir, localDateDirectory(firstDay), done.attachment!.attachment_id, file.fileName));
    expect(await store.begin(scope, file)).toEqual(done);
    expect(store.resolve(scope, [done.attachment!.attachment_id])[0].path).toBe(path);
    await store.begin(scope, input("next-day", ""));
    const next = await store.finish(scope, "next-day");
    expect(dirname(dirname(store.resolve(scope, [next.attachment!.attachment_id])[0].path)))
      .toBe(join(rootDir, "2026-10-04"));
  });

  test("discard isolates owner/session/lease and releases ten completed originals idempotently", async () => {
    const { store, scope } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < ATTACHMENT_MAX_COUNT; index++) ids.push(await complete(store, scope, `old-${index}`));
    const paths = store.resolve(scope, ids).map((item) => item.path);
    await expect(store.begin(scope, input("overflow"))).rejects.toMatchObject({ code: "too_large" });
    await expect(store.discard({ ...scope, ownerId: "other" }, ids[0])).rejects.toMatchObject({ code: "not_found" });
    for (const wrong of [{ sessionId: "other" }, { uploadScope: "stale" }]) {
      await expect(store.discard({ ...scope, ...wrong }, ids[0])).rejects.toMatchObject({ code: "invalid_scope" });
    }
    await expect(store.discard(scope, "unknown")).rejects.toMatchObject({ code: "not_found" });
    expect(store.debugCounts().resources).toBe(10);
    for (const id of ids) {
      expect(await store.discard(scope, id)).toBe("cancelled");
      expect(await store.discard(scope, id)).toBe("cancelled");
      await expect(store.discard({ ...scope, ownerId: "other" }, id)).rejects.toMatchObject({ code: "not_found" });
    }
    for (const path of paths) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(store.debugCounts()).toMatchObject({ resources: 0, attachments: 0 });
    for (let index = 0; index < ATTACHMENT_MAX_COUNT; index++) await complete(store, scope, `new-${index}`);
    expect(store.debugCounts().resources).toBe(10);
  });

  test.each(["cancel", "discard", "reset", "dispose"] as const)("%s retries failed ID-directory removal without dropping ownership", async (operation) => {
    const { store, scope } = await setup();
    const id = await complete(store, scope, "directory-retry");
    const path = store.resolve(scope, [id])[0].path;
    const directory = dirname(path);
    const remove = vi.mocked(rmdirSync);
    remove.mockClear();
    remove.mockImplementationOnce(() => { throw Object.assign(new Error("private directory"), { code: "EACCES" }); });
    if (operation === "reset") {
      store.resetScope(scope.sessionId);
      await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({ resources: 1, cleanups: 0, pending: 0 }));
    } else {
      const task = operation === "cancel" ? store.cancel(scope, "directory-retry") :
        operation === "discard" ? store.discard(scope, id) : store.dispose();
      await expect(task).rejects.toMatchObject({ code: "io_error", retryable: true });
    }
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(store.debugCounts().resources).toBe(1);
    if (operation === "reset") {
      store.resetScope(scope.sessionId);
      await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({ resources: 0, cleanups: 0, pending: 0 }));
    } else if (operation === "dispose") await expect(store.dispose()).resolves.toBeUndefined();
    else if (operation === "cancel") await store.cancel(scope, "directory-retry");
    else await store.discard(scope, id);
    expect(remove.mock.calls.filter(([target]) => target === directory)).toHaveLength(2);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.debugCounts().resources).toBe(0);
    if (operation !== "dispose") {
      const current = { ...scope, uploadScope: store.scopeFor(scope.sessionId) };
      await complete(store, current, "next-upload");
      await expect(store.dispose()).resolves.toBeUndefined();
    }
  });

  test.each(["error", "invalid"] as const)("post-mkdir identity %s retains the incomplete directory resource without later adoption", async (failure) => {
    const { rootDir, store, scope } = await setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const directory = join(rootDir, localDateDirectory(new Date()), id);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let injected = false;
    vi.mocked(lstatSync).mockImplementation(((path: PathLike) => {
      const current = actual.lstatSync(path);
      if (path === directory && !injected) {
        injected = true;
        if (failure === "error") throw Object.assign(new Error("private identity"), { code: "EACCES" });
        current.isDirectory = () => false;
      }
      return current;
    }) as typeof lstatSync);
    vi.mocked(randomUUID).mockReturnValueOnce(id);
    await expect(store.begin(scope, input("identity-failure", ""))).rejects.toMatchObject({
      code: failure === "error" ? "io_error" : "invalid_upload",
    });
    expect(injected).toBe(true);
    expect(store.debugCounts()).toMatchObject({ resources: 1, records: 1, attachments: 0 });
    expect(await readdir(directory)).toEqual([]);
    // 后续 lstat 已恢复正常，也不能将现在看到的 identity 当作 mkdir 时的证据。
    await expect(store.cancel(scope, "identity-failure")).rejects.toMatchObject({ code: "invalid_upload" });
    expect(store.debugCounts()).toMatchObject({ resources: 1, records: 1 });
    expect(await readdir(directory)).toEqual([]);
    await expect(store.dispose()).rejects.toMatchObject({ code: "invalid_upload" });
    stores.splice(stores.indexOf(store), 1);
    expect(store.debugCounts()).toMatchObject({ resources: 1, records: 1 });
    expect(await readdir(directory)).toEqual([]);
  });

  test.each(["empty", "nonempty", "symlink"] as const)("pre-existing %s ID directory is never acquired or deleted", async (kind) => {
    const { root, rootDir, store, scope } = await setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const directory = join(rootDir, localDateDirectory(new Date()), id);
    await mkdir(dirname(directory), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    if (kind === "symlink") await symlink(outside, directory);
    else await mkdir(directory);
    if (kind === "nonempty") await writeFile(join(directory, "other"), "historical");
    vi.mocked(randomUUID).mockReturnValueOnce(id);
    await expect(store.begin(scope, input("pre-existing", ""))).rejects.toMatchObject({ code: "invalid_upload" });
    expect(await readdir(directory)).toEqual(kind === "nonempty" ? ["other"] : []);
    expect(store.debugCounts().resources).toBe(0);
    await store.dispose();
    expect(await readdir(directory)).toEqual(kind === "nonempty" ? ["other"] : []);
  });

  test.each(["empty", "nonempty", "symlink"] as const)("cleanup refuses a runtime %s directory replacement and retries only the owned inode", async (kind) => {
    const { root, store, scope } = await setup();
    const moved = join(root, "owned-directory");
    const outside = join(root, "outside");
    // 原件先成功 unlink，再让 rmdir 故障保留精确目录所有权。
    const next = await complete(store, scope, "replacement-retry");
    const nextDirectory = dirname(store.resolve(scope, [next])[0].path);
    vi.mocked(rmdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("retry"), { code: "EACCES" }); });
    await expect(store.discard(scope, next)).rejects.toMatchObject({ code: "io_error" });
    await rename(nextDirectory, moved);
    await mkdir(outside);
    if (kind === "symlink") await symlink(outside, nextDirectory);
    else await mkdir(nextDirectory);
    if (kind === "nonempty") await writeFile(join(nextDirectory, "other"), "unowned");
    await expect(store.discard(scope, next)).rejects.toMatchObject({ code: "invalid_upload" });
    expect(await readdir(nextDirectory)).toEqual(kind === "nonempty" ? ["other"] : []);
    expect(store.debugCounts().resources).toBe(1);
    await rm(nextDirectory, { recursive: true });
    await rename(moved, nextDirectory);
    await store.discard(scope, next);
    await expect(stat(nextDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.debugCounts().resources).toBe(0);
  });

  test("discard retries a failed original unlink before publishing its cancellation tombstone", async () => {
    const { store, scope } = await setup();
    const id = await complete(store, scope, "unlink-retry");
    const path = store.resolve(scope, [id])[0].path;
    const remove = vi.mocked(unlink);
    remove.mockClear();
    remove.mockRejectedValueOnce(Object.assign(new Error("temporary cleanup failure"), { code: "EACCES" }));
    await expect(store.discard(scope, id)).rejects.toMatchObject({ code: "io_error", retryable: true });
    expect((await stat(path)).size).toBe(4);
    expect(store.debugCounts()).toMatchObject({ attachments: 1, resources: 1 });
    expect(() => store.resolve(scope, [id])).toThrowError(AttachmentStoreError);
    expect(() => store.retain(scope, [id])).toThrowError(AttachmentStoreError);
    expect(await store.discard(scope, id)).toBe("cancelled");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(remove.mock.calls.filter(([target]) => target === path)).toHaveLength(2);
    expect(store.debugCounts()).toMatchObject({ attachments: 0, resources: 0 });
    expect(await store.discard(scope, id)).toBe("cancelled");
    expect(remove.mock.calls.filter(([target]) => target === path)).toHaveLength(2);
    await expect(store.dispose()).resolves.toBeUndefined();
  });

  test.each(["close", "reservation"] as const)("cancel retries a failed %s without losing its live cleanup resource", async (step) => {
    let handle!: FileHandle;
    let path = "";
    const { store, scope, rootDir } = await setup({ testHooks: {
      createFile: async (filePath) => { path = filePath; return createPrivateFile(filePath); },
      afterCreate: (created) => { handle = created; },
    } });
    await store.begin(scope, input("cleanup-retry"));
    const id = basename(dirname(path));
    const ledger = join(rootDir, ".reservations");
    const close = vi.spyOn(handle, "close");
    const remove = vi.spyOn(DiskReservation.prototype, "remove");
    const failed = step === "close" ? close : remove;
    failed.mockRejectedValueOnce(Object.assign(new Error("temporary cleanup failure"), { code: "EACCES" }));
    await expect(store.cancel(scope, "cleanup-retry")).rejects.toMatchObject({ code: "io_error", retryable: true });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(store.debugCounts()).toMatchObject({ attachments: 1, resources: 1 });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    if (step === "close") {
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      expect((await stat(dirname(path))).isDirectory()).toBe(true);
      expect(await readdir(ledger)).toEqual([]);
    } else {
      expect(handle.fd).toBe(-1);
      expect(await readdir(ledger)).toHaveLength(1);
    }
    expect(await store.discard(scope, id)).toBe("cancelled");
    expect(failed).toHaveBeenCalledTimes(2);
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(handle.fd).toBe(-1);
    expect(await readdir(ledger)).toEqual([]);
    expect(store.debugCounts()).toMatchObject({ attachments: 0, resources: 0 });
    await expect(store.dispose()).resolves.toBeUndefined();
  });

  test("dispose retries earlier failures but does not erase a different resource's real failure", async () => {
    const { store, scope } = await setup();
    const first = await complete(store, scope, "first-retry");
    const second = await complete(store, scope, "second-failure");
    const [firstPath, secondPath] = store.resolve(scope, [first, second]).map((item) => item.path);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const remove = vi.mocked(unlink);
    remove.mockClear();
    let firstFailed = false;
    remove.mockImplementation(async (path) => {
      if (path === secondPath || (path === firstPath && !firstFailed)) {
        firstFailed ||= path === firstPath;
        throw Object.assign(new Error("temporary cleanup failure"), { code: "EACCES" });
      }
      return actual.unlink(path);
    });
    try {
      await expect(store.discard(scope, first)).rejects.toMatchObject({ code: "io_error" });
      await expect(store.discard(scope, second)).rejects.toMatchObject({ code: "io_error" });
      expect(await store.discard(scope, first)).toBe("cancelled");
      await expect(store.dispose()).rejects.toMatchObject({ code: "io_error" });
      await expect(stat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(secondPath)).size).toBe(4);
      expect(remove.mock.calls.filter(([path]) => path === firstPath)).toHaveLength(2);
      expect(remove.mock.calls.filter(([path]) => path === secondPath)).toHaveLength(2);
      expect(store.debugCounts().resources).toBe(1);
    } finally {
      remove.mockImplementation(actual.unlink);
      stores.splice(stores.indexOf(store), 1);
    }
  });

  test("dispose retries an earlier reservation failure and reports only remaining failures", async () => {
    const { store, scope, rootDir } = await setup();
    await store.begin(scope, input("dispose-retry"));
    const remove = vi.spyOn(DiskReservation.prototype, "remove")
      .mockRejectedValueOnce(Object.assign(new Error("temporary cleanup failure"), { code: "EACCES" }));
    await expect(store.cancel(scope, "dispose-retry")).rejects.toMatchObject({ code: "io_error" });
    await expect(store.dispose()).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
    expect(store.debugCounts()).toMatchObject({ resources: 0, attachments: 0 });
  });

  test("reset retries failed old-lease cleanup before restoring the owner's full active quota", async () => {
    const { store, scope } = await setup();
    const id = await complete(store, scope, "old-reset");
    const path = store.resolve(scope, [id])[0].path;
    const remove = vi.mocked(unlink);
    remove.mockClear();
    remove.mockRejectedValueOnce(Object.assign(new Error("temporary cleanup failure"), { code: "EACCES" }));
    store.resetScope(scope.sessionId);
    await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({ resources: 1, cleanups: 0, pending: 0 }));
    expect((await stat(path)).size).toBe(4);
    await expect(store.discard(scope, id)).rejects.toMatchObject({ code: "invalid_scope" });
    store.resetScope(scope.sessionId);
    const next = { ...scope, uploadScope: store.scopeFor(scope.sessionId) };
    await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({ resources: 0, cleanups: 0, pending: 0 }), { timeout: 5_000 });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(remove.mock.calls.filter(([target]) => target === path)).toHaveLength(2);
    for (let index = 0; index < ATTACHMENT_MAX_COUNT; index++) await complete(store, next, `after-reset-${index}`);
    expect(store.debugCounts()).toMatchObject({ resources: ATTACHMENT_MAX_COUNT, attachments: ATTACHMENT_MAX_COUNT });
  }, 15_000);

  test("discard protects retained originals and expires cancellation tombstones with the lease", async () => {
    const { store, scope } = await setup();
    const retained = await complete(store, scope, "retained");
    const path = store.resolve(scope, [retained])[0].path;
    store.retain(scope, [retained]);
    expect(await store.discard(scope, retained)).toBe("retained");
    expect(await store.discard(scope, retained)).toBe("retained");
    expect(await readFile(path, "utf8")).toBe("test");
    const removed = await complete(store, scope, "removed");
    await store.discard(scope, removed);
    store.resetScope(scope.sessionId);
    const next = { ...scope, uploadScope: store.scopeFor(scope.sessionId) };
    await expect(store.discard(scope, removed)).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(store.discard(next, removed)).rejects.toMatchObject({ code: "not_found" });
    await expect(store.discard(next, retained)).rejects.toMatchObject({ code: "not_found" });
    expect(await readFile(path, "utf8")).toBe("test");
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
    expect((await stat(dirname(path))).isDirectory()).toBe(true);
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
    let path = "";
    const { store, scope } = await setup({ testHooks: {
      beforeWrite: blocked.block,
      createFile: async (filePath) => { path = filePath; return createPrivateFile(filePath); },
    } });
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
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
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
      let path = "";
      const hooks: AttachmentStoreTestHooks = {
        createFile: async (filePath) => { path = filePath; return createPrivateFile(filePath); },
        write: async (handle, bytes, position) => {
          await blocked.block();
          return (await handle.write(bytes, 0, bytes.length, position)).bytesWritten;
        },
      };
      const { store, scope } = await setup({ testHooks: hooks });
      await store.begin(scope, input("one"));
      const writing = store.write(scope, "one", 0, Buffer.from("test"));
      const failed = expect(writing).rejects.toMatchObject({ code: "invalid_scope" });
      await blocked.started;
      if (reset) store.resetScope("session");
      const disposing = store.dispose();
      const directory = dirname(path);
      expect((await readdir(directory)).length).toBe(1);
      blocked.release();
      await failed;
      await disposing;
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
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

  test("rejects pre-existing root, date, attachment and reservation symlinks without changing targets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 12));
    for (const target of ["root", "date", "attachment", "ledger"]) {
      const { root, rootDir, store, scope } = await setup();
      const outside = join(root, "outside");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(outside);
      if (target === "root") await symlink(outside, rootDir);
      else {
        await mkdir(rootDir);
        const date = localDateDirectory(new Date());
        const id = "11111111-1111-4111-8111-111111111111";
        const internal = target === "ledger" ? ".reservations" : target === "date" ? date : join(date, id);
        if (target === "attachment") {
          await mkdir(join(rootDir, date));
          vi.mocked(randomUUID).mockReturnValueOnce(id);
        }
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
