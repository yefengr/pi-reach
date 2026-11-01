import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelinePending, TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";

type ListProps = Parameters<typeof MessageList>[0];
const base = { session_id: "session-1", leaf_id: "leaf-1", group_id: "group-1" };
const toolRunning: TimelineViewItem = { kind: "partial", createdAt: 0, partial: {
  protocol_version: 2, type: "timeline_partial", ...base, kind: "tool", partial_id: "tool:tool-1", tool_call_id: "tool-1", tool: "read", args: { path: "README.md" }, status: "running",
} satisfies TimelinePartial };
const toolDone: TimelineViewItem = { kind: "event", event: { ...base, event_id: "tool-event", timestamp: 1, kind: "tool", tool_call_id: "tool-1", tool: "read", args: { path: "README.md" }, truncated: false, status: "complete", result: {} } satisfies TimelineEvent };
const reply = (id: string, text: string): TimelineViewItem => ({ kind: "event", event: { ...base, event_id: id, timestamp: 2, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] } });
const runEnd: TimelineViewItem = { kind: "event", event: { ...base, event_id: "run-end", timestamp: 10, kind: "run_end", status: "complete" } };
const pending = (id: string): TimelinePending => ({ kind: "pending", id, clientRequestId: id, requestId: id, text: `Message ${id}`, createdAt: 1, delivery: "pending" });

/** 列表内容坐标中的位置：跟随滚动会整体移动内容，按内容坐标比较才能判断元素本身是否移动。 */
function contentTop(element: Element): number {
  const list = element.closest(".pwa-message-list")!;
  return Math.round(element.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop);
}

beforeEach(async () => { await page.viewport(1280, 900); });

async function liveList(initial: TimelineViewItem[], overrides: Partial<ListProps> = {}) {
  let setItems!: (items: TimelineViewItem[]) => void;
  let setProps!: (props: Partial<ListProps>) => void;
  function Harness() {
    const [items, update] = useState(initial);
    const [props, updateProps] = useState(overrides);
    setItems = update;
    setProps = updateProps;
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}><MessageList items={items} hasEarlier={false} isLive listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} onRetryFailed={() => {}} onCheckStatus={() => {}} onCancelQueued={() => {}} {...props} /></main>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, update: (items: TimelineViewItem[], props?: Partial<ListProps>) => flushSync(() => { setItems(items); if (props) setProps(props); }) };
}

test("S1: the empty hint fades out in place before the first bubble enters, without moving the new content", async () => {
  // 上方有带外边距的提示行时，离开状态截断外边距也不能让提示下移。
  const { screen, update } = await liveList([], { emptyContext: "pi-reach · model", topNotice: "Pi switched to a new session" });
  expect(document.querySelector(".pwa-chat-empty-slot[data-leaving]")).toBeNull();
  update([pending("first")]);
  // 原位：离开中的位置等于同一时刻去掉离开标记与补偿后的自然位置。
  const hint = document.querySelector<HTMLElement>(".pwa-chat-empty")!;
  const leavingTop = contentTop(hint);
  const compensation = hint.style.translate;
  hint.parentElement!.removeAttribute("data-leaving");
  hint.style.translate = "";
  const settledTop = contentTop(hint);
  hint.parentElement!.setAttribute("data-leaving", "");
  hint.style.translate = compensation;
  expect(leavingTop).toBe(settledTop);
  const slot = document.querySelector<HTMLElement>(".pwa-chat-empty-slot")!;
  expect(slot.hasAttribute("data-leaving")).toBe(true);
  expect(slot.inert).toBe(true);
  expect(slot.getAttribute("aria-hidden")).toBe("true");
  expect(Math.round(slot.getBoundingClientRect().height)).toBe(0);
  const bubble = document.querySelector<HTMLElement>(".pwa-message.user")!;
  expect(bubble.classList.contains("pwa-user-message-in")).toBe(true);
  expect(bubble.classList.contains("pwa-user-message-after-empty")).toBe(true);
  // 空会话的第一条消息没有跟随滚动，保留上移；之后的气泡只淡入。
  expect(getComputedStyle(bubble).animationName).toBe("pwa-user-message-in");
  expect(getComputedStyle(bubble).animationDelay).toBe(getComputedStyle(document.documentElement).getPropertyValue("--pwa-duration-fade").trim().replace(/^(\d+)ms$/, (_, ms: string) => `${Number(ms) / 1000}s`));
  // 气泡本身在做位移动画，量外层行的布局位置。
  const row = bubble.closest<HTMLElement>(".pwa-user-row")!;
  const rowTop = contentTop(row);
  await expect.poll(() => document.querySelector(".pwa-chat-empty-slot")).toBeNull();
  // 提示移除时新内容不跳动；之后的气泡按普通节奏进入。
  expect(contentTop(row)).toBe(rowTop);
  update([pending("first"), pending("second")]);
  const second = document.querySelectorAll<HTMLElement>(".pwa-message.user")[1]!;
  expect(second.classList.contains("pwa-user-message-in")).toBe(true);
  expect(second.classList.contains("pwa-user-message-after-empty")).toBe(false);
  expect(getComputedStyle(second).animationName).toBe("pwa-row-enter");
  await screen.unmount();
});

test("S2: a reply that ends a running group waits for the automatic collapse before it appears", async () => {
  const { screen, update } = await liveList([toolRunning], { running: true });
  expect(document.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("true");
  update([toolDone, reply("reply-1", "After the tools.")]);
  expect(document.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector<HTMLElement>(".pwa-process-details")?.dataset.exit).toBe("settle");
  const row = document.querySelector<HTMLElement>(".pwa-message.assistant")!;
  expect(row.classList.contains("pwa-row-enter")).toBe(true);
  expect(row.classList.contains("pwa-enter-after-settle")).toBe(true);
  expect(getComputedStyle(row).animationDelay).toBe(`${Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pwa-duration-collapse-settle")) / 1000}s`);
  // 收起之后同一轮再出现的正文不再等待。
  update([toolDone, reply("reply-1", "After the tools."), reply("reply-2", "More text.")]);
  const later = document.querySelectorAll<HTMLElement>(".pwa-message.assistant")[1]!;
  expect(later.classList.contains("pwa-row-enter")).toBe(true);
  expect(later.classList.contains("pwa-enter-after-settle")).toBe(false);
  await screen.unmount();
});

test("S3: the completion time fades in after a group without reply settles, and loaded turns do not replay", async () => {
  const { screen, update } = await liveList([toolRunning], { running: true });
  update([toolDone, runEnd], { running: false });
  await expect.poll(() => document.querySelector("button.pwa-process-head")?.getAttribute("aria-expanded")).toBe("false");
  const meta = document.querySelector<HTMLElement>(".pwa-turn-meta")!;
  expect(meta.classList.contains("pwa-turn-meta-in")).toBe(true);
  expect(meta.classList.contains("pwa-enter-after-settle")).toBe(true);
  await screen.unmount();

  const loaded = await liveList([toolDone, runEnd]);
  const restored = document.querySelector<HTMLElement>(".pwa-turn-meta")!;
  expect(restored.classList.contains("pwa-turn-meta-in")).toBe(false);
  await loaded.screen.unmount();
});
