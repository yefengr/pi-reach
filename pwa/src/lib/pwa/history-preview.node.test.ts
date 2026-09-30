import { expect, test } from "vitest";
import { historyPreviewText } from "./history-preview";

test("removes heading, emphasis, and link syntax while keeping the label", () => {
  expect(historyPreviewText("截图 **标题** 与 [测试环境](https://example.test/path)"))
    .toBe("截图 标题 与 测试环境");
});

test("removes nested markers from a link title and ignores a parenthesized URL", () => {
  expect(historyPreviewText("查看 [**粗体 _标题_**](https://example.test/path_(v1))"))
    .toBe("查看 粗体 标题");
});

test("flattens heading, list, and blockquote lines", () => {
  expect(historyPreviewText("# 项目\n\n- 第一项\n- 第二项\n> 备注"))
    .toBe("项目 第一项 第二项 备注");
});

test("keeps Chinese text, code text, paths, underscores, and mathematical stars", () => {
  expect(historyPreviewText("中文 `snake_case`、路径 src/lib/foo_bar.ts、公式 2 * 3 = 6"))
    .toBe("中文 snake_case、路径 src/lib/foo_bar.ts、公式 2 * 3 = 6");
});

test("keeps fenced code text without its fence", () => {
  expect(historyPreviewText("示例:\n```ts\nconst snake_case = value * 2;\n```\n结束"))
    .toBe("示例: const snake_case = value * 2; 结束");
});

test("keeps an image alt label without its destination", () => {
  expect(historyPreviewText("![图片](https://example.test/image)"))
    .toBe("图片");
});

test.each(["", " \n\t", "**__~~###", "---", "![](https://example.test/image)"]) (
  "uses the fallback for empty or structure-only input: %s",
  (value) => {
    expect(historyPreviewText(value)).toBe("Saved conversation");
  },
);

test("keeps the label when the preview ends inside a link destination", () => {
  const truncated = `请打开 [部署文档](https://example.test/${"a".repeat(160)}`;
  expect(historyPreviewText(truncated)).toBe("请打开 部署文档");
});
