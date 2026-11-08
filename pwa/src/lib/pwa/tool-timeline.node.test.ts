import { expect, test } from "vitest";
import { decodeServerFrameV2, encodeServerFrameV2 } from "../pi-reach/protocol-v2/codec";
import type { ServerFrame, TimelineEvent } from "@pi-reach/protocol/session";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import { TOOL_MIN_RUNNING_MS } from "./stream-structure-gate";
import { projectTimeline } from "./timeline-presentation";
import { preserveToolInline, hasCompleteToolInline } from "./tool-details-inline";
import { mergeTimelineRecords } from "./timeline-store";
import type { PwaTimelineEventRecord } from "./db";
import { toolContentBlocks, toolHeaderSummary, toolReaderArguments } from "@/components/pwa/tool-presentation";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "generation", selfSenderRef: "self", channelId: "channel" };
const base = { session_id: "session", leaf_id: "generation", group_id: "group", kind: "tool" as const, tool_call_id: "call", tool: "read", representation: "summary" as const, summary: { action: "read" as const, path: "synthetic.txt", offset: 2, limit: 3 }, tool_ref: { call_entry_id: "entry-a", tool_call_id: "call" } };
const partial = (entry = "entry-a"): Extract<ServerFrame, { type: "timeline_partial" }> => ({ ...base, tool_ref: { ...base.tool_ref, call_entry_id: entry }, partial_id: `tool:${entry}`, protocol_version: 2, type: "timeline_partial", status: "running", target_channel_id: "channel" });
const event: TimelineEvent = { ...base, event_id: "tool-result", timestamp: 2, event_seq: 2, status: "complete" };
function receive(runtime: TimelineRuntime, frame: ServerFrame) { return runtime.receive(decodeServerFrameV2(encodeServerFrameV2(frame))); }

test("summary wire reaches PWA without inline arguments or result and settles independently", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const buffer = new StreamDisplayBuffer();
  buffer.ingest(receive(runtime, partial()).items);
  buffer.ingest(receive(runtime, partial("entry-b")).items);
  buffer.ingest(receive(runtime, { protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "generation", target_channel_id: "channel", event }).items);
  const settled = buffer.advance(TOOL_MIN_RUNNING_MS).items;
  expect(settled.filter(item => item.kind === "partial")).toEqual([expect.objectContaining({ partial: expect.objectContaining({ tool_ref: { call_entry_id: "entry-b", tool_call_id: "call" } }) })]);
  expect(settled).toContainEqual({ kind: "event", event });
  expect(event).not.toHaveProperty("args"); expect(event).not.toHaveProperty("result");
});
test("native entry participates in display identity; ordinary leaf advancement does not", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const before = projectTimeline(receive(runtime, partial()).items);
  const after = projectTimeline(receive(runtime, { protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "descendant", target_channel_id: "channel", event: { ...event, leaf_id: "descendant" } }).items, before);
  expect(after.entries[0].key).toBe(before.entries[0].key);
  const parallel = projectTimeline([{ kind: "partial", createdAt: 0, partial: partial() }, { kind: "partial", createdAt: 0, partial: partial("entry-b") }]);
  expect(new Set(parallel.entries.map(entry => entry.key)).size).toBe(2);
});
test("summary presentation shows bounded descriptors without inventing empty args", () => {
  expect(toolHeaderSummary(event)).toBe("synthetic.txt · L2–4");
  expect(toolReaderArguments(event)).toBeUndefined();
  expect(toolContentBlocks(event)).toEqual([expect.objectContaining({ style: "notice" })]);
  expect(JSON.stringify(toolContentBlocks(event))).not.toContain("{}");
});
test("new summary preserves a complete legacy inline event in runtime and saved merges", () => {
  const inline: TimelineEvent = { event_id: event.event_id, timestamp: 2, event_seq: 2, session_id: "session", leaf_id: "generation", group_id: "group", kind: "tool", tool_call_id: "call", tool: "read", args: { path: "synthetic.txt" }, status: "complete", result: "SYNTHETIC_SAVED_RESULT", truncated: false };
  expect(hasCompleteToolInline(inline)).toBe(true);
  expect(preserveToolInline(inline, event)).toHaveProperty("result", "SYNTHETIC_SAVED_RESULT");
  const runtime = new TimelineRuntime(); runtime.setScope(scope); runtime.commit(inline);
  expect(runtime.commit(event).items).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ result: "SYNTHETIC_SAVED_RESULT" }) }));
  const record = (value: TimelineEvent): PwaTimelineEventRecord => ({ id: "record", eventId: value.event_id, eventSeq: value.event_seq, deviceId: "device", endpointId: "endpoint", sessionId: "session", leafId: "generation", timestamp: 2, event: value });
  expect(mergeTimelineRecords([record(inline)], [record(event)])[0].event).toHaveProperty("result", "SYNTHETIC_SAVED_RESULT");
  expect(hasCompleteToolInline({ ...inline, truncated: true })).toBe(false);
  expect(hasCompleteToolInline({ ...inline, result: [{ type: "image", omitted: true }] })).toBe(false);
  expect(preserveToolInline({ ...inline, truncated: true }, event)).toBe(event);
});
test("complete legacy JSON with many small values is preserved without a scan cutoff", () => {
  const inline: TimelineEvent = {
    event_id: event.event_id, timestamp: 2, event_seq: 2, session_id: "session", leaf_id: "generation", group_id: "group",
    kind: "tool", tool_call_id: "call", tool: "read", status: "complete", truncated: false,
    args: { values: Array.from({ length: 60 }, () => Array.from({ length: 2000 }, (_, index) => index)) },
    result: [{ type: "text", text: "SYNTHETIC_SAVED_ORIGINAL" }],
  };
  expect(hasCompleteToolInline(inline)).toBe(true);
  const preserved = preserveToolInline(inline, { ...event, leaf_id: "descendant", event_seq: 3 });
  expect(preserved).not.toHaveProperty("representation");
  expect("args" in preserved ? preserved.args : null).toBe(inline.args);
  expect(preserved).toHaveProperty("result", inline.result);
  expect(preserved.leaf_id).toBe("descendant");
  expect(preserved.event_seq).toBe(3);
});
