import { describe, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TimelineRuntime } from "./runtime.js";
import { TimelineV2Service } from "./v2_service.js";

function setup() {
  const session = SessionManager.inMemory(process.cwd());
  const runtime = new TimelineRuntime();
  const abort = vi.fn(() => true);
  const service = new TimelineV2Service({ sessionManager: session, runtime, senderRef: "owner", extensionVersion: "test", onUserMessage: () => true, onCancel: abort });
  service.handle({ protocol_version: 2, type: "session_hello", channel_id: "channel", id: "hello" });
  const cancel = (groupId: string) => service.handle({ protocol_version: 2, type: "cancel", id: "cancel", channel_id: "channel", session_id: session.getSessionId(), leaf_id: session.getLeafId(), group_id: groupId });
  const start = () => {
    runtime.onAgentStart();
    runtime.onMessageStart({ role: "user", content: "run", timestamp: 1 }, session);
    return runtime.currentGroupId!;
  };
  return { session, runtime, service, abort, cancel, start };
}

describe("cancel targets a single active run", () => {
  test("idle rejects cancellation without invoking abort", () => {
    const state = setup();
    expect(state.cancel("past")[0]).toMatchObject({ type: "protocol_error", in_reply_to: "cancel", code: "invalid_message" });
    expect(state.abort).not.toHaveBeenCalled();
  });
  test("wrong group is rejected and the correct group is only acknowledged", () => {
    const state = setup();
    const group = state.start();
    expect(state.cancel("other")[0]).toMatchObject({ type: "protocol_error", code: "invalid_message" });
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.cancel(group)[0]).toMatchObject({ type: "cancelled", in_reply_to: "cancel" });
    expect(state.abort).toHaveBeenCalledTimes(1);
    expect(state.runtime.currentGroupId).toBe(group);
    expect(state.runtime.getPublishedEvents().some((event) => event.kind === "run_end")).toBe(false);
  });
  test("late cancellation cannot abort the following run", () => {
    const state = setup();
    const first = state.start();
    state.runtime.onAgentEnd([]);
    const next = state.start();
    expect(next).not.toBe(first);
    expect(state.cancel(first)[0]).toMatchObject({ type: "protocol_error", code: "invalid_message" });
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.cancel(next)[0]).toMatchObject({ type: "cancelled" });
    expect(state.abort).toHaveBeenCalledTimes(1);
  });
});
