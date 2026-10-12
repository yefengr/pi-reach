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
/** 工具从第一条起即在默认收起的组内；需要操作工具行时先展开所有收起的组。 */
async function expandToolGroups() {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head .pwa-tool-action[aria-expanded='false']")) await userEvent.click(toggle);
}
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
  let setOverrides!: (overrides: Partial<ListProps>) => void;
  function Harness() {
    const [items, update] = useState(initial);
    const [props, updateOverrides] = useState(overrides);
    setOverrides = updateOverrides;
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    setItems = update;
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}><MessageList items={items} hasEarlier={false} listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} {...props} /></main>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, update: async (items: TimelineViewItem[], nextOverrides?: Partial<ListProps>) => {
    flushSync(() => { setItems(items); if (nextOverrides !== undefined) setOverrides(nextOverrides); });
  } };
}
function renderMessageList(items: ListProps["items"], overrides: Partial<ListProps> = {}) {
  return renderPwa(<MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} onRetryUnknown={() => {}} onCancelQueued={() => {}} {...overrides} />);
}

test.each([1280, 390])("Working fallback hands off to current thinking and visible tools at %ipx", async width => {
  await page.viewport(width, 844);
  const live = { running: true, isLive: true };
  const question = eventItem({ ...assistantEvent, event_id: "before-output", blocks: [{ type: "text", text: "Before output" }] });
  const thinking: TimelinePartial = {
    protocol_version: 2, type: "timeline_partial", session_id: toolPartial.session_id, leaf_id: toolPartial.leaf_id,
    group_id: toolPartial.group_id, partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "Inspecting the request.",
  };
  const thought = eventItem({ ...assistantEvent, blocks: [{ type: "thinking", text: "Inspecting the request." }] });
  const { screen, update } = await liveList([question], live);
  const working = () => document.querySelector(".pwa-thinking-status");
  expect(working()?.textContent).toBe("Working…");
  await update([question, partialItem(thinking)]);
  expect(working()).toBeNull();
  await expect.element(screen.getByRole("status").getByText("Thinking…")).toBeVisible();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking-head")!);
  expect(working()).toBeNull();
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  await update([question, thought, partialItem(toolPartial)]);
  expect(document.querySelector(".pwa-thinking-live")).toBeNull();
  expect(groupButton().querySelector(".pwa-tool-spinner")).not.toBeNull();
  expect(working()).toBeNull();
  await userEvent.click(groupButton());
  await expect.element(screen.getByRole("status", { name: "read: Running" })).toBeVisible();
  expect(working()).toBeNull();
  await userEvent.click(groupButton());
  expect(groupButton().querySelector(".pwa-tool-spinner")).not.toBeNull();
  expect(working()).toBeNull();
  // 结束图标不再表示正在工作；Pi 仍 working 时立即恢复兜底，不等组头停留结束。
  await update([question, thought, eventItem({ ...toolEvent, args: toolPartial.args! })]);
  expect(groupButton().querySelector(".pwa-tool-status-complete")).not.toBeNull();
  expect(working()?.textContent).toBe("Working…");
  await expect.poll(() => groupButton().querySelector(".pwa-tool-group-current"), { timeout: 4000 }).toBeNull();
  expect(groupButton().querySelector(".pwa-tool-group-summary")).not.toBeNull();
  expect(working()?.textContent).toBe("Working…");
  const body: TimelinePartial = { ...thinking, partial_id: "body:assistant:0", kind: "assistant", delta: "Streaming body" };
  await update([question, thought, eventItem(toolEvent), partialItem(body)]);
  await expect.element(screen.getByText("Streaming body")).toBeVisible();
  expect(working()?.textContent).toBe("Working…");
  // 工具组被移除后不能留下旧报告，压制兜底。
  await update([question]);
  expect(document.querySelector(".pwa-tool-group")).toBeNull();
  expect(working()?.textContent).toBe("Working…");
  await update([question, runEndItem()]);
  expect(working()).toBeNull();
});

test.each([1280, 390])("Working fallback covers a completed queued head until a running indicator is visible at %ipx", async width => {
  await page.viewport(width, 844);
  const run = (id: string) => partialItem({ ...toolPartial, partial_id: `tool:${id}`, tool_call_id: id, args: { path: `${id}.ts` } });
  const finish = (id: string) => eventItem({ ...toolEvent, event_id: id, tool_call_id: id, args: { path: `${id}.ts` } });
  const { update } = await liveList([run("a")], { running: true });
  const working = () => document.querySelector(".pwa-thinking-status");
  expect(working()).toBeNull();
  await update([finish("a"), run("b")]);
  expect(groupButton().querySelector(".pwa-tool-status-complete")).not.toBeNull();
  expect(working()?.textContent).toBe("Working…");
  await userEvent.click(groupButton());
  expect(document.querySelector(".pwa-tool-card .pwa-tool-spinner")).not.toBeNull();
  expect(working()).toBeNull();
  await userEvent.click(groupButton());
  // 不等待点击耗时后的具体组头姿态：只要当前有旋转图标就不应出现 Working。
  expect(working() === null).toBe(groupButton().querySelector(".pwa-tool-spinner, .pwa-spin") !== null);
  await expect.poll(() => groupButton().querySelector(".pwa-tool-group-current")?.textContent, { timeout: 4000 }).toBe("readb.ts");
  expect(working()).toBeNull();
  await update([run("a"), finish("b")]);
  expect(groupButton().querySelector(".pwa-tool-status-complete")).not.toBeNull();
  expect(working()?.textContent).toBe("Working…");
  await expect.poll(() => groupButton().querySelector(".pwa-tool-group-current"), { timeout: 4000 }).toBeNull();
  expect(groupButton().querySelector(".pwa-tool-group-summary .pwa-spin")).not.toBeNull();
  expect(working()).toBeNull();
  await update([finish("a"), finish("b")]);
  expect(groupButton().querySelector(".pwa-spin")).toBeNull();
  expect(working()?.textContent).toBe("Working…");
});

test.each([1280, 390])("Working fallback ignores old ended and idle residuals and respects run boundaries at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = {
    protocol_version: 2, type: "timeline_partial", session_id: toolPartial.session_id, leaf_id: toolPartial.leaf_id,
    group_id: toolPartial.group_id, partial_id: "old:thinking:0", kind: "thinking", status: "delta", delta: "Old thought",
  };
  const residuals = [partialItem(thinking), partialItem(toolPartial)];
  const user = (group: string) => eventItem({ ...assistantEvent, event_id: `user-${group}`, message_id: `user-${group}`, group_id: group, kind: "user", blocks: [{ type: "text", text: group }], origin: "pwa", sender_ref: "me", delivery: "normal", status: "committed" });
  const { update } = await liveList([user("group-1"), ...residuals], { running: true });
  const working = () => document.querySelector(".pwa-thinking-status");
  expect(working()).toBeNull();
  await update([user("group-1"), user("group-2"), ...residuals]);
  expect(working()?.textContent).toBe("Working…");
  await userEvent.click(groupButton());
  expect(working()?.textContent).toBe("Working…");
  await update([user("group-1"), runEndItem(), user("group-2"), ...residuals]);
  expect(working()?.textContent).toBe("Working…");
  await update([user("group-1"), runEndItem(), ...residuals]);
  expect(working()).toBeNull();
  // 空闲时看到的 partial，在新发送尚未获得 group_id 时仍是残留。
  await update([user("group-1"), ...residuals], { running: false });
  expect(working()).toBeNull();
  const fresh: TimelinePending = { ...unknownPending, id: "fresh", delivery: "pending" };
  await update([user("group-1"), fresh, ...residuals], { running: true });
  expect(working()?.textContent).toBe("Working…");
  await update([user("group-1"), fresh, ...residuals], { running: true, isLive: false });
  expect(working()).toBeNull();
  await update([user("group-1"), fresh, ...residuals], { running: false });
  expect(working()).toBeNull();
});

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

test("a streaming thinking row replaces headings with a leading live indicator", async () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "**First step**\nA.\n\n**Second step**\nB." };
  const { screen } = await liveList([partialItem(thinking)]);
  await expect.element(screen.getByText("Second step")).not.toBeInTheDocument();
  await expect.element(screen.getByText("First step")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("status").getByText("Thinking…")).toBeVisible();
  await expect.element(screen.getByText("Thought process")).not.toBeInTheDocument();
  const status = document.querySelector<HTMLElement>(".pwa-thinking-live")!;
  expect(status.firstElementChild?.matches("svg.pwa-spin")).toBe(true);
  expect(getComputedStyle(status).fontSize).toBe("16px");
  expect(getComputedStyle(status).fontWeight).toBe("600");
  expect(Math.round(status.getBoundingClientRect().left)).toBe(Math.round(document.querySelector(".pwa-thinking-head")!.getBoundingClientRect().left));
  expect(Math.round(status.querySelector("svg")!.getBoundingClientRect().right)).toBeLessThan(Math.round(status.querySelector("span")!.getBoundingClientRect().left));
});

test.each([1280, 390])("thinking and tool-group chevrons stay aligned across streaming completion at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "**First step**\nA.\n\n**Second step**\nB." };
  const { update } = await liveList([eventItem(toolEvent), partialItem(thinking)]);
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      await update([eventItem(toolEvent), partialItem(thinking)]);
      const toggle = document.querySelector<HTMLButtonElement>(".pwa-thinking-head")!;
      const chevronRight = () => Math.round(toggle.querySelector(".pwa-timeline-chevron")!.getBoundingClientRect().right);
      const groupRight = Math.round(groupButton().querySelector(".pwa-timeline-chevron")!.getBoundingClientRect().right);
      expect(chevronRight()).toBe(groupRight);
      await update([eventItem(toolEvent), eventItem(assistantEvent)]);
      expect(document.querySelector(".pwa-thinking-head")).toBe(toggle);
      expect(chevronRight()).toBe(groupRight);
    }
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
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
  await expect.element(screen.getByText("Thought process")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("status").getByText("Thinking…")).toBeVisible();
  await expect.element(screen.getByText("Inspecting the request.")).not.toBeInTheDocument();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
  const toggle = document.querySelector(".pwa-thinking .pwa-timeline-toggle");
  await update([eventItem(assistantEvent)]);
  expect(document.querySelector(".pwa-thinking .pwa-timeline-toggle")).toBe(toggle);
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  await expect.element(screen.getByText("Thought process")).toBeVisible();
  expect(document.querySelector(".pwa-thinking-live")).toBeNull();
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
  expect(document.querySelectorAll(".pwa-tool-group")).toHaveLength(1);
  await expandToolGroups();
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
  await expandToolGroups();
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

test("parallel completion preserves timeline order, groups and reader content", async () => {
  const before = { ...assistantEvent, event_id: "before", blocks: [{ type: "text" as const, text: "Before tools" }] };
  const between = { ...assistantEvent, event_id: "between", blocks: [{ type: "text" as const, text: "Between tools" }] };
  const laterTools = Array.from({ length: 6 }, (_, index) => eventItem({ ...toolEvent, event_id: `later-${index}`, tool_call_id: `later-${index}`, tool: "bash", args: { command: `echo ${index}` }, result: `Output ${index}` }));
  const { screen, update } = await liveList([eventItem(before), partialItem(toolPartial), eventItem(between), ...laterTools]);
  const originalOrder = [...document.querySelectorAll(".pwa-message-list > article")];
  // 正文把工具分成两段，各自从第一条起成组。
  expect(document.querySelectorAll(".pwa-tool-group")).toHaveLength(2);
  await userEvent.click(groupButton(0));
  const origin = toolButton();
  await userEvent.click(origin);
  await update([eventItem(before), eventItem(between), ...laterTools, eventItem({ ...toolEvent, args: toolPartial.args!, result: "Read completed last" }), runEndItem()]);
  expect([...document.querySelectorAll(".pwa-message-list > article")].slice(0, 3)).toEqual(originalOrder.slice(0, 3));
  expect(groupButton(0).getAttribute("aria-expanded")).toBe("true");
  expect(groupButton(1).getAttribute("aria-expanded")).toBe("false");
  expect(origin.isConnected).toBe(true);
  await expect.element(screen.getByText("Read completed last")).toBeVisible();
  await closeReader();
  await expect.poll(() => document.activeElement).toBe(origin);
  await userEvent.click(groupButton(1));
  await expect.poll(() => document.querySelectorAll(".pwa-tool-group .pwa-tool-card").length).toBe(7);
  expect(document.querySelectorAll(".pwa-tool-group .pwa-tool-action[aria-haspopup='dialog']")).toHaveLength(7);
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
  await expandToolGroups();
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
  // 状态未知的 partial 不作为组头当前工具，也没有旋转图标。
  expect(document.querySelector(".pwa-tool-group-current, .pwa-tool-group .pwa-spin")).toBeNull();
  await expandToolGroups();
  await expect.element(screen.getByRole("status", { name: "read: Status unknown" })).toBeVisible();
  await expect.element(screen.getByText("Streaming output")).not.toBeInTheDocument();
  expect(toolButton().getAttribute("aria-label")).toBe("View read tool details");
});

test("a repeated tool id in another session cannot inherit the old reader", async () => {
  const reading: boolean[] = [];
  const { screen, update } = await liveList([eventItem({ ...toolEvent, result: "Old session output" })], { onReadingChange: value => reading.push(value) });
  await expandToolGroups();
  await userEvent.click(toolButton());
  await expect.element(screen.getByText("Old session output")).toBeVisible();
  await update([eventItem({ ...toolEvent, session_id: "other-session", result: "New session output" })]);
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => reading.at(-1)).toBe(false);
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  expect(document.querySelector(".pwa-message-list")?.textContent).not.toContain("New session output");
  // 新会话的同名工具是另一个组，不继承旧组的展开选择。
  expect(groupButton().getAttribute("aria-expanded")).toBe("false");
});

test("images and structured output appear only in the direct reader without raw-data tabs", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const screen = await renderMessageList([eventItem({ ...toolEvent, args: { path: "image.png" }, result: [{ type: "text", text: "Image result" }, { type: "image", mimeType: "image/png", data: png }] })]);
  expect(document.querySelector(".pwa-message-list img")).toBeNull();
  await expandToolGroups();
  await userEvent.click(toolButton());
  await expect.element(screen.getByRole("dialog").getByRole("img", { name: "Tool output image 2" })).toBeVisible();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(document.querySelector(".pwa-message-list")?.textContent).not.toContain(png);
  await closeReader();
  await screen.unmount();
  const fallback = await renderMessageList([eventItem({ ...toolEvent, tool: "custom", result: { files: 3, ok: true } })]);
  await expandToolGroups();
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
  await expandToolGroups();
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
  await expandToolGroups();
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      const replyLeft = Math.round(document.querySelector(".pwa-message.assistant .pwa-markdown")!.getBoundingClientRect().left);
      // 组头与 Pi 回复左缘对齐；组内工具行在 2px 竖线加 12px 内边距之后。
      const group = groupButton();
      expect(Math.round(group.getBoundingClientRect().height)).toBe(44);
      expect(Math.round(group.getBoundingClientRect().left)).toBe(replyLeft);
      expect(Math.round(group.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
      expect(group.querySelector(".pwa-tool-chevron")).not.toBeNull();
      for (const action of document.querySelectorAll<HTMLElement>(".pwa-tool-card .pwa-tool-action")) {
        const rect = action.getBoundingClientRect();
        expect(Math.round(rect.height)).toBe(44);
        expect(Math.round(rect.left)).toBe(replyLeft + 14);
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
      expect(Math.round(document.querySelector(".pwa-tool-card .pwa-tool-action-copy strong")!.getBoundingClientRect().left)).toBe(replyLeft + 14);
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

test("tools join a live group from the first call and an open reader keeps its origin while the turn finishes", async () => {
  const first = { ...toolEvent, args: { path: "a.ts" }, result: "First output" };
  const second = { ...toolEvent, event_id: "second", tool_call_id: "second", args: { path: "b.ts" }, result: "Second output" };
  const running = { ...toolPartial, partial_id: "tool:third", tool_call_id: "third", args: { path: "c.ts" } };
  const reading: boolean[] = [];
  const { screen, update } = await liveList([eventItem(first)], { onReadingChange: value => reading.push(value) });
  const group = document.querySelector(".pwa-tool-group")!;
  expect(group.getAttribute("data-tool-group-size")).toBe("1");
  await update([eventItem(first), eventItem(second), partialItem(running)]);
  expect(document.querySelector(".pwa-tool-group")).toBe(group);
  // 组头按开始顺序排队显示新出现的工具（已结束的也显示一次）；组头出现后的变化才播放进入过渡。
  expect(groupButton().querySelector(".pwa-tool-group-current")?.textContent).toBe("readb.ts");
  expect(groupButton().querySelector(".pwa-tool-group-current")?.hasAttribute("data-enter")).toBe(true);
  await expect.poll(() => groupButton().querySelector(".pwa-tool-group-current")?.textContent, { timeout: 3000 }).toBe("readc.ts");
  expect(groupButton().getAttribute("aria-label")).toBe("Expand Running read c.ts · Read 3 files");
  // 末段运行中展开不加阅读锁，自动跟随继续。
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(false);
  expect(groupButton().querySelector(".pwa-tool-group-current")).toBeNull();
  expect(groupButton().textContent).toBe("Read 3 files");
  const origin = toolButton();
  await userEvent.click(origin);
  await expect.element(screen.getByText("First output")).toBeVisible();
  await update([eventItem(first), eventItem(second), eventItem({ ...toolEvent, event_id: "third", tool_call_id: "third", args: { path: "c.ts" }, result: "Third output" }), runEndItem()]);
  expect(document.querySelector(".pwa-tool-group")).toBe(group);
  expect(groupButton().getAttribute("aria-expanded")).toBe("true");
  expect(origin.isConnected).toBe(true);
  await expect.element(screen.getByText("First output")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  await closeReader("history");
  await expect.poll(() => reading.at(-1)).toBe(false);
  await expect.poll(() => document.activeElement).toBe(origin);
  // 已结束的组展开照旧暂停自动跟随。
  await userEvent.click(groupButton());
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(true);
});

test("the heading queues tools in start order, holds each briefly and never returns to an earlier one", async () => {
  const run = (id: string, command: string) => partialItem({ ...toolPartial, tool: "bash", partial_id: `tool:${id}`, tool_call_id: id, args: { command } });
  const finish = (id: string, command: string) => eventItem({ ...toolEvent, tool: "bash", event_id: id, tool_call_id: id, args: { command }, result: "ok" });
  const { update } = await liveList([run("test", "pnpm test")]);
  const current = () => groupButton().querySelector(".pwa-tool-group-current")?.textContent ?? null;
  // 组头状态图标沿用状态语义色，不被工具行文字的 secondary 覆盖。
  const tokenColor = (token: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.querySelector(".pwa-root")!.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  };
  const statusColor = () => getComputedStyle(groupButton().querySelector(".pwa-tool-group-current > .pwa-tool-status")!).color;
  expect(current()).toBe("bashpnpm test");
  expect(statusColor()).toBe(tokenColor("--pwa-running"));
  // build 开始时 test 刚进入组头，排队等 test 停满后再显示。
  await update([run("test", "pnpm test"), run("build", "pnpm build")]);
  expect(current()).toBe("bashpnpm test");
  await expect.poll(current, { timeout: 3000 }).toBe("bashpnpm build");
  // 结束的工具继续停留，图标换成结束状态；满最短停留时间后回到摘要，较早的 test 不再出现。
  await update([run("test", "pnpm test"), finish("build", "pnpm build")]);
  expect(current()).toBe("bashpnpm build");
  expect(groupButton().querySelector(".pwa-tool-group-current .pwa-tool-status-complete")).not.toBeNull();
  expect(statusColor()).toBe(tokenColor("--pwa-complete"));
  // 停留中的工具及其结束状态也在可访问名称里。
  expect(groupButton().getAttribute("aria-label")).toBe("Expand bash pnpm build: Complete · Ran 2 commands");
  await expect.poll(current, { timeout: 3000 }).toBeNull();
  // 摘要前的旋转图标只表示组内仍有工具在运行。
  expect(groupButton().querySelector(".pwa-tool-group-summary .pwa-spin")).not.toBeNull();
  expect(groupButton().textContent).toBe("Ran 2 commands");
  expect(groupButton().getAttribute("aria-label")).toBe("Expand 1 running · Ran 2 commands");
  await update([finish("test", "pnpm test"), finish("build", "pnpm build")]);
  expect(groupButton().querySelector(".pwa-spin")).toBeNull();
});

test("a live tool that first arrives already finished is still shown once in a new group", async () => {
  const { update } = await liveList([eventItem(assistantEvent)]);
  await update([eventItem(assistantEvent), eventItem({ ...toolEvent, tool: "bash", args: { command: "pnpm lint" }, result: "ok" })]);
  const current = () => groupButton().querySelector(".pwa-tool-group-current")?.textContent ?? null;
  expect(current()).toBe("bashpnpm lint");
  expect(groupButton().querySelector(".pwa-tool-group-current .pwa-tool-status-complete")).not.toBeNull();
  await expect.poll(current, { timeout: 3000 }).toBeNull();
});

test("a group split by late content does not replay tools already shown in the heading", async () => {
  const read = (id: string) => eventItem({ ...toolEvent, event_id: id, tool_call_id: id, args: { path: `${id}.ts` }, result: id });
  const late = eventItem({ ...assistantEvent, event_id: "late", blocks: [{ type: "text", text: "Late reply" }] });
  const { update } = await liveList([eventItem(assistantEvent)]);
  await update([eventItem(assistantEvent), read("a"), read("b")]);
  const current = (index = 0) => groupButton(index).querySelector(".pwa-tool-group-current")?.textContent ?? null;
  await expect.poll(() => current(), { timeout: 3000 }).toBe("readb.ts");
  await expect.poll(() => current(), { timeout: 3000 }).toBeNull();
  // 迟到的正文插入两条工具之间，b 所在的后半段作为新组挂载，不再重新显示 b。
  await update([eventItem(assistantEvent), read("a"), late, read("b")]);
  expect(document.querySelectorAll(".pwa-tool-group")).toHaveLength(2);
  expect(current(0)).toBeNull();
  expect(current(1)).toBeNull();
});

test("a burst of tools skips the heading to the latest once the backlog exceeds the limit", async () => {
  const run = (id: string) => partialItem({ ...toolPartial, tool: "bash", partial_id: `tool:${id}`, tool_call_id: id, args: { command: `echo ${id}` } });
  const { update } = await liveList([run("a")]);
  await update(["a", "b", "c", "d", "e"].map(run));
  expect(groupButton().querySelector(".pwa-tool-group-current")?.textContent).toBe("bashecho e");
});

test("earlier history keeps an expanded group expanded with the same identity", async () => {
  const read = (id: string): TimelineViewItem => eventItem({ ...toolEvent, event_id: id, tool_call_id: id, args: { path: `${id}.ts` }, result: id });
  const { update } = await liveList([read("b"), read("c")]);
  const group = document.querySelector(".pwa-tool-group")!;
  await userEvent.click(groupButton());
  await update([read("a"), read("b"), read("c")]);
  expect(document.querySelector(".pwa-tool-group")).toBe(group);
  expect(group.getAttribute("data-tool-group-size")).toBe("3");
  expect(groupButton().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelectorAll(".pwa-tool-group .pwa-tool-card")).toHaveLength(3);
});

test("reduced motion keeps the running indicator and uses a short reader fade", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    const { screen } = await liveList([partialItem(toolPartial)]);
    expect(getComputedStyle(groupButton().querySelector(".pwa-tool-group-current .pwa-tool-status-running > svg")!).animationName).not.toBe("none");
    await expandToolGroups();
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
  for (const name of ["Expand Used tools 1 time", "Expand thinking", "Retry delivery", "Cancel queued message"]) {
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
    await expandToolGroups();
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

test("groups adjacent tools of one turn including failures, and marks the failure on the group", async () => {
  const read = (id: string, path: string): Extract<TimelineEvent, { kind: "tool" }> => ({ ...toolEvent, event_id: id, tool_call_id: id, args: { path }, result: "ok" });
  const failed: Extract<TimelineEvent, { kind: "tool" }> = { ...toolEvent, event_id: "failed", tool_call_id: "failed", tool: "bash", args: { command: "pnpm lint" }, status: "error", error: "Lint failed" };
  const otherTurn: Extract<TimelineEvent, { kind: "tool" }> = { ...read("other-turn", "d.ts"), group_id: "group-2" };
  const reading: boolean[] = [];
  await liveList([...([read("a", "a.ts"), read("b", "b.ts"), failed, read("c", "c.ts"), read("d", "a.ts"), otherTurn].map(eventItem)), runEndItem()], { onReadingChange: value => reading.push(value) });
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  // 另一轮的工具单独成组，不与本轮合并。
  expect(list.querySelectorAll(":scope > .pwa-tool-group")).toHaveLength(2);
  expect(list.querySelectorAll(":scope > .pwa-tool-card")).toHaveLength(0);
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
    // 内容淡入取 --pwa-duration-content（240ms），比通用淡化长，肉眼能看到渐入过程。
    const fadeIndex = animate.mock.contexts.findIndex((element) => (element as Element).classList.contains("pwa-message-list"));
    expect(animate.mock.calls[fadeIndex]![1]).toMatchObject({ duration: 240 });
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
