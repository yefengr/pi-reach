import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { closeStreamingInline, rehypeStreamReveal, splitMarkdownChunks } from "./markdown-stream";

const remarkPlugins = [remarkGfm];

function render(text: string, marks: readonly number[] = [], base = 0): string {
  const rehypePlugins = marks.length ? [[rehypeStreamReveal, { source: text, base, marks }] as const] : [];
  return renderToStaticMarkup(<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never}>{text}</ReactMarkdown>);
}

const SAMPLES = [
  "十一、关于演进中的兼容性成本\n\n兼容性不是免费的。\n\n## 小节\n\n正文第二段，含 **加粗** 与 `代码`。\n\n---\n\n结尾。",
  "列表前\n\n- 一\n- 二\n\n- 松散项\n\n  续行段落\n\n列表后段落",
  "1. 第一\n\n2. 第二\n\n3) 第三\n\n后文",
  "围栏前\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n围栏后\n\n~~~\n\n未闭合的围栏\n\n继续",
  "> 引用一\n\n> 引用二\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n表格后",
  "缩进代码前\n\n    indented\n\n    still code\n\n后文",
  "参考 [链接][x]\n\n[x]: https://example.com\n\n脚注[^1]\n\n[^1]: 说明",
  "*强调开头的段落*\n\n* 列表项\n\n__粗体__ 结尾",
  "注释前\n\n<!--\n\n# example\n\n[链接](https://example.com)\n\n-->\n\n注释后",
  "<pre>\nline\n\n# not heading\n\n</pre>\n\n后文\n\n<script>\n\n- a\n\n</script>\n\n<style>\n\n> q\n\n</style>",
  "<?php\n\n# x\n\n?>\n\n<!DOCTYPE\n\n# y\n\n>\n\n<![CDATA[\n\n# z\n\n]]>\n\n后文",
  "<!-- 单行注释 -->\n\n# 标题\n\n<div>\n\n**粗体**\n\n</div>",
  "```\n<!--\n```\n\n围栏后的段落\n\n<!--\n\n未闭合注释\n\n继续",
];

test.each(SAMPLES)("chunks render the same DOM as the whole text: %#", (text) => {
  const chunks = splitMarkdownChunks(text);
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  for (const chunk of chunks) expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
  // MarkdownContent 在相邻块之间补同样的换行文本节点，DOM 与整体解析逐字一致。
  expect(chunks.map((chunk) => render(chunk.text)).join("\n")).toBe(render(text));
});

test("splits only between independent blocks and never inside fences, lists or cross-block references", () => {
  expect(splitMarkdownChunks("一段\n\n二段\n\n## 标题\n\n三段").map((chunk) => chunk.text)).toEqual(["一段\n\n", "二段\n\n", "## 标题\n\n", "三段"]);
  expect(splitMarkdownChunks("```\na\n\nb\n```")).toHaveLength(1);
  expect(splitMarkdownChunks("- a\n\n- b\n\n  c")).toHaveLength(1);
  expect(splitMarkdownChunks("见[^1]\n\n[^1]: 注")).toHaveLength(1);
  // 流式中尚未闭合的围栏之后不切分，闭合后恢复。
  expect(splitMarkdownChunks("前\n\n```\ncode\n\nmore")).toHaveLength(2);
  expect(splitMarkdownChunks("前\n\n```\ncode\n```\n\n后")).toHaveLength(3);
  expect(splitMarkdownChunks("<!--\n\n# example\n\n-->")).toHaveLength(1);
  expect(splitMarkdownChunks("前\n\n<!-- a -->\n\n后")).toHaveLength(3);
  expect(splitMarkdownChunks("<pre>\n\nx\n\n</pre>\n\n后")).toHaveLength(2);
});

test("reveal wraps only newly shown text and keeps text content and code blocks intact", () => {
  const text = "Hello **world** and more\n\n```\ncode block\n```";
  const html = render(text, [10, 20]);
  expect(html).toContain('<strong>wo<span class="pwa-stream-reveal" data-reveal-offset="10">rld</span></strong>');
  expect(html).toContain('<span class="pwa-stream-reveal" data-reveal-offset="10"> and </span><span class="pwa-stream-reveal" data-reveal-offset="20">more</span>');
  expect(html).not.toContain('data-reveal-offset="20">code');
  expect(html.replace(/<[^>]+>/g, "")).toBe(render(text).replace(/<[^>]+>/g, ""));
  // 文字前段沿用之前的标记；块起点偏移按整段正文计算。
  expect(render("tail text", [3], 10)).toBe('<p><span class="pwa-stream-reveal" data-reveal-offset="3">tail text</span></p>');
  // 含转义的文本节点无法逐字对应：节点起点已显示时不包装，避免已显示文字重新淡入。
  expect(render("a \\*b\\* c", [0])).toContain('data-reveal-offset="0"');
  expect(render("a \\*b\\* c", [4])).not.toContain("data-reveal-offset");
  expect(render("plain", [])).toBe("<p>plain</p>");
});

test.each([
  ["**内容核验", "**内容核验**"],
  // 收尾标记只到了一半：只补一个字符，不留下字面量星号。
  ["**内容核验*", "**内容核验**"],
  ["前文 ~~删除", "前文 ~~删除~~"],
  ["**粗体与 ~~删除", "**粗体与 ~~删除~~**"],
  ["运行 `pnpm", "运行 `pnpm`"],
  ["`**` 不是加粗", "`**` 不是加粗"],
  ["完整 **粗体** 正文", "完整 **粗体** 正文"],
  ["看 [文档](https://exa", "看 "],
  ["已开始 **", "已开始 "],
  ["尾随空白 **粗体 ", "尾随空白 **粗体**"],
  ["```\n**代码", "```\n**代码"],
  ["第一段 **未闭合\n\n第二段", "第一段 **未闭合\n\n第二段"],
] as const)("streaming inline closing: %s", (input, expected) => {
  expect(closeStreamingInline(input)).toBe(expected);
});

test("streaming closing only appends or trims the end so reveal offsets stay aligned", () => {
  const text = "已完成的正文，**加粗中";
  const closed = closeStreamingInline(text);
  expect(closed.startsWith(text)).toBe(true);
  const html = render(closed, [text.indexOf("加粗")]);
  expect(html).toContain("<strong>");
  expect(html).toContain('data-reveal-offset="');
  expect(html).not.toContain("**");
});
