import { describe, expect, test } from "vitest";
import type { PresentationEntry, ThinkingEntry, ToolEntry } from "@/lib/pwa/timeline-presentation";
import { effectiveProcessStatus, effectiveToolStatus, observeProcessEntries, timelineActivity } from "./timeline-activity";

const scope = { session_id: "s", leaf_id: "l", group_id: "g" };
const thought = (key: string, streaming = true, groupId = "g"): ThinkingEntry => ({ kind: "thinking", key, groupId, text: key, streaming });
const tool = (key: string, group = "g"): ToolEntry => ({ kind: "tool", key, value: {
  ...scope, group_id: group, protocol_version: 2, type: "timeline_partial", kind: "tool", partial_id: key,
  tool_call_id: key, tool: "bash", args: { command: key }, status: "running",
} });
const text = (key: string, groupId = "g"): PresentationEntry => ({ kind: "text", key, groupId, text: key, streaming: false, interrupted: false });
const pending = (queued = false): PresentationEntry => ({ kind: "record", key: "send", item: {
  kind: "pending", id: "send", clientRequestId: "send", requestId: "send", text: "next", createdAt: 3, delivery: "pending", queued,
} });
const status = (entry: ThinkingEntry | ToolEntry, entries: readonly PresentationEntry[], live = true, running = true, ended = false) =>
  effectiveProcessStatus(entry, entries, timelineActivity(entries, live, running, () => ended));

describe("timeline activity migration", () => {
  test("first observation is stable across output updates and history prepends", () => {
    const a = thought("a");
    const b = tool("b");
    const first = observeProcessEntries([a, text("body"), b], new Map());
    expect([...first]).toEqual([["a", 0], ["b", 1]]);
    const next = observeProcessEntries([thought("history", false), { ...a, text: "changed" }, b], first);
    expect([...next]).toEqual([["a", 0], ["b", 1], ["history", 2]]);
    expect(observeProcessEntries([a, b], next)).toBe(next);
    expect([...observeProcessEntries([a, a], new Map([["prior", 20]]))]).toEqual([["prior", 20], ["a", 21]]);
  });

  test.each([text("later"), tool("later"), thought("later"), {
    kind: "record", key: "custom", item: { kind: "event", event: {
      ...scope, kind: "custom", event_id: "custom", timestamp: 1, payload: {}, truncated: false,
    } },
  } satisfies PresentationEntry])("S13 later same-turn Pi output supersedes Thinking ($kind)", later => {
    const a = thought("a");
    const entries = [a, later];
    const activity = timelineActivity(entries, true, true, () => false);
    // 旧 UI 的 currentOutput 保持不变，新组路径单独排除缓冲尾巴。
    expect(activity.currentOutput(a)).toBe(true);
    expect(effectiveProcessStatus(a, entries, activity)).toBe("unknown");
    expect(status(a, [{ ...a, text: "late buffered text" }, later])).toBe("unknown");
  });

  test("S13 later Thinking/text never ends an effective parallel tool", () => {
    const a = tool("a");
    const b = thought("b");
    expect(status(a, [a, b, text("body")])).toBe("running");
    expect(status(b, [a, b, text("body")])).toBe("unknown");
    expect(status(b, [a, b])).toBe("running");
  });

  test("different-turn output and user records are not same-turn Thinking replacement", () => {
    const a = thought("a");
    const user: PresentationEntry = { kind: "record", key: "user", item: { kind: "event", event: {
      ...scope, kind: "user", event_id: "u", message_id: "u", timestamp: 1, blocks: [], origin: "unknown", delivery: "normal", status: "committed",
    } } };
    expect(status(a, [a, thought("other", true, "other")])).toBe("running");
    expect(status(a, [a, user])).toBe("running");
  });

  test("S07/S09 partials stop offline, idle or after run_end; formal Thinking is neutral", () => {
    for (const a of [thought("a"), tool("b")]) {
      expect(status(a, [a], false)).toBe("unknown");
      expect(status(a, [a], true, false)).toBe("unknown");
      expect(status(a, [a], true, true, true)).toBe("unknown");
    }
    const formal = thought("formal", false);
    expect(status(formal, [formal])).toBe("neutral");
  });

  test("S08 old-turn and fresh-send idle residuals stay unknown without disabling Working", () => {
    const a = tool("old", "old");
    const b = thought("old-thought", true, "old");
    const entries = [text("current"), a, b];
    const activity = timelineActivity(entries, true, true, () => false);
    expect(activity.working).toBe(true);
    expect(effectiveProcessStatus(a, entries, activity)).toBe("unknown");
    expect(effectiveProcessStatus(b, entries, activity)).toBe("unknown");
    const fresh = [thought("idle"), pending()];
    const idle = timelineActivity(fresh, true, true, () => false, new Set(["idle"]));
    expect(idle.working).toBe(true);
    expect(effectiveProcessStatus(fresh[0] as ThinkingEntry, fresh, idle)).toBe("unknown");
    const queued = [text("formal"), thought("idle"), pending(true)];
    expect(timelineActivity(queued, true, true, () => true).working).toBe(false);
    expect(timelineActivity(queued, true, true, () => false, new Set(["idle"])).currentOutput(queued[1]!)).toBe(true);
  });

  test.each(["complete", "error", "interrupted"] as const)("formal tool %s is never rewritten by activity", terminal => {
    const a: ToolEntry = { kind: "tool", key: "done", value: {
      ...scope, kind: "tool", event_id: "done", timestamp: 1, tool_call_id: "done", tool: "bash", args: {}, truncated: false,
      ...(terminal === "error" ? { status: terminal, error: "failed" } : terminal === "interrupted" ? { status: terminal } : { status: terminal, result: "ok" }),
    } };
    expect(status(a, [a], false, false, true)).toBe(terminal);
    expect(effectiveToolStatus(a.value, false)).toBe(terminal);
  });
});
