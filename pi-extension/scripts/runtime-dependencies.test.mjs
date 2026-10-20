import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Pi 把宿主提供包注入扩展模块解析，物理副本可能绕过该映射并产生重复 runtime 模块。
// 见 @earendil-works/pi-coding-agent 的 docs/packages.md。
const HOST_PROVIDED_PACKAGES = ["typebox"];

test("host-provided packages are peer dependencies with a wildcard range", () => {
  for (const name of HOST_PROVIDED_PACKAGES) {
    assert.equal(pkg.peerDependencies?.[name], "*", `${name} 必须以 "*" 声明在 peerDependencies`);
    assert.equal(pkg.dependencies?.[name], undefined, `${name} 不得出现在 dependencies`);
  }
});

test("host-provided packages stay installable for local typecheck and tests", () => {
  // publish-tool 的 Type.Object 在模块加载时执行，本地编译与测试不能依赖 SDK 的传递依赖。
  for (const name of HOST_PROVIDED_PACKAGES) {
    assert.equal(typeof pkg.devDependencies?.[name], "string", `${name} 必须声明在 devDependencies`);
  }
});
