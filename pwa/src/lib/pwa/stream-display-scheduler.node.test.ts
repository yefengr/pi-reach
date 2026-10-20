import { afterEach, expect, test, vi } from "vitest";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import { StreamDisplayScheduler } from "./stream-display-scheduler";
import type { TimelinePartial } from "../pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";

function partial(text: string, mode: "assistant" | "thinking" | "blocks" | "tool" = "assistant", status: "delta" | "running" = "delta"): TimelineViewItem {
  const base = { protocol_version: 2 as const, type: "timeline_partial" as const, session_id: "s", leaf_id: "l", group_id: "g", partial_id: "message:assistant:0", status };
  const value: TimelinePartial = mode === "tool"
    ? { ...base, kind: "tool", tool_call_id: "call", tool: "bash", delta: text }
    : mode === "blocks"
      ? { ...base, kind: "assistant", blocks: [{ type: "text", text }] }
      : { ...base, kind: mode, delta: text };
  return { kind: "partial", partial: value, createdAt: 1 };
}
function text(items: TimelineViewItem[]): string | undefined {
  const item = items[0];
  return item?.kind === "partial" ? item.partial.blocks?.map(block => block.text).join("\n") ?? item.partial.delta : undefined;
}
function fixture() {
  vi.useFakeTimers();
  const publish = vi.fn<(items: TimelineViewItem[], realtime: boolean) => void>();
  const buffer = new StreamDisplayBuffer();
  const scheduler = new StreamDisplayScheduler(buffer, publish);
  return { buffer, scheduler, publish };
}
afterEach(() => vi.useRealTimers());

test.each(["assistant", "thinking", "blocks", "tool"] as const)("coalesces %s content to one latest commit per 33ms", mode => {
  const { scheduler, publish } = fixture();
  scheduler.update([partial("ok", mode)]);
  expect(publish).toHaveBeenCalledTimes(1);
  for (let i = 1; i <= 100; i++) scheduler.update([partial(`ok${"x".repeat(i)}`, mode)]);
  expect(publish).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(32);
  expect(publish).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(publish).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(99);
  expect(publish.mock.calls.length).toBeLessThanOrEqual(5);
  expect(text(publish.mock.calls.at(-1)![0])).toBe(`ok${"x".repeat(100)}`);
  expect(vi.getTimerCount()).toBe(0);
});

test("status changes, pending actions and formal takeover bypass the content timer", () => {
  const { scheduler, publish } = fixture();
  scheduler.update([partial("one", "tool", "running")]);
  scheduler.update([partial("one two", "tool", "running")]);
  expect(publish).toHaveBeenCalledTimes(1);
  scheduler.update([partial("one two", "tool", "delta")]);
  expect(publish).toHaveBeenCalledTimes(2);
  const pending: TimelineViewItem = { kind: "pending", id: "p", clientRequestId: "p", text: "queued", createdAt: 1, delivery: "accepted", requestId: "r", queued: true };
  scheduler.update([pending]);
  scheduler.update([{ ...pending, queuedAction: "cancel" }]);
  expect(publish).toHaveBeenCalledTimes(4);
  const formal: TimelineViewItem = { kind: "event", event: { event_id: "message", session_id: "s", leaf_id: "l", group_id: "g", timestamp: 1, kind: "assistant", status: "complete", blocks: [{ type: "text", text: "Final" }] } };
  scheduler.update([formal]);
  expect(publish.mock.calls.at(-1)![0]).toEqual([formal]);
  const count = publish.mock.calls.length;
  vi.runAllTimers();
  expect(publish).toHaveBeenCalledTimes(count);
});

test("hidden pages keep only the newest content and resume without replaying any tail", () => {
  const { scheduler, publish } = fixture();
  scheduler.update([partial("starting a long answer")]);
  scheduler.setHidden(true);
  expect(vi.getTimerCount()).toBe(0);
  const before = publish.mock.calls.length;
  for (let i = 0; i < 100; i++) scheduler.update([partial(`background ${i} ${"x".repeat(500)}`)]);
  vi.advanceTimersByTime(1000);
  expect(publish).toHaveBeenCalledTimes(before);
  scheduler.setHidden(false);
  expect(text(publish.mock.calls.at(-1)![0])).toBe(`background 99 ${"x".repeat(500)}`);
  expect(publish).toHaveBeenCalledTimes(before + 1);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(500);
  expect(publish).toHaveBeenCalledTimes(before + 1);
});

test.each(["cancel", "reset"] as const)("%s invalidates even a queued old timer callback", action => {
  const { scheduler, publish } = fixture();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  scheduler.update([partial("old scope long answer")]);
  const stale = timeout.mock.calls.at(-1)![0] as () => void;
  if (action === "cancel") scheduler.cancel();
  else scheduler.update([], true);
  const before = publish.mock.calls.length;
  stale();
  expect(publish).toHaveBeenCalledTimes(before);
  expect(vi.getTimerCount()).toBe(0);
  scheduler.update([partial("new scope", "tool")], true);
  stale();
  expect(text(publish.mock.calls.at(-1)![0])).toBe("new scope");
  expect(publish).toHaveBeenCalledTimes(before + 1);
  timeout.mockRestore();
});

test("tool argument updates are coalesced without serializing the argument tree", () => {
  const { scheduler, publish } = fixture();
  const tool = (command: string): TimelineViewItem => {
    const item = partial("same output", "tool", "running");
    if (item.kind !== "partial" || item.partial.kind !== "tool") throw new Error("Invalid fixture");
    return { ...item, partial: { ...item.partial, args: { command, config: { nested: "x".repeat(1000) } } } };
  };
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    scheduler.update([tool("first")]);
    for (let i = 0; i < 20; i += 1) scheduler.update([tool(`updated-${i}`)]);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(33);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.at(-1)![0][0]).toMatchObject({ partial: { args: { command: "updated-19" } } });
    expect(stringify).not.toHaveBeenCalled();
  } finally { stringify.mockRestore(); }
});

test("an already scheduled display uses the latest committed publisher", () => {
  const { scheduler, publish } = fixture();
  scheduler.update([partial("a buffered answer")]);
  const latest = vi.fn();
  scheduler.setPublisher(latest);
  vi.advanceTimersByTime(33);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(latest).toHaveBeenCalledOnce();
  vi.runAllTimers();
  expect(text(latest.mock.calls.at(-1)![0])).toBe("a buffered answer");
});

test("elapsed time, not callback count, controls the 128ms catch-up and release cap", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("x".repeat(400))]);
  buffer.advance(64);
  expect(text(buffer.snapshot())?.length).toBeGreaterThan(100);
  buffer.advance(64);
  expect(text(buffer.snapshot())).toBe("x".repeat(400));
  expect(buffer.hasPending()).toBe(false);
  buffer.reset([partial("ok")]);
  buffer.ingest([partial(`ok${"x".repeat(1000)}`)]);
  expect(text(buffer.advance(33).items)?.length).toBeLessThanOrEqual(134);
});
