import { expect, test } from "vitest";
import { actionReply, currentRunGroup, observeNewSession, stopHasEnded, type PendingSessionAction, type PendingStop } from "./operation-feedback";
import type { TimelineViewItem } from "./timeline-runtime";

const fresh = (): PendingSessionAction => ({ id: "request", sessionId: "source", action: "session_new", phase: "pending", startedAt: 1, projection: [] });
const result = { protocol_version: 2 as const, type: "action_ok" as const, target_channel_id: "channel", in_reply_to: "request", action: "session_new" as const, session_id: "target" };

test.each(["result-first", "ready-first"])("new session joins target ready, data and result: %s", (order) => {
  let pending: PendingSessionAction | null = fresh();
  if (order === "result-first") pending = actionReply(pending, result);
  pending = observeNewSession(pending, "target", false);
  expect(pending).not.toBeNull();
  pending = observeNewSession(pending, "target", true);
  if (order === "ready-first") {
    expect(pending).not.toBeNull();
    pending = actionReply(pending, result);
  }
  expect(pending).toBeNull();
});

test("unrelated ready cannot confirm creation even with first-page data", () => {
  const pending = observeNewSession(fresh(), "other", true);
  expect(actionReply(pending, result)).toMatchObject({ targetSessionId: "target", readySessionId: "other" });
});

test("creation confirmation alone does not imply that target data is ready", () => {
  const pending = actionReply(fresh(), result);
  expect(observeNewSession(pending, "target", false)).toMatchObject({ phase: "accepted" });
});

test("mismatched id or action cannot settle a pending operation", () => {
  const pending = fresh();
  expect(actionReply(pending, { ...result, in_reply_to: "old" })).toBe(pending);
  expect(actionReply(pending, { ...result, action: "thinking_set", thinking_level: "max" })).toBe(pending);
});

test("accepted compact stays pending until its own final result", () => {
  const pending: PendingSessionAction = { ...fresh(), action: "session_compact" };
  const accepted = { ...result, action: "session_compact" as const, phase: "accepted" as const };
  const waiting = actionReply(pending, accepted);
  expect(waiting).toMatchObject({ phase: "accepted" });
  expect(actionReply(waiting, { ...accepted, in_reply_to: "old", phase: "completed" })).toBe(waiting);
  expect(actionReply(waiting, { ...accepted, phase: "completed" })).toBeNull();
  expect(actionReply(waiting, { ...accepted, phase: "cancelled" })).toBeNull();
});

test("correlated errors settle unknown operations, without inventing rollback state", () => {
  const pending: PendingSessionAction = { ...fresh(), phase: "unknown" };
  expect(actionReply(pending, { ...result, type: "action_error", error: "safe" })).toBeNull();
});

test("scope cancellation makes duplicate and late replies inert", () => {
  expect(actionReply(null, result)).toBeNull();
  expect(observeNewSession(null, "target", true)).toBeNull();
});

function runItem(group: string, end = false): TimelineViewItem {
  const event = { event_id: `${group}-${end}`, event_seq: end ? 2 : 1, session_id: "session", leaf_id: "leaf", group_id: group, timestamp: 1 };
  return { kind: "event", event: end ? { ...event, kind: "run_end", status: "complete" } : { ...event, kind: "assistant", status: "complete", blocks: [{ type: "text", text: "output" }] } };
}
const stop: PendingStop = { id: "stop", groupId: "first", sessionId: "session", leafId: "leaf", startedAt: 1, unknown: false };

test("only the current unfinished group can be stopped", () => {
  expect(currentRunGroup([])).toBeNull();
  expect(currentRunGroup([runItem("first")])).toBe("first");
  expect(currentRunGroup([runItem("first"), runItem("first", true)])).toBeNull();
  expect(currentRunGroup([runItem("first", true), runItem("second")])).toBe("second");
});

test("formal run_end closes only the stop target, even when another group has begun", () => {
  expect(stopHasEnded(stop, [runItem("other", true)])).toBe(false);
  expect(stopHasEnded(stop, [runItem("first", true), runItem("second")])).toBe(true);
  const different = runItem("first", true);
  if (different.kind === "event") different.event.session_id = "different";
  expect(stopHasEnded(stop, [different])).toBe(false);
});
