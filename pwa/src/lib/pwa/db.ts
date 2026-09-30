import Dexie, { type Table } from "dexie";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";

const DATABASE_NAME = "pi-reach";
const DATABASE_OPEN_TIMEOUT_MS = 10000;

export type PwaDatabaseErrorCode = "blocked" | "versionchange" | "open_failed";

export class PwaDatabaseError extends Error {
  constructor(public readonly code: PwaDatabaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PwaDatabaseError";
  }
}

/** A pairing is device-scoped. Endpoint selection is intentionally separate. */
export type PwaDeviceRecord = {
  id: string;
  deviceId: string;
  relayUrl: string;
  pairedAt: string;
  nickname?: string;
  hostname?: string;
  harness?: { name: string; version: string };
};

/** Cached metadata for one process-scoped endpoint; it is never online presence. */
export type PwaEndpointRecord = {
  id: string;
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  kind: "daemon" | "interactive";
  name?: string;
  cwd?: string;
  pid?: number;
  startedAt?: number;
  model?: string;
  thinking?: string;
  working?: boolean;
  /** Runtime presence is intentionally not persisted. */
  online?: boolean;
  updatedAt: number;
};

export type PwaTimelineEventRecord = {
  id: string;
  deviceId: string;
  endpointId: string;
  sessionId: string;
  leafId: string | null;
  eventId: string;
  eventSeq?: number;
  hasPreview?: number;
  groupId?: string;
  timestamp: number;
  event: TimelineEvent;
};

export type PwaTimelineSessionRecord = {
  id: string;
  deviceId: string;
  endpointId: string;
  sessionId: string;
  leafId: string | null;
  name?: string;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  preview: string;
  previewEventId?: string;
  firstEventId?: string;
  lastEventId?: string;
};

export type PwaIdentityRecord = {
  id: "owner";
  publicKey: string;
  secretKey: string;
  createdAt: number;
};

export function timelineEventPreview(event: TimelineEvent): string {
  let text = "";
  if (event.kind === "user" || event.kind === "assistant") {
    text = event.blocks.map((block) => "text" in block ? block.text : "").join(" ");
  } else if (event.kind === "provider_error") text = event.message;
  else if (event.kind === "tool") text = event.tool;
  else if (event.kind !== "run_end" && typeof event.payload === "string") text = event.payload;
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

type PwaSettingRecord = {
  key: string;
  value: string;
};

export class PwaDatabase extends Dexie {
  identities!: Table<PwaIdentityRecord, string>;
  devices!: Table<PwaDeviceRecord, string>;
  endpoints!: Table<PwaEndpointRecord, string>;
  events!: Table<PwaTimelineEventRecord, string>;
  sessions!: Table<PwaTimelineSessionRecord, string>;
  settings!: Table<PwaSettingRecord, string>;

  private openFailure: PwaDatabaseError | null = null;
  private readonly openFailureListeners = new Set<(error: PwaDatabaseError) => void>();

  constructor(databaseName = DATABASE_NAME) {
    super(databaseName);
    this.on("blocked", () => {
      this.reportOpenFailure(new PwaDatabaseError("blocked", "Another tab is holding an older local workspace open."));
    });
    this.on("versionchange", () => {
      this.reportOpenFailure(new PwaDatabaseError("versionchange", "The local workspace changed in another tab."));
      this.close();
    });

    // Plan 69 is deliberately destructive: products were never released, so
    // no room/peer IndexedDB data is migrated or exposed to this schema.
    this.version(7).stores({
      identities: "id, publicKey",
      devices: "id, deviceId, relayUrl, pairedAt",
      endpoints: "id, deviceId, [deviceId+endpointId], endpointId, updatedAt",
      events: "id, [deviceId+endpointId+sessionId+leafId], timestamp, eventId",
      settings: "key",
    });
    this.version(8).stores({
      identities: "id, publicKey",
      devices: "id, deviceId, relayUrl, pairedAt",
      endpoints: "id, deviceId, [deviceId+endpointId], endpointId, updatedAt",
      events: "id, deviceId, [deviceId+endpointId+sessionId+leafId], [deviceId+timestamp], timestamp, eventId",
      settings: "key",
    });
    this.version(9).stores({
      sessions: "id, deviceId, updatedAt",
    });
    this.version(10).stores({
      events: "id, deviceId, [deviceId+endpointId+sessionId], [deviceId+timestamp], timestamp, eventId",
    });
    this.version(11).stores({
      events: "id, deviceId, [deviceId+endpointId+sessionId], [deviceId+endpointId+sessionId+eventSeq], [deviceId+endpointId+sessionId+timestamp+eventId], [deviceId+endpointId+sessionId+hasPreview+timestamp+eventId], [deviceId+timestamp], timestamp, eventId",
      sessions: "id, deviceId, updatedAt",
    }).upgrade(async (transaction) => {
      const events = transaction.table<PwaTimelineEventRecord, string>("events");
      const sessions = transaction.table<PwaTimelineSessionRecord, string>("sessions");
      const records = await events.toArray();
      const migratedById = new Map<string, PwaTimelineEventRecord>();
      for (const record of records) {
        record.id = [record.deviceId, record.endpointId, record.sessionId, record.eventId]
          .map((value) => encodeURIComponent(value))
          .join(":");
        record.eventSeq = record.event.event_seq;
        record.hasPreview = timelineEventPreview(record.event) ? 1 : undefined;
        const previous = migratedById.get(record.id);
        const previousSequence = previous?.eventSeq;
        if (!previous || (record.eventSeq !== undefined && (previousSequence === undefined || record.eventSeq >= previousSequence))) {
          migratedById.set(record.id, record);
        }
      }
      const grouped = new Map<string, PwaTimelineEventRecord[]>();
      for (const record of migratedById.values()) {
        const groupKey = JSON.stringify([record.deviceId, record.endpointId, record.sessionId]);
        const group = grouped.get(groupKey) ?? [];
        group.push(record);
        grouped.set(groupKey, group);
      }
      for (const recordsForSession of grouped.values()) {
        const sequenceOwners = new Map<number, string>();
        const hasSequenceConflict = recordsForSession.some((record) => {
          if (record.eventSeq === undefined) return false;
          const owner = sequenceOwners.get(record.eventSeq);
          sequenceOwners.set(record.eventSeq, record.eventId);
          return owner !== undefined && owner !== record.eventId;
        });
        if (hasSequenceConflict) {
          throw new Error("Cannot migrate timeline events with conflicting sequence identities.");
        }
      }
      await events.clear();
      for (const recordsForSession of grouped.values()) {
        const first = recordsForSession[0];
        if (!first) continue;
        const id = [first.deviceId, first.endpointId, first.sessionId].map((value) => encodeURIComponent(value)).join(":");
        await events.bulkPut(recordsForSession);
        const existing = await sessions.get(id);
        const sorted = [...recordsForSession].sort((left, right) => left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId));
        const previewRecord = [...sorted].reverse().find((record) => record.hasPreview === 1);
        const firstRecord = sorted[0]!;
        const lastRecord = sorted.at(-1)!;
        await sessions.put({
          id,
          deviceId: first.deviceId,
          endpointId: first.endpointId,
          sessionId: first.sessionId,
          leafId: lastRecord.leafId,
          ...(existing?.name === undefined ? {} : { name: existing.name }),
          startedAt: firstRecord.timestamp,
          updatedAt: lastRecord.timestamp,
          eventCount: recordsForSession.length,
          preview: previewRecord ? timelineEventPreview(previewRecord.event) : "Saved conversation",
          ...(previewRecord ? { previewEventId: previewRecord.eventId } : {}),
          firstEventId: firstRecord.eventId,
          lastEventId: lastRecord.eventId,
        });
      }
    });
  }

  onOpenFailure(listener: (error: PwaDatabaseError) => void): () => void {
    this.openFailureListeners.add(listener);
    if (this.openFailure) listener(this.openFailure);
    return () => this.openFailureListeners.delete(listener);
  }

  getOpenFailure(): PwaDatabaseError | null {
    return this.openFailure;
  }

  private reportOpenFailure(error: PwaDatabaseError): void {
    if (this.openFailure) return;
    this.openFailure = error;
    for (const listener of this.openFailureListeners) listener(error);
  }
}

export function makePwaDeviceId(deviceId: string): string {
  return encodeURIComponent(deviceId);
}

export function makePwaEndpointId(deviceId: string, endpointId: string): string {
  return `${encodeURIComponent(deviceId)}:${encodeURIComponent(endpointId)}`;
}

let database: PwaDatabase | null = null;

export function getPwaDatabase(): PwaDatabase {
  if (!database) database = new PwaDatabase();
  return database;
}

export async function openPwaDatabase(): Promise<PwaDatabase> {
  const db = getPwaDatabase();
  const existingFailure = db.getOpenFailure();
  if (existingFailure) throw existingFailure;
  if (db.isOpen()) return db;

  let removeFailureListener = () => {};
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const failure = new Promise<never>((_, reject) => {
    removeFailureListener = db.onOpenFailure(reject);
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new PwaDatabaseError("open_failed", "Opening the local workspace took too long.")), DATABASE_OPEN_TIMEOUT_MS);
  });
  try {
    const opening = db.open().catch((error: unknown) => {
      if (error instanceof PwaDatabaseError) throw error;
      throw new PwaDatabaseError("open_failed", "Could not open the local workspace.", { cause: error });
    });
    await Promise.race([opening, failure, timeout]);
    return db;
  } finally {
    removeFailureListener();
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

export async function listPwaDevices(): Promise<PwaDeviceRecord[]> {
  return getPwaDatabase().devices.orderBy("pairedAt").reverse().toArray();
}

export async function listPwaEndpoints(deviceId: string): Promise<PwaEndpointRecord[]> {
  return getPwaDatabase().endpoints.where("deviceId").equals(deviceId).sortBy("updatedAt");
}

export async function removePwaDeviceData(deviceId: string, deviceRecordId: string, activeEndpointSettingKey?: string): Promise<void> {
  const db = getPwaDatabase();
  await db.transaction("rw", [db.devices, db.endpoints, db.events, db.sessions, db.settings], async () => {
    await Promise.all([
      db.devices.delete(deviceRecordId),
      db.endpoints.where("deviceId").equals(deviceId).delete(),
      db.events.where("deviceId").equals(deviceId).delete(),
      db.sessions.where("deviceId").equals(deviceId).delete(),
      activeEndpointSettingKey ? db.settings.delete(activeEndpointSettingKey) : Promise.resolve(),
    ]);
  });
}

export async function clearPwaData(): Promise<void> {
  const db = getPwaDatabase();
  await db.transaction("rw", [db.identities, db.devices, db.endpoints, db.events, db.sessions, db.settings], async () => {
    await Promise.all([
      db.identities.clear(),
      db.devices.clear(),
      db.endpoints.clear(),
      db.events.clear(),
      db.sessions.clear(),
      db.settings.clear(),
    ]);
  });
}
