import type { ClientFrame, ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import { ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_MESSAGE_BYTES, attachmentDescriptorSchema, type AttachmentDescriptor } from "../pi-reach/protocol-v2/schema";
import { parseTimelineEventV2, parseTimelinePartialV2 } from "../pi-reach/protocol-v2/codec";
import { TIMELINE_RECENT_LIMIT } from "./timeline-reconnect";
import { matchesFormalMessage, partialMessageIdentity } from "./timeline-identity";
import { createTimelineReplacement, type TimelineReplacementBranch } from "./timeline-replacement";
import {
  DEFAULT_TIMELINE_PENDING_LIMITS,
  PendingCapacityError,
  exceedsPendingCapacity,
  normalizeTimelinePendingLimits,
  pendingCapacityUsage,
  pendingPayloadBytes,
  type PendingPayload,
  type TimelinePendingLimits,
} from "./timeline-pending";
import { attachmentRequestKey, projectAttachmentMetadata } from "./timeline-attachments";

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
  /** 展示用附件描述（含预览）；承诺已提交前保留以驱动卡片展示，不含任何原件。 */
  attachments?: AttachmentDescriptor[];
  /** 消息真实 sender_ref；本端发送为 selfSenderRef，队列取 item.sender_ref，用于元信息关联。 */
  senderRef?: string;
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
export type QueuedCancellation = { clientRequestId: string; text: string; images?: UserMessageImages; attachments?: AttachmentDescriptor[] };
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
/** 本地缓存预览所属的会话；持久化历史不含 runtime，按电脑、Pi 与会话识别。 */
export type TimelinePreviewTarget = { deviceId: string; endpointId: string; sessionId: string };
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
  private preview: TimelinePreviewTarget | null = null;
  private liveHeadSeq: number | null = null;
  private readonly events = new Map<string, TimelineEvent>();
  private readonly partials = new Map<string, TimelinePartialView>();
  private readonly pending = new Map<string, Pending>();
  // 原始内容随 pending 对象回收；展示投影不能改变未知投递的重试内容。
  private readonly pendingBases = new WeakMap<Pending, { payload: PendingPayload; local: boolean }>();
  private unknown: Pending[] = [];
  private queuedSnapshotId: string | null = null;
  private readonly queuedSnapshotItems = new Map<string, QueueItem>();
  private readonly observedQueue: ClientFrame[] = [];
  private rejectedQueuedSnapshotId: string | null = null;

  constructor(limits: Partial<TimelinePendingLimits> = {}) {
    this.limits = normalizeTimelinePendingLimits({ ...DEFAULT_TIMELINE_PENDING_LIMITS, ...limits });
  }

  setScope(scope: TimelineScope): TimelineRuntimeChange {
    this.preview = null;
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
    const previewMatched = this.consumePreview(scope);
    if (this.scope && this.scope.selfSenderRef !== scope.selfSenderRef) {
      this.removeEntries((pending) => pending.scope.deviceId === scope.deviceId
        && pending.scope.endpointId === scope.endpointId
        && pending.scope.runtimeInstanceId === scope.runtimeInstanceId
        && pending.scope.sessionId === scope.sessionId);
    }
    const safeHeadSeq = isHeadSequence(headSeq) ? headSeq : 0;
    const canAppend = isHeadSequence(headSeq) && this.replacement === null && (previewMatched || this.scope === null && this.events.size === 0 && this.unknown.length === 0 || isSameLiveScope(this.scope, scope));
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
    this.preview = null;
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
    this.preview = null;
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
  /** 切换到另一个 Pi：立即撤下旧投影；未确认投递按原 scope 保留，切回该会话时仍可重试。 */
  detachLive(): TimelineRuntimeChange {
    this.markDisconnected();
    this.events.clear();
    this.scope = null;
    this.preview = null;
    this.liveHeadSeq = null;
    return this.change();
  }
  /** 握手前先显示本地缓存的最近记录；只用于已解除 scope 的空投影，预览期间没有 scope，不能发送。 */
  showPreview(target: TimelinePreviewTarget, events: readonly TimelineEvent[]): TimelineRuntimeChange | null {
    if (this.scope || this.replacement || this.events.size > 0 || events.length === 0) return null;
    for (const event of events) this.events.set(event.event_id, event);
    this.preview = target;
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
    this.storePending({ kind: "pending", scope, id: `pending:${clientRequestId}`, clientRequestId, requestId, text, ...(hasImages ? { images } : {}), senderRef: scope.selfSenderRef, createdAt: Date.now(), delivery: "pending" }, candidate, true);
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, text, images), change: this.change() };
  }
  /**
   * 附件消息入口：只传 attachment_ids，绝不把预览或原件写入 user_message。
   * 严格校验描述、数量、总量与 ID 唯一，任一不合法直接 fail closed（返回 null）。
   */
  sendUserWithAttachments(text: string, attachments: readonly AttachmentDescriptor[], requestIds?: { clientRequestId: string; requestId: string }): UserMessageSendResult | null {
    const scope = this.scope;
    if (this.replacement || !scope) return null;
    if (attachments.length < 1 || attachments.length > ATTACHMENT_MAX_COUNT) return null;
    const descriptors: AttachmentDescriptor[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const attachment of attachments) {
      const parsed = attachmentDescriptorSchema.safeParse(attachment);
      if (!parsed.success) return null;
      if (seen.has(parsed.data.attachment_id)) return null;
      seen.add(parsed.data.attachment_id);
      totalBytes += parsed.data.byte_length;
      descriptors.push(parsed.data);
    }
    if (totalBytes > ATTACHMENT_MAX_MESSAGE_BYTES) return null;
    const clientRequestId = requestIds?.clientRequestId ?? randomId();
    if (this.hasClientRequestId(clientRequestId)) return null;
    const requestId = requestIds?.requestId ?? randomId();
    const candidate: PendingPayload = { text, attachments: descriptors };
    if (exceedsPendingCapacity([...this.pendingPayloads(), candidate], this.limits)) throw new PendingCapacityError();
    this.storePending({ kind: "pending", scope, id: `pending:${clientRequestId}`, clientRequestId, requestId, text, attachments: descriptors, senderRef: scope.selfSenderRef, createdAt: Date.now(), delivery: "pending" }, candidate, true);
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, text, undefined, descriptors.map((descriptor) => descriptor.attachment_id)), change: this.change() };
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
    pending.delivery = "unknown_delivery";
    this.unknown.push(pending);
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
    const base = this.pendingBases.get(previous)!;
    const pending: Pending = { ...previous, scope, requestId, delivery: "pending", text: base.payload.text,
      images: base.payload.images ? [...base.payload.images] : undefined,
      attachments: base.payload.attachments ? [...base.payload.attachments] : undefined };
    this.pendingBases.set(pending, base);
    this.unknown.splice(index, 1);
    this.storePending(pending);
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, base.payload.text, pending.images, pending.attachments?.map((descriptor) => descriptor.attachment_id)), change: this.change() };
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
        .map((pending) => this.pendingPayload(pending));
      const stagedPayloads = stagedItems.map((item) => {
        const existing = this.pending.get(item.id) ?? this.unknown.find((pending) => pending.clientRequestId === item.id);
        const payload = { text: item.text, ...(item.images ? { images: item.images } : {}), ...(existing?.attachments ? { attachments: existing.attachments } : {}) };
        return existing ? this.pendingPayload(existing, payload) : payload;
      });
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
          if (pending.queuedAction === "cancel") cancelled.push({ clientRequestId: pending.clientRequestId, text: pending.text, ...(pending.images?.length ? { images: pending.images } : {}), ...(pending.attachments?.length ? { attachments: pending.attachments } : {}) });
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
          const base = this.pendingBases.get(existing)!;
          if (!base.local) base.payload = { text: item.text, ...(item.images ? { images: item.images } : {}) };
          existing.senderRef = item.sender_ref;
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
        this.storePending({ kind: "pending", scope, id: `pending:${item.id}`, clientRequestId: item.id, text: item.text, ...(item.images ? { images: item.images } : {}), senderRef: item.sender_ref, queued: true, cancelable: item.editable && item.sender_ref === scope.selfSenderRef, createdAt: item.created_at, delivery: "accepted", requestId: item.id }, { text: item.text, ...(item.images ? { images: item.images } : {}) });
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
        pending.delivery = "unknown_delivery";
        this.unknown.push(pending);
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
  get previewing(): boolean { return this.preview !== null; }
  formalEvents(): TimelineEvent[] { return [...this.events.values()]; }
  get pendingItems(): TimelinePending[] { return [...this.pending.values(), ...this.unknown].filter((pending) => this.isCurrentPending(pending)); }
  /** 握手确认同一会话时预览即为已保留的投影，可增量追加；不同会话立即撤下预览。 */
  private consumePreview(scope: TimelineScope): boolean {
    const preview = this.preview;
    if (!preview) return false;
    this.preview = null;
    if (preview.deviceId === scope.deviceId && preview.endpointId === scope.endpointId && preview.sessionId === scope.sessionId) return true;
    this.events.clear();
    return false;
  }
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
  private pendingPayload(pending: Pending, value: PendingPayload = pending): PendingPayload {
    const payload: PendingPayload = { text: value.text, images: value.images, attachments: value.attachments };
    const base = this.pendingBases.get(pending)!.payload;
    return JSON.stringify(payload) === JSON.stringify(base) ? payload : { ...payload, retainedPayload: base };
  }
  private pendingPayloads(): PendingPayload[] {
    return [...this.pending.values(), ...this.unknown].map((pending) => this.pendingPayload(pending));
  }
  /**
   * 晚到的附件元信息按 session/sender/request 关联到 pending（含其他 Owner 队列）。
   * 只补齐展示描述与规范化文本；超预算时不塞入并上报 pendingCapacityExceeded。
   */
  private reconcileAttachmentMetadata(): boolean {
    const formal = this.replacement?.previousEvents ?? [...this.events.values()];
    const { requests } = projectAttachmentMetadata(formal.map((event) => ({ kind: "event" as const, event })));
    let payloadBytes = pendingCapacityUsage(this.pendingPayloads()).payloadBytes;
    let exceeded = false;
    for (const pending of [...this.pending.values(), ...this.unknown]) {
      if (!this.isCurrentPending(pending) || !pending.senderRef) continue;
      const base = this.pendingBases.get(pending)!;
      // 本端附件描述和原文是未知投递的重试依据，不能被远端 sidecar 替换。
      const metadata = base.local && (base.payload.attachments || pending.senderRef !== pending.scope.selfSenderRef)
        ? undefined : requests.get(attachmentRequestKey(pending.scope.sessionId, pending.senderRef, pending.clientRequestId));
      const nextPayload: PendingPayload = metadata
        ? { text: metadata.text, images: base.payload.images, attachments: metadata.attachments } : base.payload;
      const currentBytes = pendingPayloadBytes(this.pendingPayload(pending));
      let delta = pendingPayloadBytes(this.pendingPayload(pending, nextPayload)) - currentBytes;
      let accepted = nextPayload;
      if (payloadBytes + delta > this.limits.maxPayloadBytes) {
        exceeded = true;
        accepted = base.payload;
        delta = pendingPayloadBytes(base.payload) - currentBytes;
      }
      payloadBytes += delta;
      pending.text = accepted.text;
      pending.images = accepted.images ? [...accepted.images] : undefined;
      pending.attachments = accepted.attachments ? [...accepted.attachments] : undefined;
    }
    return exceeded;
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
  private storePending(pending: Pending, basePayload?: PendingPayload, local = false): void {
    if (basePayload) this.pendingBases.set(pending, { payload: basePayload, local });
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
  private userMessageFrame(scope: TimelineScope, requestId: string, clientRequestId: string, text: string, images?: UserMessageImages, attachmentIds?: readonly string[]): UserMessageFrame {
    return { protocol_version: 2, type: "user_message", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, client_request_id: clientRequestId, text, ...(images?.length ? { images } : {}), ...(attachmentIds?.length ? { attachment_ids: [...attachmentIds] } : {}) };
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
        pending.delivery = "unknown_delivery";
        this.unknown.push(pending);
      }
    }
    this.pending.clear();
  }
  private change(result: { committed?: TimelineEvent[]; newLiveEvent?: boolean; tipAdvanced?: boolean } = {}): TimelineRuntimeChange {
    const attachmentCapacityExceeded = this.reconcileAttachmentMetadata();
    const formal = this.replacement?.previousEvents ?? [...this.events.values()];
    const transient = this.replacement ? [] : [...this.pendingItems, ...this.partials.values()];
    const items: TimelineViewItem[] = [...formal.map((event) => ({ kind: "event" as const, event })), ...transient];
    items.sort(compareItems);
    return {
      items,
      committed: result.committed ?? [],
      observed: this.replacement ? [] : this.observedQueue.splice(0),
      unknown: this.replacement ? [] : [...this.unknown],
      ...(attachmentCapacityExceeded ? { pendingCapacityExceeded: true } : {}),
      ...(result.newLiveEvent ? { newLiveEvent: true } : {}),
      ...(result.tipAdvanced ? { tipAdvanced: true } : {}),
    };
  }
}
