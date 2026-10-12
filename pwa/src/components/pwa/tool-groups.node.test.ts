import { describe, expect, test } from "vitest";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import { projectTimeline, type PresentationEntry } from "@/lib/pwa/timeline-presentation";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { appendedTools, observeTools, segmentExpansion, timelineActivity, toolSegments, withExpansion } from "./tool-groups";

const scope = { session_id: "s", leaf_id: "l" };
const tool = (id: string, group = "g1", status: "complete" | "error" = "complete"): TimelineViewItem => {
  const call = { ...scope, event_id: id, group_id: group, timestamp: 1, kind: "tool" as const, tool_call_id: id, tool: "bash", args: { command: id }, truncated: false };
  return { kind: "event", event: status === "error" ? { ...call, status, error: "failed" } : { ...call, status, result: "ok" } };
};
const running = (id: string, group = "g1"): TimelineViewItem => ({
  kind: "partial", createdAt: 0, partial: { protocol_version: 2, type: "timeline_partial", ...scope, group_id: group, partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, status: "running" },
});
const text = (id: string, group = "g1"): TimelineViewItem => ({ kind: "event", event: { ...scope, event_id: id, group_id: group, timestamp: 1, kind: "assistant", status: "complete", blocks: [{ type: "text", text: id }] } });
const streaming = (id: string, group = "g1"): TimelineViewItem => ({
  kind: "partial", createdAt: 0, partial: { protocol_version: 2, type: "timeline_partial", ...scope, group_id: group, partial_id: `${id}:assistant:0`, kind: "assistant", status: "delta", delta: id } satisfies TimelinePartial,
});
const runEnd = (group: string): TimelineEvent => ({ ...scope, event_id: `end-${group}`, group_id: group, timestamp: 2, kind: "run_end", status: "complete" });
const entries = (items: TimelineViewItem[]): PresentationEntry[] => projectTimeline(items).entries;
const segmentsOf = (items: TimelineViewItem[], gapKeys: ReadonlySet<string> = new Set()) => {
  const list = entries(items);
  return toolSegments(list, gapKeys, observeTools(list, new Map()));
};
const commands = (items: TimelineViewItem[]) => segmentsOf(items).map(segment => segment.tools.map(entry => "args" in entry.value && typeof entry.value.args === "object" && entry.value.args !== null && "command" in entry.value.args ? entry.value.args.command : ""));

describe("toolSegments", () => {
  test("groups from the first tool regardless of status or count", () => {
    expect(commands([tool("a")])).toEqual([["a"]]);
    expect(commands([tool("a"), running("b"), tool("c", "g1", "error")])).toEqual([["a", "b", "c"]]);
  });

  test("breaks at text, other turns and unsaved gaps", () => {
    expect(commands([tool("a"), text("t"), tool("b"), tool("c", "g2")])).toEqual([["a"], ["b"], ["c"]]);
    const items = [tool("a"), tool("b")];
    const gap = new Set([entries([tool("b")])[0]!.key]);
    expect(segmentsOf(items, gap).map(segment => segment.tools.length)).toEqual([1, 1]);
  });

  test("keeps the identity of an observed group when earlier history is prepended", () => {
    const live = entries([tool("b"), tool("c")]);
    const observed = observeTools(live, new Map());
    const [before] = toolSegments(live, new Set(), observed);
    const withHistory = projectTimeline([tool("a"), tool("b"), tool("c")], { items: [], entries: live }).entries;
    const nextObserved = observeTools(withHistory, observed);
    const [after] = toolSegments(withHistory, new Set(), nextObserved);
    expect(after!.tools).toHaveLength(3);
    expect(after!.key).toBe(before!.key);
    expect(observeTools(withHistory, nextObserved)).toBe(nextObserved);
  });
});

describe("appendedTools", () => {
  test("only counts tools that arrive after content already on screen", () => {
    const before = entries([text("t"), tool("a")]);
    const after = projectTimeline([text("t"), tool("a"), tool("b")], { items: [], entries: before }).entries;
    expect(appendedTools(after, before)).toEqual([after[2]!.key]);
    // 首次加载、切换会话与向前补齐的历史都不算新追加。
    expect(appendedTools(before, [])).toEqual([]);
    expect(appendedTools(entries([tool("x", "other")]), before)).toEqual([]);
    const prepended = projectTimeline([tool("old"), text("t"), tool("a")], { items: [], entries: before }).entries;
    expect(appendedTools(prepended, before)).toEqual([]);
  });
});

describe("expansion choices", () => {
  test("the latest choice among members wins after regrouping", () => {
    const [segment] = segmentsOf([tool("a"), tool("b")]);
    const [first, second] = segment!.tools;
    let choices = withExpansion(new Map(), [first!.key], true, false);
    choices = withExpansion(choices, [second!.key], false, false);
    expect(segmentExpansion(segment!.tools, choices)?.expanded).toBe(false);
    expect(segmentExpansion([first!], choices)?.expanded).toBe(true);
    expect(withExpansion(new Map(), [first!.key], false, true).get(first!.key)?.follow).toBe(false);
  });

  test("every part of a split group inherits the choice made on the whole group", () => {
    const [segment] = segmentsOf([tool("a"), tool("b"), tool("c")]);
    const choices = withExpansion(new Map(), segment!.tools.map(entry => entry.key), true, false);
    // 迟到的正文插入后拆成两段，两段都保持展开。
    const parts = segmentsOf([tool("a"), text("late"), tool("b"), tool("c")]);
    expect(parts.map(part => segmentExpansion(part.tools, choices)?.expanded)).toEqual([true, true]);
  });
});

describe("timelineActivity", () => {
  const activity = (items: TimelineViewItem[], { live = true, working = true, ended = [] as string[] } = {}) => {
    const list = entries(items);
    const segments = toolSegments(list, new Set(), observeTools(list, new Map()));
    return { result: timelineActivity(list, live, working, group => ended.includes(group)), segments };
  };

  test("shows Working only while Pi works and nothing is being output", () => {
    expect(activity([tool("a")]).result.working).toBe(true);
    expect(activity([text("t")]).result.working).toBe(true);
    expect(activity([running("a")]).result.working).toBe(false);
    expect(activity([streaming("t")]).result.working).toBe(false);
    expect(activity([tool("a")], { ended: ["g1"] }).result.working).toBe(false);
    expect(activity([tool("a")], { working: false }).result.working).toBe(false);
    expect(activity([tool("a")], { live: false }).result.working).toBe(false);
    expect(activity([{ kind: "event", event: runEnd("g0") }, tool("a")], { ended: ["g0"] }).result.working).toBe(true);
  });

  test("ignores residual partials of an ended or earlier turn", () => {
    const user = (id: string, group: string): TimelineViewItem => ({ kind: "event", event: { ...scope, event_id: id, message_id: id, group_id: group, timestamp: 2, kind: "user", blocks: [{ type: "text", text: id }], origin: "pwa", sender_ref: "me", delivery: "normal", status: "committed" } });
    // 旧轮已收到 run_end，残留的流式正文与运行中工具不再抑制新一轮的 Working。
    const ended = activity([text("a"), streaming("old"), running("t"), user("next", "g2")], { ended: ["g1"] }).result;
    expect(ended.working).toBe(true);
    expect(ended.hasOutput).toBe(false);
    // 旧轮缺少 run_end，但已不是末轮：同样视为残留。
    expect(activity([text("a"), streaming("old"), user("next", "g2")]).result.working).toBe(true);
    // 末轮自己的流式输出仍然算正在输出。
    expect(activity([user("next", "g2"), streaming("new", "g2")]).result.working).toBe(false);
  });

  test("a fresh send marks partials left over from an idle Pi as residual", () => {
    const pending = (queued: boolean): TimelineViewItem => ({ kind: "pending", id: "p", clientRequestId: "p", requestId: "p", text: "next", createdAt: 3, delivery: "pending", ...(queued ? { queued: true } : {}) });
    const items = [text("a"), streaming("old"), pending(false)];
    const list = entries(items);
    const stale = new Set(list.filter(entry => entry.kind === "text" && entry.streaming).map(entry => entry.key));
    // 旧轮缺少 run_end：Pi 空闲时就在的 partial，在新发送后不再抑制 Working。
    expect(timelineActivity(list, true, true, () => false, stale).working).toBe(true);
    // Pi 正在输出时发送：partial 不在空闲集合中，仍算正在输出。
    expect(timelineActivity(list, true, true, () => false).working).toBe(false);
    // 已进入 Pi 队列的消息不是新一轮的边界。
    expect(timelineActivity(entries([text("a"), streaming("old"), pending(true)]), true, true, () => false, stale).working).toBe(false);
  });

  test("a queued message at the end still belongs to the current turn", () => {
    const queued: TimelineViewItem = { kind: "pending", id: "q", clientRequestId: "q", requestId: "q", text: "later", createdAt: 3, delivery: "accepted", queued: true };
    const list = entries([text("a"), queued]);
    // 当前轮已收到 run_end，working 晚到也不显示 Working。
    expect(timelineActivity(list, true, true, group => group === "g1").working).toBe(false);
    // 当前轮已有输出：两段输出之间按延迟显示。
    expect(timelineActivity(list, true, true, () => false).hasOutput).toBe(true);
    // 新发送的消息开始新的一轮：已结束的旧轮不影响 Working，且新轮尚无输出。
    const fresh: TimelineViewItem = { ...queued, queued: undefined, delivery: "pending" };
    const sent = timelineActivity(entries([text("a"), fresh]), true, true, group => group === "g1");
    expect(sent.working).toBe(true);
    expect(sent.hasOutput).toBe(false);
  });

  test("treats only the trailing segment of a running turn as a live tail", () => {
    const { result, segments } = activity([tool("a"), text("t"), tool("b")]);
    expect(segments.map(segment => result.liveTail(segment))).toEqual([false, true]);
    const ended = activity([tool("a")], { ended: ["g1"], working: false });
    expect(ended.result.liveTail(ended.segments[0]!)).toBe(false);
    const stillRunning = activity([running("a")], { working: false });
    expect(stillRunning.result.liveTail(stillRunning.segments[0]!)).toBe(true);
  });
});
