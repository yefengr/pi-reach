import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ClientFrame, ServerFrame, TimelineEvent } from "../protocol/v2/index.js";
import type { Correlation, TimelineRuntime, TimelineStarted } from "./runtime.js";
import {
  UserDeliveryQueue,
  type UserDeliveryEnqueueResult,
  type UserDeliveryScope,
  type UserDeliveryScopeInput,
  type UserDeliverySteerResult,
} from "./user_delivery.js";
import type { TimelineV2Service } from "./v2_service.js";

type UserMessageFrame = Extract<ClientFrame, { type: "user_message" }>;

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

  submit(frame: UserMessageFrame, correlation: Correlation, scope: UserDeliveryScopeInput): UserDeliveryEnqueueResult | true {
    if (frame.streaming_behavior === "steer") return this.sendSteer(messageContent(frame), correlation);
    if (!this.options.canAcceptNormal()) return false;
    return this.queue.enqueue(messageContent(frame), correlation, scope, messagePayload(frame));
  }

  snapshot(ownerId: string, service: TimelineV2Service): ServerFrame[] {
    return service.queueSnapshot(this.queue.snapshot(ownerId, service));
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
    const send = () => pi.sendUserMessage(content, options);
    const timeline = this.options.getTimeline();
    if (timeline) timeline.runWithCorrelation(correlation, send); else send();
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
