import { expect, test } from "vitest";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import { STRUCTURE_BULK_LIMIT, STRUCTURE_GAP_MS, STRUCTURE_MAX_LAG_MS, TOOL_MIN_RUNNING_MS } from "./stream-structure-gate";
import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import type { TimelinePartialView, TimelinePending, TimelineViewItem } from "./timeline-runtime";
import { PWA_MOTION_FALLBACK_MS } from "@/lib/ui/motion-duration";

const scope = { session_id: "s", leaf_id: "l" } as const;

function user(group: string): TimelineViewItem {
  const event: TimelineEvent = { ...scope, event_id: `user-${group}`, timestamp: 1, group_id: group, kind: "user", message_id: `user-${group}`, blocks: [{ type: "text", text: "hi" }], origin: "extension", delivery: "normal", status: "committed" };
  return { kind: "event", event };
}

function text(id: string, group: string, delta: string): TimelineViewItem {
  const partial: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...scope, group_id: group, partial_id: `${id}:assistant:0`, kind: "assistant", status: "delta", delta };
  return { kind: "partial", partial, createdAt: 1 };
}

function tool(id: string, group: string, status: "preparing" | "running" = "running"): TimelineViewItem {
  const partial: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...scope, group_id: group, partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, status };
  return { kind: "partial", partial, createdAt: 1 };
}

function toolDone(id: string, group: string): TimelineViewItem {
  const event: TimelineEvent = { ...scope, event_id: `event-${id}`, timestamp: 2, group_id: group, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, truncated: false, status: "complete", result: "ok" };
  return { kind: "event", event };
}

function runEnd(group: string): TimelineViewItem {
  const event: TimelineEvent = { ...scope, event_id: `end-${group}`, timestamp: 3, group_id: group, kind: "run_end", status: "complete" };
  return { kind: "event", event };
}

function ids(items: readonly TimelineViewItem[]): string[] {
  return items.map(item => item.kind === "event" ? item.event.event_id : item.kind === "partial" ? item.partial.partial_id : item.id);
}

/** 先显示用户消息，使该轮成为正在观看的一轮。 */
function watching(group = "g"): StreamDisplayBuffer {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([user(group)]);
  return buffer;
}

test("initial content and catch-up of an unwatched turn appear at once", () => {
  const buffer = new StreamDisplayBuffer();
  const first = buffer.ingest([user("g"), tool("a", "g"), tool("b", "g")]);
  expect(ids(first.items)).toEqual(["user-g", "tool:a", "tool:b"]);
  // 另一轮的全部内容随同一次到达：用户消息属于新轮，不排队。
  const next = buffer.ingest([user("g"), tool("a", "g"), tool("b", "g"), user("h"), tool("c", "h")]);
  expect(ids(next.items)).toContain("tool:c");
});

test("new rows of the watched turn appear one by one with the structure gap", () => {
  const buffer = watching();
  const items = [user("g"), tool("a", "g"), tool("b", "g")];
  expect(ids(buffer.ingest(items).items)).toEqual(["user-g", "tool:a"]);
  expect(buffer.hasPending()).toBe(true);
  expect(ids(buffer.advance(STRUCTURE_GAP_MS / 2).items)).toEqual(["user-g", "tool:a"]);
  expect(ids(buffer.advance(STRUCTURE_GAP_MS / 2).items)).toEqual(["user-g", "tool:a", "tool:b"]);
});

test("a following row waits until the text before it has been revealed", () => {
  const buffer = watching();
  const long = "a reply long enough to need several frames before it is fully shown";
  buffer.ingest([user("g"), text("m1", "g", long)]);
  const withTool = buffer.ingest([user("g"), text("m1", "g", long), tool("a", "g")]);
  expect(ids(withTool.items)).not.toContain("tool:a");
  let items = withTool.items;
  for (let frame = 0; frame < 120 && !ids(items).includes("tool:a"); frame += 1) items = buffer.advance(16).items;
  const shown = items.find(item => item.kind === "partial" && item.partial.kind === "assistant");
  expect(shown?.kind === "partial" ? shown.partial.delta : undefined).toBe(long);
  expect(ids(items)).toContain("tool:a");
});

test("a gated text lane does not consume its text before it is shown", () => {
  const buffer = watching();
  const body = "queued text that must start from the first graphemes once shown";
  buffer.ingest([user("g"), tool("a", "g"), text("m1", "g", body)]);
  // 门控期间推进的时间不能提前放出排队正文。
  const shown = buffer.advance(STRUCTURE_GAP_MS).items.find(item => item.kind === "partial" && item.partial.kind === "assistant");
  expect(shown?.kind === "partial" ? shown.partial.delta?.length : 0).toBeLessThan(body.length / 2);
});

test("run_end waits for every row and tool hold of its turn", () => {
  const buffer = watching();
  buffer.ingest([user("g"), tool("a", "g")]);
  const done = buffer.ingest([user("g"), toolDone("a", "g"), runEnd("g")]);
  // 工具仍在最短运行展示期：结束标记与正式结果都暂缓。
  expect(ids(done.items)).toEqual(["user-g", "tool:a"]);
  const settled = buffer.advance(TOOL_MIN_RUNNING_MS);
  expect(ids(settled.items)).toContain("event-a");
  let items = settled.items;
  for (let frame = 0; frame < 20 && !ids(items).includes("end-g"); frame += 1) items = buffer.advance(16).items;
  expect(ids(items)).toEqual(["user-g", "event-a", "end-g"]);
  // 完成标记放出后再留一个结构间隔的交接期，之后不再有待处理内容。
  buffer.advance(STRUCTURE_GAP_MS);
  expect(buffer.hasPending()).toBe(false);
});

test("a tool first seen as complete is not shown as running", () => {
  const buffer = watching();
  const change = buffer.ingest([user("g"), toolDone("a", "g")]);
  expect(ids(change.items)).toEqual(["user-g", "event-a"]);
});

test("preparing and running keep one hold that starts at the first in-progress view", () => {
  const buffer = watching();
  buffer.ingest([user("g"), tool("a", "g", "preparing")]);
  buffer.advance(TOOL_MIN_RUNNING_MS / 2);
  buffer.ingest([user("g"), tool("a", "g", "running")]);
  expect(ids(buffer.ingest([user("g"), toolDone("a", "g")]).items)).toEqual(["user-g", "tool:a"]);
  expect(ids(buffer.advance(TOOL_MIN_RUNNING_MS / 2).items)).toEqual(["user-g", "event-a"]);
});

test("a burst larger than the bulk limit is treated as catch-up", () => {
  const buffer = watching();
  const tools = Array.from({ length: STRUCTURE_BULK_LIMIT + 1 }, (_, index) => tool(`t${index}`, "g"));
  expect(buffer.ingest([user("g"), ...tools]).items).toHaveLength(tools.length + 1);
});

test("rows waiting longer than the lag limit catch up without the gap", () => {
  const buffer = watching();
  const long = "x".repeat(400);
  buffer.ingest([user("g"), text("m1", "g", long), tool("a", "g"), tool("b", "g")]);
  let items: TimelineViewItem[] = [];
  let elapsed = 0;
  while (!ids(items).includes("tool:b") && elapsed < STRUCTURE_MAX_LAG_MS * 3) {
    items = buffer.advance(16).items;
    elapsed += 16;
  }
  expect(ids(items)).toContain("tool:b");
  // 积压超过上限后，两行之间不再强制间隔。
  expect(elapsed).toBeLessThan(STRUCTURE_MAX_LAG_MS * 3);
});

test("an own message entering the timeline lets the previous reply finish its tail", () => {
  const buffer = watching();
  const long = "a previous reply that is still being revealed when the next message is sent";
  buffer.ingest([user("g"), text("m1", "g", long)]);
  const pending: TimelinePending = { kind: "pending", id: "pending:r", clientRequestId: "r", requestId: "a", text: "next", createdAt: 2, delivery: "pending" };
  const change = buffer.ingest([user("g"), text("m1", "g", long), pending]);
  // 新气泡立即显示；上一条回复不被一次补完，继续按节奏放出。
  expect(ids(change.items)).toContain("pending:r");
  const reply = change.items.find(item => item.kind === "partial");
  expect(reply?.kind === "partial" ? reply.partial.delta?.length : 0).toBeLessThan(long.length);
});

test("a message expected to queue does not flush the running reply", () => {
  const buffer = watching();
  const long = "a reply that keeps streaming while another message waits in the queue";
  buffer.ingest([user("g"), text("m1", "g", long)]);
  const queued: TimelinePending = { kind: "pending", id: "pending:q", clientRequestId: "q", requestId: "a", text: "later", createdAt: 2, delivery: "pending", queueExpected: true };
  const reply = buffer.ingest([user("g"), text("m1", "g", long), queued]).items.find(item => item.kind === "partial");
  expect(reply?.kind === "partial" ? reply.partial.delta?.length : 0).toBeLessThan(long.length);
});

const SETTLE_MS = PWA_MOTION_FALLBACK_MS["--pwa-duration-collapse-settle"];

function thinking(id: string, group: string, delta: string): TimelineViewItem {
  const partial: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...scope, group_id: group, partial_id: `${id}:thinking:0`, kind: "thinking", status: "delta", delta };
  return { kind: "partial", partial, createdAt: 1 };
}

function reply(items: readonly TimelineViewItem[]): TimelinePartialView | undefined {
  return items.find((item): item is TimelinePartialView => item.kind === "partial" && item.partial.kind === "assistant");
}

/** 逐帧推进到正文结束等待，返回等待期间经过的时长与结束后的第一份正文。 */
function untilRevealed(buffer: StreamDisplayBuffer): { waited: number; view: TimelinePartialView | undefined } {
  let waited = 0;
  let view = reply(buffer.snapshot());
  while (view?.awaitingSettle && waited < SETTLE_MS * 4) {
    waited += 16;
    view = reply(buffer.advance(16).items);
  }
  return { waited, view };
}

test("text right after a process row waits for the group to collapse, then reveals from the first grapheme", () => {
  const buffer = watching();
  buffer.ingest([user("g"), toolDone("a", "g")]);
  buffer.advance(STRUCTURE_GAP_MS);
  buffer.ingest([user("g"), toolDone("a", "g"), text("m1", "g", "Hello world, this is the reply")]);
  const waiting = reply(buffer.advance(STRUCTURE_GAP_MS).items);
  // 等待期间正文已到达但不显示文字，投影带等待标记供过程组先收起。
  expect(waiting).toMatchObject({ awaitingSettle: true });
  expect(waiting?.partial.delta).toBe("");
  expect(buffer.hasPending()).toBe(true);
  const { waited, view } = untilRevealed(buffer);
  expect(waited).toBeGreaterThanOrEqual(SETTLE_MS - 16);
  expect(waited).toBeLessThanOrEqual(SETTLE_MS + 16);
  expect(view?.awaitingSettle).toBeUndefined();
  // 等待标记与首批字素在同一快照交接，正文不会短暂消失。
  expect(view?.partial.delta).toBe("He");
});

test("text after a thinking block of the same message also waits", () => {
  const buffer = watching();
  buffer.ingest([user("g"), thinking("m1", "g", "plan")]);
  for (let frame = 0; frame < 20; frame += 1) buffer.advance(16);
  buffer.ingest([user("g"), thinking("m1", "g", "plan"), text("m1", "g", "Answer")]);
  let view = reply(buffer.snapshot());
  for (let frame = 0; frame < 20 && !view?.awaitingSettle; frame += 1) view = reply(buffer.advance(16).items);
  expect(view).toMatchObject({ awaitingSettle: true });
});

test("text that opens a turn or follows other text does not wait", () => {
  const buffer = watching();
  buffer.ingest([user("g"), text("m1", "g", "First reply")]);
  const first = reply(buffer.advance(16).items);
  expect(first?.awaitingSettle).toBeUndefined();
  expect(first?.partial.delta).not.toBe("");
});

test("leading whitespace does not start the wait; the first visible character does", () => {
  const buffer = watching();
  buffer.ingest([user("g"), toolDone("a", "g")]);
  buffer.advance(STRUCTURE_GAP_MS);
  buffer.ingest([user("g"), toolDone("a", "g"), text("m1", "g", "\n")]);
  for (let frame = 0; frame < 10; frame += 1) expect(reply(buffer.advance(16).items)?.awaitingSettle).toBeUndefined();
  buffer.ingest([user("g"), toolDone("a", "g"), text("m1", "g", "\nVisible")]);
  expect(reply(buffer.advance(16).items)).toMatchObject({ awaitingSettle: true });
  // 等待结束时越过前导空白，首个可见字随交接一起出现。
  expect(untilRevealed(buffer).view?.partial.delta).toBe("\nVi");
});

test("run_end waits until the settled text has been revealed", () => {
  const buffer = watching();
  buffer.ingest([user("g"), toolDone("a", "g")]);
  buffer.advance(STRUCTURE_GAP_MS);
  buffer.ingest([user("g"), toolDone("a", "g"), text("m1", "g", "Done")]);
  buffer.advance(STRUCTURE_GAP_MS);
  const ended = buffer.ingest([user("g"), toolDone("a", "g"), text("m1", "g", "Done"), runEnd("g")]);
  expect(ids(ended.items)).not.toContain("end-g");
  let items = ended.items;
  for (let frame = 0; frame < 80 && !ids(items).includes("end-g"); frame += 1) items = buffer.advance(16).items;
  expect(reply(items)?.partial.delta).toBe("Done");
  expect(ids(items)).toContain("end-g");
});

test("reset and foreground flush reveal waiting text at once", () => {
  const buffer = watching();
  buffer.ingest([user("g"), toolDone("a", "g")]);
  buffer.advance(STRUCTURE_GAP_MS);
  buffer.ingest([user("g"), toolDone("a", "g"), text("m1", "g", "Hello")]);
  expect(reply(buffer.advance(STRUCTURE_GAP_MS).items)).toMatchObject({ awaitingSettle: true });
  const flushed = reply(buffer.flush().items);
  expect(flushed?.awaitingSettle).toBeUndefined();
  expect(flushed?.partial.delta).toBe("Hello");
});

function assistant(id: string, group: string, body: string): TimelineViewItem {
  const event: TimelineEvent = { ...scope, event_id: id, timestamp: 2, group_id: group, kind: "assistant", status: "complete", blocks: [{ type: "text", text: body }] };
  return { kind: "event", event };
}

function nextUser(group: string, messageId: string): TimelineViewItem {
  const event: TimelineEvent = { ...scope, event_id: `user-${group}`, timestamp: 4, group_id: group, kind: "user", message_id: messageId, blocks: [{ type: "text", text: "again" }], origin: "extension", delivery: "normal", status: "committed" };
  return { kind: "event", event };
}

function queuedMessage(patch: Partial<TimelinePending> = {}): TimelinePending {
  return { kind: "pending", id: "pending:q", clientRequestId: "q", requestId: "a", text: "again", createdAt: 2, delivery: "accepted", queued: true, cancelable: true, ...patch };
}

/** 上一轮回复仍在放尾巴时，权威快照里同时到达正式回复、run_end 与下一轮（排队消息出队）。 */
function handoffRun() {
  const buffer = watching("g1");
  const body = "a long reply whose tail is still being revealed when the next turn starts ".repeat(4);
  buffer.ingest([user("g1"), text("m1", "g1", body.slice(0, 40)), queuedMessage()]);
  for (let frame = 0; frame < 3; frame += 1) buffer.advance(16);
  return { buffer, body };
}

const pendingOf = (items: readonly TimelineViewItem[]) => items.filter((item): item is TimelinePending => item.kind === "pending");

test("the next turn waits until the previous reply and its run_end are presented, then follows after the structure gap", () => {
  const { buffer, body } = handoffRun();
  const items = [user("g1"), assistant("m1", "g1", body), runEnd("g1"), nextUser("g2", "message-q")];
  const arrived = buffer.ingest(items);
  // 上一轮尾巴未放完：完成标记与下一轮用户消息都不提前出现。
  expect(ids(arrived.items)).not.toContain("end-g1");
  expect(ids(arrived.items)).not.toContain("user-g2");
  let shown = arrived.items;
  let elapsed = 0;
  while (!ids(shown).includes("end-g1") && elapsed < 2000) { shown = buffer.advance(16).items; elapsed += 16; }
  expect(ids(shown)).not.toContain("user-g2");
  const endedAt = elapsed;
  while (!ids(shown).includes("user-g2") && elapsed < 3000) { shown = buffer.advance(16).items; elapsed += 16; }
  expect(elapsed - endedAt).toBeGreaterThanOrEqual(STRUCTURE_GAP_MS);
  expect(elapsed - endedAt).toBeLessThanOrEqual(STRUCTURE_GAP_MS + 32);
});

test("a dequeued message stays in the queue as sending until the previous turn is presented, then enters once with its user message", () => {
  const { buffer, body } = handoffRun();
  // 出队：Runtime 先记下消息 ID，随后正式用户消息到达时删除 pending。
  let shown = buffer.ingest([user("g1"), assistant("m1", "g1", body), runEnd("g1"), queuedMessage({ queued: false, messageId: "message-q", delivery: "committed" })]).items;
  expect(pendingOf(shown)).toEqual([expect.objectContaining({ id: "pending:q", queued: true, cancelable: false, messageId: undefined })]);
  shown = buffer.ingest([user("g1"), assistant("m1", "g1", body), runEnd("g1"), nextUser("g2", "message-q")]).items;
  expect(pendingOf(shown)).toEqual([expect.objectContaining({ id: "pending:q", queued: true, cancelable: false })]);
  let elapsed = 0;
  while (pendingOf(shown)[0]?.queued === true && elapsed < 3000) {
    shown = buffer.advance(16).items;
    elapsed += 16;
  }
  expect(elapsed).toBeGreaterThan(0);
  // 交接结束的快照里先以已出队副本代替用户消息，同一快照不并存两者（否则显示为两个气泡）。
  expect(pendingOf(shown)).toEqual([expect.objectContaining({ id: "pending:q", queued: false, messageId: "message-q" })]);
  expect(ids(shown).filter(id => id === "user-g2" || id === "pending:q")).toEqual(["pending:q"]);
  expect(buffer.hasPending()).toBe(true);
  // 下一帧换回用户消息，展示层按消息 ID 沿用同一气泡。
  const next = buffer.advance(16).items;
  expect(pendingOf(next)).toEqual([]);
  expect(ids(next)).toContain("user-g2");
});

test("a message delivered within the same turn is not held", () => {
  const buffer = watching("g1");
  buffer.ingest([user("g1"), text("m1", "g1", "streaming reply"), queuedMessage()]);
  const shown = buffer.ingest([user("g1"), text("m1", "g1", "streaming reply"), queuedMessage({ queued: false, messageId: "message-q", delivery: "committed" })]).items;
  expect(pendingOf(shown)).toEqual([expect.objectContaining({ queued: false, messageId: "message-q" })]);
});

test("an own message taken over while its user message waits for the previous turn stays in place, then hands over directly", () => {
  const { buffer, body } = handoffRun();
  const own: TimelinePending = { kind: "pending", id: "pending:own", clientRequestId: "own", requestId: "b", text: "again", createdAt: 3, delivery: "committed", messageId: "message-own" };
  buffer.ingest([user("g1"), text("m1", "g1", body.slice(0, 40)), own]);
  // 正式用户消息到达，Runtime 删除 pending；该用户消息属于下一轮，仍在等上一轮呈现。
  let shown = buffer.ingest([user("g1"), assistant("m1", "g1", body), runEnd("g1"), nextUser("g2", "message-own")]).items;
  expect(pendingOf(shown)).toEqual([expect.objectContaining({ id: "pending:own", messageId: "message-own" })]);
  expect(ids(shown)).not.toContain("user-g2");
  let elapsed = 0;
  while (!ids(shown).includes("user-g2") && elapsed < 3000) {
    shown = buffer.advance(16).items;
    elapsed += 16;
    // 等待期间气泡一直在，且不与用户消息并存。
    expect(pendingOf(shown).length + (ids(shown).includes("user-g2") ? 1 : 0)).toBe(1);
  }
  expect(pendingOf(shown)).toEqual([]);
});
