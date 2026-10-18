import { createRef, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";
import { Modal, Button } from "@mantine/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PUBLISHED_FILE_TYPE, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { HistoryWorkspace } from "./workspace-content";
import { MessageList } from "./message-list";
import { MessageComposer } from "./message-composer";
import { PublishedFilesProvider, type PublishedFilesView } from "./published-files-context";
import type { WorkspaceNavigationProps } from "./workspace-view";

const navigation: WorkspaceNavigationProps = {
  devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null,
  snapshotReady: true, pairingPresence: {}, onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {},
};
const base = { session_id: "work-panel", leaf_id: "leaf", group_id: "group", timestamp: 1 };
const file: PublishedFileDescriptor = { publication_id: "note", file_name: "Work panel notes.md", mime_type: "text/markdown", byte_length: 8000, tool_call_id: "publish" };
function tool(id: string, name: string): TimelineViewItem {
  return { kind: "event", event: { ...base, event_id: id, kind: "tool", tool_call_id: id, tool: name, args: { path: `${id}.txt` }, status: "complete", truncated: false, result: { content: [{ type: "text", text: `Output from ${id}\n` + "Independent reading content\n".repeat(80) }] } } };
}
function publication(): TimelineViewItem {
  const { publication_id, ...data } = file;
  return { kind: "event", event: { ...base, event_id: publication_id, kind: "custom", truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data } } };
}
const initialItems = [tool("read", "read"), publication(), tool("check", "bash")];
const pin = vi.fn();
const unpin = vi.fn();
const send = vi.fn();
type Controls = { top: () => void; append: () => void; changeScope: () => void; replaceSession: () => void; setRows: (items: TimelineViewItem[]) => void; ready: () => void; };
function Harness({ controls, pending = false }: { controls: Ref<Controls>; pending?: boolean }) {
  const [draft, setDraft] = useState("");
  const [items, setItems] = useState(initialItems);
  const [scopeToken, setScope] = useState<object>({});
  const [top, setTop] = useState(false);
  const [ready, setReady] = useState(!pending);
  const [deferred] = useState(() => {
    let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    return { promise, finish };
  });
  const [url] = useState(() => URL.createObjectURL(new Blob(["Complete original"], { type: "text/plain" })));
  const viewport = useTimelineViewport(items);
  const view = useMemo<PublishedFilesView>(() => ({
    scopeToken, canFetch: true, active: false,
    getState: () => ready ? { phase: "ready", receivedBytes: 8000, byteLength: 8000, preview: { kind: "text" }, text: "# Reading notes\n\n" + "Keep this independent reading position.\n\n".repeat(160), url } : undefined,
    open: () => deferred.promise, cancel() {}, pin, unpin,
  }), [scopeToken, ready, url, deferred]);
  useImperativeHandle(controls, () => ({
    top: () => setTop(true),
    append: () => setItems(previous => [...previous, tool("later", "grep")]),
    changeScope: () => setScope({}),
    replaceSession: () => { setScope({}); setItems([tool("different", "find")]); },
    setRows: setItems,
    ready: () => { flushSync(() => setReady(true)); deferred.finish(); },
  }), [deferred]);
  return <PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout navigation={navigation} titleBar={{ title: "Work panel", prefix: "Pi Reach", showTitle: true }} historyMode={false} toast={null} settingsRoute={{ open: false, origin: null, animate: false, change: 0 }} onOpenSettings={() => {}} onSettingsBack={() => {}} renderSettings={() => null} overlays={<Modal opened={top} onClose={() => setTop(false)} title="Top confirmation" portalProps={{ target: ".pwa-root" }}><Button onClick={() => setTop(false)}>Dismiss</Button></Modal>} closeBackgroundOverlay={close => close()}>
    <PublishedFilesProvider value={view}><MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} /></PublishedFilesProvider>
    <MessageComposer draft={draft} onDraftChange={setDraft} attachments={[]} canAttach={false} sendingAttachments={false} onAddFiles={() => {}} onRemoveAttachment={() => {}} onRetryAttachment={() => {}} isOnline isWorking={false} stopping={false} onSend={send} onStop={() => {}} commandModels={[]} commandCurrentModel={null} commandCurrentModelFallback="Model" commandThinking="medium" commandPendingAction={null} onNewSession={() => {}} onCompactSession={() => {}} onSetModel={() => {}} onSetThinking={() => {}} onCommandsOpen={() => {}} />
  </PwaWorkspaceLayout></PwaAppShell>;
}
async function mount(pending = false) {
  const controls = createRef<Controls>();
  const screen = await render(<PwaUiProvider><Harness controls={controls} pending={pending} /></PwaUiProvider>);
  return { screen, controls };
}
const panel = () => document.querySelector<HTMLElement>(".pwa-work-panel")!;
const draft = () => document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea")!;
const split = () => document.querySelector(".pwa-work-panel-layout")?.hasAttribute("data-split");
async function settle() {
  await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
async function openTool(index = 0) {
  for (const group of document.querySelectorAll<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head > button[aria-expanded='false']")) await userEvent.click(group);
  const button = document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")[index]!;
  await userEvent.click(button);
  await expect.poll(split).toBe(true);
  await expect.poll(() => panel().querySelector(".pwa-tool-reader-scroll")).not.toBeNull();
  await settle();
}
beforeEach(async () => {
  localStorage.removeItem("pi-reach-sidebar-collapsed");
  pin.mockClear(); unpin.mockClear(); send.mockClear();
  await page.viewport(1440, 1000);
});
afterEach(async () => {
  await expect.poll(() => Boolean(history.state?.piReachFileReader || history.state?.piReachToolReader)).toBe(false);
  document.documentElement.style.removeProperty("--pwa-safe-left");
  document.documentElement.style.removeProperty("--pwa-safe-right");
  document.documentElement.style.removeProperty("--pwa-safe-top");
});

test("real workspace opens one nonmodal tool panel and keeps the real Composer editable and sendable", async () => {
  const { screen } = await mount();
  const input = draft();
  await userEvent.fill(input, "Draft before opening");
  await openTool();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  expect(document.querySelector(".pwa-tool-card .pwa-tool-action")?.hasAttribute("aria-haspopup")).toBe(false);
  expect(history.state?.piReachToolReader).toBeUndefined();
  expect(draft()).toBe(input);
  expect(input.value).toBe("Draft before opening");
  await screen.getByRole("button", { name: "Return to conversation" }).click();
  await expect.poll(() => document.activeElement).toBe(input);
  await userEvent.fill(input, "Still able to send");
  await userEvent.keyboard("{Enter}");
  expect(send).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(split).toBe(false);
  expect(document.activeElement).toBe(input);
});

test("explicit clicks replace tool and text in the single panel; appended output never takes it over", async () => {
  const { screen, controls } = await mount();
  await openTool();
  await userEvent.fill(draft(), "Keep my draft");
  await userEvent.click(document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")[1]!);
  await expect.poll(() => panel().querySelector("h2")?.textContent).toBe("bash");
  expect(document.querySelectorAll(".pwa-work-panel-host .pwa-reader-portal")).toHaveLength(1);
  flushSync(() => controls.current!.append());
  expect(panel().querySelector("h2")?.textContent).toBe("bash");
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => panel().querySelector("h1")?.textContent).toBe("Reading notes");
  expect(document.querySelectorAll(".pwa-work-panel-host .pwa-reader-portal")).toHaveLength(1);
  // 可见文件卡片和阅读器各持有一份pin。
  expect(pin).toHaveBeenCalledTimes(2);
  await openTool();
  expect(unpin).toHaveBeenCalledTimes(1);
  expect(draft().value).toBe("Keep my draft");
});

test("wide to phone and back preserves the same text DOM, scroll and pin while ownership follows modal history", async () => {
  const { screen } = await mount();
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => panel().querySelector("h1")).not.toBeNull();
  const content = panel().querySelector<HTMLElement>(".pwa-file-reader-scroll")!;
  content.scrollTop = 460;
  const scroll = content.scrollTop;
  expect(scroll).toBeGreaterThan(0);
  await page.viewport(390, 844);
  await expect.element(screen.getByRole("dialog", { name: file.file_name })).toBeVisible();
  await settle();
  expect(document.querySelector(".pwa-file-reader-scroll")).toBe(content);
  expect(content.scrollTop).toBe(scroll);
  await expect.poll(() => history.state?.piReachFileReader).toBeTruthy();
  expect(pin).toHaveBeenCalledTimes(2);
  expect(unpin).not.toHaveBeenCalled();
  await page.viewport(1440, 1000);
  await expect.poll(split).toBe(true);
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => history.state?.piReachFileReader).toBeUndefined();
  expect(panel().contains(content)).toBe(true);
  expect(content.scrollTop).toBe(scroll);
  expect(unpin).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Close file reader" }).click();
  await expect.poll(split).toBe(false);
  expect(unpin).toHaveBeenCalledTimes(1);
});

test("container width, sidebar and safe areas decide fallback rather than the browser width alone", async () => {
  document.documentElement.style.setProperty("--pwa-safe-top", "24px");
  const { screen } = await mount();
  await openTool();
  expect(Math.round(panel().querySelector(".pwa-tool-reader-header")!.getBoundingClientRect().height)).toBe(48);
  await page.viewport(1100, 900);
  await expect.element(screen.getByRole("dialog", { name: "read", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Close tool details" }).click();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => history.state?.piReachToolReader).toBeUndefined();
  await screen.getByRole("button", { name: "Collapse sidebar" }).click();
  await settle();
  await openTool();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  document.documentElement.style.setProperty("--pwa-safe-left", "120px");
  document.documentElement.style.setProperty("--pwa-safe-right", "120px");
  await expect.element(screen.getByRole("dialog", { name: "read", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Close tool details" }).click();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
});

test("separator has a 44px hit region, keyboard bounds and reset, with independently scrollable columns", async () => {
  const { screen } = await mount();
  await openTool();
  const separator = screen.getByRole("separator", { name: "Resize detail panel" });
  expect(Math.round(separator.element().getBoundingClientRect().width)).toBe(44);
  separator.element().focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(separator.element().getAttribute("aria-valuenow")).toBe("464");
  await userEvent.keyboard("{Home}");
  expect(separator.element().getAttribute("aria-valuenow")).toBe("360");
  await userEvent.keyboard("{End}");
  expect(separator.element().getAttribute("aria-valuenow")).toBe(separator.element().getAttribute("aria-valuemax"));
  await screen.getByRole("button", { name: "Reset panel width" }).click();
  expect(separator.element().getAttribute("aria-valuenow")).toBe("440");
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const before = list.scrollTop;
  const content = panel().querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
  content.scrollTop = 120;
  content.dispatchEvent(new Event("scroll"));
  expect(content.scrollTop).toBe(120);
  expect(list.scrollTop).toBe(before);
  const bar = separator.element().getBoundingClientRect();
  for (const element of document.querySelectorAll<HTMLElement>(".pwa-work-panel-conversation button, .pwa-work-panel button")) {
    if (!element.getClientRects().length) continue;
    const box = element.getBoundingClientRect();
    expect(box.right <= bar.left || box.left >= bar.right).toBe(true);
  }
});

test("a top Modal owns Escape, then a later Escape closes the panel without losing valid Composer focus", async () => {
  const { screen, controls } = await mount();
  await openTool();
  flushSync(() => controls.current!.top());
  await expect.element(screen.getByRole("dialog", { name: "Top confirmation" })).toBeVisible();
  await settle();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  expect(split()).toBe(true);
  draft().focus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(split).toBe(false);
  expect(document.activeElement).toBe(draft());
});

test("scope invalidation releases a text pin, and switching actual session removes an old tool", async () => {
  const { screen, controls } = await mount();
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(split).toBe(true);
  draft().focus();
  flushSync(() => controls.current!.changeScope());
  await expect.poll(split).toBe(false);
  expect(unpin).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(draft());
  await openTool();
  flushSync(() => controls.current!.replaceSession());
  await expect.poll(split).toBe(false);
});

test("closing from the docked reader restores a visible source instead of leaving focus on body", async () => {
  const { screen } = await mount();
  await openTool();
  const origin = document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!;
  await screen.getByRole("button", { name: "Close tool details" }).click();
  await expect.poll(split).toBe(false);
  expect(document.activeElement).toBe(origin);
});

test("the same tool DOM and selection survive both layouts, and phone Back closes only the reader", async () => {
  const { screen } = await mount();
  await openTool();
  const content = panel().querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
  content.scrollTop = 320;
  const selected = content.querySelector("pre")!.firstChild!;
  window.getSelection()!.setBaseAndExtent(selected, 0, selected, 4);
  const text = window.getSelection()!.toString();
  await page.viewport(390, 844);
  await expect.element(screen.getByRole("dialog", { name: "read", exact: true })).toBeVisible();
  await settle();
  expect(document.querySelector(".pwa-tool-reader-scroll")).toBe(content);
  expect(content.scrollTop).toBe(320);
  expect(window.getSelection()!.toString()).toBe(text);
  await expect.poll(() => history.state?.piReachToolReader).toBeTruthy();
  history.back();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => history.state?.piReachToolReader).toBeUndefined();
  expect(split()).toBe(false);
});

test("rapid wide-narrow-wide-narrow migration keeps one history owner and does not close the current detail", async () => {
  const { screen } = await mount();
  await openTool();
  for (const width of [1000, 1440, 1000]) {
    await page.viewport(width, 900);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  await expect.element(screen.getByRole("dialog", { name: "read", exact: true })).toBeVisible();
  await settle();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await expect.poll(() => history.state?.piReachToolReader).toBeTruthy();
  history.back();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
});

test("changing panel width keeps the visible real timeline paragraph anchored", async () => {
  const { screen, controls } = await mount();
  flushSync(() => controls.current!.setRows([...initialItems, ...Array.from({ length: 35 }, (_, index): TimelineViewItem => ({ kind: "event", event: { ...base, group_id: `paragraph-${index}`, event_id: `paragraph-${index}`, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Paragraph ${index}. ${"Preserve this conversation reading position. ".repeat(20)}` }] } }))]));
  await openTool();
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const paragraph = screen.getByText(/^Paragraph 20\./).element();
  list.scrollTop += paragraph.getBoundingClientRect().top - list.getBoundingClientRect().top + 12;
  list.dispatchEvent(new Event("scroll"));
  await settle();
  const offset = () => Math.round(paragraph.getBoundingClientRect().top - list.getBoundingClientRect().top);
  const before = offset();
  screen.getByRole("separator").element().focus();
  await userEvent.keyboard("{Home}");
  await settle();
  expect(Math.abs(offset() - before)).toBeLessThanOrEqual(2);
  await userEvent.keyboard("{End}");
  await settle();
  expect(Math.abs(offset() - before)).toBeLessThanOrEqual(2);
});

test("a previously requested file cannot replace a later explicit tool choice when its fetch finishes", async () => {
  const { screen, controls } = await mount(true);
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await openTool();
  flushSync(() => controls.current!.ready());
  await settle();
  expect(panel().querySelector("h2")?.textContent).toBe("read");
  expect(panel().querySelector("h1")).toBeNull();
  expect(pin).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => panel().querySelector("h1")?.textContent).toBe("Reading notes");
});

test("real saved history keeps its visible paragraph anchored when a panel opens, resizes and closes", async () => {
  const saved: TimelineViewItem[] = Array.from({ length: 26 }, (_, index) => ({ kind: "event", event: { ...base, event_id: `saved-${index}`, group_id: `saved-${index}`, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Saved paragraph ${index}. ${"Keep the saved reading position while columns reflow. ".repeat(9)}` }] } }));
  saved.splice(20, 0, tool("saved-read", "read"));
  function SavedHarness() {
    const listRef = useRef<HTMLDivElement | null>(null);
    const bottomRef = useRef<HTMLDivElement | null>(null);
    return <PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout navigation={navigation} titleBar={{ title: "Saved history", prefix: "Pi Reach", showTitle: true }} historyMode toast={null} settingsRoute={{ open: false, origin: null, animate: false, change: 0 }} onOpenSettings={() => {}} onSettingsBack={() => {}} renderSettings={() => null} overlays={null} closeBackgroundOverlay={close => close()}>
      <HistoryWorkspace items={saved} listRef={listRef} bottomSentinelRef={bottomRef} />
    </PwaWorkspaceLayout></PwaAppShell>;
  }
  const screen = await render(<PwaUiProvider><SavedHarness /></PwaUiProvider>);
  await screen.getByRole("button", { name: /Read 1 file/ }).click();
  await settle();
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const paragraph = screen.getByText(/^Saved paragraph 19\./).element();
  list.scrollTop += paragraph.getBoundingClientRect().top - list.getBoundingClientRect().top + 12;
  list.dispatchEvent(new Event("scroll"));
  await settle();
  const offset = () => Math.round(paragraph.getBoundingClientRect().top - list.getBoundingClientRect().top);
  const before = offset();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!);
  await expect.poll(split).toBe(true);
  await settle();
  expect(Math.abs(offset() - before)).toBeLessThanOrEqual(2);
  screen.getByRole("separator").element().focus();
  for (const key of ["{Home}", "{End}"]) {
    await userEvent.keyboard(key);
    await settle();
    expect(Math.abs(offset() - before)).toBeLessThanOrEqual(2);
  }
  await screen.getByRole("button", { name: "Return to conversation" }).click();
  expect(document.activeElement).toBe(list);
  await screen.getByRole("button", { name: "Close tool details" }).click();
  await expect.poll(split).toBe(false);
  await settle();
  expect(Math.abs(offset() - before)).toBeLessThanOrEqual(2);
  await expect.element(screen.getByRole("textbox")).toBeDisabled();
});

test("a valid focused reader control remains focused through phone and wide migration", async () => {
  const { screen } = await mount();
  await openTool();
  const copy = screen.getByRole("button", { name: "Copy all output" }).element();
  copy.focus();
  await page.viewport(390, 844);
  await expect.element(screen.getByRole("dialog", { name: "read", exact: true })).toBeVisible();
  await settle();
  expect(document.activeElement).toBe(copy);
  expect(document.querySelector(".pwa-tool-card .pwa-tool-action")?.getAttribute("aria-haspopup")).toBe("dialog");
  await page.viewport(1440, 1000);
  await expect.poll(split).toBe(true);
  await settle();
  expect(document.activeElement).toBe(copy);
  await expect.poll(() => history.state?.piReachToolReader).toBeUndefined();
});
