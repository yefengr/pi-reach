import Dexie from "dexie";
import { expect, test } from "vitest";
import {
  clearPwaData,
  makePwaDeviceId,
  makePwaEndpointId,
  openPwaDatabase,
  PwaDatabase,
  removePwaDeviceData,
  type PwaTimelineEventRecord,
} from "./db";

const legacyTimelineSchema = "id, [deviceId+endpointId+sessionId+leafId], timestamp, eventId";

function timelineRecord(deviceId: string): PwaTimelineEventRecord {
  return {
    id: `${deviceId}:endpoint:session:generation:event`,
    deviceId,
    endpointId: "endpoint",
    sessionId: "session",
    leafId: "generation",
    eventId: "event",
    timestamp: 1,
    event: {
      event_id: "event",
      session_id: "session",
      leaf_id: "generation",
      timestamp: 1,
      kind: "custom",
      payload: { notice: true },
      truncated: false,
    },
  };
}

test("creates stable device and endpoint keys without room aliases", () => {
  const device = "ER0CaBbQVX";
  expect(makePwaDeviceId(device)).toBe(device);
  expect(makePwaEndpointId(device, "endpoint-a")).not.toBe(makePwaEndpointId(device, "endpoint-b"));
  expect(makePwaEndpointId(device, "endpoint/a")).toBe("ER0CaBbQVX:endpoint%2Fa");
});

test("upgrades v7 timeline records with the v8 device indexes intact", async () => {
  const databaseName = `pi-reach-v7-upgrade-${Date.now()}`;
  const legacy = new Dexie(databaseName);
  legacy.version(7).stores({
    identities: "id, publicKey",
    devices: "id, deviceId, relayUrl, pairedAt",
    endpoints: "id, deviceId, [deviceId+endpointId], endpointId, updatedAt",
    events: legacyTimelineSchema,
    settings: "key",
  });
  await legacy.open();
  await legacy.table<PwaTimelineEventRecord, string>("events").put(timelineRecord("legacy-device"));
  legacy.close();

  const upgraded = new PwaDatabase(databaseName);
  try {
    await upgraded.open();
    expect(await upgraded.events.where("deviceId").equals("legacy-device").count()).toBe(1);
    expect((await upgraded.events.toArray())[0]?.id).toBe("legacy-device:endpoint:session:event");
    expect(await upgraded.events.where("[deviceId+timestamp]").equals(["legacy-device", 1]).count()).toBe(1);
    expect(await upgraded.sessions.count()).toBe(1);
    expect(await upgraded.sessions.toArray()).toEqual([
      expect.objectContaining({
        deviceId: "legacy-device",
        endpointId: "endpoint",
        sessionId: "session",
        eventCount: 1,
        firstEventId: "event",
        lastEventId: "event",
      }),
    ]);
  } finally {
    upgraded.close();
    await Dexie.delete(databaseName);
  }
});

test("upgrades v10 events with sequence and summary indexes", async () => {
  const databaseName = `pi-reach-v10-upgrade-${Date.now()}`;
  const legacy = new Dexie(databaseName);
  legacy.version(10).stores({
    events: "id, deviceId, [deviceId+endpointId+sessionId], [deviceId+timestamp], timestamp, eventId",
    sessions: "id, deviceId, updatedAt",
  });
  await legacy.open();
  const event = {
    ...timelineRecord("legacy-device"),
    id: "legacy-device:endpoint:session:event",
    eventSeq: undefined,
    event: {
      event_id: "event",
      event_seq: 7,
      session_id: "session",
      leaf_id: "generation",
      group_id: "group",
      timestamp: 1,
      kind: "user" as const,
      message_id: "message",
      blocks: [{ type: "text" as const, text: "Migrated preview" }],
      origin: "extension" as const,
      delivery: "normal" as const,
      status: "committed" as const,
    },
  };
  await legacy.table<PwaTimelineEventRecord, string>("events").put(event);
  await legacy.table("sessions").put({
    id: "legacy-device:endpoint:session",
    deviceId: "legacy-device",
    endpointId: "endpoint",
    sessionId: "session",
    leafId: "generation",
    name: "Kept title",
    startedAt: 99,
    updatedAt: 99,
    eventCount: 99,
    preview: "stale",
  });
  legacy.close();

  const upgraded = new PwaDatabase(databaseName);
  try {
    await upgraded.open();
    expect(await upgraded.events.where("[deviceId+endpointId+sessionId+eventSeq]").equals(["legacy-device", "endpoint", "session", 7]).count()).toBe(1);
    expect(await upgraded.events.toArray()).toEqual([expect.objectContaining({ eventSeq: 7, hasPreview: 1 })]);
    expect(await upgraded.sessions.get("legacy-device:endpoint:session")).toMatchObject({
      name: "Kept title",
      startedAt: 1,
      updatedAt: 1,
      eventCount: 1,
      preview: "Migrated preview",
      previewEventId: "event",
      firstEventId: "event",
      lastEventId: "event",
    });
  } finally {
    upgraded.close();
    await Dexie.delete(databaseName);
  }
});

test("rejects conflicting v10 projections without deleting the legacy data", async () => {
  const databaseName = `pi-reach-v10-conflict-upgrade-${Date.now()}`;
  const schema = {
    events: "id, deviceId, [deviceId+endpointId+sessionId], [deviceId+timestamp], timestamp, eventId",
    sessions: "id, deviceId, updatedAt",
  };
  const legacy = new Dexie(databaseName);
  legacy.version(10).stores(schema);
  await legacy.open();
  const legacyEvent = (eventId: string, leafId: string) => ({
    ...timelineRecord("legacy-device"),
    id: `legacy-device:endpoint:conflict:${leafId}:${eventId}`,
    sessionId: "conflict",
    leafId,
    eventId,
    event: {
      event_id: eventId,
      event_seq: 1,
      session_id: "conflict",
      leaf_id: leafId,
      timestamp: 1,
      kind: "custom" as const,
      payload: { notice: true },
      truncated: false,
    },
  });
  const legacyEvents = [
    legacyEvent("branch-a", "leaf-a"),
    legacyEvent("branch-b", "leaf-b"),
  ];
  const legacySession = {
    id: "legacy-device:endpoint:conflict",
    deviceId: "legacy-device",
    endpointId: "endpoint",
    sessionId: "conflict",
    leafId: "leaf-b",
    name: "Preserved title",
    startedAt: 1,
    updatedAt: 1,
    eventCount: 2,
    preview: "mixed branches",
  };
  await legacy.table<PwaTimelineEventRecord, string>("events").bulkPut(legacyEvents);
  await legacy.table("sessions").put(legacySession);
  legacy.close();

  const upgraded = new PwaDatabase(databaseName);
  await expect(upgraded.open()).rejects.toThrow("conflicting sequence identities");
  upgraded.close();

  const preserved = new Dexie(databaseName);
  preserved.version(10).stores(schema);
  try {
    await preserved.open();
    expect(await preserved.table("events").orderBy("id").toArray()).toEqual(
      [...legacyEvents].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(await preserved.table("sessions").get(legacySession.id)).toEqual(legacySession);
  } finally {
    preserved.close();
    await Dexie.delete(databaseName);
  }
});

test("clears a stale preview when v11 migration has no previewable event", async () => {
  const databaseName = `pi-reach-v10-preview-upgrade-${Date.now()}`;
  const legacy = new Dexie(databaseName);
  legacy.version(10).stores({
    events: "id, deviceId, [deviceId+endpointId+sessionId], [deviceId+timestamp], timestamp, eventId",
    sessions: "id, deviceId, updatedAt",
  });
  await legacy.open();
  await legacy.table<PwaTimelineEventRecord, string>("events").put({
    ...timelineRecord("legacy-device"),
    id: "legacy-device:endpoint:no-preview:leaf:custom",
    sessionId: "no-preview",
    leafId: "leaf",
    eventId: "custom",
    event: {
      event_id: "custom",
      event_seq: 2,
      session_id: "no-preview",
      leaf_id: "leaf",
      timestamp: 2,
      kind: "custom",
      payload: { notice: true },
      truncated: false,
    },
  });
  await legacy.table("sessions").put({
    id: "legacy-device:endpoint:no-preview",
    deviceId: "legacy-device",
    endpointId: "endpoint",
    sessionId: "no-preview",
    leafId: "leaf",
    startedAt: 1,
    updatedAt: 1,
    eventCount: 1,
    preview: "deleted branch text",
    previewEventId: "deleted",
  });
  legacy.close();

  const upgraded = new PwaDatabase(databaseName);
  try {
    await upgraded.open();
    expect(await upgraded.sessions.get("legacy-device:endpoint:no-preview")).toEqual(expect.objectContaining({
      eventCount: 1,
      preview: "Saved conversation",
      firstEventId: "custom",
      lastEventId: "custom",
    }));
    expect((await upgraded.sessions.get("legacy-device:endpoint:no-preview"))?.previewEventId).toBeUndefined();
  } finally {
    upgraded.close();
    await Dexie.delete(databaseName);
  }
});


test("removing a pairing deletes only that computer's history", async () => {
  const database = await openPwaDatabase();
  await database.transaction("rw", [database.devices, database.events, database.sessions, database.settings], async () => {
    await Promise.all([database.devices.clear(), database.events.clear(), database.sessions.clear(), database.settings.clear()]);
    await database.devices.bulkPut([
      { id: makePwaDeviceId("first"), deviceId: "first", relayUrl: "https://relay.example.test", pairedAt: "2026-09-01T00:00:00.000Z" },
      { id: makePwaDeviceId("second"), deviceId: "second", relayUrl: "https://relay.example.test", pairedAt: "2026-09-02T00:00:00.000Z" },
    ]);
    await database.events.bulkPut([timelineRecord("first"), timelineRecord("second")]);
    await database.sessions.bulkPut(["first", "second"].map((deviceId) => ({
      id: `${deviceId}:endpoint:session`, deviceId, endpointId: "endpoint", sessionId: "session", leafId: "generation", name: `${deviceId} session`, startedAt: 1, updatedAt: 1, eventCount: 1, preview: "event",
    })));
  });

  await removePwaDeviceData("first", makePwaDeviceId("first"));

  expect(await database.events.where("deviceId").equals("first").count()).toBe(0);
  expect(await database.events.where("deviceId").equals("second").count()).toBe(1);
  expect(await database.sessions.where("deviceId").equals("first").count()).toBe(0);
  expect(await database.sessions.where("deviceId").equals("second").count()).toBe(1);

  await clearPwaData();
  expect(await database.sessions.count()).toBe(0);
  expect(await database.events.count()).toBe(0);
});
