import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useLiveTimeline } from "./use-live-timeline";
import type { PeerChannel } from "../pi-reach/peer-channel";
import type { TimelineScope } from "./timeline-runtime";
import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { MessageList } from "@/components/pwa/message-list";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { loadTimeline, mergeTimelineEvents, replaceTimelineEvents } from "./timeline-store";

vi.mock("./timeline-store", () => ({ loadTimeline: vi.fn(async () => []), mergeTimelineEvents: vi.fn(async () => {}), replaceTimelineEvents: vi.fn(async () => {}) }));
const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "generation", selfSenderRef: "self", channelId: "channel" };
type Timeline = ReturnType<typeof useLiveTimeline>;
const report = vi.fn();
let api: Timeline;
// 与应用一致：Pi 仍在运行（endpoint working）时，当前一轮尚未结束。
let piRunning = false;
function Harness() {
  const channelRef = useRef<PeerChannel | null>(null);
  const timeline = useLiveTimeline({ channelRef, enabled: true, reportHistoryFailure: report });
  useLayoutEffect(() => { api = timeline; });
  return <PwaUiProvider><div className="pwa-root"><div style={{ display: "flex", flexDirection: "column", height: 400 }}><MessageList items={timeline.items} hasEarlier={timeline.hasEarlier} loadingEarlier={timeline.loadingEarlier} onLoadEarlier={timeline.loadEarlier} listRef={timeline.messageListRef} bottomSentinelRef={timeline.bottomSentinelRef} onScroll={timeline.handleScroll} reconnectPhase={timeline.reconnectPhase} running={piRunning} /></div></div></PwaUiProvider>;
}
function events(start: number, end: number, target = scope): TimelineEvent[] {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const seq = start + index;
    return { event_id: `${target.sessionId}-${seq}`, event_seq: seq, session_id: target.sessionId, leaf_id: target.leafId, timestamp: seq, group_id: `group-${seq}`, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Record ${seq}\n\n${"Readable output. ".repeat(10)}` }] };
  });
}
function start(headSeq: number, target = scope) {
  const frames: ClientFrame[] = [];
  api.startLive({ scope: target, headSeq, send: (frame) => { frames.push(frame); return true; }, onHistoryChanged: () => {} });
  return frames;
}
function reply(frames: ClientFrame[], records: TimelineEvent[], target = scope) {
  const request = frames.findLast((frame) => frame.type === "session_sync")!;
  const first = records[0].event_seq!;
  const frame: ServerFrame = { protocol_version: 2, type: "session_history_chunk", target_channel_id: target.channelId, in_reply_to: request.id, session_id: target.sessionId, leaf_id: target.leafId, chunk_index: 0, events: records, fragments: [], final_chunk: true, ...(first === 1 ? { eos: true } : { eos: false, next_before: first }) };
  expect(api.historyLoaderRef.current?.receive(frame)).toBe(true);
}
function sequences() { return api.items.flatMap((item) => item.kind === "event" ? [item.event.event_seq] : []); }
afterEach(async () => { piRunning = false; vi.restoreAllMocks(); vi.mocked(loadTimeline).mockReset().mockResolvedValue([]); vi.mocked(mergeTimelineEvents).mockReset().mockResolvedValue(undefined); vi.mocked(replaceTimelineEvents).mockReset().mockResolvedValue(undefined); report.mockClear(); await page.viewport(1280, 900); });

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
    await expect.poll(() => list.querySelectorAll("article").length).toBe(4);
    await expect.poll(() => list.querySelector("article.partial")?.textContent?.includes("After tools. ".repeat(25).trim())).toBe(true);
    await settle();
    const reply = list.querySelector("article.partial")!;
    expect([...list.querySelectorAll("article")].slice(0, 3)).toEqual(original);
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
    expect([...list.querySelectorAll("article")].slice(0, 4)).toEqual([...original, reply]);
    expect(list.querySelectorAll("article")).toHaveLength(6);
    expect(list.querySelectorAll(".pwa-streaming")).toHaveLength(0);
    expect(Math.abs(offset() - before)).toBeLessThanOrEqual(1);
    expect(api.followingOutput).toBe(false);
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
    api.applyTimelineChange(api.runtimeRef.current.commit(events(41, 41)[0]));
    const first = api.retryCatchup();
    const duplicate = api.retryCatchup();
    await expect.poll(() => frames.length).toBe(2);
    expect(await duplicate).toBe(false);
    reply(frames, events(11, 40));
    expect(await first).toBe(true);
    await expect.poll(() => sequences().length).toBe(31);
    expect(api.catchupFailed).toBe(false);
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
