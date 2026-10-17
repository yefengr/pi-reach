import { describe, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TimelineRequestScope } from "./request_scope.js";

function append(session: SessionManager, content = "message") {
  return session.appendMessage({ role: "user", content, timestamp: 1 });
}

describe("TimelineRequestScope", () => {
  test("accepts only current-branch ancestors at or after each channel's hello", () => {
    const session = SessionManager.inMemory(process.cwd());
    const beforeHello = append(session);
    const baseline = session.appendModelChange("test", "model-1");
    const scope = new TimelineRequestScope(session);
    scope.hello("first");
    const thinking = session.appendThinkingLevelChange("high");
    scope.hello("second");
    const current = append(session);

    for (const leafId of [baseline, thinking, current]) {
      expect(scope.invalidReason("first", { leafId })).toBeNull();
    }
    for (const leafId of [null, "unknown", beforeHello]) {
      expect(scope.invalidReason("first", { leafId })).toBe("branch_changed");
    }
    expect(scope.invalidReason("second", { leafId: baseline })).toBe("branch_changed");
    expect(scope.invalidReason("second", { leafId: thinking })).toBeNull();
  });

  test("does not collect branch history and only walks entries appended after hello", () => {
    const session = SessionManager.inMemory(process.cwd());
    append(session, "old history");
    const baseline = append(session, "hello boundary");
    const scope = new TimelineRequestScope(session);
    scope.hello("channel");
    const getBranch = vi.spyOn(session, "getBranch");
    const getEntry = vi.spyOn(session, "getEntry");
    try {
      expect(scope.invalidReason("channel", { leafId: baseline })).toBeNull();
      expect(scope.invalidReason("channel", { leafId: "unknown" })).toBe("branch_changed");
      expect(getEntry).not.toHaveBeenCalled();
      const model = session.appendModelChange("test", "new-model");
      const thinking = session.appendThinkingLevelChange("high");
      expect(scope.invalidReason("channel", { leafId: baseline })).toBeNull();
      expect(getEntry.mock.calls).toEqual([[thinking], [model]]);
      expect(getBranch).not.toHaveBeenCalled();
    } finally {
      getBranch.mockRestore();
      getEntry.mockRestore();
    }
  });

  test("rejects sibling leaves and a baseline no longer on the current branch", () => {
    const session = SessionManager.inMemory(process.cwd());
    const root = append(session);
    const sibling = append(session);
    session.branch(root);
    const baseline = append(session);
    const scope = new TimelineRequestScope(session);
    scope.hello("channel");
    expect(scope.invalidReason("channel", { leafId: sibling })).toBe("branch_changed");

    session.branch(sibling);
    expect(scope.invalidReason("channel", { leafId: sibling })).toBe("branch_changed");
    expect(scope.invalidReason("channel", { leafId: baseline })).toBe("branch_changed");
    session.resetLeaf();
    expect(scope.invalidReason("channel", { leafId: null })).toBe("branch_changed");
  });

  test("accepts null only for a hello on the empty branch, including later appends", () => {
    const session = SessionManager.inMemory(process.cwd());
    const scope = new TimelineRequestScope(session);
    scope.hello("empty");
    expect(scope.invalidReason("empty", { leafId: null })).toBeNull();
    const model = session.appendModelChange("test", "model-1");
    session.appendThinkingLevelChange("high");
    expect(scope.invalidReason("empty", { leafId: null })).toBeNull();
    expect(scope.invalidReason("empty", { leafId: model })).toBeNull();
    scope.hello("nonempty");
    expect(scope.invalidReason("nonempty", { leafId: null })).toBe("branch_changed");
  });

  test("invalidates all channels even when a switch away and back restores the same leaf", () => {
    const session = SessionManager.inMemory(process.cwd());
    const baseline = append(session);
    const scope = new TimelineRequestScope(session);
    scope.hello("first");
    scope.hello("second");
    session.resetLeaf();
    session.branch(baseline);
    scope.invalidate();
    for (const channel of ["first", "second"]) {
      expect(scope.invalidReason(channel, { leafId: baseline })).toBe("branch_changed");
    }
    scope.hello("first");
    expect(scope.invalidReason("first", { leafId: baseline })).toBeNull();
    expect(scope.invalidReason("second", { leafId: baseline })).toBe("branch_changed");
  });

  test("checks session identity before leaf or invalidation and requires a new hello", () => {
    const session = SessionManager.inMemory(process.cwd());
    const baseline = append(session);
    const scope = new TimelineRequestScope(session);
    scope.hello("channel");
    expect(scope.invalidReason("channel", { sessionId: "other", leafId: "unknown" })).toBe("session_replaced");
    const oldSession = session.getSessionId();
    session.newSession();
    scope.invalidate();
    expect(scope.invalidReason("channel", { leafId: baseline })).toBe("session_replaced");
    scope.hello("channel");
    expect(scope.invalidReason("channel", { sessionId: oldSession, leafId: baseline })).toBe("session_replaced");
    expect(scope.invalidReason("channel", { sessionId: session.getSessionId(), leafId: null })).toBeNull();
  });
});
