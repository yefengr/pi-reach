import { expect, test, vi } from "vitest";
import { TimelineRuntime, type TimelineScope, type TimelineViewItem } from "./timeline-runtime";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import { projectTimeline, type PresentationSnapshot } from "./timeline-presentation";
import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";

const scope: TimelineScope = { deviceId: "d", endpointId: "e", runtimeInstanceId: "r", sessionId: "s", leafId: "h", selfSenderRef: "self", channelId: "c" };
const base = { session_id: "s", leaf_id: "h", group_id: "run" };
function answer(id: string, seq: number, text = id): TimelineEvent {
  return { ...base, event_id: id, event_seq: seq, timestamp: 10_000 - seq, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] };
}
function partial(id: string, text: string, index = 0): TimelinePartial {
  return { ...base, protocol_version: 2, type: "timeline_partial", partial_id: `${id}:assistant:${index}`, kind: "assistant", status: "delta", delta: text };
}
function tool(id: string): TimelinePartial {
  return { ...base, protocol_version: 2, type: "timeline_partial", partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "read", status: "running", args: { path: id } };
}
function completedTool(id: string, seq: number): TimelineEvent {
  return { ...base, event_id: `event:${id}`, event_seq: seq, timestamp: 10_000 - seq, kind: "tool", tool_call_id: id, tool: "read", status: "complete", args: { path: id }, truncated: false, result: "ok" };
}
function setup() {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const buffer = new StreamDisplayBuffer();
  let view: PresentationSnapshot = projectTimeline([]);
  const render = (items: TimelineViewItem[]) => { view = projectTimeline(items, view); return view; };
  return { runtime, buffer, view: () => view,
    ingest: (items: TimelineViewItem[]) => render(buffer.ingest(items).items),
    tick: () => render(buffer.advance().items),
  };
}
const labels = (view: PresentationSnapshot) => view.entries.map(entry => entry.kind === "text" ? entry.text : entry.kind === "tool" ? entry.value.tool_call_id : entry.kind);

test("same-run replies never hide earlier messages or restart after catching up", () => {
  const h = setup();
  h.ingest(h.runtime.commit(answer("A", 1)).items);
  h.ingest(h.runtime.commit(completedTool("tool", 2)).items);
  const first = h.ingest(h.runtime.receive(partial("B", "After the tool")).items);
  expect(labels(first)).toEqual(["A", "tool", "Af"]);
  while (h.buffer.hasPending()) h.tick();
  expect(labels(h.view())).toEqual(["A", "tool", "After the tool"]);
  h.ingest(h.runtime.receive(partial("B", " continued")).items);
  expect(labels(h.view())[2]).toBe("After the tool");
  const settled = h.ingest(h.runtime.commit(answer("B", 3, "After the tool continued")).items);
  expect(labels(settled)).toEqual(["A", "tool", "After the tool continued"]);
  expect(settled.entries.filter(entry => entry.kind === "text").every(entry => !entry.streaming)).toBe(true);
  expect(h.buffer.hasPending()).toBe(false);
});

test.each(["assistant", "provider_error"] as const)("a late %s completion clears only its source message and rejects late deltas", kind => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.receive(partial("A", "First"));
  runtime.receive(partial("B", "Next"));
  const event: TimelineEvent = kind === "assistant" ? answer("A", 1) : { ...base, kind, event_id: "A", event_seq: 1, timestamp: 1, message: "failed" };
  const changed = runtime.commit(event);
  expect(changed.items.filter(item => item.kind === "partial").map(item => item.partial.partial_id)).toEqual(["B:assistant:0"]);
  const late = runtime.receive(partial("A", " stale"));
  expect(late.items.filter(item => item.kind === "partial").map(item => item.partial.partial_id)).toEqual(["B:assistant:0"]);
});

test("reverse parallel completion, later replies and earlier history preserve observed positions", () => {
  const h = setup();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1);
  try {
    h.ingest(h.runtime.commit(answer("A", 2)).items);
    h.ingest(h.runtime.receive(tool("z-first")).items);
    h.ingest(h.runtime.receive(tool("a-second")).items);
    expect(labels(h.view())).toEqual(["A", "z-first", "a-second"]);
    h.ingest(h.runtime.commit(completedTool("a-second", 3)).items);
    h.ingest(h.runtime.commit(completedTool("z-first", 4)).items);
    h.ingest(h.runtime.receive(partial("B", "B")).items);
    h.ingest(h.runtime.commit(answer("B", 5)).items);
    h.ingest(h.runtime.prependHistory([answer("history", 1)]).items);
    expect(labels(h.view())).toEqual(["history", "A", "z-first", "a-second", "B"]);
  } finally { clock.mockRestore(); }
});

test("display buffer preserves authoritative sequence despite reversed host timestamps", () => {
  const h = setup();
  const items = h.runtime.prependHistory([answer("B", 2), answer("A", 1)]).items;
  expect(labels(h.ingest(items))).toEqual(["A", "B"]);
});

test.each(["opaque", "A:thinking:0", "A:assistant:9007199254740992"])("unidentifiable partial %s never leaves a stuck row or rejects the formal message", partialId => {
  const h = setup();
  const malformed = { ...partial("A", "unfinished"), partial_id: partialId };
  expect(h.ingest(h.runtime.receive(malformed).items).entries).toEqual([]);
  h.ingest(h.runtime.commit(answer("A", 1, "Complete answer")).items);
  expect(labels(h.ingest(h.runtime.receive(malformed).items))).toEqual(["Complete answer"]);
  expect(h.buffer.hasPending()).toBe(false);
});

test("a formal event flushes all of its blocks but leaves the next message streaming", () => {
  const h = setup();
  h.ingest(h.runtime.receive(partial("A", "first long block")).items);
  h.ingest(h.runtime.receive(partial("A", "second long block", 1)).items);
  h.ingest(h.runtime.receive(partial("B", "next long reply")).items);
  const event = answer("A", 1);
  if (event.kind !== "assistant") throw new Error("invalid fixture");
  event.blocks = [{ type: "text", text: "first long block" }, { type: "text", text: "second long block" }];
  const changed = h.ingest(h.runtime.commit(event).items);
  expect(changed.entries.slice(0, 2)).toMatchObject([{ text: "first long block", streaming: false }, { text: "second long block", streaming: false }]);
  expect(changed.entries[2]).toMatchObject({ kind: "text", streaming: true });
});
