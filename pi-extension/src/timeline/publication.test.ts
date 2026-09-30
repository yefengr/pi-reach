import { expect, test, vi } from "vitest";
import type { TimelineEvent } from "../protocol/v2/index.js";
import { TimelinePublications } from "./publication.js";

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
