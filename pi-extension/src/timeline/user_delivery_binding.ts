import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AttachmentStoreError } from "../attachments/store.js";
import type { ClientFrame, ServerFrame, TimelineEvent } from "../protocol/v2/index.js";
import type { Correlation, TimelineRuntime, TimelineStarted } from "./runtime.js";
import {
  UserDeliveryQueue,
  type UserDeliveryEnqueueResult,
  type UserDeliveryPayload,
  type UserDeliveryScope,
  type UserDeliveryScopeInput,
  type UserDeliverySteerResult,
} from "./user_delivery.js";
import type { TimelineV2Service } from "./v2_service.js";

type UserMessageFrame = Extract<ClientFrame, { type: "user_message" }>;

export type UserDeliveryRejection = {
  kind: "rejected";
  code: "invalid_target" | "unavailable" | "queue_full";
  retryable: boolean;
};

function preparationRejection(error: unknown): UserDeliveryRejection {
  if (error instanceof AttachmentStoreError) {
    if (error.code === "busy" || error.code === "no_space") {
      return { kind: "rejected", code: "unavailable", retryable: error.retryable };
    }
    // Store 的 io_error 也包含已丢失原件，缺少更强证据时不能把它当作可重试暂态。
    return { kind: "rejected", code: error.code === "io_error" ? "unavailable" : "invalid_target", retryable: false };
  }
  return { kind: "rejected", code: "unavailable", retryable: false };
}

export type UserDeliveryTarget = {
  readonly service: TimelineV2Service;
  readonly sessionId: string;
  readonly leafId: string | null;
};

export type UserDeliveryBindingOptions = {
  isIdle: () => boolean;
  canAcceptNormal: () => boolean;
  getPi: () => ExtensionAPI | null;
  getTimeline: () => TimelineRuntime | null;
  getCurrentSessionId: () => string | null;
  getCurrentLeafId: () => string | null;
  findTarget: (ownerId: string) => UserDeliveryTarget | null;
  sendFrames: (ownerId: string, frames: readonly ServerFrame[]) => void;
  prepareAttachment?: (frame: UserMessageFrame, ownerId: string) => { content: string; payload: UserDeliveryPayload } | null;
  beforeSend?: (correlation: Correlation) => void;
};

export class UserDeliveryBinding {
  private readonly options: UserDeliveryBindingOptions;
  private readonly queue: UserDeliveryQueue;

  constructor(options: UserDeliveryBindingOptions) {
    this.options = options;
    this.queue = new UserDeliveryQueue({
      isIdle: options.isIdle,
      isCurrent: (scope) => this.isCurrent(scope),
      send: (content, correlation, sendOptions) => this.send(content, correlation, sendOptions),
      onUnknownDelivery: (scope) => this.sendScope(scope, scope.service.unknownDelivery(scope.clientRequestId)),
      onQueueChanged: (scope) => this.sendSnapshot(scope),
      canQueueItem: (scope, item) => scope.service.canQueueItem(item),
    });
  }

  submit(frame: UserMessageFrame, correlation: Correlation, scope: UserDeliveryScopeInput): UserDeliveryEnqueueResult | UserDeliveryRejection | true {
    if (frame.attachment_ids && frame.streaming_behavior === "steer") return "conflict";
    if (frame.streaming_behavior === "steer") return this.sendSteer(messageContent(frame), correlation);
    // 尚无可投递的 Pi 上下文：未入队也未调用 SDK，属于可重试的确定拒绝而非未知。
    if (!this.options.canAcceptNormal()) return { kind: "rejected", code: "unavailable", retryable: true };
    if (frame.attachment_ids) {
      if (!this.options.prepareAttachment) return "conflict";
      let prepared: ReturnType<NonNullable<UserDeliveryBindingOptions["prepareAttachment"]>>;
      // 只有准备阶段可证明未入队/未调用 SDK；enqueue、beforeSend 和 SDK 不在此 catch 中。
      try {
        prepared = this.options.prepareAttachment(frame, scope.ownerId);
      } catch (error) {
        return preparationRejection(error);
      }
      if (!prepared) return "rejected";
      const result = this.queue.enqueue(prepared.content, correlation, { ...scope, leafId: this.options.getCurrentLeafId() }, prepared.payload);
      if (result !== "queued" && result !== "duplicate") prepared.payload.on_release?.();
      return result;
    }
    return this.queue.enqueue(messageContent(frame), correlation, scope, messagePayload(frame));
  }

  snapshot(ownerId: string, service: TimelineV2Service): ServerFrame[] {
    return service.queueSnapshot(this.queue.snapshot(ownerId, service));
  }

  lookup(ownerId: string, service: TimelineV2Service, clientRequestId: string): "queued" | "in_flight" | null {
    return this.queue.lookup(ownerId, service, clientRequestId);
  }

  clearQueued(ownerId: string, service: TimelineV2Service, targetId?: string): string[] {
    return this.queue.clearQueued(ownerId, service, targetId).map((scope) => scope.clientRequestId);
  }

  steerQueued(ownerId: string, service: TimelineV2Service, targetId: string): UserDeliverySteerResult {
    return this.queue.steer(ownerId, service, targetId);
  }

  onStarted(started: TimelineStarted): void {
    if (started.role !== "user") return;
    const scope = this.queue.onUserStarted(started);
    if (!scope) return;
    this.sendScope(scope, scope.service.started(started));
    this.sendSnapshot(scope);
  }

  onPublished(event: TimelineEvent, correlation: Correlation): void {
    if (event.kind !== "user") return;
    const scope = this.queue.onUserPublished(event, correlation);
    if (scope) this.sendScope(scope, scope.service.commit(scope.clientRequestId, event.event_id, event.group_id));
  }

  clearOwner(ownerId: string, service?: TimelineV2Service): void {
    this.queue.clearOwner(ownerId, service);
  }

  clearAll(): void {
    this.queue.clearAll();
  }

  scheduleDrain(): void {
    this.queue.scheduleDrain();
  }

  private sendSteer(content: Parameters<ExtensionAPI["sendUserMessage"]>[0], correlation: Correlation): boolean {
    try {
      this.send(content, correlation, { deliverAs: "steer" });
      return true;
    } catch {
      return false;
    }
  }

  private send(
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
    correlation: Correlation,
    options?: Parameters<ExtensionAPI["sendUserMessage"]>[1],
  ): void {
    const pi = this.options.getPi();
    if (!pi) throw new Error("Pi API is unavailable");
    const send = () => {
      this.options.beforeSend?.(correlation);
      pi.sendUserMessage(content, options);
    };
    const timeline = this.options.getTimeline();
    const steer = timeline !== null && options?.deliverAs === "steer";
    if (steer) timeline.expectSteer(content, correlation);
    try {
      if (timeline) timeline.runWithCorrelation(correlation, send); else send();
    } catch (error) {
      if (steer) timeline.discardSteer(correlation);
      throw error;
    }
  }

  private isCurrent(scope: UserDeliveryScope): boolean {
    const target = this.options.findTarget(scope.ownerId);
    return target?.service === scope.service
      && target.sessionId === scope.sessionId
      && this.options.getCurrentSessionId() === scope.sessionId
      && this.options.getCurrentLeafId() === scope.leafId;
  }

  private sendSnapshot(scope: UserDeliveryScope): void {
    if (this.isCurrent(scope)) this.options.sendFrames(scope.ownerId, this.snapshot(scope.ownerId, scope.service));
  }

  private sendScope(scope: UserDeliveryScope, frames: readonly ServerFrame[]): void {
    if (this.isCurrent(scope)) this.options.sendFrames(scope.ownerId, frames);
  }
}

function messageContent(frame: UserMessageFrame): Parameters<ExtensionAPI["sendUserMessage"]>[0] {
  if (!frame.images?.length) return frame.text;
  return [
    ...frame.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mime })),
    { type: "text" as const, text: frame.text },
  ];
}

function messagePayload(frame: UserMessageFrame) {
  return {
    text: frame.text,
    ...(frame.images?.length ? { images: frame.images.map((image) => ({ ...image })) } : {}),
  };
}
