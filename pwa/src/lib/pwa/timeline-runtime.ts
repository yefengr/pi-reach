import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import { parseTimelineEventV2, parseTimelinePartialV2 } from "../pi-reach/protocol-v2/codec";
import { TIMELINE_RECENT_LIMIT } from "./timeline-reconnect";
import { matchesFormalMessage, partialMessageIdentity } from "./timeline-identity";
import { createTimelineReplacement, type TimelineReplacementBranch } from "./timeline-replacement";
import {
  DEFAULT_TIMELINE_PENDING_LIMITS,
  PendingCapacityError,
  exceedsPendingCapacity,
  normalizeTimelinePendingLimits,
  type PendingPayload,
  type TimelinePendingLimits,
} from "./timeline-pending";

export { PendingCapacityError } from "./timeline-pending";
type UserMessageFrame = Extract<ClientFrame, { type: "user_message" }>;
type UserMessageImages = NonNullable<UserMessageFrame["images"]>;
type UserMessageSendResult = { frame: UserMessageFrame; change: TimelineRuntimeChange };

/** A timeline's live scope is endpoint/runtime-bound while persistence omits runtime. */
export type TimelineScope = {
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  sessionId: string;
  leafId: string | null;
  selfSenderRef: string;
  channelId: string;
};

export const QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS = 30_000;
export type PendingDelivery = "pending" | "received" | "accepted" | "committed" | "unknown_delivery";
export type QueuedInsertionStatus = "waiting" | "unconfirmed";
export type TimelinePending = {
  kind: "pending";
  id: string;
  clientRequestId: string;
  text: string;
  images?: UserMessageImages;
  cancelable?: boolean;
  queued?: boolean;
  queuedAction?: "insert" | "cancel";
  queuedActionRequestId?: string;
  insertionStatus?: QueuedInsertionStatus;
  insertionRequestedAt?: number;
  insertionNoticeDismissed?: boolean;
  createdAt: number;
  delivery: PendingDelivery;
  requestId: string;
  messageId?: string;
};
export type TimelinePartialView = { kind: "partial"; partial: TimelinePartial; createdAt: number };
export type TimelineViewItem = { kind: "event"; event: TimelineEvent } | TimelinePending | TimelinePartialView;
/** 本端撤回的排队消息：取消已被权威快照确认，文字与图片可放回输入区。 */
export type QueuedCancellation = { clientRequestId: string; text: string; images?: UserMessageImages };
export type TimelineRuntimeChange = {
  items: TimelineViewItem[];
  committed: TimelineEvent[];
  observed: ClientFrame[];
  unknown: TimelinePending[];
  pendingCapacityExceeded?: boolean;
  newLiveEvent?: boolean;
  tipAdvanced?: boolean;
  reset?: Extract<ServerFrame, { type: "reset" }>;
  cancelledQueued?: QueuedCancellation[];
};
export type TimelineLivePlan = {
  mode: "append" | "replace";
  startSeq: number | null;
  endSeq: number;
  earliestSeq: number | null;
};
export type TimelineLivePreparation = { change: TimelineRuntimeChange; plan: TimelineLivePlan };
type Pending = TimelinePending & { scope: TimelineScope; insertionRejected?: boolean };
type QueueItem = Extract<ServerFrame, { type: "queued_message_state" }>["items"][number];

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function compareItems(a: TimelineViewItem, b: TimelineViewItem): number {
  if (a.kind === "event" && b.kind === "event" && a.event.event_seq !== undefined && b.event.event_seq !== undefined) {
    return a.event.event_seq - b.event.event_seq || a.event.event_id.localeCompare(b.event.event_id);
  }
  if (a.kind === "event" && a.event.event_seq !== undefined && b.kind !== "event") return -1;
  if (b.kind === "event" && b.event.event_seq !== undefined && a.kind !== "event") return 1;
  // Map 的插入顺序记录首次观察顺序，不能用同毫秒的随机 ID 重新排列流式调用。
  if (a.kind !== "event" && b.kind !== "event") return 0;
  const aTime = a.kind === "event" ? a.event.timestamp : a.createdAt;
  const bTime = b.kind === "event" ? b.event.timestamp : b.createdAt;
  return aTime - bTime || itemId(a).localeCompare(itemId(b));
}
function itemId(item: TimelineViewItem): string {
  return item.kind === "event" ? item.event.event_id : item.kind === "partial" ? item.partial.partial_id : item.clientRequestId;
}
function isHeadSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 1;
}
function isEventSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isSameLiveScope(left: TimelineScope | null, right: TimelineScope): boolean {
  return left !== null && left.deviceId === right.deviceId && left.endpointId === right.endpointId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.sessionId === right.sessionId;
}
function isSamePendingScope(left: TimelineScope | null, right: TimelineScope): boolean {
  return left !== null && left.deviceId === right.deviceId && left.endpointId === right.endpointId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.sessionId === right.sessionId
    && left.selfSenderRef === right.selfSenderRef;
}
function isSameSession(scope: TimelineScope | null, frame: { session_id: string }): boolean {
  return scope !== null && scope.sessionId === frame.session_id;
}
function isMatchingScope(scope: TimelineScope | null, frame: { session_id: string; leaf_id: string | null }): boolean {
  return scope !== null && scope.sessionId === frame.session_id && scope.leafId === frame.leaf_id;
}
function mergePartial(previous: TimelinePartial | undefined, next: TimelinePartial): TimelinePartial {
  if (!previous || ("blocks" in next && next.blocks !== undefined)) return next;
  if (next.delta === undefined) return { ...next, ...(previous.delta === undefined ? {} : { delta: previous.delta }) };
  return { ...next, delta: `${previous.delta ?? ""}${next.delta}` };
}

/** In-memory v2 timeline state. It never persists pending or partial output. */
export class TimelineRuntime {
  private readonly limits: TimelinePendingLimits;
  private scope: TimelineScope | null = null;
  private replacement: TimelineReplacementBranch | null = null;
  private liveHeadSeq: number | null = null;
  private readonly events = new Map<string, TimelineEvent>();
  private readonly partials = new Map<string, TimelinePartialView>();
  private readonly pending = new Map<string, Pending>();
  private unknown: Pending[] = [];
  private queuedSnapshotId: string | null = null;
  private readonly queuedSnapshotItems = new Map<string, QueueItem>();
  private readonly observedQueue: ClientFrame[] = [];
  private rejectedQueuedSnapshotId: string | null = null;

  constructor(limits: Partial<TimelinePendingLimits> = {}) {
    this.limits = normalizeTimelinePendingLimits({ ...DEFAULT_TIMELINE_PENDING_LIMITS, ...limits });
  }

  setScope(scope: TimelineScope): TimelineRuntimeChange {
    this.removeReplacedEndpointEntries(scope);
    if (!isSameLiveScope(this.scope, scope)) {
      this.clearTransient(true);
      this.events.clear();
    }
    this.scope = scope;
    this.replacement = null;
    return this.change();
  }
  beginLive(scope: TimelineScope, headSeq: number): TimelineRuntimeChange {
    this.setScope(scope);
    this.clearTransient(true);
    this.events.clear();
    this.liveHeadSeq = headSeq;
    return this.change();
  }
  prepareLive(scope: TimelineScope, headSeq: number): TimelineLivePreparation {
    if (this.scope && this.scope.selfSenderRef !== scope.selfSenderRef) {
      this.removeEntries((pending) => pending.scope.deviceId === scope.deviceId
        && pending.scope.endpointId === scope.endpointId
        && pending.scope.runtimeInstanceId === scope.runtimeInstanceId
        && pending.scope.sessionId === scope.sessionId);
    }
    const safeHeadSeq = isHeadSequence(headSeq) ? headSeq : 0;
    const canAppend = isHeadSequence(headSeq) && this.replacement === null && (this.scope === null && this.events.size === 0 && this.unknown.length === 0 || isSameLiveScope(this.scope, scope));
    const retained = this.contiguousFormalRange();
    if (canAppend && !retained && safeHeadSeq === 0) {
      this.clearTransient(true);
      this.scope = scope;
      this.liveHeadSeq = 0;
      return { change: this.change(), plan: { mode: "append", startSeq: null, endSeq: 0, earliestSeq: null } };
    }
    if (canAppend && retained && safeHeadSeq >= retained.maxSeq) {
      this.clearTransient(true);
      this.scope = scope;
      this.liveHeadSeq = safeHeadSeq;
      const gap = safeHeadSeq - retained.maxSeq;
      if (gap <= TIMELINE_RECENT_LIMIT) return { change: this.change(), plan: { mode: "append", startSeq: gap === 0 ? null : retained.maxSeq + 1, endSeq: safeHeadSeq, earliestSeq: retained.minSeq } };
    }

    this.replacement ??= createTimelineReplacement(this.events.values());
    this.events.clear();
    this.removeReplacedEndpointEntries(scope);
    this.clearTransient(true);
    this.scope = scope;
    this.liveHeadSeq = safeHeadSeq;
    const startSeq = safeHeadSeq === 0 ? null : Math.max(1, safeHeadSeq - TIMELINE_RECENT_LIMIT + 1);
    return { change: this.change(), plan: { mode: "replace", startSeq, endSeq: safeHeadSeq, earliestSeq: startSeq } };
  }
  cancelReplacement(): TimelineRuntimeChange {
    if (!this.replacement) return this.change();
    const previous = this.replacement.previousEvents;
    this.removeCurrentScopeEntries();
    this.clearTransient(false);
    this.events.clear();
    for (const event of previous) this.events.set(event.event_id, event);
    this.replacement = null;
    this.scope = null;
    this.observedQueue.length = 0;
    this.liveHeadSeq = null;
    return this.change();
  }
  commitReplacement(): TimelineRuntimeChange {
    this.replacement = null;
    return this.change();
  }
  isNewLiveEvent(event: TimelineEvent): boolean {
    return this.formalEventAcceptance(event).newLiveEvent;
  }
  invalidateScope(preserveFormal = false): TimelineRuntimeChange {
    this.cancelReplacement();
    this.removeCurrentScopeEntries();
    this.partials.clear();
    this.clearQueuedSnapshot();
    this.scope = null;
    this.liveHeadSeq = null;
    if (!preserveFormal) this.events.clear();
    return this.change();
  }
  clear(): TimelineRuntimeChange {
    this.replacement = null;
    this.scope = null;
    this.liveHeadSeq = null;
    this.events.clear();
    this.partials.clear();
    this.pending.clear();
    this.unknown = [];
    this.clearQueuedSnapshot();
    return this.change();
  }
  markDisconnected(): TimelineRuntimeChange {
    this.cancelReplacement();
    this.clearTransient(true);
    return this.change();
  }
  sendUser(text: string, images?: UserMessageImages, requestIds?: { clientRequestId: string; requestId: string }): UserMessageSendResult | null {
    const scope = this.scope;
    const hasImages = Boolean(images?.length);
    if (this.replacement || !scope || images?.length && images.length > 1 || (!text.trim() && !hasImages)) return null;
    const clientRequestId = requestIds?.clientRequestId ?? randomId();
    if (this.hasClientRequestId(clientRequestId)) return null;
    const requestId = requestIds?.requestId ?? randomId();
    const candidate: PendingPayload = { text, ...(hasImages ? { images } : {}) };
    if (exceedsPendingCapacity([...this.pendingPayloads(), candidate], this.limits)) throw new PendingCapacityError();
    this.pending.set(clientRequestId, { kind: "pending", scope, id: `pending:${clientRequestId}`, clientRequestId, requestId, text, ...(hasImages ? { images } : {}), createdAt: Date.now(), delivery: "pending" });
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, text, images), change: this.change() };
  }
  actOnQueued(clientRequestId: string, action: "insert" | "cancel"): { frame: ClientFrame; change: TimelineRuntimeChange } | null {
    const scope = this.scope;
    const pending = this.findPending((candidate) => candidate.clientRequestId === clientRequestId);
    if (!scope || !pending || !this.isCurrentPending(pending) || !pending.queued || !pending.cancelable || pending.messageId || pending.queuedAction || pending.insertionStatus) return null;
    const requestId = randomId();
    pending.queuedAction = action;
    pending.queuedActionRequestId = requestId;
    if (action === "insert") {
      pending.insertionStatus = "waiting";
      pending.insertionRequestedAt = Date.now();
      delete pending.insertionNoticeDismissed;
    }
    return {
      frame: { protocol_version: 2, type: action === "insert" ? "queued_message_steer" : "queued_message_clear", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, target_id: clientRequestId },
      change: this.change(),
    };
  }
  releaseQueuedAction(requestId: string): TimelineRuntimeChange {
    const pending = this.findPending((candidate) => candidate.queuedActionRequestId === requestId);
    if (!pending) return this.change();
    const insertion = pending.insertionStatus !== undefined;
    delete pending.queuedAction;
    delete pending.queuedActionRequestId;
    if (insertion) {
      if (pending.queued && !pending.messageId) this.clearInsertionNotice(pending);
      else this.markInsertionUnconfirmed(pending);
    }
    return this.change();
  }
  expireQueuedInsertions(now = Date.now()): TimelineRuntimeChange {
    for (const pending of [...this.pending.values(), ...this.unknown]) {
      if (!this.isCurrentPending(pending) || pending.insertionStatus !== "waiting" || pending.insertionRequestedAt === undefined) continue;
      if (now >= pending.insertionRequestedAt + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS) this.markInsertionUnconfirmed(pending);
    }
    return this.change();
  }
  dismissQueuedInsertionNotice(clientRequestId: string): TimelineRuntimeChange {
    const pending = this.findPending((candidate) => candidate.clientRequestId === clientRequestId);
    if (pending?.insertionStatus === "unconfirmed") pending.insertionNoticeDismissed = true;
    return this.change();
  }
  markUnknownDelivery(clientRequestId: string): TimelineRuntimeChange {
    const pending = this.findCurrentPendingMapItem(clientRequestId);
    if (!pending) return this.change();
    this.deletePending(pending);
    if (pending.insertionStatus) this.markInsertionUnconfirmed(pending);
    this.unknown.push({ ...pending, delivery: "unknown_delivery" });
    return this.change();
  }
  retryUnknown(clientRequestId: string): UserMessageSendResult | null {
    const scope = this.scope;
    const index = this.unknown.findIndex((pending) => this.isCurrentPending(pending) && pending.clientRequestId === clientRequestId);
    if (!scope || index < 0) return null;
    const previous = this.unknown[index];
    // 队列操作断线后的结果需由权威快照恢复，不能把已插入的消息重新发送。
    if (previous.queued || previous.insertionStatus) return null;
    const requestId = randomId();
    const pending = { ...previous, scope, requestId, delivery: "pending" as const };
    this.unknown.splice(index, 1);
    this.storePending(pending);
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, pending.text, pending.images), change: this.change() };
  }
  acceptsTimelineFrame(frame: ServerFrame): boolean {
    const scope = this.scope;
    if (frame.type === "timeline_event") {
      return scope !== null && scope.sessionId === frame.session_id
        && frame.session_id === frame.event.session_id && frame.leaf_id === frame.event.leaf_id;
    }
    if (frame.type === "timeline_partial" || frame.type === "timeline_event_fragment") {
      return scope !== null && scope.sessionId === frame.session_id;
    }
    return true;
  }
  /** Tip updates are formal-event-only; retained for callers that need a current-leaf guard. */
  advanceLeaf(sessionId: string, leafId: string | null): boolean {
    return isMatchingScope(this.scope, { session_id: sessionId, leaf_id: leafId });
  }
  receive(frame: ServerFrame): TimelineRuntimeChange {
    if (!this.acceptsTimelineFrame(frame)) return this.change();
    if (frame.type === "session_ready") return this.change();
    if (frame.type === "reset") return { ...this.invalidateScope(), reset: frame };
    if (frame.type === "queued_message_state") {
      const scope = this.scope;
      if (!scope || !isMatchingScope(scope, frame)) return this.change();
      if (this.rejectedQueuedSnapshotId === frame.snapshot_id) return this.change();
      if (this.queuedSnapshotId !== frame.snapshot_id || frame.chunk_index === 0) {
        this.queuedSnapshotId = frame.snapshot_id;
        this.queuedSnapshotItems.clear();
      }
      const staged = new Map(this.queuedSnapshotItems);
      for (const item of frame.items) staged.set(item.id, item);
      const stagedItems = [...staged.values()];
      const stagedIds = new Set(stagedItems.map((item) => item.id));
      const retainedPayloads = [...this.pending.values(), ...this.unknown]
        .filter((pending) => !stagedIds.has(pending.clientRequestId))
        .map((pending) => ({ text: pending.text, ...(pending.images ? { images: pending.images } : {}) }));
      const stagedPayloads = stagedItems.map((item) => ({ text: item.text, ...(item.images ? { images: item.images } : {}) }));
      if (exceedsPendingCapacity([...retainedPayloads, ...stagedPayloads], this.limits)) {
        this.clearQueuedSnapshot();
        this.rejectedQueuedSnapshotId = frame.snapshot_id;
        return this.pendingCapacityChange();
      }
      this.queuedSnapshotItems.clear();
      for (const [itemId, item] of staged) this.queuedSnapshotItems.set(itemId, item);
      if (!frame.final) return this.change();
      const nextItems = [...this.queuedSnapshotItems.values()];
      const nextIds = new Set(nextItems.map((item) => item.id));
      const cancelled: QueuedCancellation[] = [];
      for (const pending of this.pendingItems) {
        if (!pending.queued || nextIds.has(pending.clientRequestId)) continue;
        if (!pending.messageId && pending.insertionStatus !== undefined) {
          pending.queued = false;
          pending.cancelable = false;
          delete pending.queuedAction;
        } else if (!pending.messageId) {
          // 本端请求的取消由不含该条的快照确认；取消失败（如已开始发送）时，错误回执先于快照到达并已释放 queuedAction。
          if (pending.queuedAction === "cancel") cancelled.push({ clientRequestId: pending.clientRequestId, text: pending.text, ...(pending.images?.length ? { images: pending.images } : {}) });
          this.deletePending(pending);
        } else {
          pending.queued = false;
          pending.cancelable = false;
        }
      }
      for (const item of nextItems) {
        const existing = this.findPending((candidate) => candidate.clientRequestId === item.id);
        if (existing) {
          const wasUnknown = this.unknown.includes(existing);
          this.unknown = this.unknown.filter((pending) => pending !== existing);
          this.pending.set(item.id, existing);
          existing.text = item.text;
          existing.images = item.images;
          // 断线后新的权威快照可以恢复仍在队列中的消息；同连接重复快照不解锁在途操作。
          if (wasUnknown || (existing.messageId === undefined && existing.insertionRejected)) {
            this.clearInsertionNotice(existing);
            existing.queued = true;
            existing.delivery = "accepted";
          } else if (existing.messageId === undefined && existing.queued === undefined && !existing.queuedAction && !existing.insertionStatus) {
            existing.queued = true;
            existing.delivery = "accepted";
          }
          existing.cancelable = item.editable && item.sender_ref === scope.selfSenderRef;
          continue;
        }
        this.pending.set(item.id, { kind: "pending", scope, id: `pending:${item.id}`, clientRequestId: item.id, text: item.text, ...(item.images ? { images: item.images } : {}), queued: true, cancelable: item.editable && item.sender_ref === scope.selfSenderRef, createdAt: item.created_at, delivery: "accepted", requestId: item.id });
      }
      this.clearQueuedSnapshot();
      const change = this.change();
      return cancelled.length ? { ...change, cancelledQueued: cancelled } : change;
    }
    if (frame.type === "protocol_error" && frame.in_reply_to) {
      const action = this.findPending((candidate) => candidate.queuedActionRequestId === frame.in_reply_to);
      if (action?.insertionStatus) {
        // 网络错误回执不同于同步发送失败：随后快照为空时仍需保留未确认提示。
        action.insertionRejected = true;
        this.markInsertionUnconfirmed(action);
        return this.change();
      }
      if (action) return this.releaseQueuedAction(frame.in_reply_to);
      const pending = this.findPending((candidate) => candidate.requestId === frame.in_reply_to);
      if (pending) {
        this.deletePending(pending);
        this.unknown.push({ ...pending, delivery: "unknown_delivery" });
      }
      return this.change();
    }
    if (frame.type === "user_message_status") {
      if (!isSameSession(this.scope, frame)) return this.change();
      const pending = this.findPending((candidate) => candidate.clientRequestId === frame.client_request_id
        && (candidate.requestId === frame.in_reply_to || candidate.queuedActionRequestId === frame.in_reply_to));
      if (!pending) return this.change();
      if (frame.status !== "unknown_delivery") this.restorePending(pending);
      pending.delivery = frame.status;
      if (frame.status === "unknown_delivery") {
        // SDK 投递超时不同于取消或插入成功；后续空队列不能抹去未确认提示。
        if (pending.insertionStatus) this.markInsertionUnconfirmed(pending);
        else {
          pending.queued = false;
          pending.cancelable = false;
        }
      }
      if ("message_id" in frame && frame.message_id) {
        this.clearInsertionNotice(pending);
        pending.messageId = frame.message_id;
        pending.queued = false;
        pending.cancelable = false;
        this.reconcileUserMessage(frame.message_id);
      }
      if (frame.status === "unknown_delivery" && this.pendingHas(pending)) {
        this.deletePending(pending);
        this.unknown.push(pending);
        if (pending.messageId) this.reconcileUserMessage(pending.messageId);
      }
      return this.change();
    }
    if (frame.type === "user_message_started") {
      if (!isSameSession(this.scope, frame)) return this.change();
      const pending = this.findPending((candidate) => candidate.requestId === frame.in_reply_to);
      if (pending) {
        this.restorePending(pending);
        pending.delivery = "accepted";
        this.clearInsertionNotice(pending);
        pending.messageId = frame.message.id;
        pending.queued = false;
        pending.cancelable = false;
        this.reconcileUserMessage(frame.message.id);
      }
      return this.change();
    }
    if (frame.type === "timeline_partial") {
      if (!isSameSession(this.scope, frame) || this.scope?.leafId !== frame.leaf_id) return this.change();
      try {
        const partial = parseTimelinePartialV2(frame);
        // 无法关联源消息的临时正文不进入展示；仍接受正式事件，避免留下无法结束的流式行。
        if (partial.kind !== "tool" && !partialMessageIdentity(partial)) return this.change();
        if ([...this.events.values()].some(event => matchesFormalMessage(partial, event))) return this.change();
        const previous = this.partials.get(partial.partial_id);
        this.partials.set(partial.partial_id, { kind: "partial", partial: mergePartial(previous?.partial, partial), createdAt: previous?.createdAt ?? Date.now() });
      } catch { /* strict decoder rejects invalid data */ }
      return this.change();
    }
    if (frame.type === "timeline_event") return this.commit(frame.event);
    return this.change();
  }
  commit(event: TimelineEvent): TimelineRuntimeChange {
    try {
      const parsed = parseTimelineEventV2(event);
      const acceptance = this.formalEventAcceptance(parsed);
      if (!acceptance.accepted) return this.change();
      if (!acceptance.applyToView) return this.change();
      if (acceptance.tipAdvanced) this.advanceTip(parsed);
      this.commitParsed(parsed);
      return this.change({ committed: [parsed], newLiveEvent: acceptance.newLiveEvent, tipAdvanced: acceptance.tipAdvanced });
    } catch { /* strict decoder rejects invalid data */ }
    return this.change();
  }
  replaceHistory(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    this.events.clear();
    for (const event of events) {
      try {
        const parsed = parseTimelineEventV2(event);
        if (!this.scope || isSameSession(this.scope, parsed)) this.commitParsed(parsed);
      } catch { /* transfer assembler has already rejected malformed windows */ }
    }
    return this.change();
  }
  prependHistory(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    for (const event of events) {
      try {
        const parsed = parseTimelineEventV2(event);
        if (!this.scope || isSameSession(this.scope, parsed)) this.commitParsed(parsed);
      } catch { /* transfer assembler has already rejected malformed windows */ }
    }
    return this.change();
  }
  get currentScope(): TimelineScope | null { return this.scope; }
  get replacing(): boolean { return this.replacement !== null; }
  formalEvents(): TimelineEvent[] { return [...this.events.values()]; }
  get pendingItems(): TimelinePending[] { return [...this.pending.values(), ...this.unknown].filter((pending) => this.isCurrentPending(pending)); }
  private removeReplacedEndpointEntries(scope: TimelineScope): void {
    this.removeEntries((pending) => pending.scope.deviceId === scope.deviceId
      && pending.scope.endpointId === scope.endpointId
      && !isSamePendingScope(pending.scope, scope));
  }
  private removeCurrentScopeEntries(): void {
    const current = this.scope;
    if (!current) return;
    this.removeEntries((pending) => isSamePendingScope(pending.scope, current));
  }
  private removeEntries(predicate: (pending: Pending) => boolean): void {
    for (const [clientRequestId, pending] of this.pending) {
      if (predicate(pending)) this.pending.delete(clientRequestId);
    }
    this.unknown = this.unknown.filter((pending) => !predicate(pending));
  }
  private clearQueuedSnapshot(): void {
    this.queuedSnapshotItems.clear();
    this.queuedSnapshotId = null;
    this.rejectedQueuedSnapshotId = null;
  }
  private pendingPayloads(): PendingPayload[] {
    return [...this.pending.values(), ...this.unknown].map((pending) => ({ text: pending.text, ...(pending.images ? { images: pending.images } : {}) }));
  }
  private hasClientRequestId(clientRequestId: string): boolean {
    return this.pending.has(clientRequestId) || this.unknown.some((pending) => pending.clientRequestId === clientRequestId);
  }
  private findCurrentPendingMapItem(clientRequestId: string): Pending | undefined {
    return this.findPending((pending) => pending.clientRequestId === clientRequestId);
  }
  private deletePending(pending: TimelinePending): void {
    this.pending.delete(pending.clientRequestId);
    this.unknown = this.unknown.filter((candidate) => candidate !== pending);
  }
  private pendingHas(pending: TimelinePending): boolean {
    return this.pending.get(pending.clientRequestId) === pending;
  }
  private storePending(pending: Pending): void {
    this.unknown = this.unknown.filter((candidate) => candidate !== pending && candidate.clientRequestId !== pending.clientRequestId);
    this.pending.set(pending.clientRequestId, pending);
  }
  private pendingCapacityChange(): TimelineRuntimeChange {
    return { ...this.change(), pendingCapacityExceeded: true };
  }
  private contiguousFormalRange(): { minSeq: number; maxSeq: number } | null {
    const sequences: number[] = [];
    for (const event of this.events.values()) {
      if (!isEventSequence(event.event_seq)) return null;
      sequences.push(event.event_seq);
    }
    if (sequences.length === 0) return null;
    sequences.sort((left, right) => left - right);
    for (let index = 1; index < sequences.length; index += 1) {
      if (sequences[index] !== sequences[index - 1] + 1) return null;
    }
    return { minSeq: sequences[0], maxSeq: sequences.at(-1)! };
  }
  private formalEventAcceptance(event: TimelineEvent): { accepted: boolean; applyToView: boolean; newLiveEvent: boolean; tipAdvanced: boolean } {
    const rejected = { accepted: false, applyToView: false, newLiveEvent: false, tipAdvanced: false };
    const scope = this.scope;
    if (!scope || scope.sessionId !== event.session_id) return rejected;

    const sequence = event.event_seq;
    const existing = this.events.get(event.event_id);
    if (existing) {
      const existingSequence = existing.event_seq;
      const tipAdvanced = isEventSequence(sequence) && sequence > (this.liveHeadSeq ?? 0);
      if (isEventSequence(existingSequence) && isEventSequence(sequence) && sequence < existingSequence) return rejected;
      return { accepted: true, applyToView: true, newLiveEvent: false, tipAdvanced };
    }
    if (!isEventSequence(sequence)) {
      return this.liveHeadSeq === null
        ? { accepted: true, applyToView: true, newLiveEvent: false, tipAdvanced: false }
        : rejected;
    }
    if (sequence <= (this.liveHeadSeq ?? 0)) {
      return { accepted: true, applyToView: false, newLiveEvent: false, tipAdvanced: false };
    }
    return { accepted: true, applyToView: true, newLiveEvent: true, tipAdvanced: true };
  }
  private advanceTip(event: TimelineEvent): void {
    const current = this.scope;
    if (!current || current.sessionId !== event.session_id || !isEventSequence(event.event_seq) || event.event_seq <= (this.liveHeadSeq ?? 0)) return;
    const next = { ...current, leafId: event.leaf_id };
    for (const pending of this.pending.values()) {
      if (isSamePendingScope(pending.scope, next)) pending.scope = next;
    }
    for (const pending of this.unknown) {
      if (isSamePendingScope(pending.scope, next)) pending.scope = next;
    }
    this.scope = next;
    this.liveHeadSeq = event.event_seq;
  }
  private userMessageFrame(scope: TimelineScope, requestId: string, clientRequestId: string, text: string, images?: UserMessageImages): UserMessageFrame {
    return { protocol_version: 2, type: "user_message", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, client_request_id: clientRequestId, text, ...(images?.length ? { images } : {}) };
  }
  private commitParsed(event: TimelineEvent): void {
    this.events.set(event.event_id, event);
    if (event.event_seq !== undefined) this.liveHeadSeq = Math.max(this.liveHeadSeq ?? 0, event.event_seq);
    if (event.kind === "user") this.reconcileUserMessage(event.message_id);
    if (event.kind === "assistant" || event.kind === "provider_error" || event.kind === "tool") {
      for (const [partialId, partial] of this.partials) {
        if (matchesFormalMessage(partial.partial, event)) this.partials.delete(partialId);
      }
    }
  }
  private isCurrentPending(pending: Pending): boolean {
    const scope = this.scope;
    const origin = pending.scope;
    // 重连可更换 channel；其他身份必须保持一致，防止跨 Pi 消费旧请求。
    return scope !== null && origin.deviceId === scope.deviceId && origin.endpointId === scope.endpointId
      && origin.runtimeInstanceId === scope.runtimeInstanceId && origin.sessionId === scope.sessionId
      && origin.selfSenderRef === scope.selfSenderRef;
  }
  private findPending(predicate: (pending: Pending) => boolean): Pending | undefined {
    return [...this.pending.values(), ...this.unknown].find((pending) => this.isCurrentPending(pending) && predicate(pending));
  }
  private restorePending(pending: Pending): void {
    this.unknown = this.unknown.filter((candidate) => candidate !== pending);
    this.storePending(pending);
  }
  private clearInsertionNotice(pending: Pending): void {
    delete pending.insertionStatus;
    delete pending.insertionRequestedAt;
    delete pending.insertionNoticeDismissed;
    delete pending.insertionRejected;
    delete pending.queuedAction;
    delete pending.queuedActionRequestId;
  }
  private markInsertionUnconfirmed(pending: Pending): void {
    if (!pending.insertionStatus) return;
    pending.insertionStatus = "unconfirmed";
    pending.queued = false;
    pending.cancelable = false;
    delete pending.queuedAction;
    // 超时不丢弃请求关联，迟到的拒绝仍能让后续权威快照恢复真实队列。
  }
  private reconcileUserMessage(messageId: string): void {
    const formal = [...this.events.values()].find((event): event is Extract<TimelineEvent, { kind: "user" }> => event.kind === "user" && event.message_id === messageId);
    if (!formal) return;
    const matches = [...this.pending.entries(), ...this.unknown.map((pending) => [pending.clientRequestId, pending] as const)].filter(([, pending]) => this.isCurrentPending(pending) && pending.messageId === messageId);
    for (const [, pending] of matches) {
      this.deletePending(pending);
      this.unknown = this.unknown.filter((candidate) => candidate !== pending);
      if (this.scope) this.observedQueue.push({ protocol_version: 2, type: "user_message_observed", id: randomId(), channel_id: this.scope.channelId, session_id: this.scope.sessionId, leaf_id: this.scope.leafId, client_request_id: pending.clientRequestId, message_id: formal.message_id, status: "committed" });
    }
  }
  private clearTransient(movePendingToUnknown: boolean): void {
    this.partials.clear();
    this.clearQueuedSnapshot();
    if (movePendingToUnknown) {
      for (const pending of this.pending.values()) {
        if (pending.insertionStatus) this.markInsertionUnconfirmed(pending);
        this.unknown.push({ ...pending, delivery: "unknown_delivery" });
      }
    }
    this.pending.clear();
  }
  private change(result: { committed?: TimelineEvent[]; newLiveEvent?: boolean; tipAdvanced?: boolean } = {}): TimelineRuntimeChange {
    const formal = this.replacement?.previousEvents ?? [...this.events.values()];
    const transient = this.replacement ? [] : [...this.pendingItems, ...this.partials.values()];
    const items: TimelineViewItem[] = [...formal.map((event) => ({ kind: "event" as const, event })), ...transient];
    items.sort(compareItems);
    return {
      items,
      committed: result.committed ?? [],
      observed: this.replacement ? [] : this.observedQueue.splice(0),
      unknown: this.replacement ? [] : [...this.unknown],
      ...(result.newLiveEvent ? { newLiveEvent: true } : {}),
      ...(result.tipAdvanced ? { tipAdvanced: true } : {}),
    };
  }
}
