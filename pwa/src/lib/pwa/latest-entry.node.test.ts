import { expect, test, vi } from "vitest";
import { LatestEntryVisibility } from "./latest-entry";
import { SCROLL_IDLE_MS } from "./scroll-idle-gate";

function fixture() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const changed = vi.fn<(visible: boolean) => void>();
  const entry = new LatestEntryVisibility({
    now: () => now,
    setTimeout(run, ms) { const id = ++next; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, changed);
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = target;
  };
  const visible = () => changed.mock.calls.at(-1)?.[0] ?? false;
  return { entry, changed, advance, visible };
}

const SCREEN = 600;

test("stays hidden while the reader is within one screen of the bottom", () => {
  const f = fixture();
  for (const distance of [40, 300, SCREEN]) f.entry.scrolled(distance, SCREEN);
  f.advance(SCROLL_IDLE_MS * 3);
  expect(f.changed).not.toHaveBeenCalled();
});

test("appears only after scrolling beyond one screen settles", () => {
  const f = fixture();
  f.entry.scrolled(SCREEN + 1, SCREEN);
  f.advance(SCROLL_IDLE_MS - 50);
  f.entry.scrolled(SCREEN * 2, SCREEN);
  f.advance(SCROLL_IDLE_MS - 50);
  expect(f.visible()).toBe(false);
  f.advance(60);
  expect(f.visible()).toBe(true);
  expect(f.changed).toHaveBeenCalledTimes(1);
});

test("waits for the finger to lift and keeps showing while the reader scrolls further", () => {
  const f = fixture();
  f.entry.touch(true);
  f.entry.scrolled(SCREEN * 3, SCREEN);
  f.advance(SCROLL_IDLE_MS * 3);
  expect(f.visible()).toBe(false);
  f.entry.touch(false);
  f.advance(SCROLL_IDLE_MS);
  expect(f.visible()).toBe(true);

  f.entry.touch(true);
  f.entry.scrolled(SCREEN * 4, SCREEN);
  expect(f.changed).toHaveBeenCalledTimes(1);
});

test("hides at once when the reader comes back within one screen, even mid-scroll", () => {
  const f = fixture();
  f.entry.scrolled(SCREEN * 2, SCREEN);
  f.advance(SCROLL_IDLE_MS);
  expect(f.visible()).toBe(true);
  f.entry.touch(true);
  f.entry.scrolled(SCREEN - 10, SCREEN);
  expect(f.visible()).toBe(false);

  // 等待中回到一屏以内：撤销等待，之后不再显示。
  f.entry.touch(false);
  f.entry.scrolled(SCREEN * 2, SCREEN);
  f.entry.scrolled(100, SCREEN);
  f.advance(SCROLL_IDLE_MS * 2);
  expect(f.visible()).toBe(false);
});

test("hide and dispose drop a pending appearance", () => {
  const f = fixture();
  f.entry.scrolled(SCREEN * 2, SCREEN);
  f.entry.hide();
  f.advance(SCROLL_IDLE_MS * 2);
  expect(f.changed).not.toHaveBeenCalled();

  f.entry.scrolled(SCREEN * 2, SCREEN);
  f.entry.dispose();
  f.advance(SCROLL_IDLE_MS * 2);
  expect(f.changed).not.toHaveBeenCalled();
});
