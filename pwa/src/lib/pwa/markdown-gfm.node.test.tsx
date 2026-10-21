import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, test } from "vitest";
import { FileTextContent } from "../../components/pwa/file-text-content";

const requireFromTest = createRequire(import.meta.url);

function markdown(lines: string[]): string {
  return lines.join("\n");
}

function readAlign(props: { align?: unknown; style?: unknown }): string {
  if (typeof props.align === "string") return props.align;
  const style = props.style;
  if (style && typeof style === "object" && "textAlign" in style) {
    const value = (style as { textAlign?: unknown }).textAlign;
    if (typeof value === "string") return value;
  }
  return "";
}

// 把对齐信息暴露成 data 属性，避免断言依赖 Markdown 渲染器的内部 props 传递细节。
const alignComponents: Components = {
  th: (props) => <th data-align={readAlign(props)}>{props.children}</th>,
  td: (props) => <td data-align={readAlign(props)}>{props.children}</td>,
};

function renderMarkdown(source: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={alignComponents}>{source}</ReactMarkdown>,
  );
}

function matchAll(html: string, pattern: RegExp): string[] {
  return Array.from(html.matchAll(pattern), (match) => match[1] ?? "");
}

function cellTexts(html: string): string[] {
  return matchAll(html, /<t(?:h|d)(?:\s[^>]*)?>(.*?)<\/t(?:h|d)>/g);
}

function packageDir(entryPath: string): string {
  let current = path.dirname(entryPath);
  for (;;) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name !== "") return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`无法定位包目录：${entryPath}`);
    current = parent;
  }
}

/**
 * 通过真实依赖链定位 GFM 表格的 EditMap 实现。
 * 包未导出 `lib/edit-map.js`，因此先解析包入口再拼内部路径；布局或名称变化时显式失败。
 */
function locateEditMapPath(): string {
  const remarkGfmDir = packageDir(requireFromTest.resolve("remark-gfm"));
  const remarkGfmRequire = createRequire(path.join(remarkGfmDir, "package.json"));
  const micromarkGfmDir = packageDir(remarkGfmRequire.resolve("micromark-extension-gfm"));
  const micromarkGfmRequire = createRequire(path.join(micromarkGfmDir, "package.json"));
  const tableDir = packageDir(micromarkGfmRequire.resolve("micromark-extension-gfm-table"));
  const editMapPath = path.join(tableDir, "lib", "edit-map.js");
  if (!existsSync(editMapPath)) {
    throw new Error(`micromark-extension-gfm-table 布局变化，未找到 ${editMapPath}`);
  }
  return editMapPath;
}

type TableEvent = { type: string };
type Change = [at: number, remove: number, add: TableEvent[]];
type EditMapInstance = {
  map: Change[];
  add(at: number, remove: number, add: TableEvent[]): void;
  consume(events: TableEvent[]): void;
};
type EditMapClass = new () => EditMapInstance;

async function loadEditMapClass(): Promise<EditMapClass> {
  const module: unknown = await import(/* @vite-ignore */ pathToFileURL(locateEditMapPath()).href);
  const candidate = module as { EditMap?: EditMapClass };
  if (typeof candidate.EditMap !== "function") {
    throw new Error("micromark-extension-gfm-table 未导出 EditMap，布局已变化");
  }
  return candidate.EditMap;
}

function event(type: string): TableEvent {
  return { type };
}

function types(events: TableEvent[]): string[] {
  return events.map((item) => item.type);
}

/** 统计 add() 对内部 map 数组的数字下标读取次数；数组本身与方法调用保持真实。 */
function countMapIndexReads(editMap: EditMapInstance): { reads: number } {
  if (!Array.isArray(editMap.map)) {
    throw new Error("EditMap.map 不是数组，内部结构已变化");
  }
  const counter = { reads: 0 };
  editMap.map = new Proxy(editMap.map, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) counter.reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return counter;
}

describe("GFM 表格编辑累积保持线性", () => {
  test("数百个唯一位置的 add 不随已记录编辑数二次扫描", async () => {
    const EditMap = await loadEditMapClass();
    const editMap = new EditMap();
    const counter = countMapIndexReads(editMap);
    const positionCount = 300;
    for (let index = 0; index < positionCount; index += 1) {
      editMap.add(index * 2, 0, [event(`insert-${index}`)]);
    }
    const budget = positionCount * 2;
    expect(
      counter.reads,
      `add 读取 map 数字下标 ${counter.reads} 次，线性预算 ${budget} 次（旧实现为 N(N-1)/2）`,
    ).toBeLessThanOrEqual(budget);
  });

  test("同位置编辑累积 remove 计数并保留 add 顺序", async () => {
    const EditMap = await loadEditMapClass();
    const editMap = new EditMap();
    const events = [event("a"), event("b"), event("c")];
    const originalEvents = events;
    editMap.add(1, 0, [event("X")]);
    editMap.add(1, 0, [event("Y")]);
    editMap.add(1, 1, []);
    editMap.consume(events);
    expect(events).toBe(originalEvents);
    expect(types(events)).toEqual(["a", "X", "Y", "c"]);
  });

  test("consume 清空后可以继续累积，空编辑不产生副作用", async () => {
    const EditMap = await loadEditMapClass();
    const editMap = new EditMap();
    const first = [event("0"), event("1")];
    editMap.add(1, 1, [event("X")]);
    editMap.consume(first);
    expect(types(first)).toEqual(["0", "X"]);

    const untouched = [event("p"), event("q")];
    editMap.consume(untouched);
    expect(types(untouched)).toEqual(["p", "q"]);

    editMap.add(0, 0, []);
    expect(editMap.map.length).toBe(0);

    const second = [event("m"), event("n")];
    editMap.add(1, 0, [event("Z")]);
    editMap.consume(second);
    expect(types(second)).toEqual(["m", "Z", "n"]);
  });
});

describe("GFM 表格语义", () => {
  test("列对齐保留左中右", () => {
    const html = renderMarkdown(markdown([
      "| 左 | 中 | 右 |",
      "| :--- | :---: | ---: |",
      "| a | b | c |",
    ]));
    expect(html).toContain("<table>");
    expect(matchAll(html, /<th data-align="([^"]*)"/g)).toEqual(["left", "center", "right"]);
    expect(matchAll(html, /<td data-align="([^"]*)"/g)).toEqual(["left", "center", "right"]);
  });

  test("转义管道、行内代码与 Unicode 不破坏单元格", () => {
    const html = renderMarkdown(markdown([
      "| 语法 | 说明 |",
      "| --- | --- |",
      "| a \\| b | `code` |",
      "| 中文🙂 | naïve |",
    ]));
    expect(cellTexts(html)).toEqual(["语法", "说明", "a | b", "<code>code</code>", "中文🙂", "naïve"]);
  });

  test("表格后的引用定义仍然解析", () => {
    const html = renderMarkdown(markdown([
      "| 选项 | 链接 |",
      "| --- | --- |",
      "| 引用 | [文档][ref] |",
      "",
      "[ref]: https://example.test/doc",
    ]));
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.test/doc"');
    expect(html).toContain("文档");
  });

  test("表格前后的列表与围栏代码块保持独立", () => {
    const html = renderMarkdown(markdown([
      "- 列表项",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ]));
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain("const value = 1;");
    expect(html.indexOf("<ul>")).toBeLessThan(html.indexOf("<table>"));
    expect(html.indexOf("<table>")).toBeLessThan(html.indexOf("<pre>"));
  });

  test("缺少分隔行不构成表格", () => {
    const html = renderMarkdown(markdown([
      "| A | B |",
      "| 1 | 2 |",
    ]));
    expect(html).not.toContain("<table");
  });

  test("缺失单元格补齐，多余单元格丢弃", () => {
    const html = renderMarkdown(markdown([
      "| A | B | C |",
      "| --- | --- | --- |",
      "| 只有 |",
      "| 1 | 2 | 3 | 4 |",
    ]));
    expect(cellTexts(html)).toEqual(["A", "B", "C", "只有", "", "", "1", "2", "3"]);
    expect(html).not.toContain(">4<");
  });

  test("长表保序且重复解析结果一致", () => {
    const rows = Array.from({ length: 120 }, (_, index) => `| row-${String(index).padStart(3, "0")} | 值-${index} |`);
    const source = markdown(["| 键 | 值 |", "| --- | --- |", ...rows]);
    const first = renderMarkdown(source);
    const second = renderMarkdown(source);
    expect(first).toBe(second);
    expect(matchAll(first, /row-(\d{3})/g).map(Number)).toEqual(
      Array.from({ length: 120 }, (_, index) => index),
    );
  });
});

describe("文件 Markdown 表格沿用安全策略", () => {
  test("保留表格并使用安全链接与图片降级", () => {
    const html = renderToStaticMarkup(<FileTextContent
      markdown
      text={markdown([
        "| 链接 | 图片 |",
        "| --- | --- |",
        "| [文档](https://example.test/doc) | ![remote](https://remote.test/a.png) |",
      ])}
    />);
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.test/doc"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("remote");
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toContain("remote.test");
  });
});
