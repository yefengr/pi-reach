import { createRef, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { MessageList } from "./message-list";
import { toolHeaderSummary, toolInlineText } from "./tool-presentation";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import { TimelineRuntime, type TimelinePending, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { StreamDisplayBuffer } from "@/lib/pwa/stream-display-buffer";
import { ThinkingTextParser } from "@/lib/pwa/thinking-text-parser";
import { ThinkingProcessHeading } from "./thinking-process-row";
import { THINKING_SUMMARY_WINDOW_MS } from "./use-thinking-heading";

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
function groupButton(index = 0): HTMLButtonElement { return document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head")[index]!; }
/** 已停止的过程组默认收起；需要操作明细行时先展开所有收起的组。 */
async function expandToolGroups() {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head[aria-expanded='false']")) await userEvent.click(toggle);
}
async function closeReader(key: "escape" | "history" = "escape") {
  await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
  if (key === "history") window.history.back();
  else await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => window.history.state?.piReachToolReader === true).toBe(false);
}
/** 思考明细行的标题；运行中的过程组默认展开，标题与阅读入口都在明细行。 */
const rowHeading = (index = 0) => document.querySelectorAll<HTMLElement>(".pwa-thinking-process-row .pwa-process-thinking-heading")[index] ?? null;
const rowHeadings = () => [...document.querySelectorAll<HTMLElement>(".pwa-thinking-process-row .pwa-process-thinking-heading")];
const listText = () => document.querySelector(".pwa-message-list")?.textContent ?? "";
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
  return renderPwa(<MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} onRetryFailed={() => {}} onCheckStatus={() => {}} onCancelQueued={() => {}} {...overrides} />);
}

test("all message row consumers declare distinct semantic viewport identities", async () => {
  const user: TimelineEvent = {
    event_id: "user", message_id: "user", session_id: "session-1", leaf_id: "history-1", group_id: "user", timestamp: 0,
    kind: "user", origin: "pwa", sender_ref: "self", status: "committed", delivery: "normal", blocks: [{ type: "text", text: "User text" }],
  };
  const summary: TimelineEvent = { event_id: "summary", session_id: "session-1", leaf_id: "history-1", timestamp: 2, kind: "compaction", payload: "Summary", truncated: false };
  const file: TimelineEvent = { event_id: "published", session_id: "session-1", leaf_id: "history-1", group_id: "file", timestamp: 3, kind: "custom", truncated: false,
    payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: "report.txt", mime_type: "text/plain", byte_length: 10, tool_call_id: "publish" } },
  };
  const screen = await renderMessageList([eventItem(user), unknownPending, eventItem(assistantEvent), eventItem(toolEvent), eventItem(summary), eventItem(file)]);
  try {
    const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
    const rows = [...list.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element.hasAttribute("data-viewport-row"));
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map(row => row.dataset.viewportRow)).size).toBe(rows.length);
    for (const selector of [".pwa-user-row", ".pwa-message.assistant", ".pwa-process-group", ".pwa-summary-entry", ".pwa-published-file"]) {
      for (const row of list.querySelectorAll<HTMLElement>(`:scope > ${selector}`)) expect(row.dataset.viewportRow).toBeTruthy();
    }
    expect(list.querySelector(".pwa-bottom-sentinel")?.hasAttribute("data-viewport-row")).toBe(false);
    await expandToolGroups();
    const tool = list.querySelector<HTMLElement>(".pwa-tool-card")!;
    // 组内成员不是独立的顶层消息行，只由所在过程组承担视口身份。
    expect(tool.hasAttribute("data-viewport-row")).toBe(false);
    expect(tool.closest(".pwa-process-group")?.parentElement).toBe(list);
  } finally { await screen.unmount(); }
});

test.each(["body", "tool"])("prepended gaps stay before retained %s and preserve the thinking trace node", async kind => {
  const empty: TimelineEvent = { ...assistantEvent, event_id: "later-empty", blocks: [{ type: "thinking", text: "" }] };
  const middle = kind === "body" ? eventItem({ ...assistantEvent, event_id: "middle-body", blocks: [{ type: "text", text: "Visible body" }] }) : eventItem(toolEvent);
  const { update } = await liveList([middle, eventItem(empty)]);
  // 正文之后的空痕迹单独成静态行；同轮相邻的工具与空痕迹合为同一个过程组。
  const groups = () => [...document.querySelectorAll(".pwa-message-list > .pwa-process-group")];
  const trace = groups().at(-1)!;
  const row = document.querySelector(kind === "body" ? ".pwa-message.assistant" : ".pwa-process-group")!;
  expect(trace.querySelector(".pwa-process-head-static") !== null).toBe(kind === "body");
  await update([eventItem({ ...empty, event_id: "earlier-empty" }), middle, eventItem(empty)], { gapBefore: new Set(["earlier-empty"]) });
  const gap = document.querySelector(".pwa-timeline-gap")!;
  // 补齐更早的空记录不增加痕迹，也不改变已有行的身份与相对位置。
  expect(groups()).toHaveLength(1);
  expect(groups().at(-1)).toBe(trace);
  expect(document.querySelector(kind === "body" ? ".pwa-message.assistant" : ".pwa-process-group")).toBe(row);
  expect(gap.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  if (kind === "body") expect(row.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  else expect(row).toBe(trace);
});

test("a single gap splits reverse-completed tools without reordering or duplicating notices", async () => {
  const empty: TimelineEvent = { ...assistantEvent, event_id: "later-empty", blocks: [{ type: "thinking", text: "" }] };
  const running = (id: string) => partialItem({ ...toolPartial, partial_id: `tool:${id}`, tool_call_id: id, args: { path: `${id}.ts` } });
  const complete = (id: string, timestamp: number) => eventItem({ ...toolEvent, event_id: `event-${id}`, tool_call_id: id, timestamp, args: { path: `${id}.ts` } });
  const { update } = await liveList([running("a"), running("b"), eventItem(empty)]);
  // 同轮相邻的工具与空痕迹从一开始就在同一个过程组内。
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(1);
  await update([eventItem({ ...empty, event_id: "earlier-empty" }), complete("b", 2), complete("a", 3), eventItem(empty)], { gapBefore: new Set(["event-a"]) });
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(2);
  expect(document.querySelectorAll(".pwa-timeline-gap")).toHaveLength(1);
  expect([...document.querySelectorAll(".pwa-message-list > .pwa-timeline-gap, .pwa-message-list > .pwa-process-group")].map(row => row.classList.contains("pwa-timeline-gap") ? "gap" : "group")).toEqual(["gap", "group", "group"]);
  // 缺口断开分组但不重复提示，空痕迹仍只保留一份。
  expect(document.querySelectorAll(".pwa-process-head-static")).toHaveLength(0);
  await expandToolGroups();
  expect([...document.querySelectorAll(".pwa-tool-card .pwa-tool-action")].map(row => row.textContent)).toEqual([expect.stringContaining("a.ts"), expect.stringContaining("b.ts")]);
});

test("paced thinking parses only new characters through the real presentation and component chain", async () => {
  const buffer = new StreamDisplayBuffer();
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "" };
  const original = ThinkingTextParser.prototype.read;
  let scanned = 0;
  const spy = vi.spyOn(ThinkingTextParser.prototype, "read").mockImplementation(function (this: ThinkingTextParser, text, epoch, streaming) {
    const before = this.scannedCharacters;
    const result = original.call(this, text, epoch, streaming);
    scanned += this.scannedCharacters - before;
    return result;
  });
  try {
    const { update } = await liveList(buffer.ingest([partialItem(thinking)]).items, { running: true });
    expect(rowHeading()?.textContent).toBe("Thinking…");
    const target = `${"x".repeat(1024)}\n**First title**\nBody\n**Latest title**`;
    for (let length = 32; length < target.length; length += 32) {
      await update(buffer.ingest([partialItem({ ...thinking, delta: target.slice(0, length) })]).items);
      await update(buffer.advance().items);
    }
    await update(buffer.ingest([partialItem({ ...thinking, delta: target })]).items);
    while (buffer.hasPending()) await update(buffer.advance().items);
    expect(scanned).toBe(target.length);
    expect(rowHeading()?.getAttribute("title")).toBe("Latest title");
    // 思考正文只经 Reader 阅读，时间线不铺开。
    expect(listText()).not.toContain("x".repeat(64));
    await update(buffer.snapshot());
    expect(scanned).toBe(target.length);
    await update(buffer.ingest([eventItem({ ...assistantEvent, blocks: [{ type: "thinking", text: target }] })]).items);
    expect(scanned).toBe(target.length * 2);
    expect(rowHeading()?.getAttribute("title")).toBe("Latest title");
    await update(buffer.snapshot());
    expect(scanned).toBe(target.length * 2);
  } finally { spy.mockRestore(); }
});

test.each(["assistant", "thinking"] as const)("cumulative %s thinking blocks parse only new characters through the real component chain", async kind => {
  const buffer = new StreamDisplayBuffer();
  const thought: Extract<TimelinePartial, { kind: "thinking" }> = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", blocks: [{ type: "thinking", text: "" }] };
  const snapshot = (text: string): TimelineViewItem[] => buffer.ingest([partialItem({ ...thought, kind, blocks: [{ type: "thinking", text }] })]).items;
  const original = ThinkingTextParser.prototype.read;
  let scanned = 0;
  const spy = vi.spyOn(ThinkingTextParser.prototype, "read").mockImplementation(function (this: ThinkingTextParser, text, epoch, streaming) {
    const before = this.scannedCharacters;
    const result = original.call(this, text, epoch, streaming);
    scanned += this.scannedCharacters - before;
    return result;
  });
  try {
    const { update } = await liveList(snapshot(""), { running: true });
    const target = `${"x".repeat(1024)}\n**First title**\nBody\n**Latest title**`;
    for (let length = 32; length < target.length; length += 32) {
      await update(snapshot(target.slice(0, length)));
      await update(buffer.advance().items);
    }
    await update(snapshot(target));
    expect(scanned).toBe(target.length);
    expect(rowHeading()?.getAttribute("title")).toBe("Latest title");
    expect(listText()).not.toContain("x".repeat(64));
    await update(buffer.snapshot());
    expect(scanned).toBe(target.length);
    const replacement = `${"y".repeat(1024)}\n**Other title**\nBody\n**Newest title**`;
    await update(snapshot(replacement));
    expect(scanned).toBe(target.length + replacement.length);
    expect(rowHeading()?.getAttribute("title")).toBe("Newest title");
    await update(buffer.ingest([eventItem({ ...assistantEvent, blocks: [{ type: "thinking", text: replacement }] })]).items);
    expect(scanned).toBe(target.length + replacement.length * 2);
    expect(rowHeading()?.getAttribute("title")).toBe("Newest title");
    await update(buffer.snapshot());
    expect(scanned).toBe(target.length + replacement.length * 2);
  } finally { spy.mockRestore(); }
});

test("mixed cumulative blocks keep multiple thinking components incremental and rebuild at boundary replacement", async () => {
  const buffer = new StreamDisplayBuffer();
  const assistant: Extract<TimelinePartial, { kind: "assistant" }> = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:assistant:0", kind: "assistant", status: "delta" };
  const snapshot = (blocks: NonNullable<typeof assistant.blocks>): TimelineViewItem[] => buffer.ingest([partialItem({ ...assistant, blocks })]).items;
  const initial: NonNullable<typeof assistant.blocks> = [{ type: "thinking", text: "**First**\n" }, { type: "text", text: "Answer" }, { type: "thinking", text: "**Second**\n" }];
  const original = ThinkingTextParser.prototype.read;
  let scanned = 0;
  const spy = vi.spyOn(ThinkingTextParser.prototype, "read").mockImplementation(function (this: ThinkingTextParser, text, epoch, streaming) {
    const before = this.scannedCharacters;
    const result = original.call(this, text, epoch, streaming);
    scanned += this.scannedCharacters - before;
    return result;
  });
  try {
    const { update } = await liveList(snapshot(initial), { running: true });
    for (let length = 32; length <= 512; length += 32) {
      await update(snapshot(initial.map(block => ({ ...block, text: `${block.text}${"x".repeat(length)}` }))));
    }
    const grown = initial.map(block => ({ ...block, text: `${block.text}${"x".repeat(512)}` }));
    const appended = [...grown, { type: "thinking" as const, text: "**Third**" }];
    await update(snapshot(appended));
    const count = appended.filter(block => block.type === "thinking").reduce((sum, block) => sum + block.text.length, 0);
    expect(scanned).toBe(count);
    expect(rowHeadings().map(element => element.getAttribute("title"))).toEqual(["First", "Second", "Third"]);
    // joined 文本完全相同，但首块边界改变；必须展示新边界并重建保留的解析器。
    const rebounded: NonNullable<typeof assistant.blocks> = [{ type: "thinking", text: `${grown[0]!.text}\n${grown[1]!.text}` }, ...appended.slice(2)];
    await update(snapshot(rebounded));
    expect(scanned).toBe(count + rebounded.reduce((sum, block) => sum + block.text.length, 0));
    expect(rowHeadings()).toHaveLength(3);
    expect(document.querySelector(".pwa-message.assistant")).toBeNull();
    await update(buffer.snapshot());
    expect(scanned).toBe(count + rebounded.reduce((sum, block) => sum + block.text.length, 0));
  } finally { spy.mockRestore(); }
});

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
  const headWorking = () => document.querySelector(".pwa-process-working");
  expect(working()?.textContent).toBe("Working…");
  // 与它替代的思考标题／过程组头同字号、同字重；运行色与图标一致，但保持正体。
  const workingStyle = getComputedStyle(working()!);
  expect(workingStyle.fontSize).toBe("16px");
  expect(workingStyle.fontWeight).toBe("600");
  expect(workingStyle.fontStyle).toBe("normal");
  expect(workingStyle.color).toBe(getComputedStyle(working()!.querySelector("svg")!).color);
  // 图标与状态文字统一取 6px 语义档。
  expect(workingStyle.gap).toBe("6px");
  await update([question, partialItem(thinking)]);
  expect(working()).toBeNull();
  expect(headWorking()).toBeNull();
  await expect.element(screen.getByText("Inspecting the request.")).toBeVisible();
  expect(document.querySelector(".pwa-thinking-process-row .pwa-process-status-running")).not.toBeNull();
  // 思考正文只经 Reader 阅读；明细行只是阅读入口。
  expect(document.querySelector(".pwa-thinking-process-row-action")?.getAttribute("aria-haspopup")).toBe("dialog");
  // 手动收起后组头接管当前思考的运行提示，Working 不重复出现。
  await userEvent.click(groupButton());
  expect(groupButton().querySelector(".pwa-process-status-running")).not.toBeNull();
  expect(working()).toBeNull();
  expect(headWorking()).toBeNull();
  await userEvent.click(groupButton());
  await update([question, thought, partialItem(toolPartial)]);
  // 正式思考不再运行；同轮工具加入同一过程组并承担运行提示。
  expect(document.querySelector(".pwa-thinking-process-row .pwa-process-status-running")).toBeNull();
  expect(document.querySelector(".pwa-process-details .pwa-tool-spinner")).not.toBeNull();
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(1);
  await expect.element(screen.getByRole("status", { name: "read: Running" })).toBeVisible();
  expect(working()).toBeNull();
  expect(headWorking()).toBeNull();
  await userEvent.click(groupButton());
  expect(groupButton().querySelector(".pwa-process-status-running > .pwa-spin")).not.toBeNull();
  await expect.poll(working).toBeNull();
  expect(headWorking()).toBeNull();
  await userEvent.click(groupButton());
  // 工具结束但 Pi 仍 working：立即由末段组头承载 Working，不等任何停留时间。
  await update([question, thought, eventItem({ ...toolEvent, args: toolPartial.args! })]);
  await expect.poll(() => headWorking()?.textContent).toBe("Working…");
  expect(working()).toBeNull();
  const body: TimelinePartial = { ...thinking, partial_id: "body:assistant:0", kind: "assistant", delta: "Streaming body" };
  await update([question, thought, eventItem(toolEvent), partialItem(body)]);
  await expect.element(screen.getByText("Streaming body")).toBeVisible();
  // 正文之后不能把通用 Working 挂回较早的过程组。
  expect(headWorking()).toBeNull();
  expect(working()?.textContent).toBe("Working…");
  // 过程组被移除后不能留下旧报告，压制兜底。
  await update([question]);
  expect(document.querySelector(".pwa-process-group")).toBeNull();
  expect(working()?.textContent).toBe("Working…");
  await update([question, runEndItem()]);
  expect(working()).toBeNull();
});

test.each([1280, 390])("Working stays hidden while a member still runs, even after later body, at %ipx", async width => {
  await page.viewport(width, 844);
  const run = (id: string) => partialItem({ ...toolPartial, partial_id: `tool:${id}`, tool_call_id: id, args: { path: `${id}.ts` } });
  const finish = (id: string) => eventItem({ ...toolEvent, event_id: id, tool_call_id: id, args: { path: `${id}.ts` } });
  const { update } = await liveList([run("a")], { running: true });
  const working = () => document.querySelector(".pwa-thinking-status, .pwa-process-working");
  expect(working()).toBeNull();
  await update([finish("a"), run("b")]);
  // 手动收起后组头显示仍有效的成员，不排队补播已完成调用。
  await userEvent.click(groupButton());
  await expect.poll(() => document.querySelector(".pwa-process-details")).toBeNull();
  expect(groupButton().querySelector(".pwa-process-tool-detail")?.textContent).toBe("b.ts");
  const spinner = groupButton().querySelector(".pwa-process-status-running > .pwa-spin");
  expect(spinner).not.toBeNull();
  expect(working()).toBeNull();
  await update([run("a"), finish("b")]);
  expect(groupButton().querySelector(".pwa-process-tool-detail")?.textContent).toBe("a.ts");
  expect(groupButton().querySelector(".pwa-process-status-running > .pwa-spin")).toBe(spinner);
  expect(working()).toBeNull();
  const after = eventItem({ ...assistantEvent, event_id: "after-tools", blocks: [{ type: "text", text: "After tools" }] });
  // 即使后续正文已出现，较早工具还在运行时不伪造结束，也不重复显示 Working。
  await update([run("a"), finish("b"), after]);
  expect(groupButton().querySelector(".pwa-process-tool-detail")?.textContent).toBe("a.ts");
  expect(working()).toBeNull();
  await update([finish("a"), finish("b"), after]);
  expect(groupButton().querySelector(".pwa-spin")).toBeNull();
  expect(document.querySelector(".pwa-process-working")).toBeNull();
  expect(document.querySelector(".pwa-thinking-status")?.textContent).toBe("Working…");
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

test("a completed thinking group toggles by keyboard and only exposes its Reader entry while the answer stays visible", async () => {
  const screen = await renderMessageList([eventItem(assistantEvent)]);
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  const toggle = groupButton();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  const row = screen.getByRole("button", { name: "Read thinking" });
  await expect.element(row).toBeVisible();
  // 已结束且没有完整加粗标题时明细显示「Thinking」，正文只在 Reader 中。
  expect(rowHeading()?.textContent).toBe("Thinking");
  await expect.element(screen.getByText("Inspecting the request.")).not.toBeInTheDocument();
  expect(document.querySelector(".pwa-process-details .pwa-markdown, .pwa-process-details .pwa-tool-code")).toBeNull();
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  await userEvent.keyboard(" ");
  await expect.element(row).not.toBeInTheDocument();
});

test("a thinking row is titled by its latest bold heading while the collapsed group uses the localized label", async () => {
  const titled: TimelineEvent = { ...assistantEvent, blocks: [{ type: "thinking", text: "**Earlier stage**\n**Checking the group rules**\nInspecting the request." }, { type: "text", text: "The final answer." }] };
  const screen = await renderMessageList([eventItem(titled)]);
  expect(groupButton().getAttribute("title")).toBe("Thinking");
  await userEvent.click(groupButton());
  await expect.element(screen.getByText("Checking the group rules")).toBeVisible();
  await expect.element(screen.getByText("Earlier stage")).not.toBeInTheDocument();
  expect(document.querySelector(".pwa-process-status-running")).toBeNull();
});

test.each([1280, 390])("empty thinking settles into one static historical trace per turn at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = {
    protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1",
    group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "running", delta: "",
  };
  const empty: TimelineEvent = { ...assistantEvent, blocks: [{ type: "thinking", text: "" }, { type: "thinking", text: " \t\n" }] };
  const later: TimelineEvent = { ...empty, event_id: "later-empty", leaf_id: "history-2", timestamp: 2 };
  const { screen, update } = await liveList([partialItem(thinking)], { running: true, isLive: true });
  expect(rowHeading()?.textContent).toBe("Thinking…");
  await update([eventItem(empty), eventItem(later)], { running: true, isLive: true });
  const trace = document.querySelector<HTMLElement>(".pwa-process-head-static")!;
  await expect.element(page.elementLocator(trace)).toHaveTextContent("Thinking");
  expect(getComputedStyle(trace).fontStyle).toBe("italic");
  expect(document.querySelectorAll(".pwa-process-head-static")).toHaveLength(1);
  // 静态痕迹只有中性图标，没有入口、折叠或运行状态。
  expect(trace.querySelector("button, .pwa-spin, [role='status'], [aria-expanded], .pwa-collapse")).toBeNull();
  // 历史痕迹不是运行指示，不能压制本轮 Working 兜底。
  expect(document.querySelector(".pwa-thinking-status")?.textContent).toBe("Working…");
  const earlier: TimelineEvent = { ...empty, event_id: "earlier-empty", timestamp: 0 };
  await update([eventItem(earlier), eventItem(empty), eventItem(later), runEndItem()], { running: false, isLive: false });
  expect(document.querySelector(".pwa-process-head-static")).toBe(trace);
  expect(document.querySelectorAll(".pwa-process-head-static")).toHaveLength(1);
  expect(document.querySelector(".pwa-thinking-status, .pwa-process-working, .pwa-spin")).toBeNull();
  const readable: TimelineEvent = { ...assistantEvent, event_id: "readable-thinking" };
  await update([eventItem(empty), eventItem(later), eventItem(readable), runEndItem()], { running: false, isLive: false });
  // 可读思考与空痕迹相邻同轮，合入同一过程组；组头收起，展开后才出现阅读入口。
  const readableHead = groupButton();
  expect(readableHead.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(readableHead);
  await expect.element(screen.getByRole("button", { name: "Read thinking" })).toBeVisible();
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
});

test.each([1280, 390])("streaming thinking advances only to complete headings beside its live indicator at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "**First step**\nA." };
  const { screen, update } = await liveList([partialItem(thinking)], { running: true });
  await expect.element(screen.getByText("First step")).toBeVisible();
  await update([partialItem({ ...thinking, delta: `${thinking.delta}\n\n**Second step` })]);
  expect(rowHeading()?.textContent).toBe("First step");
  await update([partialItem({ ...thinking, delta: `${thinking.delta}\n\n**Second step**\nB.\n**Unfinished` })]);
  await expect.element(screen.getByText("Second step")).toBeVisible();
  await expect.element(screen.getByText("First step")).not.toBeInTheDocument();
  const heading = rowHeading()!;
  const row = heading.closest<HTMLElement>(".pwa-thinking-process-row-action")!;
  expect(heading.getAttribute("title")).toBe("Second step");
  // 固定 16px 状态槽在前，标题紧随其后；运行状态只由图标表达。
  const slot = row.firstElementChild as HTMLElement;
  expect(slot.matches(".pwa-process-status-slot.pwa-process-status-running")).toBe(true);
  expect(Math.round(slot.getBoundingClientRect().width)).toBe(16);
  expect(Math.round(slot.getBoundingClientRect().left)).toBe(Math.round(row.getBoundingClientRect().left));
  expect(slot.querySelector("svg")?.getAttribute("width")).toBe("16");
  expect(getComputedStyle(heading).fontSize).toBe("16px");
  expect(getComputedStyle(heading).fontStyle).toBe("italic");
  expect(listText()).not.toContain("B.");
  expect(heading.textContent).not.toContain("Thinking…");
});

test("thinking headings never show Markdown fragments and replace complete titles atomically", async () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "" };
  const { update } = await liveList([partialItem(thinking)], { running: true });
  const title = () => rowHeading()?.textContent;
  for (const delta of ["*", "**", "**Checkin", "**Checking*"]) {
    await update([partialItem({ ...thinking, delta })]);
    expect(title()).toBe("Thinking…");
  }
  await update([partialItem({ ...thinking, delta: "**Checking**" })]);
  expect(title()).toBe("Checking");
  await update([partialItem({ ...thinking, delta: "**Checking**\nBody\n**Verifying" })]);
  expect(title()).toBe("Checking");
  await update([partialItem({ ...thinking, delta: "**Checking**\nBody\n**Verifying**" })]);
  expect(title()).toBe("Verifying");
  await update([eventItem({ ...assistantEvent, blocks: [{ type: "thinking", text: "**Checking**\nBody\n**Verifying**" }] })]);
  expect(rowHeading()?.getAttribute("title")).toBe("Verifying");
  expect(document.querySelector(".pwa-thinking-process-row .pwa-process-status-running, .pwa-thinking-process-row [role='status']")).toBeNull();
});

test.each([
  [true, "：接着说明"], [true, " 接着说明"], [false, "：接着说明"], [false, " 接着说明"],
] as const)("thinking recovers inline bold summaries after streamed heading fragments (trusted epoch: %s, suffix: %s)", async (trusted, suffix) => {
  let update!: (text: string) => void;
  const epoch = trusted ? {} : undefined;
  function Harness() {
    const [text, setText] = useState("");
    update = next => flushSync(() => setText(next));
    return <ThinkingProcessHeading entry={{ kind: "thinking", key: "thinking", groupId: "group", text, streaming: true, thinkingTextEpoch: epoch }} status="running" />;
  }
  await renderPwa(<Harness />);
  const title = () => document.querySelector(".pwa-process-thinking-heading")?.textContent;
  const advance = (ms: number) => flushSync(() => vi.advanceTimersByTime(ms));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    for (const fragment of ["*", "**", "**检查*", "**检查**"]) {
      update(fragment);
      advance(THINKING_SUMMARY_WINDOW_MS);
      expect(title()).toBe(fragment === "**检查**" ? "检查" : "Thinking…");
    }
    const summary = `**检查**${suffix}`;
    update(summary);
    expect(title()).toBe("Thinking…");
    advance(THINKING_SUMMARY_WINDOW_MS - 1);
    expect(title()).toBe("Thinking…");
    advance(1);
    expect(title()).toBe(summary);
    const body = `${summary}\n${"Long body ".repeat(60)}`;
    update(body);
    advance(THINKING_SUMMARY_WINDOW_MS);
    expect(title()).toBe(summary);
    update(`${body}\n**Current**`);
    expect(title()).toBe("Current");
    update(`${body}\n**Current**\n**Unfinished`);
    advance(THINKING_SUMMARY_WINDOW_MS * 2);
    expect(title()).toBe("Current");
  } finally { vi.useRealTimers(); }
});

test.each([true, false])("thinking clears an invalidated provisional heading (trusted epoch: %s)", async trusted => {
  let update!: (text: string) => void;
  const epoch = trusted ? {} : undefined;
  function Harness() {
    const [text, setText] = useState("**Title**");
    update = next => flushSync(() => setText(next));
    return <ThinkingProcessHeading entry={{ kind: "thinking", key: "thinking", groupId: "group", text, streaming: true, thinkingTextEpoch: epoch }} status="running" />;
  }
  await renderPwa(<Harness />);
  const title = () => document.querySelector(".pwa-process-thinking-heading")?.textContent;
  expect(title()).toBe("Title");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    // 末行尚无换行；追加普通文字后不再是整行加粗标题，窗口到期后回到真实摘要。
    update("**Title** continuation");
    expect(title()).toBe("Thinking…");
    flushSync(() => vi.advanceTimersByTime(THINKING_SUMMARY_WINDOW_MS));
    expect(title()).toBe("**Title** continuation");
    update("**Title** continuation\n**Current**");
    expect(title()).toBe("Current");
    if (trusted) return;
    // 未携带 epoch 的独立消费者也能替换正文，不能锁存上一份文本的标题。
    update("Fresh summary");
    expect(title()).not.toBe("Current");
    flushSync(() => vi.advanceTimersByTime(THINKING_SUMMARY_WINDOW_MS));
    expect(title()).toBe("Fresh summary");
  } finally { vi.useRealTimers(); }
});

test("thinking summary uses a bounded window and cancels stale work on replacement, completion and unmount", async () => {
  let update!: (text: string, epoch?: object, streaming?: boolean) => void;
  const epoch = {};
  function Harness() {
    const [state, setState] = useState({ text: "Seed", epoch, streaming: true });
    update = (text, nextEpoch = epoch, streaming = true) => flushSync(() => setState({ text, epoch: nextEpoch, streaming }));
    return <ThinkingProcessHeading entry={{ kind: "thinking", key: "thinking", groupId: "group", text: state.text, streaming: state.streaming, thinkingTextEpoch: state.epoch }} status={state.streaming ? "running" : "neutral"} />;
  }
  const screen = await renderPwa(<Harness />);
  await expect.poll(() => document.querySelector(".pwa-process-thinking-heading")?.textContent).toBe("Seed");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const title = () => document.querySelector(".pwa-process-thinking-heading")?.textContent;
  const advance = (ms: number) => { flushSync(() => vi.advanceTimersByTime(ms)); };
  try {
    update("Seed one");
    expect(title()).toBe("Seed");
    await advance(THINKING_SUMMARY_WINDOW_MS / 3);
    update("Seed one two");
    await advance(THINKING_SUMMARY_WINDOW_MS / 3);
    update("Seed one two three");
    expect(title()).toBe("Seed");
    await advance(THINKING_SUMMARY_WINDOW_MS / 3);
    expect(title()).toBe("Seed one two three");
    update("Seed one two three four");
    update("Seed one two three four\n**Complete**");
    expect(title()).toBe("Complete");
    await advance(THINKING_SUMMARY_WINDOW_MS * 2);
    expect(title()).toBe("Complete");
    const replacementEpoch = {};
    update("Fresh", replacementEpoch);
    expect(title()).toBe("Fresh");
    update("Fresh pending", replacementEpoch);
    update("**", {});
    expect(title()).toBe("Thinking…");
    await advance(THINKING_SUMMARY_WINDOW_MS * 2);
    expect(title()).toBe("Thinking…");
    update("No heading", replacementEpoch);
    update("No heading pending", replacementEpoch);
    update("No heading pending", replacementEpoch, false);
    expect(title()).toBe("Thinking");
    await advance(THINKING_SUMMARY_WINDOW_MS * 2);
    expect(title()).toBe("Thinking");
    const unmountEpoch = {};
    update("Unmount", unmountEpoch);
    update("Unmount pending", unmountEpoch);
    await screen.unmount();
    await advance(THINKING_SUMMARY_WINDOW_MS * 2);
    expect(document.querySelector(".pwa-process-thinking-heading")).toBeNull();
  } finally { vi.useRealTimers(); }
});

test.each([1280, 390])("streaming titles update in place without announcing every increment at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "" };
  const before = eventItem({ ...assistantEvent, event_id: "before-thinking", blocks: [{ type: "text", text: "Before thinking" }] });
  const { update } = await liveList([before], { running: true });
  await update([before, partialItem(thinking)]);
  const group = document.querySelector<HTMLElement>(".pwa-process-group")!;
  // 空文本时是静态行；出现可读正文后切换为阅读入口，此后标题原位更新。
  await update([before, partialItem({ ...thinking, delta: "I" })]);
  const heading = rowHeading()!;
  // 标题增量不进入 live region；可访问名称由入口按钮与组头提供。
  expect(heading.closest("[aria-live]:not([aria-live='off']), [role='status']")).toBeNull();
  const updates = [
    { text: "I", title: "I" },
    { text: "Inspect", title: "Inspect" },
    { text: "Inspecting the request.", title: "Inspecting the request." },
    { text: "**First stage**\nBody.\n**Second", title: "First stage" },
    { text: "**First stage**\nBody.\n**Second stage**\nMore reasoning.", title: "Second stage" },
  ];
  for (const { text, title } of updates) {
    await update([before, partialItem({ ...thinking, delta: text })]);
    expect(document.querySelector(".pwa-process-group")).toBe(group);
    expect(rowHeading()).toBe(heading);
    await expect.poll(() => heading.textContent).toBe(title);
    expect(heading.closest("[aria-live]:not([aria-live='off']), [role='status']")).toBeNull();
    expect(document.querySelector(".pwa-thinking-status, .pwa-process-working")).toBeNull();
  }
  const completed = eventItem({ ...assistantEvent, blocks: [{ type: "thinking", text: updates.at(-1)!.text }] });
  await update([before, completed]);
  expect(document.querySelector(".pwa-thinking-process-row .pwa-process-status-running")).toBeNull();
  expect(rowHeading()?.textContent).toBe("Second stage");
  await update([]);
  expect(document.querySelector(".pwa-process-group")).toBeNull();
});

test.each([1280, 390])("streaming thinking uses a first-line summary and a running empty label at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "\n \t\n" };
  const { screen, update } = await liveList([partialItem(thinking)], { running: true });
  const title = page.elementLocator(rowHeading()!);
  await expect.element(title).toBeVisible();
  await expect.element(title).toHaveTextContent("Thinking…");
  // 只有空白时没有可读正文，明细行不提供阅读入口。
  expect(document.querySelector(".pwa-thinking-process-row-action")).toBeNull();
  const text = "\n  检查   工具\t分组  \n后续原文不应显示在标题中。";
  await update([partialItem({ ...thinking, delta: text })]);
  await expect.element(screen.getByText("检查 工具 分组")).toBeVisible();
  expect(rowHeading()?.getAttribute("title")).toBe("检查 工具 分组");
  expect(listText()).not.toContain("后续原文不应显示在标题中。");
  expect(document.querySelector(".pwa-thinking-process-row-action")?.getAttribute("aria-label")).toBe("Read thinking");
});

test.each([1280, 390])("a long live thinking heading stays on one line beside a fixed slot and chevron across completion at %ipx", async width => {
  await page.viewport(width, 844);
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "**First step**\nA.\n\n**Second step**\nB." };
  const longTitle = "检查工具分组与完整思考标题 ".repeat(80);
  const longThinking = { ...thinking, delta: `${thinking.delta}\n**${longTitle.trim()}**\nAdditional reasoning.` };
  // 同轮的工具与思考被正文隔开，形成两个过程组；思考仍是当前运行输出。
  const reply = eventItem({ ...assistantEvent, event_id: "between", blocks: [{ type: "text", text: "Between" }] });
  const items = (last: TimelineViewItem) => [eventItem(toolEvent), reply, last];
  const { update } = await liveList(items(partialItem(longThinking)), { running: true });
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      await update(items(partialItem(longThinking)));
      // 手动收起当前组，组头显示当前思考标题。
      const toggle = groupButton(1);
      if (toggle.getAttribute("aria-expanded") === "true") await userEvent.click(toggle);
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
      const title = toggle.querySelector<HTMLElement>(".pwa-process-thinking-heading")!;
      expect(title.textContent).toBe(longTitle.trim());
      expect(title.title).toBe(longTitle.trim());
      expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(title).overflow).toBe("hidden");
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
      const chevron = toggle.querySelector(".pwa-timeline-chevron")!;
      expect(Math.round(title.getBoundingClientRect().right)).toBeLessThan(Math.round(chevron.getBoundingClientRect().left));
      const list = document.querySelector(".pwa-message-list")!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      expect(Math.round(toggle.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
      const slot = toggle.querySelector<HTMLElement>(".pwa-process-status-slot")!;
      expect(Math.round(slot.getBoundingClientRect().width)).toBe(16);
      const slotLeft = Math.round(slot.getBoundingClientRect().left);
      const chevronRight = () => Math.round(chevron.getBoundingClientRect().right);
      const otherRight = Math.round(groupButton(0).querySelector(".pwa-timeline-chevron")!.getBoundingClientRect().right);
      expect(chevronRight()).toBe(otherRight);
      // 正式化后组头换成摘要，但状态槽与箭头原位，不播放位移。
      await update(items(eventItem({ ...assistantEvent, blocks: [{ type: "thinking", text: longThinking.delta! }] })));
      expect(groupButton(1)).toBe(toggle);
      expect(toggle.querySelector(".pwa-process-status-slot")).toBe(slot);
      expect(Math.round(slot.getBoundingClientRect().left)).toBe(slotLeft);
      expect(Math.round(slot.getBoundingClientRect().width)).toBe(16);
      expect(toggle.querySelector(".pwa-spin, [role='status']")).toBeNull();
      expect(chevronRight()).toBe(otherRight);
    }
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test("manually expanded process groups and the reader merge their reading locks until the final reader exit", async () => {
  const reading: boolean[] = [];
  const second = eventItem({ ...toolEvent, event_id: "second", tool_call_id: "second" });
  const { screen, update } = await liveList([eventItem(assistantEvent), eventItem(toolEvent), second, runEndItem()], { onReadingChange: value => reading.push(value) });
  // 思考与工具被正文分开，形成两个已结束、默认收起的过程组。
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(2);
  await userEvent.click(groupButton(0));
  await userEvent.click(groupButton(1));
  expect(reading.at(-1)).toBe(true);
  await userEvent.click(toolButton());
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await closeReader();
  expect(reading.at(-1)).toBe(true);
  // 工具组收起后仍有手动展开的思考组，读锁不能提早释放。
  await userEvent.click(groupButton(1));
  expect(reading.at(-1)).toBe(true);
  await userEvent.click(groupButton(0));
  expect(reading.at(-1)).toBe(false);
  await userEvent.click(groupButton(1));
  await userEvent.click(toolButton());
  // 移除整个工具组，只留思考；Reader 退出完成后才清掉最后一个读锁并回焦列表。
  await update([eventItem(assistantEvent)]);
  await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
  await expect.poll(() => reading.at(-1)).toBe(false);
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
  await update([]);
  expect(reading.at(-1)).toBe(false);
});

test.each([1280, 390])("manual process choices survive live updates, the formal answer and run_end at %ipx", async width => {
  await page.viewport(width, 844);
  const reading: boolean[] = [];
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "**First step**\nInspecting the request." };
  const { screen, update } = await liveList([partialItem(thinking)], { running: true, onReadingChange: value => reading.push(value) });
  await expect.element(screen.getByText("First step")).toBeVisible();
  const toggle = groupButton();
  // 运行中默认展开，不写手动选择，也不申请阅读锁。
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(reading.at(-1) ?? false).toBe(false);
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const text = `${thinking.delta}\n\n**Second step**\nAdditional live reasoning.`;
  // 手动收起后新增内容不能强制展开；收起的组头显示当前思考标题。
  await update([partialItem({ ...thinking, delta: text })]);
  expect(groupButton()).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => toggle.querySelector(".pwa-process-thinking-heading")?.textContent).toBe("Second step");
  expect(reading.at(-1) ?? false).toBe(false);
  const completed: TimelineEvent = { ...assistantEvent, blocks: [{ type: "thinking", text }, { type: "text", text: "The final answer." }] };
  await update([eventItem(completed)]);
  expect(groupButton()).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
  // 再次手动展开即阅读意图：正式 run_end 不能把它收起。
  await userEvent.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(reading.at(-1)).toBe(true);
  await update([eventItem(completed), runEndItem()]);
  expect(groupButton()).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(rowHeading()?.textContent).toBe("Second step");
  expect(document.querySelector(".pwa-thinking-process-row .pwa-process-status-running")).toBeNull();
  expect(reading.at(-1)).toBe(true);
  await userEvent.keyboard(" ");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(reading.at(-1)).toBe(false);
});

test("streaming text keeps its timeline identity and reserved rows when it becomes formal", async () => {
  const partial: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:assistant:1", kind: "assistant", status: "delta", blocks: [{ type: "text", text: "Still writing" }] };
  const { screen, update } = await liveList([partialItem(partial)]);
  const row = document.querySelector<HTMLElement>("article.pwa-message[data-timeline-key]")!;
  const rowHeight = Math.round(row.getBoundingClientRect().height);
  expect(row.dataset.timelineKey).toContain("answer");
  expect(row.querySelector("time")).toBeNull();
  expect(row.querySelector(".pwa-message-label")).toBeNull();
  await update([eventItem(assistantEvent)]);
  expect(document.querySelector("article.pwa-message[data-timeline-key]")).toBe(row);
  expect(Math.round(row.getBoundingClientRect().height)).toBe(rowHeight);
  await expect.element(screen.getByText("The final answer.")).toBeVisible();
});

test("all tool states show only titles and status, never input, output, images or errors inline", async () => {
  const failed: TimelineEvent = { ...toolEvent, event_id: "failed", tool_call_id: "failed", status: "error", error: "Permission denied" };
  const interrupted: TimelineEvent = { event_id: "interrupted", tool_call_id: "interrupted", session_id: toolEvent.session_id, leaf_id: toolEvent.leaf_id, group_id: toolEvent.group_id, timestamp: 2, kind: "tool", tool: "bash", args: { command: "sleep 10" }, truncated: false, status: "interrupted" };
  const custom: TimelineEvent = { ...toolEvent, event_id: "custom", tool_call_id: "custom", tool: "custom", result: { secretPreview: "not visible" } };
  const image: TimelineEvent = { ...toolEvent, tool_call_id: "image", event_id: "image", tool: "write", args: { path: "file.txt", content: "INPUT_MARKER" }, result: [{ type: "image", mimeType: "image/png", data: "IMAGE_MARKER" }] };
  const { screen } = await liveList([partialItem(toolPartial), eventItem({ ...toolEvent, tool_call_id: "complete", result: "Finished" }), eventItem(failed), eventItem(interrupted), eventItem(custom), eventItem(image)]);
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(1);
  await expandToolGroups();
  expect(document.querySelectorAll(".pwa-tool-card")).toHaveLength(6);
  for (const action of document.querySelectorAll(".pwa-tool-card .pwa-tool-action")) {
    expect(action.hasAttribute("aria-expanded")).toBe(false);
    expect(action.hasAttribute("aria-controls")).toBe(false);
    expect(action.getAttribute("aria-haspopup")).toBe("dialog");
    expect(action.querySelector(".pwa-timeline-chevron")).toBeNull();
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
  expect(reading.at(-1)).toBe(true);
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
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(2);
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
  await expect.poll(() => document.querySelectorAll(".pwa-process-group .pwa-tool-card").length).toBe(7);
  expect(document.querySelectorAll(".pwa-process-group .pwa-tool-action[aria-haspopup='dialog']")).toHaveLength(7);
  expect(document.querySelector(".pwa-process-group .pwa-tool-preview")).toBeNull();
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
  expect(document.querySelector(".pwa-process-group .pwa-spin")).toBeNull();
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
  // 过程 Reader 先收起挂载、下一帧再打开；等真实正文出现，不依赖 rAF 与点击返回的先后。
  await expect.poll(() => document.querySelector(".pwa-tool-reader-scroll")?.textContent).toContain('"files": 3');
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

test.each([1280, 390])("reply and process groups align without inline details in both themes at %ipx", async width => {
  await page.viewport(width, 844);
  const originalTheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const { screen } = await liveList([
    eventItem({ ...assistantEvent, blocks: [{ type: "text", text: "我会检查 `timeline`，每次工具调用独立显示。\n\n> 真正的引用保留竖线。" }, { type: "thinking", text: "先核对路径，再检查输出。" }] }),
    eventItem({ ...toolEvent, args: { path: `src/${"directory/".repeat(30)}file.ts`, offset: 200, limit: 60 } }),
    partialItem({ ...toolPartial, tool: "bash", tool_call_id: "running", partial_id: "tool:running", args: { command: `pnpm build\n${"long-argument ".repeat(50)}` } }),
    eventItem({ ...toolEvent, tool: "edit", tool_call_id: "failed", event_id: "failed", args: { path: "src/component.tsx" }, status: "error", error: "Hidden error details" }),
  ]);
  // 正文之后同轮相邻的思考与工具合为一个过程组。
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(1);
  await expandToolGroups();
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      const reply = document.querySelector<HTMLElement>(".pwa-message.assistant .pwa-markdown")!;
      const replyLeft = Math.round(reply.getBoundingClientRect().left);
      expect(getComputedStyle(reply).fontSize).toBe("16px");
      const quote = reply.querySelector("blockquote")!;
      expect(getComputedStyle(quote).borderLeftWidth).toBe("2px");
      expect(getComputedStyle(quote).paddingLeft).toBe("12px");
      // 组头与 Pi 回复左缘对齐，不使用引用式缩进；明细只给标题入口。
      const group = groupButton();
      expect(Math.round(group.getBoundingClientRect().height)).toBe(44);
      expect(Math.round(group.getBoundingClientRect().left)).toBe(replyLeft);
      expect(Math.round(group.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
      expect(group.querySelector(".pwa-timeline-chevron")).not.toBeNull();
      const entries = [...document.querySelectorAll<HTMLElement>(".pwa-thinking-process-row-action, .pwa-tool-card .pwa-tool-action")];
      expect(entries).toHaveLength(4);
      for (const action of entries) {
        const rect = action.getBoundingClientRect();
        expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
        expect(Math.round(rect.left)).toBe(replyLeft);
        expect(Math.round(rect.right)).toBeLessThanOrEqual(width);
        expect(action.hasAttribute("aria-expanded")).toBe(false);
        expect(action.getAttribute("aria-haspopup")).toBe("dialog");
        expect(action.querySelector(".pwa-timeline-chevron")).toBeNull();
      }
      expect(getComputedStyle(rowHeading()!).fontStyle).toBe("italic");
      for (const card of document.querySelectorAll(".pwa-tool-card")) {
        expect(getComputedStyle(card).borderTopWidth).toBe("0px");
        expect(getComputedStyle(card).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      }
      const list = document.querySelector(".pwa-message-list")!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      expect(listText()).not.toContain("先核对路径，再检查输出。".repeat(2));
      await expect.element(screen.getByText("Hidden error details")).not.toBeInTheDocument();
    }
    await expect.poll(() => getComputedStyle(groupButton().querySelector(".pwa-timeline-chevron")!).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
  } finally {
    if (originalTheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalTheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test.each([1280, 390])("completed process groups summarize calls with a right chevron and clickable title-only children in both themes at %ipx", async width => {
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
  // 正式结束后左侧状态槽与真实结果相符；组头不复用子行的状态文字。
  expect(group.querySelector(".pwa-process-status-slot.pwa-process-status-complete")).not.toBeNull();
  expect(group.querySelector(".pwa-tool-status")).toBeNull();
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(getComputedStyle(group.querySelector(".pwa-process-summary")!).fontSize).toBe("16px");
  group.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelectorAll(".pwa-process-group .pwa-tool-card").length).toBe(calls.length);
  // 工具组与思考都靠排版区分层级，不使用引用竖线或额外缩进。
  const detailsInner = document.querySelector<HTMLElement>(".pwa-process-details > .pwa-collapse-inner")!;
  expect(getComputedStyle(detailsInner).borderLeftWidth).toBe("0px");
  expect(getComputedStyle(detailsInner).paddingLeft).toBe("0px");
  await expect.poll(() => Math.round(detailsInner.getBoundingClientRect().left)).toBe(Math.round(group.getBoundingClientRect().left));
  try {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", theme);
      // 旋转中 SVG 的包围盒会暂时变宽；等待最终姿态后再检查布局，不放宽几何容差。
      await expect.poll(() => getComputedStyle(group.querySelector(".pwa-timeline-chevron")!).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
      const arrow = group.querySelector(".pwa-timeline-chevron")!.getBoundingClientRect();
      const summaryLabel = group.querySelector(".pwa-process-summary")!;
      const summary = summaryLabel.getBoundingClientRect();
      expect(getComputedStyle(summaryLabel).fontSize).toBe("16px");
      expect(Math.round(arrow.left)).toBeGreaterThanOrEqual(Math.round(summary.right));
      expect(Math.round(arrow.right)).toBeLessThanOrEqual(Math.round(group.getBoundingClientRect().right));
      expect(group.querySelector("[role='status']")).toBeNull();
      expect(document.querySelectorAll(".pwa-process-group .pwa-tool-status-complete")).toHaveLength(calls.length);
      const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
      expect(list.querySelector(".pwa-tool-content, .pwa-tool-preview, .pwa-tool-details")).toBeNull();
      expect(list.textContent).not.toContain("Requested changes");
      expect(list.textContent).not.toContain("Tests passed: 12");
      for (const action of document.querySelectorAll<HTMLElement>(".pwa-tool-card .pwa-tool-action")) {
        expect(Math.round(action.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        expect(Math.round(action.getBoundingClientRect().left)).toBe(Math.round(group.getBoundingClientRect().left));
        // 子项与组头同用正文字号，层级靠状态槽与短竖线区分。
        expect(getComputedStyle(action.querySelector("strong")!).fontSize).toBe("16px");
        expect(action.hasAttribute("aria-expanded")).toBe(false);
      }
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      await userEvent.click(toolButton(4));
      // 阅读器首块原样列出参数，正文只放真实结果，不再拼出请求修改。
      await expect.element(screen.getByText("Successfully replaced text")).toBeVisible();
      expect(document.querySelector(".pwa-tool-reader-command")?.textContent).toBe("path: src/settings.ts\noldText: enabled = false\nnewText: enabled = true");
      // 参数名承担识别、值保持常规字重；整块不再与抽屉标题等重。
      const argumentNames = [...document.querySelectorAll<HTMLElement>(".pwa-tool-reader-arg-name")];
      expect(argumentNames.map(node => node.textContent)).toEqual(["path:", "oldText:", "newText:"]);
      expect(argumentNames.every(node => getComputedStyle(node).fontWeight === "600")).toBe(true);
      expect(getComputedStyle(document.querySelector<HTMLElement>(".pwa-tool-reader-command")!).fontWeight).toBe("400");
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

test("tools join a live group from the first call and an open reader keeps its group and origin while the turn finishes", async () => {
  const first = { ...toolEvent, args: { path: "a.ts" }, result: "First output" };
  const second = { ...toolEvent, event_id: "second", tool_call_id: "second", args: { path: "b.ts" }, result: "Second output" };
  const running = { ...toolPartial, partial_id: "tool:third", tool_call_id: "third", args: { path: "c.ts" } };
  const reading: boolean[] = [];
  const { screen, update } = await liveList([eventItem(first)], { running: true, onReadingChange: value => reading.push(value) });
  const group = document.querySelector(".pwa-process-group")!;
  // 运行中的组从第一条起即默认展开，不申请阅读锁。
  expect(groupButton().getAttribute("aria-expanded")).toBe("true");
  expect(reading.at(-1) ?? false).toBe(false);
  await update([eventItem(first), eventItem(second), partialItem(running)]);
  expect(document.querySelector(".pwa-process-group")).toBe(group);
  expect(document.querySelectorAll(".pwa-process-group .pwa-tool-card")).toHaveLength(3);
  expect(groupButton().getAttribute("aria-label")).toBe("Collapse Read 3 files");
  const origin = toolButton();
  await userEvent.click(origin);
  await expect.element(screen.getByText("First output")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  // 阅读器打开期间收到 run_end：组暂缓自动收起，原入口保持有效。
  await update([eventItem(first), eventItem(second), eventItem({ ...toolEvent, event_id: "third", tool_call_id: "third", args: { path: "c.ts" }, result: "Third output" }), runEndItem()]);
  expect(document.querySelector(".pwa-process-group")).toBe(group);
  expect(groupButton().getAttribute("aria-expanded")).toBe("true");
  expect(origin.isConnected).toBe(true);
  await expect.element(screen.getByText("First output")).toBeVisible();
  expect(reading.at(-1)).toBe(true);
  await closeReader("history");
  // 焦点回到明细入口后，明细焦点继续保护该组不被收起；默认展开不再持有阅读锁。
  await expect.poll(() => document.activeElement).toBe(origin);
  expect(groupButton().getAttribute("aria-expanded")).toBe("true");
  await expect.poll(() => reading.at(-1)).toBe(false);
  // 焦点离开明细后按正式结束收起。
  groupButton().focus();
  await expect.poll(() => groupButton().getAttribute("aria-expanded")).toBe("false");
  // 已结束的组手动展开照旧暂停自动跟随。
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(true);
});

test.each([390, 1280].flatMap(width => ["light", "dark"].map(scheme => ({ width, scheme }))))("process group text stays neutral while the left status slot carries the real state at $width in $scheme", async ({ width, scheme }) => {
  await page.viewport(width, 844);
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const command = `pnpm test --filter ${"long-parameter-".repeat(80)}`;
  const running = { ...toolPartial, tool: "bash", args: { command } };
  const finished = { ...toolEvent, tool: "bash", args: { command }, result: "ok" };
  const earlierFailure: Extract<TimelineEvent, { kind: "tool" }> = { ...toolEvent, event_id: "earlier-failure", tool_call_id: "earlier-failure", tool: "bash", args: { command: "pnpm lint" }, status: "error", error: "failed" };
  const reply = eventItem({ ...assistantEvent, blocks: [{ type: "text", text: "The final answer." }] });
  const { update } = await liveList([reply], { running: true });
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    await update([reply, eventItem(earlierFailure), partialItem(running)]);
    const group = groupButton();
    // 手动收起后组头显示当前调用。
    await userEvent.click(group);
    await expect.poll(() => group.getAttribute("aria-expanded")).toBe("false");
    const tokenColor = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.querySelector(".pwa-root")!.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const slot = () => group.querySelector<HTMLElement>(".pwa-process-status-slot")!;
    const assertLayout = () => {
      const copy = group.querySelector<HTMLElement>(".pwa-process-copy")!;
      const chevron = group.querySelector(".pwa-timeline-chevron")!;
      expect(Math.round(slot().getBoundingClientRect().width)).toBe(16);
      expect(Math.round(slot().getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(copy.getBoundingClientRect().left));
      expect(Math.round(copy.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(chevron.getBoundingClientRect().left));
      expect(Math.round(chevron.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(group.getBoundingClientRect().right));
      const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    };
    assertLayout();
    const detail = group.querySelector<HTMLElement>(".pwa-process-tool-detail")!;
    expect(detail.textContent).toBe(toolInlineText(toolHeaderSummary(running)));
    expect(getComputedStyle(detail).textOverflow).toBe("ellipsis");
    expect(detail.scrollWidth).toBeGreaterThan(detail.clientWidth);
    // 运行中的调用文字保持中性色，运行状态只由左侧图标表达；较早失败保留独立提示。
    const runningColor = tokenColor("--pwa-running");
    expect(getComputedStyle(group.querySelector(".pwa-process-copy strong")!).color).not.toBe(runningColor);
    expect(getComputedStyle(detail).color).not.toBe(runningColor);
    expect(getComputedStyle(slot()).color).toBe(runningColor);
    expect(group.querySelector(".pwa-process-alert-error")).not.toBeNull();
    await userEvent.click(group);
    await expect.poll(() => group.getAttribute("aria-expanded")).toBe("true");
    for (const [status, token] of [["complete", "--pwa-complete"], ["error", "--pwa-error"], ["interrupted", "--pwa-secondary"]] as const) {
      const ended: Extract<TimelineEvent, { kind: "tool" }> = status === "error" ? { ...finished, status, error: "failed" }
        : status === "interrupted" ? { ...finished, status, result: undefined } : finished;
      await update([reply, eventItem(earlierFailure), eventItem(ended), runEndItem()]);
      assertLayout();
      expect(group.querySelector(".pwa-process-status-running")).toBeNull();
      for (const node of group.querySelectorAll<HTMLElement>(".pwa-process-copy *")) expect(getComputedStyle(node).color).not.toBe(runningColor);
      // 组状态不反写成员：较早失败始终让组头显示错误，成员各自保留真实状态色。
      expect(getComputedStyle(slot()).color).toBe(tokenColor("--pwa-error"));
      expect(group.querySelector(".pwa-process-alert-error")).not.toBeNull();
      const member = document.querySelectorAll<HTMLElement>(".pwa-process-group .pwa-tool-card .pwa-tool-status")[1]!;
      expect(member.classList.contains(`pwa-tool-status-${status}`)).toBe(true);
      expect(getComputedStyle(member).color).toBe(tokenColor(token));
    }
  } finally {
    if (originalScheme) document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    else document.documentElement.removeAttribute("data-mantine-color-scheme");
  }
});

test("earlier history keeps an expanded group expanded with the same identity", async () => {
  const read = (id: string): TimelineViewItem => eventItem({ ...toolEvent, event_id: id, tool_call_id: id, args: { path: `${id}.ts` }, result: id });
  const { update } = await liveList([read("b"), read("c")]);
  const group = document.querySelector(".pwa-process-group")!;
  await userEvent.click(groupButton());
  await update([read("a"), read("b"), read("c")]);
  expect(document.querySelector(".pwa-process-group")).toBe(group);
  expect(groupButton().getAttribute("aria-label")).toBe("Collapse Read 3 files");
  expect(groupButton().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelectorAll(".pwa-process-group .pwa-tool-card")).toHaveLength(3);
});

test("reduced motion keeps the running indicator and uses a short reader fade", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    const { screen } = await liveList([partialItem(toolPartial)], { running: true });
    expect(getComputedStyle(groupButton().querySelector(".pwa-process-status-running > svg")!).animationName).not.toBe("none");
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
  const screen = await renderMessageList([eventItem(toolEvent), eventItem(assistantEvent), unknownPending, { ...unknownPending, id: "pending-2", delivery: "failed", deliveryFailure: { code: "transport_unavailable", retryable: true } }, { ...unknownPending, id: "pending-3", delivery: "accepted", cancelable: true }]);
  // 同轮相邻的工具与思考合为一个过程组，组头是唯一的折叠控件。
  expect(document.querySelectorAll("button.pwa-process-head")).toHaveLength(1);
  for (const element of [groupButton(), ...["Check status", "Retry send", "Cancel queued message"].map(name => screen.getByRole("button", { name }).element())]) {
    const rect = element.getBoundingClientRect();
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
  expect(list.querySelectorAll(":scope > .pwa-process-group")).toHaveLength(2);
  expect(list.querySelectorAll(":scope > .pwa-tool-card")).toHaveLength(0);
  expect(groupButton().textContent).toBe("Read 3 files · Ran 1 command · 1 failed");
  expect(groupButton().querySelector(".pwa-process-alert-error")).not.toBeNull();
  expect(groupButton().getAttribute("aria-label")).toBe("Expand Read 3 files · Ran 1 command · 1 failed");
  await userEvent.click(groupButton());
  expect(groupButton().getAttribute("aria-label")).toBe("Collapse Read 3 files · Ran 1 command · 1 failed");
  expect(document.querySelectorAll(".pwa-process-group .pwa-tool-card")).toHaveLength(5);
  expect(document.querySelector(".pwa-process-group .pwa-tool-status-error")?.textContent).toBe("Error");
  expect(reading.at(-1)).toBe(true);
  await userEvent.click(groupButton());
  expect(reading.at(-1)).toBe(false);
});

test("a group without failures shows no failure marker", async () => {
  const read = (id: string, path: string): Extract<TimelineEvent, { kind: "tool" }> => ({ ...toolEvent, event_id: id, tool_call_id: id, args: { path }, result: "ok" });
  await liveList([read("a", "a.ts"), read("b", "b.ts")].map(eventItem).concat(runEndItem()));
  expect(groupButton().textContent).toBe("Read 2 files");
  expect(groupButton().querySelector(".pwa-process-alert")).toBeNull();
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
    // 骨架与内容在同一帧交接，淡入从约 1/3 可见度起始，不留全空帧。
    expect(animate.mock.calls[fadeIndex]![0]).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
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

/** 本地压缩提示必须停在发生时的记录之后，不随新消息漂到列表末尾。 */
test("compaction notices stay anchored behind the record they followed", async () => {
  const first = { ...assistantEvent, event_id: "notice-first", event_seq: 1, blocks: [{ type: "text" as const, text: "Before notice" }] };
  const later = { ...assistantEvent, event_id: "notice-later", event_seq: 2, blocks: [{ type: "text" as const, text: "After notice" }] };
  const notice = { id: "notice-1", sessionId: "session-1", afterSeq: 1, kind: "failed" as const };
  const { update } = await liveList([eventItem(first)], { notices: [notice] });
  const noticeRow = () => document.querySelector<HTMLElement>(".pwa-compaction-notice")!;
  const messageWith = (text: string) => [...document.querySelectorAll<HTMLElement>(".pwa-message")].find(row => row.textContent?.includes(text))!;
  expect(noticeRow().textContent).toBe("Could not compact context.");
  expect(noticeRow().classList.contains("is-error")).toBe(true);
  expect(messageWith("Before notice").compareDocumentPosition(noticeRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await update([eventItem(first), eventItem(later)]);
  expect(noticeRow()).not.toBeNull();
  expect(messageWith("Before notice").compareDocumentPosition(noticeRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(noticeRow().compareDocumentPosition(messageWith("After notice")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("running compaction row follows the last record", async () => {
  const screen = await renderMessageList([eventItem({ ...assistantEvent, event_id: "compaction-body", event_seq: 1, blocks: [{ type: "text" as const, text: "Ready" }] })], { compacting: true });
  try {
    const row = document.querySelector<HTMLElement>(".pwa-compaction-status")!;
    const message = [...document.querySelectorAll<HTMLElement>(".pwa-message")].find(item => item.textContent?.includes("Ready"))!;
    expect(row.textContent).toContain("Compacting context…");
    expect(message.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally { await screen.unmount(); }
});

test("holds the scrollbar while earlier records load and releases it afterwards", async () => {
  const loading = await renderMessageList([eventItem(assistantEvent)], { hasEarlier: true, loadingEarlier: true, onLoadEarlier: () => {} });
  try {
    // 加载更早记录会改变内容高度，滚动条长度瞬变；期间抑制显示，避免看到滑块突然变短。
    expect(document.querySelector(".pwa-message-list")!.hasAttribute("data-scroll-hold")).toBe(true);
  } finally { await loading.unmount(); }

  const idle = await renderMessageList([eventItem(assistantEvent)], { hasEarlier: true, loadingEarlier: false, onLoadEarlier: () => {} });
  try {
    expect(document.querySelector(".pwa-message-list")!.hasAttribute("data-scroll-hold")).toBe(false);
  } finally { await idle.unmount(); }
});

test("shows the delayed earlier-records loader with the small status spinner beside 13px text", async () => {
  const screen = await renderMessageList([eventItem(assistantEvent)], { hasEarlier: true, loadingEarlier: true, onLoadEarlier: () => {} });
  try {
    // 300ms 内完成不显示，之后与 13px 状态文字同行的旋转图标为 12、线宽 2.4（DESIGN「基础层」图标）。
    await expect.poll(() => document.querySelector(".pwa-earlier-loading svg"), { timeout: 3000 }).not.toBeNull();
    const icon = document.querySelector(".pwa-earlier-loading svg")!;
    expect(icon.getAttribute("width")).toBe("12");
    expect(icon.getAttribute("stroke-width")).toBe("2.4");
    expect(getComputedStyle(document.querySelector(".pwa-earlier")!).fontSize).toBe("13px");
  } finally { await screen.unmount(); }
});

test("streaming reply fades in only newly shown text and keeps each fade's start through re-renders", async () => {
  const streaming: TimelinePartial = { protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: "group-1", partial_id: "answer:assistant:0", kind: "assistant", status: "delta", delta: "First paragraph." };
  const { screen, update } = await liveList([partialItem(streaming)]);
  try {
    const row = () => document.querySelector<HTMLElement>(".pwa-message.assistant")!;
    await expect.element(page.elementLocator(row())).toBeVisible();
    // 首次挂载的已有正文不重播淡入。
    expect(row().querySelector(".pwa-stream-reveal")).toBeNull();
    await update([partialItem({ ...streaming, delta: "First paragraph. More" })]);
    const first = row().querySelector<HTMLElement>(".pwa-stream-reveal")!;
    expect(first.textContent).toBe(" More");
    const start = first.getAnimations()[0]?.startTime;
    expect(start).not.toBeNull();
    await update([partialItem({ ...streaming, delta: "First paragraph. More text\n\nSecond" })]);
    const spans = [...row().querySelectorAll<HTMLElement>(".pwa-stream-reveal")];
    expect(spans.map(span => span.textContent)).toEqual([" More", " text", "Second"]);
    expect(spans[0].getAnimations()[0]?.startTime).toBe(start);
    expect([...row().querySelectorAll(".pwa-markdown > p")].map(node => node.textContent)).toEqual(["First paragraph. More text", "Second"]);
    const formal: TimelineEvent = { ...assistantEvent, blocks: [{ type: "text", text: "First paragraph. More text\n\nSecond" }] };
    await update([eventItem(formal)]);
    await expect.poll(() => document.querySelector(".pwa-message.assistant.partial")).toBeNull();
    expect([...row().querySelectorAll(".pwa-markdown > p")].map(node => node.textContent)).toEqual(["First paragraph. More text", "Second"]);
  } finally { await screen.unmount(); }
});
