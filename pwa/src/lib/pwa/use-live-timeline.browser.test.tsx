import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useLiveTimeline } from "./use-live-timeline";
import { receiveTimelineFrame } from "./timeline-frame-handler";
import type { PeerChannel } from "../pi-reach/peer-channel";
import type { TimelineScope } from "./timeline-runtime";
import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { MessageList } from "@/components/pwa/message-list";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { clearTimelineBranchCheckpoint, discardTimelineEventsAfter, ensureTimelineBranchCheckpoint, latestTimelineEvent, loadTimeline, mergeTimelineEvents, replaceTimelineEvents } from "./timeline-store";

vi.mock("./timeline-store", () => ({
  loadTimeline: vi.fn(async () => []), mergeTimelineEvents: vi.fn(async () => {}), replaceTimelineEvents: vi.fn(async () => {}), latestTimelineEvent: vi.fn(async () => null), discardTimelineEventsAfter: vi.fn(async () => {}),
  ensureTimelineBranchCheckpoint: vi.fn(async () => null), clearTimelineBranchCheckpoint: vi.fn(async () => {}),
  TimelineStoreConflictError: class extends Error {},
}));
const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "generation", selfSenderRef: "self", channelId: "channel" };
type Timeline = ReturnType<typeof useLiveTimeline>;
const report = vi.fn();
const branchMismatch = vi.fn();
let api: Timeline;
// 与应用一致：endpoint working 只控制运行/等待展示，不决定一轮是否结束。
let piRunning = false;
function Harness() {
  const channelRef = useRef<PeerChannel | null>(null);
  const timeline = useLiveTimeline({ channelRef, enabled: true, reportHistoryFailure: report });
  useLayoutEffect(() => { api = timeline; });
  return <PwaUiProvider><div className="pwa-root"><div style={{ display: "flex", flexDirection: "column", height: 400 }}><MessageList items={timeline.items} hasEarlier={timeline.hasEarlier} loadingEarlier={timeline.loadingEarlier} onLoadEarlier={timeline.loadEarlier} loadEarlierFailed={timeline.loadEarlierFailed} autoLoadEarlier={!timeline.followingOutput} listRef={timeline.messageListRef} bottomSentinelRef={timeline.bottomSentinelRef} onScroll={timeline.handleScroll} reconnectPhase={timeline.reconnectPhase} running={piRunning} /></div></div></PwaUiProvider>;
}
function events(start: number, end: number, target = scope): TimelineEvent[] {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const seq = start + index;
    return { event_id: `${target.sessionId}-${seq}`, event_seq: seq, session_id: target.sessionId, leaf_id: target.leafId, timestamp: seq, group_id: `group-${seq}`, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Record ${seq}\n\n${"Readable output. ".repeat(10)}` }] };
  });
}
function start(headSeq: number, target = scope) {
  const frames: ClientFrame[] = [];
  api.startLive({ scope: target, headSeq, send: (frame) => { frames.push(frame); return true; }, onHistoryChanged: () => {}, onBranchMismatch: branchMismatch });
  return frames;
}
function reply(frames: ClientFrame[], records: TimelineEvent[], target = scope) {
  const request = frames.findLast((frame) => frame.type === "session_sync")!;
  const first = records[0].event_seq!;
  const frame: ServerFrame = { protocol_version: 2, type: "session_history_chunk", target_channel_id: target.channelId, in_reply_to: request.id, session_id: target.sessionId, leaf_id: target.leafId, chunk_index: 0, events: records, fragments: [], final_chunk: true, ...(first === 1 ? { eos: true } : { eos: false, next_before: first }) };
  expect(api.historyLoaderRef.current?.receive(frame)).toBe(true);
}
function sequences() { return api.items.flatMap((item) => item.kind === "event" ? [item.event.event_seq] : []); }
afterEach(async () => { piRunning = false; vi.restoreAllMocks(); vi.mocked(loadTimeline).mockReset().mockResolvedValue([]); vi.mocked(mergeTimelineEvents).mockReset().mockResolvedValue(undefined); vi.mocked(replaceTimelineEvents).mockReset().mockResolvedValue(undefined); vi.mocked(latestTimelineEvent).mockReset().mockResolvedValue(null); branchMismatch.mockClear(); vi.mocked(discardTimelineEventsAfter).mockReset().mockResolvedValue(undefined); vi.mocked(ensureTimelineBranchCheckpoint).mockReset().mockResolvedValue(null); vi.mocked(clearTimelineBranchCheckpoint).mockReset().mockResolvedValue(undefined); report.mockClear(); await page.viewport(1280, 900); });

test.each([1280, 390])("same-run tool/reply cycles preserve DOM order and reading position at %ipx", async width => {
  await page.viewport(width, 844);
  piRunning = true;
  const screen = await render(<Harness />);
  const base = { session_id: scope.sessionId, leaf_id: scope.leafId, group_id: "same-run" };
  const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const receive = (frame: ServerFrame) => flushSync(() => api.applyTimelineChange(api.runtimeRef.current.receive(frame)));
  const commit = (event: TimelineEvent) => flushSync(() => api.applyTimelineChange(api.runtimeRef.current.commit(event)));
  const text = (id: string, delta: string): ServerFrame => ({ ...base, protocol_version: 2, type: "timeline_partial", partial_id: `${id}:assistant:0`, kind: "assistant", status: "delta", delta });
  const formal = (id: string, seq: number, value: string): TimelineEvent => ({ ...base, event_id: id, event_seq: seq, timestamp: 10_000 - seq, kind: "assistant", status: "complete", blocks: [{ type: "text", text: value }] });
  const tool = (id: string): ServerFrame => ({ ...base, protocol_version: 2, type: "timeline_partial", partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.txt` }, status: "running" });
  const done = (id: string, seq: number): TimelineEvent => ({ ...base, event_id: `event:${id}`, event_seq: seq, timestamp: 10_000 - seq, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.txt` }, status: "complete", truncated: false, result: "ok" });
  try {
    flushSync(() => { start(0); });
    const history = Array.from({ length: 20 }, (_, i) => `Earlier paragraph ${i}.`).join("\n\n");
    commit(formal("A", 1, history));
    receive(tool("z-first"));
    receive(tool("a-second"));
    await settle();
    const list = api.messageListRef.current!;
    const original = [...list.querySelectorAll("article")];
    commit(done("a-second", 2));
    commit(done("z-first", 3));
    receive(text("B", "After tools. ".repeat(25)));
    // 两条工具从第一条起即在同一个折叠组内：正文、工具组、正文。
    await expect.poll(() => list.querySelectorAll("article").length).toBe(3);
    await expect.poll(() => list.querySelector("article.partial")?.textContent?.includes("After tools. ".repeat(25).trim())).toBe(true);
    await settle();
    const reply = list.querySelector("article.partial")!;
    expect([...list.querySelectorAll("article")].slice(0, 2)).toEqual(original);
    expect(list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
    const reading = original[0].querySelectorAll("p")[5];
    list.scrollTop += reading.getBoundingClientRect().top - list.getBoundingClientRect().top - 2;
    flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();
    expect(api.followingOutput).toBe(false);
    const offset = () => reading.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const before = offset();
    receive(text("B", "Continued without restarting."));
    commit(formal("B", 4, `${"After tools. ".repeat(25)}Continued without restarting.`));
    receive(tool("third"));
    commit(done("third", 5));
    receive(text("C", "Final summary."));
    commit(formal("C", 6, "Final summary."));
    await settle();
    expect([...list.querySelectorAll("article")].slice(0, 3)).toEqual([...original, reply]);
    expect(list.querySelectorAll("article")).toHaveLength(5);
    expect(list.querySelectorAll(".pwa-streaming")).toHaveLength(0);
    expect(Math.abs(offset() - before)).toBeLessThanOrEqual(1);
    expect(api.followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test.each(["missing run_end", "run_end", "run_end with residual partial"] as const)("live frame delivery groups tools from the first call and finishes the turn only on run_end (%s)", async mode => {
  piRunning = true;
  const screen = await render(<Harness />);
  const base = { session_id: scope.sessionId, leaf_id: scope.leafId, group_id: "tool-run" };
  const receive = (frame: ServerFrame) => flushSync(() => receiveTimelineFrame(frame, {
    runtime: api.runtimeRef.current,
    fragmentAssemblerRef: api.fragmentAssemblerRef,
    applyTimelineChange: api.applyTimelineChange,
    receiveRealtimeOutput: api.receiveRealtimeOutput,
    setError: report,
    setLastSyncedAt: api.setLastSyncedAt,
  }));
  const formal = (event: TimelineEvent) => receive({ protocol_version: 2, type: "timeline_event", session_id: event.session_id, leaf_id: event.leaf_id, event });
  const partial = (id: string): ServerFrame => ({ ...base, protocol_version: 2, type: "timeline_partial", partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "running" });
  const done = (id: string, seq: number): TimelineEvent => ({ ...base, event_id: `event:${id}`, event_seq: seq, timestamp: seq, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "complete", truncated: false, result: "ok" });
  try {
    flushSync(() => { expect(start(0)).toEqual([]); });
    const list = api.messageListRef.current!;
    const current = () => list.querySelector(".pwa-tool-group-current")?.textContent ?? null;
    receive(partial("first"));
    await expect.poll(current).toBe("readfirst.ts");
    receive(partial("second"));
    // 两条并行：second 排队，等 first 停满后显示。
    await expect.poll(current, { timeout: 3000 }).toBe("readsecond.ts");
    expect(list.querySelectorAll(".pwa-tool-group")).toHaveLength(1);
    expect(list.querySelector(".pwa-thinking-status")).toBeNull();

    formal(done("first", 1));
    await expect.poll(() => api.items.some(item => item.kind === "event" && item.event.event_id === "event:first")).toBe(true);
    expect(current()).toBe("readsecond.ts");
    formal(done("second", 2));
    // 工具全部结束、Pi 仍 working：短暂延迟后显示 Working；组头停留满最短时间后回到摘要。
    expect(list.querySelector(".pwa-thinking-status")).toBeNull();
    await expect.poll(() => list.querySelector(".pwa-thinking-status")?.textContent).toBe("Working…");
    await expect.poll(current, { timeout: 3000 }).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Expand Read 2 files" })).toBeVisible();
    expect(list.querySelectorAll(".pwa-tool-group")).toHaveLength(1);
    expect(list.querySelectorAll(".pwa-tool-card")).toHaveLength(0);
    expect(list.querySelector(".pwa-turn-meta")).toBeNull();

    if (mode === "run_end with residual partial") {
      receive({ ...base, protocol_version: 2, type: "timeline_partial", partial_id: "unfinished:assistant:0", kind: "assistant", status: "delta", delta: "Still streaming" });
      await expect.poll(() => list.querySelector("article.partial")?.textContent).toContain("Still streaming");
      expect(list.querySelector(".pwa-thinking-status")).toBeNull();
    }
    if (mode !== "missing run_end") {
      const timestamp = Date.UTC(2026, 0, 1, 9, 30);
      formal({ ...base, event_id: "run-end", event_seq: 3, timestamp, kind: "run_end", status: "complete" });
      await expect.poll(() => list.querySelector(".pwa-turn-meta time")?.getAttribute("datetime")).toBe(new Date(timestamp).toISOString());
      await expect.poll(() => vi.mocked(mergeTimelineEvents).mock.calls.some(([, values]) => values.some(event => event.kind === "run_end"))).toBe(true);
      // 收到 run_end 后即使 working 尚未更新也不再显示 Working。
      expect(list.querySelector(".pwa-thinking-status")).toBeNull();
    }
    expect(list.querySelectorAll(".pwa-tool-group")).toHaveLength(1);
    if (mode === "run_end") expect(api.items.some(item => item.kind === "partial")).toBe(false);
    if (mode === "run_end with residual partial") expect(api.items.some(item => item.kind === "partial" && item.partial.partial_id === "unfinished:assistant:0")).toBe(true);
    expect(api.messageListRef.current).toBe(list);
    expect(piRunning).toBe(true);
    expect(report).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

test("an oversized queue reports capacity without replacing existing messages", async () => {
  const screen = await render(<Harness />);
  try {
    flushSync(() => { start(0); });
    const existing = api.runtimeRef.current.sendUser("Keep this request")!;
    flushSync(() => api.applyTimelineChange(existing.change));
    const snapshot: Extract<ServerFrame, { type: "queued_message_state" }> = {
      protocol_version: 2, type: "queued_message_state", session_id: scope.sessionId,
      leaf_id: scope.leafId, snapshot_id: "too-large", chunk_index: 0, final: true,
      items: Array.from({ length: 129 }, (_, index) => ({ id: `queued-${index}`, text: "Queued", sender_ref: scope.selfSenderRef, editable: true, created_at: index })),
    };
    flushSync(() => api.applyTimelineChange(api.runtimeRef.current.receive(snapshot)));
    expect(report).toHaveBeenCalledWith("Too many queued messages or attachments. Existing messages were kept. Reconnect after the queue gets smaller.");
    expect(api.runtimeRef.current.pendingItems).toHaveLength(1);
    expect(api.items).toEqual([expect.objectContaining({ clientRequestId: existing.frame.client_request_id, text: "Keep this request" })]);
  } finally { await screen.unmount(); }
});

test.each([0, 30, 31])("reconnect gap %i retains or replaces the view and merges concurrent live events", async (gap) => {
  const screen = await render(<Harness />);
  try {
    start(0);
    api.applyTimelineChange(api.runtimeRef.current.prependHistory(events(1, 5)));
    await expect.poll(sequences).toEqual([1, 2, 3, 4, 5]);
    const list = document.querySelector(".pwa-message-list");
    api.disconnect();
    const frames = start(5 + gap);
    api.loadEarlier();
    if (gap === 0) {
      await expect.poll(() => api.catchingUp).toBe(false);
      expect(frames).toHaveLength(0);
      expect(sequences()).toEqual([1, 2, 3, 4, 5]);
      return;
    }
    expect(sequences()).toEqual([1, 2, 3, 4, 5]);
    const concurrent = events(6 + gap, 6 + gap)[0];
    api.applyTimelineChange(api.runtimeRef.current.commit(concurrent));
    await expect.poll(() => frames.length).toBe(1);
    const first = gap === 30 ? 6 : 7;
    expect(frames[0]).toMatchObject({ type: "session_sync", before: 6 + gap, limit: 30 });
    reply(frames, events(first, 5 + gap));
    await expect.poll(() => api.reconnectPhase).toBe(null);
    await expect.poll(sequences).toEqual(Array.from({ length: gap === 30 ? 36 : 31 }, (_, index) => (gap === 30 ? 1 : 7) + index));
    expect(document.querySelector(".pwa-message-list")).toBe(list);
    expect(api.catchupFailed).toBe(false);
  } finally { await screen.unmount(); }
});

test("preserves a reader's anchor through a small catchup on mobile", async () => {
  await page.viewport(390, 844);
  const screen = await render(<Harness />);
  try {
    start(0);
    api.applyTimelineChange(api.runtimeRef.current.prependHistory(events(1, 20)));
    await expect.poll(() => document.querySelectorAll("article").length).toBe(20);
    const list = api.messageListRef.current!;
    list.scrollTop = 200;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    await expect.poll(() => api.followingOutput).toBe(false);
    const article = list.querySelectorAll("article")[2];
    const offset = article.getBoundingClientRect().top - list.getBoundingClientRect().top;
    api.disconnect();
    const frames = start(22);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(21, 22));
    await expect.poll(() => sequences().length).toBe(22);
    await expect.poll(() => Math.abs(article.getBoundingClientRect().top - list.getBoundingClientRect().top - offset)).toBeLessThanOrEqual(1);
    expect(api.followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("failed initial catchup can be retried once without losing concurrent output", async () => {
  const screen = await render(<Harness />);
  try {
    const frames = start(40);
    await expect.poll(() => frames.length).toBe(1);
    api.historyLoaderRef.current!.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: frames[0].id, code: "internal_error", message: "history failed" });
    await expect.poll(() => api.catchupFailed).toBe(true);
    expect(api.loadEarlierFailed).toBe(true);
    api.applyTimelineChange(api.runtimeRef.current.commit(events(41, 41)[0]));
    const first = api.retryCatchup();
    const duplicate = api.retryCatchup();
    await expect.poll(() => frames.length).toBe(2);
    expect(await duplicate).toBe(false);
    reply(frames, events(11, 40));
    expect(await first).toBe(true);
    await expect.poll(() => sequences().length).toBe(31);
    expect(api.catchupFailed).toBe(false);
    // 补齐成功后顶部恢复为可自动加载，不残留失败状态。
    await expect.poll(() => api.loadEarlierFailed).toBe(false);
    await expect.poll(() => document.querySelector(".pwa-earlier")?.textContent).not.toContain("Couldn't load earlier records");
  } finally { await screen.unmount(); }
});

test("scope replacement starts from authoritative history and reduced motion skips fading", async () => {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => query === "(prefers-reduced-motion: reduce)" ? { ...matchMedia(query), matches: true } : matchMedia(query));
  vi.mocked(loadTimeline).mockImplementation(async () => []);
  const screen = await render(<Harness />);
  try {
    start(30);
    const nextScope = { ...scope, sessionId: "new-session", leafId: "new-generation" };
    const current = start(2, nextScope);
    await expect.poll(() => current.length).toBe(1);
    reply(current, events(1, 2, nextScope), nextScope);
    await expect.poll(() => sequences().length).toBe(2);
    expect(api.reconnectPhase).toBe(null);
    expect(api.items.every((item) => item.kind !== "event" || item.event.session_id === "new-session")).toBe(true);
  } finally { await screen.unmount(); }
});

test("keeps the old branch through failed persistence and commits a successful retry atomically", async () => {
  const screen = await render(<Harness />);
  const next = { ...scope, sessionId: "next", leafId: "next-leaf" };
  try {
    start(0);
    api.applyTimelineChange(api.runtimeRef.current.prependHistory(events(1, 2)));
    await expect.poll(sequences).toEqual([1, 2]);
    vi.mocked(replaceTimelineEvents).mockRejectedValueOnce(new Error("quota"));
    api.invalidateScope();
    const frames = start(3, next);
    await expect.poll(() => frames.length).toBe(1);
    api.applyTimelineChange(api.runtimeRef.current.commit(events(4, 4, next)[0]));
    expect(sequences()).toEqual([1, 2]);
    expect(api.runtimeRef.current.sendUser("not while replacing")).toBeNull();
    reply(frames, events(1, 3, next), next);
    await expect.poll(() => api.catchupFailed).toBe(true);
    expect(api.items.every((item) => item.kind === "event" && item.event.session_id === scope.sessionId)).toBe(true);
    const retry = api.retryCatchup();
    expect(await retry).toBe(true);
    await expect.poll(sequences).toEqual([1, 2, 3, 4]);
    expect(api.items.every((item) => item.kind === "event" && item.event.session_id === next.sessionId)).toBe(true);
  } finally { await screen.unmount(); }
});

test("repeats the final atomic replace when realtime output arrives during persistence", async () => {
  let releaseFirstWrite!: () => void;
  vi.mocked(replaceTimelineEvents).mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstWrite = resolve; }));
  const screen = await render(<Harness />);
  const next = { ...scope, sessionId: "next-during-write", leafId: "next-leaf" };
  try {
    start(0);
    api.applyTimelineChange(api.runtimeRef.current.prependHistory(events(1, 2)));
    await expect.poll(sequences).toEqual([1, 2]);

    api.invalidateScope();
    const frames = start(1, next);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(1, 1, next), next);
    await expect.poll(() => vi.mocked(replaceTimelineEvents).mock.calls.length).toBe(1);
    api.applyTimelineChange(api.runtimeRef.current.commit(events(2, 2, next)[0]));
    expect(sequences()).toEqual([1, 2]);

    releaseFirstWrite();
    await expect.poll(() => vi.mocked(replaceTimelineEvents).mock.calls.length).toBe(2);
    await expect.poll(sequences).toEqual([1, 2]);
    expect(vi.mocked(replaceTimelineEvents).mock.calls.at(-1)?.[1].map((event) => event.event_seq)).toEqual([1, 2]);
  } finally { await screen.unmount(); }
});

test("retries an empty branch replacement after persistence fails without requesting history", async () => {
  const screen = await render(<Harness />);
  const empty = { ...scope, sessionId: "empty-session", leafId: null };
  try {
    start(0);
    api.applyTimelineChange(api.runtimeRef.current.prependHistory(events(1, 2)));
    await expect.poll(sequences).toEqual([1, 2]);
    vi.mocked(replaceTimelineEvents).mockRejectedValueOnce(new Error("quota"));

    api.invalidateScope();
    const frames = start(0, empty);
    expect(frames).toEqual([]);
    await expect.poll(() => api.catchupFailed).toBe(true);
    expect(sequences()).toEqual([1, 2]);

    expect(await api.retryCatchup()).toBe(true);
    await expect.poll(sequences).toEqual([]);
    expect(vi.mocked(replaceTimelineEvents)).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: empty.sessionId, leafId: null }), []);
  } finally { await screen.unmount(); }
});

test("reset and disconnect preserve the previous formal branch and cancel staged output", async () => {
  const screen = await render(<Harness />);
  const next = { ...scope, sessionId: "next", leafId: "next-leaf" };
  try {
    start(0);
    api.applyTimelineChange(api.runtimeRef.current.prependHistory(events(1, 2)));
    await expect.poll(sequences).toEqual([1, 2]);
    api.invalidateScope();
    expect(api.runtimeRef.current.currentScope).toBeNull();
    await expect.poll(sequences).toEqual([1, 2]);
    const frames = start(3, next);
    await expect.poll(() => frames.length).toBe(1);
    api.applyTimelineChange(api.runtimeRef.current.commit(events(4, 4, next)[0]));
    api.disconnect();
    await expect.poll(sequences).toEqual([1, 2]);
    expect(api.runtimeRef.current.currentScope).toBeNull();
    const empty = start(0, next);
    expect(empty).toEqual([]);
    await expect.poll(sequences).toEqual([]);
  } finally { await screen.unmount(); }
});

test.each([
  ["the same runtime after a large gap", scope],
  ["a restarted Pi resuming the same session", { ...scope, runtimeInstanceId: "runtime-restarted", channelId: "channel-2" }],
])("reconnecting %s merges the latest window into local history instead of replacing it", async (_label, target) => {
  const screen = await render(<Harness />);
  try {
    const first = start(40);
    await expect.poll(() => first.length).toBe(1);
    reply(first, events(11, 40));
    await expect.poll(() => sequences().length).toBe(30);
    api.disconnect();

    const frames = start(100, target);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(71, 100, target), target);
    await expect.poll(sequences).toEqual(Array.from({ length: 30 }, (_, index) => 71 + index));
    expect(vi.mocked(replaceTimelineEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(mergeTimelineEvents).mock.calls.at(-1)?.[1].map((event) => event.event_seq)).toEqual(Array.from({ length: 30 }, (_, index) => 71 + index));
  } finally { await screen.unmount(); }
});

test("a lower head for the same session still replaces the stale local projection", async () => {
  const screen = await render(<Harness />);
  try {
    const first = start(40);
    await expect.poll(() => first.length).toBe(1);
    reply(first, events(11, 40));
    await expect.poll(() => sequences().length).toBe(30);
    api.disconnect();

    const frames = start(20);
    await expect.poll(() => frames.length).toBe(1);
    expect(vi.mocked(loadTimeline)).toHaveBeenCalledTimes(1);
    reply(frames, events(1, 20));
    await expect.poll(() => vi.mocked(replaceTimelineEvents).mock.calls.length).toBe(1);
    expect(vi.mocked(replaceTimelineEvents).mock.calls[0]?.[1].map((event) => event.event_seq)).toEqual(Array.from({ length: 20 }, (_, index) => 1 + index));
  } finally { await screen.unmount(); }
});

test("auto-loads earlier history near the top only after the reader leaves the latest output, and stops after a failure", async () => {
  const screen = await render(<Harness />);
  const syncs = (frames: ClientFrame[]) => frames.filter((frame): frame is Extract<ClientFrame, { type: "session_sync" }> => frame.type === "session_sync");
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  try {
    const frames = start(200);
    await expect.poll(() => syncs(frames).length).toBe(1);
    reply(frames, events(171, 200));
    await expect.poll(() => sequences().length).toBe(30);
    const list = api.messageListRef.current!;
    await expect.poll(() => list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
    for (let index = 0; index < 4; index += 1) await nextFrame();
    // 跟随最新输出时不向前加载。
    expect(syncs(frames)).toHaveLength(1);

    list.scrollTop = 0;
    await expect.poll(() => syncs(frames).length).toBe(2);
    expect([syncs(frames)[1]!.before, syncs(frames)[1]!.limit]).toEqual([171, 80]);
    await expect.element(screen.getByText("Loading records…")).toBeInTheDocument();
    reply(frames, events(91, 170));
    await expect.poll(() => sequences().length).toBe(110);

    list.scrollTop = 0;
    await expect.poll(() => syncs(frames).length).toBe(3);
    const failed = syncs(frames)[2]!;
    expect(api.historyLoaderRef.current?.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId, in_reply_to: failed.id, code: "internal_error", message: "History unavailable" })).toBe(true);
    await expect.element(screen.getByText("Couldn't load earlier records")).toBeVisible();
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    for (let index = 0; index < 4; index += 1) await nextFrame();
    expect(syncs(frames)).toHaveLength(3);

    await screen.getByRole("button", { name: "Retry loading earlier records", exact: true }).click();
    await expect.poll(() => syncs(frames).length).toBe(4);
    expect([syncs(frames)[3]!.before, syncs(frames)[3]!.limit]).toEqual([91, 80]);

    // 断线销毁 loader 后不保留失败状态，否则离线时仍显示无效的重试。
    const retried = syncs(frames)[3]!;
    expect(api.historyLoaderRef.current?.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId, in_reply_to: retried.id, code: "internal_error", message: "History unavailable" })).toBe(true);
    await expect.poll(() => api.loadEarlierFailed).toBe(true);
    api.disconnect();
    await expect.poll(() => api.loadEarlierFailed).toBe(false);
  } finally { await screen.unmount(); }
});

test("a cold start replaces saved records when the persisted sequence is ahead of the head", async () => {
  vi.mocked(latestTimelineEvent).mockResolvedValue(events(100, 100)[0]!);
  const screen = await render(<Harness />);
  try {
    const frames = start(50);
    await expect.poll(() => frames.length).toBe(1);
    // 本地记录已过期：不以它们填充窗口，取得权威记录后整段替换。
    expect(vi.mocked(loadTimeline)).not.toHaveBeenCalled();
    reply(frames, events(21, 50));
    await expect.poll(() => vi.mocked(replaceTimelineEvents).mock.calls.length).toBe(1);
    expect(vi.mocked(replaceTimelineEvents).mock.calls[0]?.[1].map((event) => event.event_seq)).toEqual(Array.from({ length: 30 }, (_, index) => 21 + index));
    expect(vi.mocked(mergeTimelineEvents)).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

test("a cold start of an empty session clears saved records left from another branch", async () => {
  vi.mocked(latestTimelineEvent).mockResolvedValue(events(5, 5)[0]!);
  const screen = await render(<Harness />);
  try {
    expect(start(0)).toEqual([]);
    await expect.poll(() => vi.mocked(discardTimelineEventsAfter).mock.calls.length).toBe(1);
    expect(vi.mocked(discardTimelineEventsAfter)).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: scope.sessionId }), 0);
    expect(vi.mocked(replaceTimelineEvents)).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

const checkpoint50 = { eventSeq: 50, eventId: "session-50" };

test("checks the latest saved record against the current branch after catching up", async () => {
  vi.mocked(ensureTimelineBranchCheckpoint).mockResolvedValue(checkpoint50);
  const screen = await render(<Harness />);
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    // 先照常补齐，不因核对拖慢打开。
    expect(frames[0]).toMatchObject({ type: "session_sync", before: 81, limit: 30 });
    reply(frames, events(51, 80));
    await expect.poll(() => sequences().length).toBe(30);
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1]).toMatchObject({ type: "session_sync", before: 51, limit: 1 });
    reply(frames, events(50, 50));
    // 核对通过才清除检查点。
    await expect.poll(() => vi.mocked(clearTimelineBranchCheckpoint).mock.calls.length).toBe(1);
    expect(vi.mocked(clearTimelineBranchCheckpoint)).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: scope.sessionId }), checkpoint50);
    expect(branchMismatch).not.toHaveBeenCalled();
    expect(vi.mocked(replaceTimelineEvents)).not.toHaveBeenCalled();
    // 检查点须在补齐记录写入前记下，否则会被新写入的当前分支记录顶替。
    expect(vi.mocked(ensureTimelineBranchCheckpoint).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(mergeTimelineEvents).mock.invocationCallOrder[0]!);
  } finally { await screen.unmount(); }
});

test("a saved record from an abandoned branch triggers branch recovery", async () => {
  vi.mocked(ensureTimelineBranchCheckpoint).mockResolvedValue(checkpoint50);
  const screen = await render(<Harness />);
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(51, 80));
    await expect.poll(() => frames.length).toBe(2);
    reply(frames, [{ ...events(50, 50)[0]!, event_id: "new-branch-50" }]);
    await expect.poll(() => branchMismatch.mock.calls.length).toBe(1);
    // 检查点由随后的整段替换清除。
    expect(vi.mocked(clearTimelineBranchCheckpoint)).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

test("a checkpoint that cannot be saved still checks the latest saved record in this connection", async () => {
  vi.mocked(ensureTimelineBranchCheckpoint).mockRejectedValue(new Error("IndexedDB unavailable"));
  vi.mocked(latestTimelineEvent).mockResolvedValue(events(50, 50)[0]!);
  const screen = await render(<Harness />);
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(51, 80));
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1]).toMatchObject({ type: "session_sync", before: 51, limit: 1 });
    reply(frames, [{ ...events(50, 50)[0]!, event_id: "new-branch-50" }]);
    await expect.poll(() => branchMismatch.mock.calls.length).toBe(1);
  } finally { await screen.unmount(); }
});

test("a pending checkpoint beyond the current head triggers branch recovery without a request", async () => {
  vi.mocked(ensureTimelineBranchCheckpoint).mockResolvedValue({ eventSeq: 90, eventId: "session-90" });
  const screen = await render(<Harness />);
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(51, 80));
    await expect.poll(() => branchMismatch.mock.calls.length).toBe(1);
    expect(frames).toHaveLength(1);
  } finally { await screen.unmount(); }
});

test("a failed branch check keeps the caught-up view without recovery", async () => {
  vi.mocked(ensureTimelineBranchCheckpoint).mockResolvedValue(checkpoint50);
  const screen = await render(<Harness />);
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(51, 80));
    await expect.poll(() => frames.length).toBe(2);
    expect(api.historyLoaderRef.current?.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId, in_reply_to: frames[1]!.id, code: "internal_error", message: "History unavailable" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(branchMismatch).not.toHaveBeenCalled();
    // 保留检查点，下次连接再核对。
    expect(vi.mocked(clearTimelineBranchCheckpoint)).not.toHaveBeenCalled();
    expect(api.catchupFailed).toBe(false);
    expect(sequences()).toHaveLength(30);
    // 核对结束后可照常向前加载。
    api.loadEarlier();
    await expect.poll(() => frames.length).toBe(3);
    expect(frames[2]).toMatchObject({ before: 51, limit: 50 });
  } finally { await screen.unmount(); }
});

test("an earlier page requested during the branch check runs after the check", async () => {
  vi.mocked(ensureTimelineBranchCheckpoint).mockResolvedValue(checkpoint50);
  const screen = await render(<Harness />);
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(51, 80));
    await expect.poll(() => frames.length).toBe(2);
    api.loadEarlier();
    await expect.poll(() => api.loadingEarlier).toBe(true);
    expect(frames).toHaveLength(2);
    reply(frames, events(50, 50));
    await expect.poll(() => frames.length).toBe(3);
    expect(frames[2]).toMatchObject({ before: 51, limit: 50 });
    reply(frames, events(1, 50));
    await expect.poll(() => sequences().length).toBe(80);
  } finally { await screen.unmount(); }
});

function receiveLive(event: TimelineEvent) {
  flushSync(() => receiveTimelineFrame({ protocol_version: 2, type: "timeline_event", session_id: event.session_id, leaf_id: event.leaf_id, event }, {
    runtime: api.runtimeRef.current,
    fragmentAssemblerRef: api.fragmentAssemblerRef,
    applyTimelineChange: api.applyTimelineChange,
    receiveRealtimeOutput: api.receiveRealtimeOutput,
    setError: report,
    setLastSyncedAt: api.setLastSyncedAt,
  }));
}

test("history requests follow the leaf advanced by live events", async () => {
  const screen = await render(<Harness />);
  const advanced = { ...scope, leafId: "leaf-after-live" };
  try {
    const frames = start(80);
    await expect.poll(() => frames.length).toBe(1);
    reply(frames, events(51, 80));
    await expect.poll(() => sequences().length).toBe(30);
    receiveLive(events(81, 81, advanced)[0]!);
    await expect.poll(() => sequences().length).toBe(31);
    api.loadEarlier();
    await expect.poll(() => frames.length).toBe(2);
    // Extension 按 Pi 当前 leaf 校验，旧 leaf 会被当作分支变化而 reset。
    expect(frames[1]).toMatchObject({ before: 51, limit: 50, leaf_id: advanced.leafId });
    reply(frames, events(1, 50, advanced), advanced);
    await expect.poll(() => sequences().length).toBe(81);
  } finally { await screen.unmount(); }
});

test("discarding records past the head runs before live events received after the handshake are saved", async () => {
  let resolveLatest!: (event: TimelineEvent | null) => void;
  vi.mocked(latestTimelineEvent).mockImplementation(() => new Promise((resolve) => { resolveLatest = resolve; }));
  const screen = await render(<Harness />);
  try {
    expect(start(0)).toEqual([]);
    receiveLive(events(1, 1)[0]!);
    await expect.poll(() => vi.mocked(mergeTimelineEvents).mock.calls.length).toBe(1);
    resolveLatest(events(5, 5)[0]!);
    await expect.poll(() => vi.mocked(discardTimelineEventsAfter).mock.calls.length).toBe(1);
    // 删除旧分支记录须排在握手后新事件的保存之前，否则会连新事件一起删掉。
    expect(vi.mocked(discardTimelineEventsAfter).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(mergeTimelineEvents).mock.invocationCallOrder[0]!);
  } finally { await screen.unmount(); }
});
