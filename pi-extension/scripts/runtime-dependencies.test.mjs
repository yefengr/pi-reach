import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("publish_file schema library is included in production dependencies", () => {
  // publish-tool 的 Type.Object 在模块加载时执行，不能依赖开发包或 SDK 的传递依赖。
  assert.equal(typeof pkg.dependencies?.typebox, "string");
  assert.ok(pkg.dependencies.typebox.length > 0);
  assert.equal(pkg.devDependencies?.typebox, undefined);
});
