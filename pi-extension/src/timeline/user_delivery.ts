import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerFrame, TimelineEvent } from "../protocol/v2/index.js";
import type { Correlation, TimelineStarted } from "./runtime.js";
import type { TimelineV2Service } from "./v2_service.js";

export const USER_DELIVERY_START_TIMEOUT_MS = 30_000;
export const MAX_USER_DELIVERY_ENTRIES = 32;
export const MAX_USER_DELIVERY_BYTES = 8 * 1024 * 1024;
const MAX_LATE_DELIVERY_RECORDS = 128;

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type UserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type DeliveryState = "queued" | "steering" | "in_flight" | "started" | "timed_out";
type DeliveryTimer = ReturnType<typeof setTimeout>;
type DeliveryImmediate = ReturnType<typeof setImmediate>;

export type QueuedMessageItem = Extract<ServerFrame, { type: "queued_message_state" }>["items"][number];
export type UserDeliveryPayload = Readonly<{
  text: string;
  images?: readonly Readonly<{ data: string; mime: string }>[];
}>;

export type UserDeliveryScope = {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly service: TimelineV2Service;
  readonly clientRequestId: string;
  readonly deliveryToken: string;
};

export type UserDeliveryScopeInput = Omit<UserDeliveryScope, "deliveryToken">;

export type UserDeliveryEnqueueResult = "queued" | "duplicate" | "conflict" | "rejected" | false;
export type UserDeliverySteerResult =
  | { kind: "sent"; scope: UserDeliveryScope }
  | { kind: "failed"; scope: UserDeliveryScope }
  | { kind: "missing" };

type DeliveryJob = {
  scope: UserDeliveryScope;
  readonly correlation: Correlation;
  readonly bytes: number;
  readonly createdAt: number;
  content: UserMessageContent | undefined;
  payload: UserDeliveryPayload | undefined;
  state: DeliveryState;
  timer: DeliveryTimer | undefined;
};

export type UserDeliveryQueueOptions = {
  isIdle: () => boolean;
  isCurrent: (scope: UserDeliveryScope) => boolean;
  send: (content: UserMessageContent, correlation: Correlation, options?: UserMessageOptions) => void;
  onUnknownDelivery: (scope: UserDeliveryScope) => void;
  onQueueChanged?: (scope: UserDeliveryScope) => void;
  canQueueItem?: (scope: UserDeliveryScopeInput, item: QueuedMessageItem) => boolean;
  clock?: () => number;
  startTimeoutMs?: number;
  maxEntries?: number;
  maxBytes?: number;
};

export class UserDeliveryQueue {
  private readonly isIdle: UserDeliveryQueueOptions["isIdle"];
  private readonly isCurrent: UserDeliveryQueueOptions["isCurrent"];
  private readonly send: UserDeliveryQueueOptions["send"];
  private readonly onUnknownDelivery: UserDeliveryQueueOptions["onUnknownDelivery"];
  private readonly onQueueChanged?: UserDeliveryQueueOptions["onQueueChanged"];
  private readonly canQueueItem: NonNullable<UserDeliveryQueueOptions["canQueueItem"]>;
  private readonly clock: () => number;
  private readonly startTimeoutMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly jobs = new Map<string, DeliveryJob>();
  private queue: DeliveryJob[] = [];
  private lateTokens: string[] = [];
  private active: DeliveryJob | undefined;
  private scheduled: DeliveryImmediate | undefined;
  private queuedPayloadCount = 0;
  private queuedPayloadBytes = 0;

  constructor(options: UserDeliveryQueueOptions) {
    this.isIdle = options.isIdle;
    this.isCurrent = options.isCurrent;
    this.send = options.send;
    this.onUnknownDelivery = options.onUnknownDelivery;
    this.onQueueChanged = options.onQueueChanged;
    this.canQueueItem = options.canQueueItem ?? (() => true);
    this.clock = options.clock ?? Date.now;
    this.startTimeoutMs = positiveInteger(options.startTimeoutMs, USER_DELIVERY_START_TIMEOUT_MS);
    this.maxEntries = positiveInteger(options.maxEntries, MAX_USER_DELIVERY_ENTRIES);
    this.maxBytes = positiveInteger(options.maxBytes, MAX_USER_DELIVERY_BYTES);
  }

  enqueue(
    content: UserMessageContent,
    correlation: Correlation,
    scope: UserDeliveryScopeInput,
    payload: UserDeliveryPayload = payloadFromContent(content),
  ): UserDeliveryEnqueueResult {
    if (!this.isCurrentScope(scope)) return false;
    const existing = this.findTarget(scope.ownerId, scope.service, scope.clientRequestId);
    if (existing) return payloadEquals(existing.payload, payload) ? "duplicate" : "conflict";

    const bytes = contentBytes(content);
    const deliveryToken = randomUUID();
    const job: DeliveryJob = {
      scope: { ...scope, deliveryToken },
      correlation: { ...correlation, deliveryToken },
      bytes,
      createdAt: this.clock(),
      content,
      payload: copyPayload(payload),
      state: "queued",
      timer: undefined,
    };
    if (!this.canQueueItem(scope, this.itemFor(job))) return "rejected";
    if (this.queuedPayloadCount >= this.maxEntries || this.queuedPayloadBytes + bytes > this.maxBytes) return "rejected";

    this.jobs.set(deliveryToken, job);
    this.queue.push(job);
    this.queuedPayloadCount += 1;
    this.queuedPayloadBytes += bytes;
    this.scheduleDrain();
    return "queued";
  }

  snapshot(ownerId: string, service: TimelineV2Service): QueuedMessageItem[] {
    const items: QueuedMessageItem[] = [];
    for (const job of this.jobs.values()) {
      if (!this.matches(job, ownerId, service) || (job.state !== "queued" && job.state !== "in_flight")) continue;
      items.push(this.itemFor(job));
    }
    return items;
  }

  clearQueued(ownerId: string, service: TimelineV2Service, targetId?: string): UserDeliveryScope[] {
    const removed: UserDeliveryScope[] = [];
    for (const job of [...this.jobs.values()]) {
      if (job.state !== "queued" || !this.matches(job, ownerId, service)) continue;
      if (targetId !== undefined && job.scope.clientRequestId !== targetId) continue;
      removed.push(job.scope);
      this.remove(job);
    }
    this.rescheduleAfterMutation();
    return removed;
  }

  steer(ownerId: string, service: TimelineV2Service, targetId: string): UserDeliverySteerResult {
    const job = this.findTarget(ownerId, service, targetId);
    if (!job || job.state !== "queued" || job.content === undefined) return { kind: "missing" };

    const queueIndex = this.queue.indexOf(job);
    job.state = "steering";
    this.queue = this.queue.filter((candidate) => candidate !== job);
    if (this.queue.length === 0 && !this.active) this.cancelScheduledDrain();
    try {
      this.send(job.content, job.correlation, { deliverAs: "steer" });
    } catch {
      job.state = "queued";
      this.queue.splice(Math.max(0, queueIndex), 0, job);
      this.scheduleDrain();
      return { kind: "failed", scope: job.scope };
    }

    const scope = job.scope;
    this.remove(job);
    this.scheduleDrain();
    return { kind: "sent", scope };
  }

  scheduleDrain(): void {
    if (this.scheduled || this.queue.length === 0) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.drain();
    });
  }

  onUserStarted(started: TimelineStarted): UserDeliveryScope | null {
    if (started.role !== "user") return null;
    const job = this.jobFor(started.correlation);
    if (!job) return null;
    if (!this.isCurrentScope(job.scope)) {
      if (job.state === "in_flight" && job.scope.sessionId === job.scope.service.sessionId) {
        job.scope = { ...job.scope, leafId: job.scope.service.leafId };
      }
      if (!this.isCurrentScope(job.scope)) {
        this.remove(job);
        return null;
      }
    }
    if (job.state !== "in_flight" && job.state !== "timed_out") return null;
    this.clearTimer(job);
    this.releasePayload(job);
    job.state = "started";
    if (this.active === job) this.active = undefined;
    this.scheduleDrain();
    return job.scope;
  }

  onUserPublished(event: TimelineEvent, correlation: Correlation): UserDeliveryScope | null {
    if (event.kind !== "user") return null;
    const job = this.jobFor(correlation);
    if (!job) return null;
    if (job.scope.sessionId !== event.session_id) {
      this.remove(job);
      return null;
    }
    job.scope = { ...job.scope, leafId: event.leaf_id };
    if (!this.isCurrentScope(job.scope)) {
      this.remove(job);
      return null;
    }
    if (job.state !== "started") return null;
    const scope = job.scope;
    this.remove(job);
    return scope;
  }

  clearOwner(ownerId: string, service?: TimelineV2Service): void {
    this.clearWhere((scope) => scope.ownerId === ownerId && (service === undefined || scope.service === service));
  }

  clearAll(): void {
    this.clearWhere(() => true);
  }

  private drain(): void {
    if (this.active || !this.isIdle()) return;
    for (;;) {
      const job = this.queue.shift();
      if (!job) return;
      if (!this.jobs.has(job.scope.deliveryToken)) {
        this.remove(job);
        continue;
      }
      if (job.state === "queued" && job.scope.sessionId === job.scope.service.sessionId && job.scope.leafId !== job.scope.service.leafId) {
        job.scope = { ...job.scope, leafId: job.scope.service.leafId };
      }
      if (!this.isCurrentScope(job.scope)) {
        this.remove(job);
        continue;
      }
      if (job.state !== "queued" || job.content === undefined) {
        this.remove(job);
        continue;
      }
      job.state = "in_flight";
      this.active = job;
      this.notifyQueueChanged(job.scope);
      try {
        this.send(job.content, job.correlation);
      } catch {
        this.failBeforeStart(job, false);
        continue;
      }
      if (job.state === "in_flight") this.startTimer(job);
      return;
    }
  }

  private startTimer(job: DeliveryJob): void {
    job.timer = setTimeout(() => this.failBeforeStart(job, true), this.startTimeoutMs);
    job.timer.unref?.();
  }

  private failBeforeStart(job: DeliveryJob, retainLateRecord: boolean): void {
    if (job.state !== "in_flight" || !this.jobs.has(job.scope.deliveryToken)) return;
    this.clearTimer(job);
    this.releasePayload(job);
    if (this.active === job) this.active = undefined;
    if (retainLateRecord) {
      job.state = "timed_out";
      this.lateTokens.push(job.scope.deliveryToken);
      this.trimLateRecords();
    } else {
      this.remove(job);
    }
    if (this.isCurrentScope(job.scope)) {
      this.onUnknownDelivery(job.scope);
      this.notifyQueueChanged(job.scope);
    }
    this.scheduleDrain();
  }

  private trimLateRecords(): void {
    while (this.lateTokens.length > MAX_LATE_DELIVERY_RECORDS) {
      const token = this.lateTokens.shift();
      if (!token) return;
      const job = this.jobs.get(token);
      if (job?.state === "timed_out") this.remove(job);
    }
  }

  private clearWhere(predicate: (scope: UserDeliveryScope) => boolean): void {
    let removed = false;
    for (const job of [...this.jobs.values()]) {
      if (!predicate(job.scope)) continue;
      this.remove(job);
      removed = true;
    }
    if (removed) this.rescheduleAfterMutation();
  }

  private rescheduleAfterMutation(): void {
    if (this.queue.length === 0 && !this.active) this.cancelScheduledDrain();
    else this.scheduleDrain();
  }

  private findTarget(ownerId: string, service: TimelineV2Service, targetId: string): DeliveryJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.scope.clientRequestId === targetId && this.matches(job, ownerId, service)) return job;
    }
    return undefined;
  }

  private matches(job: DeliveryJob, ownerId: string, service: TimelineV2Service): boolean {
    return job.scope.ownerId === ownerId
      && job.scope.service === service
      && job.scope.sessionId === service.sessionId
      && job.scope.leafId === service.leafId
      && this.isCurrentScope(job.scope);
  }

  private itemFor(job: DeliveryJob): QueuedMessageItem {
    const payload = job.payload ?? { text: "" };
    return {
      id: job.scope.clientRequestId,
      text: payload.text,
      ...(payload.images?.length ? { images: payload.images.map((image) => ({ ...image })) } : {}),
      sender_ref: job.scope.ownerId,
      editable: job.state === "queued",
      created_at: job.createdAt,
    };
  }

  private jobFor(correlation: Correlation): DeliveryJob | undefined {
    return correlation.deliveryToken ? this.jobs.get(correlation.deliveryToken) : undefined;
  }

  private isCurrentScope(scope: UserDeliveryScope | UserDeliveryScopeInput): boolean {
    return this.isCurrent(scope as UserDeliveryScope);
  }

  private releasePayload(job: DeliveryJob): void {
    if (job.content === undefined) return;
    job.content = undefined;
    job.payload = undefined;
    this.queuedPayloadCount -= 1;
    this.queuedPayloadBytes -= job.bytes;
  }

  private clearTimer(job: DeliveryJob): void {
    if (!job.timer) return;
    clearTimeout(job.timer);
    job.timer = undefined;
  }

  private remove(job: DeliveryJob): void {
    this.clearTimer(job);
    this.releasePayload(job);
    if (this.active === job) this.active = undefined;
    this.jobs.delete(job.scope.deliveryToken);
    this.queue = this.queue.filter((candidate) => candidate !== job);
    this.lateTokens = this.lateTokens.filter((token) => token !== job.scope.deliveryToken);
  }

  private notifyQueueChanged(scope: UserDeliveryScope): void {
    try {
      this.onQueueChanged?.(scope);
    } catch {
      // Queue delivery must not depend on a best-effort snapshot send.
    }
  }

  private cancelScheduledDrain(): void {
    if (!this.scheduled) return;
    clearImmediate(this.scheduled);
    this.scheduled = undefined;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function copyPayload(payload: UserDeliveryPayload): UserDeliveryPayload {
  return {
    text: payload.text,
    ...(payload.images?.length ? { images: payload.images.map((image) => ({ ...image })) } : {}),
  };
}

function payloadEquals(left: UserDeliveryPayload | undefined, right: UserDeliveryPayload): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function payloadFromContent(content: UserMessageContent): UserDeliveryPayload {
  if (typeof content === "string") return { text: content };
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
  const images = content
    .filter((part) => part.type === "image")
    .map((part) => ({ data: part.data, mime: part.mimeType }));
  return { text, ...(images.length ? { images } : {}) };
}

function contentBytes(content: UserMessageContent): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  let bytes = 0;
  for (const part of content) {
    bytes += Buffer.byteLength(part.type === "text" ? part.text : part.data, "utf8");
    if (part.type === "image") bytes += Buffer.byteLength(part.mimeType, "utf8");
  }
  return bytes;
}
