import { expect, test, vi } from "vitest";
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor,
} from "./timeline-viewport-anchor";

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function viewportList(): HTMLDivElement {
  const list = document.createElement("div");
  document.body.append(list);
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 100 });
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(100, 300));
  return list;
}

test("uses semantic rows regardless of tag or visual classes and ignores unmarked content", () => {
  const list = viewportList();
  const decoration = document.createElement("article");
  decoration.className = "pwa-message pwa-timeline-row";
  const row = document.createElement("div");
  row.dataset.viewportRow = "semantic";
  list.append(decoration, row);
  vi.spyOn(decoration, "getBoundingClientRect").mockReturnValue(rect(100, 130));
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(130, 280));
  expect(captureTimelineViewportAnchor(list)?.rowElement).toBe(row);
  list.remove();
});

test("does not reuse a DOM node whose semantic row identity changed", () => {
  const list = viewportList();
  const row = document.createElement("article");
  row.dataset.viewportRow = "old";
  list.append(row);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(120, 180));
  const anchor = captureTimelineViewportAnchor(list)!;
  row.dataset.viewportRow = "new";
  expect(restoreTimelineViewportAnchor(list, anchor)).toBe(false);
  expect(list.scrollTop).toBe(100);
  list.remove();
});

test("does not resolve a missing top-level row to a nested row with the same key", () => {
  const list = viewportList();
  const row = document.createElement("article");
  row.dataset.viewportRow = "old";
  list.append(row);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(120, 180));
  const anchor = captureTimelineViewportAnchor(list)!;
  row.remove();
  const group = document.createElement("article");
  group.dataset.viewportRow = "group";
  group.append(row.cloneNode());
  list.append(group);
  expect(restoreTimelineViewportAnchor(list, anchor)).toBe(false);
  list.remove();
});

test("captures a visible readable block before its timeline row", () => {
  const list = viewportList();
  const row = document.createElement("article");
  row.dataset.viewportRow = "answer-1";
  const paragraph = document.createElement("p");
  row.append(paragraph);
  list.append(row);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(80, 500));
  let paragraphTop = 130;
  vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(() => rect(paragraphTop, paragraphTop + 40));

  const anchor = captureTimelineViewportAnchor(list);
  expect(anchor?.element).toBe(paragraph);

  paragraphTop = 180;
  expect(restoreTimelineViewportAnchor(list, anchor!)).toBe(true);
  expect(list.scrollTop).toBe(150);
  list.remove();
});

test("anchors the first visible collapsed tool instead of a later paragraph", () => {
  const list = viewportList();
  const tool = document.createElement("article");
  tool.dataset.viewportRow = "tool";
  const later = document.createElement("article");
  later.dataset.viewportRow = "later";
  const paragraph = document.createElement("p");
  later.append(paragraph);
  list.append(tool, later);
  vi.spyOn(tool, "getBoundingClientRect").mockReturnValue(rect(100, 144));
  vi.spyOn(later, "getBoundingClientRect").mockReturnValue(rect(152, 240));
  vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(rect(180, 220));
  expect(captureTimelineViewportAnchor(list)?.element).toBe(tool);
  list.remove();
});

test("recovers a replaced readable block from the stable timeline row key", () => {
  const list = viewportList();
  const originalRow = document.createElement("article");
  originalRow.dataset.viewportRow = "scope:[answer-1]";
  const originalParagraph = document.createElement("p");
  originalRow.append(originalParagraph);
  list.append(originalRow);
  vi.spyOn(originalRow, "getBoundingClientRect").mockReturnValue(rect(90, 400));
  vi.spyOn(originalParagraph, "getBoundingClientRect").mockReturnValue(rect(140, 180));
  const anchor = captureTimelineViewportAnchor(list)!;

  originalRow.remove();
  const replacementRow = document.createElement("article");
  replacementRow.dataset.viewportRow = "scope:[answer-1]";
  const replacementParagraph = document.createElement("p");
  replacementRow.append(replacementParagraph);
  list.append(replacementRow);
  vi.spyOn(replacementRow, "getBoundingClientRect").mockReturnValue(rect(170, 480));
  vi.spyOn(replacementParagraph, "getBoundingClientRect").mockReturnValue(rect(220, 260));

  expect(restoreTimelineViewportAnchor(list, anchor)).toBe(true);
  expect(list.scrollTop).toBe(180);
  list.remove();
});

test("does not jump to unrelated content when the anchored row disappears", () => {
  const list = viewportList();
  const row = document.createElement("article");
  row.dataset.viewportRow = "old-session";
  list.append(row);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(120, 180));
  const anchor = captureTimelineViewportAnchor(list)!;

  row.remove();
  const unrelated = document.createElement("article");
  unrelated.dataset.viewportRow = "new-session";
  list.append(unrelated);
  vi.spyOn(unrelated, "getBoundingClientRect").mockReturnValue(rect(500, 560));

  expect(restoreTimelineViewportAnchor(list, anchor)).toBe(false);
  expect(list.scrollTop).toBe(100);
  list.remove();
});

/** 自上而下排列的子元素，每个 20px；第 firstVisible 个的顶边对齐列表顶边（100）。 */
function stackedChildren(list: HTMLDivElement, count: number, firstVisible: number, make: (index: number) => HTMLElement = () => {
  const row = document.createElement("article");
  row.dataset.viewportRow = "row";
  return row;
}): { children: HTMLElement[]; measured: () => number } {
  let measured = 0;
  const children = Array.from({ length: count }, (_, index) => {
    const child = make(index);
    const top = 100 + (index - firstVisible) * 20;
    vi.spyOn(child, "getBoundingClientRect").mockImplementation(() => { measured += 1; return rect(top, top + 20); });
    return child;
  });
  list.append(...children);
  return { children, measured: () => measured };
}

test("finds the first visible row of a long list without measuring every row above it", () => {
  const list = viewportList();
  const { children, measured } = stackedChildren(list, 1000, 900, (index) => {
    const row = document.createElement("article");
    row.dataset.viewportRow = `row-${index}`;
    return row;
  });
  const anchor = captureTimelineViewportAnchor(list);
  expect(anchor?.rowElement).toBe(children[900]);
  expect(anchor?.rowLocator?.key).toBe("row-900");
  // 逐行查找要测量前 900 行；二分只需十余次，再加可见行内的少量测量。
  expect(measured()).toBeLessThan(40);
  list.remove();
});

test("skips non-row, hidden and boxless children around the viewport edge exactly like a full scan", () => {
  const list = viewportList();
  const { children } = stackedChildren(list, 60, 40, (index) => {
    const edge = index >= 40 && index <= 42;
    const child = document.createElement(index === 40 || (!edge && index % 3 === 0) ? "p" : "article");
    if (child.tagName === "ARTICLE") child.dataset.viewportRow = `row-${index}`;
    if (index === 41) child.setAttribute("aria-hidden", "true");
    return child;
  });
  // 首个进入视口的是第 40 个（非语义行），第 41 个被隐藏，第 42 个才是锚点行。
  expect(captureTimelineViewportAnchor(list)?.rowElement).toBe(children[42]);
  // 不占布局的子元素（如 display: none）报告 0 尺寸，不能误导二分把可见行当成在视口上方。
  const boxless = document.createElement("article");
  boxless.dataset.viewportRow = "boxless";
  vi.spyOn(boxless, "getBoundingClientRect").mockReturnValue(rect(0, 0));
  list.insertBefore(boxless, children[45]!);
  expect(captureTimelineViewportAnchor(list)?.rowElement).toBe(children[42]);
  list.remove();
});

test("returns no anchor when only non-row children are on screen", () => {
  const list = viewportList();
  stackedChildren(list, 30, 10, (index) => {
    const child = document.createElement(index >= 10 && index < 20 ? "p" : "article");
    if (index < 10 || index >= 20) child.dataset.viewportRow = `row-${index}`;
    return child;
  });
  expect(captureTimelineViewportAnchor(list)).toBeNull();
  list.remove();
});
