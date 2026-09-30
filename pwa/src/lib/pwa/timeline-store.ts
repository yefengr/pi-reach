import Dexie from "dexie";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { getPwaDatabase, timelineEventPreview, type PwaTimelineEventRecord, type PwaTimelineSessionRecord } from "./db";

/** Runtime identity deliberately does not participate in persistent history keys. */
export type TimelineScope = {
  deviceId: string;
  endpointId: string;
  sessionId: string;
  leafId: string | null;
};

export type TimelineSessionSummary = TimelineScope & {
  id: string;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  preview: string;
  name?: string;
};

type ScopedTimelineEvent = { event: TimelineEvent; timestamp: number };

export class TimelineStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineStoreConflictError";
  }
}

export function makeTimelineScopeId(scope: TimelineScope): string {
  return [scope.deviceId, scope.endpointId, scope.sessionId]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

export function makePwaTimelineEventId(scope: TimelineScope, eventId: string): string {
  return `${makeTimelineScopeId(scope)}:${encodeURIComponent(eventId)}`;
}

export function isPersistableTimelineEvent(event: TimelineEvent): boolean {
  return "event_id" in event;
}

function assertEventInScope(scope: TimelineScope, event: TimelineEvent): void {
  if (event.session_id !== scope.sessionId) {
    throw new Error("Timeline event does not belong to the active session.");
  }
}

function scopedEvents(scope: TimelineScope, events: readonly TimelineEvent[]): ScopedTimelineEvent[] {
  return events.map((event) => {
    assertEventInScope(scope, event);
    return { event, timestamp: event.timestamp };
  });
}

function compareEvents(a: ScopedTimelineEvent, b: ScopedTimelineEvent): number {
  const leftSequence = a.event.event_seq;
  const rightSequence = b.event.event_seq;
  if (leftSequence !== undefined && rightSequence === undefined) return -1;
  if (leftSequence === undefined && rightSequence !== undefined) return 1;
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return a.timestamp - b.timestamp || a.event.event_id.localeCompare(b.event.event_id);
}

export function selectPersistableTimelineEvents(scope: TimelineScope, events: readonly TimelineEvent[]): TimelineEvent[] {
  return scopedEvents(scope, events).sort(compareEvents).map((item) => item.event);
}

function toRecord(scope: TimelineScope, event: TimelineEvent): PwaTimelineEventRecord {
  const preview = timelineEventPreview(event);
  return {
    id: makePwaTimelineEventId(scope, event.event_id),
    deviceId: scope.deviceId,
    endpointId: scope.endpointId,
    sessionId: scope.sessionId,
    leafId: event.leaf_id,
    eventId: event.event_id,
    eventSeq: event.event_seq,
    ...(preview ? { hasPreview: 1 } : {}),
    groupId: event.group_id,
    timestamp: event.timestamp,
    event,
  };
}

function recordSequence(record: PwaTimelineEventRecord): number | undefined {
  return record.eventSeq ?? record.event.event_seq;
}

function shouldReplaceRecord(previous: PwaTimelineEventRecord | undefined, incoming: PwaTimelineEventRecord): boolean {
  if (!previous) return true;
  const previousSequence = recordSequence(previous);
  const incomingSequence = recordSequence(incoming);
  return (incomingSequence === undefined && previousSequence === undefined)
    || (incomingSequence !== undefined && (previousSequence === undefined || incomingSequence >= previousSequence));
}

function finalRecordsById(
  existing: readonly PwaTimelineEventRecord[],
  incoming: readonly PwaTimelineEventRecord[],
): Map<string, PwaTimelineEventRecord> {
  const byEventId = new Map(existing.map((record) => [record.eventId, record]));
  for (const record of incoming) {
    if (shouldReplaceRecord(byEventId.get(record.eventId), record)) byEventId.set(record.eventId, record);
  }
  return byEventId;
}

export function findTimelineConflict(existing: PwaTimelineEventRecord[], incoming: PwaTimelineEventRecord[]): PwaTimelineEventRecord | undefined {
  const bySequence = new Map<number, PwaTimelineEventRecord>();
  for (const record of finalRecordsById(existing, incoming).values()) {
    const sequence = recordSequence(record);
    if (sequence === undefined) continue;
    const previous = bySequence.get(sequence);
    if (previous && previous.eventId !== record.eventId) return record;
    bySequence.set(sequence, record);
  }
  return undefined;
}

export function mergeTimelineRecords(existing: PwaTimelineEventRecord[], incoming: PwaTimelineEventRecord[]): PwaTimelineEventRecord[] {
  if (findTimelineConflict(existing, incoming)) return [];
  const existingById = new Map(existing.map((record) => [record.eventId, record]));
  const finalById = finalRecordsById(existing, incoming);
  return [...new Set(incoming.map((record) => record.eventId))]
    .flatMap((eventId) => {
      const record = finalById.get(eventId);
      return record && record !== existingById.get(eventId) ? [record] : [];
    });
}

function scopeWhere(scope: TimelineScope): readonly [string, string, string] {
  return [scope.deviceId, scope.endpointId, scope.sessionId];
}

async function recordsForScope(scope: TimelineScope): Promise<PwaTimelineEventRecord[]> {
  return getPwaDatabase().events.where("[deviceId+endpointId+sessionId]").equals(scopeWhere(scope)).toArray();
}

async function mergeCandidates(
  scope: TimelineScope,
  incoming: readonly PwaTimelineEventRecord[],
): Promise<PwaTimelineEventRecord[]> {
  const db = getPwaDatabase();
  const byId = await db.events.bulkGet([...new Set(incoming.map((record) => record.id))]);
  const sequenceKeys = [...new Set(incoming.flatMap((record) => record.eventSeq === undefined ? [] : [record.eventSeq]))]
    .map((eventSeq) => [...scopeWhere(scope), eventSeq]);
  const bySequence = sequenceKeys.length === 0
    ? []
    : await db.events.where("[deviceId+endpointId+sessionId+eventSeq]").anyOf(sequenceKeys).toArray();
  return [...new Map([...byId.filter((record): record is PwaTimelineEventRecord => record !== undefined), ...bySequence]
    .map((record) => [record.eventId, record])).values()];
}

async function clearScopeInTransaction(scope: TimelineScope): Promise<void> {
  const db = getPwaDatabase();
  await Promise.all([
    db.events.where("[deviceId+endpointId+sessionId]").equals(scopeWhere(scope)).delete(),
    db.sessions.delete(makeTimelineScopeId(scope)),
  ]);
}

export async function loadTimeline(scope: TimelineScope): Promise<TimelineEvent[]> {
  const records = await recordsForScope(scope);
  return selectPersistableTimelineEvents(scope, records.map((record) => record.event));
}

export async function listTimelineSessions(deviceId?: string): Promise<TimelineSessionSummary[]> {
  const db = getPwaDatabase();
  const records = deviceId
    ? await db.sessions.where("deviceId").equals(deviceId).toArray()
    : await db.sessions.toArray();
  return records
    .filter((record) => record.eventCount > 0)
    .map((record) => ({
      id: record.id,
      deviceId: record.deviceId,
      endpointId: record.endpointId,
      sessionId: record.sessionId,
      leafId: record.leafId,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      eventCount: record.eventCount,
      preview: record.preview,
      ...(record.name === undefined ? {} : { name: record.name }),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
}

function summarizeSession(
  scope: TimelineScope,
  records: readonly PwaTimelineEventRecord[],
  existing: PwaTimelineSessionRecord | undefined,
  preserveEmptySummary = false,
): PwaTimelineSessionRecord {
  const sorted = [...records].sort((left, right) => left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId));
  const previewRecord = [...sorted].reverse().find((record) => record.hasPreview === 1);
  const first = sorted[0];
  const last = sorted.at(-1);
  return {
    id: makeTimelineScopeId(scope),
    deviceId: scope.deviceId,
    endpointId: scope.endpointId,
    sessionId: scope.sessionId,
    leafId: scope.leafId,
    ...(existing?.name === undefined ? {} : { name: existing.name }),
    startedAt: first?.timestamp ?? existing?.startedAt ?? Date.now(),
    updatedAt: last?.timestamp ?? existing?.updatedAt ?? Date.now(),
    eventCount: records.length > 0 || !preserveEmptySummary ? records.length : existing?.eventCount ?? 0,
    preview: previewRecord ? timelineEventPreview(previewRecord.event) : existing?.preview ?? "Saved conversation",
    ...(previewRecord
      ? { previewEventId: previewRecord.eventId }
      : preserveEmptySummary && existing?.previewEventId ? { previewEventId: existing.previewEventId } : {}),
    ...(first
      ? { firstEventId: first.eventId }
      : preserveEmptySummary && existing?.firstEventId ? { firstEventId: existing.firstEventId } : {}),
    ...(last
      ? { lastEventId: last.eventId }
      : preserveEmptySummary && existing?.lastEventId ? { lastEventId: existing.lastEventId } : {}),
  };
}

function scopeTimeRange(scope: TimelineScope): { lower: unknown[]; upper: unknown[] } {
  return {
    lower: [...scopeWhere(scope), Dexie.minKey, Dexie.minKey],
    upper: [...scopeWhere(scope), Dexie.maxKey, Dexie.maxKey],
  };
}

async function summarizeStoredSession(
  scope: TimelineScope,
  eventCount: number,
  existing: PwaTimelineSessionRecord | undefined,
): Promise<PwaTimelineSessionRecord> {
  const db = getPwaDatabase();
  const range = scopeTimeRange(scope);
  const ordered = db.events.where("[deviceId+endpointId+sessionId+timestamp+eventId]")
    .between(range.lower, range.upper, true, true);
  const previewRange = {
    lower: [...scopeWhere(scope), 1, Dexie.minKey, Dexie.minKey],
    upper: [...scopeWhere(scope), 1, Dexie.maxKey, Dexie.maxKey],
  };
  const [first, last, previewRecord] = await Promise.all([
    ordered.first(),
    ordered.clone().reverse().first(),
    db.events.where("[deviceId+endpointId+sessionId+hasPreview+timestamp+eventId]")
      .between(previewRange.lower, previewRange.upper, true, true)
      .reverse()
      .first(),
  ]);
  if (!first || !last) return summarizeSession(scope, [], existing);
  return {
    id: makeTimelineScopeId(scope),
    deviceId: scope.deviceId,
    endpointId: scope.endpointId,
    sessionId: scope.sessionId,
    leafId: scope.leafId,
    ...(existing?.name === undefined ? {} : { name: existing.name }),
    startedAt: first.timestamp,
    updatedAt: last.timestamp,
    eventCount,
    preview: previewRecord ? timelineEventPreview(previewRecord.event) : "Saved conversation",
    ...(previewRecord ? { previewEventId: previewRecord.eventId } : {}),
    firstEventId: first.eventId,
    lastEventId: last.eventId,
  };
}

export async function saveTimelineSessionName(scope: TimelineScope, name: string): Promise<void> {
  const normalizedName = name.trim();
  if (!normalizedName) return;
  const db = getPwaDatabase();
  const id = makeTimelineScopeId(scope);
  await db.transaction("rw", db.sessions, async () => {
    const existing = await db.sessions.get(id);
    await db.sessions.put({
      ...summarizeSession(scope, [], existing, true),
      name: normalizedName,
    });
  });
}

export async function mergeTimelineEvents(scope: TimelineScope, events: readonly TimelineEvent[]): Promise<void> {
  const db = getPwaDatabase();
  const incoming = scopedEvents(scope, events).map((item) => toRecord(scope, item.event));
  if (incoming.length === 0) return;
  await db.transaction("rw", [db.events, db.sessions], async () => {
    const existing = await mergeCandidates(scope, incoming);
    const conflict = findTimelineConflict(existing, incoming);
    if (conflict) throw new TimelineStoreConflictError("Local timeline contains a conflicting event sequence.");
    const writes = mergeTimelineRecords(existing, incoming);
    if (writes.length === 0) return;
    const existingById = new Set(existing.map((record) => record.eventId));
    const addedCount = writes.filter((record) => !existingById.has(record.eventId)).length;
    await db.events.bulkPut(writes);
    const existingSession = await db.sessions.get(makeTimelineScopeId(scope));
    const eventCount = existingSession
      ? existingSession.eventCount + addedCount
      : await db.events.where("[deviceId+endpointId+sessionId]").equals(scopeWhere(scope)).count();
    await db.sessions.put(await summarizeStoredSession(scope, eventCount, existingSession));
  });
}

export async function replaceTimelineEvents(scope: TimelineScope, events: readonly TimelineEvent[]): Promise<void> {
  const db = getPwaDatabase();
  const incoming = scopedEvents(scope, events).map((item) => toRecord(scope, item.event));
  const conflict = findTimelineConflict([], incoming);
  if (conflict) throw new TimelineStoreConflictError("Replacement contains a conflicting event sequence.");
  const records = mergeTimelineRecords([], incoming);
  await db.transaction("rw", [db.events, db.sessions], async () => {
    const existingSession = await db.sessions.get(makeTimelineScopeId(scope));
    await db.events.where("[deviceId+endpointId+sessionId]").equals(scopeWhere(scope)).delete();
    if (records.length > 0) await db.events.bulkPut(records);
    await db.sessions.put(summarizeSession(scope, records, existingSession));
  });
}

export async function clearScope(scope: TimelineScope): Promise<void> {
  const db = getPwaDatabase();
  await db.transaction("rw", [db.events, db.sessions], () => clearScopeInTransaction(scope));
}
