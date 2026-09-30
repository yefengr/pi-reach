import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { HistoryWindowAssembler, type HistoryWindowResult } from "./timeline-transfer";
import type { TimelineScope as RuntimeTimelineScope } from "./timeline-runtime";
import { TIMELINE_RECENT_LIMIT } from "./timeline-reconnect";
import type { TimelineScope as StoreTimelineScope } from "./timeline-store";

const PAGE_SIZE = 80;
const DEFAULT_TIMEOUT_MS = 15_000;
const CANCELLED = Symbol("timeline-history-loader-cancelled");

type Cancelled = typeof CANCELLED;
type SequenceRange = { start: number; end: number };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};
type ActiveRequest = {
  id: string;
  range: SequenceRange;
  assembler: HistoryWindowAssembler;
  deferred: Deferred<HistoryWindowResult>;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
type PageOperation = {
  token: number;
  page: SequenceRange;
  events: Map<number, TimelineEvent>;
  eventSequences: Map<string, number>;
  cancelled: Deferred<void>;
  promise: Promise<boolean>;
  request: ActiveRequest | null;
};

export type TimelineHistoryLoaderOptions = {
  scope: RuntimeTimelineScope;
  headSeq: number;
  /** Exclusive lower-history cursor; defaults to the sequence after the current head. */
  boundary?: number;
  send: (frame: ClientFrame) => boolean;
  load: (scope: StoreTimelineScope) => Promise<TimelineEvent[]>;
  persist: (scope: StoreTimelineScope, events: readonly TimelineEvent[]) => Promise<void>;
  onPage: (events: TimelineEvent[]) => void;
  onState: (state: { hasEarlier: boolean; loading: boolean }) => void;
  onError: (message: string) => void;
  requestId?: () => string;
  timeoutMs?: number;
};

class TimelineHistoryLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineHistoryLoaderError";
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isPositiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHeadSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 1;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function findMissingRanges(events: ReadonlyMap<number, TimelineEvent>, page: SequenceRange): SequenceRange[] {
  const ranges: SequenceRange[] = [];
  let start: number | null = null;
  for (let sequence = page.start; sequence <= page.end; sequence += 1) {
    if (events.has(sequence)) {
      if (start !== null) {
        ranges.push({ start, end: sequence - 1 });
        start = null;
      }
      continue;
    }
    if (start === null) start = sequence;
  }
  if (start !== null) ranges.push({ start, end: page.end });
  return ranges;
}

function defaultRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Loads one immutable, dense history range before exposing any part of it. */
export class TimelineHistoryLoader {
  private readonly scope: RuntimeTimelineScope;
  private readonly headSeq: number;
  private readonly timeoutMs: number;
  private readonly requestId: () => string;
  private boundary: number;
  private active: PageOperation | null = null;
  private disposed = false;
  private token = 0;

  constructor(private readonly options: TimelineHistoryLoaderOptions) {
    if (!isHeadSequence(options.headSeq)) throw new Error("headSeq must be a nonnegative safe integer.");
    if (options.boundary !== undefined && (!isPositiveSequence(options.boundary) || options.boundary > options.headSeq + 1)) {
      throw new Error("boundary must be a positive safe integer at or before headSeq + 1.");
    }
    this.scope = { ...options.scope };
    this.headSeq = options.headSeq;
    this.boundary = options.boundary ?? options.headSeq + 1;
    this.requestId = options.requestId ?? defaultRequestId;
    this.timeoutMs = options.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.emitState(false);
  }

  get hasEarlier(): boolean {
    return this.boundary > 1;
  }

  loadEarlier(): Promise<boolean> {
    if (this.disposed || !this.hasEarlier) return Promise.resolve(false);
    return this.loadPage({ start: Math.max(1, this.boundary - PAGE_SIZE), end: this.boundary - 1 });
  }

  loadRange(start: number, end: number): Promise<boolean> {
    if (this.disposed || !isPositiveSequence(start) || !isPositiveSequence(end) || start > end || end > this.headSeq || end - start + 1 > TIMELINE_RECENT_LIMIT) {
      return Promise.resolve(false);
    }
    return this.loadPage({ start, end });
  }

  private loadPage(range: SequenceRange): Promise<boolean> {
    if (this.active) return this.active.promise;

    const page: PageOperation = {
      token: ++this.token,
      page: range,
      events: new Map(),
      eventSequences: new Map(),
      cancelled: createDeferred<void>(),
      promise: Promise.resolve(false),
      request: null,
    };
    this.active = page;
    page.promise = this.run(page);
    this.emitState(true);
    return page.promise;
  }

  receive(frame: ServerFrame): boolean {
    const page = this.active;
    const request = page?.request;
    if (!page || !request || !this.isCurrent(page)) return false;

    if (frame.type === "protocol_error") {
      if (
        frame.in_reply_to !== request.id
        || ("target_channel_id" in frame && frame.target_channel_id !== this.scope.channelId)
      ) return false;
      this.rejectRequest(request, new TimelineHistoryLoaderError(frame.message));
      return true;
    }
    if (frame.type !== "session_history_chunk" || frame.in_reply_to !== request.id) return false;
    if (
      frame.target_channel_id !== this.scope.channelId
      || frame.session_id !== this.scope.sessionId
      || frame.leaf_id !== this.scope.leafId
    ) return false;

    const result = request.assembler.accept(frame);
    if (result.status === "pending" || result.status === "ignored") return true;
    if (result.status === "discarded") {
      this.rejectRequest(request, new TimelineHistoryLoaderError("History response was invalid."));
      return true;
    }
    this.resolveRequest(request, result);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token += 1;
    const page = this.active;
    this.active = null;
    if (!page) return;
    this.clearRequest(page.request);
    page.cancelled.resolve();
  }

  private async run(page: PageOperation): Promise<boolean> {
    let cached: TimelineEvent[] = [];
    try {
      const loaded = await this.waitFor(page, this.options.load(this.scope));
      if (loaded === CANCELLED) return false;
      cached = loaded;
    } catch {
      // A failed local read must not prevent an authoritative full-page fetch.
      cached = [];
    }
    if (!this.isCurrent(page)) return false;

    try {
      this.seedCache(page, cached);
      if (!await this.loadMissingRanges(page) || !this.isCurrent(page)) return false;
      const events = this.completePage(page);
      try {
        const persisted = await this.waitFor(page, this.options.persist(this.scope, events));
        if (persisted === CANCELLED) return false;
      } catch {
        throw new TimelineHistoryLoaderError("Could not update local history.");
      }
      if (!this.isCurrent(page)) return false;
      this.boundary = Math.min(this.boundary, page.page.start);
      this.active = null;
      this.options.onPage(events);
      this.emitState(false);
      return true;
    } catch (error) {
      if (!this.isCurrent(page)) return false;
      this.fail(page, error instanceof TimelineHistoryLoaderError ? error.message : "Could not load earlier history.");
      return false;
    }
  }

  private async loadMissingRanges(page: PageOperation): Promise<boolean> {
    const gaps = findMissingRanges(page.events, page.page);
    for (const gap of gaps) {
      let end = gap.end;
      while (end >= gap.start) {
        const result = await this.requestRange(page, { start: gap.start, end });
        if (result === CANCELLED) return false;
        const firstSequence = this.acceptResponse(page, { start: gap.start, end }, result);
        end = firstSequence - 1;
      }
    }
    return true;
  }

  private async requestRange(page: PageOperation, range: SequenceRange): Promise<HistoryWindowResult | Cancelled> {
    const requestId = this.requestId();
    if (!requestId) throw new TimelineHistoryLoaderError("Could not create a history request.");
    const request: ActiveRequest = {
      id: requestId,
      range,
      assembler: new HistoryWindowAssembler(requestId, { session_id: this.scope.sessionId, leaf_id: this.scope.leafId }),
      deferred: createDeferred<HistoryWindowResult>(),
      settled: false,
      timer: null,
    };
    page.request = request;

    const frame: Extract<ClientFrame, { type: "session_sync" }> = {
      protocol_version: 2,
      type: "session_sync",
      id: request.id,
      channel_id: this.scope.channelId,
      session_id: this.scope.sessionId,
      leaf_id: this.scope.leafId,
      before: range.end + 1,
      limit: range.end - range.start + 1,
    };
    let sent = false;
    try {
      sent = this.options.send(frame);
    } catch {
      throw new TimelineHistoryLoaderError("Could not request earlier history.");
    }
    if (!sent) {
      if (page.request === request) page.request = null;
      throw new TimelineHistoryLoaderError("Relay is not connected.");
    }
    if (!request.settled) {
      request.timer = setTimeout(() => {
        if (this.isCurrent(page) && page.request === request) {
          this.rejectRequest(request, new TimelineHistoryLoaderError("History request timed out."));
        }
      }, this.timeoutMs);
    }

    let result: HistoryWindowResult | Cancelled;
    try {
      result = await this.waitFor(page, request.deferred.promise);
    } finally {
      if (page.request === request) page.request = null;
      this.clearRequest(request);
    }
    return result;
  }

  private acceptResponse(page: PageOperation, range: SequenceRange, result: HistoryWindowResult): number {
    if (result.status !== "complete" || result.events.length === 0) {
      throw new TimelineHistoryLoaderError("History response made no progress.");
    }

    let firstSequence: number | null = null;
    let previousSequence: number | null = null;
    for (const event of result.events) {
      if (!isPositiveSequence(event.event_seq)) throw new TimelineHistoryLoaderError("History response omitted an event sequence.");
      const sequence = event.event_seq;
      if (sequence < range.start || sequence > range.end) {
        throw new TimelineHistoryLoaderError("History response was outside the requested range.");
      }
      if (previousSequence !== null && sequence !== previousSequence + 1) {
        throw new TimelineHistoryLoaderError("History response was not contiguous.");
      }
      firstSequence ??= sequence;
      previousSequence = sequence;
    }
    if (firstSequence === null || previousSequence !== range.end) {
      throw new TimelineHistoryLoaderError("History response made no progress.");
    }
    if (result.eos) {
      if (firstSequence !== 1) throw new TimelineHistoryLoaderError("History response had an invalid end marker.");
    } else if (result.next_before !== firstSequence) {
      throw new TimelineHistoryLoaderError("History response had an invalid cursor.");
    }

    for (const event of result.events) this.mergePageEvent(page, event);
    return firstSequence;
  }

  private seedCache(page: PageOperation, cached: readonly TimelineEvent[]): void {
    const idsBySequence = new Map<number, string>();
    for (const event of cached) {
      if (event.session_id !== this.scope.sessionId) {
        throw new TimelineHistoryLoaderError("Cached timeline belongs to another session.");
      }
      if (event.event_seq === undefined) continue;
      if (!isPositiveSequence(event.event_seq)) throw new TimelineHistoryLoaderError("Cached timeline has an invalid event sequence.");
      const previousSequence = page.eventSequences.get(event.event_id);
      if (previousSequence !== undefined && previousSequence !== event.event_seq) {
        throw new TimelineHistoryLoaderError("Cached timeline has conflicting event sequences.");
      }
      const previousId = idsBySequence.get(event.event_seq);
      if (previousId !== undefined && previousId !== event.event_id) {
        throw new TimelineHistoryLoaderError("Cached timeline has conflicting event sequences.");
      }
      page.eventSequences.set(event.event_id, event.event_seq);
      idsBySequence.set(event.event_seq, event.event_id);
      if (event.event_seq >= page.page.start && event.event_seq <= page.page.end) this.mergePageEvent(page, event);
    }
  }

  private mergePageEvent(page: PageOperation, event: TimelineEvent): void {
    if (event.session_id !== this.scope.sessionId) {
      throw new TimelineHistoryLoaderError("History response belongs to another session.");
    }
    if (!isPositiveSequence(event.event_seq)) throw new TimelineHistoryLoaderError("History response omitted an event sequence.");
    const sequence = event.event_seq;
    const previousSequence = page.eventSequences.get(event.event_id);
    if (previousSequence !== undefined && previousSequence !== sequence) {
      throw new TimelineHistoryLoaderError("History response has conflicting event sequences.");
    }
    const previous = page.events.get(sequence);
    if (previous !== undefined && (previous.event_id !== event.event_id || !sameValue(previous, event))) {
      throw new TimelineHistoryLoaderError("History response has conflicting events.");
    }
    page.eventSequences.set(event.event_id, sequence);
    page.events.set(sequence, event);
  }

  private completePage(page: PageOperation): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    for (let sequence = page.page.start; sequence <= page.page.end; sequence += 1) {
      const event = page.events.get(sequence);
      if (!event) throw new TimelineHistoryLoaderError("History page was incomplete.");
      events.push(event);
    }
    return events;
  }

  private waitFor<T>(page: PageOperation, promise: Promise<T>): Promise<T | Cancelled> {
    return Promise.race([promise, page.cancelled.promise.then(() => CANCELLED)]) as Promise<T | Cancelled>;
  }

  private resolveRequest(request: ActiveRequest, result: HistoryWindowResult): void {
    if (request.settled) return;
    request.settled = true;
    this.clearRequest(request);
    request.deferred.resolve(result);
  }

  private rejectRequest(request: ActiveRequest, error: TimelineHistoryLoaderError): void {
    if (request.settled) return;
    request.settled = true;
    this.clearRequest(request);
    request.deferred.reject(error);
  }

  private clearRequest(request: ActiveRequest | null): void {
    if (!request || request.timer === null) return;
    clearTimeout(request.timer);
    request.timer = null;
  }

  private fail(page: PageOperation, message: string): void {
    this.clearRequest(page.request);
    this.active = null;
    this.emitState(false);
    this.options.onError(message);
  }

  private isCurrent(page: PageOperation): boolean {
    return !this.disposed && this.active === page && page.token === this.token;
  }

  private emitState(loading: boolean): void {
    if (!this.disposed) this.options.onState({ hasEarlier: this.hasEarlier, loading });
  }
}
