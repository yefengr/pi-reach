import { createRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
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
    showModal = value => flushSync(() => setModalOpened(value));
    const view: PublishedFilesView = { scopeToken, canFetch: fetch, active: busy, getState, open, cancel, pin, unpin, onReadingChange: reading };
    return <PublishedFilesProvider value={provided ? view : null!}>{records ? <MessageList items={records} hasEarlier={false} listRef={createRef()} bottomSentinelRef={createRef()} onScroll={() => {}} isLive={live} /> : <PublishedFile file={file} live={live} onRead={onRead} />}{modal ? <Modal opened={modalOpened} onClose={() => setModalOpened(false)} title="Top confirmation" portalProps={{ target: ".pwa-root" }}><button>Confirm</button></Modal> : null}</PublishedFilesProvider>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, open, cancel, pin, unpin, reading, onRead, showModal, replaceScope: () => { scopeToken = {}; update(); }, removeProvider: () => { provided = false; update(); }, removeState: () => { state = undefined; update(); }, setItems: (next: TimelineViewItem[]) => { records = next; update(); }, update: (value: PublishedFileViewState | undefined = state, options: { canFetch?: boolean; active?: boolean } = {}) => { state = value; fetch = options.canFetch ?? fetch; busy = options.active ?? busy; update(); } };
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
  expect(h.unpin.mock.calls.length).toBe(unpins + 1);
  expect(h.reading).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(trigger.element());
  expect(h.cancel).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test("system Back closes only the file reader without cancelling transfer", async () => {
  const h = await harness({ items: [event(published())], initial: { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "safe content", url: blobUrl() } });
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
  window.history.back();
  await expect.poll(() => document.querySelector(".pwa-file-reader")).toBeNull();
  expect(h.cancel).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test.each(["scope", "provider"] as const)("reused nonempty timeline destroys the old reader on %s loss without moving focus", async loss => {
  const ready: PublishedFileViewState = { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "old scope", url: blobUrl() };
  const h = await harness({ items: [event(published())], initial: ready });
  const removedListener = vi.spyOn(window, "removeEventListener");
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => window.history.state?.piReachFileReader).toBeTruthy();
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
  expect(h.unpin).toHaveBeenCalledExactlyOnceWith("publication");
  expect(h.reading).toHaveBeenLastCalledWith(false);
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
    expect(h.unpin).toHaveBeenCalledTimes(2);
  }
  focus.mockRestore(); listFocus.mockRestore(); removedListener.mockRestore();
  await h.screen.unmount();
});

test("same scope keeps the reader and lock across item replacement, missing state and disconnection", async () => {
  const ready: PublishedFileViewState = { phase: "ready", receivedBytes: 20, preview: { kind: "text" }, text: "cached", url: blobUrl() };
  const h = await harness({ items: [event(published())], initial: ready });
  await h.screen.getByRole("button", { name: "View", exact: true }).click();
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
  expect(h.reading).toHaveBeenLastCalledWith(false);
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
  expect(h.unpin).toHaveBeenCalledTimes(2);
  expect(h.open).not.toHaveBeenCalled();
  await h.screen.unmount();
});

test("decode error never loops and retry is explicitly manual", async () => {
  const h = await harness({ file: image, initial: { phase: "ready", receivedBytes: 100, preview: imagePreview, url: blobUrl(new Blob(["not an image"])) } });
  visibility(true);
  await expect.element(h.screen.getByText("Couldn't display the image. Retry manually.").last()).toBeVisible();
  expect(document.querySelector(".pwa-published-image")).toBeNull();
  visibility(false); visibility(true); h.update();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.onRead).not.toHaveBeenCalled();
  await h.screen.getByRole("button", { name: "Retry", exact: true }).click();
  expect(h.onRead).toHaveBeenCalledTimes(1);
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
  expect(h.unpin).toHaveBeenCalledTimes(1);
  await h.screen.unmount();
});
