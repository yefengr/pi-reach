import { expect, test } from "vitest";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";
import { projectTimelineGaps, projectTimeline } from "./timeline-presentation";
import { observeTools, toolSegments } from "@/components/pwa/tool-groups";

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

function emptyThinking(id: string, scope: Partial<Pick<TimelineEvent, "session_id" | "leaf_id" | "group_id">> = {}): TimelineViewItem {
  return item({ ...answer(id, ""), ...scope, blocks: [{ type: "thinking", text: "" }] });
}

test("merges empty historical thinking blocks and messages into one trace per turn", () => {
  const first = item({ ...answer("first", ""), blocks: [{ type: "thinking", text: "" }, { type: "thinking", text: " \t\n" }, { type: "text", text: "" }] });
  const view = projectTimeline([first, emptyThinking("later", { leaf_id: "next-leaf" }), item(answer("answer", "Visible answer"))]);
  expect(view.entries).toHaveLength(2);
  expect(view.entries[0]).toMatchObject({ kind: "thinking", text: "", streaming: false });
  expect(view.entries[1]).toMatchObject({ kind: "text", text: "Visible answer" });
});

test("does not invent thinking traces for empty text or absent blocks", () => {
  const view = projectTimeline([item(answer("empty-text", " \t\n")), item({ ...answer("absent", ""), blocks: [] })]);
  expect(view.entries).toEqual([]);
});

test("isolates empty thinking traces by session and turn, not by appended leaf", () => {
  const view = projectTimeline([
    emptyThinking("first"), emptyThinking("same-turn", { leaf_id: "next-leaf" }),
    emptyThinking("other-turn", { group_id: "other" }), emptyThinking("other-session", { session_id: "other" }),
  ]);
  expect(view.entries).toHaveLength(3);
  expect(new Set(view.entries.map(entry => entry.key)).size).toBe(3);
});

test("keeps live empty thinking separate and retains a trace after completion", () => {
  const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "answer:thinking:0", kind: "thinking", status: "running", delta: "" };
  const first = projectTimeline([item(thinking), item({ ...thinking, partial_id: "answer:thinking:1" })]);
  expect(first.entries).toHaveLength(2);
  expect(first.entries.every(entry => entry.kind === "thinking" && entry.streaming)).toBe(true);
  const completed = projectTimeline([emptyThinking("answer")], first);
  expect(completed.entries).toHaveLength(1);
  expect(completed.entries[0]).toMatchObject({ kind: "thinking", text: "", streaming: false });
});

test("keeps the trace key when earlier empty history is loaded and clears it on replacement", () => {
  const first = projectTimeline([emptyThinking("later")]);
  const loaded = projectTimeline([emptyThinking("earlier"), emptyThinking("later")], first);
  expect(loaded.entries.map(entry => entry.key)).toEqual(first.entries.map(entry => entry.key));
  expect(projectTimeline([], loaded).entries).toEqual([]);
});

test("retains readable thinking alongside the merged empty trace", () => {
  const readable = item({ ...answer("readable", ""), blocks: [{ type: "thinking", text: "**First step**\nReasoning." }] });
  const first = projectTimeline([readable]);
  const view = projectTimeline([emptyThinking("empty"), readable, emptyThinking("later")], first);
  expect(view.entries).toHaveLength(2);
  expect(view.entries.find(entry => entry.key === first.entries[0]!.key)).toMatchObject({ kind: "thinking", text: "**First step**\nReasoning." });
});

test.each([false, true])("moves a gap past deduplicated empty thinking to the next visible body (same message: %s)", sameMessage => {
  const body = item(answer("body", "Visible body"));
  const duplicate = sameMessage
    ? item({ ...answer("duplicate", ""), blocks: [{ type: "thinking", text: "" }, { type: "text", text: "Visible body" }] })
    : emptyThinking("duplicate");
  const items = [emptyThinking("first"), duplicate, ...(sameMessage ? [] : [body])];
  const view = projectTimeline(items);
  expect(projectTimelineGaps(items, new Set(["duplicate"]))).toEqual({ keys: new Set([view.entries[1]!.key]), toolBreakKeys: new Set(), atEnd: false });
  expect(projectTimelineGaps(items, new Set(["first"]))).toEqual({ keys: new Set([view.entries[0]!.key]), toolBreakKeys: new Set(), atEnd: false });
});

test("keeps a trailing gap after a deduplicated empty thinking message", () => {
  expect(projectTimelineGaps([emptyThinking("first"), emptyThinking("duplicate")], new Set(["duplicate"])))
    .toEqual({ keys: new Set(), toolBreakKeys: new Set(), atEnd: true });
});

test.each(["body", "tool"])("anchors a prepended gap before retained %s rather than the moved trace", kind => {
  const middle = kind === "body" ? item(answer("body", "Visible body")) : item(tool("middle", 2));
  const initial = projectTimeline([middle, emptyThinking("later")]);
  const items = [emptyThinking("earlier"), middle, emptyThinking("later")];
  const loaded = projectTimeline(items, initial);
  expect(loaded.entries.map(entry => entry.key)).toEqual(initial.entries.map(entry => entry.key));
  const gaps = projectTimelineGaps(items, new Set(["earlier"]), loaded.entries);
  expect(gaps).toEqual({ keys: new Set([initial.entries[0]!.key]), toolBreakKeys: new Set(), atEnd: false });
});

test("splits retained adjacent tools at a real gap despite reversed completion order", () => {
  const initial = projectTimeline([item(partial("a")), item(partial("b")), emptyThinking("later")]);
  const items = [emptyThinking("earlier"), item(tool("b", 2)), item(tool("a", 3)), emptyThinking("later")];
  const loaded = projectTimeline(items, initial);
  const gaps = projectTimelineGaps(items, new Set(["earlier", "event-a"]), loaded.entries);
  expect(gaps.keys).toEqual(new Set([initial.entries[0]!.key, initial.entries[1]!.key]));
  expect(toolSegments(loaded.entries, new Set([...gaps.keys, ...gaps.toolBreakKeys]), observeTools(loaded.entries, new Map())).map(segment => segment.tools.length)).toEqual([1, 1]);
  const separated = projectTimelineGaps(items, new Set(["event-b"]), loaded.entries);
  expect(separated.keys).toEqual(new Set([initial.entries[0]!.key]));
});

test("splits retained adjacent tools at a single real gap despite reversed completion order", () => {
  const initial = projectTimeline([item(partial("a")), item(partial("b")), emptyThinking("later")]);
  const items = [emptyThinking("earlier"), item(tool("b", 2)), item(tool("a", 3)), emptyThinking("later")];
  const loaded = projectTimeline(items, initial);
  const gaps = projectTimelineGaps(items, new Set(["event-a"]), loaded.entries);
  expect(loaded.entries.map(entry => entry.key)).toEqual(initial.entries.map(entry => entry.key));
  expect(gaps.keys).toEqual(new Set([initial.entries[0]!.key]));
  expect(gaps.toolBreakKeys).toEqual(new Set([initial.entries[1]!.key]));
  expect(gaps.atEnd).toBe(false);
  const breaks = new Set([...gaps.keys, ...gaps.toolBreakKeys]);
  expect(toolSegments(loaded.entries, breaks, observeTools(loaded.entries, new Map())).map(segment => segment.tools.length)).toEqual([1, 1]);
});

test("moves invisible run_end gaps past duplicate traces and preserves trailing gaps", () => {
  const end = item({ ...base, event_id: "end", timestamp: 3, kind: "run_end", status: "complete" });
  const items = [emptyThinking("first"), end, emptyThinking("duplicate"), item(tool("next", 4))];
  const view = projectTimeline(items);
  expect(projectTimelineGaps(items, new Set(["end"]), view.entries)).toEqual({ keys: new Set([view.entries.at(-1)!.key]), toolBreakKeys: new Set(), atEnd: false });
  const trailing = items.slice(0, -1);
  expect(projectTimelineGaps(trailing, new Set(["end"]), projectTimeline(trailing).entries)).toEqual({ keys: new Set(), toolBreakKeys: new Set(), atEnd: true });
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
