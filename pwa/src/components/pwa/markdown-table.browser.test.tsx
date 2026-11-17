import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { resetTouch } from "@/test/browser/swipe";
import { FileTextContent } from "./file-text-content";
import { MarkdownContent } from "./timeline-content";

type Source = "chat" | "file";

/** 说明列足够长，任何常见列数下都会超过两行，用于验证完整展开而不是被加宽到两行。 */
const chineseDetail = "用于检查普通表格在窄屏下的完整换行，不截断内容，也不强制两行；说明较长时仍优先适配容器宽度。";
const englishDetail = "A detailed note that wraps across several lines without clipping any words inside the reading column.";
const chineseHeaders = ["状态", "名称", "说明", "负责人", "更新时间"];
const chineseValues = ["完成", "阅读", chineseDetail, "维护者", "昨天"];
const englishHeaders = ["Name", "State", "Note", "Team", "Total"];
const englishValues = ["alpha", "ready", englishDetail, "search", "42"];
const alignments = ["---", ":---:", "---", "---", "---:"];

function markdownTable(headers: string[], values: string[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${alignments.slice(0, headers.length).join(" | ")} |`,
    `| ${values.join(" | ")} |`,
  ].join("\n");
}
const chineseTable = (columns: number) => markdownTable(chineseHeaders.slice(0, columns), chineseValues.slice(0, columns));
const englishTable = (columns: number) => markdownTable(englishHeaders.slice(0, columns), englishValues.slice(0, columns));
/** 多列表格：每列都窄，列数足够多时只能由外层横向滚动。 */
function matrixTable(columns: number, extra = ""): string {
  const headers = Array.from({ length: columns }, (_, index) => `列 ${index + 1}`);
  const values = Array.from({ length: columns }, (_, index) => index === 1 && extra ? extra : `值 ${index + 1}`);
  return [headers, headers.map(() => "---"), values].map(row => `| ${row.join(" | ")} |`).join("\n");
}

function SourceContent({ source, text }: { source: Source; text: string }) {
  return source === "chat" ? <MarkdownContent text={text} /> : <FileTextContent markdown text={text} />;
}
function table(): HTMLTableElement { return document.querySelector<HTMLTableElement>(".pwa-markdown table")!; }
function wrapper(): HTMLElement { return document.querySelector<HTMLElement>(".pwa-markdown-table")!; }
function cells(): HTMLElement[] { return [...document.querySelectorAll<HTMLElement>(".pwa-markdown-cell")]; }
function lineHeight(element: HTMLElement): number { return Number.parseFloat(getComputedStyle(element).lineHeight); }
function height(element: HTMLElement): number { return Math.round(element.getBoundingClientRect().height); }
function expectUnclipped() {
  for (const cell of cells()) {
    expect(cell.scrollHeight, cell.textContent ?? "").toBeLessThanOrEqual(cell.clientHeight);
    expect(cell.scrollWidth, cell.textContent ?? "").toBeLessThanOrEqual(cell.clientWidth);
  }
}
afterEach(async () => {
  await resetTouch();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

const fitCases: { source: Source; width: 320 | 390; columns: 3 | 4 | 5; language: "中文" | "英文" }[] = [
  { source: "chat", width: 390, columns: 3, language: "中文" },
  { source: "file", width: 390, columns: 3, language: "英文" },
  { source: "chat", width: 390, columns: 4, language: "中文" },
  { source: "file", width: 390, columns: 4, language: "英文" },
  { source: "chat", width: 390, columns: 5, language: "中文" },
  { source: "file", width: 390, columns: 5, language: "英文" },
  { source: "chat", width: 320, columns: 3, language: "中文" },
  { source: "file", width: 320, columns: 3, language: "英文" },
];

test.each(fitCases)("$source $width px：$language $columns 列表格完整换行且不横滚", async ({ source, width, columns, language }) => {
  await page.viewport(width, 800);
  const container = width - 32;
  const text = language === "中文" ? chineseTable(columns) : englishTable(columns);
  await renderPwa(<div style={{ width: container }}><SourceContent source={source} text={text} /></div>);
  await expect.poll(() => cells().length).toBe(columns * 2);

  const box = wrapper();
  expect(box.clientWidth).toBe(container);
  expect(box.scrollWidth - box.clientWidth).toBeLessThanOrEqual(1);
  const tableWidth = Math.round(table().getBoundingClientRect().width);
  expect(tableWidth).toBeGreaterThanOrEqual(container - 1);
  expect(tableWidth).toBeLessThanOrEqual(container + 1);
  const fontSize = Number.parseFloat(getComputedStyle(cells()[0]!).fontSize);
  for (const cell of cells()) expect(Math.round(cell.getBoundingClientRect().width)).toBeGreaterThanOrEqual(Math.round(fontSize * 2));

  const detail = cells()[columns + 2]!;
  expect(detail.textContent).toContain(language === "中文" ? "完整换行" : "without clipping");
  expect(height(detail)).toBeGreaterThan(Math.round(lineHeight(detail) * 2));
  expectUnclipped();
});

test("GFM 对齐、发丝格线与单元格内边距保持不变", async () => {
  await renderPwa(<div style={{ width: 358 }}><MarkdownContent text={chineseTable(5)} /></div>);
  await expect.poll(() => cells().length).toBe(10);
  const styles = getComputedStyle(table());
  expect(styles.borderCollapse).toBe("separate");
  expect(styles.borderSpacing).toMatch(/^0px( 0px)?$/);
  const headers = [...document.querySelectorAll<HTMLElement>("th")];
  expect(headers[1]!.style.textAlign).toBe("center");
  expect(document.querySelectorAll<HTMLElement>("td")[4]!.style.textAlign).toBe("right");
  for (const element of [...headers, ...document.querySelectorAll<HTMLElement>("td")]) {
    const cellStyle = getComputedStyle(element);
    expect(cellStyle.verticalAlign).toBe("top");
    expect(cellStyle.borderBottomStyle).toBe("solid");
    expect(Number.parseFloat(cellStyle.borderBottomWidth)).toBeGreaterThan(0);
    expect(cellStyle.paddingTop).toBe("6px");
    expect(cellStyle.paddingLeft).toBe("8px");
    expect(cellStyle.paddingRight).toBe("8px");
  }
});

test("多列表格由外层横滚，内容增长与容器变窄保留同一 DOM 和滚动位置", async () => {
  await page.viewport(390, 800);
  let update!: (next: { text?: string; width?: number }) => void;
  function Harness() {
    const [state, setState] = useState({ text: matrixTable(12), width: 358 });
    useLayoutEffect(() => { update = next => setState(previous => ({ ...previous, ...next })); }, []);
    return <div style={{ width: state.width }}><MarkdownContent text={state.text} /></div>;
  }
  await renderPwa(<Harness />);
  await expect.poll(() => cells().length).toBe(24);

  const box = wrapper();
  const rendered = table();
  expect(box.clientWidth).toBe(358);
  expect(box.scrollWidth).toBeGreaterThan(box.clientWidth + 100);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  box.scrollLeft = 120;
  await expect.poll(() => box.scrollLeft).toBe(120);
  for (const cell of cells()) expect(cell.hasAttribute("style")).toBe(false);

  // 内容不变的重渲染：表格与滚动容器不重建，也不写入新的内联宽度。
  flushSync(() => update({ text: matrixTable(12) + "\n\n新增段落。" }));
  await expect.poll(() => document.querySelectorAll(".pwa-markdown p").length).toBe(1);
  expect(wrapper()).toBe(box);
  expect(table()).toBe(rendered);
  expect(box.scrollLeft).toBe(120);
  for (const cell of cells()) expect(cell.hasAttribute("style")).toBe(false);

  // 单元格内容变长仍复用同一表格，已横滚位置不会被重置。
  flushSync(() => update({ text: matrixTable(12, "增长后的单元格内容仍然完整显示，不截断也不写入内联宽度。") }));
  await expect.poll(() => cells()[13]!.textContent).toContain("增长后的单元格内容");
  expect(wrapper()).toBe(box);
  expect(table()).toBe(rendered);
  expect(box.scrollLeft).toBe(120);
  for (const cell of cells()) expect(cell.hasAttribute("style")).toBe(false);

  // 可用宽度变窄（对应手机视口切换）后仍是同一个表格和滚动位置。
  await page.viewport(320, 800);
  flushSync(() => update({ width: 288 }));
  await expect.poll(() => box.clientWidth).toBe(288);
  expect(wrapper()).toBe(box);
  expect(table()).toBe(rendered);
  expect(box.scrollLeft).toBe(120);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  expectUnclipped();
});

test("长不可断标识符撑开表格并保持单行，正文不横溢", async () => {
  await page.viewport(390, 800);
  const identifier = `log_${"x".repeat(96)}`;
  const text = `| 名称 | 标识 | 状态 |\n| --- | --- | --- |\n| 定位 | ${identifier} | 完成 |`;
  await renderPwa(<div style={{ width: 358 }}><MarkdownContent text={text} /></div>);
  await expect.poll(() => cells().length).toBe(6);

  const box = wrapper();
  expect(box.clientWidth).toBe(358);
  expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
  expect(table().getBoundingClientRect().width).toBeGreaterThan(358);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  const identifierCell = cells()[4]!;
  expect(identifierCell.textContent).toBe(identifier);
  expect(height(identifierCell)).toBe(Math.round(lineHeight(identifierCell)));
  expectUnclipped();
});

test("短表格在桌面宽度下仍按容器排布且不滚动", async () => {
  await renderPwa(<div style={{ width: 760 }}><MarkdownContent text={"| Item | Result |\n| --- | --- |\n| first | ready |"} /></div>);
  const box = wrapper();
  await expect.poll(() => cells().length).toBe(4);
  expect(box.scrollWidth).toBe(box.clientWidth);
  expect(Math.round(table().getBoundingClientRect().width)).toBe(760);
  for (const cell of cells()) expect(height(cell)).toBe(Math.round(lineHeight(cell)));
});

test("触控基准下表格沿用正文的触控字号", async () => {
  await page.viewport(390, 800);
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await renderPwa(<div style={{ width: 358 }}><MarkdownContent text={chineseTable(3)} /></div>);
  await expect.poll(() => cells().length).toBe(6);
  await expect.poll(() => matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(Number.parseFloat(getComputedStyle(cells()[0]!).fontSize)).toBe(17);
  expect(wrapper().scrollWidth - wrapper().clientWidth).toBeLessThanOrEqual(1);
});
