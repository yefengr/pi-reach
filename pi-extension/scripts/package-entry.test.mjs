import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));

test("Pi uses a published root index entry without changing the existing module and type entries", () => {
  assert.deepEqual(pkg.pi.extensions, ["./index.js"]);
  assert.ok(pkg.files.includes("index.js"), "根入口必须包含在 npm 包中");
  assert.ok(pkg.files.includes("dist"), "编译产物必须包含在 npm 包中");
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.types, "dist/index.d.ts");
});

test("the published root entry forwards the compiled factory without wrapping or invoking it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reach-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: pkg.type }));
  await copyFile(new URL("index.js", packageRoot), join(root, "index.js"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/index.js"), [
    "export let calls = 0;",
    "export default function factory(api) { calls += 1; return api; }",
  ].join("\n"));

  const entry = await import(pathToFileURL(join(root, pkg.pi.extensions[0])).href);
  const compiled = await import(pathToFileURL(join(root, pkg.main)).href);
  assert.equal(typeof entry.default, "function");
  assert.equal(entry.default, compiled.default);
  assert.equal(compiled.calls, 0, "导入根入口不得执行扩展工厂");
  const api = {};
  assert.equal(entry.default(api), api);
  assert.equal(compiled.calls, 1);
});
