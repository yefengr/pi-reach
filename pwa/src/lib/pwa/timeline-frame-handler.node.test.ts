import { beforeEach, expect, test, vi } from "vitest";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import { receiveTimelineFrame } from "./timeline-frame-handler";
import { mergeTimelineEvents, TimelineStoreConflictError } from "./timeline-store";
import type { TimelineEventFragmentAssembler } from "./timeline-transfer";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";

vi.mock("./timeline-store", () => ({
  mergeTimelineEvents: vi.fn(async () => {}),
  TimelineStoreConflictError: class extends Error {},
}));
beforeEach(() => vi.clearAllMocks());
const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "generation", channelId: "channel", selfSenderRef: "self" };
const event: TimelineEvent = { event_id: "event", event_seq: 10, session_id: "session", leaf_id: "generation", timestamp: 1, group_id: "group", kind: "assistant", status: "complete", blocks: [{ type: "text", text: "output" }] };
function harness() {
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 10);
  return { runtime, fragmentAssemblerRef: { current: null as TimelineEventFragmentAssembler | null }, applyTimelineChange: vi.fn(), receiveRealtimeOutput: vi.fn(), setError: vi.fn(), setLastSyncedAt: vi.fn() };
}

test("ignores delayed pre-connection formal output without appearing or incrementing unread", async () => {
  const state = harness();
  receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "generation", event }, state);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mergeTimelineEvents).not.toHaveBeenCalled();
  expect(state.receiveRealtimeOutput).not.toHaveBeenCalled();
  expect(state.applyTimelineChange).not.toHaveBeenCalled();
});

test("persists ordinary leaf advancement under the advanced live scope", async () => {
  const state = harness();
  const advanced = { ...event, event_seq: 11, leaf_id: "next-leaf" };
  receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "next-leaf", event: advanced }, state);
  expect(state.runtime.currentScope?.leafId).toBe("next-leaf");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mergeTimelineEvents).toHaveBeenCalledWith({ ...scope, leafId: "next-leaf" }, [advanced]);
  expect(state.applyTimelineChange.mock.calls.at(-1)?.[0].items).toContainEqual(expect.objectContaining({ kind: "event", event: advanced }));
});

test("a complete stale-leaf fragment is ignored without moving the current tip backward", async () => {
  const state = harness();
  const advanced = { ...event, event_id: "advanced", event_seq: 11, leaf_id: "next-leaf" };
  receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "next-leaf", event: advanced }, state);

  const stale = { ...event, event_id: "stale", event_seq: 10 };
  receiveTimelineFrame({
    protocol_version: 2,
    type: "timeline_event_fragment",
    session_id: stale.session_id,
    leaf_id: stale.leaf_id,
    event_id: stale.event_id,
    index: 0,
    data_base64: Buffer.from(JSON.stringify(stale)).toString("base64"),
    final: true,
  }, state);
  for (let index = 0; index < 5; index += 1) await Promise.resolve();

  expect(state.runtime.currentScope?.leafId).toBe("next-leaf");
  expect(vi.mocked(mergeTimelineEvents).mock.calls.at(-1)?.[1]).toEqual([advanced]);
});

test("serializes same-ID revisions and keeps runtime and persistence on the latest content", async () => {
  const state = harness();
  const original = { ...event, event_seq: 11 };
  const revised = { ...original, blocks: [{ type: "text" as const, text: "revised" }] };
  const frame = (value: TimelineEvent) => ({ protocol_version: 2 as const, type: "timeline_event" as const, session_id: value.session_id, leaf_id: value.leaf_id, event: value });

  receiveTimelineFrame(frame(original), state);
  receiveTimelineFrame(frame(revised), state);
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  expect(state.applyTimelineChange.mock.calls.at(-1)?.[0].items).toContainEqual(expect.objectContaining({ kind: "event", event: revised }));
  expect(vi.mocked(mergeTimelineEvents).mock.calls.map(([, events]) => events[0])).toEqual([original, revised]);
});

test("a duplicate broadcast is reconciled once while new output is displayed", () => {
  const state = harness();
  const frame = { protocol_version: 2 as const, type: "timeline_event" as const, session_id: "session", leaf_id: "generation", event: { ...event, event_seq: 11 } };
  receiveTimelineFrame(frame, state);
  receiveTimelineFrame(frame, state);
  expect(state.receiveRealtimeOutput).toHaveBeenCalledTimes(1);
  expect(state.applyTimelineChange.mock.calls.at(-1)![0].items).toHaveLength(1);
});

test.each([
  [new Error("IndexedDB INTERNAL_TOKEN"), "Could not update local history."],
  [new TimelineStoreConflictError("Conflicting event INTERNAL_TOKEN"), "Local timeline changed unexpectedly."],
])("reports formal persistence failure as local-history: %s", async (failure, message) => {
  const state = harness();
  vi.mocked(mergeTimelineEvents).mockRejectedValueOnce(failure);
  receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "generation", event: { ...event, event_seq: 11 } }, state);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(message, "local-history");
  expect(state.setLastSyncedAt).not.toHaveBeenCalled();
  expect(state.applyTimelineChange).toHaveBeenCalledTimes(1);
});

test("ignores a persistence failure after its channel is replaced", async () => {
  const state = harness();
  vi.mocked(mergeTimelineEvents).mockRejectedValueOnce(new Error("IndexedDB INTERNAL_TOKEN"));
  receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: "session", leaf_id: "generation", event: { ...event, event_seq: 11 } }, { ...state, isCurrent: () => false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(state.setError).not.toHaveBeenCalled();
});

test.each([
  ["invalid_channel", "This session is out of date. Reconnect and try again."],
  ["reset_required", "This session is out of date. Reconnect and try again."],
  ["invalid_leaf", "This session is out of date. Reconnect and try again."],
  ["too_large", "This message is too large to send."],
  ["unsupported_type", "This operation is not supported. Update Pi and try again."],
  ["invalid_message", "Pi rejected this message. Check it and try again."],
  ["internal_error", "Pi could not process this request. Try again."],
] as const)("reports protocol code %s without forwarding remote message text", (code, message) => {
  const state = harness();
  receiveTimelineFrame({ protocol_version: 2, type: "protocol_error", target_channel_id: "channel", code, message: "Could not load earlier history." }, state);
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(message, "protocol");
  expect(state.applyTimelineChange).toHaveBeenCalledTimes(1);
});

test("foreign sessions cannot affect persistence, display or unread counts", () => {
  const state = harness();
  receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: "other-session", leaf_id: "other", event: { ...event, session_id: "other-session", leaf_id: "other" } }, state);
  expect(mergeTimelineEvents).not.toHaveBeenCalled();
  expect(state.applyTimelineChange).not.toHaveBeenCalled();
  expect(state.receiveRealtimeOutput).not.toHaveBeenCalled();
});
