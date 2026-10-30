import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";
import { PwaConnectionBanner } from "./pwa-app-actions";

const scope = { session_id: "viewport-session", leaf_id: "generation" };
const paragraphs = (prefix: string, count = 18) => Array.from({ length: count }, (_, index) => `${prefix} paragraph ${index}: content that stays available while reading.`).join("\n\n");
function answer(id: string, text: string): TimelineViewItem {
  return { kind: "event", event: { ...scope, event_id: id, group_id: id, timestamp: 1, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] } };
}
function partial(id: string, text: string, kind: "assistant" | "thinking" = "assistant"): TimelineViewItem {
  return { kind: "partial", createdAt: 1, partial: { ...scope, protocol_version: 2, type: "timeline_partial", partial_id: `${id}:${kind}:0`, group_id: id, kind, status: "delta", delta: text } };
}
async function settleLayout() {
  // 先等展开／收起等有限时长的过渡结束，再等合并的跟随帧、ResizeObserver 和其产生的 scroll 事件。
  await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished));
  for (let frame = 0; frame < 4; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}
async function renderTimeline(initialItems: TimelineViewItem[]) {
  let updateItems!: (items: TimelineViewItem[]) => void;
  let viewport!: TimelineViewport;
  function Harness() {
    const [items, setItems] = useState(initialItems);
    updateItems = setItems;
    viewport = useTimelineViewport(items);
    return <main className="pwa-main" style={{ width: "100vw", height: 600 }}>
      {/* 流式输出期间 Pi 处于运行状态：轮末时间要等 run_end 才出现。 */}
      <MessageList items={items} hasEarlier={false} running listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} />
      <button type="button" onClick={viewport.showLatest}>Latest output</button>
    </main>;
  }
  const screen = await renderPwa(<Harness />);
  await settleLayout();
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  return {
    screen, list, viewport: () => viewport,
    update: (items: TimelineViewItem[]) => flushSync(() => { updateItems(items); viewport.receiveRealtimeOutput("live-output"); }),
    /** 切换会话：内容整体替换，不产生实时输出。 */
    replace: (items: TimelineViewItem[]) => flushSync(() => updateItems(items)),
    readAt: async (element: Element) => {
      // 模拟用户回看须包含输入意图；单独写 scrollTop 也可能来自正在结束的程序滚动。
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - 2;
      flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true })));
      await settleLayout();
      expect(viewport.followingOutput).toBe(false);
    },
  };
}
const bottomGap = (list: HTMLElement) => list.scrollHeight - list.clientHeight - list.scrollTop;
const offset = (element: Element, list: Element) => element.getBoundingClientRect().top - list.getBoundingClientRect().top;

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

test.each([1280, 390])("Markdown growth, shrink and completion keep the follower at the bottom at %ipx", async width => {
  await page.viewport(width, 844);
  const history = answer("history", paragraphs("Earlier"));
  const drafts = [
    "| Column | Value |",
    "| Column | Value |\n| --- | --- |\n| a | b |\n| c | d |",
    "```ts\nconst value = 1;\nconst next = value + 1;\n```\n\n- one\n- two",
    "A short final response.",
  ];
  const { screen, list, update, viewport } = await renderTimeline([history, partial("live", drafts[0])]);
  try {
    for (const text of drafts.slice(1)) {
      update([history, partial("live", text)]);
      await settleLayout();
      // 流式正文增长由原生平滑滚动接续，落点时长由浏览器决定。
      await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
      expect(viewport().followingOutput).toBe(true);
    }
    // 逐帧跟随静止后再取基准：连续两帧滚动位置不变。
    let previous = Number.NaN;
    await expect.poll(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const stable = list.scrollTop === previous;
      previous = list.scrollTop;
      return stable;
    }).toBe(true);
    const row = list.querySelector<HTMLElement>("article.partial")!;
    const before = { height: row.getBoundingClientRect().height, scrollTop: list.scrollTop };
    update([history, answer("live", drafts.at(-1)!)]);
    await settleLayout();
    expect(list.querySelectorAll("article")[1]).toBe(row);
    expect(row.getBoundingClientRect().height).toBeCloseTo(before.height, 0);
    expect(list.scrollTop).toBeCloseTo(before.scrollTop, 0);
    expect(bottomGap(list)).toBeLessThanOrEqual(1);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("reading a later message survives Markdown height changes above it at %ipx", async width => {
  await page.viewport(width, 844);
  const reading = answer("reading", "This is the paragraph being read.");
  const tail = answer("tail", paragraphs("Below"));
  const { screen, list, update, readAt, viewport } = await renderTimeline([partial("above", paragraphs("Above", 5)), reading, tail]);
  try {
    const target = screen.getByText("This is the paragraph being read.").element();
    await readAt(target);
    const top = offset(target, list);
    for (const text of [paragraphs("Above", 12), "| Item | Result |\n| --- | --- |\n| first | ready |", "```\nline one\nline two\n```\n\nLast paragraph."]) {
      update([partial("above", text), reading, tail]);
      await settleLayout();
      expect(Math.abs(offset(target, list) - top)).toBeLessThanOrEqual(1);
      expect(viewport().followingOutput).toBe(false);
    }
    expect(viewport().unreadOutput).toBe(1);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("history prepend preserves reading when only a tall user bubble is visible at %ipx", async width => {
  await page.viewport(width, 844);
  const user: TimelineViewItem = { kind: "event", event: {
    ...scope, event_id: "user-long", message_id: "user-long", group_id: "user-run", timestamp: 1,
    kind: "user", status: "committed", origin: "extension", delivery: "normal",
    blocks: Array.from({ length: 30 }, (_, index) => ({ type: "text", text: `User paragraph ${index}. ${"Readable content. ".repeat(8)}` })),
  } };
  const { screen, list, readAt, replace, viewport } = await renderTimeline([user]);
  try {
    const target = screen.getByText(/^User paragraph 10\./).element();
    await readAt(target);
    const before = Math.round(offset(target, list));
    replace([answer("earlier", paragraphs("Prepended", 12)), user]);
    await settleLayout();
    expect(Math.abs(Math.round(offset(target, list)) - before)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("reading inside one long message preserves the visible paragraph at %ipx", async width => {
  await page.viewport(width, 844);
  const prefix = "Opening paragraph.";
  const targetText = "The visible paragraph inside the streaming answer.";
  const rest = `\n\n${targetText}\n\n${paragraphs("Continuation")}`;
  const { screen, list, update, readAt } = await renderTimeline([partial("long", `${prefix}${rest}`)]);
  try {
    const target = screen.getByText(targetText).element();
    await readAt(target);
    const top = offset(target, list);
    update([partial("long", `${"An opening line with more detail. ".repeat(30)}${rest}`)]);
    await settleLayout();
    expect(Math.abs(offset(screen.getByText(targetText).element(), list) - top)).toBeLessThanOrEqual(1);
    update([answer("long", `${prefix}${rest}`)]);
    await settleLayout();
    expect(Math.abs(offset(screen.getByText(targetText).element(), list) - top)).toBeLessThanOrEqual(1);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("Thinking pauses following without showing Latest until new output, then Latest resumes at %ipx", async width => {
  await page.viewport(width, 844);
  const history = answer("history", paragraphs("Earlier"));
  const { screen, list, update, viewport } = await renderTimeline([history, partial("thinking", "Initial thought", "thinking")]);
  try {
    const trigger = screen.getByRole("button", { name: "Expand Thinking" }).element();
    const top = offset(trigger, list);
    await screen.getByRole("button", { name: "Expand Thinking" }).click();
    await settleLayout();
    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);
    expect(offset(trigger, list)).toBeCloseTo(top, 0);
    update([history, partial("thinking", paragraphs("Thinking", 12), "thinking"), answer("later", "New output while thinking is open.")]);
    await settleLayout();
    expect(viewport().unreadOutput).toBeGreaterThan(0);
    expect(offset(trigger, list)).toBeCloseTo(top, 0);
    await screen.getByRole("button", { name: "Latest output" }).click();
    await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);
    expect(screen.getByRole("button", { name: "Collapse Thinking" }).element()).toBe(trigger);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("paused anchor compensation accepts native scroll and resumes on close at %ipx", async width => {
  await page.viewport(width, 844);
  const above = answer("above", paragraphs("Above", 4));
  const reading = answer("reading", paragraphs("Reading", 18));
  const { screen, list, replace, viewport } = await renderTimeline([above, reading]);
  try {
    expect(viewport().followingOutput).toBe(true);
    flushSync(() => viewport().setReadingDetails(true));
    const anchor = [...list.querySelectorAll("p")].find(node => node.getBoundingClientRect().bottom > list.getBoundingClientRect().top)!;
    const before = { top: Math.round(offset(anchor, list)), scroll: list.scrollTop };
    let nativeScrolls = 0;
    const onScroll = (event: Event) => { if (event.isTrusted) nativeScrolls += 1; };
    list.addEventListener("scroll", onScroll);
    try {
      replace([answer("above", paragraphs("Above", 12)), reading, answer("tail", paragraphs("Tail", 18))]);
      await expect.poll(() => nativeScrolls).toBeGreaterThan(0);
      await settleLayout();
      expect(list.scrollTop).toBeGreaterThan(before.scroll);
      expect(Math.round(offset(anchor, list))).toBe(before.top);
      expect(bottomGap(list)).toBeGreaterThan(100);
      expect(viewport().followingOutput).toBe(true);
      flushSync(() => viewport().setReadingDetails(false));
      await settleLayout();
      expect(bottomGap(list)).toBeLessThanOrEqual(1);
      expect(viewport().followingOutput).toBe(true);
    } finally { list.removeEventListener("scroll", onScroll); }
  } finally { await screen.unmount(); }
});

test("manual scrolling while Thinking is open updates the reading position", async () => {
  const thinking = partial("thinking", paragraphs("Thoughts", 5), "thinking");
  const tail = answer("tail", paragraphs("Below", 24));
  const { screen, list, readAt, update, viewport } = await renderTimeline([partial("above", paragraphs("Above", 6)), thinking, tail]);
  try {
    await readAt(screen.getByRole("button", { name: "Expand Thinking" }).element());
    await screen.getByRole("button", { name: "Expand Thinking" }).click();
    await settleLayout();
    const target = screen.getByText("Below paragraph 4: content that stays available while reading.").element();
    await readAt(target);
    const top = offset(target, list);
    update([partial("above", paragraphs("Above", 10)), thinking, tail]);
    await settleLayout();
    expect(Math.abs(offset(target, list) - top)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("asynchronous image layout above a reader compensates without a timeline update", async () => {
  const image: TimelineViewItem = { kind: "pending", id: "image", clientRequestId: "image", requestId: "image", text: "Attachment", createdAt: 0, delivery: "pending", images: [{ mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }] };
  const { screen, list, readAt, viewport } = await renderTimeline([image, answer("reading", "Reading below the attachment."), answer("tail", paragraphs("Below"))]);
  try {
    const target = screen.getByText("Reading below the attachment.").element();
    await readAt(target);
    const top = offset(target, list);
    // 模拟图片尺寸在解码后才确定；不触发 React items 更新。
    const attachment = list.querySelector<HTMLImageElement>("img")!;
    attachment.style.height = "260px";
    await settleLayout();
    expect(offset(target, list)).toBeCloseTo(top, 0);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("closing the direct reader by Escape or history preserves compensated position and focus at %ipx", async width => {
  await page.viewport(width, 844);
  const tool: TimelineViewItem = { kind: "event", event: { ...scope, event_id: "tool", group_id: "tool", tool_call_id: "read-call", timestamp: 1, kind: "tool", tool: "read", args: { path: "file.txt" }, status: "complete", truncated: false, result: paragraphs("File", 80) } };
  const tail = answer("tail", paragraphs("Below"));
  const { screen, list, readAt, update, viewport } = await renderTimeline([partial("above", paragraphs("Above", 5)), tool, tail]);
  try {
    // 已停止的过程组默认收起，先展开再从工具行打开阅读器。
    const head = list.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
    if (head.getAttribute("aria-expanded") === "false") await userEvent.click(head);
    await settleLayout();
    const heading = list.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!;
    await readAt(heading);
    heading.focus({ preventScroll: true });
    const top = offset(heading, list);
    await userEvent.click(heading);
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    update([partial("above", paragraphs("Above", 12)), tool, tail]);
    await settleLayout();
    expect(offset(heading, list)).toBeCloseTo(top, 0);
    await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
    if (width === 390) window.history.back();
    else await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
    await settleLayout();
    expect(document.activeElement).toBe(heading);
    expect(offset(heading, list)).toBeCloseTo(top, 0);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("layout breakpoint changes preserve the visible paragraph instead of raw scrollTop", async () => {
  const { screen, list, readAt, viewport } = await renderTimeline([answer("long", paragraphs("Responsive", 32))]);
  try {
    const target = screen.getByText("Responsive paragraph 8: content that stays available while reading.").element();
    await readAt(target);
    const top = offset(target, list);
    for (const width of [390, 1280]) {
      await page.viewport(width, 844);
      await settleLayout();
      expect(Math.abs(offset(target, list) - top)).toBeLessThanOrEqual(1);
      expect(viewport().followingOutput).toBe(false);
    }
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("a lone tall user row preserves its paragraph when history is prepended at %ipx", async width => {
  await page.viewport(width, 844);
  const user: TimelineViewItem = { kind: "event", event: {
    ...scope, event_id: "long-user", message_id: "long-user", group_id: "user", timestamp: 1,
    kind: "user", origin: "pwa", sender_ref: "self", status: "committed", delivery: "normal",
    blocks: Array.from({ length: 45 }, (_, index) => ({ type: "text", text: `User paragraph ${index}: keep this reading position.` })),
  } };
  const { screen, list, readAt, update, viewport } = await renderTimeline([user]);
  try {
    const target = screen.getByText("User paragraph 20: keep this reading position.").element();
    await readAt(target);
    const row = target.closest<HTMLElement>("[data-viewport-row]")!;
    expect(row.parentElement).toBe(list);
    expect(row.getBoundingClientRect().height).toBeGreaterThan(list.clientHeight);
    expect(row.getBoundingClientRect().top).toBeLessThan(list.getBoundingClientRect().top);
    expect(row.getBoundingClientRect().bottom).toBeGreaterThan(list.getBoundingClientRect().bottom);
    const before = Math.round(offset(target, list));
    const key = row.dataset.viewportRow;
    flushSync(() => viewport().prepareHistoryPrepend());
    update([answer("older-user-history", paragraphs("Earlier")), user]);
    await settleLayout();
    expect(Math.abs(Math.round(offset(target, list)) - before)).toBeLessThanOrEqual(1);
    expect(target.closest("[data-viewport-row]")).toBe(row);
    expect(row.dataset.viewportRow).toBe(key);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("prepending history while reading keeps the same real paragraph at the same offset", async () => {
  const reading = answer("reading", paragraphs("Reading", 12));
  const tail = answer("tail", paragraphs("Below"));
  const { screen, list, readAt, update, viewport } = await renderTimeline([reading, tail]);
  try {
    const target = screen.getByText("Reading paragraph 3: content that stays available while reading.").element();
    await readAt(target);
    const top = offset(target, list);
    flushSync(() => viewport().prepareHistoryPrepend());
    update([answer("older", paragraphs("Older")), reading, tail]);
    await settleLayout();
    expect(offset(target, list)).toBeCloseTo(top, 0);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("switching back to a viewed session restores its reading position while a new session opens at the bottom at %ipx", async width => {
  await page.viewport(width, 844);
  // 缺少 run_end 时没有轮末时间行；目标段落下方仍须有足够正文，确保是在回看而非底部跟随。
  const sessionMessageCount = 10;
  const sessionA = Array.from({ length: sessionMessageCount }, (_, index) => answer(`a-${index}`, paragraphs(`Session A ${index}`, 4)));
  const sessionB = Array.from({ length: sessionMessageCount }, (_, index) => answer(`b-${index}`, paragraphs(`Session B ${index}`, 4)));
  const { screen, list, readAt, replace, viewport } = await renderTimeline(sessionA);
  try {
    const targetText = "Session A 2 paragraph 1: content that stays available while reading.";
    await readAt(screen.getByText(targetText).element());
    expect(bottomGap(list)).toBeGreaterThan(list.clientHeight / 2);
    const top = offset(screen.getByText(targetText).element(), list);
    const saved = viewport().captureSessionPosition();
    expect(saved?.following).toBe(false);

    // 首次打开的会话停在底部最新内容。
    flushSync(() => { viewport().reset(); viewport().restoreSessionPosition(null); });
    replace([]);
    await settleLayout();
    replace(sessionB);
    await settleLayout();
    expect(bottomGap(list)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(true);

    // 切回看过的会话：先清空再分批加载，锚点行出现后回到离开时的位置。
    flushSync(() => { viewport().reset(); viewport().restoreSessionPosition(saved); });
    replace([]);
    await settleLayout();
    replace(sessionA.slice(4));
    await settleLayout();
    expect(bottomGap(list)).toBeLessThanOrEqual(1);
    replace(sessionA);
    await settleLayout();
    expect(Math.abs(offset(screen.getByText(targetText).element(), list) - top)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("switching back restores a reading position anchored on a collapsed tool group", async () => {
  await page.viewport(390, 844);
  const tool = (id: string): TimelineViewItem => ({ kind: "event", event: { ...scope, event_id: id, group_id: "tools", tool_call_id: id, timestamp: 1, kind: "tool", tool: "read", args: { path: `${id}.txt` }, status: "complete", truncated: false, result: "ok" } });
  const sessionA = [answer("a-0", paragraphs("Session A 0", 4)), tool("first"), tool("second"), ...Array.from({ length: 8 }, (_, index) => answer(`a-${index + 1}`, paragraphs(`Session A ${index + 1}`, 4)))];
  const { screen, list, readAt, replace, viewport } = await renderTimeline(sessionA);
  try {
    const group = () => list.querySelector<HTMLElement>(".pwa-process-group")!;
    await readAt(group());
    const top = offset(group(), list);
    const saved = viewport().captureSessionPosition();
    // 切到另一个会话后整体替换内容，原工具组 DOM 断开，只能靠定位键找回。
    flushSync(() => { viewport().reset(); viewport().restoreSessionPosition(null); });
    replace([answer("b-0", paragraphs("Session B", 30))]);
    await settleLayout();
    expect(group()).toBeNull();
    flushSync(() => { viewport().reset(); viewport().restoreSessionPosition(saved); });
    replace(sessionA);
    await settleLayout();
    expect(Math.abs(offset(group(), list) - top)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

const activityCases = [1280, 390].flatMap(width => ["no-preference", "reduce"].map(motion => ({ width, motion })));

/** 在真正绘制前的状态同步结束后取样，只观察一次标题入场所需的窗口。 */
async function sampleActivityLayout(list: HTMLElement, action: () => void) {
  const snapshot = () => ({
    scrollTop: Math.round(list.scrollTop), height: list.scrollHeight,
    working: list.querySelector(".pwa-turn-activity[data-working], .pwa-process-working") !== null,
    thinking: list.querySelector(".pwa-process-status-running > .lucide-lightbulb") !== null,
    tool: list.querySelector(".pwa-process-status-running > .pwa-spin, .pwa-process-details .pwa-tool-spinner") !== null,
  });
  action();
  const samples = [snapshot()];
  const start = performance.now();
  await new Promise<void>(resolve => {
    const sample = () => window.setTimeout(() => {
      samples.push(snapshot());
      if (performance.now() - start >= 260) resolve();
      else requestAnimationFrame(sample);
    }, 0);
    requestAnimationFrame(sample);
  });
  expect(samples.length).toBeGreaterThan(1);
  return samples;
}

test.each(activityCases)("expanding a live tool group preserves reading until Latest at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const history = answer("live-output", paragraphs("Earlier", 30));
  const tool = (id: string, complete = false): TimelineViewItem => complete ? { kind: "event", event: {
    ...scope, event_id: `event:${id}`, group_id: "live-output", timestamp: 1, kind: "tool", tool_call_id: id,
    tool: "read", args: { path: `${id}.ts` }, status: "complete", truncated: false, result: "ok",
  } } : { kind: "partial", createdAt: 1, partial: {
    ...scope, protocol_version: 2, type: "timeline_partial", group_id: "live-output", partial_id: `tool:${id}`,
    kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "running",
  } };
  const ended: TimelineViewItem = { kind: "event", event: { ...scope, event_id: "end", group_id: "live-output", timestamp: 2, kind: "run_end", status: "complete" } };
  const { screen, list, update, readAt, viewport } = await renderTimeline([history, tool("a")]);
  try {
    const group = list.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
    // 运行中的组默认展开且不暂停跟随；先手动收起，再验证一次手动展开的阅读语义。
    expect(group.getAttribute("aria-expanded")).toBe("true");
    flushSync(() => group.click());
    await settleLayout();
    expect(group.getAttribute("aria-expanded")).toBe("false");
    const top = Math.round(offset(group, list));
    const scrollTop = Math.round(list.scrollTop);
    const samples = await sampleActivityLayout(list, () => flushSync(() => group.click()));
    for (const sample of samples) expect(sample.scrollTop).toBe(scrollTop);
    expect(Math.round(offset(group, list))).toBe(top);
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(viewport().unreadOutput).toBe(0);
    for (const items of [
      [history, tool("a", true), tool("b")],
      [history, tool("a", true), tool("b", true), ended],
    ]) {
      update(items);
      await settleLayout();
      expect(Math.round(offset(group, list))).toBe(top);
      expect(Math.round(list.scrollTop)).toBe(scrollTop);
      expect(group.getAttribute("aria-expanded")).toBe("true");
    }
    expect(viewport().unreadOutput).toBeGreaterThan(0);
    await screen.getByRole("button", { name: "Latest output" }).click();
    await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
    expect(viewport().unreadOutput).toBe(0);
    expect(group.getAttribute("aria-expanded")).toBe("true");
    const latestTop = list.scrollTop;
    update([history, tool("a", true), tool("b", true), ended, answer("next", "Next reply")]);
    const bottom = list.scrollHeight - list.clientHeight;
    const allowance = Math.max(0, Number.parseFloat(getComputedStyle(list).paddingBottom) - 8);
    const expected = Math.min(bottom, Math.max(latestTop, bottom - allowance));
    await settleLayout();
    expect(Math.round(list.scrollTop)).toBe(Math.round(expected));
    const nextBody = screen.getByText("Next reply").element();
    expect(Math.round(nextBody.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(list.getBoundingClientRect().bottom) - 8);
    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);

    // 恢复跟随后再主动上滑，后续输出仍须保留用户的阅读锚点。
    const target = screen.getByText("Earlier paragraph 4: content that stays available while reading.").element();
    await readAt(target);
    const anchorTop = Math.round(offset(target, list));
    update([history, tool("a", true), tool("b", true), ended, answer("next", paragraphs("New output", 4))]);
    await settleLayout();
    expect(Math.round(offset(target, list))).toBe(anchorTop);
    expect(viewport().followingOutput).toBe(false);
    expect(viewport().unreadOutput).toBeGreaterThan(0);
  } finally { await screen.unmount(); }
});

/** 末行底边到可视区底边的距离；过程组增长优先使用底部留白，但最后一行必须完整可见并保留基础间距。 */
const lastRowClearance = (list: HTMLElement) => {
  const rows = [...list.querySelectorAll<HTMLElement>(":scope > [data-viewport-row], :scope > .pwa-thinking-status")];
  return Math.round(list.getBoundingClientRect().bottom - rows.at(-1)!.getBoundingClientRect().bottom);
};

test.each(activityCases)("a running Thinking group enters above the activity slot without hiding the follower or doubling indicators at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  // partial 必须属于最后正式记录所在轮次，才属于当前运行轮。
  const history = answer("live-output", paragraphs("Earlier", 30));
  const { screen, list, update, viewport } = await renderTimeline([history]);
  try {
    // 活动区与过程组头同高同字号，运行期间一直在末尾占位。
    const slot = list.querySelector<HTMLElement>(".pwa-turn-activity")!;
    expect(Math.round(slot.getBoundingClientRect().height)).toBe(44);
    expect(getComputedStyle(slot).fontSize).toBe("16px");
    for (const thinking of [true, false, true]) {
      const samples = await sampleActivityLayout(list, () => update(thinking ? [history, partial("live-output", "**Checking results**\nReasoning in progress.", "thinking")] : [history]));
      // 新内容出现时 Working 立即隐藏，过渡窗口内不重复提示；跟随中只向新底部移动。
      for (const sample of samples) expect(sample).toMatchObject({ working: false, thinking, tool: false });
      if (thinking) for (const [index, sample] of samples.entries()) if (index > 0) expect(sample.scrollTop).toBeGreaterThanOrEqual(samples[index - 1]!.scrollTop);
      await settleLayout();
      expect(list.querySelector(":scope > .pwa-turn-activity")).toBe(slot);
      expect(lastRowClearance(list)).toBeGreaterThanOrEqual(8);
      expect(viewport().followingOutput).toBe(true);
      expect(viewport().unreadOutput).toBe(0);
    }
  } finally { await screen.unmount(); }
});

test.each(activityCases)("a completed call hands the running heading to the next member while following and reading positions hold at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const history = answer("live-output", paragraphs("Earlier", 30));
  const tool = (id: string, complete = false): TimelineViewItem => complete ? { kind: "event", event: {
    ...scope, event_id: `event:${id}`, group_id: "live-output", timestamp: 1, kind: "tool", tool_call_id: id,
    tool: "read", args: { path: `${id}.ts` }, status: "complete", truncated: false, result: "ok",
  } } : { kind: "partial", createdAt: 1, partial: {
    ...scope, protocol_version: 2, type: "timeline_partial", group_id: "live-output", partial_id: `tool:${id}`,
    kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "running",
  } };
  const { screen, list, update, readAt, viewport } = await renderTimeline([history, tool("a")]);
  try {
    const head = list.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
    const spinner = head.querySelector(".pwa-process-status-running > .pwa-spin")!;
    expect(spinner).not.toBeNull();
    const samples = await sampleActivityLayout(list, () => update([history, tool("a", true), tool("b")]));
    // 组头运行图标原位保留，不因成员交接重新挂载；工具新行按跟随规则贴底，过程中不反向。
    for (const sample of samples) expect(sample).toMatchObject({ working: false, tool: true });
    for (const [index, sample] of samples.entries()) if (index > 0) expect(sample.scrollTop).toBeGreaterThanOrEqual(samples[index - 1]!.scrollTop);
    expect(head.querySelector(".pwa-process-status-running > .pwa-spin")).toBe(spinner);
    await settleLayout();
    expect(lastRowClearance(list)).toBeGreaterThanOrEqual(8);
    expect(viewport().followingOutput).toBe(true);

    const target = screen.getByText("Earlier paragraph 4: content that stays available while reading.").element();
    await readAt(target);
    const anchorTop = Math.round(offset(target, list));
    const readingSamples = await sampleActivityLayout(list, () => update([history, tool("a", true), tool("b", true), tool("c")]));
    for (const sample of readingSamples) expect(sample).toMatchObject({ working: false, tool: true });
    // 回看时成员追加不改变阅读位置。
    expect(new Set(readingSamples.map(sample => sample.scrollTop)).size).toBe(1);
    expect(Math.round(offset(target, list))).toBe(anchorTop);
    expect(viewport().followingOutput).toBe(false);
    expect(viewport().unreadOutput).toBe(1);
  } finally { await screen.unmount(); }
});

test.each([1280, 390])("running tool members keep following without reversal and hold the reading position at %ipx", async width => {
  await page.viewport(width, 844);
  const history = answer("live-output", paragraphs("Earlier", 30));
  const tool = (id: string): TimelineViewItem => ({ kind: "partial", createdAt: 1, partial: {
    ...scope, protocol_version: 2, type: "timeline_partial", group_id: "live-output", partial_id: `tool:${id}`,
    kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "running",
  } });
  const { screen, list, update, readAt, viewport } = await renderTimeline([history, tool("a")]);
  try {
    const sampleUpdate = async (ids: string[]) => {
      const samples: { scrollTop: number; height: number }[] = [];
      update([history, ...ids.map(tool)]);
      const start = performance.now();
      await new Promise<void>(resolve => {
        const sample = () => window.setTimeout(() => {
          samples.push({ scrollTop: Math.round(list.scrollTop), height: list.scrollHeight });
          if (performance.now() - start >= 260) resolve();
          else requestAnimationFrame(sample);
        }, 0);
        requestAnimationFrame(sample);
      });
      expect(samples.length).toBeGreaterThan(1);
      // 转动的工具图标是持续动作，Working 不出现，组头也不承载。
      expect(list.querySelector(".pwa-turn-activity[data-working], .pwa-process-working")).toBeNull();
      return samples;
    };
    const following = await sampleUpdate(["a", "b", "c", "d", "e"]);
    for (const [index, sample] of following.entries()) if (index > 0) expect(sample.scrollTop).toBeGreaterThanOrEqual(following[index - 1]!.scrollTop);
    await settleLayout();
    expect(lastRowClearance(list)).toBeGreaterThanOrEqual(8);
    expect(viewport().followingOutput).toBe(true);
    const target = screen.getByText("Earlier paragraph 4: content that stays available while reading.").element();
    await readAt(target);
    const anchorTop = Math.round(offset(target, list));
    const reading = await sampleUpdate(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(new Set(reading.map(sample => sample.scrollTop)).size).toBe(1);
    expect(Math.round(offset(target, list))).toBe(anchorTop);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("a connection banner entering and fading out above the list keeps the reading row in place", async () => {
  let setKind!: (kind: "relay" | null) => void;
  let viewport!: TimelineViewport;
  const items = [answer("first", paragraphs("First")), answer("second", paragraphs("Second")), answer("third", paragraphs("Third"))];
  function Harness() {
    const [kind, setBannerKind] = useState<"relay" | null>(null);
    setKind = setBannerKind;
    viewport = useTimelineViewport(items);
    return <main className="pwa-main" style={{ width: "100vw", height: 600, display: "flex", flexDirection: "column" }}>
      <div className="pwa-main-notices"><PwaConnectionBanner kind={kind} connection="retrying" /></div>
      <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} />
    </main>;
  }
  const screen = await renderPwa(<Harness />);
  try {
    await settleLayout();
    const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
    const row = [...list.querySelectorAll("p")].find((element) => element.textContent?.startsWith("Second paragraph 4"))!;
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    list.scrollTop += offset(row, list) - 40;
    flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settleLayout();
    expect(viewport.followingOutput).toBe(false);
    const before = offset(row, list);

    // 提示条占布局：列表变矮一次，阅读行按锚点保持在原处。
    flushSync(() => setKind("relay"));
    await settleLayout();
    expect(document.querySelector(".pwa-connection-banner")).not.toBeNull();
    expect(Math.round(Math.abs(offset(row, list) - before))).toBeLessThanOrEqual(1);

    flushSync(() => setKind(null));
    await expect.poll(() => document.querySelector(".pwa-connection-banner"), { timeout: 2000 }).toBeNull();
    await settleLayout();
    expect(Math.round(Math.abs(offset(row, list) - before))).toBeLessThanOrEqual(1);
    expect(viewport.followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

/** 同轮的长过程组：16 个已完成工具在运行中默认展开，超过一屏；正式 run_end 到达时自动收起并出现完成时间。 */
function collapsingRun(options: { reply?: boolean; runningLast?: boolean } = {}) {
  const history = answer("live-output", paragraphs("Earlier", 30));
  const tool = (id: string): TimelineViewItem => ({ kind: "event", event: {
    ...scope, event_id: `event:${id}`, group_id: "live-output", timestamp: 1, kind: "tool", tool_call_id: id,
    tool: "read", args: { path: `${id}.ts` }, status: "complete", truncated: false, result: "ok",
  } });
  const tools = Array.from({ length: 16 }, (_, index) => tool(`t${index}`));
  // 最后一个调用仍在运行时，后续正文已出现也不收起；它结束后才让位。
  const runningTail: TimelineViewItem = { kind: "partial", createdAt: 1, partial: {
    ...scope, protocol_version: 2, type: "timeline_partial", group_id: "live-output", partial_id: "tool:t15",
    kind: "tool", tool_call_id: "t15", tool: "read", args: { path: "t15.ts" }, status: "running",
  } };
  const runningTools = options.runningLast ? [...tools.slice(0, -1), runningTail] : tools;
  const reply: TimelineViewItem[] = options.reply ? [{ kind: "event", event: { ...scope, event_id: "reply", group_id: "live-output", timestamp: 2, kind: "assistant", status: "complete", blocks: [{ type: "text", text: paragraphs("Reply", 30) }] } }] : [];
  const ended: TimelineViewItem = { kind: "event", event: { ...scope, event_id: "end", group_id: "live-output", timestamp: 3, kind: "run_end", status: "complete" } };
  return { running: [history, ...runningTools, ...reply], ended: [history, ...tools, ...reply, ended] };
}

/** 采样一次收起所需的窗口；每帧在该帧回调与提交完成后读取。 */
async function sampleCollapse(list: HTMLElement, action: () => void, read: () => number) {
  action();
  const samples = [read()];
  const start = performance.now();
  await new Promise<void>(resolve => {
    const sample = () => window.setTimeout(() => {
      samples.push(read());
      if (performance.now() - start >= 400) resolve();
      else requestAnimationFrame(sample);
    }, 0);
    requestAnimationFrame(sample);
  });
  await settleLayout();
  expect(samples.length).toBeGreaterThan(2);
  expect(list.style.paddingBottom).toBe("");
  return samples;
}

test.each(activityCases)("a long group collapsing at run_end while following moves only toward the new bottom at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const run = collapsingRun();
  const { screen, list, update, viewport } = await renderTimeline(run.running);
  try {
    const head = list.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(bottomGap(list)).toBeLessThanOrEqual(1);
    // 收起与完成时间出现在同一提交：按净高度处理，不先为完成时间向下追、再随收起回落。
    // 先行一步发生在同步提交内，因此与更新前的位置一起比较。
    const before = Math.round(list.scrollTop);
    const samples = [before, ...await sampleCollapse(list, () => update(run.ended), () => Math.round(list.scrollTop))];
    for (const [index, top] of samples.entries()) if (index > 0) expect(top).toBeLessThanOrEqual(samples[index - 1]!);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    const meta = list.querySelector<HTMLElement>(".pwa-turn-meta")!;
    expect(meta).not.toBeNull();
    expect(Math.round(list.getBoundingClientRect().bottom - meta.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);
    await expect.element(screen.getByText("Earlier paragraph 29: content that stays available while reading.")).toBeVisible();
  } finally { await screen.unmount(); }
});

test.each(activityCases)("reading below a collapsing group keeps the anchor in every frame at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const run = collapsingRun({ reply: true, runningLast: true });
  const { screen, list, update, readAt, viewport } = await renderTimeline(run.running);
  try {
    expect(list.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("true");
    const anchor = screen.getByText("Reply paragraph 12: content that stays available while reading.").element();
    await readAt(anchor);
    const top = Math.round(offset(anchor, list));
    const samples = await sampleCollapse(list, () => update(run.ended), () => Math.round(offset(anchor, list)));
    for (const sample of samples) expect(Math.abs(sample - top)).toBeLessThanOrEqual(1);
    expect(list.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("false");
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each(activityCases)("an unreachable reading position moves once in one direction with the collapse and leaves no padding at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const run = collapsingRun();
  const { screen, list, update, readAt, viewport } = await renderTimeline(run.running);
  try {
    const anchor = screen.getByText("Earlier paragraph 25: content that stays available while reading.").element();
    await readAt(anchor);
    const before = Math.round(offset(anchor, list));
    // 收起后滚动范围不足以保持原位置：不垫长期空白，阅读内容只随收起向下移动一次（减少动态效果时一步到位）。
    const samples = await sampleCollapse(list, () => update(run.ended), () => Math.round(offset(anchor, list)));
    for (const [index, sample] of [before, ...samples].entries()) if (index > 0) expect(sample).toBeGreaterThanOrEqual(index === 1 ? before : samples[index - 2]!);
    expect(samples.at(-1)!).toBeGreaterThan(before);
    expect(bottomGap(list)).toBeLessThanOrEqual(1);
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each(activityCases)("an anchor inside collapsing details falls back to the still-visible group head at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const run = collapsingRun();
  const { screen, list, update, readAt, viewport } = await renderTimeline(run.running);
  try {
    // 选组内靠前的成员，保证各宽度下都离底部足够远，确实处于回看状态。
    const member = list.querySelector<HTMLElement>(".pwa-process-group .pwa-tool-card")!;
    await readAt(member);
    const head = list.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
    await sampleCollapse(list, () => update(run.ended), () => Math.round(list.scrollTop));
    expect(member.isConnected).toBe(false);
    const rect = head.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    expect(Math.round(rect.top)).toBeGreaterThanOrEqual(Math.round(bounds.top));
    expect(Math.round(rect.bottom)).toBeLessThanOrEqual(Math.round(bounds.bottom));
    expect(viewport().followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each(activityCases)("the usual turn ending — collapsed group, reply, activity slot, then run_end — never moves backward while following at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const run = collapsingRun({ reply: true });
  const { screen, list, update, viewport } = await renderTimeline(run.running);
  try {
    // 正文出现时过程组已让位收起；本轮结束呈现时活动区收起、完成时间出现在同一提交。
    expect(list.querySelector(".pwa-turn-activity")).not.toBeNull();
    expect(list.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("false");
    expect(bottomGap(list)).toBeLessThanOrEqual(1);
    const before = Math.round(list.scrollTop);
    const raw = [list.scrollTop];
    const samples = [before, ...await sampleCollapse(list, () => update(run.ended), () => { raw.push(list.scrollTop); return Math.round(list.scrollTop); })];
    // 失败时附上逐帧原始 scrollTop，便于在 CI 上区分取整抖动与真实的先跟随再回落。
    for (const [index, top] of samples.entries()) if (index > 0) expect(top, `frame ${index}: ${JSON.stringify(raw)}`).toBeLessThanOrEqual(samples[index - 1]!);
    expect(list.querySelector(".pwa-turn-activity")).toBeNull();
    expect(list.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("false");
    const meta = list.querySelector<HTMLElement>(".pwa-turn-meta")!;
    expect(Math.round(list.getBoundingClientRect().bottom - meta.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
    expect(viewport().followingOutput).toBe(true);
  } finally { await screen.unmount(); }
});
