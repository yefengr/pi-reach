import { createRef, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
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
  await screen.unmount();
});

test("thinking is independently collapsed and keyboard toggling leaves the answer visible", async () => {
  const screen = await renderMessageList([eventItem(assistantEvent)]);
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  const toggle = screen.getByRole("button", { name: "Expand thinking" });
  toggle.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  expect(document.querySelector(".pwa-thinking .pwa-text-plain")).not.toBeNull();
  expect(document.querySelector(".pwa-thinking .pwa-tool-code")).toBeNull();
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  await userEvent.keyboard(" ");
  await expect.element(screen.getByText("Inspecting the request.")).not.toBeInTheDocument();
});

test("thinking and tools share the reading lock without affecting each other", async () => {
  const reading: boolean[] = [];
  const secondThinking: TimelineEvent = { ...assistantEvent, event_id: "second-thinking", blocks: [{ type: "thinking", text: "Another thought." }] };
  const { screen, update } = await liveList([eventItem(assistantEvent), eventItem(secondThinking), eventItem(toolEvent)], { onReadingChange: value => reading.push(value) });
  await screen.getByRole("button", { name: "Expand thinking" }).first().click();
  expect(reading.at(-1)).toBe(true);
  await screen.getByRole("button", { name: "Expand thinking" }).first().click();
  expect(reading.at(-1)).toBe(true);
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  expect(reading.at(-1)).toBe(true);
  await screen.getByRole("button", { name: "Collapse thinking" }).first().click();
  expect(reading.at(-1)).toBe(true);
  await screen.getByRole("button", { name: "Collapse read tool" }).click();
  expect(reading.at(-1)).toBe(true);
  await update([eventItem(secondThinking)]);
  expect(reading.at(-1)).toBe(true);
  await update([]);
  expect(reading.at(-1)).toBe(false);
});

test("streaming thinking starts collapsed and keeps a manual choice in the formal answer", async () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "Inspecting the request." };
  const { screen, update } = await liveList([partialItem(thinking)]);
  await expect.element(screen.getByText("Thinking…")).toBeVisible();
  await expect.element(screen.getByText("Inspecting the request.")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Expand thinking" }).click();
  const toggle = screen.getByRole("button", { name: "Collapse thinking" }).element();
  await update([eventItem(assistantEvent)]);
  expect(screen.getByRole("button", { name: "Collapse thinking" }).element()).toBe(toggle);
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  await expect.element(screen.getByText("Thought process")).toBeVisible();
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
});

test("streaming text keeps its timeline identity and reserved rows when it becomes formal", async () => {
  const partial: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:assistant:1", kind: "assistant", status: "delta", blocks: [{ type: "text", text: "Still writing" }] };
  const { screen, update } = await liveList([partialItem(partial)]);
  const row = document.querySelector<HTMLElement>("article[data-timeline-key]")!;
  const rowHeight = row.getBoundingClientRect().height;
  expect(row.dataset.timelineKey).toContain("answer");
  // Pi 回复不显示逐条标签与时间，只保留读屏前缀。
  expect(row.querySelector("time")).toBeNull();
  expect(row.querySelector(".pwa-message-label")).toBeNull();
  await update([eventItem(assistantEvent)]);
  const formalRow = document.querySelector<HTMLElement>("article[data-timeline-key]")!;
  expect(formalRow).toBe(row);
  expect(formalRow.getBoundingClientRect().height).toBeCloseTo(rowHeight, 0);
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
});

test("all tools start collapsed, including running, failed, interrupted and custom records", async () => {
  const failed: TimelineEvent = { ...toolEvent, event_id: "failed", tool_call_id: "failed", status: "error", error: "Permission denied" };
  const interrupted: TimelineEvent = { event_id: "interrupted", tool_call_id: "interrupted", session_id: "session-1", leaf_id: "history-1", timestamp: 2, group_id: "group-1", kind: "tool", tool: "bash", args: { command: "sleep 10" }, truncated: false, status: "interrupted" };
  const custom: TimelineEvent = { ...toolEvent, event_id: "custom", tool_call_id: "custom", tool: "custom", result: { secretPreview: "not visible" } };
  const { screen } = await liveList([partialItem(toolPartial), eventItem({ ...toolEvent, tool_call_id: "complete", result: "Finished" }), eventItem(failed), eventItem(interrupted), eventItem(custom)]);
  expect(document.querySelectorAll(".pwa-tool-card")).toHaveLength(5);
  expect(document.querySelector(".pwa-activity-group")).toBeNull();
  for (const action of document.querySelectorAll(".pwa-tool-action")) expect(action.getAttribute("aria-expanded")).toBe("false");
  for (const label of ["Streaming output", "Permission denied", "Finished", "Tool execution was interrupted.", "not visible"]) {
    await expect.element(screen.getByText(label, { exact: true })).not.toBeInTheDocument();
  }
  expect(document.querySelector("[aria-label='Tool input']")).toBeNull();
  expect(document.querySelector("[aria-label='Tool output']")).toBeNull();
  await expect.element(screen.getByRole("status", { name: "read: Error" })).toBeVisible();
  await expect.element(screen.getByRole("status", { name: "bash: Interrupted" })).toBeVisible();
});

test("output and status updates never override manual tool expansion or focus", async () => {
  const reading: boolean[] = [];
  const { screen, update } = await liveList([partialItem(toolPartial)], { onReadingChange: value => reading.push(value) });
  await update([partialItem({ ...toolPartial, blocks: [{ type: "text", text: "New live output" }] })]);
  await expect.element(screen.getByText("New live output")).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Expand read tool" });
  const originalButton = toggle.element();
  originalButton.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("New live output")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  const completed: TimelineEvent = { ...toolEvent, args: toolPartial.args!, result: [{ type: "text", text: "Final file content" }] };
  await update([eventItem(completed)]);
  expect(screen.getByRole("button", { name: "Collapse read tool" }).element()).toBe(originalButton);
  expect(document.activeElement).toBe(originalButton);
  await expect.element(screen.getByText("Final file content")).toBeVisible();
  await expect.element(screen.getByRole("status", { name: "read: Complete" })).toBeVisible();
  // 完成状态只显示对勾，不显示文字；可访问名称保留。
  expect(screen.getByRole("status", { name: "read: Complete" }).element().textContent).toBe("");
  await userEvent.keyboard(" ");
  expect(reading.at(-1)).toBe(false);
  const failed: TimelineEvent = { ...toolEvent, args: toolPartial.args!, status: "error", error: "Permission denied" };
  await update([eventItem(failed)]);
  await expect.element(screen.getByRole("button", { name: "Expand read tool" })).toBeVisible();
  // 失败等非完成状态保留图标＋文字。
  expect(document.querySelector(".pwa-tool-card .pwa-tool-status-error")?.textContent).toBe("Error");
  await expect.element(screen.getByText("Permission denied")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  await expect.element(screen.getByText("Permission denied")).toBeVisible();
  expect(document.querySelectorAll(".pwa-tool-card")).toHaveLength(1);
});

test("every tool stays reachable and expansion is independent across parallel completions", async () => {
  const before = { ...assistantEvent, event_id: "before", blocks: [{ type: "text" as const, text: "Before tools" }] };
  const between = { ...assistantEvent, event_id: "between", blocks: [{ type: "text" as const, text: "Between tools" }] };
  const laterTools = Array.from({ length: 6 }, (_, index) => eventItem({ ...toolEvent, event_id: `later-${index}`, tool_call_id: `later-${index}`, tool: "bash", args: { command: `echo ${index}` }, result: `Output ${index}` }));
  const { screen, update } = await liveList([eventItem(before), partialItem(toolPartial), eventItem(between), ...laterTools]);
  const originalOrder = [...document.querySelectorAll(".pwa-message-list > article")];
  // 这一轮仍有工具在运行：每个工具逐条显示，不合并。
  expect(document.querySelectorAll(".pwa-tool-action")).toHaveLength(7);
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  await update([eventItem(before), eventItem(between), ...laterTools, eventItem({ ...toolEvent, args: toolPartial.args!, result: "Read completed last" }), runEndItem()]);
  // 这一轮结束后，连续成功的 6 条命令合并为一行摘要；已展开的读取被正文隔开，保持原位与展开状态。
  expect([...document.querySelectorAll(".pwa-message-list > article")].slice(0, 3)).toEqual(originalOrder.slice(0, 3));
  const group = screen.getByRole("button", { name: "Expand Ran 6 commands" });
  await expect.element(group).toBeVisible();
  expect(document.querySelectorAll('.pwa-tool-action[aria-expanded="true"]')).toHaveLength(1);
  await expect.element(screen.getByText("Read completed last")).toBeVisible();
  // 展开摘要即可看到全部命令，且各自独立展开。
  await group.click();
  await expect.poll(() => document.querySelectorAll(".pwa-tool-group .pwa-tool-card").length).toBe(6);
  expect(document.querySelectorAll('.pwa-tool-group .pwa-tool-card .pwa-tool-action[aria-expanded="false"]')).toHaveLength(6);
  expect(document.querySelector(".pwa-activity-earlier")).toBeNull();
});

test.each(["history-replacement", "empty"])("releases the reading lock when an expanded tool disappears (%s)", async (removal) => {
  const runtime = new TimelineRuntime();
  runtime.setScope({ deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: toolEvent.session_id, leafId: toolEvent.leaf_id, selfSenderRef: "self", channelId: "channel" });
  let updateItems!: (items: TimelineViewItem[]) => void;
  let viewport!: ReturnType<typeof useTimelineViewport>;
  const initial = runtime.commit(toolEvent).items;
  function Harness() {
    const [items, setItems] = useState(initial);
    updateItems = setItems;
    viewport = useTimelineViewport();
    return <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} />;
  }
  const screen = await renderPwa(<Harness />);
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  expect(viewport.followingOutput).toBe(true);
  // 展开仅暂停自动跟随，不改变仍在底部的阅读状态；移除展开工具会解除暂停。
  const change = runtime.replaceHistory(removal === "empty" ? [] : [assistantEvent]);
  expect(change.items.some(item => item.kind === "event" && item.event.kind === "tool")).toBe(false);
  flushSync(() => updateItems(change.items));
  await expect.element(screen.getByRole("button", { name: "Collapse read tool" })).not.toBeInTheDocument();
  const list = viewport.messageListRef.current!;
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, writable: true, value: 600 } });
  flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  await expect.poll(() => viewport.followingOutput).toBe(true);
  flushSync(() => viewport.receiveRealtimeOutput("after-history"));
  expect(viewport.unreadOutput).toBe(0);
});

test("a historical or offline partial stays folded and is not labeled as running", async () => {
  const screen = await renderMessageList([partialItem(toolPartial)], { isLive: false });
  await expect.element(screen.getByRole("status", { name: "read: Status unknown" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Expand read tool" })).toBeVisible();
  await expect.element(screen.getByText("Streaming output")).not.toBeInTheDocument();
});

test("a repeated tool id in a different session does not inherit expansion", async () => {
  const { screen, update } = await liveList([eventItem(toolEvent)]);
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  await update([eventItem({ ...toolEvent, session_id: "other-session" })]);
  await expect.element(screen.getByRole("button", { name: "Expand read tool" })).toBeVisible();
  expect(document.querySelector('[aria-label="Tool output"]')).toBeNull();
});

test("tool images and structured output stay inline without a raw-data entry", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const screen = await renderMessageList([eventItem({ ...toolEvent, args: { path: "image.png" }, result: [{ type: "text", text: "Image result" }, { type: "image", mimeType: "image/png", data: png }] })]);
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  await expect.element(screen.getByRole("img", { name: "Tool output image 2" })).toBeVisible();
  await screen.getByRole("button", { name: /^View all/ }).click();
  await expect.element(screen.getByRole("dialog").getByRole("img", { name: "Tool output image 2" })).toBeVisible();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(document.querySelector(".pwa-tool-details")?.textContent).not.toContain(png);
  await screen.unmount();
  const fallback = await renderMessageList([eventItem({ ...toolEvent, tool: "custom", result: { files: 3, ok: true } })]);
  await fallback.getByRole("button", { name: "Expand custom tool" }).click();
  expect(document.querySelector(".pwa-tool-content")?.textContent).toContain('"files": 3');
  await expect.element(fallback.getByRole("button", { name: /^View all/ })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("Raw data");
});

test.each([1280, 390])("manual expansion and reader preserve layout, scroll and focus at %ipx", async (width) => {
  await page.viewport(width, 844);
  const output = `${"long-output\n".repeat(120)}END OF OUTPUT`;
  const { screen } = await liveList([
    eventItem(assistantEvent),
    partialItem({ ...toolPartial, args: { path: `src/${"directory/".repeat(30)}file.ts` }, blocks: [{ type: "text", text: output }] }),
  ]);
  await screen.getByRole("button", { name: "Expand read tool" }).click();
  const preview = document.querySelector<HTMLElement>(".pwa-tool-preview")!;
  const previews = document.querySelectorAll<HTMLElement>(".pwa-tool-preview pre");
  expect(previews.length).toBeGreaterThan(0);
  expect(preview.getBoundingClientRect().height).toBeLessThanOrEqual(384);
  for (const pre of previews) expect(getComputedStyle(pre).overflowY).not.toMatch(/auto|scroll/);
  const control = screen.getByRole("button", { name: /^View all/ });
  const origin = control.element();
  origin.focus();
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  const scrollTop = list.scrollTop;
  await page.screenshot({ path: `../../../.vitest/screenshots/details-preview-${width}.png` });
  await control.click();
  await expect.element(screen.getByText("END OF OUTPUT").first()).toBeVisible();
  const reader = document.querySelector(".pwa-tool-reader")!;
  expect(document.querySelector(".pwa-root")?.contains(reader)).toBe(true);
  await expect.poll(() => reader.getBoundingClientRect().right).toBeCloseTo(width, 0);
  const readerWidth = width >= 768 ? 720 : width;
  expect(reader.getBoundingClientRect().left).toBeCloseTo(width - readerWidth, 0);
  expect(reader.getBoundingClientRect().width).toBeCloseTo(readerWidth, 0);
  expect(reader.getBoundingClientRect().height).toBeCloseTo(844, 0);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  const detailScroll = reader.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
  detailScroll.scrollTop = detailScroll.scrollHeight;
  expect(detailScroll.scrollTop).toBeGreaterThan(0);
  expect(detailScroll.scrollTop + detailScroll.clientHeight).toBeCloseTo(detailScroll.scrollHeight, 0);
  expect(detailScroll.textContent).toContain("END OF OUTPUT");
  await page.screenshot({ path: `../../../.vitest/screenshots/details-fullscreen-${width}.png` });
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement).toBe(origin);
  expect(list.scrollTop).toBe(scrollTop);
  expect(document.querySelector('.pwa-tool-action[aria-expanded="true"]')).not.toBeNull();
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
});

test.each([1280, 390])("reply, thinking and tools share typography and alignment in both themes at %ipx", async (width) => {
  await page.viewport(width, 844);
  const tools = [
    eventItem({ ...toolEvent, args: { path: `src/${"directory/".repeat(30)}file.ts`, offset: 200, limit: 60 } }),
    partialItem({ ...toolPartial, tool: "bash", tool_call_id: "running", partial_id: "tool:running", args: { command: `pnpm build\n${"long-argument ".repeat(50)}` } }),
    eventItem({ ...toolEvent, tool: "edit", tool_call_id: "failed", event_id: "failed", args: { path: "src/component.tsx" }, status: "error", error: "Hidden error details" }),
  ];
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const { screen } = await liveList([
    { kind: "pending", id: "example-user", clientRequestId: "example", requestId: "example", createdAt: 0, delivery: "pending", text: "请检查消息与工具展示。" },
    eventItem({ ...assistantEvent, blocks: [{ type: "text", text: "我会检查 `timeline`，每次工具调用独立显示。" }] }),
    tools[0],
    eventItem({ ...assistantEvent, event_id: "thinking-between", blocks: [{ type: "thinking", text: "先核对路径，再检查输出。" }] }),
    ...tools.slice(1),
  ]);
  const leftOfText = (element: Element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.trim()) node = walker.nextNode();
    expect(node).not.toBeNull();
    const range = document.createRange();
    range.selectNodeContents(node!);
    return range.getBoundingClientRect().left;
  };
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      for (const action of document.querySelectorAll<HTMLElement>(".pwa-tool-action")) {
        const rect = action.getBoundingClientRect();
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeLessThanOrEqual(52);
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        const copy = action.querySelector<HTMLElement>(".pwa-tool-action-copy")!;
        expect(getComputedStyle(copy).whiteSpace).toBe("nowrap");
        expect(action.getAttribute("aria-expanded")).toBe("false");
      }
      const labels = [
        document.querySelector(".pwa-thinking-title")!,
        document.querySelector(".pwa-tool-action-copy strong")!,
      ];
      for (const label of labels) {
        expect(getComputedStyle(label).fontSize).toBe("16px");
        expect(getComputedStyle(label).fontStyle).toBe("normal");
        expect(getComputedStyle(label).fontWeight).toBe("600");
        expect(leftOfText(label)).toBeCloseTo(leftOfText(labels[0]), 0);
      }
      const thinkingToggle = screen.getByRole("button", { name: "Expand thinking" }).element();
      const toolToggle = screen.getByRole("button", { name: "Expand read tool" }).element();
      expect(thinkingToggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      const thinkingArrow = thinkingToggle.querySelector("svg")!;
      const toolArrow = toolToggle.querySelector("svg")!;
      expect(thinkingArrow.getBoundingClientRect().left).toBeCloseTo(toolArrow.getBoundingClientRect().left, 0);
      expect(thinkingArrow.getBoundingClientRect().right).toBeLessThan(leftOfText(labels[0]));
      for (const card of document.querySelectorAll(".pwa-tool-card")) {
        expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(56);
        expect(getComputedStyle(card).borderTopWidth).toBe("0px");
        expect(getComputedStyle(card).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      }
      const list = document.querySelector(".pwa-message-list")!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      await expect.element(screen.getByText("Hidden error details")).not.toBeInTheDocument();
      await page.screenshot({ path: `../../../.vitest/screenshots/unified-timeline-${width}-${theme}.png` });
    }
    await screen.getByRole("button", { name: "Expand thinking" }).click();
    await screen.getByRole("button", { name: "Expand read tool" }).click();
    // Pi 回复占满阅读列、与状态行箭头左缘对齐；展开的思考和工具内容与标题文字对齐。
    const replyLeft = document.querySelector(".pwa-message.assistant .pwa-markdown")!.getBoundingClientRect().left;
    expect(document.querySelector(".pwa-thinking .pwa-timeline-toggle")!.getBoundingClientRect().left).toBeCloseTo(replyLeft, 0);
    const bodyLeft = document.querySelector(".pwa-thinking .pwa-text-plain")!.getBoundingClientRect().left;
    expect(bodyLeft).toBeCloseTo(replyLeft + 24, 0);
    expect(document.querySelector(".pwa-tool-preview")!.getBoundingClientRect().left).toBeCloseTo(bodyLeft, 0);
    for (const selector of [".pwa-thinking .pwa-timeline-chevron", ".pwa-tool-action[aria-expanded='true'] .pwa-timeline-chevron"]) {
      await expect.poll(() => getComputedStyle(document.querySelector(selector)!).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
    }
    await page.screenshot({ path: `../../../.vitest/screenshots/unified-timeline-expanded-${width}.png` });
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test.each([1280, 390])("expanded tools use direct TUI content in both themes at %ipx", async width => {
  await page.viewport(width, 844);
  const calls: Extract<TimelineEvent, { kind: "tool" }>[] = [
    { ...toolEvent, args: { path: ".pi/tmp/logs/check.exit" }, result: [{ type: "text", text: "0\n" }] },
    { ...toolEvent, event_id: "source", tool_call_id: "source", args: { path: "src/status.ts" }, result: "const status = 'ready';" },
    { ...toolEvent, event_id: "command", tool_call_id: "command", tool: "bash", args: { command: "pnpm test" }, result: "Tests passed: 12\nAll checks passed." },
    { ...toolEvent, event_id: "write", tool_call_id: "write", tool: "write", args: { path: "src/settings.ts", content: "export const enabled = true;" }, result: "Wrote file" },
    { ...toolEvent, event_id: "edit", tool_call_id: "edit", tool: "edit", args: { path: "src/settings.ts", oldText: "enabled = false", newText: "enabled = true" }, result: "Successfully replaced text" },
  ];
  const { screen } = await liveList([...calls.map(eventItem), runEndItem()]);
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  // 连续成功的工具先合并为一行摘要：展开摘要后再逐条展开。
  const groupToggle = document.querySelector<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head .pwa-tool-action")!;
  expect(groupToggle.textContent).toBe("Read 2 files · Ran 1 command · Wrote 1 file · Edited 1 file");
  groupToggle.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelectorAll(".pwa-tool-group .pwa-tool-card").length).toBe(calls.length);
  for (const action of [...document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")]) {
    action.focus();
    await userEvent.keyboard("{Enter}");
  }
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      await expect.element(screen.getByText("0", { exact: true })).toBeVisible();
      await expect.element(screen.getByText("Requested changes")).toBeVisible();
      await expect.element(screen.getByRole("button", { name: /^View all/ })).not.toBeInTheDocument();
      expect(document.querySelectorAll(".pwa-tool-content")).toHaveLength(calls.length);
      for (const body of document.querySelectorAll<HTMLElement>(".pwa-tool-content")) {
        expect(body.textContent).not.toContain('"path":');
        expect(body.textContent).not.toContain('"command":');
        expect(body.textContent).not.toContain('"oldText":');
      }
      expect(document.querySelector(".pwa-tool-detail-label")).toBeNull();
      // 工具输出是原始文本，不做语法高亮。
      expect(document.querySelector(".pwa-tool-content .hljs")).toBeNull();
      for (const action of document.querySelectorAll<HTMLElement>(".pwa-tool-read-actions button")) {
        expect(getComputedStyle(action).borderTopWidth).toBe("0px");
        expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      list.scrollTop = 0;
      await expect.poll(() => getComputedStyle(document.querySelector(".pwa-tool-chevron")!).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
      await page.screenshot({ path: `../../../.vitest/screenshots/tui-tools-${width}-${theme}.png` });
    }
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test("full reader shows write input and restores focus when streaming completion removes its entry button", async () => {
  const partial = { ...toolPartial, tool: "write", args: { path: "file.txt", content: `${"line\n".repeat(50)}FINAL_WRITE_LINE` }, blocks: [] };
  const { screen, update } = await liveList([partialItem(partial)]);
  await screen.getByRole("button", { name: "Expand write tool" }).click();
  const origin = screen.getByRole("button", { name: /^View all/ });
  origin.element().focus();
  await origin.click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  await expect.element(screen.getByText("FINAL_WRITE_LINE").first()).toBeVisible();
  await update([eventItem({ ...toolEvent, tool: "write", args: { path: "file.txt", content: "short" }, result: "Wrote file" })]);
  await expect.element(screen.getByRole("button", { name: /^View all/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  await expect.element(screen.getByRole("button", { name: "Collapse write tool" })).toBeVisible();
});

test("reduced motion keeps the running indicator animating as a status signal", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    const { screen } = await liveList([partialItem(toolPartial)]);
    const spinner = document.querySelector(".pwa-tool-status-running > svg")!;
    expect(getComputedStyle(spinner).animationName).not.toBe("none");
    await expect.element(screen.getByRole("status", { name: "read: Running" })).toBeVisible();
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
  for (const name of ["Expand read tool", "Expand thinking", "Retry delivery", "Cancel queued message"]) {
    const rect = screen.getByRole("button", { name }).element().getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
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
    // 长行在代码区内横向滚动；复制按钮位于标题栏，不与任何代码行重叠。
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    expect(copy.getBoundingClientRect().bottom).toBeLessThanOrEqual(code.getBoundingClientRect().top + 1);
    const copyRect = copy.getBoundingClientRect();
    expect(copyRect.width).toBeGreaterThanOrEqual(44);
    expect(copyRect.height).toBeGreaterThanOrEqual(44);
    const list = document.querySelector<HTMLElement>(".pwa-message-list");
    if (list) expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  } finally {
    await screen.unmount();
  }
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
  } finally {
    await screen.unmount();
  }
});

test("groups only adjacent completed tools of one turn and keeps failures on their own rows", async () => {
  const read = (id: string, path: string): Extract<TimelineEvent, { kind: "tool" }> => ({ ...toolEvent, event_id: id, tool_call_id: id, args: { path }, result: "ok" });
  const failed: Extract<TimelineEvent, { kind: "tool" }> = { ...toolEvent, event_id: "failed", tool_call_id: "failed", tool: "bash", args: { command: "pnpm lint" }, status: "error", error: "Lint failed" };
  const otherTurn: Extract<TimelineEvent, { kind: "tool" }> = { ...read("other-turn", "d.ts"), group_id: "group-2" };
  const reading: boolean[] = [];
  const { screen } = await liveList([...([read("a", "a.ts"), read("b", "b.ts"), failed, read("c", "c.ts"), read("d", "a.ts"), otherTurn].map(eventItem)), runEndItem()], { onReadingChange: (value) => { reading.push(value); } });
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  // 失败的命令单独一行并把前后隔开；另一轮里只有一条工具，不合并。
  expect(list.querySelectorAll(":scope > .pwa-tool-group")).toHaveLength(2);
  expect(list.querySelectorAll(":scope > .pwa-tool-card")).toHaveLength(2);
  expect(list.querySelector(":scope > .pwa-tool-card .pwa-tool-status-error")?.textContent).toBe("Error");
  await expect.element(screen.getByRole("button", { name: "Expand Read 2 files" }).first()).toBeVisible();
  await screen.getByRole("button", { name: "Expand Read 2 files" }).first().click();
  await expect.element(screen.getByRole("button", { name: "Collapse Read 2 files" })).toBeVisible();
  // 展开摘要与展开单条工具一样暂停自动跟随。
  expect(reading.at(-1)).toBe(true);
});

test("keeps a tool the user expanded visible when its finished turn is grouped", async () => {
  const first: Extract<TimelineEvent, { kind: "tool" }> = { ...toolEvent, event_id: "first", tool_call_id: "first", args: { path: "a.ts" }, result: "First output" };
  const second: Extract<TimelineEvent, { kind: "tool" }> = { ...toolEvent, event_id: "second", tool_call_id: "second", args: { path: "b.ts" }, result: "Second output" };
  const running: Extract<TimelinePartial, { kind: "tool" }> = { ...toolPartial, partial_id: "tool:third", tool_call_id: "third", args: { path: "c.ts" } };
  const { screen, update } = await liveList([eventItem(first), eventItem(second), partialItem(running)]);
  // 这一轮还在运行：逐条显示，用户展开第一条。
  expect(document.querySelector(".pwa-tool-group")).toBeNull();
  await screen.getByRole("button", { name: "Expand read tool" }).first().click();
  await expect.element(screen.getByText("First output")).toBeVisible();
  await update([eventItem(first), eventItem(second), eventItem({ ...toolEvent, event_id: "third", tool_call_id: "third", args: { path: "c.ts" }, result: "Third output" }), runEndItem()]);
  // 这一轮结束后合并为摘要；组内有已展开的工具，摘要默认展开，正在阅读的内容不被收起。
  await expect.element(screen.getByRole("button", { name: "Collapse Read 3 files" })).toBeVisible();
  await expect.element(screen.getByText("First output")).toBeVisible();
});
