import { createRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { Modal } from "@mantine/core";
import { PUBLISHED_FILE_TYPE, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { renderPwa } from "@/test/browser/render";
import { PublishedFile } from "./published-file";
import { MessageList } from "./message-list";
import { PublishedFilesProvider, type PublishedFilesView, type PublishedFileViewState } from "./published-files-context";

const readerCallbacks: { close: () => void; exit: () => void }[] = [];
vi.mock("./published-file-reader", async importOriginal => {
  const original = await importOriginal<typeof import("./published-file-reader")>();
  return { PublishedFileReader: (props: ComponentProps<typeof original.PublishedFileReader>) => {
    // 保留真实 Drawer 和 cleanup，只捕获边界回调以可重复验证迟到调用。
    readerCallbacks.push({ close: props.onClose, exit: props.onExitTransitionEnd });
    return <original.PublishedFileReader {...props} />;
  } };
});

const descriptor: PublishedFileDescriptor = { publication_id: "publication", file_name: "说明.md", mime_type: "text/markdown", byte_length: 20, tool_call_id: "publish-tool" };
const base = { session_id: "session", leaf_id: "leaf", group_id: "group", timestamp: 10 };
function published(file = descriptor): TimelineEvent & { kind: "custom" } {
  const { publication_id, ...data } = file;
  return { ...base, kind: "custom", event_id: publication_id, truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data } };
}
const event = (value: TimelineEvent): TimelineViewItem => ({ kind: "event", event: value });
const image: PublishedFileDescriptor = { ...descriptor, file_name: "图.png", mime_type: "image/png", byte_length: 100 };
const imagePreview = { kind: "image" as const, width: 1, height: 1 };
const imageBlob = new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII="), char => char.charCodeAt(0))], { type: "image/png" });
let urls: string[] = [];
let observers: { callback: IntersectionObserverCallback; element: Element }[] = [];
function visibility(visible: boolean) {
  flushSync(() => observers.forEach(({ callback, element }) => callback([{ isIntersecting: visible, target: element } as IntersectionObserverEntry], {} as IntersectionObserver)));
}
function blobUrl(blob = new Blob(["whole original"], { type: "text/plain" })) { const url = URL.createObjectURL(blob); urls.push(url); return url; }
beforeEach(() => {
  readerCallbacks.length = 0;
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { observers.push({ callback: this.callback, element }); }
    disconnect() {}
  });
});
afterEach(async () => {
  await page.viewport(1280, 900);
  vi.unstubAllGlobals();
  urls.forEach(url => URL.revokeObjectURL(url));
  urls = [];
});

async function harness({ file = descriptor, initial, canFetch = true, active = false, live = true, items, modal = false }: { file?: PublishedFileDescriptor; initial?: PublishedFileViewState; canFetch?: boolean; active?: boolean; live?: boolean; items?: TimelineViewItem[]; modal?: boolean } = {}) {
  let state = initial;
  let fetch = canFetch;
  let busy = active;
  let records = items;
  let scopeToken = {};
  let provided = true;
  let showModal!: (value: boolean) => void;
  let update!: () => void;
  let notify!: () => void;
  const onRead = vi.fn();
  const pin = vi.fn();
  const unpin = vi.fn();
  const reading = vi.fn();
  const open = vi.fn<PublishedFilesView["open"]>().mockResolvedValue(undefined);
  const cancel = vi.fn(() => { state = undefined; update(); });
  const getState = () => state;
  function Harness() {
    const [, refresh] = useState(0);
    const [modalOpened, setModalOpened] = useState(false);
    update = () => flushSync(() => refresh(value => value + 1));
    // 真实控制器在事件之外通知，React 按普通优先级调度，不同步提交。
    notify = () => refresh(value => value + 1);
    showModal = value => flushSync(() => setModalOpened(value));
    const view: PublishedFilesView = { scopeToken, canFetch: fetch, active: busy, getState, open, cancel, pin, unpin, onReadingChange: reading };
    return <PublishedFilesProvider value={provided ? view : null!}>{records ? <MessageList items={records} hasEarlier={false} listRef={createRef()} bottomSentinelRef={createRef()} onScroll={() => {}} isLive={live} /> : <PublishedFile file={file} live={live} onRead={onRead} />}{modal ? <Modal opened={modalOpened} onClose={() => setModalOpened(false)} title="Top confirmation" portalProps={{ target: ".pwa-root" }}><button>Confirm</button></Modal> : null}</PublishedFilesProvider>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, publish: (value: PublishedFileViewState) => { state = value; notify(); }, open, cancel, pin, unpin, reading, onRead, showModal, replaceScope: () => { scopeToken = {}; update(); }, removeProvider: () => { provided = false; update(); }, removeState: () => { state = undefined; update(); }, setItems: (next: TimelineViewItem[]) => { records = next; update(); }, update: (value: PublishedFileViewState | undefined = state, options: { canFetch?: boolean; active?: boolean } = {}) => { state = value; fetch = options.canFetch ?? fetch; busy = options.active ?? busy; update(); } };
}

test("legal custom is independent output and a summary boundary with one group completion", async () => {
  const tool = (id: string): TimelineEvent => ({ ...base, kind: "tool", event_id: id, tool_call_id: id, tool: "read", args: { path: `${id}.txt` }, status: "complete", truncated: false, result: {} });
  const unknown: TimelineEvent = { ...base, kind: "custom", event_id: "unknown", truncated: false, payload: { custom_type: "unknown", data: { file_name: "hidden" } } };
  const invalid: TimelineEvent = { ...published(), event_id: "invalid", payload: { custom_type: PUBLISHED_FILE_TYPE, data: { ...descriptor, source_path: "/private" } } };
  const items = [tool("a"), tool("b"), published(), tool("c"), unknown, invalid, { ...base, kind: "run_end", event_id: "end", status: "complete" } as TimelineEvent].map(event);
  const h = await harness({ items });
  await expect.element(h.screen.getByText("说明.md", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".pwa-published-file")).toHaveLength(1);
  expect(document.querySelectorAll(".pwa-tool-group")).toHaveLength(1);
  expect(document.querySelectorAll(".pwa-turn-meta")).toHaveLength(1);
  expect(document.querySelector(".pwa-published-file")?.closest(".pwa-tool-group")).toBeNull();
  await h.screen.unmount();
});

test("history and disconnected metadata never fetch, even when a live gate remains true", async () => {
  const h = await harness({ file: image, live: false, initial: { phase: "ready", receivedBytes: 100, preview: imagePreview, url: blobUrl(imageBlob) } });
  visibility(true);
  await expect.element(h.screen.getByText("Connect and open the original session to fetch")).toBeVisible();
  expect(h.open).not.toHaveBeenCalled();
  expect(document.querySelector(".pwa-published-actions button")).toBeNull();
  expect(document.querySelector(".pwa-published-image")).toBeNull();
  await h.screen.unmount();
  const offline = await harness({ file: image, canFetch: false });
  visibility(true);
  expect(offline.open).not.toHaveBeenCalled();
  await offline.screen.unmount();
});

test("auto only near viewport, deduplicates failures, waits for busy without an offscreen queue", async () => {
  const h = await harness({ file: image, active: true });
  visibility(true);
  expect(h.open).not.toHaveBeenCalled();
  visibility(false);
  h.update(undefined, { active: false });
  expect(h.open).not.toHaveBeenCalled();
  h.open.mockRejectedValue(new Error("private path /secret"));
  visibility(true);
  await expect.poll(() => h.open.mock.calls.length).toBe(1);
  await expect.element(h.screen.getByText("Couldn't fetch the file. Try again.").last()).toBeVisible();
  visibility(false); visibility(true); h.update();
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("/secret");
  await h.screen.unmount();
});

test("cancel locks out automatic retry, explicit retry catches rejected operations", async () => {
  const h = await harness({ file: image });
  visibility(true);
  await expect.poll(() => h.open.mock.calls.length).toBe(1);
  h.update({ phase: "reading", receivedBytes: 30, preview: imagePreview });
  await h.screen.getByRole("button", { name: "Cancel" }).click();
  expect(h.cancel).toHaveBeenCalledTimes(1);
  visibility(false); visibility(true);
  expect(h.open).toHaveBeenCalledTimes(1);
  h.open.mockRejectedValue(new Error("unsafe details"));
  await h.screen.getByRole("button", { name: "Fetch image" }).click();
  await expect.poll(() => h.open.mock.calls.length).toBe(2);
  expect(document.body.textContent).not.toContain("unsafe details");
  await h.screen.unmount();
});

test("current metadata decides large image and none, never old image MIME", async () => {
  const h = await harness({ file: image, initial: { phase: "manual", receivedBytes: 0, preview: imagePreview, byteLength: 15 * 1024 * 1024, fileName: "当前照片.png" } });
  visibility(true);
  await expect.element(h.screen.getByText("Large image — click to fetch")).toBeVisible();
  expect(h.open).not.toHaveBeenCalled();
  await h.screen.getByRole("button", { name: "Fetch image" }).click();
  expect(h.open).toHaveBeenCalledWith(image, "view");
  h.update({ phase: "manual", receivedBytes: 0, preview: { kind: "none" }, fileName: "current.zip", mimeType: "application/zip", byteLength: 2048 });
  await expect.element(h.screen.getByText("current.zip")).toBeVisible();
  expect(document.querySelector(".pwa-published-image")).toBeNull();
  expect(h.screen.getByRole("button", { name: "View", exact: true }).query()).toBeNull();
  await h.screen.getByRole("button", { name: "Download", exact: true }).click();
  expect(h.open).toHaveBeenLastCalledWith(image, "download");
  await h.screen.unmount();
});

test.each(["image/png", "image/gif", "image/webp"])("server-denied %s stays download-only even after becoming ready", async mimeType => {
  const file = { ...image, mime_type: mimeType };
  const h = await harness({ file, initial: { phase: "manual", receivedBytes: 0, preview: { kind: "none" }, mimeType } });
  visibility(true);
  expect(h.open).not.toHaveBeenCalled();
  expect(document.querySelector(".pwa-published-file img")).toBeNull();
  expect(h.screen.getByRole("button", { name: "Fetch image" }).query()).toBeNull();
  expect(h.screen.getByRole("button", { name: "View", exact: true }).query()).toBeNull();
  await h.screen.getByRole("button", { name: "Download", exact: true }).click();
  expect(h.open).toHaveBeenCalledWith(file, "download");

  const url = blobUrl(new Blob(["unchanged original"], { type: "application/octet-stream" }));
  h.update({ phase: "ready", receivedBytes: file.byte_length, preview: { kind: "none" }, mimeType, url });
  const save = h.screen.getByRole("link", { name: "Save file" });
  await expect.element(save).toBeVisible();
  expect(save.element().getAttribute("href")).toBe(url);
  expect(save.element().getAttribute("download")).toBe(file.file_name);
  expect(document.querySelector(".pwa-published-file img")).toBeNull();
  expect(h.screen.getByRole("button", { name: "View", exact: true }).query()).toBeNull();
  expect(h.onRead).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test("download completes as a fresh safe save anchor and ready survives disconnection", async () => {
  const h = await harness();
  const url = blobUrl();
  h.open.mockImplementation(async () => h.update({ phase: "ready", receivedBytes: 20, preview: { kind: "text" }, fileName: "../成果.md", text: "original", url }));
  await h.screen.getByRole("button", { name: "Download", exact: true }).click();
  const save = h.screen.getByRole("link", { name: "Save file" });
  await expect.element(save).toBeVisible();
  expect(save.element().getAttribute("href")).toBe(url);
  expect(save.element().getAttribute("download")).toBe(".._成果.md");
  expect(h.open).toHaveBeenCalledWith(descriptor, "download");
  h.update(undefined, { canFetch: false });
  await expect.element(save).toBeVisible();
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  expect(h.onRead).toHaveBeenCalledTimes(1);
  await h.screen.unmount();
});

test("safe bounded file reader escapes raw HTML and blocks external resources", async () => {
  const text = '# Report\n![secret](https://invalid.example/secret.png)\n<script>alert(1)</script>\n[bad](javascript:alert(1))\n[local](file:///secret)\n[ok](https://example.com)\n' + "x".repeat(100000);
  const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 110000, byteLength: 110000, preview: { kind: "text" }, mimeType: "text/markdown", text, url: blobUrl() } });
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true })).toBeVisible();
  await expect.element(h.screen.getByRole("heading", { name: "Report" })).toBeVisible();
  expect(document.querySelector(".pwa-file-reader img, .pwa-file-reader script, .pwa-file-reader iframe")).toBeNull();
  expect(document.querySelector('.pwa-file-reader a[href^="javascript:"], .pwa-file-reader a[href^="file:"]')).toBeNull();
  expect(document.querySelector('.pwa-file-reader a[href="https://example.com/"]')?.getAttribute("rel")).toBe("noopener noreferrer");
  await expect.element(h.screen.getByText("Only part of the content is shown. Save the file for the complete original.")).toBeVisible();
  expect(document.querySelector(".pwa-file-reader-scroll")!.textContent!.length).toBeLessThan(66000);
  await h.screen.getByRole("button", { name: "Close file reader" }).click();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  await h.screen.unmount();
  const raw = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, mimeType: "image/svg+xml", text: '<svg onload="alert(1)"><script>bad()</script></svg>', url: blobUrl() } });
  await raw.screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-file-plain")?.textContent).toContain("<svg");
  expect(document.querySelector(".pwa-file-reader svg[onload], .pwa-file-reader script")).toBeNull();
  await raw.screen.getByRole("button", { name: "Close file reader" }).click();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  await raw.screen.unmount();
});

test("reader pins through exit, releases reading lock, returns focus, and Escape closes only top layer", async () => {
  const h = await harness({ modal: true, items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe content", url: blobUrl() } });
  const trigger = h.screen.getByRole("button", { name: "View", exact: true });
  await trigger.click();
  await expect.poll(() => document.activeElement?.tagName).toBe("H2");
  expect(h.pin).toHaveBeenCalledWith("publication");
  expect(h.reading).toHaveBeenLastCalledWith(true);
  h.showModal(true);
  await expect.element(h.screen.getByRole("heading", { name: "Top confirmation" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(h.screen.getByText("Top confirmation")).not.toBeInTheDocument();
  expect(document.querySelector(".pwa-file-reader")).not.toBeNull();
  const unpins = h.unpin.mock.calls.length;
  await userEvent.keyboard("{Escape}");
  expect(h.unpin.mock.calls.length).toBe(unpins);
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  await expect.poll(() => h.unpin.mock.calls.length).toBe(unpins + 1);
  await expect.poll(() => h.reading.mock.lastCall?.[0]).toBe(false);
  expect(document.activeElement).toBe(trigger.element());
  expect(h.cancel).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test("system Back closes only the file reader without cancelling transfer", async () => {
  const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe content", url: blobUrl() } });
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  // 历史标记可能早于 Portal 挂载；先确认打开态，避免把尚未挂载误判为返回后的卸载。
  await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true })).toBeVisible();
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
  window.history.back();
  // 等原生返回提交后再卸载，防止 cleanup 对尚未撤回的记录再次调用 history.back()。
  await expect.poll(() => window.history.state?.piReachFileReader).toBeUndefined();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  expect(h.cancel).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test.each([390, 1280].flatMap(width => [false, true].map(reduce => ({ width, reduce }))))("file reader plays its enter motion when opened at $width (reduce=$reduce)", async ({ width, reduce }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });
  const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe content", url: blobUrl() } });
  try {
    const seen = { minOpacity: 1, maxLeft: 0, finalLeft: 0 };
    let stop = false;
    const tick = () => {
      const node = document.querySelector<HTMLElement>(".pwa-file-reader");
      if (node) {
        seen.minOpacity = Math.min(seen.minOpacity, Number(getComputedStyle(node).opacity));
        seen.finalLeft = Math.round(node.getBoundingClientRect().left);
        seen.maxLeft = Math.max(seen.maxLeft, seen.finalLeft);
      }
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 500));
    stop = true;
    if (reduce) {
      // 减少动态效果：无位移，只淡入。
      expect(seen.maxLeft).toBe(seen.finalLeft);
      expect(seen.minOpacity).toBeLessThan(1);
    } else {
      // 阅读器必须从屏外滑入，而不是直接出现在终点；面板全程不透明。
      expect(seen.maxLeft).toBeGreaterThan(seen.finalLeft);
      expect(seen.minOpacity).toBe(1);
    }
    await h.screen.unmount();
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    window.history.replaceState(null, "");
  }
});

/** 获取后打开阅读器前有 600ms 完成态停留，为慢机器留出余量。 */
const FETCH_SETTLE_WAIT = { timeout: 3000 };

/** 首次查看：先经历获取再就绪；就绪后主线程忙于重渲染，模拟真机上帧已到期才继续打开阅读器。 */
function fetchOnFirstView(h: Awaited<ReturnType<typeof harness>>) {
  const ready: PublishedFileViewState = { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe content", url: blobUrl() };
  h.open.mockImplementation(async () => {
    h.publish({ phase: "opening", receivedBytes: 0 });
    await new Promise(resolve => setTimeout(resolve, 30));
    h.publish({ phase: "reading", receivedBytes: 10 });
    await new Promise(resolve => setTimeout(resolve, 30));
    h.publish(ready);
    const busyUntil = performance.now() + 40;
    while (performance.now() < busyUntil) { /* 占住主线程直到下一帧到期 */ }
  });
}

test("first view after fetching still slides the reader in", async () => {
  await page.viewport(390, 844);
  const h = await harness({ items: [event(published())] });
  fetchOnFirstView(h);
  try {
    const seen = { maxLeft: 0, finalLeft: 0 };
    let stop = false;
    const tick = () => {
      const node = document.querySelector<HTMLElement>(".pwa-file-reader");
      if (node) {
        seen.finalLeft = Math.round(node.getBoundingClientRect().left);
        seen.maxLeft = Math.max(seen.maxLeft, seen.finalLeft);
      }
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true }), FETCH_SETTLE_WAIT).toBeVisible();
    await new Promise(resolve => setTimeout(resolve, 500));
    stop = true;
    expect(h.open).toHaveBeenCalledWith(descriptor, "view");
    // 挂载与打开不得合并到同一次提交，否则阅读器直接出现在终点。
    expect(seen.maxLeft).toBeGreaterThan(seen.finalLeft);
    expect(seen.finalLeft).toBe(0);
    await h.screen.unmount();
  } finally {
    window.history.replaceState(null, "");
  }
});

test("first view returns focus to the View button that started the fetch", async () => {
  const h = await harness({ items: [event(published())] });
  fetchOnFirstView(h);
  const trigger = h.screen.getByRole("button", { name: "View", exact: true });
  await trigger.click();
  await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true }), FETCH_SETTLE_WAIT).toBeVisible();
  await expect.poll(() => document.activeElement?.tagName).toBe("H2");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  // 获取期间同一按钮元素暂显示为「取消」，就绪后复原为「查看」，回焦不落到消息列表。
  await expect.poll(() => document.activeElement).toBe(trigger.element());
  expect(trigger.element().getAttribute("aria-label")).toBe("View");
  await h.screen.unmount();
});

test("first view settles a full progress bar before the reader covers the card, cached views open at once", async () => {
  const h = await harness({ items: [event(published())] });
  fetchOnFirstView(h);
  const seen: string[] = [];
  const heights = new Set<number>();
  const doneLabels = new Set<string | null>();
  const record = () => {
    const card = document.querySelector<HTMLElement>(".pwa-published-file");
    if (card) heights.add(Math.round(card.getBoundingClientRect().height));
    if (document.querySelector(".pwa-file-reader") && !seen.includes("reader")) seen.push("reader");
    const status = document.querySelector(".pwa-published-file [role=status]")?.textContent;
    const value = document.querySelector(".pwa-published-file [role=progressbar]")?.getAttribute("aria-valuenow");
    if (status === "Fetched") doneLabels.add(document.querySelector(".pwa-published-file [role=progressbar]")?.getAttribute("aria-label") ?? null);
    const entry = status ? `${status}:${value}` : null;
    if (entry && seen.at(-1) !== entry) seen.push(entry);
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  record();
  try {
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true }), FETCH_SETTLE_WAIT).toBeVisible();
    // 进度补满并停留后才交给阅读器；阅读器打开后卡片不再保留进度。
    expect(seen.indexOf("Fetched:100")).toBeGreaterThan(-1);
    expect(seen.indexOf("Fetched:100")).toBeLessThan(seen.indexOf("reader"));
    // 进度原地替换大小行，获取前后卡片高度不变。
    expect(seen.some(entry => entry.startsWith("Fetching "))).toBe(true);
    expect([...heights]).toHaveLength(1);
    // 完成态的进度条名称与状态文字一致，读屏不会同时听到「正在获取」和「完成」。
    expect([...doneLabels]).toEqual(["Fetched"]);
    expect(document.querySelector(".pwa-published-file [role=status], .pwa-published-file [role=progressbar]")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
    seen.length = 0;
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true })).toBeVisible();
    expect(seen).toEqual(["reader"]);
    expect(h.open).toHaveBeenCalledTimes(1);
    await h.screen.unmount();
  } finally {
    observer.disconnect();
    window.history.replaceState(null, "");
  }
});

test("a failed fetch replaces the size line in place and every action is an icon", async () => {
  await page.viewport(390, 844);
  const h = await harness();
  const card = () => Math.round(document.querySelector(".pwa-published-file")!.getBoundingClientRect().height);
  const idle = card();
  h.open.mockRejectedValue(new Error("private path /secret"));
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  const alert = h.screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Couldn't fetch the file. Try again.");
  // 错误占用大小行而不是追加一行，卡片高度不变。
  expect(alert.element().closest(".pwa-published-info")?.children).toHaveLength(2);
  expect(card()).toBe(idle);
  const actions = [...document.querySelectorAll(".pwa-published-actions > *")];
  expect(actions.map(action => action.getAttribute("aria-label"))).toEqual(["Retry", "Download"]);
  expect(actions.every(action => action.textContent === "" && action.querySelector("svg"))).toBe(true);
  expect(document.body.textContent).not.toContain("/secret");
  await h.screen.unmount();
});

test("the desktop file reader header clears a translucent status bar", async () => {
  const safeTop = 24;
  await page.viewport(1024, 768);
  document.documentElement.style.setProperty("--pwa-safe-top", `${safeTop}px`);
  try {
    const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, mimeType: "text/markdown", text: "# Report", url: blobUrl() } });
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true })).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-file-reader-header")!;
    // 阅读器贯通全高，顶栏与会话标题区同为安全区之下 48px，标题、保存与关闭垂直居中。
    const children = [...header.children].filter(child => child.getBoundingClientRect().height > 0);
    expect(children.length).toBe(3);
    expect(Math.round(header.getBoundingClientRect().height)).toBe(48 + safeTop);
    for (const child of children) {
      const box = child.getBoundingClientRect();
      expect(Math.abs(box.top + box.height / 2 - (safeTop + 24)), child.className).toBeLessThanOrEqual(1);
    }
    await h.screen.unmount();
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
    window.history.replaceState(null, "");
  }
});

test("the mobile file reader header starts with a back button and keeps the name on one line", async () => {
  await page.viewport(390, 844);
  try {
    const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, mimeType: "text/markdown", text: "# Report", url: blobUrl() } });
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByRole("dialog", { name: descriptor.file_name, exact: true })).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-file-reader-header")!;
    await expect.poll(() => Math.round(header.getBoundingClientRect().left)).toBe(0);
    const back = h.screen.getByRole("button", { name: "Close file reader" });
    expect(header.firstElementChild).toBe(back.element());
    // 与设置页同一位置：返回按钮距左缘 4px，标题紧随其后 4px，单行省略。
    expect(Math.round(back.element().getBoundingClientRect().left)).toBe(4);
    const title = header.querySelector("h2")!;
    expect(Math.round(title.getBoundingClientRect().left)).toBe(52);
    expect(getComputedStyle(title).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    expect(Math.round(header.getBoundingClientRect().height)).toBe(48);
    await h.screen.unmount();
  } finally {
    await page.viewport(1280, 900);
    window.history.replaceState(null, "");
  }
});

test("reader mounts text only after its enter motion ends", async () => {
  const width = 390;
  await page.viewport(width, 844);
  const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, mimeType: "text/markdown", text: "# Report\nbody", url: blobUrl() } });
  let pendingSeen = false;
  let contentLeft: number | null = null;
  const observer = new MutationObserver(() => {
    const reader = document.querySelector<HTMLElement>(".pwa-file-reader");
    if (!reader) return;
    if (reader.querySelector(".pwa-file-reader-scroll[aria-busy]") && !reader.querySelector("h1")) pendingSeen = true;
    if (contentLeft === null && reader.querySelector("h1")) contentLeft = Math.round(reader.getBoundingClientRect().left);
  });
  observer.observe(document.body, { subtree: true, childList: true });
  try {
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByRole("heading", { name: "Report" })).toBeVisible();
    // 滑入期间只有占位，正文在进入动画结束时才挂载，解析不推迟滑入起点。
    // 过渡计时与 CSS 时钟可能差一帧，只要求面板已基本到位（不足屏宽一成）。
    expect(pendingSeen).toBe(true);
    expect(contentLeft).not.toBeNull();
    expect(contentLeft!).toBeLessThan(width / 10);
    await h.screen.unmount();
  } finally {
    observer.disconnect();
    window.history.replaceState(null, "");
  }
});

test("native Back closes the file reader before popstate returns without cancelling transfer", async () => {
  const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe content", url: blobUrl() } });
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
  // 注入 UA 信号但仍使用真实 React 与 Drawer；不模拟 Safari 的原生转场。
  const popstate = new PopStateEvent("popstate", { state: window.history.state });
  Object.defineProperty(popstate, "hasUAVisualTransition", { value: true });
  window.dispatchEvent(popstate);
  expect(document.querySelector(".pwa-file-reader")).toBeNull();
  expect(document.querySelector(".mantine-Drawer-overlay")).toBeNull();
  expect(h.cancel).not.toHaveBeenCalled();
  await h.screen.unmount();
  // 合成事件没有真正弹出已压入的记录，清掉标记以免影响后续用例。
  window.history.replaceState(null, "");
});

test.each(["scope", "provider"] as const)("reused nonempty timeline destroys the old reader on %s loss without moving focus", async loss => {
  const ready: PublishedFileViewState = { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "old scope", url: blobUrl() };
  const h = await harness({ items: [event(published())], initial: ready });
  const removedListener = vi.spyOn(window, "removeEventListener");
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
  // 阅读器先收起挂载、随后才进入，等对话框真正渲染后再取引用。
  await expect.poll(() => document.querySelector(".pwa-file-reader")).not.toBeNull();
  const oldDialog = document.querySelector<HTMLElement>(".pwa-file-reader")!;
  const staleCallbacks = readerCallbacks.at(-1)!;
  expect(document.querySelectorAll(".pwa-scrim")).toHaveLength(1);
  await expect.poll(() => document.body.hasAttribute("data-scroll-locked"), { timeout: 5000 }).toBe(true);
  const trigger = h.screen.getByRole("button", { name: "View", exact: true }).element();
  const focus = vi.spyOn(trigger, "focus");
  const listFocus = vi.spyOn(document.querySelector<HTMLElement>(".pwa-message-list")!, "focus");
  expect(h.reading).toHaveBeenLastCalledWith(true);
  if (loss === "scope") h.replaceScope(); else h.removeProvider();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  expect(oldDialog.isConnected).toBe(false);
  expect(document.querySelector(".pwa-scrim")).toBeNull();
  await expect.poll(() => document.body.hasAttribute("data-scroll-locked"), { timeout: 5000 }).toBe(false);
  await expect.poll(() => h.unpin.mock.calls.length).toBe(1);
  expect(h.unpin).toHaveBeenCalledExactlyOnceWith("publication");
  await expect.poll(() => h.reading.mock.lastCall?.[0]).toBe(false);
  await expect.poll(() => window.history.state?.piReachFileReader, { timeout: 5000 }).toBeUndefined();
  expect(removedListener.mock.calls.some(([type]) => String(type) === "popstate")).toBe(true);
  expect(focus).not.toHaveBeenCalled();
  expect(listFocus).not.toHaveBeenCalled();
  if (loss === "scope") {
    h.update({ ...ready, text: "new scope" });
    await h.screen.getByRole("button", { name: "View", exact: true }).click();
    await expect.element(h.screen.getByText("new scope", { exact: true })).toBeVisible();
    const nextDialog = document.querySelector(".pwa-file-reader");
    flushSync(() => { staleCallbacks.close(); staleCallbacks.exit(); });
    expect(document.querySelector(".pwa-file-reader")).toBe(nextDialog);
    expect(document.querySelectorAll(".pwa-file-reader")).toHaveLength(1);
    expect(focus).not.toHaveBeenCalled();
    expect(listFocus).not.toHaveBeenCalled();
    expect(h.reading).toHaveBeenLastCalledWith(true);
    expect(h.pin).toHaveBeenCalledTimes(2);
    expect(h.unpin).toHaveBeenCalledTimes(1);
    await h.screen.getByRole("button", { name: "Close file reader" }).click();
    await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
    await expect.poll(() => h.unpin.mock.calls.length).toBe(2);
  }
  focus.mockRestore(); listFocus.mockRestore(); removedListener.mockRestore();
  await h.screen.unmount();
});

test("same scope keeps the reader and lock across item replacement, missing state and disconnection", async () => {
  const ready: PublishedFileViewState = { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "cached", url: blobUrl() };
  const h = await harness({ items: [event(published())], initial: ready });
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  // 阅读器先以收起态挂载、下一帧才打开，等对话框出现后再取引用。
  await expect.poll(() => document.querySelector(".pwa-file-reader")).not.toBeNull();
  const dialog = document.querySelector(".pwa-file-reader");
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
  const marker = window.history.state.piReachFileReader;
  h.setItems([event(published({ ...descriptor }))]);
  h.update(undefined, { canFetch: false, active: false });
  h.removeState();
  expect(document.querySelector(".pwa-file-reader")).toBe(dialog);
  h.update({ phase: "idle", receivedBytes: 0 }, { canFetch: false });
  h.setItems([event(published({ ...descriptor, publication_id: "other" }))]);
  expect(document.querySelector(".pwa-file-reader")).toBe(dialog);
  expect(h.reading).toHaveBeenLastCalledWith(true);
  expect(h.unpin).not.toHaveBeenCalled();
  expect(window.history.state.piReachFileReader).toBe(marker);
  await h.screen.getByRole("button", { name: "Close file reader" }).click();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  await expect.poll(() => h.reading.mock.lastCall?.[0]).toBe(false);
  await h.screen.unmount();
});

test("ready image embeds once, visibility pins inline, zoom/pointer pan/pinch and reset work", async () => {
  const h = await harness({ file: image, items: [event(published(image))], initial: { phase: "ready", receivedBytes: 100, preview: imagePreview, url: blobUrl(imageBlob) } });
  visibility(true);
  expect(h.pin).toHaveBeenCalledTimes(1);
  await h.screen.getByRole("button", { name: "View image" }).click();
  await expect.element(h.screen.getByRole("button", { name: "Zoom in" })).toBeVisible();
  expect(h.pin).toHaveBeenCalledTimes(2);
  visibility(false);
  expect(h.unpin).toHaveBeenCalledTimes(1);
  await h.screen.getByRole("button", { name: "Zoom in" }).click();
  const stage = document.querySelector<HTMLDivElement>(".pwa-file-image-stage")!;
  const pointer = (type: string, id: number, x: number, y: number) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: "touch", clientX: x, clientY: y }));
  // 合成事件没有 UA 活跃指针，单独屏蔽 capture；真实指针捕获由浏览器负责。
  stage.setPointerCapture = () => {};
  flushSync(() => { pointer("pointerdown", 1, 10, 10); pointer("pointermove", 1, 30, 30); });
  await expect.poll(() => stage.querySelector("img")?.style.transform).toContain("translate(20px, 20px)");
  flushSync(() => pointer("pointerdown", 2, 40, 30));
  flushSync(() => pointer("pointermove", 2, 50, 30));
  await expect.poll(() => stage.querySelector("img")?.style.transform).toContain("scale(3)");
  flushSync(() => { pointer("pointerup", 1, 30, 30); pointer("pointercancel", 2, 50, 30); });
  await h.screen.getByRole("button", { name: "Reset zoom" }).click();
  await expect.poll(() => stage.querySelector("img")?.style.transform).toBe("translate(0px, 0px) scale(1)");
  await h.screen.getByRole("button", { name: "Close file reader" }).click();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  await expect.poll(() => h.unpin.mock.calls.length).toBe(2);
  expect(h.open).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test("decode error never loops and retry is explicitly manual", async () => {
  const h = await harness({ file: image, initial: { phase: "ready", receivedBytes: 100, preview: imagePreview, url: blobUrl(new Blob(["not an image"])) } });
  visibility(true);
  await expect.element(h.screen.getByText("Couldn't display the image. Retry manually.").last()).toBeVisible();
  for (const message of h.screen.getByText("Couldn't display the image. Retry manually.").elements()) expect(message.classList.contains("pwa-published-error")).toBe(true);
  expect(document.querySelector(".pwa-published-image")).toBeNull();
  visibility(false); visibility(true); h.update();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.onRead).not.toHaveBeenCalled();
  await h.screen.getByRole("button", { name: "Retry", exact: true }).click();
  // 重试经过一次重新获取，完成态停留后才交给阅读器。
  await expect.poll(() => h.onRead.mock.calls.length, FETCH_SETTLE_WAIT).toBe(1);
  await h.screen.unmount();
});

test("publishing during a run is visible immediately, singleton reader survives removed origin with list focus fallback", async () => {
  await page.viewport(390, 844);
  const second = { ...descriptor, publication_id: "second", file_name: "second.md" };
  const h = await harness({ items: [event(published()), event(published(second))], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe", url: blobUrl() } });
  expect(document.querySelectorAll(".pwa-published-file")).toHaveLength(2);
  expect(document.querySelectorAll(".pwa-turn-meta")).toHaveLength(0);
  const buttons = document.querySelectorAll<HTMLButtonElement>(".pwa-published-actions button");
  buttons[0].click();
  await expect.element(h.screen.getByRole("button", { name: "Close file reader" })).toBeVisible();
  // 绕过遮罩模拟第二个异步 view 完成，不允许创建第二个 reader。
  buttons[1].click();
  expect(document.querySelectorAll(".pwa-file-reader")).toHaveLength(1);
  expect(h.pin).toHaveBeenCalledTimes(1);
  h.setItems([event(published(second))]);
  await h.screen.getByRole("button", { name: "Close file reader" }).click();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  await expect.poll(() => h.unpin.mock.calls.length).toBe(1);
  await h.screen.unmount();
});
