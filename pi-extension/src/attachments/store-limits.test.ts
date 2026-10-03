import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ATTACHMENT_MAX_COUNT } from "@pi-reach/protocol/session";
import { createPrivateFile } from "./safe-files.js";
import { AttachmentStore, type AttachmentScope, type AttachmentStoreTestHooks } from "./store.js";

const roots: string[] = [];
const stores: AttachmentStore[] = [];
const empty = (uploadId: string) => ({ uploadId, fileName: "empty", mimeType: "application/octet-stream",
  byteLength: 0, sha256: createHash("sha256").digest("hex") });

async function setup(testHooks: AttachmentStoreTestHooks = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-reach-limits-"));
  roots.push(root);
  const rootDir = join(root, "store");
  const store = new AttachmentStore({ rootDir, runtimeId: "limits-test", minFreeBytes: 2,
    testHooks: { availableBytes: () => 6n, ...testHooks } });
  stores.push(store);
  const scope: AttachmentScope = { ownerId: "owner", sessionId: "session", uploadScope: store.scopeFor("session") };
  return { store, scope, rootDir };
}

async function drained(store: AttachmentStore) {
  await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({ resources: 0, cleanups: 0, pending: 0 }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each(["ENOSPC", "EACCES"])("creation %s preserves sanitized error and releases reservation / active quota", async (code) => {
  let fail = true;
  const { store, scope, rootDir } = await setup({ createFile: async (path) => {
    if (fail) throw Object.assign(new Error(`sensitive ${path}`), { code });
    return createPrivateFile(path);
  } });
  for (let i = 0; i < ATTACHMENT_MAX_COUNT + 1; i++) {
    await expect(store.begin(scope, { ...empty(`failed-${i}`), byteLength: 4 })).rejects.toMatchObject({
      code: code === "ENOSPC" ? "no_space" : "io_error",
      message: `Attachment operation failed (${code === "ENOSPC" ? "no_space" : "io_error"}).`,
    });
    expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
    for (const name of (await readdir(rootDir)).filter((name) => name !== ".reservations")) {
      expect(await readdir(join(rootDir, name))).toEqual([]);
    }
  }
  await drained(store);
  expect(store.debugCounts().records).toBe(0);
  fail = false;
  await store.begin(scope, { ...empty("failed-0"), byteLength: 4 });
  await store.cancel(scope, "failed-0");
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
});

test("reservation failure loops never create ID directories", async () => {
  const { store, scope, rootDir } = await setup({ availableBytes: () => 0n });
  for (let i = 0; i < ATTACHMENT_MAX_COUNT + 1; i++) {
    await expect(store.begin(scope, empty(`reservation-${i}`))).rejects.toMatchObject({ code: "no_space" });
    expect(await readdir(rootDir)).toEqual([".reservations"]);
    expect(store.debugCounts().resources).toBe(0);
  }
});

test("cancel during reservation publication never creates an ID directory", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { store, scope, rootDir } = await setup({ availableBytes: async () => { entered(); await blocked; return 6n; } });
  const beginning = store.begin(scope, empty("publishing"));
  await started;
  const cancelled = store.cancel(scope, "publishing");
  release();
  expect((await beginning).status).toBe("cancelled");
  await cancelled;
  expect(await readdir(rootDir)).toEqual([".reservations"]);
  await drained(store);
});

test("exclusive collision never deletes someone else's path", async () => {
  let collisionPath = "";
  let collide = true;
  const { store, scope, rootDir } = await setup({ createFile: async (path) => {
    if (collide) { collisionPath = path; await writeFile(path, "other original"); }
    return createPrivateFile(path);
  } });
  await expect(store.begin(scope, empty("collision"))).rejects.toMatchObject({ code: "io_error" });
  expect(await readFile(collisionPath, "utf8")).toBe("other original");
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
  // 目录确为本次创建，但碰撞文件不归本次所有；非空目录失败须保留有界资源。
  expect(store.debugCounts().resources).toBe(1);
  await expect(store.cancel(scope, "collision")).rejects.toMatchObject({ code: "io_error" });
  collide = false;
  await store.begin(scope, empty("another-upload"));
  await store.cancel(scope, "another-upload");
  await expect(store.dispose()).rejects.toMatchObject({ code: "io_error" });
  stores.splice(stores.indexOf(store), 1);
  expect(store.debugCounts().resources).toBe(1);
  expect(await readFile(collisionPath, "utf8")).toBe("other original");
});

test.each(["stat", "initialization"])("post-creation %s failure closes handle, removes owned inode and credits", async (stage) => {
  let captured: FileHandle | undefined;
  let path = "";
  let fail = true;
  const hooks: AttachmentStoreTestHooks = {
    createFile: async (filePath) => {
      path = filePath;
      captured = await createPrivateFile(filePath);
      if (fail && stage === "stat") {
        vi.spyOn(captured, "stat").mockRejectedValueOnce(Object.assign(new Error("private stat"), { code: "EACCES" }));
      }
      return captured;
    },
    afterCreate: () => {
      if (fail && stage === "initialization") throw Object.assign(new Error("private initialization"), { code: "ENOSPC" });
    },
  };
  const { store, scope, rootDir } = await setup(hooks);
  await expect(store.begin(scope, empty("one"))).rejects.toMatchObject({ code: stage === "stat" ? "io_error" : "no_space" });
  expect(captured!.fd).toBe(-1);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
  fail = false;
  await store.begin(scope, empty("one"));
  await store.cancel(scope, "one");
});

test("missing original during cleanup still closes its handle and releases disk credits", async () => {
  let handle: FileHandle | undefined;
  let path = "";
  const { store, scope, rootDir } = await setup({ createFile: async (filePath) => {
    path = filePath; handle = await createPrivateFile(path); return handle;
  } });
  await store.begin(scope, { ...empty("one"), byteLength: 4 });
  await rm(path);
  await store.cancel(scope, "one");
  expect(handle!.fd).toBe(-1);
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
  await drained(store);
  await store.begin(scope, { ...empty("two"), byteLength: 4 });
});

test("unsafe replacement cleanup preserves the begin error and bounded failed resource while closing handles and releasing credits", async () => {
  let handle: FileHandle | undefined;
  let path = "";
  const { store, scope, rootDir } = await setup({
    createFile: async (filePath) => { path = filePath; return createPrivateFile(path); },
    afterCreate: async (created) => {
      handle = created;
      await rename(path, `${path}.owned`);
      await writeFile(path, "replacement original");
      throw Object.assign(new Error("private disk error"), { code: "ENOSPC" });
    },
  });
  await expect(store.begin(scope, empty("one"))).rejects.toMatchObject({
    code: "no_space", message: "Attachment operation failed (no_space).",
  });
  expect(handle!.fd).toBe(-1);
  expect(await readFile(path, "utf8")).toBe("replacement original");
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
  await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({
    cleanups: 0, pending: 0, resources: 1, records: 1,
  }));
  await expect(store.cancel(scope, "one")).rejects.toMatchObject({ code: "invalid_upload" });
  expect(await readFile(path, "utf8")).toBe("replacement original");
  expect(handle!.fd).toBe(-1);
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
  await vi.waitFor(() => expect(store.debugCounts()).toMatchObject({
    cleanups: 0, pending: 0, resources: 1, records: 1,
  }));
  await expect(store.dispose()).rejects.toMatchObject({ code: "invalid_upload" });
  stores.splice(stores.indexOf(store), 1);
});

test("unknown cancellation flood creates only bounded lightweight tombstones, never disk cleanup", async () => {
  const { store, scope, rootDir } = await setup({ metadataLimit: 32 });
  await Promise.all(Array.from({ length: 32 }, (_, i) => store.cancel(scope, `cancel-${i}`)));
  expect(store.debugCounts()).toEqual({ records: 32, attachments: 0, resources: 0, cleanups: 0, pending: 0 });
  await expect(stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.cancel(scope, "new")).rejects.toMatchObject({ code: "busy" });
  await expect(store.begin(scope, empty("new"))).rejects.toMatchObject({ code: "busy" });
  for (let i = 0; i < 32; i++) {
    expect((await store.begin(scope, empty(`cancel-${i}`))).status).toBe("cancelled");
    expect((await store.finish(scope, `cancel-${i}`)).status).toBe("cancelled");
  }
  expect((await store.cancel(scope, "cancel-0")).status).toBe("cancelled");
  store.resetScope("session");
  expect(store.debugCounts().records).toBe(0);
  await expect(store.begin(scope, empty("new"))).rejects.toMatchObject({ code: "invalid_scope" });
  await store.begin({ ...scope, uploadScope: store.scopeFor("session") }, empty("new"));
});

test("retain / tombstone / active share metadata budget; reset frees old records but preserves originals", async () => {
  const { store, scope, rootDir } = await setup({ metadataLimit: 6 });
  const paths: string[] = [];
  let current = scope;
  for (let round = 0; round < 4; round++) {
    await store.cancel(current, "unknown");
    for (let i = 0; i < 4; i++) {
      await store.begin(current, empty(`retained-${i}`));
      const done = await store.finish(current, `retained-${i}`);
      const id = done.attachment!.attachment_id;
      paths.push(store.resolve(current, [id])[0].path);
      store.retain(current, [id]);
    }
    await store.begin(current, empty("active"));
    await expect(store.begin(current, empty("new"))).rejects.toMatchObject({ code: "busy" });
    const other = { ...current, ownerId: "other-owner" };
    await expect(store.cancel(other, "new")).rejects.toMatchObject({ code: "busy" });
    expect((await store.status(current, "active")).status).toBe("receiving");
    expect((await store.begin(current, empty("unknown"))).status).toBe("cancelled");
    const old = current;
    store.resetScope("session");
    current = { ...scope, uploadScope: store.scopeFor("session") };
    expect(store.debugCounts()).toMatchObject({ records: 0, attachments: 0 });
    await expect(store.status(old, "active")).rejects.toMatchObject({ code: "invalid_scope" });
    await drained(store);
  }
  await store.dispose();
  expect(store.debugCounts()).toEqual({ records: 0, attachments: 0, resources: 0, cleanups: 0, pending: 0 });
  for (const path of paths) expect((await stat(path)).size).toBe(0);
  expect(await readdir(join(rootDir, ".reservations"))).toEqual([]);
});

test("real cancellation flood deduplicates cleanup; old-scope work bounds admission until drained", async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { store, scope } = await setup({ beforeWrite: async () => { entered(); await blocked; } });
  await store.begin(scope, { ...empty("active"), byteLength: 4 });
  const writing = store.write(scope, "active", 0, Buffer.from("test"));
  const failed = expect(writing).rejects.toMatchObject({ code: "invalid_scope" });
  await started;
  const cancellations = Array.from({ length: 1000 }, () => store.cancel(scope, "active"));
  const observed = cancellations.map((promise) => expect(promise).rejects.toMatchObject({ code: "invalid_scope" }));
  expect(store.debugCounts()).toMatchObject({ resources: 1, cleanups: 1, pending: 2 });
  store.resetScope("session");
  let current = { ...scope, uploadScope: store.scopeFor("session") };
  for (let i = 0; i < ATTACHMENT_MAX_COUNT - 1; i++) await store.begin(current, empty(`queued-${i}`));
  await expect(store.begin(current, empty("owner-over"))).rejects.toMatchObject({ code: "too_large" });
  // 不等待旧操作释放，多次切换也不能绕过全局资源上限。
  current = { ...current, ownerId: "other-owner" };
  for (let i = 0; i < ATTACHMENT_MAX_COUNT; i++) await store.begin(current, empty(`other-${i}`));
  await expect(store.begin({ ...current, ownerId: "third-owner" }, empty("global-over")))
    .rejects.toMatchObject({ code: "busy" });
  store.resetScope("session");
  release();
  await failed;
  await Promise.all(observed);
  await drained(store);
  current = { ...scope, uploadScope: store.scopeFor("session") };
  await store.begin(current, empty("recovered"));
});
