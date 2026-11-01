import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import { isQueuedMessage } from "@/lib/pwa/queued-message-display";
import { StreamDisplayBuffer } from "@/lib/pwa/stream-display-buffer";
import type { TimelinePending, TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";

// 隔离的合成数据：显示缓冲按真实节奏逐帧推进，不连接会话、不写入历史。
const scope = { session_id: "session-1", leaf_id: "leaf-1" } as const;
const QUEUED_TEXT = "Queued follow-up";
const userEvent = (group: string, messageId: string, text: string): TimelineViewItem => ({ kind: "event", event: {
  ...scope, event_id: `user-${group}`, timestamp: 1, group_id: group, kind: "user", message_id: messageId,
  blocks: [{ type: "text", text }], origin: "extension", delivery: "normal", status: "committed",
} satisfies TimelineEvent });
const reply = (delta: string): TimelineViewItem => ({ kind: "partial", createdAt: 1, partial: {
  protocol_version: 2, type: "timeline_partial", ...scope, group_id: "g1", partial_id: "m1:assistant:0", kind: "assistant", status: "delta", delta,
} satisfies TimelinePartial });
const formal = (text: string): TimelineViewItem => ({ kind: "event", event: {
  ...scope, event_id: "m1", timestamp: 2, group_id: "g1", kind: "assistant", status: "complete", blocks: [{ type: "text", text }],
} satisfies TimelineEvent });
const runEnd: TimelineViewItem = { kind: "event", event: { ...scope, event_id: "end-g1", timestamp: 3, group_id: "g1", kind: "run_end", status: "complete" } };
const queued = (patch: Partial<TimelinePending> = {}): TimelinePending => ({
  kind: "pending", id: "pending:q", clientRequestId: "q", requestId: "a", text: QUEUED_TEXT, createdAt: 2, delivery: "accepted", queued: true, cancelable: true, ...patch,
});

beforeEach(async () => { await page.viewport(1280, 900); });

async function liveList() {
  let setItems!: (items: TimelineViewItem[]) => void;
  function Harness() {
    const [items, update] = useState<TimelineViewItem[]>([]);
    setItems = update;
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}><MessageList items={items} hasEarlier={false} isLive running listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} onRetryFailed={() => {}} onCheckStatus={() => {}} onCancelQueued={() => {}} /></main>;
  }
  const screen = await renderPwa(<Harness />);
  // 与应用一致：排队区的消息由排队面板呈现，不交给消息列表。
  return { screen, show: (items: TimelineViewItem[]) => flushSync(() => setItems(items.filter(item => !isQueuedMessage(item)))) };
}

/** 对话区里显示排队消息正文的行数（排队面板不在消息列表内）。 */
const bubbles = () => [...document.querySelectorAll<HTMLElement>(".pwa-message-list .pwa-message.user")]
  .filter(row => row.textContent?.includes(QUEUED_TEXT)).length;

test("a dequeued message enters the conversation once, without a duplicate bubble when its user message takes over", async () => {
  const { screen, show } = await liveList();
  const buffer = new StreamDisplayBuffer();
  const body = "A previous reply whose tail is still being revealed when the queued message starts. ".repeat(3);
  show(buffer.ingest([userEvent("g1", "first", "First")]).items);
  show(buffer.ingest([userEvent("g1", "first", "First"), reply(body.slice(0, 30)), queued()]).items);
  for (let frame = 0; frame < 3; frame += 1) show(buffer.advance(16).items);
  expect(bubbles()).toBe(0);
  // 出队：先记下消息 ID，随后正式用户消息到达、pending 被删除。
  show(buffer.ingest([userEvent("g1", "first", "First"), formal(body), runEnd, queued({ queued: false, messageId: "message-q", delivery: "committed" })]).items);
  show(buffer.ingest([userEvent("g1", "first", "First"), formal(body), runEnd, userEvent("g2", "message-q", QUEUED_TEXT)]).items);
  const counts: number[] = [];
  for (let frame = 0; frame < 150 && buffer.hasPending(); frame += 1) {
    show(buffer.advance(16).items);
    counts.push(bubbles());
  }
  show(buffer.advance(16).items);
  counts.push(bubbles());
  // 全程最多一个气泡：等待期间为 0，进入后保持 1，用户消息接管时不重复。
  expect(Math.max(...counts)).toBe(1);
  expect(counts.at(-1)).toBe(1);
  expect(counts.findIndex(count => count === 1)).toBeGreaterThan(0);
  await screen.unmount();
});
