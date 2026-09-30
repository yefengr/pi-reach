import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import { matchesFormalMessage } from "./timeline-identity";
import type { TimelinePartialView, TimelinePending, TimelineViewItem } from "./timeline-runtime";

const DRAIN_TICKS = 8;
const MAX_RELEASE_PER_TICK = 64;
const graphemeSegmenter = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

type StreamState = {
  partial: TimelinePartialView;
  targetText: string;
  targetGraphemes: string[];
  visibleCount: number;
  visibleText: string;
  ticks: number;
  seen: boolean;
};

type NonStreamToken =
  | { kind: "event"; id: string; event: TimelineEvent }
  | {
    kind: "pending";
    id: string;
    clientRequestId: string;
    text: string;
    images: TimelinePending["images"];
    createdAt: number;
    delivery: TimelinePending["delivery"];
    cancelable: boolean | undefined;
    queued: boolean | undefined;
    queuedAction: TimelinePending["queuedAction"];
    queuedActionRequestId: string | undefined;
    insertionStatus: TimelinePending["insertionStatus"];
    insertionRequestedAt: number | undefined;
    insertionNoticeDismissed: boolean | undefined;
    messageId: string | undefined;
  };

export type StreamDisplayBufferChange = {
  items: TimelineViewItem[];
  shouldRender: boolean;
  hasPending: boolean;
};

function partialText(partial: TimelinePartial): string {
  if (partial.blocks !== undefined) return partial.blocks.map((block) => block.text).join("\n");
  return partial.delta ?? "";
}

function hasBlocks(partial: TimelinePartial): boolean {
  return partial.blocks !== undefined;
}

function streamsImmediately(partial: TimelinePartial): boolean {
  return partial.kind === "tool" || hasBlocks(partial);
}

function segmentText(text: string): string[] {
  if (graphemeSegmenter) return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
  return Array.from(text);
}

function appendTargetGraphemes(previous: StreamState, targetText: string): void {
  const suffix = targetText.slice(previous.targetText.length);
  const lastGrapheme = previous.targetGraphemes.pop();
  if (lastGrapheme === undefined) {
    previous.targetGraphemes.push(...segmentText(suffix));
    return;
  }
  previous.targetGraphemes.push(...segmentText(`${lastGrapheme}${suffix}`));
}

function itemId(item: TimelineViewItem): string {
  if (item.kind === "event") return item.event.event_id;
  if (item.kind === "partial") return item.partial.partial_id;
  return item.clientRequestId;
}

function sameItem(a: TimelineViewItem, b: TimelineViewItem): boolean {
  if (a.kind !== b.kind || itemId(a) !== itemId(b)) return false;
  if (a.kind === "event" && b.kind === "event") return a.event === b.event;
  if (a.kind === "pending" && b.kind === "pending") {
    return a.delivery === b.delivery
      && a.text === b.text
      && a.createdAt === b.createdAt
      && a.messageId === b.messageId
      && a.cancelable === b.cancelable
      && a.queued === b.queued
      && a.queuedAction === b.queuedAction
      && a.queuedActionRequestId === b.queuedActionRequestId
      && a.insertionStatus === b.insertionStatus
      && a.insertionRequestedAt === b.insertionRequestedAt
      && a.insertionNoticeDismissed === b.insertionNoticeDismissed
      && a.images === b.images;
  }
  if (a.kind === "partial" && b.kind === "partial") return partialText(a.partial) === partialText(b.partial);
  return false;
}

function sameItems(a: readonly TimelineViewItem[], b: readonly TimelineViewItem[]): boolean {
  return a.length === b.length && a.every((item, index) => sameItem(item, b[index]));
}

function nonStreamTokens(items: readonly TimelineViewItem[]): NonStreamToken[] {
  const tokens: NonStreamToken[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      tokens.push({ kind: "event", id: item.event.event_id, event: item.event });
      continue;
    }
    if (item.kind === "pending") {
      tokens.push({
        kind: "pending",
        id: item.id,
        clientRequestId: item.clientRequestId,
        text: item.text,
        images: item.images,
        createdAt: item.createdAt,
        delivery: item.delivery,
        cancelable: item.cancelable,
        queued: item.queued,
        queuedAction: item.queuedAction,
        queuedActionRequestId: item.queuedActionRequestId,
        insertionStatus: item.insertionStatus,
        insertionRequestedAt: item.insertionRequestedAt,
        insertionNoticeDismissed: item.insertionNoticeDismissed,
        messageId: item.messageId,
      });
    }
  }
  return tokens;
}

function sameNonStreamTokens(a: readonly NonStreamToken[], b: readonly NonStreamToken[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((token, index) => {
    const next = b[index];
    if (token.kind !== next.kind || token.id !== next.id) return false;
    if (token.kind === "event" && next.kind === "event") return token.event === next.event;
    if (token.kind === "pending" && next.kind === "pending") {
      return token.clientRequestId === next.clientRequestId
        && token.text === next.text
        && token.images === next.images
        && token.createdAt === next.createdAt
        && token.delivery === next.delivery
        && token.cancelable === next.cancelable
        && token.queued === next.queued
        && token.queuedAction === next.queuedAction
        && token.queuedActionRequestId === next.queuedActionRequestId
        && token.insertionStatus === next.insertionStatus
        && token.insertionRequestedAt === next.insertionRequestedAt
        && token.insertionNoticeDismissed === next.insertionNoticeDismissed
        && token.messageId === next.messageId;
    }
    return false;
  });
}

function projectedPartial(state: StreamState): TimelinePartialView {
  const partial = hasBlocks(state.partial.partial)
    ? state.partial.partial
    : { ...state.partial.partial, delta: state.visibleText };
  return { ...state.partial, partial };
}

function expectedVisibleText(state: StreamState): string {
  return state.targetGraphemes.slice(0, state.visibleCount).join("");
}

function isDrained(state: StreamState): boolean {
  return state.visibleCount >= state.targetGraphemes.length && state.visibleText === state.targetText;
}

/**
 * Projects authoritative timeline snapshots into a paced display snapshot.
 * The runtime remains authoritative; this class only owns the transient display cursor.
 */
export class StreamDisplayBuffer {
  private authoritative: TimelineViewItem[] = [];
  private displayed: TimelineViewItem[] = [];
  private renderedNonStreamTokens: NonStreamToken[] = [];
  private readonly streams = new Map<string, StreamState>();

  ingest(authoritative: readonly TimelineViewItem[]): StreamDisplayBufferChange {
    const previous = this.displayed;
    this.authoritative = [...authoritative];
    const formalEvents = this.formalEvents();
    const currentPartials = new Map(
      this.authoritative
        .filter((item): item is TimelinePartialView => item.kind === "partial")
        .map((item) => [item.partial.partial_id, item]),
    );
    let needsSnapshot = !sameNonStreamTokens(this.renderedNonStreamTokens, nonStreamTokens(this.authoritative));

    for (const state of this.streams.values()) state.seen = false;
    for (const partial of currentPartials.values()) {
      const id = partial.partial.partial_id;
      const targetText = partialText(partial.partial);
      const existing = this.streams.get(id);
      if (!existing) {
        const targetGraphemes = segmentText(targetText);
        const immediate = streamsImmediately(partial.partial);
        const visibleCount = immediate ? targetGraphemes.length : Math.min(2, targetGraphemes.length);
        this.streams.set(id, {
          partial,
          targetText,
          targetGraphemes,
          visibleCount,
          visibleText: targetGraphemes.slice(0, visibleCount).join(""),
          ticks: immediate ? DRAIN_TICKS : 0,
          seen: true,
        });
        needsSnapshot = true;
        continue;
      }

      const targetChanged = existing.targetText !== targetText;
      const immediate = streamsImmediately(partial.partial);
      if (targetChanged && immediate) {
        const targetGraphemes = segmentText(targetText);
        existing.targetText = targetText;
        existing.targetGraphemes = targetGraphemes;
        existing.visibleCount = targetGraphemes.length;
        existing.visibleText = targetText;
        existing.ticks = DRAIN_TICKS;
        needsSnapshot = true;
      } else if (targetChanged && targetText.startsWith(existing.targetText)) {
        appendTargetGraphemes(existing, targetText);
        existing.targetText = targetText;
        existing.visibleCount = Math.min(existing.visibleCount, existing.targetGraphemes.length);
        // New output starts a fresh catch-up window, including after this lane drained.
        existing.ticks = 0;
      } else if (targetChanged) {
        const targetGraphemes = segmentText(targetText);
        existing.targetText = targetText;
        existing.targetGraphemes = targetGraphemes;
        existing.visibleCount = Math.min(2, targetGraphemes.length);
        existing.visibleText = targetGraphemes.slice(0, existing.visibleCount).join("");
        existing.ticks = 0;
        needsSnapshot = true;
      } else if (immediate && !streamsImmediately(existing.partial.partial)) {
        existing.visibleCount = existing.targetGraphemes.length;
        existing.visibleText = targetText;
        existing.ticks = DRAIN_TICKS;
        needsSnapshot = true;
      }
      existing.partial = partial;
      existing.seen = true;
    }

    for (const [id, state] of this.streams) {
      const formal = formalEvents.some((event) => matchesFormalMessage(state.partial.partial, event));
      // 正式版本立即接管对应消息，不延迟完成状态，也不重播已完成文字。
      if (!state.seen || formal) {
        this.streams.delete(id);
        needsSnapshot = true;
      }
    }

    if (!needsSnapshot) return this.unchanged();
    return this.rebuild(previous, true);
  }

  reset(authoritative: readonly TimelineViewItem[]): StreamDisplayBufferChange {
    const previous = this.displayed;
    this.authoritative = [...authoritative];
    this.streams.clear();
    const partials = this.authoritative.filter((item): item is TimelinePartialView => item.kind === "partial");
    for (const partial of partials) {
      const targetText = partialText(partial.partial);
      const targetGraphemes = segmentText(targetText);
      this.streams.set(partial.partial.partial_id, {
        partial,
        targetText,
        targetGraphemes,
        visibleCount: targetGraphemes.length,
        visibleText: targetText,
        ticks: DRAIN_TICKS,
        seen: true,
      });
    }
    const formalEvents = this.formalEvents();
    for (const [id, state] of this.streams) {
      if (formalEvents.some((event) => matchesFormalMessage(state.partial.partial, event))) this.streams.delete(id);
    }
    return this.rebuild(previous, true);
  }

  snapshot(): TimelineViewItem[] {
    return [...this.displayed];
  }

  advance(): StreamDisplayBufferChange {
    const previous = this.displayed;
    let changed = false;
    for (const state of this.streams.values()) {
      const backlog = state.targetGraphemes.length - state.visibleCount;
      if (backlog > 0) {
        state.ticks += 1;
        const ticksLeft = Math.max(1, DRAIN_TICKS - state.ticks + 1);
        const release = Math.min(MAX_RELEASE_PER_TICK, Math.max(1, Math.ceil(backlog / ticksLeft)));
        state.visibleCount = Math.min(state.targetGraphemes.length, state.visibleCount + release);
        state.visibleText = expectedVisibleText(state);
        changed = true;
      } else if (state.visibleText !== expectedVisibleText(state)) {
        state.visibleText = expectedVisibleText(state);
        changed = true;
      }
    }
    if (!changed) return this.unchanged();
    return this.rebuild(previous, true);
  }

  hasPending(): boolean {
    return [...this.streams.values()].some((state) => !isDrained(state));
  }

  private formalEvents(): TimelineEvent[] {
    return this.authoritative
      .filter((item): item is Extract<TimelineViewItem, { kind: "event" }> => item.kind === "event")
      .map((item) => item.event);
  }

  private buildSnapshot(): TimelineViewItem[] {
    // 保留运行态顺序；主机 timestamp 和浏览器 createdAt 不能用于跨端比较。
    return this.authoritative.flatMap((item): TimelineViewItem[] => {
      if (item.kind !== "partial") return [item];
      const state = this.streams.get(item.partial.partial_id);
      return state ? [projectedPartial(state)] : [];
    });
  }

  private rebuild(previous: readonly TimelineViewItem[], forceRender: boolean): StreamDisplayBufferChange {
    this.displayed = this.buildSnapshot();
    this.renderedNonStreamTokens = nonStreamTokens(this.authoritative);
    return this.change(previous, forceRender);
  }

  private unchanged(): StreamDisplayBufferChange {
    return { items: this.snapshot(), shouldRender: false, hasPending: this.hasPending() };
  }

  private change(previous: readonly TimelineViewItem[], forceRender: boolean): StreamDisplayBufferChange {
    return {
      items: this.snapshot(),
      shouldRender: forceRender || !sameItems(previous, this.displayed),
      hasPending: this.hasPending(),
    };
  }
}
