import { expect, test } from "vitest";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import { STRUCTURE_BULK_LIMIT, STRUCTURE_GAP_MS, STRUCTURE_MAX_LAG_MS, TOOL_MIN_RUNNING_MS } from "./stream-structure-gate";
import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import type { TimelinePending, TimelineViewItem } from "./timeline-runtime";

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
