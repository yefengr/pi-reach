import type { WireImage } from "../pi-reach/protocol-v2/schema";

export const DEFAULT_TIMELINE_PENDING_LIMITS = {
  maxEntries: 128,
  maxPayloadBytes: 16 * 1024 * 1024,
} as const;

export const PENDING_CAPACITY_ERROR_MESSAGE = "Too many unconfirmed messages or attachments. Wait for delivery confirmation before sending more.";

export type TimelinePendingLimits = {
  maxEntries: number;
  maxPayloadBytes: number;
};

export type PendingPayload = {
  text: string;
  images?: readonly WireImage[];
};

export class PendingCapacityError extends Error {
  constructor() {
    super(PENDING_CAPACITY_ERROR_MESSAGE);
    this.name = "PendingCapacityError";
  }
}

export function normalizeTimelinePendingLimits(limits: Partial<TimelinePendingLimits> = {}): TimelinePendingLimits {
  const normalized = {
    maxEntries: limits.maxEntries ?? DEFAULT_TIMELINE_PENDING_LIMITS.maxEntries,
    maxPayloadBytes: limits.maxPayloadBytes ?? DEFAULT_TIMELINE_PENDING_LIMITS.maxPayloadBytes,
  };
  if (!Number.isSafeInteger(normalized.maxEntries) || normalized.maxEntries <= 0) {
    throw new RangeError("maxEntries must be a positive safe integer");
  }
  if (!Number.isSafeInteger(normalized.maxPayloadBytes) || normalized.maxPayloadBytes <= 0) {
    throw new RangeError("maxPayloadBytes must be a positive safe integer");
  }
  return normalized;
}

export function pendingPayloadBytes(payload: PendingPayload): number {
  const serialized = JSON.stringify({ text: payload.text, images: payload.images });
  return new TextEncoder().encode(serialized).byteLength;
}

export function pendingCapacityUsage(entries: readonly PendingPayload[]): { count: number; payloadBytes: number } {
  return entries.reduce((usage, entry) => ({
    count: usage.count + 1,
    payloadBytes: usage.payloadBytes + pendingPayloadBytes(entry),
  }), { count: 0, payloadBytes: 0 });
}

export function exceedsPendingCapacity(entries: readonly PendingPayload[], limits: TimelinePendingLimits): boolean {
  const usage = pendingCapacityUsage(entries);
  return usage.count > limits.maxEntries || usage.payloadBytes > limits.maxPayloadBytes;
}
