import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { vendorProtocol } from "./vendor-protocol.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-reach-vendor-"));
  const paths = { extensionDist: join(root, "extension/dist"), protocolDist: join(root, "protocol/dist") };
  const put = async (path, value) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, value); };
  try {
    await put(join(root, "package.json"), '{"type":"module"}');
    await put(join(paths.extensionDist, "index.js"), 'export { value } from "@pi-reach/protocol/session";');
    await put(join(paths.extensionDist, "nested/schema.d.ts"), 'export type Value = import("@pi-reach/protocol/session").Value;');
    await put(join(paths.extensionDist, "nested/outer.js"), 'export * from "@pi-reach/protocol/outer";');
    await put(join(paths.extensionDist, "vendor/protocol/stale.js"), 'old');
    for (const entry of ["outer", "session"]) {
      await put(join(paths.protocolDist, entry, "index.js"), 'export { value } from "../common.js";');
      await put(join(paths.protocolDist, entry, "index.d.ts"), 'export type Value = string;');
    }
    await put(join(paths.protocolDist, "common.js"), 'export const value = "shared";');
    await run(paths, put);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("vendors runnable modules and declarations, preserves dependency imports, and is idempotent", () => fixture(async (paths, put) => {
  const path = join(paths.extensionDist, "nested/outer.js");
  await put(path, [
    'export * from "@pi-reach/protocol/outer";',
    '// import("@pi-reach/protocol/not-an-entry")',
    'const text = "@pi-reach/protocol/session";',
    'export const load = () => import("@pi-reach/protocol/session");',
  ].join("\n"));
  await put(join(paths.protocolDist, "dependency.d.ts"), 'export { z } from "zod";');
  const result = await vendorProtocol(paths);
  assert.equal(result.rewrittenFiles.length, 3);
  assert.equal((await import(pathToFileURL(join(paths.extensionDist, "index.js")).href)).value, "shared");
  const outer = await import(pathToFileURL(path).href);
  assert.equal((await outer.load()).value, "shared");
  assert.match(await readFile(path, "utf8"), /const text = "@pi-reach\/protocol\/session"/);
  assert.match(await readFile(join(paths.extensionDist, "nested/schema.d.ts"), "utf8"), /import\("\.\.\/vendor\/protocol\/session\/index\.js"\)/);
  assert.equal(await readFile(join(result.vendorProtocolDirectory, "dependency.d.ts"), "utf8"), 'export { z } from "zod";');
  await assert.rejects(readFile(join(result.vendorProtocolDirectory, "stale.js")), { code: "ENOENT" });
  assert.deepEqual((await vendorProtocol(paths)).rewrittenFiles, []);
}));

test("unknown package entry fails before changing existing output", () => fixture(async (paths, put) => {
  await put(join(paths.extensionDist, "unsupported.js"), 'export * from "@pi-reach/protocol/internal";');
  await assert.rejects(vendorProtocol(paths), /Unknown protocol entry/);
  assert.equal(await readFile(join(paths.extensionDist, "vendor/protocol/stale.js"), "utf8"), "old");
  assert.match(await readFile(join(paths.extensionDist, "index.js"), "utf8"), /@pi-reach\/protocol/);
}));

test("missing declarations fail without deleting the old vendor output", () => fixture(async (paths) => {
  await rm(join(paths.protocolDist, "session/index.d.ts"));
  await assert.rejects(vendorProtocol(paths), /Missing protocol build entry/);
  assert.equal(await readFile(join(paths.extensionDist, "vendor/protocol/stale.js"), "utf8"), "old");
}));

test("rejects source and test files in shared build output", () => fixture(async (paths, put) => {
  const path = join(paths.protocolDist, "unexpected.test.js");
  await put(path, "test");
  await assert.rejects(vendorProtocol(paths), /Unexpected protocol build file/);
  await rm(path);
  await put(join(paths.protocolDist, "source.ts"), "export const value = 1;");
  await assert.rejects(vendorProtocol(paths), /Unexpected protocol build file/);
}));

test("rejects overlapping directories and symlinked output parents", () => fixture(async (paths) => {
  await assert.rejects(vendorProtocol({ ...paths, protocolDist: paths.extensionDist }), /must not overlap/);
  await rm(join(paths.extensionDist, "vendor"), { recursive: true });
  await symlink(paths.protocolDist, join(paths.extensionDist, "vendor"), "dir");
  await assert.rejects(vendorProtocol(paths), /must not contain symbolic links/);
  assert.equal(await readFile(join(paths.protocolDist, "common.js"), "utf8"), 'export const value = "shared";');
}));
