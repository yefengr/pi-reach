import { describe, expect, test } from "vitest";
import type { PresentationEntry, ThinkingEntry, ToolEntry } from "@/lib/pwa/timeline-presentation";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import { en } from "@/lib/i18n/messages/en";
import { zh } from "@/lib/i18n/messages/zh";
import { processGroups, withProcessExpansion, type ProcessEntry, type ProcessExpansion, type ProcessGroup } from "./process-groups";
import { observeProcessEntries, timelineActivity } from "./timeline-activity";
import { processGroupState, processGroupSummary, type ProcessStatus } from "./process-group-state";

const scope = { session_id: "s", leaf_id: "l", group_id: "g" };
const tool = (key: string, terminal?: "complete" | "error" | "interrupted", name = "bash", args: NonNullable<ToolEntry["value"]["args"]> = { command: key }): ToolEntry => ({ kind: "tool", key, value: terminal === undefined ? {
  ...scope, protocol_version: 2, type: "timeline_partial", kind: "tool", partial_id: key, tool_call_id: key, tool: name, args, status: "running",
} : {
  ...scope, kind: "tool", event_id: key, timestamp: 100, tool_call_id: key, tool: name, args, truncated: false,
  ...(terminal === "error" ? { status: terminal, error: "failed" } : terminal === "interrupted" ? { status: terminal } : { status: terminal, result: "ok" }),
} });
const thought = (key: string, streaming = true, text = key): ThinkingEntry => ({ kind: "thinking", key, groupId: "g", text, streaming });
const body: PresentationEntry = { kind: "text", key: "body", groupId: "g", text: "answer", streaming: false, interrupted: false };
const group = (...entries: ProcessEntry[]): ProcessGroup => ({ key: "process:test", groupId: "g", entries });
const end: RunCompletion = { status: "complete", timestamp: 200 };
type Options = Partial<Parameters<typeof processGroupState>[1]> & { live?: boolean; running?: boolean };
function state(g: ProcessGroup, options: Options = {}) {
  const entries = options.entries ?? g.entries;
  const activity = options.activity ?? timelineActivity(entries, options.live ?? true, options.running ?? true, id => id === g.groupId && options.completion !== undefined);
  return processGroupState(g, {
    entries, activity, observed: observeProcessEntries(entries, new Map()), choices: new Map(), ...options,
  });
}

describe("process group state transitions", () => {
  test("S01 initial running group is expanded synchronously without writing choices", () => {
    const choices = new Map<string, ProcessExpansion>();
    const a = tool("a");
    expect(state(group(a), { choices })).toMatchObject({ expanded: true, expansionSource: "running", status: "running", activeEntry: a, canHostWorking: true });
    expect(choices.size).toBe(0);
  });

  test("S02 manual collapse survives new calls; manual false also beats reading protection", () => {
    const a = tool("a");
    const choices = withProcessExpansion(new Map(), [a.key], false);
    expect(state(group(a, tool("b")), { choices, protectedReading: true })).toMatchObject({ expanded: false, expansionSource: "manual" });
    expect([...choices]).toEqual([["a", { expanded: false, order: 1 }]]);
  });

  test("S03 all tools complete without run_end does not close a running group", () => {
    const g = group(tool("a", "complete"), tool("b", "complete"));
    const current = state(g);
    expect(current).toMatchObject({ expanded: true, expansionSource: "running", status: "running", activeEntry: null, canHostWorking: true });
    expect([...current.entryStatuses.values()]).toEqual(["complete", "complete"]);
    expect(state(g, { running: false, previousExpanded: true })).toMatchObject({ expanded: true, expansionSource: "retained", status: "unknown" });
  });

  test("S03 same-turn body changes hosting, not completion or expansion", () => {
    const g = group(tool("a", "complete"));
    expect(state(g, { entries: [...g.entries, body], previousExpanded: true })).toMatchObject({ expanded: true, status: "running", canHostWorking: false });
    expect(state(g, { entries: [...g.entries, body], running: false, previousExpanded: true })).toMatchObject({ expanded: true, status: "unknown", expansionSource: "retained" });
  });

  test("S04 completion and repeated completion are idempotent", () => {
    const g = group(tool("a", "complete"));
    const first = state(g, { completion: end, previousExpanded: true });
    expect(first).toMatchObject({ expanded: false, expansionSource: "completed", status: "complete", activeEntry: null, canHostWorking: false });
    expect(state(g, { completion: { ...end }, previousExpanded: first.expanded })).toEqual(first);
  });

  test("S05 manual expansion survives completion", () => {
    const g = group(tool("a", "complete"));
    const choices = withProcessExpansion(new Map(), ["a"], true);
    expect(state(g, { completion: end, choices })).toMatchObject({ expanded: true, expansionSource: "manual" });
  });

  test("S06 history starts collapsed, both with and without explicit end", () => {
    const g = group(tool("a", "complete"));
    expect(state(g, { completion: end, live: false })).toMatchObject({ expanded: false, expansionSource: "completed", status: "complete" });
    expect(state(g, { live: false })).toMatchObject({ expanded: false, expansionSource: "history", status: "unknown" });
    expect(state(group(thought("empty", false, "")), { live: false })).toMatchObject({ status: "neutral", expanded: false });
    expect(state(group(thought("history", false)), { live: false })).toMatchObject({ status: "unknown" });
    expect(state(group(thought("history", false)), { completion: end, live: false })).toMatchObject({ status: "neutral" });
  });

  test("S07 disconnect retains established expansion but not spinners; reconnect never writes choices", () => {
    const g = group(tool("a"));
    const choices = new Map<string, ProcessExpansion>();
    const offline = state(g, { live: false, previousExpanded: true, choices });
    expect(offline).toMatchObject({ expanded: true, expansionSource: "retained", status: "unknown", activeEntry: null, canHostWorking: false });
    expect(state(g, { live: false, previousExpanded: false })).toMatchObject({ expanded: false, expansionSource: "retained" });
    expect(state(g, { running: false, previousExpanded: true })).toMatchObject({ expanded: true, status: "unknown" });
    expect(state(g, { previousExpanded: offline.expanded, choices })).toMatchObject({ expanded: true, status: "running" });
    expect(choices.size).toBe(0);
  });

  test("S08 old turn / idle residue cannot host current Working", () => {
    const g = group(tool("old"));
    const current: PresentationEntry = { ...body, groupId: "new" };
    expect(state(g, { entries: [current, ...g.entries] })).toMatchObject({ status: "unknown", activeEntry: null, canHostWorking: false });
    const entries = [...g.entries, { kind: "record", key: "pending", item: {
      kind: "pending", id: "p", clientRequestId: "p", requestId: "p", text: "next", createdAt: 3, delivery: "pending",
    } } satisfies PresentationEntry];
    const activity = timelineActivity(entries, true, true, () => false, new Set(["old"]));
    expect(activity.working).toBe(true);
    expect(state(g, { entries, activity })).toMatchObject({ status: "unknown", activeEntry: null, canHostWorking: false });
  });

  test("S09/S15 run_end beats late working and leaves unmatched partials unknown", () => {
    const g = group(thought("thinking"), tool("a"));
    const result = state(g, { completion: end, running: true });
    expect(result).toMatchObject({ status: "unknown", activeEntry: null, expanded: false, canHostWorking: false });
    expect([...result.entryStatuses.values()]).toEqual(["unknown", "unknown"]);
    expect(processGroupSummary(g, result.entryStatuses, en.tools)).toMatchObject({ unknownCount: 2, failureCount: 0, interruptedCount: 0 });
  });

  test("S10/S11 group outcome preserves individual results (error > interrupted > unknown)", () => {
    const g = group(tool("fail", "error"), tool("stop", "interrupted"), tool("unknown"), tool("ok", "complete"));
    const result = state(g, { completion: end });
    expect(result.status).toBe("error");
    expect([...result.entryStatuses.values()]).toEqual(["error", "interrupted", "unknown", "complete"]);
    const successful = group(tool("ok", "complete"));
    const error = state(successful, { completion: { ...end, status: "error" } });
    expect(error.status).toBe("error");
    expect(error.entryStatuses.get("ok")).toBe("complete");
    expect(state(successful, { completion: { ...end, status: "interrupted" } }).status).toBe("interrupted");
    expect(state(group(tool("stop", "interrupted"), tool("unknown")), { completion: end }).status).toBe("interrupted");
  });

  test("S12 latest observed running member wins immediately and falls back without replay", () => {
    const a = tool("a");
    const b = tool("b");
    const c = tool("c", "complete");
    const g = group(b, a, c);
    const observed = new Map([["a", 0], ["b", 1], ["c", 2]]);
    expect(state(g, { observed })).toMatchObject({ activeEntry: b, additionalRunningTools: 1 });
    expect(state(group(tool("b", "complete"), a, c), { observed })).toMatchObject({ activeEntry: a, additionalRunningTools: 0 });
    expect(state(group(tool("a", "complete"), tool("b", "complete"), c), { observed })).toMatchObject({ activeEntry: null, additionalRunningTools: 0 });
    expect(state(group(a, b), { observed: new Map() }).activeEntry).toBe(b);
  });

  test("S13 newer Thinking counts all parallel tools; superseded Thinking never revives", () => {
    const a = tool("a");
    const b = tool("b");
    const thinking = thought("thinking");
    const g = group(a, b, thinking);
    expect(state(g)).toMatchObject({ activeEntry: thinking, additionalRunningTools: 2 });
    const after = state(g, { entries: [...g.entries, body] });
    expect(after).toMatchObject({ activeEntry: b, additionalRunningTools: 1, canHostWorking: false });
    expect(after.entryStatuses.get(thinking.key)).toBe("unknown");
    const finished = group(tool("a", "complete"), tool("b", "complete"), thinking);
    expect(state(finished, { entries: [...finished.entries, body] }).activeEntry).toBeNull();
  });

  test("S14 separated same-turn groups apply their own member choices on end", () => {
    const entries = [tool("a", "complete"), body, tool("b", "complete"), { ...body, key: "body2" }, thought("c", false)];
    const groups = processGroups(entries, new Set());
    let choices = withProcessExpansion(new Map(), ["a"], true);
    choices = withProcessExpansion(choices, ["b"], false);
    expect(groups.map(g => state(g, { entries, choices, completion: end }).expanded)).toEqual([true, false, false]);
    expect(groups.map(g => g.entries.map(e => e.key))).toEqual([["a"], ["b"], ["c"]]);
  });

  test("R04 reader/focus protection defers collapse only until released, manual choice remains first", () => {
    const g = group(tool("a", "complete"));
    expect(state(g, { completion: end, protectedReading: true })).toMatchObject({ expanded: true, expansionSource: "protected" });
    expect(state(g, { completion: end, protectedReading: false, previousExpanded: true })).toMatchObject({ expanded: false, expansionSource: "completed" });
    expect(state(g, { completion: end, protectedReading: true, choices: withProcessExpansion(new Map(), ["a"], false) })).toMatchObject({ expanded: false, expansionSource: "manual" });
    expect(state(g, { completion: end, protectedReading: false, choices: withProcessExpansion(new Map(), ["a"], true) })).toMatchObject({ expanded: true, expansionSource: "manual" });
  });

  test("Working hosting requires the final timeline entry and the current running boundary", () => {
    const g = group(tool("a", "complete"));
    const record: PresentationEntry = { kind: "record", key: "record", item: { kind: "event", event: {
      ...scope, kind: "custom", event_id: "custom", timestamp: 1, payload: {}, truncated: false,
    } } };
    expect(state(g).canHostWorking).toBe(true);
    expect(state(g, { entries: [...g.entries, record] }).canHostWorking).toBe(false);
    expect(state(g, { entries: [...g.entries, thought("other")] }).canHostWorking).toBe(false);
    expect(state(g, { running: false }).canHostWorking).toBe(false);
  });
});

describe("process summaries share tool classification", () => {
  test.each([en, zh])("classification preserves first category order, distinct file paths, call counts and real failures", messages => {
    const g = group(thought("model-original", false), tool("r1", "complete", "read", { path: "a" }), tool("r2", "complete", "read", { path: "a" }),
      tool("c1", "error"), tool("r3", "complete", "read", { path: "b" }), tool("c2", "interrupted"),
      tool("e1", "complete", "edit", { path: "a" }), tool("e2", "complete", "edit", { path: "a" }),
      tool("w1", "complete", "write", { path: "b" }), tool("w2", "complete", "write", { path: "b" }));
    const t = messages.tools;
    const expected = [t.groupRead(2), t.groupCommand(2), t.groupEdit(1), t.groupWrite(1), t.groupFailed(1), t.groupInterrupted(1)].join(" · ");
    const values = g.entries.filter(e => e.kind === "tool").map(e => e.value);
    const result = state(g, { completion: end });
    expect(processGroupSummary({ key: "summary", groupId: "summary", entries: values.map((value, index) => ({ kind: "tool" as const, key: `tool-${index}`, value })) }, new Map(), t).fullLabel).toBe(expected);
    expect(processGroupSummary(g, result.entryStatuses, t)).toEqual({ fullLabel: expected, compactLabel: expected, failureCount: 1, interruptedCount: 1, unknownCount: 0 });
  });

  test("S15 unknown labels remain explicit without rewriting successful formal tools", () => {
    const g = group(tool("ok", "complete"), tool("unknown"));
    const result = state(g, { live: false });
    expect([...result.entryStatuses.values()]).toEqual(["complete", "unknown"]);
    const summary = processGroupSummary(g, result.entryStatuses, en.tools);
    expect(summary.unknownCount).toBe(1);
    expect(summary.fullLabel).toContain(en.tools.status.unknown);
    expect(summary.fullLabel).toContain(en.tools.groupCommand(2));
  });

  test("Thinking-only summary uses Thinking copy, never model content or fictional tool calls", () => {
    const g = group(thought("a", false, "MODEL ORIGINAL"), thought("b", false, ""));
    const statuses = new Map<string, ProcessStatus>([["a", "neutral"], ["b", "neutral"]]);
    expect(processGroupSummary(g, statuses, en.tools)).toEqual({ fullLabel: "Thinking", compactLabel: "Thinking", failureCount: 0, interruptedCount: 0, unknownCount: 0 });
    expect(processGroupSummary(g, new Map([["a", "unknown"], ["b", "neutral"]]), en.tools).unknownCount).toBe(1);
  });
});
