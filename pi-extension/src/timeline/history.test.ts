import { describe, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { decodeServerFrameV2, MAX_WINDOW_DECODE_BYTES, type TimelineEvent } from "../protocol/v2/index.js";
import { TimelineHistoryPager } from "./history.js";

const MARKER = "pi-reach:timeline-v2";

function marker(session: SessionManager, _eventId: string, groupId: string): void {
  session.appendCustomEntry(MARKER, { version: 2, group_id: groupId, kind: "user" });
}

function userEvent(session: SessionManager, eventSeq: number, groupId: string, text = `event-${eventSeq}`): TimelineEvent {
  const eventId = `event-${eventSeq}`;
  return {
    event_id: eventId,
    event_seq: eventSeq,
    message_id: eventId,
    session_id: session.getSessionId(),
    leaf_id: session.getLeafId() ?? null,
    group_id: groupId,
    timestamp: 1,
    kind: "user",
    blocks: [{ type: "text", text }],
    origin: "unknown",
    delivery: "unknown",
    status: "committed",
  };
}

function events(count: number, session: SessionManager): TimelineEvent[] {
  const recovered = Array.from({ length: count }, (_, index) => {
    const event = userEvent(session, index + 1, `group-${Math.floor(index / 3)}`);
    marker(session, event.event_id, event.group_id);
    return event;
  });
  const leafId = session.getLeafId() ?? null;
  return recovered.map((event) => ({ ...event, leaf_id: leafId }));
}

function frameEvents(frames: ReturnType<TimelineHistoryPager["sync"]>): TimelineEvent[] {
  return frames.flatMap((frame) => frame.type === "session_history_chunk" ? frame.events : []);
}

function finalChunk(frames: ReturnType<TimelineHistoryPager["sync"]>) {
  const frame = frames.at(-1);
  if (frame?.type !== "session_history_chunk" || !frame.final_chunk) throw new Error("missing final history chunk");
  return frame;
}

function returnedFragmentIds(frames: ReturnType<TimelineHistoryPager["sync"]>): string[] {
  const ids = frames.flatMap((frame) => frame.type === "session_history_chunk" ? frame.fragments.map((fragment) => fragment.event_id) : []);
  return [...new Set(ids)];
}

describe("TimelineHistoryPager", () => {
  test("returns an empty authoritative chunk for a new session", () => {
    const session = SessionManager.inMemory(process.cwd());
    const pager = new TimelineHistoryPager(session, () => []);
    expect(pager.sync({ requestId: "empty", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: null })[0]).toMatchObject({
      type: "session_history_chunk",
      final_chunk: true,
      eos: true,
      leaf_id: null,
      events: [],
      fragments: [],
    });
  });

  test("pages exactly 80 formal events regardless of group boundaries", () => {
    const session = SessionManager.inMemory(process.cwd());
    const recovered = events(83, session);
    const pager = new TimelineHistoryPager(session, () => recovered);

    const first = pager.sync({ requestId: "sync-1", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: null });
    expect(frameEvents(first).map((event) => event.event_seq)).toEqual(Array.from({ length: 80 }, (_, index) => index + 4));
    expect(finalChunk(first)).toMatchObject({ eos: false, next_before: 4, leaf_id: session.getLeafId() });

    const second = pager.sync({ requestId: "sync-2", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: 4 });
    expect(frameEvents(second).map((event) => event.event_seq)).toEqual([1, 2, 3]);
    expect(finalChunk(second)).toMatchObject({ eos: true });
  });

  test("serves exact numeric subranges repeatedly and ordinary append keeps existing ordinals stable", () => {
    const session = SessionManager.inMemory(process.cwd());
    const recovered = events(83, session);
    const pager = new TimelineHistoryPager(session, () => recovered);
    const request = { requestId: "range-1", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: 61, limit: 10 } as const;

    expect(frameEvents(pager.sync(request)).map((event) => event.event_seq)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(frameEvents(pager.sync({ ...request, requestId: "range-retry" })).map((event) => event.event_seq)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);

    const appended = userEvent(session, 84, "group-later");
    marker(session, appended.event_id, appended.group_id);
    recovered.push(appended);
    expect(pager.sync({ ...request, requestId: "range-after-append" })[0]).toMatchObject({
      type: "reset",
      reason: "branch_changed",
      leaf_id: session.getLeafId(),
    });
  });

  test("rejects future and malformed numeric boundaries without cursor state", () => {
    const session = SessionManager.inMemory(process.cwd());
    const recovered = events(3, session);
    const pager = new TimelineHistoryPager(session, () => recovered);

    expect(pager.sync({ requestId: "future", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: 5 })[0]).toMatchObject({
      type: "protocol_error", code: "invalid_cursor", in_reply_to: "future",
    });
    expect(pager.sync({ requestId: "zero", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: 0 })[0]).toMatchObject({
      type: "protocol_error", code: "invalid_cursor",
    });
    expect(pager.sync({ requestId: "large-limit", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: 4, limit: 81 })[0]).toMatchObject({
      type: "protocol_error", code: "invalid_cursor",
    });
  });

  test("fails closed for non-dense, duplicate, and out-of-scope recovery", () => {
    const session = SessionManager.inMemory(process.cwd());
    marker(session, "event-2", "group");
    const base = userEvent(session, 2, "group");
    const cases: TimelineEvent[][] = [
      [base],
      [{ ...base, event_seq: 1 }, { ...base, event_seq: 2 }],
      [{ ...base, event_seq: 1, session_id: "other-session" }],
    ];
    for (const [index, recovered] of cases.entries()) {
      const pager = new TimelineHistoryPager(session, () => recovered);
      expect(pager.sync({ requestId: `invalid-${index}`, targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: null })[0]).toMatchObject({
        type: "protocol_error", code: "internal_error",
      });
    }
  });

  test("isolates a response when its generation or branch changes during recovery", () => {
    const generationSession = SessionManager.inMemory(process.cwd());
    const generationEvents = events(1, generationSession);
    const generationLeaf = generationSession.getLeafId() ?? null;
    const generationPager = new TimelineHistoryPager(generationSession, () => {
      const recovered = generationEvents.map((event) => ({ ...event, leaf_id: generationLeaf }));
      marker(generationSession, "event-2", "group-later");
      return recovered;
    });
    expect(generationPager.sync({ requestId: "generation", targetChannelId: "channel-1", leafId: generationLeaf, before: null })[0]).toMatchObject({
      type: "reset", reason: "branch_changed", leaf_id: generationSession.getLeafId(),
    });

    const branchSession = SessionManager.inMemory(process.cwd());
    const branchEvents = events(1, branchSession);
    const branchPager = new TimelineHistoryPager(branchSession, () => {
      marker(branchSession, "event-2", "group-later");
      return branchEvents;
    });
    expect(branchPager.sync({ requestId: "branch", targetChannelId: "channel-1", leafId: branchSession.getLeafId() ?? null, before: null })[0]).toMatchObject({
      type: "reset", reason: "branch_changed",
    });
  });

  test("resets to the replacement session and generation when recovery replaces the session", () => {
    let sessionId = "session-old";
    let leafId: string | null = null;
    const recoverySession = {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getBranch: () => [],
    } as unknown as SessionManager;
    const recovered = { ...userEvent(recoverySession, 1, "group-1"), leaf_id: null };
    const pager = new TimelineHistoryPager(recoverySession, () => {
      sessionId = "session-new";
      leafId = "generation-new";
      return [recovered];
    });

    expect(pager.sync({ requestId: "replacement", targetChannelId: "channel-1", leafId: recoverySession.getLeafId() ?? null, before: null })[0]).toMatchObject({
      type: "reset",
      target_channel_id: "channel-1",
      session_id: "session-new",
      leaf_id: "generation-new",
      reason: "session_replaced",
    });
  });

  test("fragments large events at 50 KiB and keeps every encoded chunk within 512 KiB", () => {
    const session = SessionManager.inMemory(process.cwd());
    marker(session, "event-1", "large-group");
    const largeEvent = userEvent(session, 1, "large-group", "x".repeat(700 * 1024));
    const pager = new TimelineHistoryPager(session, () => [largeEvent]);
    const frames = pager.sync({ requestId: "large", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: null });
    const fragments = frames.flatMap((frame) => frame.type === "session_history_chunk" ? frame.fragments : []);
    expect(frames.length).toBeGreaterThan(1);
    expect(fragments.length).toBeGreaterThan(10);
    expect(fragments.map((fragment) => fragment.index)).toEqual([...Array(fragments.length).keys()]);
    expect(fragments.at(-1)?.final).toBe(true);
    for (const frame of frames) {
      expect(decodeServerFrameV2(frame)).toEqual(frame);
      expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(512 * 1024);
    }
  });

  test("returns a contiguous suffix when an 80-event range exceeds 32 MiB", () => {
    const session = SessionManager.inMemory(process.cwd());
    const text = "x".repeat(1024 * 1024 - 2048);
    const recovered = Array.from({ length: 34 }, (_, index) => {
      marker(session, `event-${index + 1}`, `group-${index}`);
      return userEvent(session, index + 1, `group-${index}`, text);
    });
    const leafId = session.getLeafId() ?? null;
    const scopedRecovered = recovered.map((event) => ({ ...event, leaf_id: leafId }));
    const pager = new TimelineHistoryPager(session, () => scopedRecovered);
    const first = pager.sync({ requestId: "suffix", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: null });
    const ids = returnedFragmentIds(first);
    const oldestSeq = Number(ids[0]?.slice("event-".length));
    expect(oldestSeq).toBeGreaterThan(1);
    expect(ids).toEqual(Array.from({ length: 35 - oldestSeq }, (_, index) => `event-${oldestSeq + index}`));
    expect(finalChunk(first)).toMatchObject({ eos: false, next_before: oldestSeq });

    const remaining = pager.sync({ requestId: "prefix", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: oldestSeq, limit: oldestSeq - 1 });
    expect(returnedFragmentIds(remaining)).toEqual(Array.from({ length: oldestSeq - 1 }, (_, index) => `event-${index + 1}`));
    expect(finalChunk(remaining)).toMatchObject({ eos: true });
  });

  test("returns too_large when one formal event exceeds the 32 MiB window", () => {
    const session = SessionManager.inMemory(process.cwd());
    marker(session, "event-1", "one-large-event");
    const block = "x".repeat(1024 * 1024);
    const event = {
      ...userEvent(session, 1, "one-large-event"),
      blocks: Array.from({ length: 33 }, () => ({ type: "text" as const, text: block })),
    };
    expect(new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeGreaterThan(MAX_WINDOW_DECODE_BYTES);
    const pager = new TimelineHistoryPager(session, () => [event]);
    expect(pager.sync({ requestId: "too-large", targetChannelId: "channel-1", leafId: session.getLeafId() ?? null, before: null })[0]).toMatchObject({
      type: "protocol_error", code: "too_large",
    });
  });
});
