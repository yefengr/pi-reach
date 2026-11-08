import Dexie from "dexie";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_TOOL_DETAILS_BYTES, MAX_TOOL_DETAILS_CACHE_BYTES, MAX_TOOL_DETAILS_CACHE_ENTRIES, type ToolDetailsContent } from "@pi-reach/protocol/session";
import { clearPwaData, makePwaDeviceId, openPwaDatabase, PwaDatabase, removePwaDeviceData, type PwaTimelineEventRecord } from "./db";
import { clearScope, makeTimelineScopeId, saveTimelineSessionDetails } from "./timeline-store";
import { PersistentToolDetailsCache, toolDetailsCacheKey, type ToolDetailsCacheScope } from "./tool-details-cache";

// 仅使用 Browser Mode 测试 origin 下的隔离合成记录。
const scope: ToolDetailsCacheScope = { ownerId: "synthetic-owner", deviceId: "synthetic-device", endpointId: "synthetic-endpoint", sessionId: "synthetic-session" };
const ref = (id: string) => ({ call_entry_id: `entry-${id}`, tool_call_id: `call-${id}` });
const key = (id: string, selected = scope) => toolDetailsCacheKey(selected, "group", ref(id));
function document(id: string): ToolDetailsContent {
  return { tool_ref: ref(id), tool: "read", source: "session", status: "complete", args: { path: "synthetic.txt" }, result: "SYNTHETIC_RESULT", limited: false };
}
const text = (id: string) => JSON.stringify(document(id));
async function session(selected = scope) {
  await saveTimelineSessionDetails({ ...selected, leafId: "leaf" }, { name: "Synthetic cache fixture" });
}
let clock = 1;
beforeEach(async () => {
  await openPwaDatabase();
  await clearPwaData();
  await session();
  clock = 1;
  vi.spyOn(Date, "now").mockImplementation(() => clock++);
});
afterEach(async () => { vi.restoreAllMocks(); await clearPwaData(); });

test("v11 to v12 only adds a recyclable table and leaves formal history intact", async () => {
  const name = `synthetic-tool-details-upgrade-${crypto.randomUUID()}`;
  const legacy = new Dexie(name);
  legacy.version(11).stores({
    identities: "id, publicKey", devices: "id, deviceId, relayUrl, pairedAt", endpoints: "id, deviceId, [deviceId+endpointId], endpointId, updatedAt",
    events: "id, deviceId, [deviceId+endpointId+sessionId], [deviceId+endpointId+sessionId+eventSeq], [deviceId+endpointId+sessionId+timestamp+eventId], [deviceId+endpointId+sessionId+hasPreview+timestamp+eventId], [deviceId+timestamp], timestamp, eventId",
    sessions: "id, deviceId, updatedAt", settings: "key",
  });
  const record: PwaTimelineEventRecord = { id: "synthetic:formal", deviceId: scope.deviceId, endpointId: scope.endpointId, sessionId: scope.sessionId, leafId: "leaf", eventId: "formal", eventSeq: 7, timestamp: 1,
    event: { event_id: "formal", event_seq: 7, session_id: scope.sessionId, leaf_id: "leaf", timestamp: 1, group_id: "group", kind: "tool", tool_call_id: "call", tool: "read", args: { path: "synthetic.txt" }, result: "COMPLETE_SYNTHETIC_INLINE", status: "complete", truncated: false } };
  await legacy.open();
  await legacy.table("events").put(record);
  const savedSession = { id: "synthetic:session", deviceId: scope.deviceId, endpointId: scope.endpointId, sessionId: scope.sessionId, leafId: "leaf", startedAt: 1, updatedAt: 1, eventCount: 1, preview: "Synthetic saved preview" };
  await legacy.table("sessions").put(savedSession);
  await legacy.table("settings").put({ key: "synthetic-setting", value: "kept" });
  legacy.close();
  const upgraded = new PwaDatabase(name);
  try {
    await upgraded.open();
    expect(await upgraded.events.toArray()).toEqual([record]);
    expect(await upgraded.sessions.toArray()).toEqual([savedSession]);
    expect(await upgraded.settings.get("synthetic-setting")).toEqual({ key: "synthetic-setting", value: "kept" });
    expect(await upgraded.toolDetails.count()).toBe(0);
    expect(upgraded.verno).toBe(12);
  } finally { upgraded.close(); await Dexie.delete(name); }
});
test("global 64-entry LRU touches reads and isolates Owner keys", async () => {
  const cache = new PersistentToolDetailsCache();
  const db = await openPwaDatabase();
  for (let index = 0; index < MAX_TOOL_DETAILS_CACHE_ENTRIES; index++) await cache.put(scope, "group", ref(String(index)), text(String(index)));
  expect(await cache.get(key("0"))).toEqual(document("0"));
  const other = { ...scope, ownerId: "synthetic-other-owner" };
  await cache.put(other, "group", ref("next"), text("next"));
  expect(await db.toolDetails.count()).toBe(MAX_TOOL_DETAILS_CACHE_ENTRIES);
  expect(await cache.get(key("1"))).toBeUndefined();
  expect(await cache.get(key("0"))).toEqual(document("0"));
  expect(await cache.get(key("next", other))).toEqual(document("next"));
  expect(await cache.get(key("next"))).toBeUndefined();
});
test("global 16 MiB byte budget is inclusive and evicts least recently used complete documents", async () => {
  const cache = new PersistentToolDetailsCache();
  const db = await openPwaDatabase();
  const sized = (id: string) => {
    const value = { ...document(id), result: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(value)).length;
    return JSON.stringify({ ...value, result: "x".repeat(MAX_TOOL_DETAILS_BYTES - overhead) });
  };
  await cache.put(scope, "group", ref("a"), sized("a"));
  await cache.put(scope, "group", ref("b"), sized("b"));
  expect((await db.toolDetails.toArray()).reduce((sum, record) => sum + record.bytes, 0)).toBe(MAX_TOOL_DETAILS_CACHE_BYTES);
  await cache.get(key("a"));
  await cache.put({ ...scope, ownerId: "synthetic-other-owner" }, "group", ref("c"), text("c"));
  expect(await db.toolDetails.get(key("b"))).toBeUndefined();
  const records = await db.toolDetails.toArray();
  expect(records).toHaveLength(2);
  expect(records.reduce((sum, record) => sum + record.bytes, 0)).toBeLessThanOrEqual(MAX_TOOL_DETAILS_CACHE_BYTES);
});
test("rejects previews, missing results, mismatched native references and corrupt cached text", async () => {
  const cache = new PersistentToolDetailsCache();
  const db = await openPwaDatabase();
  for (const input of ["not-json", JSON.stringify({ ...document("x"), source: "preview", status: "running", limited: true }), JSON.stringify({ ...document("x"), result: undefined }), text("other")]) await cache.put(scope, "group", ref("x"), input);
  expect(await db.toolDetails.count()).toBe(0);
  await db.toolDetails.put({ ...scope, id: key("x"), text: "{}", bytes: 2, usedAt: 1 });
  expect(await cache.get(key("x"))).toBeUndefined();
  expect(await db.toolDetails.count()).toBe(0);
});
test("session/device/full cleanup removes details and a late cache put cannot orphan them", async () => {
  const db = await openPwaDatabase();
  const cache = new PersistentToolDetailsCache();
  const anotherSession = { ...scope, sessionId: "synthetic-second-session" };
  const anotherDevice = { ...scope, deviceId: "synthetic-second-device" };
  await session(anotherSession); await session(anotherDevice);
  for (const selected of [scope, anotherSession, anotherDevice]) {
    await db.devices.put({ id: makePwaDeviceId(selected.deviceId), deviceId: selected.deviceId, relayUrl: "https://synthetic.example.test", pairedAt: "synthetic" });
    await cache.put(selected, "group", ref("x"), text("x"));
  }
  await clearScope({ ...scope, leafId: "leaf" });
  await cache.put(scope, "group", ref("late"), text("late"));
  expect(await db.sessions.get(makeTimelineScopeId({ ...scope, leafId: "leaf" }))).toBeUndefined();
  expect(await db.toolDetails.get(key("x"))).toBeUndefined();
  expect(await db.toolDetails.get(key("late"))).toBeUndefined();
  expect(await db.toolDetails.get(key("x", anotherSession))).toBeDefined();
  await removePwaDeviceData(scope.deviceId, makePwaDeviceId(scope.deviceId));
  await cache.put(anotherSession, "group", ref("late"), text("late"));
  expect(await db.toolDetails.where("deviceId").equals(scope.deviceId).count()).toBe(0);
  expect(await db.toolDetails.get(key("x", anotherDevice))).toBeDefined();
  await clearPwaData();
  await cache.put(anotherDevice, "group", ref("late"), text("late"));
  expect(await db.toolDetails.count()).toBe(0);
  expect(await db.sessions.count()).toBe(0);
  expect(await db.devices.count()).toBe(0);
});
