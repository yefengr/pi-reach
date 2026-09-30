import { describe, expect, test } from "vitest";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { runCompletions } from "./run-completion";

const base = { session_id: "session-1", leaf_id: "leaf-1" };

function user(id: string, group: string, timestamp: number, seq?: number): TimelineEvent {
  return { ...base, event_id: id, message_id: id, group_id: group, timestamp, kind: "user", blocks: [{ type: "text", text: id }], origin: "unknown", delivery: "normal", status: "committed", ...(seq === undefined ? {} : { event_seq: seq }) };
}

function assistant(id: string, group: string, timestamp: number, seq?: number): TimelineEvent {
  return { ...base, event_id: id, group_id: group, timestamp, kind: "assistant", blocks: [{ type: "text", text: id }], status: "complete", ...(seq === undefined ? {} : { event_seq: seq }) };
}

function runEnd(id: string, group: string, timestamp: number, status: "complete" | "interrupted" | "error" = "complete", seq?: number): TimelineEvent {
  return { ...base, event_id: id, group_id: group, timestamp, kind: "run_end", status, ...(seq === undefined ? {} : { event_seq: seq }) };
}

describe("runCompletions", () => {
  test.each(["complete", "interrupted", "error"] as const)("takes time and %s status only from run_end", (status) => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 9), runEnd("r1", "g1", 5, status)]);
    expect(result.get("g1")).toEqual({ timestamp: 5, status });
  });

  test("keeps a run open when it has no run_end", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 2)]);
    expect(result.has("g1")).toBe(false);
  });

  test("does not infer completion from a later formal run", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 3), user("u2", "g2", 4), runEnd("r2", "g2", 5)]);
    expect(result.has("g1")).toBe(false);
    expect(result.get("g2")).toEqual({ timestamp: 5, status: "complete" });
  });

  test("orders explicit endings by event_seq and ignores ungrouped system events", () => {
    const system: TimelineEvent = { ...base, event_id: "s1", timestamp: 9, kind: "compaction", payload: "summary", truncated: false, event_seq: 3 };
    const result = runCompletions([runEnd("r2", "g1", 5, "error", 6), assistant("a2", "g2", 6, 4), system, user("u1", "g1", 1, 1), runEnd("r1", "g1", 2, "complete", 2)]);
    expect(result.get("g1")).toEqual({ timestamp: 5, status: "error" });
    expect(result.has("g2")).toBe(false);
    expect(result.size).toBe(1);
  });

  test("ignores a run_end whose group has no other formal events", () => {
    const result = runCompletions([runEnd("r0", "g0", 1), user("u1", "g1", 2)]);
    expect(result.has("g0")).toBe(false);
    expect(result.has("g1")).toBe(false);
  });

  test("recognizes run_end before the other formal event of its group", () => {
    const result = runCompletions([runEnd("r1", "g1", 1), assistant("a1", "g1", 2)]);
    expect(result.get("g1")).toEqual({ timestamp: 1, status: "complete" });
  });
});
