import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
import { FileTextContent } from "./file-text-content";
import { MarkdownContent } from "./timeline-content";

const longCell = "A long table cell sentence that keeps going ".repeat(6);
const columns = ["Name", "Status", "Detail", "Owner", "Note"];
function table(detail: string) {
  return [`| ${columns.join(" | ")} |`, "| --- | :---: | --- | --- | ---: |", `| first | ready | ${detail} | team | 42 |`].join("\n");
}

function cells(): HTMLElement[] { return [...document.querySelectorAll<HTMLElement>(".pwa-markdown-cell")]; }
function lineHeight(element: HTMLElement): number { return Number.parseFloat(getComputedStyle(element).lineHeight); }
function height(element: HTMLElement): number { return Math.round(element.getBoundingClientRect().height); }
function expectTwoLinesWithoutClipping() {
  for (const cell of cells()) {
    expect(height(cell)).toBeLessThanOrEqual(Math.round(lineHeight(cell) * 2));
    expect(cell.scrollHeight).toBeLessThanOrEqual(cell.clientHeight);
    expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth);
  }
}
afterEach(async () => { await page.viewport(1280, 900); });

test.each(["chat", "file"])("%s table cells widen to at most two unclipped lines and scroll horizontally at 390px", async (source) => {
  await page.viewport(390, 800);
  const text = table(longCell);
  await renderPwa(<div style={{ width: 358 }}>{source === "chat" ? <MarkdownContent text={text} /> : <FileTextContent markdown text={text} />}</div>);
  const wrapper = document.querySelector<HTMLElement>(".pwa-markdown-table")!;
  await expect.poll(() => cells().length).toBe(columns.length * 2);
  const fontSize = Number.parseFloat(getComputedStyle(cells()[0]!).fontSize);
  for (const cell of cells()) expect(Math.round(cell.getBoundingClientRect().width)).toBeGreaterThanOrEqual(Math.round(fontSize * 8));
  expectTwoLinesWithoutClipping();
  expect(height(cells()[columns.length + 2]!)).toBe(Math.round(lineHeight(cells()[0]!) * 2));
  expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
  expect(document.querySelectorAll("th")[1]!.style.textAlign).toBe("center");
  expect(document.querySelectorAll("td")[4]!.style.textAlign).toBe("right");
});

test("a long identifier between short words still ends within two lines", async () => {
  // 四轮放宽后宽度约为单行的 97.7%：首行放不下前缀加标识符、次行放不下标识符加尾词，仍是三行，须落到单行宽度。
  await renderPwa(<div style={{ width: 358 }}><MarkdownContent text={table(`a ${"x".repeat(100)} b`)} /></div>);
  await expect.poll(() => cells().length).toBe(columns.length * 2);
  expectTwoLinesWithoutClipping();
});

test("streaming content growth re-fits the table to two lines", async () => {
  const screen = await renderPwa(<div style={{ width: 760 }}><MarkdownContent text={table("short")} /></div>);
  await expect.poll(() => cells().length).toBe(columns.length * 2);
  for (const cell of cells()) expect(height(cell)).toBe(Math.round(lineHeight(cell)));
  await screen.rerender(<PwaUiProvider><div className="pwa-root"><div style={{ width: 760 }}><MarkdownContent text={table(longCell.repeat(4))} /></div></div></PwaUiProvider>);
  await expect.poll(() => cells()[columns.length + 2]!.textContent?.length).toBeGreaterThan(longCell.length * 3);
  expectTwoLinesWithoutClipping();
});

test("re-renders with unchanged content skip measuring, changed content measures again", async () => {
  let setFrame!: (frame: { text: string; index: number }) => void;
  function Harness() {
    const [frame, update] = useState({ text: table(longCell), index: 0 });
    setFrame = update;
    return <div style={{ width: 760 }} data-frame={frame.index}><MarkdownContent text={frame.text} /></div>;
  }
  await renderPwa(<Harness />);
  await expect.poll(() => cells().length).toBe(columns.length * 2);
  const rendered = document.querySelector("table")!;
  const observer = new MutationObserver(() => {});
  observer.observe(rendered, { subtree: true, attributes: true, attributeFilter: ["style"] });
  for (let index = 1; index <= 3; index += 1) flushSync(() => setFrame({ text: table(longCell), index }));
  expect(observer.takeRecords()).toHaveLength(0);
  flushSync(() => setFrame({ text: table(longCell.repeat(2)), index: 4 }));
  expect(observer.takeRecords().length).toBeGreaterThan(0);
  observer.disconnect();
  expect(document.querySelector("table")).toBe(rendered);
  expectTwoLinesWithoutClipping();
});

test("short tables fit their columns without scrolling at desktop width", async () => {
  await renderPwa(<div style={{ width: 760 }}><MarkdownContent text={"| Item | Result |\n| --- | --- |\n| first | ready |"} /></div>);
  const wrapper = document.querySelector<HTMLElement>(".pwa-markdown-table")!;
  await expect.poll(() => cells().length).toBe(4);
  expect(wrapper.scrollWidth).toBe(wrapper.clientWidth);
  for (const cell of cells()) expect(height(cell)).toBe(Math.round(lineHeight(cell)));
});
