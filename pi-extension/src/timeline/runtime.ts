import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MessageUpdateEvent, SessionManager, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent } from "@earendil-works/pi-coding-agent";
import { MarkerSchemaV2, TimelineEventSchema, type JsonValue, type MarkerV2, type TimelineEvent, type TimelinePartial } from "../protocol/v2/index.js";
import { partialDeltaChunks } from "./partial_delta.js";
import { isRunEndMarker, runEndEvent, runEndMarker, runEndStatus } from "./run_end.js";
import { sequenceTimelineProjections, type TimelineProjection } from "./sequence.js";
import { jsonValue, recoverToolCalls, ToolLifecycleTracker, toolPartial, toolTimelineEvent, type ToolCallDetails } from "./tool_lifecycle.js";

export const TIMELINE_MARKER = "pi-reach:timeline-v2" as const;

type MessageRole = "user" | "assistant" | "toolResult";

type MessageRecord = {
  role: MessageRole;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  args?: unknown;
  api?: string;
  provider?: string;
  model?: string;
};

export type Correlation = {
  /** 内部投递令牌只在内存回调链中流转，不写入 marker 或协议帧。 */
  deliveryToken?: string;
  clientRequestId?: string;
  channelId?: string;
  requestId?: string;
  origin: "pwa" | "extension" | "unknown";
  delivery: "normal" | "queued" | "unknown";
  senderRef?: string;
};

type MessageMarker = MarkerV2 & { event_id: string; group_id: string };

function isMessageMarker(marker: MarkerV2): marker is MarkerV2 & { group_id: string } {
  return marker.kind === "user" || marker.kind === "assistant" || marker.kind === "tool" || marker.kind === "provider_error";
}

type PendingMessage = {
  message: object;
  role: MessageRole;
  marker: MessageMarker;
  correlation: Correlation;
  identity: string | null;
};

type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];
type MessageEntry = Extract<SessionEntry, { type: "message" }>;

export type TimelineStarted = {
  eventId: string;
  groupId: string;
  role: MessageRole;
  correlation: Correlation;
  blocks: JsonValue[];
};

export type TimelineRuntimeOptions = {
  onStarted?: (started: TimelineStarted) => void;
  onPublished?: (event: TimelineEvent, correlation: Correlation) => void;
  onPartial?: (partial: TimelinePartial, correlation: Correlation) => void;
};

export class TimelineRuntime {
  private readonly correlations = new AsyncLocalStorage<Correlation>();
  private readonly messageCorrelations = new WeakMap<object, Correlation>();
  private readonly pending = new WeakMap<object, PendingMessage>();
  private readonly pendingByRole: Record<MessageRole, PendingMessage[]> = {
    user: [],
    assistant: [],
    toolResult: [],
  };
  private readonly published: TimelineEvent[] = [];
  private readonly toolAssociations = new ToolLifecycleTracker<Correlation>();
  private sessionManager: SessionManager | null = null;
  private epoch = 0;
  private stateRevision = 0;
  private activeGroupId: string | null = null;
  private active = false;
  private readonly onStarted?: (started: TimelineStarted) => void;
  private readonly onPublished?: (event: TimelineEvent, correlation: Correlation) => void;
  private readonly onPartial?: (partial: TimelinePartial, correlation: Correlation) => void;

  constructor(options: TimelineRuntimeOptions = {}) {
    this.onStarted = options.onStarted;
    this.onPublished = options.onPublished;
    this.onPartial = options.onPartial;
  }

  attach(sessionManager: SessionManager): void {
    if (this.sessionManager === sessionManager) return;
    this.sessionManager = sessionManager;
    this.resetState();
  }

  resetSession(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
    this.resetState();
  }

  private resetState(): void {
    this.stateRevision += 1;
    this.epoch = 0;
    this.activeGroupId = null;
    this.active = false;
    this.published.length = 0;
    this.pendingByRole.user = [];
    this.pendingByRole.assistant = [];
    this.pendingByRole.toolResult = [];
    this.toolAssociations.clear();
  }

  get sessionId(): string | null {
    return this.sessionManager?.getSessionId() ?? null;
  }

  get leafId(): string | null {
    const leafId = this.sessionManager?.getLeafId();
    return leafId ?? null;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get currentGroupId(): string | null {
    return this.activeGroupId;
  }

  getPublishedEvents(): readonly TimelineEvent[] {
    return [...this.published];
  }

  getCorrelation(message: object): Correlation | undefined {
    return this.messageCorrelations.get(message);
  }

  publishSessionEntry(entry: SessionEntry, sessionManager: SessionManager): TimelineEvent | null {
    this.attach(sessionManager);
    const event = this.recover(sessionManager).find((candidate) => candidate.event_id === entry.id) ?? null;
    if (!event) return null;
    this.publish(event, { origin: "unknown", delivery: "unknown" });
    return event;
  }

  runWithCorrelation<T>(correlation: Correlation, callback: () => T): T {
    return this.correlations.run(correlation, callback);
  }

  currentCorrelation(): Correlation | undefined {
    return this.correlations.getStore();
  }

  onAgentStart(): void {
    this.epoch += 1;
    this.active = true;
    this.activeGroupId = null;
  }

  /** 为本次运行的组写入 run_end marker，并在同组正式消息发布之后推送。 */
  onAgentEnd(messages?: readonly unknown[]): void {
    const sessionManager = this.sessionManager;
    if (this.activeGroupId && sessionManager) {
      const markerId = sessionManager.appendCustomEntry(TIMELINE_MARKER, runEndMarker(this.activeGroupId, runEndStatus(messages)));
      this.publishWhenVisible(sessionManager, markerId, { origin: "unknown", delivery: "unknown" });
    }
    this.active = false;
    this.activeGroupId = null;
    this.pendingByRole.user = [];
    this.pendingByRole.assistant = [];
    this.pendingByRole.toolResult = [];
    this.toolAssociations.clear();
  }

  onMessageStart(message: unknown, sessionManager: SessionManager): TimelineStarted | null {
    this.attach(sessionManager);
    const record = this.asMessageRecord(message);
    if (!record) return null;
    if (!this.active) {
      this.onAgentStart();
    }
    const correlation = this.correlationFor(message);
    const groupId = this.activeGroupId ?? randomUUID();
    this.activeGroupId = groupId;
    const markerData = this.buildMarker(record.role, groupId, correlation);
    const markerId = sessionManager.appendCustomEntry(TIMELINE_MARKER, markerData);
    if (!isMessageMarker(markerData)) return null;
    const marker: MessageMarker = { ...markerData, event_id: markerId };
    const objectMessage = message as object;
    this.messageCorrelations.set(objectMessage, correlation);
    const pending = { message: objectMessage, role: record.role, marker, correlation, identity: this.messageIdentity(record) };
    this.pending.set(objectMessage, pending);
    this.pendingByRole[record.role].push(pending);
    const started: TimelineStarted = {
      eventId: markerId,
      groupId,
      role: record.role,
      correlation: { ...correlation },
      blocks: record.role === "user" ? this.userBlocks(record.content) : [],
    };
    this.onStarted?.(started);
    return started;
  }

  onMessageUpdate(event: MessageUpdateEvent, sessionManager: SessionManager): void {
    if (this.sessionManager !== sessionManager || this.messageRole(event.message) !== "assistant") return;
    const pending = this.findPending(event.message, "assistant");
    if (!pending) return;
    const update = event.assistantMessageEvent;
    // 正式 blocks 会移除 toolCall；流式 ID 使用同一投影索引，避免完成时重建正文节点。
    const contentIndex = "contentIndex" in update ? this.assistantBlocks(update.partial.content.slice(0, update.contentIndex)).length : 0;
    if (update.type === "text_start") {
      this.publishPartial(pending, "assistant", contentIndex, "running");
    } else if (update.type === "thinking_start") {
      this.publishPartial(pending, "thinking", contentIndex, "running");
    } else if (update.type === "text_delta" && update.delta) {
      this.publishPartial(pending, "assistant", contentIndex, "delta", update.delta);
    } else if (update.type === "thinking_delta" && update.delta) {
      this.publishPartial(pending, "thinking", contentIndex, "delta", update.delta);
    } else if (update.type === "toolcall_end") {
      this.toolAssociations.indexAssistantContent([update.toolCall], {
        groupId: pending.marker.group_id,
        correlation: { ...pending.correlation },
      });
    }
  }

  onMessageEnd(message: unknown, sessionManager: SessionManager): void {
    this.attach(sessionManager);
    if (typeof message !== "object" || message === null) return;
    const objectMessage = message as object;
    const role = this.messageRole(message);
    const pending = role ? this.findPending(message, role) : undefined;
    if (!pending) return;
    if (pending.role === "assistant") {
      this.toolAssociations.indexAssistantContent(this.asMessageRecord(message)?.content, {
        groupId: pending.marker.group_id,
        correlation: { ...pending.correlation },
      });
    }
    this.pending.delete(pending.message);
    this.pending.delete(objectMessage);
    this.pendingByRole[pending.role] = this.pendingByRole[pending.role].filter((candidate) => candidate !== pending);
    this.publishWhenVisible(sessionManager, pending.marker.event_id, pending.correlation);
  }

  private publishWhenVisible(sessionManager: SessionManager, markerId: string, correlation: Correlation): void {
    const revision = this.stateRevision;
    setImmediate(() => {
      if (this.stateRevision !== revision || this.sessionManager !== sessionManager) return;
      const markerVisible = sessionManager.getBranch().some((entry) => entry.type === "custom"
        && entry.customType === TIMELINE_MARKER && entry.id === markerId);
      if (!markerVisible) return;
      const event = this.recover(sessionManager).find((candidate) => candidate.event_id === markerId);
      if (!event) return;
      this.publish(event, correlation);
      if (event.kind === "tool") this.toolAssociations.complete(event.tool_call_id);
    });
  }

  onToolExecutionStart(event: ToolExecutionStartEvent, sessionManager: SessionManager): void {
    if (this.sessionManager !== sessionManager || !this.active) return;
    const fallback = this.activeGroupId ? {
      groupId: this.activeGroupId,
      correlation: this.currentCorrelation() ?? { origin: "unknown" as const, delivery: "unknown" as const },
    } : undefined;
    this.toolAssociations.start(event.toolCallId, event.toolName, event.args, fallback);
    this.publishToolPartial(event.toolCallId);
  }

  onToolExecutionUpdate(event: ToolExecutionUpdateEvent, sessionManager: SessionManager): void {
    if (this.sessionManager !== sessionManager || !this.active) return;
    this.publishToolPartial(event.toolCallId, event.partialResult);
  }

  onToolExecutionEnd(event: ToolExecutionEndEvent, sessionManager: SessionManager): void {
    if (this.sessionManager !== sessionManager || !this.active) return;
    this.publishToolPartial(event.toolCallId, event.result);
  }

  private publishToolPartial(toolCallId: string, result?: unknown): void {
    const association = this.toolAssociations.get(toolCallId);
    const sessionId = this.sessionId;
    const leafId = this.leafId;
    if (!association || !sessionId) return;
    const partial = toolPartial(toolCallId, association, { sessionId, leafId }, result);
    if (partial) this.onPartial?.(partial, { ...association.correlation });
  }

  recover(sessionManager: SessionManager): TimelineEvent[] {
    this.attach(sessionManager);
    const branch = sessionManager.getBranch();
    const legacyGroup = `legacy:${sessionManager.getSessionId()}`;
    const recoveryTools = recoverToolCalls(branch);
    const positions = new Map(branch.map((entry, index) => [entry.id, index]));
    const matched = new Set<string>();
    const recovered: TimelineProjection[] = [];
    for (let index = 0; index < branch.length; index += 1) {
      const entry = branch[index]!;
      if (entry.type !== "custom" || entry.customType !== TIMELINE_MARKER) continue;
      const markerData = this.parseMarker(entry.data);
      if (markerData && isRunEndMarker(markerData)) {
        const base = { event_id: entry.id, session_id: sessionManager.getSessionId(), leaf_id: sessionManager.getLeafId() ?? null, timestamp: this.timestamp(entry.timestamp) };
        recovered.push({ event: runEndEvent(markerData, base), branchPosition: index });
        continue;
      }
      if (!markerData || !isMessageMarker(markerData)) continue;
      const marker: MessageMarker = { ...markerData, event_id: entry.id };
      const target = this.scanTargetAfterMarker(branch, index, this.roleForMarker(marker));
      if (!target) continue;
      matched.add(target.id);
      const event = this.toTimelineEvent(target, marker, this.correlationFromMarker(marker), sessionManager, recoveryTools.get(target.id));
      if (event) recovered.push({ event, branchPosition: positions.get(target.id)! });
    }
    for (const [branchPosition, entry] of branch.entries()) {
      let event: TimelineEvent | null = null;
      if (entry.type === "message" && !matched.has(entry.id)) {
        const role = this.messageRole(entry.message);
        if (role) {
          const marker: MessageMarker = role === "user"
            ? { version: 2, event_id: entry.id, group_id: legacyGroup, kind: "user", origin: "unknown", delivery: "unknown" }
            : { version: 2, event_id: entry.id, group_id: legacyGroup, kind: role === "assistant" ? "assistant" : "tool" };
          event = this.toTimelineEvent(entry, marker, this.correlationFromMarker(marker), sessionManager, recoveryTools.get(entry.id));
        }
      } else if (entry.type !== "message") {
        event = this.toSystemEvent(entry, sessionManager);
      }
      if (event) recovered.push({ event, branchPosition });
    }
    return sequenceTimelineProjections(recovered);
  }

  private findPending(message: unknown, role: MessageRole): PendingMessage | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const direct = this.pending.get(message);
    if (direct?.role === role && this.pendingByRole[role].includes(direct)) return direct;
    const record = this.asMessageRecord(message);
    const identity = record ? this.messageIdentity(record) : null;
    if (!identity) return undefined;
    return this.pendingByRole[role].find((candidate) => candidate.identity === identity);
  }

  private messageIdentity(message: MessageRecord): string | null {
    if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return null;
    return [message.role, message.timestamp, message.api ?? "", message.provider ?? "", message.model ?? ""].join(":");
  }

  private publish(event: TimelineEvent, correlation: Correlation): void {
    if (this.published.some((existing) => existing.event_id === event.event_id)) return;
    this.published.push(event);
    this.onPublished?.(event, { ...correlation });
  }

  private publishPartial(
    pending: PendingMessage,
    kind: "assistant" | "thinking",
    contentIndex: number,
    status: "running" | "delta",
    delta?: string,
  ): void {
    const sessionId = this.sessionId;
    const leafId = this.leafId;
    const groupId = pending.marker.group_id;
    if (!sessionId || !groupId) return;
    const publish = (chunk?: string): void => {
      const partial: TimelinePartial = {
        protocol_version: 2,
        type: "timeline_partial",
        session_id: sessionId,
        leaf_id: leafId,
        group_id: groupId,
        partial_id: `${pending.marker.event_id}:${kind}:${contentIndex}`,
        kind,
        status,
        ...(chunk === undefined ? {} : { delta: chunk }),
      };
      this.onPartial?.(partial, { ...pending.correlation });
    };
    if (delta === undefined) {
      publish();
      return;
    }
    for (const chunk of partialDeltaChunks(delta)) publish(chunk);
  }

  private correlationFor(message: unknown): Correlation {
    const existing = this.currentCorrelation();
    if (existing) return { ...existing };
    const objectMessage = typeof message === "object" && message !== null ? message : null;
    const known = objectMessage ? this.messageCorrelations.get(objectMessage) : undefined;
    return known ? { ...known } : { origin: "unknown", delivery: "unknown" };
  }

  private buildMarker(role: MessageRole, groupId: string, correlation: Correlation): MarkerV2 {
    if (role === "user") {
      const marker: Record<string, unknown> = {
        version: 2, group_id: groupId, kind: "user",
        origin: correlation.origin, delivery: correlation.delivery,
      };
      if (correlation.senderRef !== undefined) marker.sender_ref = correlation.senderRef;
      return MarkerSchemaV2.parse(marker) as MessageMarker;
    }
    return MarkerSchemaV2.parse({ version: 2, group_id: groupId, kind: role === "assistant" ? "assistant" : "tool" }) as MarkerV2;
  }

  private parseMarker(data: unknown): MarkerV2 | null {
    const parsed = MarkerSchemaV2.safeParse(data);
    return parsed.success ? parsed.data : null;
  }

  private correlationFromMarker(marker: MarkerV2): Correlation {
    if (marker.kind !== "user") return { origin: "unknown", delivery: "unknown" };
    return {
      origin: marker.origin,
      delivery: marker.delivery,
      ...(marker.sender_ref ? { senderRef: marker.sender_ref } : {}),
    };
  }

  private roleForMarker(marker: MarkerV2): MessageRole {
    if (marker.kind === "user") return "user";
    return marker.kind === "assistant" ? "assistant" : "toolResult";
  }

  private scanTargetAfterMarker(branch: readonly SessionEntry[], markerIndex: number, role: MessageRole): MessageEntry | undefined {
    for (let index = markerIndex + 1; index < branch.length; index += 1) {
      const entry = branch[index]!;
      if (entry.type === "custom" && entry.customType === TIMELINE_MARKER) return undefined;
      if (entry.type === "custom") continue;
      if (entry.type !== "message") return undefined;
      return this.messageRole(entry.message) === role ? entry : undefined;
    }
    return undefined;
  }

  private toTimelineEvent(
    entry: MessageEntry,
    marker: MessageMarker,
    correlation: Correlation,
    sessionManager: SessionManager,
    association?: ToolCallDetails,
  ): TimelineEvent | null {
    const message = this.asMessageRecord(entry.message);
    if (!message) return null;
    const sessionId = sessionManager.getSessionId();
    const timestamp = this.timestamp(entry.timestamp, message.timestamp);
    const leafId = sessionManager.getLeafId() ?? null;
    const base = { event_id: marker.event_id, session_id: sessionId, leaf_id: leafId, timestamp };
    const groupId = marker.group_id;
    if (!groupId) return null;
    if (message.role === "user") {
      const senderRef = marker.kind === "user" && marker.sender_ref ? { sender_ref: marker.sender_ref } : {};
      return TimelineEventSchema.parse({
        ...base, group_id: groupId, kind: "user", message_id: marker.event_id,
        blocks: this.userBlocks(message.content), origin: correlation.origin, delivery: correlation.delivery,
        status: "committed", ...senderRef,
      });
    }
    if (message.role === "assistant") {
      if (message.stopReason === "error") {
        return TimelineEventSchema.parse({
          ...base,
          group_id: groupId,
          kind: "provider_error",
          message: this.nonEmpty(message.errorMessage ?? this.textFromContent(message.content) ?? "Provider error"),
        });
      }
      return TimelineEventSchema.parse({
        ...base, group_id: groupId, kind: "assistant", blocks: this.assistantBlocks(message.content),
        status: message.stopReason === "aborted" ? "interrupted" : "complete",
      });
    }
    return toolTimelineEvent(base, groupId, message, association);
  }

  private toSystemEvent(entry: SessionEntry, sessionManager: SessionManager): TimelineEvent | null {
    const base = {
      event_id: entry.id,
      session_id: sessionManager.getSessionId(),
      leaf_id: sessionManager.getLeafId() ?? null,
      timestamp: this.timestamp(entry.timestamp),
      truncated: false,
    };
    let candidate: unknown;
    if (entry.type === "compaction") {
      candidate = {
        ...base,
        kind: "compaction",
        payload: {
          summary: entry.summary,
          first_kept_entry_id: entry.firstKeptEntryId,
          tokens_before: entry.tokensBefore,
          from_hook: entry.fromHook ?? false,
          ...(entry.details === undefined ? {} : { details: jsonValue(entry.details) }),
        },
      };
    } else if (entry.type === "branch_summary") {
      candidate = {
        ...base,
        kind: "branch_summary",
        payload: {
          summary: entry.summary,
          from_id: entry.fromId,
          from_hook: entry.fromHook ?? false,
          ...(entry.details === undefined ? {} : { details: jsonValue(entry.details) }),
        },
      };
    } else if (entry.type === "custom" && entry.customType !== TIMELINE_MARKER) {
      candidate = {
        ...base,
        kind: "custom",
        payload: {
          custom_type: entry.customType,
          ...(entry.data === undefined ? {} : { data: jsonValue(entry.data) }),
        },
      };
    } else {
      return null;
    }
    const parsed = TimelineEventSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  private asMessageRecord(value: unknown): MessageRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<MessageRecord>;
    const role = record.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
    return record as MessageRecord;
  }

  private messageRole(value: unknown): MessageRole | null {
    return this.asMessageRecord(value)?.role ?? null;
  }

  private timestamp(entryTimestamp: string, messageTimestamp?: number): number {
    const entryMs = Date.parse(entryTimestamp);
    if (Number.isFinite(entryMs) && entryMs >= 0) return entryMs;
    if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp) && messageTimestamp >= 0) return messageTimestamp;
    return Date.now();
  }

  private userBlocks(content: unknown): JsonValue[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return [{ type: "text", text: "" }];
    return content.flatMap((part): JsonValue[] => {
      if (!part || typeof part !== "object") return [];
      const item = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        return [{ type: "image", mime_type: item.mimeType, data: item.data, byte_length: this.base64Length(item.data) }];
      }
      return [];
    });
  }

  private assistantBlocks(content: unknown): JsonValue[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): JsonValue[] => {
      if (!part || typeof part !== "object") return [];
      const item = part as { type?: unknown; text?: unknown; thinking?: unknown };
      if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
      if (item.type === "thinking" && typeof item.thinking === "string") return [{ type: "thinking", text: item.thinking }];
      return [];
    });
  }

  private textFromContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join(" ");
  }

  private nonEmpty(value: string): string {
    return value.trim() || "tool failed";
  }

  private base64Length(value: string): number {
    try {
      return Buffer.from(value, "base64").byteLength;
    } catch {
      return 0;
    }
  }

}
