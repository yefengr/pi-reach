import { expect, test, vi } from "vitest";
import type { TimelineEvent } from "../protocol/v2/index.js";
import { TimelinePublications } from "./publication.js";
import type { Correlation } from "./runtime.js";

const correlation = { origin: "pwa" as const, delivery: "normal" as const, deliveryToken: "in-memory-token" };
const first: TimelineEvent = { kind: "assistant", event_id: "first", event_seq: 1, group_id: "group", session_id: "session", leaf_id: "leaf", timestamp: 1, status: "complete", blocks: [{ type: "text", text: "Done" }] };
const end: TimelineEvent = { kind: "run_end", event_id: "end", event_seq: 2, group_id: "group", session_id: "session", leaf_id: "leaf", timestamp: 2, status: "complete" };
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("retains a visible marker until the formal target persists and publishes it once", async () => {
  const published = vi.fn();
  const publications = new TimelinePublications(published);
  let events: TimelineEvent[] = [];
  const recover = () => events;
  publications.defer(first.event_id, correlation, recover, () => true);
  await nextMacrotask();
  expect(published).not.toHaveBeenCalled();

  events = [first];
  publications.flush(recover);
  expect(published).toHaveBeenCalledExactlyOnceWith(first, correlation);
  publications.flush(recover);
  publications.publish(first, correlation);
  expect(published).toHaveBeenCalledTimes(1);
});

test("flushes pending formal events and run_end in recovered event_seq order", async () => {
  const publications = new TimelinePublications(() => {});
  const recover = () => [first, end];
  publications.defer(end.event_id, correlation, recover, () => true);
  publications.defer(first.event_id, correlation, recover, () => true);
  await nextMacrotask();
  expect(publications.events()).toEqual([first, end]);
});

test("reset invalidates deferred publications even when they use the same manager", async () => {
  const published = vi.fn();
  const publications = new TimelinePublications(published);
  publications.defer(end.event_id, correlation, () => [end], () => true);
  publications.reset();
  await nextMacrotask();
  publications.flush(() => [end]);
  expect(published).not.toHaveBeenCalled();
  expect(publications.events()).toEqual([]);
});

test("a marker removed from the active branch is not published when that branch returns", async () => {
  const published = vi.fn();
  const publications = new TimelinePublications(published);
  publications.defer(end.event_id, correlation, () => [], () => false);
  await nextMacrotask();
  publications.flush(() => [end]);
  expect(published).not.toHaveBeenCalled();
});

function event(eventId: string, eventSeq: number): TimelineEvent {
  return { ...first, event_id: eventId, event_seq: eventSeq };
}

test("coalesces a burst of defers into one recovery and only retries on an explicit boundary", async () => {
  const published: string[] = [];
  const publications = new TimelinePublications((value) => published.push(value.event_id));
  const ids = Array.from({ length: 35 }, (_, index) => `marker-${index}`);
  let events = ids.slice(0, 4).map((id, index) => event(id, index + 1));
  const recover = vi.fn(() => events);
  for (const id of ids) publications.defer(id, correlation, recover, () => true);

  // 35 项登记只执行一次恢复，且只发布已可恢复的 4 项。
  await nextMacrotask();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(published).toEqual(ids.slice(0, 4));

  // 无状态变化时不再自行调度。
  await nextMacrotask();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(published).toEqual(ids.slice(0, 4));

  // 后续显式边界恢复剩余项，已发布项不重复。
  events = ids.slice(4).map((id, index) => event(id, index + 5));
  publications.flush(recover);
  expect(published).toEqual(ids);
});

test("an explicit flush replaces the scheduled drain instead of recovering twice", async () => {
  const publications = new TimelinePublications(() => {});
  const recover = vi.fn(() => [first]);
  publications.defer(first.event_id, correlation, recover, () => true);
  publications.flush(recover);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(publications.events()).toEqual([first]);
  await nextMacrotask();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(publications.events()).toEqual([first]);
});

test("prunes a hidden first marker without dropping the rest of the batch", async () => {
  const published: string[] = [];
  const publications = new TimelinePublications((value) => published.push(value.event_id));
  const gone = event("gone", 1);
  const kept = event("kept", 2);
  const late = event("late", 3);
  const visible = new Map([["gone", true], ["kept", true], ["late", true]]);
  const recover = () => [gone, kept, late];
  for (const id of visible.keys()) publications.defer(id, correlation, recover, () => visible.get(id)!);

  visible.set("gone", false);
  await nextMacrotask();
  expect(published).toEqual(["kept", "late"]);

  // 清理后的登记不会因重新可见而复活；只有新的 defer 才重新登记。
  visible.set("gone", true);
  publications.flush(recover);
  expect(published).toEqual(["kept", "late"]);
  publications.defer("gone", correlation, recover, () => true);
  await nextMacrotask();
  expect(published).toEqual(["kept", "late", "gone"]);
});

test("a later marker that left the branch is dropped even when it returns", async () => {
  const published: string[] = [];
  const publications = new TimelinePublications((value) => published.push(value.event_id));
  const recover = () => [event("first-item", 1), event("second-item", 2)];
  const visible = new Map([["first-item", true], ["second-item", true]]);
  publications.defer("first-item", correlation, recover, () => visible.get("first-item")!);
  publications.defer("second-item", correlation, recover, () => visible.get("second-item")!);

  visible.set("second-item", false);
  await nextMacrotask();
  expect(published).toEqual(["first-item"]);
  visible.set("second-item", true);
  publications.flush(recover);
  expect(published).toEqual(["first-item"]);
});

test("a repeated defer for the same marker keeps one drain and its latest correlation", async () => {
  const observed: Array<{ eventId: string; correlation: Correlation }> = [];
  const publications = new TimelinePublications((value, current) => observed.push({ eventId: value.event_id, correlation: current }));
  const recover = vi.fn(() => [first]);
  const unknown: Correlation = { origin: "unknown", delivery: "unknown" };
  publications.defer(first.event_id, unknown, recover, () => true);
  publications.defer(first.event_id, correlation, recover, () => true);
  await nextMacrotask();

  expect(recover).toHaveBeenCalledTimes(1);
  expect(observed).toEqual([{ eventId: first.event_id, correlation }]);
  expect(publications.events()).toEqual([first]);
});

test("a defer right after reset publishes while the cancelled batch stays dead", async () => {
  const published: string[] = [];
  const publications = new TimelinePublications((value) => published.push(value.event_id));
  const staleRecover = vi.fn(() => [event("stale", 1)]);
  publications.defer("stale", correlation, staleRecover, () => true);
  publications.reset();
  const fresh = event("fresh", 1);
  publications.defer("fresh", correlation, () => [fresh], () => true);
  await nextMacrotask();

  expect(staleRecover).not.toHaveBeenCalled();
  expect(published).toEqual(["fresh"]);
});

test("re-deferring a published marker does not schedule another recovery", async () => {
  const publications = new TimelinePublications(() => {});
  publications.publish(first, correlation);
  const recover = vi.fn(() => [first]);
  publications.defer(first.event_id, correlation, recover, () => true);
  await nextMacrotask();

  expect(recover).not.toHaveBeenCalled();
  expect(publications.events()).toEqual([first]);
});
