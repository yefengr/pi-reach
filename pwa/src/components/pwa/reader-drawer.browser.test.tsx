import { createRef, useImperativeHandle, useMemo, useState, type Ref } from "react";
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
import { MessageList } from "./message-list";
import { MessageComposer } from "./message-composer";
import { PublishedFilesProvider, type PublishedFilesView } from "./published-files-context";
import type { WorkspaceNavigationProps } from "./workspace-view";

const navigation: WorkspaceNavigationProps = {
  devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null,
  snapshotReady: true, pairingPresence: {}, onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {},
};
const base = { session_id: "reader-drawer", leaf_id: "leaf", group_id: "group", timestamp: 1 };
const file: PublishedFileDescriptor = { publication_id: "note", file_name: "Reader notes.md", mime_type: "text/markdown", byte_length: 8000, tool_call_id: "publish" };
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
  return <PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout navigation={navigation} titleBar={{ title: "Reader drawer", prefix: "Pi Reach", showTitle: true }} historyMode={false} toast={null} settingsRoute={{ open: false, origin: null, animate: false, change: 0 }} onOpenSettings={() => {}} onSettingsBack={() => {}} renderSettings={() => null} overlays={<Modal opened={top} onClose={() => setTop(false)} title="Top confirmation" portalProps={{ target: ".pwa-root" }}><Button onClick={() => setTop(false)}>Dismiss</Button></Modal>} closeBackgroundOverlay={close => close()}>
    <PublishedFilesProvider value={view}><MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} /></PublishedFilesProvider>
    <MessageComposer draft={draft} onDraftChange={setDraft} attachments={[]} canAttach={false} sendingAttachments={false} onAddFiles={() => {}} onRemoveAttachment={() => {}} onRetryAttachment={() => {}} isOnline isWorking={false} stopping={false} onSend={send} onStop={() => {}} commandModels={[]} commandCurrentModel={null} commandCurrentModelFallback="Model" commandThinking="medium" commandPendingAction={null} onNewSession={() => {}} onCompactSession={() => {}} onSetModel={() => {}} onSetThinking={() => {}} onCommandsOpen={() => {}} />
  </PwaWorkspaceLayout></PwaAppShell>;
}
async function mount(pending = false) {
  const controls = createRef<Controls>();
  const screen = await render(<PwaUiProvider><Harness controls={controls} pending={pending} /></PwaUiProvider>);
  return { screen, controls };
}
const draft = () => document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea")!;
const reader = (selector: string) => document.querySelector<HTMLElement>(selector);
const toolReader = () => reader(".pwa-tool-reader-scroll");
const fileReader = () => reader(".pwa-file-reader-scroll");
const dialog = () => reader(".pwa-tool-reader[role='dialog'], .pwa-file-reader[role='dialog']");
const scrollLocked = () => document.body.hasAttribute("data-scroll-locked") || document.documentElement.hasAttribute("data-scroll-locked") || document.body.style.overflow === "hidden";
async function settle() {
  await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
async function openTool(index = 0) {
  for (const group of document.querySelectorAll<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head > button[aria-expanded='false']")) await userEvent.click(group);
  const button = document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")[index]!;
  await userEvent.click(button);
  await expect.poll(() => toolReader()).not.toBeNull();
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

test("desktop opens the reader as a 720px modal Drawer instead of a second column", async () => {
  const { screen } = await mount();
  const input = draft();
  await userEvent.fill(input, "Draft before opening");
  await openTool();
  const surface = dialog()!;
  expect(surface).not.toBeNull();
  expect(Math.round(surface.getBoundingClientRect().width)).toBe(720);
  expect(document.querySelector(".pwa-scrim")).not.toBeNull();
  expect(scrollLocked()).toBe(true);
  expect(history.state?.piReachToolReader).toBe(true);
  expect(document.querySelector(".pwa-tool-card .pwa-tool-action")?.getAttribute("aria-haspopup")).toBe("dialog");
  expect(document.querySelector(".pwa-work-panel, .pwa-work-panel-layout")).toBeNull();
  // 抽屉打开时焦点在阅读器内，遮罩隔开对话；草稿不被卸载。
  expect(surface.contains(document.activeElement)).toBe(true);
  expect(draft()).toBe(input);
  expect(input.value).toBe("Draft before opening");
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  await expect.poll(() => history.state?.piReachToolReader).toBeUndefined();
  expect(scrollLocked()).toBe(false);
  expect(draft().value).toBe("Draft before opening");
});

test.each([1440, 390])("a running tool keeps one reader body and follows completion at %ipx", async width => {
  await page.viewport(width, 1000);
  const { screen, controls } = await mount();
  const running = { kind: "partial", createdAt: 2, partial: {
    protocol_version: 2, type: "timeline_partial", ...base, partial_id: "tool:stream", kind: "tool",
    tool_call_id: "stream", tool: "bash", args: { command: "fixed fixture" }, status: "delta", blocks: [{ type: "text", text: "First output" }],
  } } satisfies TimelineViewItem;
  flushSync(() => controls.current!.setRows([running]));
  const group = document.querySelector<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head > button")!;
  await userEvent.click(group);
  const source = document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!;
  await userEvent.click(source);
  await expect.poll(toolReader).not.toBeNull();
  await settle();
  const body = toolReader()!;
  flushSync(() => controls.current!.setRows([{ ...running, partial: { ...running.partial, blocks: [{ type: "text", text: "Later output" }] } }]));
  await expect.poll(() => body.querySelector(".pwa-reader-text")?.textContent).toBe("Later output");
  const completed: TimelineViewItem = { kind: "event", event: {
    ...base, leaf_id: "completed-leaf", event_id: "stream-result", kind: "tool", tool_call_id: "stream", tool: "bash",
    args: { command: "fixed fixture" }, status: "complete", truncated: false, result: [{ type: "text", text: "Complete output" }],
  } };
  flushSync(() => controls.current!.setRows([completed]));
  await expect.poll(() => toolReader()?.querySelector(".pwa-reader-text")?.textContent).toBe("Complete output");
  expect(toolReader()).toBe(body);
  expect(document.querySelector(".pwa-tool-card .pwa-tool-action")).toBe(source);
  expect(group.getAttribute("aria-expanded")).toBe("true");
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(toolReader).toBeNull();
});

test("appended output never takes over the open reader and the single reader keeps one pin", async () => {
  const { screen, controls } = await mount();
  await openTool();
  expect(toolReader()?.closest(".pwa-tool-reader")?.querySelector("h2")?.textContent).toBe("read");
  flushSync(() => controls.current!.append());
  expect(dialog()?.querySelector("h2")?.textContent).toBe("read");
  expect(document.querySelectorAll(".pwa-tool-reader[role='dialog']")).toHaveLength(1);
  // 可继续在遮罩外读取的只有阅读器本身；关闭后草稿仍在。
  await settle();
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  await userEvent.click(document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")[1]!);
  await expect.poll(() => dialog()?.querySelector("h2")?.textContent).toBe("bash");
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
});

test("a late file result does not replace an open tool reader", async () => {
  const { screen, controls } = await mount(true);
  // 获取中不会提前挂载阅读器；只有完成后的明确点击才展开。
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await openTool();
  flushSync(() => controls.current!.ready());
  await settle();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("read");
  expect(fileReader()).toBeNull();
  // 可见文件卡片自持一份 pin；阅读器随点击才引用。
  expect(pin).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => fileReader()?.querySelector("h1")?.textContent).toBe("Reading notes");
  expect(pin).toHaveBeenCalledTimes(2);
  await screen.getByRole("button", { name: "Close file reader", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  await expect.poll(() => unpin).toHaveBeenCalledTimes(1);
});

test("scope invalidation releases the text pin and switching session removes the reader", async () => {
  const { screen, controls } = await mount();
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(fileReader).not.toBeNull();
  flushSync(() => controls.current!.changeScope());
  await expect.poll(dialog).toBeNull();
  expect(unpin).toHaveBeenCalledTimes(1);
  await openTool();
  flushSync(() => controls.current!.replaceSession());
  await expect.poll(dialog).toBeNull();
  expect(fileReader()).toBeNull();
});

test("a top Modal owns Escape, then the next Escape closes the reader", async () => {
  const { screen, controls } = await mount();
  await openTool();
  const origin = document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!;
  flushSync(() => controls.current!.top());
  await expect.element(screen.getByRole("dialog", { name: "Top confirmation" })).toBeVisible();
  await settle();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("dialog", { name: "Top confirmation" })).not.toBeInTheDocument();
  expect(dialog()).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(dialog).toBeNull();
  await expect.poll(() => document.activeElement).toBe(origin);
});

test("system Back closes only the reader and keeps the transfer unpinned", async () => {
  const { screen } = await mount();
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(fileReader).not.toBeNull();
  const body = fileReader()!;
  body.scrollTop = 240;
  await expect.poll(() => history.state?.piReachFileReader).toBe(true);
  history.back();
  await expect.poll(dialog).toBeNull();
  await expect.poll(() => history.state?.piReachFileReader).toBeUndefined();
  expect(document.querySelector(".pwa-file-reader-scroll")).toBeNull();
  expect(unpin).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".pwa-composer textarea")).not.toBeNull();
});

test("mobile keeps the full-screen reader with a back arrow", async () => {
  await page.viewport(390, 844);
  const { screen } = await mount();
  await openTool();
  const surface = dialog()!;
  expect(Math.round(surface.getBoundingClientRect().width)).toBe(390);
  expect(surface.querySelector(".pwa-topbar-back")).not.toBeNull();
  expect(surface.querySelector(".pwa-tool-reader-close")).not.toBeNull();
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
});

test("sidebar collapse and container width never bring the second column back", async () => {
  const { screen } = await mount();
  await openTool();
  expect(Math.round(dialog()!.getBoundingClientRect().width)).toBe(720);
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  await screen.getByRole("button", { name: "Collapse sidebar" }).click();
  await settle();
  await openTool();
  expect(Math.round(dialog()!.getBoundingClientRect().width)).toBe(720);
  await page.viewport(1100, 900);
  await settle();
  expect(Math.round(dialog()!.getBoundingClientRect().width)).toBe(720);
  expect(document.querySelector(".pwa-work-panel, .pwa-work-panel-layout")).toBeNull();
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
});

test("closing restores a visible source instead of leaving focus on body", async () => {
  const { screen } = await mount();
  await openTool();
  const origin = document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!;
  await screen.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  await expect.poll(() => document.activeElement).toBe(origin);
});

test("viewport changes keep the same reader DOM, scroll and focused control", async () => {
  const { screen } = await mount();
  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(fileReader).not.toBeNull();
  await expect.poll(() => fileReader()?.querySelector("h1")?.textContent).toBe("Reading notes");
  await settle();
  const content = fileReader()!;
  content.scrollTop = 460;
  const scroll = content.scrollTop;
  expect(scroll).toBeGreaterThan(0);
  const save = dialog()!.querySelector<HTMLAnchorElement>("a[download]")!;
  save.focus();
  await page.viewport(390, 844);
  await expect.element(screen.getByRole("dialog", { name: file.file_name, exact: true })).toBeVisible();
  await settle();
  expect(fileReader()).toBe(content);
  expect(content.scrollTop).toBe(scroll);
  expect(document.activeElement).toBe(save);
  await page.viewport(1440, 1000);
  await settle();
  expect(fileReader()).toBe(content);
  expect(content.scrollTop).toBe(scroll);
  expect(document.activeElement).toBe(save);
  await screen.getByRole("button", { name: "Close file reader", exact: true }).click();
  await expect.poll(dialog).toBeNull();
  expect(unpin).toHaveBeenCalledTimes(1);
});
