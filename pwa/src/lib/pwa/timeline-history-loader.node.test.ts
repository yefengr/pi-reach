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
  "headSeq" | "boundary" | "send" | "load" | "persist" | "requestId" | "timeoutMs"
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
