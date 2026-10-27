import { expect, test, vi } from "vitest";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { TIMELINE_PAGE_SIZE } from "./timeline-history-loader";
import { TimelineLocalPager } from "./timeline-local-pager";

function event(sequence: number): TimelineEvent {
  return { event_id: `event-${sequence}`, event_seq: sequence, message_id: `event-${sequence}`, session_id: "session", leaf_id: "leaf", timestamp: sequence, group_id: "group", kind: "user", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: "self", delivery: "normal", status: "committed" };
}

function fixture(sequences: number[], shown: number) {
  const onPage = vi.fn<(events: TimelineEvent[]) => void>();
  const onState = vi.fn<(state: { hasEarlier: boolean; loading: boolean }) => void>();
  const pager = new TimelineLocalPager({ events: sequences.map(event), shown, onPage, onState });
  const pages = () => onPage.mock.calls.map(([events]) => events.map((item) => item.event_seq));
  return { pager, onPage, onState, pages };
}

test("shows the newest records first and pages earlier ones in fixed-size steps", async () => {
  const sequences = Array.from({ length: 30 + TIMELINE_PAGE_SIZE + 5 }, (_, index) => index + 1);
  const f = fixture(sequences, 30);
  expect(f.pager.initialEvents().map((item) => item.event_seq)).toEqual(sequences.slice(-30));
  expect(f.onState).toHaveBeenLastCalledWith({ hasEarlier: true, loading: false });

  const loading = f.pager.loadEarlier();
  expect(f.onState).toHaveBeenLastCalledWith({ hasEarlier: true, loading: true });
  expect(f.onPage).not.toHaveBeenCalled();
  expect(await loading).toBe(true);
  expect(f.pages()).toEqual([sequences.slice(5, 5 + TIMELINE_PAGE_SIZE)]);
  expect(f.pager.shownCount).toBe(30 + TIMELINE_PAGE_SIZE);

  expect(await f.pager.loadEarlier()).toBe(true);
  expect(f.pages()[1]).toEqual([1, 2, 3, 4, 5]);
  expect(f.pager.hasEarlier).toBe(false);
  expect(f.onState).toHaveBeenLastCalledWith({ hasEarlier: false, loading: false });
  expect(await f.pager.loadEarlier()).toBe(false);
});

test("pages by record count, so a large local gap never produces an empty page", async () => {
  const f = fixture([1, 2, 3, 5000, 5001], 2);
  expect(await f.pager.loadEarlier()).toBe(true);
  expect(f.pages()).toEqual([[1, 2, 3]]);
});

test("restores to the saved expansion and clamps it to the records that exist", () => {
  expect(fixture([1, 2, 3], 2.5).pager.shownCount).toBe(2);
  const all = fixture([1, 2, 3], 50);
  expect(all.pager.shownCount).toBe(3);
  expect(all.pager.hasEarlier).toBe(false);
  expect(fixture([], 30).pager.initialEvents()).toEqual([]);
});

test("ignores overlapping requests and drops a page that arrives after dispose", async () => {
  const sequences = Array.from({ length: 200 }, (_, index) => index + 1);
  const f = fixture(sequences, 30);
  const first = f.pager.loadEarlier();
  expect(await f.pager.loadEarlier()).toBe(false);
  expect(await first).toBe(true);
  expect(f.onPage).toHaveBeenCalledTimes(1);

  const late = f.pager.loadEarlier();
  f.pager.dispose();
  const calls = f.onState.mock.calls.length;
  expect(await late).toBe(false);
  expect(f.onPage).toHaveBeenCalledTimes(1);
  expect(f.onState).toHaveBeenCalledTimes(calls);
});
