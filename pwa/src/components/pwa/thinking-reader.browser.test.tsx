import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Button, Modal } from "@mantine/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touchDrag, touchOrigin } from "@/test/browser/swipe";
import { setLanguagePreference } from "@/lib/i18n";
import { getLanguageState } from "@/lib/i18n/locale";
import { PUBLISHED_FILE_TYPE, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { MessageList } from "./message-list";
import { PublishedFilesProvider, type PublishedFilesView } from "./published-files-context";

// 合成的隔离展示数据；不连接 Pi，不写历史、投递状态或真实文件。
const base = { session_id: "thinking-reader", leaf_id: "leaf", group_id: "run", timestamp: 1 };
const thought = (text: string, id = "answer"): TimelineViewItem => ({ kind: "partial", createdAt: 1, partial: {
  protocol_version: 2, type: "timeline_partial", ...base, partial_id: `${id}:thinking:0`, kind: "thinking", status: "delta", delta: text,
} });
const formalThought = (text: string, id = "answer"): TimelineViewItem => ({ kind: "event", event: {
  ...base, leaf_id: "formal-leaf", event_id: id, kind: "assistant", status: "complete", blocks: [{ type: "thinking", text }],
} });
const body = (text: string, id = "body"): TimelineViewItem => ({ kind: "event", event: { ...base, event_id: id, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] } });
const tool = (id = "check", partial = false): TimelineViewItem => partial ? { kind: "partial", createdAt: 1, partial: {
  protocol_version: 2, type: "timeline_partial", ...base, partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "bash", args: { command: "pnpm --filter pwa typecheck" }, status: "running", delta: "Running output",
} } : { kind: "event", event: { ...base, event_id: id, kind: "tool", tool_call_id: id, tool: "bash", args: { command: "pnpm --filter pwa typecheck" }, status: "complete", truncated: false, result: "Completed output" } };
const end: TimelineViewItem = { kind: "event", event: { ...base, event_id: "run-end", kind: "run_end", status: "complete", timestamp: 3 } };
const summary: TimelineViewItem = { kind: "event", event: { ...base, event_id: "summary", kind: "compaction", payload: { summary: "Original summary content" }, truncated: false } };
const file: PublishedFileDescriptor = { publication_id: "reader-note", file_name: "Thinking reader notes.md", mime_type: "text/markdown", byte_length: 128, tool_call_id: "publish" };
const publication: TimelineViewItem = { kind: "event", event: { ...base, event_id: "publication", kind: "custom", truncated: false,
  payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: file.file_name, mime_type: file.mime_type, byte_length: file.byte_length, tool_call_id: file.tool_call_id } },
} };
type Config = { items: TimelineViewItem[]; live: boolean; running: boolean; sourceKey: string; fileReady: boolean };
const originalLanguage = getLanguageState().preference;
const mounted: Array<{ unmount: () => Promise<unknown> }> = [];
const thinkingDialog = () => document.querySelector<HTMLElement>(".pwa-thinking-reader[role='dialog']");
const thinkingScroll = () => thinkingDialog()?.querySelector<HTMLElement>(".pwa-thinking-reader-scroll") ?? null;
const toolDialog = () => document.querySelector<HTMLElement>(".pwa-tool-reader[role='dialog']:not(.pwa-thinking-reader):not(.pwa-summary-reader)");
const fileDialog = () => document.querySelector<HTMLElement>(".pwa-file-reader[role='dialog']");
const allReaders = () => [...document.querySelectorAll<HTMLElement>(".pwa-tool-reader[role='dialog'], .pwa-file-reader[role='dialog']")];
const hasHistory = () => Boolean(history.state?.piReachThinkingReader || history.state?.piReachToolReader || history.state?.piReachSummaryReader || history.state?.piReachFileReader);

beforeEach(async () => {
  setLanguagePreference("en");
  await page.viewport(1280, 900);
});
afterEach(async () => {
  for (const screen of mounted.splice(0)) await screen.unmount();
  await expect.poll(hasHistory, { timeout: 5000 }).toBe(false);
  setLanguagePreference(originalLanguage);
  vi.restoreAllMocks();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

async function harness(options: Partial<Config> = {}) {
  let update!: (patch: Partial<Config>) => void;
  let setTop!: (opened: boolean) => void;
  let completeFile!: () => void;
  const reading = vi.fn();
  const fileReading = vi.fn();
  const pin = vi.fn();
  const unpin = vi.fn();
  // 真实 Provider 的 getState 读当前存储；acquire 完成时拿到的是最新状态，而不是点击时渲染的快照。
  const fileStore = { ready: options.fileReady ?? true };
  function Harness() {
    const [config, setConfig] = useState<Config>({ items: [thought("**Original thinking**\n\nOriginal model text.")], live: true, running: true, sourceKey: JSON.stringify(["endpoint-a", base.session_id]), fileReady: true, ...options });
    const [top, changeTop] = useState(false);
    const [deferred] = useState(() => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    });
    const [url] = useState(() => URL.createObjectURL(new Blob(["Original file body"], { type: "text/plain" })));
    useEffect(() => () => URL.revokeObjectURL(url), [url]);
    const scopeToken = useMemo(() => ({}), [config.sourceKey]);
    const viewport = useTimelineViewport(config.items);
    const onReadingChange = useCallback((active: boolean) => { reading(active); viewport.setReadingDetails(active); }, [viewport.setReadingDetails]);
    const files = useMemo<PublishedFilesView>(() => ({
      scopeToken, canFetch: true, active: false,
      getState: () => fileStore.ready ? { phase: "ready", receivedBytes: 128, byteLength: 128, preview: { kind: "text" }, text: "# Original file body\n\nFile reading.", url } : undefined,
      open: () => deferred.promise, cancel() {}, pin, unpin, onReadingChange: fileReading,
    }), [scopeToken, deferred, url]);
    update = patch => flushSync(() => setConfig(previous => ({ ...previous, ...patch })));
    setTop = opened => flushSync(() => changeTop(opened));
    completeFile = () => { fileStore.ready = true; update({ fileReady: true }); deferred.resolve(); };
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
      <PublishedFilesProvider value={files}><MessageList items={config.items} sourceKey={config.sourceKey} hasEarlier={false} isLive={config.live} running={config.running}
        listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={onReadingChange} /></PublishedFilesProvider>
      <input aria-label="Outside reader control" />
      <Modal opened={top} onClose={() => changeTop(false)} title="Top reader confirmation" portalProps={{ target: ".pwa-root" }}><Button onClick={() => changeTop(false)}>Dismiss confirmation</Button></Modal>
    </main>;
  }
  const screen = await renderPwa(<Harness />);
  mounted.push(screen);
  return { screen, update, setTop, completeFile, reading, fileReading, pin, unpin };
}

const thoughtButton = () => document.querySelector<HTMLButtonElement>(".pwa-thinking-process-row-action")!;
const groupHeads = () => [...document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head")];
async function openThought() {
  const trigger = thoughtButton();
  expect(trigger).not.toBeNull();
  trigger.focus();
  await userEvent.click(trigger);
  await expect.poll(thinkingDialog).not.toBeNull();
  await expect.poll(() => history.state?.piReachThinkingReader).toBe(true);
  await expect.poll(() => thinkingDialog()?.hasAttribute("data-pwa-moving")).toBe(false);
  return trigger;
}
async function closeThought() {
  await page.getByRole("button", { name: "Close thinking", exact: true }).click();
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => history.state?.piReachThinkingReader).toBeUndefined();
}
/** 已结束的过程组默认收起；手动展开即一次阅读选择。 */
async function expandTools() {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head[aria-expanded='false']")) await userEvent.click(toggle);
}
/** 运行中默认展开不产生选择；需要手动展开时先收起再展开，记录一次用户操作。 */
async function chooseExpanded(head: HTMLButtonElement) {
  if (head.getAttribute("aria-expanded") === "true") await userEvent.click(head);
  await userEvent.click(head);
  await expect.poll(() => head.getAttribute("aria-expanded")).toBe("true");
}
const toolButton = () => document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!;
const fileButton = () => document.querySelector<HTMLButtonElement>('.pwa-published-file .pwa-published-actions button[aria-label="View"]')!;
const gapToBottom = (scroll: HTMLElement) => Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight);

// 验证真实父链路，不直接挂载 ThinkingReader 或用假退出回调代替动画生命周期。
test.each([1280, 402, 320])("real Thinking entry opens a single scrollable Reader and returns focus at %ipx", async width => {
  await page.viewport(width, 844);
  const text = `## Original heading\n\n${"Original model paragraph.\n\n".repeat(160)}FINAL THINKING LINE`;
  // 本轮仍在运行时过程组默认展开，不产生手动阅读选择。
  const view = await harness({ items: [formalThought(text)] });
  const trigger = await openThought();
  const dialog = thinkingDialog()!;
  expect(Math.round(dialog.getBoundingClientRect().width)).toBe(width >= 768 ? 720 : width);
  await expect.poll(() => Math.round(dialog.getBoundingClientRect().right)).toBe(width);
  expect(Math.round(dialog.getBoundingClientRect().height)).toBe(844);
  expect(document.querySelector(".pwa-root")?.contains(dialog)).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(allReaders()).toHaveLength(1);
  expect(view.reading.mock.calls.at(-1)?.[0]).toBe(true);
  const scroll = thinkingScroll()!;
  // 已结束的 Thinking 与其他 Reader 一致从开头阅读；只有流式输出打开即跟随。
  expect(scroll.scrollTop).toBe(0);
  expect(scroll.clientHeight).toBeGreaterThan(0);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  scroll.scrollTop = scroll.scrollHeight;
  expect(gapToBottom(scroll)).toBeLessThanOrEqual(1);
  const last = [...scroll.querySelectorAll(".pwa-markdown p")].at(-1)!;
  expect(last.textContent).toContain("FINAL THINKING LINE");
  expect(Math.round(last.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(scroll.getBoundingClientRect().bottom));
  expect(dialog.querySelectorAll(".pwa-long-text, .pwa-long-text-toggle")).toHaveLength(0);
  await closeThought();
  expect(document.activeElement).toBe(trigger);
  expect(view.reading.mock.calls.at(-1)?.[0]).toBe(false);
});

test("streaming follows only at the bottom; returning upward never scrolls the main timeline", async () => {
  const text = `**Streaming original**\n\n${"Reading paragraph.\n\n".repeat(140)}Original tail`;
  const view = await harness({ items: [body("Earlier reply.\n\n".repeat(80), "earlier"), thought(text)] });
  await openThought();
  const scroll = thinkingScroll()!;
  expect(gapToBottom(scroll)).toBeLessThanOrEqual(1);
  const main = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const mainTop = Math.round(main.scrollTop);
  scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - 200);
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  const readingTop = Math.round(scroll.scrollTop);
  const next = `${text}\n\nAdditional original chunk.`;
  view.update({ items: [body("Earlier reply.\n\n".repeat(80), "earlier"), thought(next)] });
  await expect.poll(() => thinkingScroll()?.textContent).toContain("Additional original chunk.");
  expect(thinkingScroll()).toBe(scroll);
  expect(Math.round(scroll.scrollTop)).toBe(readingTop);
  expect(Math.round(main.scrollTop)).toBe(mainTop);
  scroll.scrollTop = scroll.scrollHeight;
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  view.update({ items: [body("Earlier reply.\n\n".repeat(80), "earlier"), thought(`${next}\n\nNewest final chunk.`)] });
  await expect.poll(() => thinkingScroll()?.textContent).toContain("Newest final chunk.");
  await expect.poll(() => gapToBottom(scroll)).toBeLessThanOrEqual(1);
  expect(Math.round(main.scrollTop)).toBe(mainTop);
  await closeThought();
});

test("partial-to-formal and new activity preserve the selected Reader instance and do not push another history entry", async () => {
  const view = await harness();
  await openThought();
  const scroll = thinkingScroll()!;
  const length = history.length;
  view.update({ items: [formalThought("**Final original**\n\nFinal body."), tool(), thought("**New activity**\nDo not take over.", "later"), end] });
  await expect.poll(() => scroll.textContent).toContain("Final body.");
  expect(thinkingScroll()).toBe(scroll);
  expect(scroll.textContent).not.toContain("Do not take over");
  expect(history.length).toBe(length);
  expect(allReaders()).toHaveLength(1);
  await closeThought();
});

test("disconnect stops the Reader's running indication without manufacturing an execution result", async () => {
  const view = await harness();
  await openThought();
  const original = thinkingScroll()!;
  view.update({ live: false });
  expect(thinkingScroll()).toBe(original);
  expect(thinkingDialog()!.querySelectorAll(".pwa-spin")).toHaveLength(0);
  const header = thinkingDialog()!.querySelector("header")!;
  const statusText = [header.textContent, ...[...header.querySelectorAll("[aria-label], [title]")].map(element => `${element.getAttribute("aria-label")} ${element.getAttribute("title")}`)].join(" ");
  expect(statusText).toMatch(/unknown/i);
  expect(thinkingScroll()?.textContent).toContain("Original model text.");
  await closeThought();
});

test("tool Reader receives exactly the same unknown state as the retained partial row", async () => {
  const view = await harness({ items: [tool("live", true)] });
  await expandTools();
  const trigger = toolButton();
  trigger.focus();
  await userEvent.click(trigger);
  await expect.poll(toolDialog).not.toBeNull();
  await expect.poll(() => history.state?.piReachToolReader).toBe(true);
  view.update({ live: false });
  expect(document.querySelector(".pwa-tool-card")?.getAttribute("data-tool-status")).toBe("unknown");
  expect(toolDialog()?.querySelector(".pwa-tool-reader-status")?.classList.contains("pwa-tool-status-unknown")).toBe(true);
  expect(toolDialog()?.querySelectorAll(".pwa-spin")).toHaveLength(0);
  await page.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(toolDialog).toBeNull();
});

test("an empty historical Thinking trace has no Reader entry or invented body", async () => {
  const view = await harness({ items: [formalThought("   "), end], live: false, running: false });
  expect(document.querySelector(".pwa-process-head-static")?.textContent).toBe("Thinking");
  expect(document.querySelector(".pwa-process-group button")).toBeNull();
  expect(thinkingDialog()).toBeNull();
  expect(hasHistory()).toBe(false);
  expect(view.reading.mock.calls.at(-1)?.[0]).toBe(false);
});

test("copy uses the complete raw Thinking text rather than the rendered or truncated excerpt", async () => {
  const text = "## Original model heading\n\n**Original raw formatting**\n\n" + "原始思考正文\n\n".repeat(80);
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await harness({ items: [formalThought(text)] });
  await openThought();
  await page.getByRole("button", { name: "Copy thinking", exact: true }).click();
  expect(copy).toHaveBeenLastCalledWith(text);
  await closeThought();
});

test("the reading hold survives closing animation, then releases only after the actual Dialog is removed", async () => {
  const view = await harness();
  await openThought();
  const dialog = thinkingDialog()!;
  flushSync(() => dialog.querySelector<HTMLButtonElement>(".pwa-tool-reader-close")!.click());
  expect(thinkingDialog()).toBe(dialog);
  expect(view.reading.mock.calls.at(-1)?.[0]).toBe(true);
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
});

test("closing a Reader does not release another manually expanded group", async () => {
  const view = await harness({ items: [tool(), body("Separate the process groups."), thought("**Reader content**\nIndependent text.")] });
  await chooseExpanded(groupHeads()[0]!);
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(true);
  await openThought();
  await closeThought();
  expect(view.reading.mock.calls.at(-1)?.[0]).toBe(true);
  await userEvent.click(groupHeads()[0]!);
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
});

test("an external valid focus chosen during exit is not stolen back", async () => {
  await harness();
  await openThought();
  flushSync(() => thinkingDialog()!.querySelector<HTMLButtonElement>(".pwa-tool-reader-close")!.click());
  const outside = document.querySelector<HTMLInputElement>('input[aria-label="Outside reader control"]')!;
  outside.focus();
  await expect.poll(thinkingDialog).toBeNull();
  expect(document.activeElement).toBe(outside);
});

test("removing the source entry closes its Reader, clears history and releases the reading hold", async () => {
  const view = await harness();
  await openThought();
  view.update({ items: [body("Remaining reply.", "remaining")] });
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => history.state?.piReachThinkingReader).toBeUndefined();
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
});

test("invalidating before the opening frame cannot leave a history record, pending open or reading hold", async () => {
  const view = await harness();
  thoughtButton().click();
  view.update({ items: [] });
  await expect.poll(() => document.querySelector(".pwa-chat-empty")).not.toBeNull();
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(hasHistory).toBe(false);
  expect(view.reading.mock.calls.at(-1)?.[0]).toBe(false);
  view.update({ items: [thought("**Fresh source**\nFresh body.")] });
  await openThought();
  expect(thinkingScroll()?.textContent).toContain("Fresh body.");
  expect(allReaders()).toHaveLength(1);
  await closeThought();
});

test("a different endpoint with identical session/entry IDs resets the old viewer selection", async () => {
  const view = await harness();
  await openThought();
  view.update({ sourceKey: JSON.stringify(["endpoint-b", base.session_id]) });
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(hasHistory).toBe(false);
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
  await openThought();
  expect(allReaders()).toHaveLength(1);
  expect(thinkingScroll()?.textContent).toContain("Original model text.");
  await closeThought();
});

test("an existing Thinking selection blocks tool and summary attempts until its real exit completes", async () => {
  await harness({ items: [thought("**Chosen Thinking**\nChosen text."), tool(), summary] });
  await expandTools();
  await openThought();
  toolButton().click();
  document.querySelector<HTMLButtonElement>(".pwa-summary-action")!.click();
  expect(thinkingScroll()?.textContent).toContain("Chosen text.");
  expect(allReaders()).toHaveLength(1);
  expect(document.querySelector(".pwa-summary-reader[role='dialog']")).toBeNull();
  await closeThought();
  await userEvent.click(toolButton());
  await expect.poll(toolDialog).not.toBeNull();
  await page.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(toolDialog).toBeNull();
});

test("a late file acquire cannot replace a newer Thinking selection", async () => {
  const view = await harness({ items: [publication, thought("**Chosen Thinking**\nChosen text.")], fileReady: false });
  await userEvent.click(fileButton());
  await openThought();
  view.completeFile();
  await expect.poll(() => thinkingScroll()?.textContent).toContain("Chosen text.");
  expect(fileDialog()).toBeNull();
  expect(allReaders()).toHaveLength(1);
  await closeThought();
});

test("file selection excludes Thinking until close and its Reader pin is actually released", async () => {
  const view = await harness({ items: [publication, thought("**Thinking after file**\nText.")] });
  await expect.poll(() => view.pin.mock.calls.length - view.unpin.mock.calls.length).toBe(1);
  const baselinePins = view.pin.mock.calls.length - view.unpin.mock.calls.length;
  await userEvent.click(fileButton());
  await expect.poll(fileDialog).not.toBeNull();
  await expect.poll(() => history.state?.piReachFileReader).toBe(true);
  thoughtButton().click();
  expect(thinkingDialog()).toBeNull();
  expect(allReaders()).toHaveLength(1);
  expect(view.pin.mock.calls.length - view.unpin.mock.calls.length).toBe(baselinePins + 1);
  await userEvent.click(fileDialog()!.querySelector<HTMLButtonElement>(".pwa-tool-reader-close")!);
  await expect.poll(fileDialog).toBeNull();
  await expect.poll(() => view.pin.mock.calls.length - view.unpin.mock.calls.length).toBe(baselinePins);
  await openThought();
  await closeThought();
});

test.each(["no-preference", "reduce"])("top Modal owns Escape; the next Escape closes only Thinking (%s)", async motion => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const view = await harness();
  await openThought();
  view.setTop(true);
  await expect.element(page.getByRole("dialog", { name: "Top reader confirmation" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog", { name: "Top reader confirmation" })).not.toBeInTheDocument();
  expect(thinkingDialog()).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
});

test("Back with a top Modal preserves Thinking's marker; the following Back closes only the Reader", async () => {
  const view = await harness();
  const url = location.href;
  await openThought();
  view.setTop(true);
  await expect.element(page.getByRole("dialog", { name: "Top reader confirmation" })).toBeVisible();
  history.back();
  await expect.poll(() => history.state?.piReachThinkingReader).toBe(true);
  expect(thinkingDialog()).not.toBeNull();
  await page.getByRole("button", { name: "Dismiss confirmation", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "Top reader confirmation" })).not.toBeInTheDocument();
  history.back();
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => history.state?.piReachThinkingReader).toBeUndefined();
  expect(location.href).toBe(url);
});

test("clicking the desktop scrim closes only Thinking, clears history and returns focus", async () => {
  const view = await harness();
  const trigger = await openThought();
  const scrim = document.querySelector<HTMLElement>(".pwa-scrim")!;
  const dialogLeft = thinkingDialog()!.getBoundingClientRect().left;
  expect(dialogLeft).toBeGreaterThan(100);
  await userEvent.click(scrim, { position: { x: Math.round(dialogLeft / 2), y: 400 } });
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => history.state?.piReachThinkingReader).toBeUndefined();
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

test("mobile right-swipe on the Thinking body closes the Reader through the real exit", async () => {
  await page.viewport(390, 844);
  const view = await harness({ items: [formalThought(`**Swipe original**\n\n${"Swipe paragraph.\n\n".repeat(60)}`)] });
  await enableTouch();
  try {
    const trigger = await openThought();
    const scroll = thinkingScroll()!;
    expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
    await touchDrag(touchOrigin(scroll, 80, 32), 200, 0);
    await expect.poll(thinkingDialog).toBeNull();
    await expect.poll(() => history.state?.piReachThinkingReader).toBeUndefined();
    await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
    expect(document.activeElement).toBe(trigger);
  } finally {
    await resetTouch();
  }
});

test("source removal under a top Modal leaves focus inside that Modal", async () => {
  const view = await harness();
  await openThought();
  view.setTop(true);
  const dismiss = page.getByRole("button", { name: "Dismiss confirmation", exact: true });
  await expect.element(dismiss).toBeVisible();
  dismiss.element().focus();
  expect(document.activeElement).toBe(dismiss.element());
  view.update({ items: [body("Remaining reply.", "remaining")] });
  await expect.poll(thinkingDialog).toBeNull();
  await expect.poll(() => view.reading.mock.calls.at(-1)?.[0]).toBe(false);
  expect(document.activeElement).toBe(dismiss.element());
  await userEvent.click(dismiss);
  await expect.element(page.getByRole("dialog", { name: "Top reader confirmation" })).not.toBeInTheDocument();
});

test("an invalid tool trigger returns focus to its still-visible group head", async () => {
  await harness({ items: [tool(), tool("second")], running: false });
  await expandTools();
  const head = groupHeads()[0]!;
  const trigger = toolButton();
  trigger.focus();
  await userEvent.click(trigger);
  await expect.poll(toolDialog).not.toBeNull();
  await expect.poll(() => history.state?.piReachToolReader).toBe(true);
  // 原入口在阅读期间失效（禁用）；组仍可见时回到组头而不是列表。
  trigger.disabled = true;
  await page.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(toolDialog).toBeNull();
  expect(document.activeElement).toBe(head);
});

test("a file acquire finishing after a newer Thinking selection has fully closed does not open", async () => {
  const view = await harness({ items: [publication, thought("**Chosen Thinking**\nChosen text.")], fileReady: false });
  await userEvent.click(fileButton());
  await openThought();
  await closeThought();
  const readingCalls = view.reading.mock.calls.length;
  const fileReadingCalls = view.fileReading.mock.calls.length;
  view.completeFile();
  // 进度在 acquire 的 finally 中撤下，晚于 onRead 的同步提交；被接受的选择此时已同步上报阅读锁。
  await expect.poll(() => document.querySelector(".pwa-published-progress")).toBeNull();
  expect(view.reading.mock.calls.slice(readingCalls).some(([active]) => active)).toBe(false);
  expect(view.fileReading.mock.calls.slice(fileReadingCalls).some(([active]) => active)).toBe(false);
  expect(fileDialog()).toBeNull();
  expect(history.state?.piReachFileReader).toBeUndefined();
  await userEvent.click(fileButton());
  await expect.poll(fileDialog).not.toBeNull();
  await userEvent.click(fileDialog()!.querySelector<HTMLButtonElement>(".pwa-tool-reader-close")!);
  await expect.poll(fileDialog).toBeNull();
});
