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
export const USER_MESSAGE_CONFIRMATION_TIMEOUT_MS = 30_000;
export const DELIVERY_STATUS_QUERY_TIMEOUT_MS = 10_000;
const DELIVERY_QUERY_ASSOCIATION_LIMIT = 128;
const DELIVERY_QUERY_ASSOCIATION_TTL_MS = 60_000;
export type PendingDelivery = "pending" | "received" | "accepted" | "committed" | "unknown_delivery" | "failed" | "cancelled";
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
  /** 权威队列快照声明该项已在途发送（editable===false）；只影响展示归属，不代表可操作性。 */
  queueInFlight?: boolean;
  queuedAction?: "insert" | "cancel";
  queuedActionRequestId?: string;
  insertionStatus?: QueuedInsertionStatus;
  insertionRequestedAt?: number;
  insertionNoticeDismissed?: boolean;
  /** 原目标已失效：只读保留内容供复制，不再发送或核对。 */
  scopeInvalid?: boolean;
  createdAt: number;
  delivery: PendingDelivery;
  deliveryFailure?: { code: string; retryable: boolean };
  statusQuery?: { requestId: string; requestedAt: number };
  statusQueryUnsupported?: boolean;
  /** 本地观察到的确认窗口起点；不用服务端时间参与本地超时。 */
  confirmationStartedAt?: number;
  lastEvidenceAt?: number;
  requestId: string;
  messageId?: string;
};
export type TimelinePartialView = { kind: "partial"; partial: TimelinePartial; createdAt: number; thinkingTextEpoch?: object };
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
/**
 * previewMatched：握手确认了本地预览的同一会话，后续补齐只是接上最新记录。
 * sequenceRegressed：同一会话的最新序号低于已保留的记录，本地投影已过期，须权威替换而非合并。
 */
export type TimelineLivePreparation = { change: TimelineRuntimeChange; plan: TimelineLivePlan; previewMatched: boolean; sequenceRegressed: boolean };
/** 本地缓存预览所属的会话；持久化历史不含 runtime，按电脑、Pi 与会话识别。 */
export type TimelinePreviewTarget = { deviceId: string; endpointId: string; sessionId: string };
type Pending = TimelinePending & { scope: TimelineScope; insertionRejected?: boolean };
type DeliveryQueryAssociation = {
  pending: Pending; attempt: string; operation: string | undefined; evidence: object; expiresAt: number;
};
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
/** 明确失败与已确认取消不因断线、超时或迟到回执降级为未知。 */
function isTerminalDelivery(delivery: PendingDelivery): boolean {
  return delivery === "failed" || delivery === "cancelled";
}
const CONFIRMING_DELIVERIES: readonly PendingDelivery[] = ["pending", "received", "accepted"];
/**
 * 本地确认窗口的截止时间：只用本地观察时间，不受服务端时钟影响；
 * 已关联正式消息、查询中、插队待确认或真正排队的消息不计时。
 */
function confirmationDeadline(pending: TimelinePending): number | null {
  if (pending.scopeInvalid === true || pending.messageId || pending.statusQuery || pending.insertionStatus
    || pending.queued && !pending.queueInFlight || !CONFIRMING_DELIVERIES.includes(pending.delivery)) return null;
  return Math.max(pending.confirmationStartedAt ?? 0, pending.lastEvidenceAt ?? 0) + USER_MESSAGE_CONFIRMATION_TIMEOUT_MS;
}
function statusQueryDeadline(pending: TimelinePending): number | null {
  return pending.scopeInvalid !== true && pending.statusQuery ? pending.statusQuery.requestedAt + DELIVERY_STATUS_QUERY_TIMEOUT_MS : null;
}
/** editable 只取自权威队列快照：false 即在途发送，与 sender 归属无关。 */
function applyQueueInFlight(pending: Pending, editable: boolean): void {
  if (editable) delete pending.queueInFlight;
  else pending.queueInFlight = true;
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
  // 只读历史：投影只来自本地正式记录，任何实时帧、发送与握手都不得复用或改写它。
  private readOnly = false;
  // 最近展示的电脑与 Pi：scope 因断线或失效解除后，只读保留内容仍只在原 Pi 下展示，不串到其他目标。
  private displayTarget: Pick<TimelineScope, "deviceId" | "endpointId"> | null = null;
  private liveHeadSeq: number | null = null;
  private readonly events = new Map<string, TimelineEvent>();
  private readonly partials = new Map<string, TimelinePartialView>();
  private readonly pending = new Map<string, Pending>();
  // 原始内容随 pending 对象回收；展示投影不能改变明确失败后的重试内容。
  private readonly pendingBases = new WeakMap<Pending, { payload: PendingPayload; local: boolean }>();
  // 等待超时后仍短期关联状态与错误回执；身份令牌不依赖时钟精度，不保留第二套投递状态。
  private readonly deliveryEvidence = new WeakMap<Pending, object>();
  private readonly latestDeliveryQuery = new WeakMap<Pending, string>();
  private readonly deliveryQueries = new Map<string, DeliveryQueryAssociation>();
  private unknown: Pending[] = [];
  private queuedSnapshotId: string | null = null;
  private readonly queuedSnapshotItems = new Map<string, QueueItem>();
  private readonly observedQueue: ClientFrame[] = [];
  private rejectedQueuedSnapshotId: string | null = null;
  private queuedSnapshotNextChunk = 0;
  private queueSnapshotComplete = false;
  private readonly queueSnapshotListeners = new Set<() => void>();

  get queueSnapshotReady(): boolean { return this.queueSnapshotComplete; }
  getQueueSnapshotReady = (): boolean => this.queueSnapshotComplete;
  subscribeQueueSnapshot = (listener: () => void): (() => void) => {
    this.queueSnapshotListeners.add(listener);
    return () => { this.queueSnapshotListeners.delete(listener); };
  };
  private setQueueSnapshotReady(ready: boolean): void {
    if (this.queueSnapshotComplete === ready) return;
    this.queueSnapshotComplete = ready;
    for (const listener of this.queueSnapshotListeners) listener();
  }

  constructor(limits: Partial<TimelinePendingLimits> = {}) {
    this.limits = normalizeTimelinePendingLimits({ ...DEFAULT_TIMELINE_PENDING_LIMITS, ...limits });
  }

  setScope(scope: TimelineScope): TimelineRuntimeChange {
    this.leaveReadOnly();
    this.deliveryQueries.clear();
    this.clearQueuedSnapshot();
    this.preview = null;
    this.removeReplacedEndpointEntries(scope);
    if (!isSameLiveScope(this.scope, scope)) {
      this.clearTransient();
      this.events.clear();
    }
    this.attachScope(scope);
    this.replacement = null;
    return this.change();
  }
  beginLive(scope: TimelineScope, headSeq: number): TimelineRuntimeChange {
    this.setScope(scope);
    this.clearTransient();
    this.events.clear();
    this.liveHeadSeq = headSeq;
    return this.change();
  }
  prepareLive(scope: TimelineScope, headSeq: number): TimelineLivePreparation {
    // 只读历史不是已保留的实时投影，不能被当作增量基线或替换期间的旧内容。
    this.leaveReadOnly();
    const previewMatched = this.consumePreview(scope);
    if (this.scope && this.scope.selfSenderRef !== scope.selfSenderRef) {
      this.markScopeInvalid((pending) => pending.scope.deviceId === scope.deviceId
        && pending.scope.endpointId === scope.endpointId
        && pending.scope.runtimeInstanceId === scope.runtimeInstanceId
        && pending.scope.sessionId === scope.sessionId);
    }
    const safeHeadSeq = isHeadSequence(headSeq) ? headSeq : 0;
    const canAppend = isHeadSequence(headSeq) && this.replacement === null && (previewMatched || this.scope === null && this.events.size === 0 && this.unknown.length === 0 || isSameLiveScope(this.scope, scope));
    const retained = this.contiguousFormalRange();
    const sameSession = previewMatched || (this.scope !== null && this.scope.deviceId === scope.deviceId
      && this.scope.endpointId === scope.endpointId && this.scope.sessionId === scope.sessionId);
    const sequenceRegressed = sameSession && retained !== null && safeHeadSeq < retained.maxSeq;
    if (canAppend && !retained && safeHeadSeq === 0) {
      this.clearTransient();
      this.attachScope(scope);
      this.liveHeadSeq = 0;
      return { change: this.change(), plan: { mode: "append", startSeq: null, endSeq: 0, earliestSeq: null }, previewMatched, sequenceRegressed };
    }
    if (canAppend && retained && safeHeadSeq >= retained.maxSeq) {
      this.clearTransient();
      this.attachScope(scope);
      this.liveHeadSeq = safeHeadSeq;
      const gap = safeHeadSeq - retained.maxSeq;
      if (gap <= TIMELINE_RECENT_LIMIT) return { change: this.change(), plan: { mode: "append", startSeq: gap === 0 ? null : retained.maxSeq + 1, endSeq: safeHeadSeq, earliestSeq: retained.minSeq }, previewMatched, sequenceRegressed };
    }

    this.replacement ??= createTimelineReplacement(this.events.values());
    this.events.clear();
    this.removeReplacedEndpointEntries(scope);
    this.clearTransient();
    this.attachScope(scope);
    this.liveHeadSeq = safeHeadSeq;
    const startSeq = safeHeadSeq === 0 ? null : Math.max(1, safeHeadSeq - TIMELINE_RECENT_LIMIT + 1);
    return { change: this.change(), plan: { mode: "replace", startSeq, endSeq: safeHeadSeq, earliestSeq: startSeq }, previewMatched, sequenceRegressed };
  }
  /**
   * 放弃未完成的权威替换并恢复旧投影。断线只撤下当前 scope，未确认内容按原 scope 保留待核对；
   * invalidate 表示原目标已失效（reset／bye），内容只读保留，不再发送或核对。
   */
  cancelReplacement(invalidate = false): TimelineRuntimeChange {
    if (!this.replacement) return this.change();
    const previous = this.replacement.previousEvents;
    if (invalidate) this.removeCurrentScopeEntries();
    this.clearTransient();
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
    this.deliveryQueries.clear();
    this.cancelReplacement(true);
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
    this.readOnly = false;
    this.deliveryQueries.clear();
    this.replacement = null;
    this.preview = null;
    this.scope = null;
    this.displayTarget = null;
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
    this.clearTransient();
    return this.change();
  }
  /** 切换到另一个 Pi：立即撤下旧投影；未确认投递按原 scope 保留，切回该会话时只读核对。 */
  detachLive(): TimelineRuntimeChange {
    this.readOnly = false;
    this.markDisconnected();
    this.events.clear();
    this.scope = null;
    this.preview = null;
    this.displayTarget = null;
    this.liveHeadSeq = null;
    return this.change();
  }
  /** 握手前先显示本地缓存的最近记录；只用于已解除 scope 的空投影，预览期间没有 scope，不能发送。 */
  showPreview(target: TimelinePreviewTarget, events: readonly TimelineEvent[]): TimelineRuntimeChange | null {
    if (this.scope || this.replacement || this.events.size > 0 || events.length === 0) return null;
    for (const event of events) this.events.set(event.event_id, event);
    this.preview = target;
    this.displayTarget = target;
    return this.change();
  }
  /**
   * 只读历史：撤下实时投影，只显示本地保存的正式记录。没有 scope 与显示目标，因此不能发送，
   * 其他会话未确认的消息也不会显示在历史里；序号允许不连续，缺口由视图标出。
   */
  showReadOnly(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    this.detachLive();
    this.readOnly = true;
    return this.prependHistory(events);
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
    this.storePending({ kind: "pending", scope, id: `pending:${clientRequestId}`, clientRequestId, requestId, text, ...(hasImages ? { images } : {}), senderRef: scope.selfSenderRef, createdAt: Date.now(), confirmationStartedAt: Date.now(), delivery: "pending" }, candidate, true);
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
    this.storePending({ kind: "pending", scope, id: `pending:${clientRequestId}`, clientRequestId, requestId, text, attachments: descriptors, senderRef: scope.selfSenderRef, createdAt: Date.now(), confirmationStartedAt: Date.now(), delivery: "pending" }, candidate, true);
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
      if (!this.isCurrentPending(pending) || pending.scopeInvalid === true || pending.insertionStatus !== "waiting" || pending.insertionRequestedAt === undefined) continue;
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
    if (!pending || pending.scopeInvalid === true || pending.messageId || pending.delivery === "committed" || pending.delivery === "cancelled") return this.change();
    this.deletePending(pending);
    delete pending.deliveryFailure;
    if (pending.insertionStatus) this.markInsertionUnconfirmed(pending);
    pending.delivery = "unknown_delivery";
    this.unknown.push(pending);
    return this.change();
  }
  markDeliveryFailed(clientRequestId: string, code: string, retryable: boolean): TimelineRuntimeChange {
    const pending = this.findPendingOrUnknown(clientRequestId);
    if (!pending || pending.scopeInvalid === true || pending.messageId || pending.delivery === "committed" || pending.delivery === "cancelled") return this.change();
    this.deletePending(pending);
    this.deliveryEvidence.set(pending, {});
    pending.delivery = "failed";
    pending.deliveryFailure = { code, retryable };
    delete pending.statusQuery;
    this.unknown.push(pending);
    return this.change();
  }
  retryFailed(clientRequestId: string): UserMessageSendResult | null {
    const scope = this.scope;
    const pending = this.findPendingOrUnknown(clientRequestId);
    if (!scope || !pending || pending.scopeInvalid === true || pending.delivery !== "failed" || !pending.deliveryFailure?.retryable
      || pending.queued || pending.queueInFlight || pending.insertionStatus || pending.messageId) return null;
    const base = this.pendingBases.get(pending)!;
    pending.scope = scope;
    pending.requestId = randomId();
    pending.delivery = "pending";
    pending.lastEvidenceAt = Date.now();
    delete pending.deliveryFailure;
    delete pending.statusQuery;
    delete pending.statusQueryUnsupported;
    pending.text = base.payload.text;
    pending.images = base.payload.images ? [...base.payload.images] : undefined;
    pending.attachments = base.payload.attachments ? [...base.payload.attachments] : undefined;
    this.restorePending(pending);
    return { frame: this.userMessageFrame(scope, pending.requestId, clientRequestId, base.payload.text, pending.images, pending.attachments?.map((descriptor) => descriptor.attachment_id)), change: this.change() };
  }
  /** 取消已确认且草稿回填成功：移除对应的只读消息。 */
  confirmCancelledRestore(clientRequestIds: readonly string[]): TimelineRuntimeChange {
    for (const clientRequestId of clientRequestIds) {
      const pending = this.findPendingOrUnknown(clientRequestId);
      if (pending?.delivery === "cancelled") this.deletePending(pending);
    }
    return this.change();
  }

  /** 取消已确认但附件无法放回输入区：保留内容供复制，不伪装成撤销成功。 */
  keepCancelledRestore(): TimelineRuntimeChange {
    return this.change();
  }

  /** 建立 pending 后、确定内容无法编码时回滚，调用方保留草稿并报告输入区错误。 */
  discardPending(clientRequestId: string): TimelineRuntimeChange {
    const pending = this.findPendingOrUnknown(clientRequestId);
    if (!pending) return this.change();
    this.deletePending(pending);
    return this.change();
  }
  requestDeliveryStatus(clientRequestId: string): { frame: Extract<ClientFrame, { type: "user_message_status_request" }>; change: TimelineRuntimeChange } | null {
    const scope = this.scope;
    const pending = this.findPendingOrUnknown(clientRequestId);
    if (!scope || !pending || pending.scopeInvalid === true || pending.delivery === "committed" || pending.delivery === "cancelled"
      || pending.statusQuery || pending.senderRef !== scope.selfSenderRef) return null;
    const requestId = randomId();
    const now = Date.now();
    pending.statusQuery = { requestId, requestedAt: now };
    const evidence = this.deliveryEvidence.get(pending) ?? {};
    this.deliveryEvidence.set(pending, evidence);
    this.latestDeliveryQuery.set(pending, requestId);
    this.pruneDeliveryQueries(now);
    this.deliveryQueries.set(requestId, { pending, attempt: pending.requestId, operation: pending.queuedActionRequestId,
      evidence, expiresAt: now + DELIVERY_QUERY_ASSOCIATION_TTL_MS });
    while (this.deliveryQueries.size > DELIVERY_QUERY_ASSOCIATION_LIMIT) this.deliveryQueries.delete(this.deliveryQueries.keys().next().value!);
    return {
      frame: { protocol_version: 2, type: "user_message_status_request", id: requestId, channel_id: scope.channelId,
        session_id: scope.sessionId, leaf_id: scope.leafId, client_request_id: clientRequestId },
      change: this.change(),
    };
  }
  private pruneDeliveryQueries(now = Date.now()): void {
    for (const [requestId, query] of this.deliveryQueries) {
      if (query.expiresAt <= now) this.deliveryQueries.delete(requestId);
    }
  }
  private isCurrentDeliveryQuery(requestId: string, query: DeliveryQueryAssociation): boolean {
    const pending = query.pending;
    return this.findPendingOrUnknown(pending.clientRequestId) === pending && !pending.scopeInvalid
      && pending.requestId === query.attempt && pending.queuedActionRequestId === query.operation
      && this.latestDeliveryQuery.get(pending) === requestId;
  }
  /** null 表示非本连接的已知查询；非 null 即已消费，旧查询只吞错，不写回新证据。 */
  consumeDeliveryStatusError(frame: Extract<ServerFrame, { type: "protocol_error" }>): TimelineRuntimeChange | null {
    if (!this.scope || "target_channel_id" in frame && frame.target_channel_id !== this.scope.channelId || !frame.in_reply_to) return null;
    this.pruneDeliveryQueries();
    const query = this.deliveryQueries.get(frame.in_reply_to);
    if (!query) return null;
    const pending = query.pending;
    if (!this.isCurrentDeliveryQuery(frame.in_reply_to, query) || pending.messageId
      || this.deliveryEvidence.get(pending) !== query.evidence) return this.change();
    if (pending.statusQuery?.requestId === frame.in_reply_to) delete pending.statusQuery;
    if (pending.delivery === "unknown_delivery" && frame.code === "protocol_upgrade_required") pending.statusQueryUnsupported = true;
    return this.change();
  }
  clearDeliveryStatusQuery(clientRequestId: string, unsupported = false): TimelineRuntimeChange {
    const pending = this.findPendingOrUnknown(clientRequestId);
    if (pending) {
      delete pending.statusQuery;
      if (unsupported) pending.statusQueryUnsupported = true;
    }
    return this.change();
  }
  expireDeliveryConfirmations(now = Date.now()): TimelineRuntimeChange {
    for (const pending of this.pendingItems) {
      const deadline = confirmationDeadline(pending);
      if (deadline === null || deadline > now) continue;
      this.markUnknownDelivery(pending.clientRequestId);
      delete pending.deliveryFailure;
    }
    return this.change();
  }
  expireDeliveryStatusQueries(now = Date.now()): TimelineRuntimeChange {
    for (const pending of this.pendingItems) {
      const deadline = statusQueryDeadline(pending);
      if (deadline !== null && deadline <= now) delete pending.statusQuery;
    }
    return this.change();
  }
  /** 调度方只按此时间设置定时器，与上面两个到期判定共用同一口径。 */
  nextDeliveryDeadline(): number | null {
    let next: number | null = null;
    for (const pending of this.pendingItems) {
      const deadline = statusQueryDeadline(pending) ?? confirmationDeadline(pending);
      if (deadline !== null && (next === null || deadline < next)) next = deadline;
    }
    return next;
  }
  findPendingOrUnknown(clientRequestId: string): Pending | undefined {
    return this.findPending((pending) => pending.clientRequestId === clientRequestId);
  }
  acceptsTimelineFrame(frame: ServerFrame): boolean {
    if (this.readOnly) return false;
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
    if ("target_channel_id" in frame && frame.target_channel_id !== this.scope?.channelId) return this.change();
    if (frame.type === "session_ready") return this.change();
    if (frame.type === "reset") return { ...this.invalidateScope(), reset: frame };
    if (frame.type === "queued_message_state") {
      const scope = this.scope;
      if (!scope || !isMatchingScope(scope, frame)) return this.change();
      if (this.rejectedQueuedSnapshotId === frame.snapshot_id) return this.change();
      if (this.queuedSnapshotId !== frame.snapshot_id && frame.chunk_index === 0) {
        this.queuedSnapshotId = frame.snapshot_id;
        this.queuedSnapshotItems.clear();
        this.queuedSnapshotNextChunk = 0;
      }
      // 只接受从零开始且连续的快照；final 不能把缺块或乱序内容当作完整队列。
      if (this.queuedSnapshotId !== frame.snapshot_id || frame.chunk_index !== this.queuedSnapshotNextChunk) {
        this.clearQueuedSnapshot();
        this.rejectedQueuedSnapshotId = frame.snapshot_id;
        return this.change();
      }
      this.queuedSnapshotNextChunk += 1;
      const staged = new Map(this.queuedSnapshotItems);
      for (const item of frame.items) staged.set(item.id, item);
      const stagedItems = [...staged.values()];
      const stagedIds = new Set(stagedItems.map((item) => item.id));
      const retainedPayloads = this.pendingPayloads((pending) => !stagedIds.has(pending.clientRequestId));
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
      for (const pending of [...this.pending.values(), ...this.unknown]) {
        if (!this.isCurrentPending(pending) || !pending.queued || nextIds.has(pending.clientRequestId)) continue;
        if (!pending.messageId && pending.insertionStatus !== undefined) {
          pending.queued = false;
          pending.cancelable = false;
          delete pending.queuedAction;
        } else if (!pending.messageId) {
          // 快照不再包含该条只证明它不在可取消队列，不能单独证明取消失败或成功；
          // 保留取消关联并转未知，等明确的 cancelled 查询结果再回填草稿。
          if (pending.queuedAction === "cancel") {
            pending.queued = false;
            pending.cancelable = false;
            this.markUnknownDelivery(pending.clientRequestId);
          } else if (this.pendingBases.get(pending)?.local || pending.senderRef === scope.selfSenderRef) {
            // 本端消息（含快照恢复项）缺席可能已启动或被取消，转未知并只读核对，不直接删除。
            pending.queued = false;
            pending.cancelable = false;
            this.markUnknownDelivery(pending.clientRequestId);
          } else this.deletePending(pending);
        } else {
          pending.queued = false;
          pending.cancelable = false;
        }
      }
      for (const item of nextItems) {
        const existing = this.findPending((candidate) => candidate.clientRequestId === item.id);
        if (existing?.delivery === "cancelled") continue;
        if (existing) {
          this.deliveryEvidence.set(existing, {});
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
          } else if (existing.messageId === undefined && !existing.queued && !existing.queuedAction && !existing.insertionStatus) {
            existing.queued = true;
            existing.delivery = "accepted";
          }
          existing.cancelable = item.editable && item.sender_ref === scope.selfSenderRef;
          delete existing.deliveryFailure;
          delete existing.statusQueryUnsupported;
          existing.confirmationStartedAt ??= Date.now();
          if (!item.editable && !existing.queueInFlight) existing.lastEvidenceAt = Date.now();
          applyQueueInFlight(existing, item.editable);
          continue;
        }
        this.storePending({ kind: "pending", scope, id: `pending:${item.id}`, clientRequestId: item.id, text: item.text, ...(item.images ? { images: item.images } : {}), senderRef: item.sender_ref, queued: true, cancelable: item.editable && item.sender_ref === scope.selfSenderRef, ...(item.editable ? {} : { queueInFlight: true }), createdAt: item.created_at, confirmationStartedAt: Date.now(), lastEvidenceAt: Date.now(), delivery: "accepted", requestId: item.id }, { text: item.text, ...(item.images ? { images: item.images } : {}) });
      }
      this.clearQueuedSnapshot(true);
      const change = this.change();
      if (!change.pendingCapacityExceeded) this.setQueueSnapshotReady(true);
      return change;
    }
    if (frame.type === "protocol_error") {
      const consumed = this.consumeDeliveryStatusError(frame);
      if (consumed) return consumed;
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
      if (pending && !pending.messageId && pending.delivery !== "committed") return this.markUnknownDelivery(pending.clientRequestId);
      return this.change();
    }
    if (frame.type === "user_message_status") return this.receiveDeliveryStatus(frame);
    if (frame.type === "user_message_started") {
      if (!isSameSession(this.scope, frame)) return this.change();
      const pending = this.findPending((candidate) => candidate.requestId === frame.in_reply_to);
      if (pending) {
        this.deliveryEvidence.set(pending, {});
        this.restorePending(pending);
        if (pending.delivery !== "committed") pending.delivery = "accepted";
        delete pending.deliveryFailure;
        delete pending.statusQuery;
        delete pending.statusQueryUnsupported;
        this.clearInsertionNotice(pending);
        pending.messageId = frame.message.id;
        pending.queued = false;
        pending.cancelable = false;
        this.reconcileUserMessage(frame.message.id);
      }
      return this.change();
    }
    if (frame.type === "timeline_partial") {
      // marker 等普通追加会先推进主机 leaf；partial 不推进本地 tip，真正分支变化由 reset 隔离。
      if (!isSameSession(this.scope, frame)) return this.change();
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
  get readOnlyView(): boolean { return this.readOnly; }
  formalEvents(): TimelineEvent[] { return [...this.events.values()]; }
  get pendingItems(): TimelinePending[] { return [...this.pending.values(), ...this.unknown].filter((pending) => this.isCurrentPending(pending) || this.isRetainedForDisplay(pending)); }
  /** 握手确认同一会话时预览即为已保留的投影，可增量追加；不同会话立即撤下预览。 */
  private receiveDeliveryStatus(frame: Extract<ServerFrame, { type: "user_message_status" }>): TimelineRuntimeChange {
    if (!isSameSession(this.scope, frame)) return this.change();
    const pending = this.findPendingOrUnknown(frame.client_request_id);
    if (!pending) return this.change();
    this.pruneDeliveryQueries();
    const query = this.deliveryQueries.get(frame.in_reply_to);
    const hasMessage = (frame.status === "accepted" || frame.status === "committed") && Boolean(frame.message_id);
    if (query) {
      if (query.pending !== pending || !this.isCurrentDeliveryQuery(frame.in_reply_to, query)) return this.change();
      // 同查询的新证据挡住弱／负状态；肯定 ID 仍可关联原消息，但不能跨新查询、尝试或操作。
      if (!hasMessage && this.deliveryEvidence.get(pending) !== query.evidence) return this.change();
      if (pending.statusQuery?.requestId === frame.in_reply_to) delete pending.statusQuery;
    } else if (pending.requestId !== frame.in_reply_to && pending.queuedActionRequestId !== frame.in_reply_to) return this.change();
    // 正式关联优先，较早查询与迟到的接收/拒绝都不能使已启动消息回退。
    if (pending.messageId || pending.delivery === "committed") {
      if (frame.status === "committed" && hasMessage && pending.messageId === frame.message_id) pending.delivery = "committed";
      return this.change();
    }
    // 取消已由 Pi 确认，迟到的查询或投递回执不能把它改回未知或在途。
    if (pending.delivery === "cancelled") return this.change();
    this.deliveryEvidence.set(pending, {});
    if (frame.status === "not_found") return this.change();
    if (frame.status === "cancelled") {
      // 服务端只对未投递的 received/queued 记录返回 cancelled。排队项和因证据缺失进入未知的消息
      // 都可以据此结清；明确失败是终态，不能被取消结果改写。
      if (!pending.queued && pending.delivery !== "unknown_delivery") return this.change();
      const cancellation = pending.queuedAction === "cancel" ? {
        clientRequestId: pending.clientRequestId, text: pending.text, images: pending.images, attachments: pending.attachments,
      } : null;
      // 保留内容直到调用方确认草稿与附件描述已回填；回填失败时继续只读展示。
      pending.delivery = "cancelled";
      pending.queued = false;
      pending.cancelable = false;
      delete pending.queuedAction;
      delete pending.queuedActionRequestId;
      return { ...this.change(), ...(cancellation ? { cancelledQueued: [cancellation] } : {}) };
    }
    if (frame.status === "rejected") {
      return this.markDeliveryFailed(pending.clientRequestId, frame.code, frame.retryable);
    }
    if (frame.status === "unknown_delivery") {
      if (!pending.insertionStatus) { pending.queued = false; pending.cancelable = false; }
      return this.markUnknownDelivery(pending.clientRequestId);
    }
    this.restorePending(pending);
    delete pending.deliveryFailure;
    delete pending.statusQueryUnsupported;
    pending.confirmationStartedAt = Date.now();
    pending.lastEvidenceAt = Date.now();
    if (frame.status !== "received" || pending.delivery !== "accepted") pending.delivery = frame.status;
    if (hasMessage && "message_id" in frame && frame.message_id) {
      delete pending.statusQuery;
      this.clearInsertionNotice(pending);
      pending.messageId = frame.message_id;
      pending.queued = false;
      pending.cancelable = false;
      this.reconcileUserMessage(frame.message_id);
    }
    return this.change();
  }
  private leaveReadOnly(): void {
    if (!this.readOnly) return;
    this.readOnly = false;
    this.events.clear();
  }
  private consumePreview(scope: TimelineScope): boolean {
    const preview = this.preview;
    if (!preview) return false;
    this.preview = null;
    if (preview.deviceId === scope.deviceId && preview.endpointId === scope.endpointId && preview.sessionId === scope.sessionId) return true;
    this.events.clear();
    return false;
  }
  private removeReplacedEndpointEntries(scope: TimelineScope): void {
    // 同一设备与 endpoint 的 runtime／session／Owner 变化代表原目标失效，保留只读；
    // 切到另一个 Pi 时只撤下投影，切回原目标仍可核对未确认消息。
    this.markScopeInvalid((pending) => pending.scope.deviceId === scope.deviceId
      && pending.scope.endpointId === scope.endpointId
      && !isSamePendingScope(pending.scope, scope));
  }
  private removeCurrentScopeEntries(): void {
    const current = this.scope;
    if (!current) return;
    this.markScopeInvalid((pending) => isSamePendingScope(pending.scope, current));
  }
  /**
   * 失效目标不再发送或核对，但保留正文与附件描述供用户复制；
   * 已取得正式记录或明确失败的消息不受影响。
   */
  private markScopeInvalid(predicate: (pending: Pending) => boolean): void {
    for (const pending of [...this.pending.values(), ...this.unknown]) {
      if (pending.scopeInvalid === true || !predicate(pending) || pending.messageId || pending.delivery === "committed") continue;
      pending.scopeInvalid = true;
      pending.queued = false;
      pending.cancelable = false;
      delete pending.queuedAction;
      delete pending.queuedActionRequestId;
      delete pending.statusQuery;
      delete pending.statusQueryUnsupported;
      delete pending.insertionStatus;
      delete pending.queueInFlight;
    }
  }
  private removeEntries(predicate: (pending: Pending) => boolean): void {
    for (const [clientRequestId, pending] of this.pending) {
      if (predicate(pending)) this.pending.delete(clientRequestId);
    }
    this.unknown = this.unknown.filter((pending) => !predicate(pending));
  }
  private clearQueuedSnapshot(preserveEvidence = false): void {
    this.queuedSnapshotItems.clear();
    this.queuedSnapshotId = null;
    this.queuedSnapshotNextChunk = 0;
    this.rejectedQueuedSnapshotId = null;
    if (!preserveEvidence) this.setQueueSnapshotReady(false);
  }
  private pendingPayload(pending: Pending, value: PendingPayload = pending): PendingPayload {
    const payload: PendingPayload = { text: value.text, images: value.images, attachments: value.attachments };
    const base = this.pendingBases.get(pending)!.payload;
    return JSON.stringify(payload) === JSON.stringify(base) ? payload : { ...payload, retainedPayload: base };
  }
  /** 活动 pending 的容量口径：准入、快照和附件元信息共用；失效目标的只读保留内容不计入。 */
  private pendingPayloads(include: (pending: Pending) => boolean = () => true): PendingPayload[] {
    return [...this.pending.values(), ...this.unknown]
      .filter((pending) => pending.scopeInvalid !== true && include(pending))
      .map((pending) => this.pendingPayload(pending));
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
      // 本端附件描述和原文是明确失败后的重试依据，不能被远端 sidecar 替换。
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
  private attachScope(scope: TimelineScope): void {
    this.scope = scope;
    this.displayTarget = { deviceId: scope.deviceId, endpointId: scope.endpointId };
  }
  private isRetainedForDisplay(pending: Pending): boolean {
    const target = this.displayTarget;
    return pending.scopeInvalid === true && target !== null
      && pending.scope.deviceId === target.deviceId && pending.scope.endpointId === target.endpointId;
  }
  private isCurrentPending(pending: Pending): boolean {
    if (pending.scopeInvalid === true) return false;
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
    if (pending.scopeInvalid === true) return;
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
  /** 连接或投影边界：未确认内容一律移入 unknown 保留；明确失败与已确认取消是终态，不降级为未知。 */
  private clearTransient(): void {
    this.deliveryQueries.clear();
    this.partials.clear();
    this.clearQueuedSnapshot();
    for (const pending of [...this.pending.values(), ...this.unknown]) {
      delete pending.statusQuery;
      delete pending.statusQueryUnsupported;
      if (pending.messageId || pending.delivery === "committed") continue;
      if (pending.insertionStatus) this.markInsertionUnconfirmed(pending);
      if (!isTerminalDelivery(pending.delivery)) pending.delivery = "unknown_delivery";
      this.deletePending(pending);
      this.unknown.push(pending);
    }
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
