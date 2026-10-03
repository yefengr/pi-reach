import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  TimelineEventSchema,
  V2SessionState,
  MAX_FRAME_BYTES,
  MAX_FRAGMENT_DECODE_BYTES,
  type ClientFrame,
  type ServerFrame,
  type TimelineEvent,
  type TimelinePartial,
} from "../protocol/v2/index.js";
import { attachmentReplayFrames, type AttachmentReplay } from "./attachment_delivery.js";
import { userMessageIdempotencyPayload } from "./attachment_content.js";
import { TimelineHistoryPager } from "./history.js";
import type { Correlation, TimelineRuntime, TimelineStarted } from "./runtime.js";

export type V2ActionFrame = Extract<
  ClientFrame,
  { type: "session_new" | "session_compact" | "model_set" | "thinking_set" }
>;

export type V2ServiceOptions = {
  sessionManager: SessionManager;
  senderRef: string;
  extensionVersion: string;
  runtime: TimelineRuntime;
  onUserMessage: (
    frame: Extract<ClientFrame, { type: "user_message" }>,
    correlation: Correlation,
  ) => boolean | "queued" | "duplicate" | "conflict" | "rejected";
  onAttachmentReplay?: (frame: Extract<ClientFrame, { type: "user_message" }>) => AttachmentReplay;
  onCancel?: () => boolean;
  onAction?: (frame: V2ActionFrame) => void;
  onQueueSnapshot?: () => ServerFrame[];
  onQueuedMessageClear?: (targetId?: string) => string[];
  onQueuedMessageSteer?: (targetId: string) => "sent" | "failed" | "missing";
  onListModels?: () => Pick<Extract<ServerFrame, { type: "models_list" }>, "models" | "current">;
};

export type V2Broadcast = Extract<
  ServerFrame,
  { type: "timeline_event" | "timeline_partial" | "timeline_event_fragment" }
>;

type RecordWithChannel = ReturnType<V2SessionState["snapshot"]>["records"][number] & { channelId: string };
type QueuedMessageItem = Extract<ServerFrame, { type: "queued_message_state" }>["items"][number];

export class TimelineV2Service {
  private readonly state: V2SessionState;
  private readonly pager: TimelineHistoryPager;
  private readonly sessionManager: SessionManager;
  private readonly senderRef: string;
  private readonly extensionVersion: string;
  private readonly runtime: TimelineRuntime;
  private readonly onUserMessage: V2ServiceOptions["onUserMessage"];
  private readonly onAttachmentReplay?: V2ServiceOptions["onAttachmentReplay"];
  private readonly onCancel?: V2ServiceOptions["onCancel"];
  private readonly onAction?: V2ServiceOptions["onAction"];
  private readonly onQueueSnapshot?: V2ServiceOptions["onQueueSnapshot"];
  private readonly onQueuedMessageClear?: V2ServiceOptions["onQueuedMessageClear"];
  private readonly onQueuedMessageSteer?: V2ServiceOptions["onQueuedMessageSteer"];
  private readonly onListModels?: V2ServiceOptions["onListModels"];
  private readonly requestChannels = new Map<string, string>();

  constructor(options: V2ServiceOptions) {
    this.sessionManager = options.sessionManager;
    this.senderRef = options.senderRef;
    this.extensionVersion = options.extensionVersion;
    this.state = new V2SessionState({ sessionId: options.sessionManager.getSessionId(), leafId: options.sessionManager.getLeafId() ?? null });
    this.runtime = options.runtime;
    this.onUserMessage = options.onUserMessage;
    this.onCancel = options.onCancel;
    this.onAttachmentReplay = options.onAttachmentReplay;
    this.onAction = options.onAction;
    this.onQueueSnapshot = options.onQueueSnapshot;
    this.onQueuedMessageClear = options.onQueuedMessageClear;
    this.onQueuedMessageSteer = options.onQueuedMessageSteer;
    this.onListModels = options.onListModels;
    this.pager = new TimelineHistoryPager(
      this.sessionManager,
      (manager) => this.runtime.recover(manager),
    );
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get leafId(): string | null {
    return this.sessionManager.getLeafId() ?? null;
  }

  canQueueItem(item: QueuedMessageItem): boolean {
    // 为非最终分块与后续 chunk_index 预留序列化空间。
    return this.frameBytes(this.queueFrame(randomUUID(), Number.MAX_SAFE_INTEGER, false, [item])) <= MAX_FRAME_BYTES;
  }

  queueSnapshot(items: readonly QueuedMessageItem[]): ServerFrame[] {
    const snapshotId = randomUUID();
    if (items.length === 0) return [this.queueFrame(snapshotId, 0, true, [])];

    const frames: ServerFrame[] = [];
    let chunk: QueuedMessageItem[] = [];
    for (const item of items) {
      const candidate = [...chunk, item];
      if (this.frameBytes(this.queueFrame(snapshotId, frames.length, false, candidate)) <= MAX_FRAME_BYTES) {
        chunk = candidate;
        continue;
      }
      if (chunk.length === 0) throw new Error("queued message item exceeds the frame limit");
      frames.push(this.queueFrame(snapshotId, frames.length, false, chunk));
      chunk = [item];
    }
    const final = this.queueFrame(snapshotId, frames.length, true, chunk);
    if (this.frameBytes(final) > MAX_FRAME_BYTES) throw new Error("queued message item exceeds the frame limit");
    frames.push(final);
    return frames;
  }

  reset(reason: "branch_changed" | "session_replaced"): ServerFrame[] {
    return this.state.snapshot().channels.map((channel) => ({
      protocol_version: 2,
      type: "reset" as const,
      target_channel_id: channel.channelId,
      session_id: this.sessionId,
      leaf_id: this.leafId,
      reason,
    }));
  }

  refreshScope(): boolean {
    const sessionId = this.sessionId;
    const leafId = this.leafId;
    if (sessionId === this.state.sessionId && leafId === this.state.leafId) return false;
    this.state.setScope(sessionId, leafId);
    this.requestChannels.clear();
    return true;
  }

  handle(frame: ClientFrame): ServerFrame[] {
    switch (frame.type) {
      case "session_hello":
        return [this.ready(frame), ...this.currentQueueSnapshot()];
      case "extension_info_request":
        return this.handleExtensionInfo(frame);
      case "pair_request":
        return [this.error(frame.id, "protocol_upgrade_required", "pairing is handled before session_hello")];
      case "session_sync":
        return this.handleHistory(frame);
      case "ping":
        return this.handlePing(frame);
      case "cancel":
        return this.handleCancel(frame);
      case "user_message":
        return this.handleUserMessage(frame);
      case "user_message_observed":
        return this.handleObserved(frame);
      case "session_new":
      case "session_compact":
      case "model_set":
      case "thinking_set":
        return this.handleAction(frame);
      case "attachment_capabilities_request":
      case "attachment_begin":
      case "attachment_chunk":
      case "attachment_finish":
      case "attachment_status_request":
      case "attachment_cancel":
      case "attachment_discard":
      case "file_open":
      case "file_read":
      case "file_close":
      case "queued_message_set":
      case "approve_tool":
        return this.requireReady(frame);
      case "list_models":
        return this.handleListModels(frame);
      case "queued_message_clear":
        return this.handleQueuedMessageClear(frame);
      case "queued_message_steer":
        return this.handleQueuedMessageSteer(frame);
    }
  }

  started(started: TimelineStarted): ServerFrame[] {
    const clientRequestId = started.correlation.clientRequestId;
    if (!clientRequestId) return [];
    const request = this.findRecord(clientRequestId);
    if (!request) return [];
    this.state.update(request.key, "accepted", { messageId: started.eventId, groupId: started.groupId });
    const message = {
      id: started.eventId,
      group_id: started.groupId,
      blocks: started.blocks as never,
      origin: started.correlation.origin,
      ...(started.correlation.senderRef ? { sender_ref: started.correlation.senderRef } : {}),
      delivery: started.correlation.delivery,
    };
    return [
      ...this.direct(request.channelId, {
        type: "user_message_status",
        in_reply_to: started.correlation.requestId ?? clientRequestId,
        session_id: this.sessionId,
        leaf_id: this.leafId,
        client_request_id: clientRequestId,
        status: "accepted",
        message_id: started.eventId,
        group_id: started.groupId,
      }),
      ...this.direct(request.channelId, {
        type: "user_message_started",
        in_reply_to: started.correlation.requestId ?? clientRequestId,
        session_id: this.sessionId,
        leaf_id: this.leafId,
        message,
      }),
    ];
  }

  commit(clientRequestId: string, messageId: string, groupId?: string): ServerFrame[] {
    const request = this.findRecord(clientRequestId);
    if (!request) return [];
    const record = this.state.update(request.key, "committed", { messageId, groupId });
    if (!record) return [];
    return this.direct(request.channelId, {
      type: "user_message_status",
      in_reply_to: clientRequestId,
      session_id: this.sessionId,
      leaf_id: this.leafId,
      client_request_id: clientRequestId,
      status: "committed",
      message_id: messageId,
      ...(groupId ? { group_id: groupId } : {}),
    });
  }

  canDrain(clientRequestId: string): boolean {
    const status = this.findRecord(clientRequestId)?.status;
    return status === "received" || status === "queued";
  }

  unknownDelivery(clientRequestId: string): ServerFrame[] {
    const request = this.findRecord(clientRequestId);
    if (!request) return [];
    const updated = this.state.rememberUnknownDelivery(request.key);
    if (!updated) return [];
    return this.direct(request.channelId, {
      type: "user_message_status",
      in_reply_to: clientRequestId,
      session_id: this.sessionId,
      leaf_id: this.leafId,
      client_request_id: clientRequestId,
      status: "unknown_delivery",
    });
  }

  partial(partial: TimelinePartial): V2Broadcast | null {
    if (partial.session_id !== this.sessionId || partial.leaf_id !== this.leafId) return null;
    return partial as V2Broadcast;
  }

  publish(event: TimelineEvent): V2Broadcast | null {
    return this.publishFrames(event)[0] as V2Broadcast | undefined ?? null;
  }

  publishFrames(event: TimelineEvent): V2Broadcast[] {
    const parsed = TimelineEventSchema.safeParse(event);
    if (!parsed.success || parsed.data.event_seq === undefined || parsed.data.session_id !== this.sessionId || parsed.data.leaf_id !== this.leafId) {
      if (event.kind === "run_end") console.warn("[pi-reach] run_end publication rejected", {
        reason: !parsed.success ? "invalid_event" : parsed.data.event_seq === undefined ? "missing_event_seq"
          : parsed.data.session_id !== this.sessionId ? "session_mismatch" : "leaf_mismatch",
        event_id: event.event_id, group_id: event.group_id, event_seq: event.event_seq,
        event_scope: { session_id: event.session_id, leaf_id: event.leaf_id },
        service_scope: { session_id: this.sessionId, leaf_id: this.leafId },
      });
      return [];
    }
    const complete: V2Broadcast = {
      protocol_version: 2,
      type: "timeline_event",
      session_id: this.sessionId,
      leaf_id: this.leafId,
      event: parsed.data,
    };
    if (new TextEncoder().encode(JSON.stringify(complete)).byteLength <= MAX_FRAME_BYTES) return [complete];
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
    const frames: V2Broadcast[] = [];
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += MAX_FRAGMENT_DECODE_BYTES, index += 1) {
      const slice = bytes.slice(offset, offset + MAX_FRAGMENT_DECODE_BYTES);
      frames.push({
        protocol_version: 2,
        type: "timeline_event_fragment",
        session_id: this.sessionId,
        leaf_id: this.leafId,
        event_id: parsed.data.event_id,
        index,
        data_base64: Buffer.from(slice).toString("base64"),
        final: offset + slice.byteLength >= bytes.byteLength,
      });
    }
    return frames;
  }

  private ready(frame: Extract<ClientFrame, { type: "session_hello" }>): ServerFrame {
    this.state.hello(this.senderRef, frame.channel_id);
    const headSeq = this.runtime.recover(this.sessionManager).at(-1)?.event_seq ?? 0;
    return {
      protocol_version: 2,
      type: "session_ready",
      in_reply_to: frame.id,
      target_channel_id: frame.channel_id,
      session_id: this.sessionId,
      leaf_id: this.leafId,
      self_sender_ref: this.senderRef,
      head_seq: headSeq,
    };
  }

  private handleExtensionInfo(frame: Extract<ClientFrame, { type: "extension_info_request" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    return this.direct(frame.channel_id, { type: "extension_info", in_reply_to: frame.id, version: this.extensionVersion });
  }

  private handleHistory(frame: Extract<ClientFrame, { type: "session_sync" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    return this.pager.sync({
      requestId: frame.id,
      targetChannelId: frame.channel_id,
      leafId: frame.leaf_id,
      before: frame.before,
      limit: frame.limit,
    });
  }

  private handlePing(frame: Extract<ClientFrame, { type: "ping" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    return this.direct(frame.channel_id, { type: "pong", in_reply_to: frame.id });
  }

  private handleQueuedMessageClear(frame: Extract<ClientFrame, { type: "queued_message_clear" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    if (!this.onQueuedMessageClear) {
      return [this.error(frame.id, "unsupported_type", "Queued messages are unavailable.", frame.channel_id), ...this.currentQueueSnapshot()];
    }
    try {
      const removed = this.onQueuedMessageClear(frame.target_id);
      for (const clientRequestId of removed) this.terminateQueuedRequest(clientRequestId);
      if (frame.target_id !== undefined && !removed.includes(frame.target_id)) {
        return [this.error(frame.id, "invalid_message", "This message has already started sending or is no longer queued.", frame.channel_id), ...this.currentQueueSnapshot()];
      }
      return this.currentQueueSnapshot();
    } catch {
      return [this.error(frame.id, "internal_error", "Could not clear queued messages.", frame.channel_id), ...this.currentQueueSnapshot()];
    }
  }

  private handleQueuedMessageSteer(frame: Extract<ClientFrame, { type: "queued_message_steer" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    if (!this.onQueuedMessageSteer) {
      return [this.error(frame.id, "unsupported_type", "Queued messages are unavailable.", frame.channel_id), ...this.currentQueueSnapshot()];
    }
    try {
      const result = this.onQueuedMessageSteer(frame.target_id);
      if (result === "sent") {
        this.terminateQueuedRequest(frame.target_id);
        return this.currentQueueSnapshot();
      }
      const message = result === "failed"
        ? "Could not steer this queued message; it remains queued."
        : "This queued message is no longer available to steer.";
      return [this.error(frame.id, "invalid_message", message, frame.channel_id), ...this.currentQueueSnapshot()];
    } catch {
      return [this.error(frame.id, "internal_error", "Could not steer this queued message.", frame.channel_id), ...this.currentQueueSnapshot()];
    }
  }

  private handleCancel(frame: Extract<ClientFrame, { type: "cancel" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    try {
      if (!(this.onCancel?.() ?? false)) {
        return [this.error(frame.id, "internal_error", "no active request to cancel", frame.channel_id)];
      }
      return this.direct(frame.channel_id, {
        type: "cancelled",
        in_reply_to: frame.id,
      });
    } catch (cancelError) {
      const detail = cancelError instanceof Error ? cancelError.message : String(cancelError);
      return [this.error(frame.id, "internal_error", `cancel failed: ${detail}`, frame.channel_id)];
    }
  }

  private handleObserved(frame: Extract<ClientFrame, { type: "user_message_observed" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    const record = this.findRecord(frame.client_request_id);
    if (!record || record.senderRef !== this.senderRef) {
      return [this.error(frame.id, "invalid_message", "unknown observed request", frame.channel_id)];
    }
    this.state.forget(record.key);
    this.requestChannels.delete(frame.client_request_id);
    return [];
  }

  private handleUserMessage(frame: Extract<ClientFrame, { type: "user_message" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    const attachmentReplay = attachmentReplayFrames(frame, this.onAttachmentReplay, this.sessionId, this.leafId);
    if (attachmentReplay) return attachmentReplay;
    const result = this.state.begin({
      senderRef: this.senderRef,
      clientRequestId: frame.client_request_id,
      payload: userMessageIdempotencyPayload(frame),
    });
    if (result.kind === "conflict") {
      return [this.error(frame.id, "invalid_message", "client_request_id payload conflict", frame.channel_id)];
    }
    if (result.kind === "replay") return this.replay(frame, result.record);
    this.requestChannels.set(frame.client_request_id, frame.channel_id);
    const correlation: Correlation = frame.streaming_behavior === "steer"
      ? { origin: "unknown", delivery: "unknown", channelId: frame.channel_id, requestId: frame.id }
      : {
        origin: "pwa",
        delivery: "normal",
        senderRef: this.senderRef,
        channelId: frame.channel_id,
        requestId: frame.id,
        clientRequestId: frame.client_request_id,
      };
    try {
      const acceptedForDelivery = this.onUserMessage(frame, correlation);
      if (acceptedForDelivery === "rejected") {
        this.state.forget(result.record.key);
        this.requestChannels.delete(frame.client_request_id);
        return [this.error(frame.id, "too_large", "The message is too large or the queue is full; retry after queued work drains.", frame.channel_id), ...this.currentQueueSnapshot()];
      }
      if (acceptedForDelivery === "conflict") {
        this.state.forget(result.record.key);
        this.requestChannels.delete(frame.client_request_id);
        return [this.error(frame.id, "invalid_message", "client_request_id payload conflict", frame.channel_id), ...this.currentQueueSnapshot()];
      }
      if (!acceptedForDelivery) return this.unknownDelivery(frame.client_request_id);
      if (acceptedForDelivery === "queued" || acceptedForDelivery === "duplicate") {
        this.state.update(result.record.key, "queued");
        return [this.status(frame, "accepted"), ...this.currentQueueSnapshot()];
      }
      if (frame.streaming_behavior === "steer") return this.unknownDelivery(frame.client_request_id);
      return [this.status(frame, "received")];
    } catch {
      return this.unknownDelivery(frame.client_request_id);
    }
  }

  private replay(
    frame: Extract<ClientFrame, { type: "user_message" }>,
    record: ReturnType<V2SessionState["begin"]>["record"],
  ): ServerFrame[] {
    if (record.status === "unknown_delivery") return this.unknownDelivery(frame.client_request_id);
    if (record.status === "received") return [this.status(frame, "received")];
    if (record.status === "queued") return [this.status(frame, "accepted"), ...this.currentQueueSnapshot()];
    return [this.status(frame, record.status === "committed" ? "committed" : "accepted", record.messageId, record.groupId)];
  }

  private status(
    frame: Extract<ClientFrame, { type: "user_message" }>,
    status: "received" | "accepted" | "committed",
    messageId?: string,
    groupId?: string,
  ): ServerFrame {
    return this.direct(frame.channel_id, {
      type: "user_message_status",
      in_reply_to: frame.id,
      session_id: this.sessionId,
      leaf_id: this.leafId,
      client_request_id: frame.client_request_id,
      status,
      ...(messageId ? { message_id: messageId } : {}),
      ...(groupId ? { group_id: groupId } : {}),
    })[0]!;
  }

  private handleListModels(frame: Extract<ClientFrame, { type: "list_models" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    if (!this.onListModels) return [this.error(frame.id, "unsupported_type", "model listing is unavailable", frame.channel_id)];
    try {
      return this.direct(frame.channel_id, { type: "models_list", ...this.onListModels(), in_reply_to: frame.id });
    } catch {
      return [this.error(frame.id, "internal_error", "Could not list available models.", frame.channel_id)];
    }
  }

  private handleAction(frame: V2ActionFrame): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    if (!this.onAction) {
      return [this.error(frame.id, "unsupported_type", "session action is unavailable", frame.channel_id)];
    }
    try {
      this.onAction(frame);
      return [];
    } catch {
      return [this.error(frame.id, "internal_error", "Could not execute session action.", frame.channel_id)];
    }
  }

  private requireReady(frame: ClientFrame): ServerFrame[] {
    const error = this.ensureReady(frame);
    return [error ?? this.error("id" in frame ? frame.id : "v2", "unsupported_type", "frame is not implemented", "channel_id" in frame ? frame.channel_id : undefined)];
  }

  validateRequest(frame: ClientFrame): ServerFrame | null { return this.ensureReady(frame); }

  private ensureReady(frame: ClientFrame): ServerFrame | null {
    if (!("channel_id" in frame) || !this.state.get(this.senderRef, frame.channel_id)) {
      return this.error("id" in frame ? frame.id : "v2", "invalid_channel", "session_hello required", "channel_id" in frame ? frame.channel_id : undefined);
    }
    const sessionMismatch = "session_id" in frame && frame.session_id !== this.sessionId;
    const leafMismatch = "leaf_id" in frame && frame.leaf_id !== this.leafId;
    if (sessionMismatch || leafMismatch) {
      return {
        protocol_version: 2,
        type: "reset",
        target_channel_id: frame.channel_id,
        session_id: this.sessionId,
        leaf_id: this.leafId,
        reason: sessionMismatch ? "session_replaced" : "branch_changed",
      };
    }
    this.state.touch(this.senderRef, frame.channel_id);
    return null;
  }

  private currentQueueSnapshot(): ServerFrame[] {
    return this.onQueueSnapshot?.() ?? this.queueSnapshot([]);
  }

  private queueFrame(
    snapshotId: string,
    chunkIndex: number,
    final: boolean,
    items: readonly QueuedMessageItem[],
  ): Extract<ServerFrame, { type: "queued_message_state" }> {
    return {
      protocol_version: 2,
      type: "queued_message_state",
      session_id: this.sessionId,
      leaf_id: this.leafId,
      snapshot_id: snapshotId,
      chunk_index: chunkIndex,
      final,
      items: [...items],
    };
  }

  private frameBytes(frame: ServerFrame): number {
    return Buffer.byteLength(JSON.stringify(frame), "utf8");
  }

  private terminateQueuedRequest(clientRequestId: string): void {
    const record = this.state.getRecord(this.recordKey(clientRequestId));
    if (record?.senderRef === this.senderRef) this.state.rememberUnknownDelivery(record.key);
  }

  private direct(channelId: string, frame: Record<string, unknown>): ServerFrame[] {
    return [{ ...frame, protocol_version: 2, target_channel_id: channelId } as ServerFrame];
  }

  private error(
    inReplyTo: string,
    code: "protocol_upgrade_required" | "invalid_channel" | "invalid_message" | "unsupported_type" | "too_large" | "internal_error",
    message: string,
    channelId?: string,
  ): ServerFrame {
    return {
      protocol_version: 2,
      type: "protocol_error",
      ...(channelId ? { target_channel_id: channelId } : {}),
      in_reply_to: inReplyTo,
      code,
      message,
    };
  }

  private recordKey(clientRequestId: string): string {
    return `${this.sessionId}\u0000${this.leafId ?? ""}\u0000${this.senderRef}\u0000${clientRequestId}`;
  }

  private findRecord(clientRequestId: string): RecordWithChannel | undefined {
    const channelId = this.requestChannels.get(clientRequestId);
    if (!channelId) return undefined;
    const current = this.state.getRecord(this.recordKey(clientRequestId));
    if (current) return { ...current, channelId };
    const fallback = this.state.snapshot().records.find((record) => record.senderRef === this.senderRef && record.clientRequestId === clientRequestId);
    return fallback ? { ...fallback, channelId } : undefined;
  }
}
