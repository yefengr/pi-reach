import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("公共规范纳入后续包制品，文档和消费示例使用同一确认顺序", () => {
  const manifest = JSON.parse(read("../package.json")) as { files: string[] };
  expect(manifest.files).toContain("DESIGN.md");
  const design = read("../DESIGN.md");
  const readme = read("../README.md");
  expect(design).toContain("桌面取消在左、确认在右；手机确认在上、取消在最下");
  expect(readme).toContain("[公共设计与交互规范](DESIGN.md)");
  expect(readme).toContain("{mobile ? [confirm, cancel] : [cancel, confirm]}");
  expect(design).toContain("自 `0.0.3` 随包分发");
  expect(design).toContain("`0.0.2` 不包含此文件");
});
