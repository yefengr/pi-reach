import { createRef, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { Modal } from "@mantine/core";
import { PUBLISHED_FILE_TYPE, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, pointer, resetTouch, syntheticCapture, syntheticSwipe, touch, touchDrag, touchOrigin } from "@/test/browser/swipe";
import { MessageList } from "./message-list";
import { ToolReader } from "./tool-reader";
import { PublishedFilesProvider, type PublishedFilesView, type PublishedFileViewState } from "./published-files-context";
import type { ToolValue } from "./tool-presentation";

const longText = Array.from({ length: 100 }, (_, index) => `Reading line ${index}: content for vertical scrolling.`).join("\n");
const columns = Array.from({ length: 18 }, (_, index) => `Column ${index}`);
const tableText = `Body **child text**.\n\n| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.map(() => "Cell value").join(" | ")} |`;
const codeText = `Body **child text**.\n\n\`\`\`text\n${"unbroken_long_line_".repeat(120)}\n\`\`\``;
const descriptor: PublishedFileDescriptor = { publication_id: "swipe-file", file_name: "notes.txt", mime_type: "text/plain", byte_length: 20, tool_call_id: "publish" };
const toolValue: ToolValue = { event_id: "tool-event", session_id: "session", leaf_id: "leaf", group_id: "group", timestamp: 10, kind: "tool", tool_call_id: "read", tool: "read", args: { path: "notes.txt" }, status: "complete", truncated: false, result: longText };
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=";
let mounted: Awaited<ReturnType<typeof renderPwa>> | undefined;
let urls: string[] = [];

beforeEach(async () => {
  window.history.replaceState(null, "", "/app");
  window.getSelection()?.removeAllRanges();
  await page.viewport(390, 844);
  await enableTouch();
  // 不触发图片 inline 自动 pin；阅读器本身仍使用真实 Provider 和生命周期。
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(async () => {
  await resetTouch();
  await mounted?.unmount();
  mounted = undefined;
  await expect.poll(() => window.history.state?.piReachToolReader ?? window.history.state?.piReachFileReader).toBeUndefined();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  urls.forEach(url => URL.revokeObjectURL(url));
  urls = [];
  window.getSelection()?.removeAllRanges();
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});
function element(selector: string) { return document.querySelector<HTMLElement>(selector)!; }
function blobUrl(blob: Blob) { const url = URL.createObjectURL(blob); urls.push(url); return url; }

function TopModal({ opened, close }: { opened: boolean; close: () => void }) {
  return <Modal opened={opened} onClose={close} title="Top confirmation" portalProps={{ target: ".pwa-root" }}><button>Confirm</button></Modal>;
}
async function toolHarness(synthetic = true) {
  let modal!: (opened: boolean) => void;
  const close = vi.fn();
  function Harness() {
    const [opened, setOpened] = useState(true);
    const [top, setTop] = useState(false);
    useLayoutEffect(() => { modal = value => flushSync(() => setTop(value)); }, []);
    return <><ToolReader value={toolValue} opened={opened} onClose={() => { close(); setOpened(false); }} /><TopModal opened={top} close={() => setTop(false)} /></>;
  }
  const screen = await renderPwa(<Harness />);
  mounted = screen;
  await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
  await expect.poll(() => Math.round(element(".pwa-tool-reader").getBoundingClientRect().right)).toBe(window.innerWidth);
  const surface = element(".pwa-tool-reader");
  const scroll = element(".pwa-tool-reader-scroll");
  scroll.scrollTop = 0;
  if (synthetic) syntheticCapture(surface);
  return { screen, surface, scroll, child: element(".pwa-reader-text"), close, modal };
}
async function fileHarness({ text = longText, markdown = false, image = false, synthetic = true }: { text?: string; markdown?: boolean; image?: boolean; synthetic?: boolean } = {}) {
  const file = { ...descriptor, file_name: image ? "image.png" : markdown ? "notes.md" : "notes.txt", mime_type: image ? "image/png" : markdown ? "text/markdown" : "text/plain" };
  let state: PublishedFileViewState = image
    ? { phase: "ready", receivedBytes: 20, preview: { kind: "image", width: 1, height: 1 }, url: blobUrl(new Blob([Uint8Array.from(atob(imageData), c => c.charCodeAt(0))], { type: "image/png" })) }
    : { phase: "ready", receivedBytes: text.length, preview: { kind: "text" }, text, url: blobUrl(new Blob([text])) };
  const { publication_id, ...data } = file;
  const items: TimelineViewItem[] = [{ kind: "event", event: { event_id: publication_id, session_id: "session", leaf_id: "leaf", group_id: "group", timestamp: 10, kind: "custom", truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data } } }];
  const pin = vi.fn();
  const unpin = vi.fn();
  const reading = vi.fn();
  const cancel = vi.fn();
  const view: PublishedFilesView = { scopeToken: {}, canFetch: true, active: false, getState: () => state, open: vi.fn().mockResolvedValue(undefined), cancel, pin, unpin, onReadingChange: reading };
  let modal!: (opened: boolean) => void;
  let updateText!: (value: string) => void;
  function Harness() {
    const [top, setTop] = useState(false);
    const [, refresh] = useState(0);
    useLayoutEffect(() => {
      modal = value => flushSync(() => setTop(value));
      updateText = value => { state = { ...state, text: value }; flushSync(() => refresh(count => count + 1)); };
    }, []);
    return <PublishedFilesProvider value={view}><MessageList items={items} hasEarlier={false} listRef={createRef()} bottomSentinelRef={createRef()} onScroll={() => {}} /><TopModal opened={top} close={() => setTop(false)} /></PublishedFilesProvider>;
  }
  const screen = await renderPwa(<Harness />);
  mounted = screen;
  const trigger = screen.getByRole("button", { name: image ? "View image" : "View", exact: true });
  await trigger.click();
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
  await expect.poll(() => Math.round(element(".pwa-file-reader").getBoundingClientRect().right)).toBe(window.innerWidth);
  const surface = element(".pwa-file-reader");
  if (synthetic) syntheticCapture(surface);
  return { screen, surface, trigger, pin, unpin, reading, cancel, modal, updateText };
}
async function toolClosed(h: Awaited<ReturnType<typeof toolHarness>>) {
  await expect.poll(() => window.history.state?.piReachToolReader).toBeUndefined();
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  expect(h.close).toHaveBeenCalledExactlyOnceWith();
}
async function fileClosed(h: Awaited<ReturnType<typeof fileHarness>>) {
  await expect.poll(() => window.history.state?.piReachFileReader).toBeUndefined();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  await expect.poll(() => h.unpin.mock.calls.length).toBe(1);
  expect(h.pin).toHaveBeenCalledExactlyOnceWith(descriptor.publication_id);
  expect(h.reading).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(h.trigger.element());
  expect(h.cancel).not.toHaveBeenCalled();
}

test("G4 mobile right swipe closes through existing history cleanup", async () => {
  const h = await toolHarness();
  expect(getComputedStyle(h.surface).touchAction).toBe("pan-y");
  expect(getComputedStyle(h.scroll).touchAction).toBe("pan-y");
  syntheticSwipe(h.child);
  await toolClosed(h);
});
test("G4 desktop touch swipe is disabled", async () => {
  await page.viewport(1280, 900);
  const h = await toolHarness();
  syntheticSwipe(h.child);
  expect(h.close).not.toHaveBeenCalled();
  expect(getComputedStyle(h.scroll).touchAction).toBe("auto");
});
test("G4 top modal blocks a right swipe", async () => {
  const h = await toolHarness();
  h.modal(true);
  await expect.element(h.screen.getByRole("heading", { name: "Top confirmation" })).toBeVisible();
  syntheticSwipe(h.child);
  expect(h.close).not.toHaveBeenCalled();
  expect(window.history.state?.piReachToolReader).toBe(true);
});
test("G4 CDP output child transfers capture and closes", async () => {
  const h = await toolHarness(false);
  await touchDrag(touchOrigin(h.child, 40, 10), 110, 0);
  await toolClosed(h);
}, 15000);
test("G4 CDP vertical drag scrolls without closing", async () => {
  const h = await toolHarness(false);
  expect(h.scroll.scrollHeight).toBeGreaterThan(h.scroll.clientHeight);
  await touchDrag(touchOrigin(h.scroll, 100, 350), 0, -180);
  await expect.poll(() => h.scroll.scrollTop).toBeGreaterThan(20);
  expect(h.close).not.toHaveBeenCalled();
}, 15000);

test("G5 mobile plain text swipe preserves singleton focus, reading lock and pin lifecycle", async () => {
  const h = await fileHarness();
  const scroll = element(".pwa-file-reader-scroll");
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
  expect(h.reading).toHaveBeenLastCalledWith(true);
  syntheticSwipe(element(".pwa-file-plain"));
  await fileClosed(h);
});
test("G5 desktop swipe is disabled", async () => {
  await page.viewport(1280, 900);
  const h = await fileHarness();
  syntheticSwipe(element(".pwa-file-plain"));
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.reading).toHaveBeenLastCalledWith(true);
  expect(h.unpin).not.toHaveBeenCalled();
  expect(getComputedStyle(element(".pwa-file-reader-scroll")).touchAction).toBe("auto");
});
test("G5 top modal blocks a right swipe", async () => {
  const h = await fileHarness();
  h.modal(true);
  await expect.element(h.screen.getByRole("heading", { name: "Top confirmation" })).toBeVisible();
  syntheticSwipe(element(".pwa-file-plain"));
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.unpin).not.toHaveBeenCalled();
});
test("G5 real Markdown table stays independently horizontal and excluded", async () => {
  const h = await fileHarness({ text: tableText, markdown: true });
  const table = element(".pwa-markdown-table");
  const scroll = element(".pwa-file-reader-scroll");
  expect(table.scrollWidth).toBeGreaterThan(table.clientWidth);
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  expect(getComputedStyle(table).touchAction).toBe("auto");
  expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
  syntheticSwipe(element(".pwa-markdown-table td"));
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.unpin).not.toHaveBeenCalled();
});
test("G5 wide fenced code scrolls inside its block and leaves the body swipeable", async () => {
  const h = await fileHarness({ text: codeText, markdown: true });
  const scroll = element(".pwa-file-reader-scroll");
  const pre = element(".pwa-file-markdown pre");
  expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  expect(scroll.hasAttribute("data-swipe-horizontal")).toBe(false);
  expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
  expect(getComputedStyle(pre).touchAction).toBe("auto");
  // 从代码块内起手属于它自己的横滚，不关闭；从正文其他位置起手可以关闭。
  syntheticSwipe(pre);
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.unpin).not.toHaveBeenCalled();
  syntheticSwipe(element(".pwa-file-markdown strong"));
  await fileClosed(h);
});
test("G5 content that still overflows the body keeps the outer horizontal exception and tracks changes", async () => {
  const h = await fileHarness({ text: "Body **child text**.", markdown: true });
  const scroll = element(".pwa-file-reader-scroll");
  expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
  // 用 DOM 注入稳定地制造正文自身横溢（Markdown 本身已不会产生）。
  const wide = document.createElement("div");
  wide.style.cssText = "width: 800px; height: 10px";
  element(".pwa-file-markdown").append(wide);
  await expect.poll(() => getComputedStyle(scroll).touchAction).toBe("auto");
  expect(scroll.hasAttribute("data-swipe-horizontal")).toBe(true);
  syntheticSwipe(element(".pwa-file-markdown strong"));
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  wide.remove();
  await expect.poll(() => getComputedStyle(scroll).touchAction).toBe("pan-y");
  expect(h.unpin).not.toHaveBeenCalled();
});
test("G5 image single pan and two-finger pinch do not close", async () => {
  const h = await fileHarness({ image: true });
  await h.screen.getByRole("button", { name: "Zoom in" }).click();
  const stage = element(".pwa-file-image-stage");
  expect(stage.hasAttribute("data-swipe-ignore")).toBe(true);
  expect(getComputedStyle(stage).touchAction).toBe("none");
  // 只为这项合成图片事件模拟舞台 capture；CDP 用例不替换捕获。
  vi.spyOn(stage, "setPointerCapture").mockImplementation(() => {});
  flushSync(() => { pointer(stage, "pointerdown", 10, 10); pointer(stage, "pointermove", 110, 30); });
  await expect.poll(() => stage.querySelector("img")?.style.transform).toContain("translate(100px, 20px)");
  flushSync(() => pointer(stage, "pointerup", 110, 30));
  flushSync(() => pointer(stage, "pointerdown", 10, 10));
  flushSync(() => pointer(stage, "pointerdown", 30, 10, { pointerId: 2, isPrimary: false }));
  flushSync(() => pointer(stage, "pointermove", 50, 10, { pointerId: 2, isPrimary: false }));
  await expect.poll(() => stage.querySelector("img")?.style.transform).toContain("scale(3)");
  flushSync(() => {
    pointer(stage, "pointerup", 10, 10);
    pointer(stage, "pointerup", 50, 10, { pointerId: 2, isPrimary: false });
  });
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.unpin).not.toHaveBeenCalled();
});
test("G5 CDP Markdown child closes through the MessageList lifecycle", async () => {
  const h = await fileHarness({ text: "Body **child text**.", markdown: true, synthetic: false });
  await touchDrag(touchOrigin(element(".pwa-file-markdown strong"), 10), 110, 0);
  await fileClosed(h);
}, 15000);
test("G5 CDP plain text vertical drag scrolls without closing", async () => {
  const h = await fileHarness({ synthetic: false });
  const scroll = element(".pwa-file-reader-scroll");
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await touchDrag(touchOrigin(scroll, 100, 350), 0, -180);
  await expect.poll(() => scroll.scrollTop).toBeGreaterThan(20);
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.reading).toHaveBeenLastCalledWith(true);
}, 15000);
test("G5 CDP real Markdown table scrolls horizontally without closing", async () => {
  const h = await fileHarness({ text: tableText, markdown: true, synthetic: false });
  const table = element(".pwa-markdown-table");
  await touchDrag(touchOrigin(element(".pwa-markdown-table td"), 40), -130, 0);
  await expect.poll(() => table.scrollLeft).toBeGreaterThan(20);
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.unpin).not.toHaveBeenCalled();
}, 15000);
test("G5 CDP fenced code scrolls horizontally inside its block without closing", async () => {
  await fileHarness({ text: codeText, markdown: true, synthetic: false });
  const pre = element(".pwa-file-markdown pre");
  await touchDrag(touchOrigin(pre, 180), -130, 0);
  await expect.poll(() => pre.scrollLeft).toBeGreaterThan(20);
  expect(window.history.state?.piReachFileReader).toBeTruthy();
}, 15000);
test("G5 CDP body text next to a fenced code block still closes on right swipe", async () => {
  const h = await fileHarness({ text: codeText, markdown: true, synthetic: false });
  await touchDrag(touchOrigin(element(".pwa-file-markdown strong"), 10), 110, 0);
  await fileClosed(h);
}, 15000);
test("G5 CDP native image capture handles pan and pinch without closing", async () => {
  const h = await fileHarness({ image: true, synthetic: false });
  await h.screen.getByRole("button", { name: "Zoom in" }).click();
  const stage = element(".pwa-file-image-stage");
  await touchDrag(touchOrigin(stage, 80, 120), 100, 20);
  expect(stage.querySelector("img")?.style.transform).not.toBe("translate(0px, 0px) scale(1.5)");
  const first = touchOrigin(stage, 100, 200);
  const second = { ...first, x: first.x + 40, id: 2 };
  await touch("touchStart", [first]);
  await touch("touchStart", [first, second]);
  await touch("touchMove", [first, { ...second, x: second.x + 40 }]);
  await touch("touchEnd", []);
  await expect.poll(() => stage.querySelector("img")?.style.transform).toContain("scale(3)");
  expect(window.history.state?.piReachFileReader).toBeTruthy();
  expect(h.unpin).not.toHaveBeenCalled();
}, 15000);
