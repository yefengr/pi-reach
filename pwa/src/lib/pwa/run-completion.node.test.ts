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
  test("uses run_end for time and status, even while Pi is running", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 2), runEnd("r1", "g1", 5, "interrupted")], true);
    expect(result.get("g1")).toEqual({ timestamp: 5, status: "interrupted" });
  });

  test("keeps the current run open until run_end arrives", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 2)], true);
    expect(result.has("g1")).toBe(false);
  });

  test("closes a legacy run when a later run appears", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 3), user("u2", "g2", 4)], true);
    expect(result.get("g1")).toEqual({ timestamp: 3 });
    expect(result.has("g2")).toBe(false);
  });

  test("closes the last legacy run at its final event when Pi is not running", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 3)], false);
    expect(result.get("g1")).toEqual({ timestamp: 3 });
  });

  test("orders by event_seq and ignores ungrouped system events", () => {
    const system: TimelineEvent = { ...base, event_id: "s1", timestamp: 9, kind: "compaction", payload: "summary", truncated: false, event_seq: 3 };
    const result = runCompletions([assistant("a2", "g2", 6, 4), system, user("u1", "g1", 1, 1), assistant("a1", "g1", 2, 2)], true);
    expect(result.get("g1")).toEqual({ timestamp: 2 });
    expect(result.has("g2")).toBe(false);
  });

  test("ignores a run_end whose group has no other visible events", () => {
    const result = runCompletions([runEnd("r0", "g0", 1), user("u1", "g1", 2)], true);
    expect(result.has("g0")).toBe(false);
    expect(result.has("g1")).toBe(false);
  });

  test("treats a streaming later turn as the start of a new run", () => {
    const result = runCompletions([user("u1", "g1", 1), assistant("a1", "g1", 3)], true, ["g2"]);
    expect(result.get("g1")).toEqual({ timestamp: 3 });
    expect(result.has("g2")).toBe(false);
  });
});
