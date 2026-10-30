import { describe, expect, test } from "vitest";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import { projectTimeline, type PresentationEntry } from "@/lib/pwa/timeline-presentation";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { timelineActivity } from "./timeline-activity";

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
describe("timelineActivity", () => {
  const activity = (items: TimelineViewItem[], { live = true, working = true, ended = [] as string[] } = {}) => {
    const list = entries(items);
    return { result: timelineActivity(list, live, working, group => ended.includes(group)) };
  };

  test("keeps the Working run gate independent of specific output indicators", () => {
    expect(activity([tool("a")]).result.working).toBe(true);
    expect(activity([text("t")]).result.working).toBe(true);
    expect(activity([running("a")]).result.working).toBe(true);
    expect(activity([streaming("t")]).result.working).toBe(true);
    const list = entries([running("a"), streaming("t"), tool("done")]);
    const current = timelineActivity(list, true, true, () => false);
    expect(list.map(entry => current.currentOutput(entry))).toEqual([true, true, false]);
    expect(list.some(entry => timelineActivity(list, false, true, () => false).currentOutput(entry))).toBe(false);
    expect(list.some(entry => timelineActivity(list, true, false, () => false).currentOutput(entry))).toBe(false);
    expect(list.some(entry => timelineActivity(list, true, true, () => true).currentOutput(entry))).toBe(false);
    expect(activity([tool("a")], { ended: ["g1"] }).result.working).toBe(false);
    expect(activity([tool("a")], { working: false }).result.working).toBe(false);
    expect(activity([tool("a")], { live: false }).result.working).toBe(false);
    expect(activity([{ kind: "event", event: runEnd("g0") }, tool("a")], { ended: ["g0"] }).result.working).toBe(true);
  });

  test("keeps frozen visible indicators scoped to the active turn after a tool completes", () => {
    const list = entries([tool("old", "g0"), tool("done", "g1")]);
    const current = timelineActivity(list, true, true, () => false);
    expect(list.map(entry => current.currentIndicator(entry))).toEqual([false, true]);
    expect(list.some(entry => current.currentOutput(entry))).toBe(false);
    expect(list.some(entry => timelineActivity(list, true, false, () => false).currentIndicator(entry))).toBe(false);
    expect(list.some(entry => timelineActivity(list, false, true, () => false).currentIndicator(entry))).toBe(false);
    expect(list.some(entry => timelineActivity(list, true, true, group => group === "g1").currentIndicator(entry))).toBe(false);
    const pending: TimelineViewItem = { kind: "pending", id: "next", clientRequestId: "next", requestId: "next", text: "next", createdAt: 3, delivery: "pending" };
    const fresh = entries([tool("done"), pending]);
    expect(timelineActivity(fresh, true, true, () => false, new Set([fresh[0]!.key])).currentIndicator(fresh[0]!)).toBe(false);
  });

  test("ignores residual partials of an ended or earlier turn", () => {
    const user = (id: string, group: string): TimelineViewItem => ({ kind: "event", event: { ...scope, event_id: id, message_id: id, group_id: group, timestamp: 2, kind: "user", blocks: [{ type: "text", text: id }], origin: "pwa", sender_ref: "me", delivery: "normal", status: "committed" } });
    // 旧轮残留不改变新一轮的 Working 或具体运行提示归属。
    const ended = activity([text("a"), tool("next", "g2"), streaming("old"), running("t")], { ended: ["g1"] });
    expect(ended.result.working).toBe(true);
    expect(entries([streaming("old"), running("t")]).some(entry => ended.result.currentOutput(entry))).toBe(false);
    const earlier = activity([tool("next", "g2"), running("t")]);
    expect(earlier.result.currentOutput(entries([running("t")])[0]!)).toBe(false);
    expect(earlier.result.currentOutput(entries([running("new", "g2")])[0]!)).toBe(true);
    // 旧轮缺少 run_end，但已不是末轮：同样视为残留。
    expect(activity([text("a"), streaming("old"), user("next", "g2")]).result.working).toBe(true);
    // 末轮自己的流式输出也不隐藏 Working。
    expect(activity([user("next", "g2"), streaming("new", "g2")]).result.working).toBe(true);
  });

  test("keeps Working visible for fresh sends and queued messages despite residual partials", () => {
    const pending = (queued: boolean): TimelineViewItem => ({ kind: "pending", id: "p", clientRequestId: "p", requestId: "p", text: "next", createdAt: 3, delivery: "pending", ...(queued ? { queued: true } : {}) });
    const items = [text("a"), streaming("old"), pending(false)];
    const list = entries(items);
    const stale = new Set(list.filter(entry => entry.kind === "text" && entry.streaming).map(entry => entry.key));
    // 新发送、流式输出与排队期间都保持 Working。
    expect(timelineActivity(list, true, true, () => false, stale).working).toBe(true);
    expect(list.filter(entry => entry.kind === "text" && entry.streaming).some(entry => timelineActivity(list, true, true, () => false, stale).currentOutput(entry))).toBe(false);
    expect(timelineActivity(list, true, true, () => false).working).toBe(true);
    // 已进入 Pi 队列的消息不是新一轮的边界。
    expect(timelineActivity(entries([text("a"), streaming("old"), pending(true)]), true, true, () => false, stale).working).toBe(true);
  });

  test("a queued message at the end still belongs to the current turn", () => {
    const queued: TimelineViewItem = { kind: "pending", id: "q", clientRequestId: "q", requestId: "q", text: "later", createdAt: 3, delivery: "accepted", queued: true };
    const list = entries([text("a"), queued]);
    // 当前轮已收到 run_end，working 晚到也不显示 Working。
    expect(timelineActivity(list, true, true, group => group === "g1").working).toBe(false);
    // 当前轮已有输出，仍持续显示 Working。
    expect(timelineActivity(list, true, true, () => false).working).toBe(true);
    // 新发送的消息开始新的一轮：已结束的旧轮不影响 Working。
    const fresh: TimelineViewItem = { ...queued, queued: undefined, delivery: "pending" };
    const sent = timelineActivity(entries([text("a"), fresh]), true, true, group => group === "g1");
    expect(sent.working).toBe(true);
  });
});
