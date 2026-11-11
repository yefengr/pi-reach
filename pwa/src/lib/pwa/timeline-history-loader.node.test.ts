import { afterEach, expect, test, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { SequencedTimelineEvent, TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { TimelineHistoryLoader, type TimelineHistoryLoaderOptions } from "./timeline-history-loader";
import type { TimelineScope } from "./timeline-runtime";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};
type HistoryChunkFrame = Extract<ServerFrame, { type: "session_history_chunk" }>;
type SessionSyncFrame = Extract<ClientFrame, { type: "session_sync" }>;
type HarnessOverrides = Partial<Pick<
  TimelineHistoryLoaderOptions,
  "headSeq" | "boundary" | "send" | "load" | "persist" | "requestId" | "timeoutMs" | "maxDurationMs" | "currentLeafId"
>>;

const scope: TimelineScope = {
  deviceId: "device",
  endpointId: "endpoint",
  runtimeInstanceId: "runtime",
  sessionId: "session",
  leafId: "generation",
  selfSenderRef: "self",
  channelId: "channel",
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function numberedEvents(start = 1, count = 80): SequencedTimelineEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = start + index;
    return {
      event_id: `event-${sequence}`,
      event_seq: sequence,
      session_id: scope.sessionId,
      leaf_id: scope.leafId,
      timestamp: sequence,
      group_id: `group-${sequence}`,
      kind: "assistant" as const,
      status: "complete" as const,
      blocks: [{ type: "text" as const, text: `Event ${sequence}` }],
    };
  });
}

function historyFrame(requestId: string, events = numberedEvents()): HistoryChunkFrame {
  const firstSequence = events[0]?.event_seq ?? 1;
  const eos = firstSequence === 1;
  return {
    protocol_version: 2,
    type: "session_history_chunk",
    target_channel_id: scope.channelId,
    in_reply_to: requestId,
    session_id: scope.sessionId,
    leaf_id: scope.leafId,
    chunk_index: 0,
    events,
    fragments: [],
    final_chunk: true,
    ...(eos ? { eos: true as const } : { eos: false as const, next_before: firstSequence }),
  };
}

function createHarness(overrides: HarnessOverrides = {}) {
  const sent: ClientFrame[] = [];
  let requestIndex = 0;
  const onPage = vi.fn<(events: TimelineEvent[]) => void>();
  const onState = vi.fn<(state: { hasEarlier: boolean; loading: boolean }) => void>();
  const onError = vi.fn<(message: string) => void>();
  const loader = new TimelineHistoryLoader({
    scope,
    headSeq: 80,
    send: (frame) => {
      sent.push(frame);
      return true;
    },
    load: async () => [],
    persist: async () => {},
    requestId: () => `request-${++requestIndex}`,
    timeoutMs: 25,
    ...overrides,
    onPage,
    onState,
    onError,
  });
  return { loader, sent, onPage, onState, onError };
}

function sessionSyncFrames(frames: ClientFrame[]): SessionSyncFrame[] {
  return frames.filter((frame): frame is SessionSyncFrame => frame.type === "session_sync");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

test("history recovery accepts continuing valid chunks beyond the old total timeout", async () => {
  vi.useFakeTimers();
  const harness = createHarness({ timeoutMs: 15_000 });
  const operation = harness.loader.loadEarlier();
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(10_000);
  harness.loader.receive({
    protocol_version: 2, type: "session_history_chunk", target_channel_id: scope.channelId,
    in_reply_to: "request-1", session_id: scope.sessionId, leaf_id: scope.leafId,
    chunk_index: 0, events: numberedEvents(1, 40), fragments: [], final_chunk: false,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  harness.loader.receive({
    protocol_version: 2, type: "session_history_chunk", target_channel_id: scope.channelId,
    in_reply_to: "request-1", session_id: scope.sessionId, leaf_id: scope.leafId,
    chunk_index: 1, events: numberedEvents(41, 40), fragments: [], final_chunk: true, eos: true,
  });
  expect(await operation).toBe(true);
  expect(harness.onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

function pendingChunk(index = 0): HistoryChunkFrame {
  return {
    protocol_version: 2, type: "session_history_chunk", target_channel_id: scope.channelId,
    in_reply_to: "request-1", session_id: scope.sessionId, leaf_id: scope.leafId,
    chunk_index: index, events: [], fragments: [], final_chunk: false,
  };
}

test("history recovery times out after the last valid progress and ignores unrelated frames", async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  const operation = harness.loader.loadEarlier();
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(20);
  expect(harness.loader.receive(pendingChunk())).toBe(true);
  await vi.advanceTimersByTimeAsync(20);
  expect(harness.loader.receive({ ...pendingChunk(1), in_reply_to: "other" })).toBe(false);
  expect(harness.loader.receive({ ...pendingChunk(1), leaf_id: "other" })).toBe(false);
  await vi.advanceTimersByTimeAsync(5);
  expect(await operation).toBe(false);
  expect(harness.onError).toHaveBeenLastCalledWith("History request timed out.");
  expect(vi.getTimerCount()).toBe(0);
});

test("history recovery never renews its independent maximum duration", async () => {
  vi.useFakeTimers();
  const harness = createHarness({ timeoutMs: 25, maxDurationMs: 60 });
  const operation = harness.loader.loadEarlier();
  await flushMicrotasks();
  for (let index = 0; index < 2; index++) {
    await vi.advanceTimersByTimeAsync(20);
    harness.loader.receive(pendingChunk(index));
  }
  await vi.advanceTimersByTimeAsync(20);
  expect(await operation).toBe(false);
  expect(harness.onError).toHaveBeenLastCalledWith("History request exceeded its maximum duration.");
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["duplicate", "conflict", "invalid"] as const)("history recovery keeps %s chunks terminal and clears both timers", async kind => {
  vi.useFakeTimers();
  const harness = createHarness();
  const operation = harness.loader.loadEarlier();
  await flushMicrotasks();
  harness.loader.receive(pendingChunk());
  const chunk = kind === "invalid" ? { ...pendingChunk(1), chunk_index: -1 }
    : kind === "conflict" ? { ...pendingChunk(), events: numberedEvents(1, 1) } : pendingChunk();
  harness.loader.receive(chunk);
  expect(await operation).toBe(false);
  expect(harness.onError).toHaveBeenLastCalledWith("History response was invalid.");
  expect(vi.getTimerCount()).toBe(0);
});

test.each([0, -1, 1.5, NaN, Infinity])("history recovery falls back from invalid timeout options %s", async invalid => {
  vi.useFakeTimers();
  const harness = createHarness({ timeoutMs: invalid, maxDurationMs: invalid });
  const operation = harness.loader.loadEarlier();
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(harness.onError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await operation).toBe(false);
  expect(harness.onError).toHaveBeenLastCalledWith("History request timed out.");
  expect(vi.getTimerCount()).toBe(0);
});

test("history recovery uses the default hard limit even with continuous progress", async () => {
  vi.useFakeTimers();
  const harness = createHarness({ timeoutMs: 20_000, maxDurationMs: 0 });
  const operation = harness.loader.loadEarlier();
  await flushMicrotasks();
  for (let index = 0; index < 17; index++) {
    await vi.advanceTimersByTimeAsync(10_000);
    harness.loader.receive(pendingChunk(index));
  }
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await operation).toBe(false);
  expect(harness.onError).toHaveBeenLastCalledWith("History request exceeded its maximum duration.");
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["dispose", "synchronous completion", "synchronous failure"] as const)("history recovery leaves no timer after %s", async mode => {
  vi.useFakeTimers();
  const harness = createHarness(mode === "dispose" ? {} : { send: frame => {
    if (mode === "synchronous completion") loader.receive(historyFrame(frame.id));
    else loader.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: frame.id, code: "internal_error", message: "failed" });
    return true;
  } });
  const loader = harness.loader;
  const operation = loader.loadEarlier();
  await flushMicrotasks();
  if (mode === "dispose") {
    expect(vi.getTimerCount()).toBe(2);
    loader.dispose();
  }
  expect(await operation).toBe(mode === "synchronous completion");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(harness.onError).toHaveBeenCalledTimes(mode === "synchronous failure" ? 1 : 0);
});

test("releases loading after timeout and retries the same range without accepting the old response", async () => {
  vi.useFakeTimers();
  const harness = createHarness();

  const firstLoad = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent)).toEqual([expect.objectContaining({ id: "request-1", before: 81, limit: 80 })]);

  await vi.advanceTimersByTimeAsync(25);
  expect(await firstLoad).toBe(false);
  expect(harness.onState).toHaveBeenLastCalledWith({ hasEarlier: true, loading: false });
  expect(harness.onError).toHaveBeenLastCalledWith("History request timed out.");

  harness.onError.mockClear();
  const retry = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent)).toEqual([
    expect.objectContaining({ id: "request-1", before: 81, limit: 80 }),
    expect.objectContaining({ id: "request-2", before: 81, limit: 80 }),
  ]);

  expect(harness.loader.receive(historyFrame("request-1"))).toBe(false);
  expect(harness.onPage).not.toHaveBeenCalled();
  expect(harness.onError).not.toHaveBeenCalled();

  expect(harness.loader.receive(historyFrame("request-2"))).toBe(true);
  expect(await retry).toBe(true);
  expect(harness.onPage).toHaveBeenCalledWith(numberedEvents());
  expect(harness.onState).toHaveBeenLastCalledWith({ hasEarlier: false, loading: false });
});

test("dispose isolates unfinished loads, persists, and late frames from callbacks", async () => {
  const pendingLoad = createDeferred<TimelineEvent[]>();
  const loading = createHarness({ load: () => pendingLoad.promise });
  const loadOperation = loading.loader.loadEarlier();
  loading.loader.dispose();
  const loadingStateCalls = loading.onState.mock.calls.length;
  expect(await loadOperation).toBe(false);
  pendingLoad.resolve(numberedEvents());
  await flushMicrotasks();
  expect(loading.onPage).not.toHaveBeenCalled();
  expect(loading.onState).toHaveBeenCalledTimes(loadingStateCalls);
  expect(loading.onError).not.toHaveBeenCalled();

  const pendingPersist = createDeferred<void>();
  const persist = vi.fn(() => pendingPersist.promise);
  const persisting = createHarness({ load: async () => numberedEvents(), persist });
  const persistOperation = persisting.loader.loadEarlier();
  await flushMicrotasks();
  expect(persist).toHaveBeenCalledTimes(1);
  persisting.loader.dispose();
  const persistingStateCalls = persisting.onState.mock.calls.length;
  expect(await persistOperation).toBe(false);
  pendingPersist.resolve();
  await flushMicrotasks();
  expect(persisting.onPage).not.toHaveBeenCalled();
  expect(persisting.onState).toHaveBeenCalledTimes(persistingStateCalls);
  expect(persisting.onError).not.toHaveBeenCalled();

  const receiving = createHarness();
  const receiveOperation = receiving.loader.loadEarlier();
  await flushMicrotasks();
  const request = sessionSyncFrames(receiving.sent)[0];
  expect(request).toBeDefined();
  receiving.loader.dispose();
  const receivingStateCalls = receiving.onState.mock.calls.length;
  expect(await receiveOperation).toBe(false);
  expect(receiving.loader.receive(historyFrame(request.id))).toBe(false);
  expect(receiving.onPage).not.toHaveBeenCalled();
  expect(receiving.onState).toHaveBeenCalledTimes(receivingStateCalls);
  expect(receiving.onError).not.toHaveBeenCalled();
});

test("loads a bounded reconnect range from cache and requests only its missing gap", async () => {
  const cached = [...numberedEvents(51, 10), ...numberedEvents(71, 10)];
  const persist = vi.fn(async () => {});
  const harness = createHarness({ load: async () => cached, persist });

  const operation = harness.loader.loadRange(51, 80);
  expect(harness.loader.loadRange(51, 80)).toBe(operation);
  await flushMicrotasks();
  const request = sessionSyncFrames(harness.sent)[0];
  expect(request).toEqual(expect.objectContaining({ before: 71, limit: 10 }));
  expect(harness.loader.receive(historyFrame(request.id, numberedEvents(61, 10)))).toBe(true);

  const expected = numberedEvents(51, 30);
  expect(await operation).toBe(true);
  expect(harness.onPage).toHaveBeenCalledWith(expected);
  expect(persist).toHaveBeenCalledWith(scope, expected);
  expect(harness.onState).toHaveBeenLastCalledWith({ hasEarlier: true, loading: false });
});

test("loads mixed-leaf cache records for one stable session", async () => {
  const mixed = numberedEvents(51, 30).map((event, index) => ({ ...event, leaf_id: index < 15 ? "older-leaf" : "newer-leaf" }));
  const persist = vi.fn(async () => {});
  const harness = createHarness({ load: async () => mixed, persist });

  expect(await harness.loader.loadRange(51, 80)).toBe(true);
  expect(sessionSyncFrames(harness.sent)).toEqual([]);
  expect(harness.onPage).toHaveBeenCalledWith(mixed);
  expect(persist).toHaveBeenCalledWith(scope, mixed);
});

test("uses a complete reconnect range cache and rejects ranges wider than 30 events", async () => {
  const harness = createHarness({ load: async () => numberedEvents(51, 30) });
  expect(await harness.loader.loadRange(50, 80)).toBe(false);
  expect(await harness.loader.loadRange(51, 80)).toBe(true);
  expect(sessionSyncFrames(harness.sent)).toEqual([]);
  expect(harness.onPage).toHaveBeenCalledWith(numberedEvents(51, 30));
});

test("keeps an explicit earlier boundary when a later reconnect range succeeds", async () => {
  const harness = createHarness({ boundary: 51, load: async () => numberedEvents(61, 20) });
  expect(await harness.loader.loadRange(61, 80)).toBe(true);
  expect(sessionSyncFrames(harness.sent)).toEqual([]);

  const earlier = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent)).toEqual([expect.objectContaining({ before: 51, limit: 50 })]);
  harness.loader.dispose();
  expect(await earlier).toBe(false);
});

test("keeps the earlier-history boundary when a reconnect range fails", async () => {
  const harness = createHarness();
  const operation = harness.loader.loadRange(51, 80);
  await flushMicrotasks();
  const request = sessionSyncFrames(harness.sent)[0];
  expect(request).toBeDefined();
  expect(harness.loader.receive({
    protocol_version: 2,
    type: "protocol_error",
    target_channel_id: scope.channelId,
    in_reply_to: request.id,
    code: "invalid_message",
    message: "rejected",
  })).toBe(true);
  expect(await operation).toBe(false);
  expect(harness.onError).toHaveBeenLastCalledWith("rejected");

  const earlier = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent).at(-1)).toEqual(expect.objectContaining({ before: 81, limit: 80 }));
  harness.loader.dispose();
  expect(await earlier).toBe(false);
});

test("returns false without callbacks when a reconnect range is cancelled", async () => {
  const pendingLoad = createDeferred<TimelineEvent[]>();
  const harness = createHarness({ load: () => pendingLoad.promise });
  const operation = harness.loader.loadRange(51, 80);
  harness.loader.dispose();

  expect(await operation).toBe(false);
  pendingLoad.resolve(numberedEvents(51, 30));
  await flushMicrotasks();
  expect(harness.onPage).not.toHaveBeenCalled();
  expect(harness.onError).not.toHaveBeenCalled();
});

test("fetches one authoritative event id without reading the cache, persisting, or changing the boundary", async () => {
  const load = vi.fn(async () => numberedEvents(1, 80));
  const persist = vi.fn(async () => {});
  const harness = createHarness({ load, persist });

  const fetched = harness.loader.fetchEventId(50);
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent)).toEqual([expect.objectContaining({ id: "request-1", before: 51, limit: 1 })]);
  expect(harness.loader.receive(historyFrame("request-1", [{ ...numberedEvents(50, 1)[0]!, event_id: "remote-50" }]))).toBe(true);
  expect(await fetched).toBe("remote-50");
  expect(load).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  expect(harness.onPage).not.toHaveBeenCalled();
  expect(harness.onState).not.toHaveBeenCalledWith(expect.objectContaining({ loading: true }));
  expect(harness.loader.hasEarlier).toBe(true);

  // 核对结束后可照常从缓存加载。
  expect(await harness.loader.loadEarlier()).toBe(true);
  expect(load).toHaveBeenCalledTimes(1);
  expect(harness.onPage).toHaveBeenCalledTimes(1);
});

test("returns null for an event id request that fails, times out, or is out of range", async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  expect(await harness.loader.fetchEventId(81)).toBeNull();
  expect(await harness.loader.fetchEventId(0)).toBeNull();

  const failed = harness.loader.fetchEventId(10);
  await flushMicrotasks();
  harness.loader.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId, in_reply_to: "request-1", code: "internal_error", message: "History unavailable" });
  expect(await failed).toBeNull();

  const timedOut = harness.loader.fetchEventId(10);
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(25);
  expect(await timedOut).toBeNull();
  expect(harness.onError).not.toHaveBeenCalled();
});

test("queues an earlier page requested during an event id check instead of dropping it", async () => {
  const harness = createHarness();
  const check = harness.loader.fetchEventId(50);
  await flushMicrotasks();
  const page = harness.loader.loadEarlier();
  await flushMicrotasks();
  // 核对期间先显示加载中，分页请求等核对结束后再发出。
  expect(sessionSyncFrames(harness.sent)).toHaveLength(1);
  expect(harness.onState).toHaveBeenLastCalledWith({ hasEarlier: true, loading: true });

  harness.loader.receive(historyFrame("request-1", numberedEvents(50, 1)));
  expect(await check).toBe("event-50");
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent).at(-1)).toMatchObject({ id: "request-2", before: 81, limit: 80 });
  harness.loader.receive(historyFrame("request-2"));
  expect(await page).toBe(true);
  expect(harness.onPage).toHaveBeenCalledTimes(1);
});

test("sends each history request with the current leaf and accepts only responses for that leaf", async () => {
  let leaf = "generation";
  const harness = createHarness({ currentLeafId: () => leaf });
  leaf = "advanced";
  const page = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent)).toEqual([expect.objectContaining({ leaf_id: "advanced", before: 81, limit: 80 })]);
  // 旧 leaf 的响应不被接受。
  expect(harness.loader.receive(historyFrame("request-1"))).toBe(false);
  expect(harness.loader.receive({ ...historyFrame("request-1"), leaf_id: "advanced" })).toBe(true);
  expect(await page).toBe(true);
});

function upgradeRequired(requestId: string): ServerFrame {
  return { protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId, in_reply_to: requestId, code: "protocol_upgrade_required", message: "Protocol v2 is required" };
}

test("loads a 160-event page in one request", async () => {
  const harness = createHarness({ headSeq: 200 });
  const page = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent)).toEqual([expect.objectContaining({ id: "request-1", before: 201, limit: 160 })]);
  harness.loader.receive(historyFrame("request-1", numberedEvents(41, 160)));
  expect(await page).toBe(true);
  expect(harness.onPage).toHaveBeenCalledWith(numberedEvents(41, 160));
});

test("an extension that only accepts 80 events gets the same page in 80-event requests from then on", async () => {
  const harness = createHarness({ headSeq: 400 });
  const first = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(harness.loader.receive(upgradeRequired("request-1"))).toBe(true);
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent).at(-1)).toMatchObject({ id: "request-2", before: 401, limit: 80 });
  harness.loader.receive(historyFrame("request-2", numberedEvents(321, 80)));
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent).at(-1)).toMatchObject({ id: "request-3", before: 321, limit: 80 });
  harness.loader.receive(historyFrame("request-3", numberedEvents(241, 80)));
  expect(await first).toBe(true);
  expect(harness.onPage).toHaveBeenLastCalledWith(numberedEvents(241, 160));
  expect(harness.onError).not.toHaveBeenCalled();

  // 降级只发生一次，后续页直接按 80 拆分。
  const second = harness.loader.loadEarlier();
  await flushMicrotasks();
  expect(sessionSyncFrames(harness.sent).at(-1)).toMatchObject({ id: "request-4", before: 241, limit: 80 });
  harness.loader.receive(historyFrame("request-4", numberedEvents(161, 80)));
  await flushMicrotasks();
  harness.loader.receive(historyFrame("request-5", numberedEvents(81, 80)));
  expect(await second).toBe(true);
  expect(harness.onPage).toHaveBeenLastCalledWith(numberedEvents(81, 160));
});

test("other errors and a repeated upgrade refusal still fail the page without retrying", async () => {
  const other = createHarness({ headSeq: 200 });
  const failed = other.loader.loadEarlier();
  await flushMicrotasks();
  other.loader.receive({ protocol_version: 2, type: "protocol_error", target_channel_id: scope.channelId, in_reply_to: "request-1", code: "invalid_cursor", message: "bad cursor" });
  expect(await failed).toBe(false);
  expect(sessionSyncFrames(other.sent)).toHaveLength(1);
  expect(other.onError).toHaveBeenCalledWith("bad cursor");

  const repeated = createHarness({ headSeq: 200 });
  const refused = repeated.loader.loadEarlier();
  await flushMicrotasks();
  repeated.loader.receive(upgradeRequired("request-1"));
  await flushMicrotasks();
  repeated.loader.receive(upgradeRequired("request-2"));
  expect(await refused).toBe(false);
  expect(sessionSyncFrames(repeated.sent)).toHaveLength(2);
  expect(repeated.onError).toHaveBeenCalledTimes(1);
  expect(repeated.onPage).not.toHaveBeenCalled();
});
