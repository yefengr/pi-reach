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

test("captures a visible readable block before its timeline row", () => {
  const list = viewportList();
  const row = document.createElement("article");
  row.dataset.timelineKey = "answer-1";
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
  tool.dataset.toolKey = "tool";
  const later = document.createElement("article");
  later.dataset.timelineKey = "later";
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
  originalRow.dataset.timelineKey = "scope:[answer-1]";
  const originalParagraph = document.createElement("p");
  originalRow.append(originalParagraph);
  list.append(originalRow);
  vi.spyOn(originalRow, "getBoundingClientRect").mockReturnValue(rect(90, 400));
  vi.spyOn(originalParagraph, "getBoundingClientRect").mockReturnValue(rect(140, 180));
  const anchor = captureTimelineViewportAnchor(list)!;

  originalRow.remove();
  const replacementRow = document.createElement("article");
  replacementRow.dataset.timelineKey = "scope:[answer-1]";
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
  row.dataset.timelineKey = "old-session";
  list.append(row);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(120, 180));
  const anchor = captureTimelineViewportAnchor(list)!;

  row.remove();
  const unrelated = document.createElement("article");
  unrelated.dataset.timelineKey = "new-session";
  list.append(unrelated);
  vi.spyOn(unrelated, "getBoundingClientRect").mockReturnValue(rect(500, 560));

  expect(restoreTimelineViewportAnchor(list, anchor)).toBe(false);
  expect(list.scrollTop).toBe(100);
  list.remove();
});
