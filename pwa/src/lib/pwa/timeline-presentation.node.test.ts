import { expect, test } from "vitest";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";
import { projectTimeline } from "./timeline-presentation";

const base = { session_id: "s", leaf_id: "g", group_id: "group" } as const;
function tool(id: string, timestamp: number): Extract<TimelineEvent, { kind: "tool" }> {
  return { ...base, event_id: `event-${id}`, timestamp, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, truncated: false, status: "complete", result: id };
}
function partial(id: string): Extract<TimelinePartial, { kind: "tool" }> {
  return { protocol_version: 2, type: "timeline_partial", ...base, partial_id: `partial-${id}`, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "running", delta: "working" };
}
function item(event: TimelineEvent | TimelinePartial): TimelineViewItem {
  return "event_id" in event ? { kind: "event", event } : { kind: "partial", createdAt: 1, partial: event };
}
function answer(id: string, text: string): Extract<TimelineEvent, { kind: "assistant" }> {
  return { ...base, event_id: id, timestamp: 2, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] };
}

test("keeps each tool in place when parallel completion order differs from call order", () => {
  const before = item(answer("before", "Before"));
  const between = item(answer("between", "Between"));
  const first = projectTimeline([before, item(partial("a")), between, item(partial("b"))]);
  expect(first.entries.map(entry => entry.kind)).toEqual(["text", "tool", "text", "tool"]);
  // Runtime 按结果时间排序后，已出现的调用仍留在正文两侧。
  const settled = projectTimeline([before, between, item(tool("b", 3)), item(tool("a", 5))], first);
  expect(settled.entries.map(entry => entry.key)).toEqual(first.entries.map(entry => entry.key));
  expect(settled.entries.filter(entry => entry.kind === "tool").map(entry => entry.value)).toEqual([tool("a", 5), tool("b", 3)]);
});

test("keeps all tools independently visible instead of selecting the latest three", () => {
  const items = Array.from({ length: 12 }, (_, index) => item(tool(String(index), index)));
  const view = projectTimeline(items);
  expect(view.entries).toHaveLength(12);
  expect(view.entries.every(entry => entry.kind === "tool")).toBe(true);
  expect(new Set(view.entries.map(entry => entry.key)).size).toBe(12);
});

test("loading earlier history inserts it before existing records without moving them", () => {
  const first = projectTimeline([item(tool("a", 2)), item(tool("b", 3))]);
  const view = projectTimeline([item(answer("earlier", "Earlier")), item(tool("a", 2)), item(tool("b", 3))], first);
  expect(view.entries[0]).toMatchObject({ kind: "text", text: "Earlier" });
  expect(view.entries.slice(1).map(entry => entry.key)).toEqual(first.entries.map(entry => entry.key));
});

test("retains thinking identity as the formal message replaces its partial", () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "answer:thinking:0", kind: "thinking", status: "delta", delta: "Considering" };
  const first = projectTimeline([item(thinking)]);
  const view = projectTimeline([item({ ...answer("answer", "Answer"), blocks: [{ type: "thinking", text: "Considered" }, { type: "text", text: "Answer" }] })], first);
  expect(view.entries[0]).toMatchObject({ kind: "thinking", key: first.entries[0].key, streaming: false, text: "Considered" });
  expect(view.entries[1]).toMatchObject({ kind: "text", text: "Answer" });
});

test("isolates repeated tool ids between sessions and history generations", () => {
  const first = projectTimeline([item(tool("same", 1))]);
  for (const scope of [{ session_id: "other" }, { leaf_id: "other" }, { group_id: "other" }]) {
    const view = projectTimeline([item({ ...tool("same", 1), ...scope })], first);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].key).not.toBe(first.entries[0].key);
  }
  expect(projectTimeline([], first).entries).toEqual([]);
});
