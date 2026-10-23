import { createHash } from "node:crypto";

export type V2IdempotencyStatus = "received" | "queued" | "accepted" | "committed" | "unknown_delivery" | "rejected" | "cancelled";

export type V2ChannelState = {
  readonly senderRef: string;
  readonly channelId: string;
  readonly ready: true;
  readonly lastSeen: number;
};

export type V2IdempotencyRequest = {
  senderRef: string;
  clientRequestId: string;
  attemptId: string;
  payload: unknown;
};

export type V2IdempotencyRecord = {
  readonly key: string;
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly senderRef: string;
  readonly clientRequestId: string;
  // null 仅用于旧指纹已回收后的取消墓碑，不能用于重新准入。
  readonly fingerprint: string | null;
  status: V2IdempotencyStatus;
  attemptId?: string;
  rejectCode?: string;
  retryable?: boolean;
  retried?: boolean;
  messageId?: string;
  groupId?: string;
  touchedAt: number;
};

type Clock = () => number;

export type V2SessionStateOptions = {
  sessionId: string;
  leafId: string | null;
  maxEntries?: number;
  ttlMs?: number;
  clock?: Clock;
};

type BeginResult =
  | { kind: "new" | "retry"; record: V2IdempotencyRecord }
  | { kind: "replay"; record: V2IdempotencyRecord }
  | { kind: "conflict"; record: V2IdempotencyRecord };

export class V2SessionState {
  private sessionIdValue: string;
  private leafIdValue: string | null;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly channels = new Map<string, V2ChannelState>();
  private readonly records = new Map<string, V2IdempotencyRecord>();

  constructor(options: V2SessionStateOptions) {
    this.assertId(options.sessionId, "sessionId");
    this.sessionIdValue = options.sessionId;
    this.leafIdValue = options.leafId;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 512));
    this.ttlMs = Math.max(1, options.ttlMs ?? 10 * 60 * 1000);
    this.clock = options.clock ?? Date.now;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get leafId(): string | null {
    return this.leafIdValue;
  }

  setScope(sessionId: string, leafId: string | null): void {
    this.assertId(sessionId, "sessionId");
    if (sessionId === this.sessionIdValue && leafId === this.leafIdValue) return;
    this.sessionIdValue = sessionId;
    this.leafIdValue = leafId;
    this.records.clear();
  }

  hello(senderRef: string, channelId: string): V2ChannelState {
    this.assertId(senderRef, "senderRef");
    this.assertId(channelId, "channelId");
    const state: V2ChannelState = { senderRef, channelId, ready: true, lastSeen: this.clock() };
    this.channels.set(this.channelKey(senderRef, channelId), state);
    return state;
  }

  touch(senderRef: string, channelId: string): V2ChannelState | undefined {
    const current = this.get(senderRef, channelId);
    if (!current) return undefined;
    const state: V2ChannelState = { ...current, lastSeen: this.clock() };
    this.channels.set(this.channelKey(senderRef, channelId), state);
    return state;
  }

  get(senderRef: string, channelId: string): V2ChannelState | undefined {
    return this.channels.get(this.channelKey(senderRef, channelId));
  }

  removeChannel(senderRef: string, channelId: string): void {
    this.channels.delete(this.channelKey(senderRef, channelId));
  }

  removeOwner(senderRef: string): void {
    for (const [key, channel] of this.channels) if (channel.senderRef === senderRef) this.channels.delete(key);
    for (const [key, record] of this.records) if (record.senderRef === senderRef) this.records.delete(key);
  }

  begin(request: V2IdempotencyRequest): BeginResult {
    this.prune();
    this.assertId(request.senderRef, "senderRef");
    this.assertId(request.clientRequestId, "clientRequestId");
    this.assertId(request.attemptId, "attemptId");
    const key = this.recordKey(request.senderRef, request.clientRequestId);
    const fingerprint = fingerprintPayload(request.payload);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint === null) return { kind: "replay", record: { ...existing } };
      if (existing.status !== "cancelled") {
        existing.touchedAt = this.clock();
        this.records.delete(key);
        this.records.set(key, existing);
      }
      if (existing.fingerprint !== fingerprint) return { kind: "conflict", record: { ...existing } };
      if (existing.status === "rejected" && existing.retryable === true && request.attemptId !== existing.attemptId && existing.retried !== true) {
        existing.status = "received";
        existing.attemptId = request.attemptId;
        existing.retried = true;
        delete existing.rejectCode;
        delete existing.retryable;
        return { kind: "retry", record: { ...existing } };
      }
      return { kind: "replay", record: { ...existing } };
    }
    const record: V2IdempotencyRecord = {
      key,
      sessionId: this.sessionIdValue,
      leafId: this.leafIdValue,
      senderRef: request.senderRef,
      clientRequestId: request.clientRequestId,
      fingerprint,
      attemptId: request.attemptId,
      status: "received",
      touchedAt: this.clock(),
    };
    this.records.set(key, record);
    this.pruneCapacity();
    return { kind: "new", record: { ...record } };
  }

  update(key: string, status: V2IdempotencyStatus, details: { messageId?: string; groupId?: string } = {}): V2IdempotencyRecord | undefined {
    this.prune();
    const record = this.records.get(key);
    if (!record) return undefined;
    record.status = status;
    if (details.messageId !== undefined) record.messageId = details.messageId;
    if (details.groupId !== undefined) record.groupId = details.groupId;
    record.touchedAt = this.clock();
    this.records.delete(key);
    this.records.set(key, record);
    return { ...record };
  }

  rememberUnknownDelivery(key: string): V2IdempotencyRecord | undefined {
    return this.update(key, "unknown_delivery");
  }

  getRecord(key: string): V2IdempotencyRecord | undefined {
    this.prune();
    const record = this.records.get(key);
    return record ? { ...record } : undefined;
  }

  findByClientRequest(senderRef: string, clientRequestId: string): V2IdempotencyRecord | undefined {
    const matches = (record: V2IdempotencyRecord) => record.sessionId === this.sessionIdValue
      && record.senderRef === senderRef && record.clientRequestId === clientRequestId
      && this.clock() - record.touchedAt < this.ttlMs;
    const current = this.records.get(this.recordKey(senderRef, clientRequestId));
    const record = current && matches(current) ? current : [...this.records.values()].find(matches);
    return record ? { ...record } : undefined;
  }

  reject(key: string, attemptId: string, code: string, retryable: boolean): V2IdempotencyRecord | undefined {
    const record = this.getRecord(key);
    if (!record || (record.status !== "received" && record.status !== "queued")) return record;
    const rejected = this.update(key, "rejected");
    if (!rejected) return undefined;
    const stored = this.records.get(key)!;
    stored.attemptId = attemptId;
    stored.rejectCode = code;
    // 首次重新准入已用尽时，重试按钮必须收敛为不可重试，不能无限点击。
    stored.retryable = retryable && stored.retried !== true;
    return { ...stored };
  }

  markCancelled(key: string): V2IdempotencyRecord | undefined {
    const record = this.getRecord(key);
    if (!record || (record.status !== "received" && record.status !== "queued")) return record;
    return this.update(key, "cancelled");
  }

  markCancelledByClientRequest(senderRef: string, clientRequestId: string): V2IdempotencyRecord | undefined {
    this.prune();
    this.assertId(senderRef, "senderRef");
    this.assertId(clientRequestId, "clientRequestId");
    const existing = this.findByClientRequest(senderRef, clientRequestId);
    if (existing) {
      const cancelled = this.markCancelled(existing.key);
      if (cancelled) return cancelled;
      // 查找与更新之间也可能跨过 TTL；成功取消仍需创建新鲜的有界证据。
    }
    const record: V2IdempotencyRecord = {
      key: this.recordKey(senderRef, clientRequestId),
      sessionId: this.sessionIdValue,
      leafId: this.leafIdValue,
      senderRef,
      clientRequestId,
      fingerprint: null,
      status: "cancelled",
      touchedAt: this.clock(),
    };
    this.records.set(record.key, record);
    this.pruneCapacity();
    return { ...record };
  }

  forget(key: string): boolean {
    return this.records.delete(key);
  }

  snapshot(): { channels: V2ChannelState[]; records: V2IdempotencyRecord[] } {
    this.prune();
    return { channels: [...this.channels.values()].map((channel) => ({ ...channel })), records: [...this.records.values()].map((record) => ({ ...record })) };
  }

  private prune(): void {
    const now = this.clock();
    for (const [key, record] of this.records) if (now - record.touchedAt >= this.ttlMs) this.records.delete(key);
    this.pruneCapacity();
  }

  private pruneCapacity(): void {
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  private recordKey(senderRef: string, clientRequestId: string): string {
    return `${this.sessionIdValue}\u0000${this.leafIdValue ?? ""}\u0000${senderRef}\u0000${clientRequestId}`;
  }

  private channelKey(senderRef: string, channelId: string): string {
    return `${senderRef}\u0000${channelId}`;
  }

  private assertId(value: string, name: string): void {
    if (!value || value.length > 256) throw new Error(`${name} is invalid`);
  }
}

function fingerprintPayload(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = canonicalize((value as Record<string, unknown>)[key]);
    return result;
  }
  return String(value);
}

export function fingerprintV2Payload(value: unknown): string {
  return fingerprintPayload(value);
}
