import { describe, expect, test, vi } from "vitest";
import { SCROLL_IDLE_MS, ScrollIdleGate } from "./scroll-idle-gate";

function fixture() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const gate = new ScrollIdleGate({
    now: () => now,
    setTimeout(run, ms) { const id = ++next; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  /** 推进时钟并按到期顺序执行定时器。 */
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
  return { gate, advance, get timers() { return timers.size; } };
}

describe("ScrollIdleGate", () => {
  test("runs immediately when nothing has scrolled or touched", () => {
    const f = fixture();
    const run = vi.fn();
    f.gate.defer(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("waits for the scroll stream to go quiet, restarting with each new scroll", () => {
    const f = fixture();
    const run = vi.fn();
    f.gate.scrolled();
    f.gate.defer(run);
    f.advance(SCROLL_IDLE_MS - 50);
    f.gate.scrolled();
    f.advance(60);
    expect(run).not.toHaveBeenCalled();
    f.advance(SCROLL_IDLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("holds while a finger is down and then waits out momentum", () => {
    const f = fixture();
    const run = vi.fn();
    f.gate.touch(true);
    f.gate.defer(run);
    f.advance(SCROLL_IDLE_MS * 3);
    expect(run).not.toHaveBeenCalled();
    f.gate.scrolled();
    f.gate.touch(false);
    expect(run).not.toHaveBeenCalled();
    f.advance(SCROLL_IDLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("cancel and dispose drop the pending work and its timer", () => {
    const f = fixture();
    const cancelled = vi.fn();
    f.gate.scrolled();
    const cancel = f.gate.defer(cancelled);
    cancel();
    expect(f.timers).toBe(0);
    const disposed = vi.fn();
    f.gate.defer(disposed);
    f.gate.dispose();
    f.advance(SCROLL_IDLE_MS * 2);
    expect(cancelled).not.toHaveBeenCalled();
    expect(disposed).not.toHaveBeenCalled();
  });

  test("a newer request replaces the older one and a stale cancel does not drop it", () => {
    const f = fixture();
    const older = vi.fn();
    const newer = vi.fn();
    f.gate.touch(true);
    const cancelOlder = f.gate.defer(older);
    f.gate.defer(newer);
    cancelOlder();
    f.gate.touch(false);
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });
});
