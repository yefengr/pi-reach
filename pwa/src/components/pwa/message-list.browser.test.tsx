import { createRef, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { MessageList } from "./message-list";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import { TimelineRuntime, type TimelinePending, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";

type ListProps = Parameters<typeof MessageList>[0];
const toolEvent: Extract<TimelineEvent, { kind: "tool" }> = {
  event_id: "event-1", session_id: "session-1", leaf_id: "history-1", timestamp: 0,
  group_id: "group-1", kind: "tool", tool_call_id: "tool-1", tool: "read", args: {}, truncated: false, status: "complete", result: {},
};
const unknownPending: TimelinePending = {
  kind: "pending", id: "pending-1", clientRequestId: "request-1", requestId: "request-1", text: "Retry me", createdAt: 0, delivery: "unknown_delivery",
};
const assistantEvent: Extract<TimelineEvent, { kind: "assistant" }> = {
  event_id: "answer", session_id: "session-1", leaf_id: "history-1", timestamp: 1, group_id: "group-1",
  kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: "Inspecting the request." }, { type: "text", text: "**The final answer.**" }],
};
const toolPartial: Extract<TimelinePartial, { kind: "tool" }> = {
  protocol_version: 2, type: "timeline_partial", session_id: toolEvent.session_id, leaf_id: toolEvent.leaf_id,
  group_id: toolEvent.group_id, kind: "tool", partial_id: "tool:tool-1", tool_call_id: toolEvent.tool_call_id, tool: "read", args: { path: "README.md" }, status: "running",
  blocks: [{ type: "text", text: "Streaming output" }],
};
function eventItem(event: TimelineEvent): TimelineViewItem { return { kind: "event", event }; }
function runEndItem(): TimelineViewItem {
  return eventItem({ event_id: "run-end", session_id: toolEvent.session_id, leaf_id: toolEvent.leaf_id, group_id: toolEvent.group_id, timestamp: 10, kind: "run_end", status: "complete" });
}
function partialItem(partial: TimelinePartial): TimelineViewItem { return { kind: "partial", createdAt: 0, partial }; }
function toolButton(index = 0): HTMLButtonElement { return document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")[index]!; }
function groupButton(index = 0): HTMLButtonElement { return document.querySelectorAll<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head .pwa-tool-action")[index]!; }
async function closeReader(key: "escape" | "history" = "escape") {
  await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
  if (key === "history") window.history.back();
  else await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => window.history.state?.piReachToolReader === true).toBe(false);
}
afterEach(async () => { await page.viewport(1280, 900); });

async function liveList(initial: TimelineViewItem[], overrides: Partial<ListProps> = {}) {
  let setItems!: (items: TimelineViewItem[]) => void;
  function Harness() {
    const [items, update] = useState(initial);
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    setItems = update;
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}><MessageList items={items} hasEarlier={false} listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} {...overrides} /></main>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, update: async (items: TimelineViewItem[]) => { flushSync(() => setItems(items)); } };
}
function renderMessageList(items: ListProps["items"], overrides: Partial<ListProps> = {}) {
  return renderPwa(<MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} onRetryUnknown={() => {}} onCancelQueued={() => {}} {...overrides} />);
}

test("supplements a readonly historical user row when metadata arrives after the message", async () => {
  const user: TimelineEvent = { event_id: "message", message_id: "message", group_id: "group", session_id: "session-1", leaf_id: "user-leaf", timestamp: 2, kind: "user", blocks: [{ type: "text", text: "Server fallback notes.txt" }], sender_ref: "owner", origin: "pwa", delivery: "normal", status: "committed" };
  const metadata: TimelineEvent = { event_id: "metadata", session_id: "session-1", leaf_id: "metadata-leaf", timestamp: 1, kind: "custom", truncated: false, payload: { custom_type: "pi-reach:attachments-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", text: "Original text", attachments: [{ attachment_id: "file", file_name: "notes.txt", mime_type: "text/plain", byte_length: 1024, sha256: "a".repeat(64) }] } } };
  const binding: TimelineEvent = { ...metadata, event_id: "binding", leaf_id: "binding-leaf", payload: { custom_type: "pi-reach:attachment-message-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", message_id: "message" } } };
  const { screen, update } = await liveList([eventItem(user)], { isLive: false });
  await expect.element(screen.getByText("Server fallback notes.txt")).toBeVisible();
  await update([eventItem(metadata), eventItem(binding), eventItem(user)]);
  await expect.element(screen.getByText("Original text")).toBeVisible();
  await expect.element(screen.getByText("notes.txt", { exact: true })).toBeVisible();
  expect(document.querySelector(".pwa-attachment-cards button")).toBeNull();
  await expect.element(screen.getByText("Server fallback notes.txt")).not.toBeInTheDocument();
});

test("thinking is independently collapsed and keyboard toggling leaves the answer visible", async () => {
  const screen = await renderMessageList([eventItem(assistantEvent)]);
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  const toggle = document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!;
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  expect(document.querySelector(".pwa-thinking .pwa-text-plain")).not.toBeNull();
  expect(document.querySelector(".pwa-thinking .pwa-tool-code")).toBeNull();
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  await userEvent.keyboard(" ");
  await expect.element(screen.getByText("Inspecting the request.")).not.toBeInTheDocument();
});

test("a thinking row is titled by its first bold heading and falls back to the localized label", async () => {
  const titled: TimelineEvent = { ...assistantEvent, blocks: [{ type: "thinking", text: "**Checking the group rules**\nInspecting the request." }, { type: "text", text: "The final answer." }] };
  const screen = await renderMessageList([eventItem(titled)]);
  await expect.element(screen.getByText("Checking the group rules")).toBeVisible();
  await expect.element(screen.getByText("Thought process")).not.toBeInTheDocument();
  expect(document.querySelector(".pwa-thinking-live")).toBeNull();
});

test("a streaming thinking row shows the latest heading with a live indicator", async () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "**First step**\nA.\n\n**Second step**\nB." };
  const { screen } = await liveList([partialItem(thinking)]);
  await expect.element(screen.getByText("Second step")).toBeVisible();
  await expect.element(screen.getByText("First step")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("status").getByText("Thinking")).toBeVisible();
});

test("thinking, tool groups and reader merge their reading locks until the final reader exit", async () => {
  const reading: boolean[] = [];
  const second = eventItem({ ...toolEvent, event_id: "second", tool_call_id: "second" });
  const { screen, update } = await liveList([eventItem(assistantEvent), eventItem(toolEvent), second, runEndItem()], { onReadingChange: value => reading.push(value) });
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(true);
  await userEvent.click(toolButton());
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await closeReader();
  expect(reading.at(-1)).toBe(true);
  // 组折叠后仍有展开的思考，读锁不能提早释放。
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(true);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
  expect(reading.at(-1)).toBe(false);
  await userEvent.click(groupButton());
  await userEvent.click(toolButton());
  // 移除整个组，只留思考；Reader 退出完成后才清掉最后一个读锁并回焦列表。
  await update([eventItem(assistantEvent)]);
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => reading.at(-1)).toBe(false);
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  await update([]);
  expect(reading.at(-1)).toBe(false);
});

test("streaming thinking starts collapsed and keeps a manual choice in the formal answer", async () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "Inspecting the request." };
  const { screen, update } = await liveList([partialItem(thinking)]);
  await expect.element(screen.getByText("Thought process")).toBeVisible();
  await expect.element(screen.getByRole("status").getByText("Thinking")).toBeVisible();
  await expect.element(screen.getByText("Inspecting the request.")).not.toBeInTheDocument();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
  const toggle = document.querySelector(".pwa-thinking .pwa-timeline-toggle");
  await update([eventItem(assistantEvent)]);
  expect(document.querySelector(".pwa-thinking .pwa-timeline-toggle")).toBe(toggle);
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  await expect.element(screen.getByText("Thought process")).toBeVisible();
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
});

test("streaming text keeps its timeline identity and reserved rows when it becomes formal", async () => {
  const partial: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:assistant:1", kind: "assistant", status: "delta", blocks: [{ type: "text", text: "Still writing" }] };
  const { screen, update } = await liveList([partialItem(partial)]);
  const row = document.querySelector<HTMLElement>("article[data-timeline-key]")!;
  const rowHeight = Math.round(row.getBoundingClientRect().height);
  expect(row.dataset.timelineKey).toContain("answer");
  expect(row.querySelector("time")).toBeNull();
  expect(row.querySelector(".pwa-message-label")).toBeNull();
  await update([eventItem(assistantEvent)]);
  expect(document.querySelector("article[data-timeline-key]")).toBe(row);
  expect(Math.round(row.getBoundingClientRect().height)).toBe(rowHeight);
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
});

test("all tool states show only titles and status, never input, output, images or errors inline", async () => {
  const failed: TimelineEvent = { ...toolEvent, event_id: "failed", tool_call_id: "failed", status: "error", error: "Permission denied" };
  const interrupted: TimelineEvent = { event_id: "interrupted", tool_call_id: "interrupted", session_id: toolEvent.session_id, leaf_id: toolEvent.leaf_id, group_id: toolEvent.group_id, timestamp: 2, kind: "tool", tool: "bash", args: { command: "sleep 10" }, truncated: false, status: "interrupted" };
  const custom: TimelineEvent = { ...toolEvent, event_id: "custom", tool_call_id: "custom", tool: "custom", result: { secretPreview: "not visible" } };
  const image: TimelineEvent = { ...toolEvent, tool_call_id: "image", event_id: "image", tool: "write", args: { path: "file.txt", content: "INPUT_MARKER" }, result: [{ type: "image", mimeType: "image/png", data: "IMAGE_MARKER" }] };
  const { screen } = await liveList([partialItem(toolPartial), eventItem({ ...toolEvent, tool_call_id: "complete", result: "Finished" }), eventItem(failed), eventItem(interrupted), eventItem(custom), eventItem(image)]);
  expect(document.querySelectorAll(".pwa-tool-card")).toHaveLength(6);
  for (const action of document.querySelectorAll(".pwa-tool-card .pwa-tool-action")) {
    expect(action.hasAttribute("aria-expanded")).toBe(false);
    expect(action.hasAttribute("aria-controls")).toBe(false);
    expect(action.getAttribute("aria-haspopup")).toBe("dialog");
    expect(action.querySelector(".pwa-tool-chevron")).toBeNull();
  }
  const list = document.querySelector(".pwa-message-list")!;
  for (const hidden of ["Streaming output", "Permission denied", "Finished", "Tool execution was interrupted.", "not visible", "INPUT_MARKER", "IMAGE_MARKER"]) expect(list.textContent).not.toContain(hidden);
  expect(list.querySelector("pre, img, .pwa-tool-details, .pwa-tool-preview")).toBeNull();
  await expect.element(screen.getByRole("status", { name: "read: Error" })).toBeVisible();
  await expect.element(screen.getByRole("status", { name: "bash: Interrupted" })).toBeVisible();
});

test("one keyboard action opens live output and partial updates and formalization keep the reader open", async () => {
  const reading: boolean[] = [];
  const { screen, update } = await liveList([partialItem(toolPartial)], { onReadingChange: value => reading.push(value) });
  await update([partialItem({ ...toolPartial, blocks: [{ type: "text", text: "New live output" }] })]);
  await expect.element(screen.getByText("New live output")).not.toBeInTheDocument();
  const origin = toolButton();
  expect(origin.getAttribute("aria-label")).toBe("View read tool details");
  origin.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByText("New live output")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  await update([partialItem({ ...toolPartial, blocks: [{ type: "text", text: "Additional live output" }] })]);
  await expect.element(screen.getByText("Additional live output")).toBeVisible();
  const completed: TimelineEvent = { ...toolEvent, args: toolPartial.args!, result: "Final file content" };
  await update([eventItem(completed)]);
  expect(toolButton()).toBe(origin);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByText("Final file content")).toBeVisible();
  expect(document.querySelector(".pwa-tool-card .pwa-tool-status-complete")?.textContent).toBe("");
  await closeReader();
  await expect.poll(() => document.activeElement).toBe(origin);
  expect(reading.at(-1)).toBe(false);
  await update([eventItem({ ...toolEvent, status: "error", error: "Permission denied" })]);
  expect(document.querySelector(".pwa-tool-card .pwa-tool-status-error")?.textContent).toBe("Error");
  await expect.element(screen.getByText("Permission denied")).not.toBeInTheDocument();
  await userEvent.click(toolButton());
  await expect.element(screen.getByText("Permission denied")).toBeVisible();
  expect(document.querySelectorAll(".pwa-tool-card")).toHaveLength(1);
  await closeReader();
});

test("parallel completion preserves timeline order and reader content while other tools become a collapsed group", async () => {
  const before = { ...assistantEvent, event_id: "before", blocks: [{ type: "text" as const, text: "Before tools" }] };
  const between = { ...assistantEvent, event_id: "between", blocks: [{ type: "text" as const, text: "Between tools" }] };
  const laterTools = Array.from({ length: 6 }, (_, index) => eventItem({ ...toolEvent, event_id: `later-${index}`, tool_call_id: `later-${index}`, tool: "bash", args: { command: `echo ${index}` }, result: `Output ${index}` }));
  const { screen, update } = await liveList([eventItem(before), partialItem(toolPartial), eventItem(between), ...laterTools]);
  const originalOrder = [...document.querySelectorAll(".pwa-message-list > article")];
  expect(document.querySelectorAll(".pwa-tool-action")).toHaveLength(7);
  await userEvent.click(toolButton());
  await update([eventItem(before), eventItem(between), ...laterTools, eventItem({ ...toolEvent, args: toolPartial.args!, result: "Read completed last" }), runEndItem()]);
  expect([...document.querySelectorAll(".pwa-message-list > article")].slice(0, 3)).toEqual(originalOrder.slice(0, 3));
  expect(groupButton().getAttribute("aria-expanded")).toBe("false");
  await expect.element(screen.getByText("Read completed last")).toBeVisible();
  await closeReader();
  await userEvent.click(groupButton());
  await expect.poll(() => document.querySelectorAll(".pwa-tool-group .pwa-tool-card").length).toBe(6);
  expect(document.querySelectorAll(".pwa-tool-group .pwa-tool-action[aria-haspopup='dialog']")).toHaveLength(6);
  expect(document.querySelector(".pwa-tool-group .pwa-tool-preview")).toBeNull();
});

test.each(["history-replacement", "empty"])("tool removal closes the reader and releases its reading lock (%s)", async removal => {
  const runtime = new TimelineRuntime();
  runtime.setScope({ deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: toolEvent.session_id, leafId: toolEvent.leaf_id, selfSenderRef: "self", channelId: "channel" });
  let updateItems!: (items: TimelineViewItem[]) => void;
  let viewport!: ReturnType<typeof useTimelineViewport>;
  const reading: boolean[] = [];
  const initial = runtime.commit(toolEvent).items;
  function Harness() {
    const [items, setItems] = useState(initial);
    updateItems = setItems;
    viewport = useTimelineViewport();
    return <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={value => { viewport.setReadingDetails(value); reading.push(value); }} />;
  }
  const screen = await renderPwa(<Harness />);
  await userEvent.click(toolButton());
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  expect(viewport.followingOutput).toBe(true);
  await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
  const change = runtime.replaceHistory(removal === "empty" ? [] : [assistantEvent]);
  flushSync(() => updateItems(change.items));
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => reading.at(-1)).toBe(false);
  await expect.poll(() => window.history.state?.piReachToolReader === true).toBe(false);
  if (removal !== "empty") expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  const list = viewport.messageListRef.current!;
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, writable: true, value: 600 } });
  flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  flushSync(() => viewport.receiveRealtimeOutput("after-history"));
  expect(viewport.unreadOutput).toBe(0);
});

test("an offline partial has an unknown status and hides its content until opened", async () => {
  const screen = await renderMessageList([partialItem(toolPartial)], { isLive: false });
  await expect.element(screen.getByRole("status", { name: "read: Status unknown" })).toBeVisible();
  await expect.element(screen.getByText("Streaming output")).not.toBeInTheDocument();
  expect(toolButton().getAttribute("aria-label")).toBe("View read tool details");
});

test("a repeated tool id in another session cannot inherit the old reader", async () => {
  const reading: boolean[] = [];
  const { screen, update } = await liveList([eventItem({ ...toolEvent, result: "Old session output" })], { onReadingChange: value => reading.push(value) });
  await userEvent.click(toolButton());
  await expect.element(screen.getByText("Old session output")).toBeVisible();
  await update([eventItem({ ...toolEvent, session_id: "other-session", result: "New session output" })]);
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => reading.at(-1)).toBe(false);
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  expect(document.querySelector(".pwa-message-list")?.textContent).not.toContain("New session output");
});

test("images and structured output appear only in the direct reader without raw-data tabs", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const screen = await renderMessageList([eventItem({ ...toolEvent, args: { path: "image.png" }, result: [{ type: "text", text: "Image result" }, { type: "image", mimeType: "image/png", data: png }] })]);
  expect(document.querySelector(".pwa-message-list img")).toBeNull();
  await userEvent.click(toolButton());
  await expect.element(screen.getByRole("dialog").getByRole("img", { name: "Tool output image 2" })).toBeVisible();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(document.querySelector(".pwa-message-list")?.textContent).not.toContain(png);
  await closeReader();
  await screen.unmount();
  const fallback = await renderMessageList([eventItem({ ...toolEvent, tool: "custom", result: { files: 3, ok: true } })]);
  await userEvent.click(toolButton());
  expect(document.querySelector(".pwa-tool-reader-scroll")?.textContent).toContain('"files": 3');
  expect(document.body.textContent).not.toContain("Raw data");
  await expect.element(fallback.getByRole("button", { name: /^View all/ })).not.toBeInTheDocument();
  await closeReader();
});

test.each([1280, 390])("one click opens short output or complete long write input and restores layout, scroll and focus at %ipx", async width => {
  await page.viewport(width, 844);
  const calls: TimelineEvent[] = [
    { ...toolEvent, args: { path: ".pi/tmp/logs/check.exit" }, result: "SHORT_EXIT_OUTPUT" },
    { ...toolEvent, tool: "write", args: { path: `src/${"directory/".repeat(30)}file.ts`, content: `${"long-input\n".repeat(120)}FINAL_WRITE_LINE` }, result: "Wrote file" },
  ];
  const { screen, update } = await liveList([eventItem(calls[0])]);
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  for (let index = 0; index < calls.length; index += 1) {
    await update([eventItem(calls[index])]);
    const origin = toolButton();
    origin.focus();
    const scrollTop = list.scrollTop;
    expect(list.querySelector(".pwa-tool-preview")).toBeNull();
    await userEvent.click(origin);
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const reader = document.querySelector<HTMLElement>(".pwa-tool-reader")!;
    const readerWidth = width >= 768 ? 720 : width;
    await expect.poll(() => Math.round(reader.getBoundingClientRect().right)).toBe(width);
    expect(Math.round(reader.getBoundingClientRect().left)).toBe(width - readerWidth);
    expect(Math.round(reader.getBoundingClientRect().width)).toBe(readerWidth);
    expect(Math.round(reader.getBoundingClientRect().height)).toBe(844);
    expect(document.querySelector(".pwa-root")?.contains(reader)).toBe(true);
    const detailScroll = reader.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    expect(detailScroll.textContent).toContain(index === 0 ? "SHORT_EXIT_OUTPUT" : "FINAL_WRITE_LINE");
    if (index === 1) {
      detailScroll.scrollTop = detailScroll.scrollHeight;
      expect(detailScroll.scrollTop).toBeGreaterThan(0);
      expect(Math.round(detailScroll.scrollTop + detailScroll.clientHeight)).toBe(Math.round(detailScroll.scrollHeight));
    }
    await closeReader(index === 0 ? "escape" : "history");
    await expect.poll(() => document.activeElement).toBe(origin);
    expect(list.scrollTop).toBe(scrollTop);
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    expect(origin.hasAttribute("aria-expanded")).toBe(false);
  }
});

test.each([1280, 390])("reply and tools align while thinking retains its own chevron and typography in both themes at %ipx", async width => {
  await page.viewport(width, 844);
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const { screen } = await liveList([
    eventItem({ ...assistantEvent, blocks: [{ type: "text", text: "我会检查 `timeline`，每次工具调用独立显示。" }, { type: "thinking", text: "先核对路径，再检查输出。" }] }),
    eventItem({ ...toolEvent, args: { path: `src/${"directory/".repeat(30)}file.ts`, offset: 200, limit: 60 } }),
    partialItem({ ...toolPartial, tool: "bash", tool_call_id: "running", partial_id: "tool:running", args: { command: `pnpm build\n${"long-argument ".repeat(50)}` } }),
    eventItem({ ...toolEvent, tool: "edit", tool_call_id: "failed", event_id: "failed", args: { path: "src/component.tsx" }, status: "error", error: "Hidden error details" }),
  ]);
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      const replyLeft = Math.round(document.querySelector(".pwa-message.assistant .pwa-markdown")!.getBoundingClientRect().left);
      for (const action of document.querySelectorAll<HTMLElement>(".pwa-tool-action")) {
        const rect = action.getBoundingClientRect();
        expect(Math.round(rect.height)).toBe(44);
        expect(Math.round(rect.left)).toBe(replyLeft);
        expect(Math.round(rect.right)).toBeLessThanOrEqual(width);
        expect(action.hasAttribute("aria-expanded")).toBe(false);
        expect(action.querySelector(".pwa-tool-chevron")).toBeNull();
        expect(getComputedStyle(action.querySelector(".pwa-tool-action-copy")!).whiteSpace).toBe("nowrap");
      }
      for (const label of document.querySelectorAll(".pwa-thinking-title, .pwa-tool-action-copy strong")) {
        expect(getComputedStyle(label).fontSize).toBe("16px");
        expect(getComputedStyle(label).fontStyle).toBe("normal");
        expect(getComputedStyle(label).fontWeight).toBe("600");
      }
      expect(Math.round(document.querySelector(".pwa-tool-action-copy strong")!.getBoundingClientRect().left)).toBe(replyLeft);
      const thinking = document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!;
      // 思考与工具行一样：标题与 Pi 回复左缘对齐，折叠箭头在行右侧。
      expect(Math.round(document.querySelector(".pwa-thinking-title")!.getBoundingClientRect().left)).toBe(replyLeft);
      expect(Math.round(thinking.querySelector(".pwa-timeline-chevron")!.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(thinking.getBoundingClientRect().right));
      expect(Math.round(thinking.querySelector(".pwa-timeline-chevron")!.getBoundingClientRect().left)).toBeGreaterThan(Math.round(document.querySelector(".pwa-thinking-title")!.getBoundingClientRect().right) - 1);
      for (const card of document.querySelectorAll(".pwa-tool-card")) {
        expect(getComputedStyle(card).borderTopWidth).toBe("0px");
        expect(getComputedStyle(card).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      }
      const list = document.querySelector(".pwa-message-list")!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      await expect.element(screen.getByText("Hidden error details")).not.toBeInTheDocument();
    }
    await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
    // 展开内容不整块缩进：左侧 2px 竖线（与引用同色）加 12px 内边距，竖线贴齐标题左缘。
    const quote = document.querySelector<HTMLElement>(".pwa-thinking .pwa-long-text")!;
    expect(Math.round(quote.getBoundingClientRect().left)).toBe(Math.round(document.querySelector(".pwa-thinking-title")!.getBoundingClientRect().left));
    expect(getComputedStyle(quote).borderLeftWidth).toBe("2px");
    expect(Math.round(document.querySelector(".pwa-thinking .pwa-text-plain")!.getBoundingClientRect().left)).toBe(Math.round(quote.getBoundingClientRect().left) + 14);
    await expect.poll(() => getComputedStyle(document.querySelector(".pwa-thinking .pwa-timeline-chevron")!).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test.each([1280, 390])("tool groups have a right chevron, no group check and clickable title-only children in both themes at %ipx", async width => {
  await page.viewport(width, 844);
  const calls: Extract<TimelineEvent, { kind: "tool" }>[] = [
    { ...toolEvent, args: { path: ".pi/tmp/logs/check.exit" }, result: "0\n" },
    { ...toolEvent, event_id: "source", tool_call_id: "source", args: { path: "src/status.ts" }, result: "const status = 'ready';" },
    { ...toolEvent, event_id: "command", tool_call_id: "command", tool: "bash", args: { command: "pnpm test" }, result: "Tests passed: 12\nAll checks passed." },
    { ...toolEvent, event_id: "write", tool_call_id: "write", tool: "write", args: { path: "src/settings.ts", content: "export const enabled = true;" }, result: "Wrote file" },
    { ...toolEvent, event_id: "edit", tool_call_id: "edit", tool: "edit", args: { path: "src/settings.ts", oldText: "enabled = false", newText: "enabled = true" }, result: "Successfully replaced text" },
  ];
  const { screen } = await liveList([...calls.map(eventItem), runEndItem()]);
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const group = groupButton();
  expect(group.textContent).toBe("Read 2 files · Ran 1 command · Wrote 1 file · Edited 1 file");
  expect(group.querySelector(".pwa-tool-status, .lucide-check")).toBeNull();
  expect(group.getAttribute("aria-expanded")).toBe("false");
  group.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelectorAll(".pwa-tool-group .pwa-tool-card").length).toBe(calls.length);
  // 展开的子项不整块缩进：左侧 2px 竖线（与引用同色）加 12px 内边距，与思考展开内容同一规则。
  const detailsInner = document.querySelector<HTMLElement>(".pwa-tool-group-details > .pwa-collapse-inner")!;
  expect(getComputedStyle(detailsInner).borderLeftWidth).toBe("2px");
  await expect.poll(() => Math.round(detailsInner.getBoundingClientRect().left)).toBe(Math.round(group.getBoundingClientRect().left));
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      // 旋转中 SVG 的包围盒会暂时变宽；等待最终姿态后再检查布局，不放宽几何容差。
      await expect.poll(() => getComputedStyle(group.querySelector(".pwa-tool-chevron")!).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
      const arrow = group.querySelector(".pwa-tool-chevron")!.getBoundingClientRect();
      const summary = group.querySelector(".pwa-tool-group-summary")!.getBoundingClientRect();
      expect(Math.round(arrow.left)).toBeGreaterThanOrEqual(Math.round(summary.right));
      // 亚像素取整可能相差 1px。
      expect(Math.abs(Math.round(arrow.right) - (Math.round(group.getBoundingClientRect().right) - 6))).toBeLessThanOrEqual(1);
      expect(group.querySelector("[role='status']")).toBeNull();
      expect(document.querySelectorAll(".pwa-tool-group .pwa-tool-status-complete")).toHaveLength(calls.length);
      const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
      expect(list.querySelector(".pwa-tool-content, .pwa-tool-preview, .pwa-tool-details")).toBeNull();
      expect(list.textContent).not.toContain("Requested changes");
      expect(list.textContent).not.toContain("Tests passed: 12");
      for (const action of document.querySelectorAll<HTMLElement>(".pwa-tool-card .pwa-tool-action")) {
        expect(Math.round(action.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        expect(action.hasAttribute("aria-expanded")).toBe(false);
      }
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      await userEvent.click(toolButton(4));
      // 阅读器首块原样列出参数，正文只放真实结果，不再拼出请求修改。
      await expect.element(screen.getByText("Successfully replaced text")).toBeVisible();
      expect(document.querySelector(".pwa-tool-reader-command")?.textContent).toBe("path: src/settings.ts\noldText: enabled = false\nnewText: enabled = true");
      expect(document.querySelector(".pwa-tool-reader-scroll")!.textContent).not.toContain("Requested changes");
      expect(document.querySelector(".pwa-tool-reader-scroll .hljs")).toBeNull();
      await closeReader();
      expect(document.activeElement).toBe(toolButton(4));
      expect(group.getAttribute("aria-expanded")).toBe("true");
    }
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test("finished-turn grouping waits for the open reader, then groups and falls back to list focus", async () => {
  const first = { ...toolEvent, args: { path: "a.ts" }, result: "First output" };
  const second = { ...toolEvent, event_id: "second", tool_call_id: "second", args: { path: "b.ts" }, result: "Second output" };
  const running = { ...toolPartial, partial_id: "tool:third", tool_call_id: "third", args: { path: "c.ts" } };
  const reading: boolean[] = [];
  const { screen, update } = await liveList([eventItem(first), eventItem(second), partialItem(running)], { onReadingChange: value => reading.push(value) });
  const origin = toolButton();
  await userEvent.click(origin);
  await expect.element(screen.getByText("First output")).toBeVisible();
  await update([eventItem(first), eventItem(second), eventItem({ ...toolEvent, event_id: "third", tool_call_id: "third", args: { path: "c.ts" }, result: "Third output" }), runEndItem()]);
  // 阅读器打开期间不合并：触发行仍在，阅读内容不变。
  expect(document.querySelector(".pwa-tool-group")).toBeNull();
  expect(origin.isConnected).toBe(true);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByText("First output")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  await closeReader("history");
  await expect.poll(() => reading.at(-1)).toBe(false);
  // 退出后合并生效，原触发行收入组内，焦点回到列表。
  await expect.poll(() => document.querySelector(".pwa-tool-group")).not.toBeNull();
  expect(groupButton().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  await userEvent.click(groupButton());
  await userEvent.click(toolButton());
  await expect.element(screen.getByText("First output")).toBeVisible();
  await closeReader();
});

test("reduced motion keeps the running indicator and uses a short reader fade", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    const { screen } = await liveList([partialItem(toolPartial)]);
    expect(getComputedStyle(document.querySelector(".pwa-tool-status-running > svg")!).animationName).not.toBe("none");
    await expect.element(screen.getByRole("status", { name: "read: Running" })).toBeVisible();
    await userEvent.click(toolButton());
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const reader = document.querySelector<HTMLElement>(".pwa-tool-reader")!;
    expect(getComputedStyle(reader).transitionProperty).not.toContain("transform");
    expect(parseFloat(getComputedStyle(reader).transitionDuration)).toBeLessThanOrEqual(0.12);
    await closeReader();
    expect(document.activeElement).toBe(toolButton());
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("reports whether scrolling is within 32px of the latest output", async () => {
  const positions: boolean[] = [];
  const screen = await renderMessageList([], { onScroll: nearBottom => positions.push(nearBottom) });
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, writable: true, value: 560 } });
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  list.scrollTop = 568;
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  expect(positions).toEqual([false, true]);
  await screen.unmount();
});

test("message list controls retain 44px touch targets", async () => {
  const screen = await renderMessageList([eventItem(toolEvent), eventItem(assistantEvent), unknownPending, { ...unknownPending, id: "pending-2", delivery: "accepted", cancelable: true }]);
  for (const name of ["View read tool details", "Expand thinking", "Retry delivery", "Cancel queued message"]) {
    const rect = screen.getByRole("button", { name }).element().getBoundingClientRect();
    expect(Math.round(rect.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
  }
});

test.each([390, 767, 768, 1280].flatMap(width => ["light", "dark"].map(scheme => ({ width, scheme }))))("keeps enlarged message, code and metadata typography readable at $width in $scheme", async ({ width, scheme }) => {
  await page.viewport(width, 844);
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const answer: Extract<TimelineEvent, { kind: "assistant" }> = { ...assistantEvent, blocks: [{ type: "text", text: "## 阅读标题 Reading title\n\n正文更易阅读。Run `pnpm test`.\n\n```ts\nconst readable = true;\n```" }] };
  const screen = await renderMessageList([eventItem(answer), runEndItem()]);
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    await expect.element(screen.getByRole("heading", { name: "阅读标题 Reading title" })).toBeVisible();
    for (const [selector, size, lineHeight] of [[".pwa-markdown h2", "18px", "25.2px"], [".pwa-markdown p", "16px", "26.4px"], [".pwa-markdown p code", "14px", "21.7px"], [".pwa-code-block pre", "14px", "21.7px"], [".pwa-code-language", "13px", "18.2px"], [".pwa-turn-meta", "13px", "18.2px"]]) {
      const element = document.querySelector(selector)!;
      expect(element, selector).not.toBeNull();
      expect(getComputedStyle(element).fontSize, selector).toBe(size);
      expect(getComputedStyle(element).lineHeight, selector).toBe(lineHeight);
    }
    const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
  }
});

test("code blocks keep the copy button in a header so long lines stay readable on phones", async () => {
  await page.viewport(390, 844);
  const longLine = "shell.style.height = `${viewport.height}px`; shell.style.top = `${viewport.offsetTop}px`;";
  const answer: Extract<TimelineEvent, { kind: "assistant" }> = { ...assistantEvent, event_id: "code-answer", blocks: [{ type: "text", text: `Result:\n\n\`\`\`ts\n${longLine}\nconst done = true;\n\`\`\`` }] };
  const screen = await renderMessageList([eventItem(answer)]);
  try {
    await expect.element(screen.getByText("Result:")).toBeVisible();
    const block = document.querySelector<HTMLElement>(".pwa-code-block")!;
    const language = block.querySelector<HTMLElement>(".pwa-code-head .pwa-code-language")!;
    const copy = block.querySelector<HTMLElement>(".pwa-code-head .pwa-code-copy")!;
    const pre = block.querySelector<HTMLElement>("pre")!;
    const code = pre.querySelector<HTMLElement>("code")!;
    expect(language.textContent).toBe("ts");
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    expect(Math.round(copy.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(code.getBoundingClientRect().top) + 1);
    expect(Math.round(copy.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(copy.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  } finally { await screen.unmount(); }
});

test("keeps inline code and tool names in neutral text while links keep the accent", async () => {
  const answer: Extract<TimelineEvent, { kind: "assistant" }> = { ...assistantEvent, event_id: "inline-answer", blocks: [{ type: "text", text: "Run `pnpm test` or read [the guide](https://example.com/guide)." }] };
  const screen = await renderMessageList([eventItem(toolEvent), eventItem(answer)]);
  try {
    await expect.element(screen.getByText("pnpm test")).toBeVisible();
    const probe = document.createElement("span");
    probe.style.cssText = "color: var(--pwa-soft-ink); border-top: 1px solid var(--pwa-ink); background: var(--pwa-accent)";
    document.querySelector(".pwa-root")!.append(probe);
    const [softInk, ink, accent] = [getComputedStyle(probe).color, getComputedStyle(probe).borderTopColor, getComputedStyle(probe).backgroundColor];
    probe.remove();
    expect(getComputedStyle(document.querySelector(".pwa-markdown p code")!).color).toBe(softInk);
    expect(getComputedStyle(document.querySelector(".pwa-markdown a")!).color).toBe(accent);
    expect(getComputedStyle(document.querySelector(".pwa-tool-action-copy strong")!).color).toBe(ink);
  } finally { await screen.unmount(); }
});

test("groups adjacent finished tools of one turn including failures, and marks the failure on the group", async () => {
  const read = (id: string, path: string): Extract<TimelineEvent, { kind: "tool" }> => ({ ...toolEvent, event_id: id, tool_call_id: id, args: { path }, result: "ok" });
  const failed: Extract<TimelineEvent, { kind: "tool" }> = { ...toolEvent, event_id: "failed", tool_call_id: "failed", tool: "bash", args: { command: "pnpm lint" }, status: "error", error: "Lint failed" };
  const otherTurn: Extract<TimelineEvent, { kind: "tool" }> = { ...read("other-turn", "d.ts"), group_id: "group-2" };
  const reading: boolean[] = [];
  await liveList([...([read("a", "a.ts"), read("b", "b.ts"), failed, read("c", "c.ts"), read("d", "a.ts"), otherTurn].map(eventItem)), runEndItem()], { onReadingChange: value => reading.push(value) });
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  expect(list.querySelectorAll(":scope > .pwa-tool-group")).toHaveLength(1);
  expect(list.querySelectorAll(":scope > .pwa-tool-card")).toHaveLength(1);
  expect(groupButton().textContent).toBe("Read 3 files · Ran 1 command · 1 failed");
  expect(groupButton().querySelector(".pwa-tool-group-alert")).not.toBeNull();
  expect(groupButton().getAttribute("aria-label")).toBe("Expand Read 3 files · Ran 1 command · 1 failed");
  await userEvent.click(groupButton());
  expect(groupButton().getAttribute("aria-label")).toBe("Collapse Read 3 files · Ran 1 command · 1 failed");
  expect(document.querySelectorAll(".pwa-tool-group .pwa-tool-card")).toHaveLength(5);
  expect(document.querySelector(".pwa-tool-group .pwa-tool-status-error")?.textContent).toBe("Error");
  expect(reading.at(-1)).toBe(true);
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(false);
});

test("a group without failures shows no failure marker", async () => {
  const read = (id: string, path: string): Extract<TimelineEvent, { kind: "tool" }> => ({ ...toolEvent, event_id: id, tool_call_id: id, args: { path }, result: "ok" });
  await liveList([read("a", "a.ts"), read("b", "b.ts")].map(eventItem).concat(runEndItem()));
  expect(groupButton().textContent).toBe("Read 2 files");
  expect(groupButton().querySelector(".pwa-tool-group-alert")).toBeNull();
});

test("fades in content that arrives in a loading list, without replaying for updates or a first message", async () => {
  const animate = vi.spyOn(HTMLElement.prototype, "animate");
  let setState!: (state: { items: TimelineViewItem[]; loading: boolean }) => void;
  function Harness() {
    const [state, update] = useState<{ items: TimelineViewItem[]; loading: boolean }>({ items: [], loading: true });
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    setState = update;
    return <MessageList items={state.items} loading={state.loading} hasEarlier listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} />;
  }
  const screen = await renderPwa(<Harness />);
  const fades = () => animate.mock.contexts.filter((element) => (element as Element).classList.contains("pwa-message-list")).length;
  const first = eventItem({ ...assistantEvent, event_id: "first" });
  const second = eventItem({ ...assistantEvent, event_id: "second", timestamp: 2 });
  try {
    // 加载中的空列表只显示骨架，不叠加「加载更多」。
    expect(document.querySelector(".pwa-earlier-button")).toBeNull();
    flushSync(() => setState({ items: [first], loading: false }));
    expect(fades()).toBe(1);
    expect(document.querySelector(".pwa-earlier-button")).not.toBeNull();
    flushSync(() => setState({ items: [first, second], loading: false }));
    expect(fades()).toBe(1);
    flushSync(() => setState({ items: [], loading: false }));
    flushSync(() => setState({ items: [first], loading: false }));
    expect(fades()).toBe(1);
  } finally {
    animate.mockRestore();
    await screen.unmount();
  }
});
