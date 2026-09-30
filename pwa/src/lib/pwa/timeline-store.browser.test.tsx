import { beforeEach, expect, test, vi } from "vitest";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { getPwaDatabase, openPwaDatabase, type PwaTimelineEventRecord } from "./db";
import {
  clearScope,
  findTimelineConflict,
  isPersistableTimelineEvent,
  listTimelineSessions,
  loadTimeline,
  makePwaTimelineEventId,
  makeTimelineScopeId,
  mergeTimelineEvents,
  replaceTimelineEvents,
  saveTimelineSessionName,
  selectPersistableTimelineEvents,
  type TimelineScope,
} from "./timeline-store";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", sessionId: "session", leafId: "leaf" };
type UserTimelineEvent = Extract<TimelineEvent, { kind: "user" }>;
function userEvent(eventId: string, groupId: string, timestamp: number, target = scope): UserTimelineEvent {
  return { event_id: eventId, session_id: target.sessionId, leaf_id: target.leafId, timestamp, group_id: groupId, kind: "user", message_id: eventId, blocks: [{ type: "text", text: eventId }], origin: "extension", delivery: "normal", status: "committed" };
}
function record(event: TimelineEvent): PwaTimelineEventRecord {
  const hasPreview = (event.kind === "user" || event.kind === "assistant")
    && event.blocks.some((block) => "text" in block && block.text.trim());
  return {
    id: makePwaTimelineEventId(scope, event.event_id),
    deviceId: scope.deviceId,
    endpointId: scope.endpointId,
    sessionId: scope.sessionId,
    leafId: event.leaf_id,
    eventId: event.event_id,
    eventSeq: event.event_seq,
    ...(hasPreview ? { hasPreview: 1 } : {}),
    groupId: event.group_id,
    timestamp: event.timestamp,
    event,
  };
}

beforeEach(async () => {
  await openPwaDatabase();
  await Promise.all([
    getPwaDatabase().events.clear(),
    getPwaDatabase().sessions.clear(),
  ]);
});

test("stores every formal event, including ungrouped system records", () => {
  const committed = userEvent("committed", "group-1", 1);
  const system: TimelineEvent = { event_id: "system", session_id: scope.sessionId, leaf_id: scope.leafId, timestamp: 2, kind: "custom", payload: { notice: true }, truncated: false };
  expect(isPersistableTimelineEvent(committed)).toBe(true);
  expect(isPersistableTimelineEvent(system)).toBe(true);
  expect(selectPersistableTimelineEvents(scope, [system, committed])).toEqual([committed, system]);
});

test("stores and replays run_end without using it as the history preview", async () => {
  const committed = { ...userEvent("committed", "group-1", 1), event_seq: 1 };
  const runEnd: TimelineEvent = { event_id: "run-end", event_seq: 2, session_id: scope.sessionId, leaf_id: scope.leafId, timestamp: 3, group_id: "group-1", kind: "run_end", status: "complete" };
  await mergeTimelineEvents(scope, [committed, runEnd]);
  expect(await loadTimeline(scope)).toEqual([committed, runEnd]);
  expect((await listTimelineSessions(scope.deviceId))[0]).toMatchObject({ preview: "committed", updatedAt: 3 });
});

test("orders sequenced formal events independently of reversed timestamps", async () => {
  const first = { ...userEvent("first", "group-1", 200), event_seq: 1 };
  const second = { ...userEvent("second", "group-2", 100), event_seq: 2 };

  expect(selectPersistableTimelineEvents(scope, [second, first])).toEqual([first, second]);
  await mergeTimelineEvents(scope, [second, first]);
  expect(await loadTimeline(scope)).toEqual([first, second]);
});

test("falls back to timestamp and event id when sequence numbers are missing", () => {
  const first = userEvent("a", "group-a", 100);
  const second = userEvent("b", "group-b", 100);
  const third = userEvent("c", "group-c", 200);

  expect(selectPersistableTimelineEvents(scope, [third, second, first])).toEqual([first, second, third]);
});

test("keeps a stable total order when sequenced and unsequenced events are mixed", () => {
  const first = { ...userEvent("first", "group-1", 300), event_seq: 1 };
  const second = { ...userEvent("second", "group-2", 100), event_seq: 2 };
  const unsequenced = userEvent("unsequenced", "group-legacy", 200);
  const expected = [first, second, unsequenced];
  const permutations = [
    [first, second, unsequenced],
    [first, unsequenced, second],
    [second, first, unsequenced],
    [second, unsequenced, first],
    [unsequenced, first, second],
    [unsequenced, second, first],
  ];

  for (const events of permutations) {
    expect(selectPersistableTimelineEvents(scope, events)).toEqual(expected);
  }
});

test("keeps all formal groups when newer history windows arrive", async () => {
  const first = Array.from({ length: 6 }, (_, index) => userEvent(`event-${index}`, `group-${index}`, index));
  await mergeTimelineEvents(scope, first);
  await mergeTimelineEvents(scope, [userEvent("event-6", "group-6", 6)]);
  expect((await loadTimeline(scope)).map((event) => event.event_id)).toEqual([
    "event-0", "event-1", "event-2", "event-3", "event-4", "event-5", "event-6",
  ]);
});

test("lists stable history summaries across endpoints and sessions", async () => {
  const secondScope = { ...scope, endpointId: "other-endpoint", sessionId: "other-session", leafId: "other-leaf" };
  const otherDeviceScope = { ...scope, deviceId: "other-device" };
  await mergeTimelineEvents(scope, [userEvent("first", "group", 1)]);
  await mergeTimelineEvents(secondScope, [userEvent("second", "group", 3, secondScope)]);
  await mergeTimelineEvents(otherDeviceScope, [userEvent("hidden", "group", 4, otherDeviceScope)]);

  const summaries = await listTimelineSessions(scope.deviceId);
  expect(summaries).toHaveLength(2);
  expect(summaries.map((summary) => summary.endpointId)).toEqual([secondScope.endpointId, scope.endpointId]);
  expect(summaries[0]).toMatchObject({ sessionId: secondScope.sessionId, leafId: secondScope.leafId, eventCount: 1, preview: "second" });
});

test("keeps event-only history records untitled", async () => {
  await mergeTimelineEvents(scope, [userEvent("legacy", "group", 1)]);

  const [summary] = await listTimelineSessions(scope.deviceId);
  expect(summary).not.toHaveProperty("name");
});

test("updates a saved name without changing event-derived metadata", async () => {
  await mergeTimelineEvents(scope, [userEvent("first", "group", 10)]);
  const beforeRename = (await listTimelineSessions(scope.deviceId))[0]!;

  await saveTimelineSessionName(scope, "  First local title  ");
  await saveTimelineSessionName(scope, "Updated local title");
  await saveTimelineSessionName(scope, "   ");
  const afterRename = (await listTimelineSessions(scope.deviceId))[0]!;
  expect(afterRename).toMatchObject({
    name: "Updated local title",
    startedAt: beforeRename.startedAt,
    updatedAt: beforeRename.updatedAt,
    eventCount: beforeRename.eventCount,
  });

  await mergeTimelineEvents(scope, [userEvent("second", "group", 20)]);
  expect((await listTimelineSessions(scope.deviceId))[0]).toMatchObject({
    name: "Updated local title",
    updatedAt: 20,
    eventCount: 2,
  });
});

test("shares names across leaf changes and isolates sessions", async () => {
  const nextLeaf = { ...scope, leafId: "next-leaf" };
  const nextSession = { ...scope, sessionId: "next-session" };
  await mergeTimelineEvents(scope, [userEvent("base", "group", 1)]);
  await mergeTimelineEvents(nextLeaf, [userEvent("next-leaf", "group", 2, nextLeaf)]);
  await mergeTimelineEvents(nextSession, [userEvent("next-session", "group", 3, nextSession)]);
  await saveTimelineSessionName(scope, "Base title");
  await saveTimelineSessionName(nextSession, "Next session title");

  const summaries = await listTimelineSessions(scope.deviceId);
  const namesById = new Map(summaries.map((summary) => [summary.id, summary.name]));
  expect(namesById.get(makeTimelineScopeId(scope))).toBe("Base title");
  expect(namesById.get(makeTimelineScopeId(nextLeaf))).toBe("Base title");
  expect(namesById.get(makeTimelineScopeId(nextSession))).toBe("Next session title");
});

test("persists saved names after reopening IndexedDB", async () => {
  await mergeTimelineEvents(scope, [userEvent("persisted", "group", 1)]);
  await saveTimelineSessionName(scope, "Persistent title");

  getPwaDatabase().close();
  await openPwaDatabase();

  expect((await listTimelineSessions(scope.deviceId))[0]).toMatchObject({ name: "Persistent title" });
});

test("clears a session name with its scoped events", async () => {
  const retainedScope = { ...scope, sessionId: "retained-session" };
  await mergeTimelineEvents(scope, [userEvent("cleared", "group", 1)]);
  await mergeTimelineEvents(retainedScope, [userEvent("retained", "group", 2, retainedScope)]);
  await saveTimelineSessionName(scope, "Clear me");
  await saveTimelineSessionName(retainedScope, "Keep me");

  await clearScope(scope);

  expect(await loadTimeline(scope)).toEqual([]);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(scope))).toBeUndefined();
  expect(await loadTimeline(retainedScope)).toHaveLength(1);
  expect((await listTimelineSessions(scope.deviceId))[0]).toMatchObject({
    id: makeTimelineScopeId(retainedScope),
    name: "Keep me",
  });
});

test("detects divergent event IDs sharing one stable sequence", () => {
  const existing = [record({ ...userEvent("event-a", "group", 1), event_seq: 7 })];
  const incoming = [record({ ...userEvent("event-b", "group", 1), event_seq: 7 })];
  expect(findTimelineConflict(existing, incoming)?.eventId).toBe("event-b");
});

test("rejects a late old-branch event with an occupied sequence", async () => {
  const oldBranch = { ...scope, leafId: "old-leaf" };
  const nextBranch = { ...scope, leafId: "next-leaf" };
  const current = { ...userEvent("current", "group", 2, nextBranch), event_seq: 7 };
  const late = { ...userEvent("late", "group", 1, oldBranch), event_seq: 7 };

  await replaceTimelineEvents(nextBranch, [current]);
  await expect(mergeTimelineEvents(nextBranch, [late])).rejects.toThrow("conflicting event sequence");
  expect(await loadTimeline(nextBranch)).toEqual([current]);

  getPwaDatabase().close();
  await openPwaDatabase();
  expect(await loadTimeline(nextBranch)).toEqual([current]);
});


test("overwrites a duplicate event ID without deleting saved history", async () => {
  const original = userEvent("event", "group", 1);
  await mergeTimelineEvents(scope, [original]);

  const replacement = { ...original, blocks: [{ type: "text" as const, text: "different" }] };
  await mergeTimelineEvents(scope, [replacement]);

  expect(await loadTimeline(scope)).toEqual([replacement]);
});

test("does not let an older same-ID sequence overwrite a newer revision", async () => {
  const newer = { ...userEvent("event", "group", 2), event_seq: 11 };
  const older = { ...newer, event_seq: 10, blocks: [{ type: "text" as const, text: "older" }] };
  await mergeTimelineEvents(scope, [newer]);
  await mergeTimelineEvents(scope, [older]);
  expect(await loadTimeline(scope)).toEqual([newer]);
});


test("does not let an unnumbered same-ID revision overwrite a numbered event", async () => {
  const numbered = { ...userEvent("event", "group", 2), event_seq: 11 };
  const unnumbered = { ...userEvent("event", "group", 3), blocks: [{ type: "text" as const, text: "unnumbered" }] };
  await mergeTimelineEvents(scope, [numbered]);
  await mergeTimelineEvents(scope, [unnumbered]);
  expect(await loadTimeline(scope)).toEqual([numbered]);
});

test("rejects a batch sequence swap that would downgrade one event", async () => {
  const first = { ...userEvent("first", "group", 1), event_seq: 1 };
  const second = { ...userEvent("second", "group", 2), event_seq: 2 };
  await mergeTimelineEvents(scope, [first, second]);
  const firstMoved = { ...first, event_seq: 2 };
  const secondMoved = { ...second, event_seq: 1 };
  await expect(mergeTimelineEvents(scope, [firstMoved, secondMoved])).rejects.toThrow("conflicting event sequence");
  expect(await loadTimeline(scope)).toEqual([first, second]);
});


test("allows an event to move sequences before another event takes the released sequence", async () => {
  const first = { ...userEvent("first", "group", 1), event_seq: 7 };
  await mergeTimelineEvents(scope, [first]);
  const moved = { ...first, event_seq: 8, blocks: [{ type: "text" as const, text: "moved" }] };
  await mergeTimelineEvents(scope, [moved]);
  const replacement = { ...userEvent("replacement", "group", 2), event_seq: 7 };
  await mergeTimelineEvents(scope, [replacement]);

  expect(await loadTimeline(scope)).toEqual([replacement, moved]);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(scope))).toMatchObject({ eventCount: 2 });
});

test("recomputes summary sources after a revision changes preview and time order", async () => {
  const first = { ...userEvent("first", "group", 1), event_seq: 1 };
  const latest = { ...userEvent("latest", "group", 2), event_seq: 2 };
  await mergeTimelineEvents(scope, [first, latest]);

  const withoutPreview = { ...latest, blocks: [] };
  await mergeTimelineEvents(scope, [withoutPreview]);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(scope))).toMatchObject({
    eventCount: 2,
    preview: "first",
    previewEventId: "first",
    firstEventId: "first",
    lastEventId: "latest",
  });

  const movedFirst = { ...first, event_seq: 3, timestamp: 3, blocks: [{ type: "text" as const, text: "moved first" }] };
  await mergeTimelineEvents(scope, [movedFirst]);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(scope))).toMatchObject({
    eventCount: 2,
    startedAt: 2,
    updatedAt: 3,
    preview: "moved first",
    previewEventId: "first",
    firstEventId: "latest",
    lastEventId: "first",
  });
});


test("is idempotent for duplicate formal events", async () => {
  const event = userEvent("event", "group", 1);
  await mergeTimelineEvents(scope, [event, event]);
  await mergeTimelineEvents(scope, [event]);

  expect(await loadTimeline(scope)).toEqual([event]);
});

test("atomically replaces the current branch projection while preserving the session name", async () => {
  const nextLeaf = { ...scope, leafId: "next-leaf" };
  await mergeTimelineEvents(scope, [userEvent("old-1", "old", 1), userEvent("old-2", "old", 2)]);
  await saveTimelineSessionName(scope, "Pinned session");
  const replacement = userEvent("new-1", "new", 3, nextLeaf);

  await replaceTimelineEvents(nextLeaf, [replacement]);

  expect(await loadTimeline(scope)).toEqual([replacement]);
  expect(await loadTimeline(nextLeaf)).toEqual([replacement]);
  expect(await getPwaDatabase().events.where("[deviceId+endpointId+sessionId]").equals([scope.deviceId, scope.endpointId, scope.sessionId]).count()).toBe(1);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(scope))).toMatchObject({
    name: "Pinned session",
    leafId: nextLeaf.leafId,
    eventCount: 1,
    preview: "new-1",
  });
});

test("persists an empty replacement as the current session projection", async () => {
  const emptyBranch = { ...scope, leafId: null };
  await mergeTimelineEvents(scope, [userEvent("old", "old", 1)]);
  await saveTimelineSessionName(scope, "Keep the title");

  await replaceTimelineEvents(emptyBranch, []);

  expect(await loadTimeline(scope)).toEqual([]);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(scope))).toMatchObject({
    name: "Keep the title",
    leafId: null,
    eventCount: 0,
  });
  expect(await listTimelineSessions(scope.deviceId)).toEqual([]);
});

test("roundtrips null leaf events and clears the stable session projection", async () => {
  const emptyLeaf = { ...scope, leafId: null };
  const first = userEvent("first", "g1", 1, emptyLeaf);
  const second = userEvent("second", "g2", 2, emptyLeaf);
  await mergeTimelineEvents(emptyLeaf, [first]);
  await mergeTimelineEvents(emptyLeaf, [second]);
  await mergeTimelineEvents(scope, [userEvent("retained", "g3", 3)]);
  const replacement = { ...first, blocks: [{ type: "text" as const, text: "edited" }] };
  await mergeTimelineEvents(emptyLeaf, [replacement]);
  getPwaDatabase().close();
  await openPwaDatabase();
  expect(await loadTimeline(emptyLeaf)).toEqual([replacement, second, userEvent("retained", "g3", 3)]);
  expect((await listTimelineSessions()).find((entry) => entry.sessionId === emptyLeaf.sessionId)).toMatchObject({ eventCount: 3, preview: "retained", leafId: null });
  await clearScope(emptyLeaf);
  expect(await loadTimeline(emptyLeaf)).toEqual([]);
  expect(await getPwaDatabase().sessions.get(makeTimelineScopeId(emptyLeaf))).toBeUndefined();
  expect(await loadTimeline(scope)).toEqual([]);
});

test("serializes renames with event summary updates", async () => {
  await mergeTimelineEvents(scope, [userEvent("first", "g1", 1)]);
  await Promise.all([
    saveTimelineSessionName(scope, "Renamed"),
    mergeTimelineEvents(scope, [userEvent("second", "g2", 2)]),
  ]);
  expect((await listTimelineSessions())[0]).toMatchObject({ name: "Renamed", eventCount: 2, preview: "second", updatedAt: 2 });
});

test.each([10, 1_000, 10_000])("keeps single-event merge reads bounded with %i saved events", async (size) => {
  const db = getPwaDatabase();
  const seeded = Array.from({ length: size }, (_, index) => record({
    ...userEvent(`seed-${index}`, `group-${index}`, index + 1),
    event_seq: index + 1,
  }));
  await db.events.bulkPut(seeded);
  await db.sessions.put({
    id: makeTimelineScopeId(scope),
    ...scope,
    startedAt: 1,
    updatedAt: size,
    eventCount: size,
    preview: `seed-${size - 1}`,
    previewEventId: `seed-${size - 1}`,
    firstEventId: "seed-0",
    lastEventId: `seed-${size - 1}`,
  });

  let materializedRecords = 0;
  let materializedBytes = 0;
  const readingHook = (value: PwaTimelineEventRecord | undefined) => {
    if (value) {
      materializedRecords += 1;
      materializedBytes += JSON.stringify(value).length;
    }
    return value;
  };
  db.events.hook("reading", readingHook);
  const baselineStartedAt = performance.now();
  await db.events.where("[deviceId+endpointId+sessionId]").equals([scope.deviceId, scope.endpointId, scope.sessionId]).toArray();
  const baseline = {
    queryCount: 1,
    materializedRecords,
    materializedBytes,
    durationMs: performance.now() - baselineStartedAt,
  };
  materializedRecords = 0;
  materializedBytes = 0;
  const bulkGet = vi.spyOn(db.events, "bulkGet");
  const where = vi.spyOn(db.events, "where");
  const startedAt = performance.now();
  try {
    await mergeTimelineEvents(scope, [{
      ...userEvent(`appended-${size}`, "appended", size + 1),
      event_seq: size + 1,
    }]);
  } finally {
    db.events.hook("reading").unsubscribe(readingHook);
  }
  const durationMs = performance.now() - startedAt;
  const queryCount = bulkGet.mock.calls.length + where.mock.calls.length;
  bulkGet.mockRestore();
  where.mockRestore();

  expect(baseline.materializedRecords).toBe(size);
  expect(materializedRecords).toBe(3);
  expect(materializedBytes).toBeLessThanOrEqual(2_048);
  expect(queryCount).toBe(4);
  expect((await db.sessions.get(makeTimelineScopeId(scope)))?.eventCount).toBe(size + 1);
  console.info(JSON.stringify({ size, baseline, optimized: { queryCount, materializedRecords, materializedBytes, durationMs } }));
});


test("omits runtime identity from the persistent key", () => {
  expect(makeTimelineScopeId({ ...scope, leafId: null })).toBe(makeTimelineScopeId({ ...scope, leafId: "null" }));
  expect(makePwaTimelineEventId(scope, "event/1")).toBe("device:endpoint:session:event%2F1");
});
