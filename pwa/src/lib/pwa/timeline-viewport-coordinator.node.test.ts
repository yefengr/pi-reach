import { describe, expect, test } from "vitest";
import { TimelineViewportCoordinator, type ViewportLayout, type ViewportMotion, type ViewportTrace } from "./timeline-viewport-coordinator";

function fixture(trace?: (entry: ViewportTrace) => void, tracing = () => true) {
  let top = 0;
  let bottom = 100;
  let animate = true;
  let tailSpace = 0;
  let finishes = 0;
  let starts = 0;
  let advances = 0;
  let measures = 0;
  let now = 0;
  const samples: number[] = [];
  let reenter: (() => void) | null = null;
  let anchorAvailable = true;
  let anchorShift = 0;
  let finishShift = 0;
  const restored: number[] = [];
  const activityOrigins: number[] = [];
  const writes: number[] = [];
  const frames = new Map<number, (now: number) => void>();
  const late: ((now: number) => void)[] = [];
  let next = 0;
  const motion = (target = () => bottom): ViewportMotion => {
    starts += 1;
    let start: number | null = null;
    return { advance(now) { advances += 1; samples.push(now); start ??= now; return { top: (top + target()) / 2, finished: now - start >= 160 }; }, finish() { finishes += 1; anchorShift += finishShift; } };
  };
  const layout: ViewportLayout<number, number> = {
    measure: () => { measures += 1; return { top, bottom, height: bottom + 50, animate, tailSpace, compensation: 0 }; }, top: () => top,
    scroll(value) { writes.push(value); top = Math.min(bottom, value); reenter?.(); },
    captureSend: () => top, send: () => motion(), activity: (from, target) => {
      activityOrigins.push(from); return motion(() => target(layout.measure()));
    },
    captureAnchor: () => top - anchorShift, restoreAnchor: (anchor) => {
      if (!anchorAvailable) return false;
      restored.push(anchor); top = Math.min(bottom, anchor + anchorShift); reenter?.(); return true;
    },
  };
  const core = new TimelineViewportCoordinator({ now: () => now,
    request(callback) { const id = ++next; frames.set(id, callback); late.push(callback); return id; },
    cancel(id) { frames.delete(id); },
  }, () => {}, trace, tracing);
  core.bind(layout);
  return { core, layout, writes, frames, late, restored, activityOrigins, samples,
    setNow(value: number) { now = value; },
    setAnchorAvailable(value: boolean) { anchorAvailable = value; },
    shiftAnchor(value: number) { anchorShift = value; },
    shiftOnFinish(value: number) { finishShift = value; },
    step(value = now) { now = value; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(now)); },
    setBottom(value: number) { bottom = value; }, setTop(value: number) { top = value; },
    setTailSpace(value: number) { tailSpace = value; },
    reduce() { animate = false; }, allowMotion() { animate = true; }, reenter(callback: () => void) { reenter = callback; },
    get finishes() { return finishes; }, get starts() { return starts; }, get advances() { return advances; },
    get measures() { return measures; },
  };
}

describe("TimelineViewportCoordinator", () => {
  test("activity borrows tail space and native logical-target receipts never end following", () => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(156); f.core.notify("activity");
    expect(f.layout.top()).toBe(100);
    expect(f.starts).toBe(0);
    for (let i = 0; i < 3; i++) f.core.scroll(false);
    expect(f.core.state.following).toBe(true);
    f.core.notify("commit"); f.core.notify("geometry");
    f.core.output("reply"); f.step(200);
    expect(f.layout.top()).toBe(100);
    f.setBottom(196); f.core.notify("commit");
    expect(f.layout.top()).toBe(140);
    f.setTop(120); f.core.scroll(false);
    expect(f.core.state.following).toBe(false);
  });

  test.each([2, 8, 20])("scrolling down %ipx into borrowed space preserves follow without snapping back", (distance) => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(156); f.core.notify("activity");
    f.setTop(100 + distance); f.core.scroll(false);
    expect(f.core.state.following).toBe(true);
    f.core.notify("commit");
    expect(f.layout.top()).toBe(100 + distance);
    f.setTop(96 + distance); f.core.scroll(false);
    expect(f.core.state.following).toBe(false);
  });

  test("Reduced Motion Latest is ready for activity before another content commit", () => {
    const f = fixture();
    f.setTailSpace(80); f.reduce(); f.core.latest();
    expect(f.layout.top()).toBe(100);
    f.core.scroll(true);
    f.setBottom(156); f.core.notify("activity");
    expect(f.layout.top()).toBe(100);
    expect(f.core.state.following).toBe(true);
    expect(f.starts).toBe(0);
    f.core.notify("commit");
    expect(f.layout.top()).toBe(100);
  });

  test("activity scrolls only the deficit and keeps its effective target through handoff", () => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(300); f.core.notify("activity");
    expect(f.starts).toBe(1);
    expect(f.layout.top()).toBe(160);
    f.step(160); f.step(200);
    expect(f.layout.top()).toBe(220);
    expect(f.finishes).toBe(1);
    f.core.scroll(false); f.core.scroll(false);
    expect(f.core.state.following).toBe(true);
    expect(f.frames.size).toBe(0);
  });

  test.each(["details", "hidden", "reduce", "viewport-resize"] as const)("%s preserves borrowed space and rejects stale work", (action) => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(156); f.core.notify("activity");
    if (action === "details") { f.core.details(true); f.core.details(false); }
    else { if (action === "reduce") f.reduce(); f.core.settle(action); }
    f.step(200); f.core.notify("commit");
    expect(f.layout.top()).toBe(100);
    expect(f.core.state.following).toBe(true);
  });

  test.each(["latest", "reset", "send", "rebind"] as const)("%s clears old tail credit", (action) => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(156); f.core.notify("activity");
    if (action === "latest") { f.reduce(); f.core.latest(); }
    else if (action === "reset") f.core.reset();
    else if (action === "send") f.core.followOwnSend(f.core.captureOwnSend());
    else f.core.bind({ ...f.layout });
    f.core.notify("commit"); f.step(200); f.step(400);
    expect(f.layout.top()).toBe(156);
    expect(f.core.state.following).toBe(true);
  });

  test("net content shrink returns borrowed space before moving the existing body downward", () => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(156); f.core.notify("activity");
    f.setBottom(144); f.core.notify("commit");
    expect(f.layout.top()).toBe(100);
    f.core.notify("geometry"); f.core.scroll(false);
    expect(f.layout.top()).toBe(100);
    expect(f.core.state.following).toBe(true);
    f.setBottom(180); f.core.notify("commit");
    expect(f.layout.top()).toBe(136);
  });

  test("a smaller current tail budget clamps credit permanently, without borrowing it again", () => {
    const f = fixture();
    f.setTailSpace(80); f.core.notify("commit");
    f.setBottom(156); f.core.notify("activity");
    f.setTailSpace(0); f.core.settle("viewport-resize");
    expect(f.layout.top()).toBe(156);
    f.setTailSpace(80); f.core.notify("geometry");
    expect(f.layout.top()).toBe(156);
  });

  test("capture is readonly; only successful activation starts motion", () => {
    const f = fixture();
    f.core.userRead();
    const capture = f.core.captureOwnSend();
    expect(f.core.state.following).toBe(false);
    expect(f.starts).toBe(0);
    expect(f.writes).toEqual([]);
    f.core.followOwnSend(capture);
    expect(f.core.state.mode).toBe("send");
    expect(f.frames.size).toBe(1);
    expect(f.core.state.following).toBe(true);
  });

  test.each(["commit", "frame"] as const)("send defers its first sample until %s, including no new items fallback", (first) => {
    const f = fixture();
    f.core.followOwnSend(f.core.captureOwnSend());
    expect(f.advances).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.frames.size).toBe(1);
    if (first === "commit") f.core.notify("commit");
    else f.step(20);
    expect(f.advances).toBe(1);
    expect(f.frames.size).toBe(1);
  });

  test.each(["commit", "geometry", "activity"] as const)("%s initializes motion time; synchronous notices only refresh layout", (first) => {
    const f = fixture();
    f.core.notify("commit");
    f.setNow(20);
    if (first !== "activity") f.core.followOwnSend(f.core.captureOwnSend());
    f.setBottom(150);
    f.setNow(36); f.core.notify(first);
    f.setNow(52); f.core.notify("commit");
    f.setNow(68); f.core.notify("geometry");
    expect(f.samples).toEqual([36, 36, 36]);
    expect(f.starts).toBe(1);
    expect(f.frames.size).toBe(1);
    f.step(76);
    f.setBottom(200);
    f.setNow(92); f.core.notify("activity");
    f.setNow(108); f.core.notify("commit");
    expect(f.samples.slice(-3)).toEqual([76, 76, 76]);
    expect(f.starts).toBe(1);
    f.step(196);
    expect(f.finishes).toBe(1);
    expect(f.layout.top()).toBe(200);
    f.step(212);
    expect(f.frames.size).toBe(0);
  });

  test("a send without a commit initializes on RAF and retains that time for later geometry", () => {
    const f = fixture();
    f.setNow(20); f.core.followOwnSend(f.core.captureOwnSend());
    expect(f.samples).toEqual([]);
    f.step(50);
    f.setNow(66); f.core.notify("geometry");
    expect(f.samples).toEqual([50, 50]);
    f.step(210);
    expect(f.finishes).toBe(1);
  });

  test("a frame timestamp before synchronous initialization cannot move motion time backward", () => {
    const f = fixture();
    f.setNow(100); f.core.followOwnSend(f.core.captureOwnSend()); f.core.notify("commit");
    f.step(96);
    f.step(116);
    f.setNow(132); f.core.notify("geometry");
    expect(f.samples).toEqual([100, 100, 116, 116]);
    f.step(260);
    expect(f.finishes).toBe(1);
  });

  test("a consecutive send starts a new motion time rather than inheriting the prior frame", () => {
    const f = fixture();
    f.setNow(100); f.core.followOwnSend(f.core.captureOwnSend()); f.core.notify("commit");
    f.step(140);
    const stale = [...f.frames.values()];
    f.setNow(200); f.core.followOwnSend(f.core.captureOwnSend());
    f.setNow(216); f.core.notify("commit");
    expect(f.samples.at(-1)).toBe(216);
    const count = f.samples.length;
    stale.forEach(callback => callback(999));
    expect(f.samples).toHaveLength(count);
    f.step(376);
    expect(f.finishes).toBe(2);
  });

  test.each(["input", "user", "details", "reset", "replace", "unmount", "reduce", "hidden", "viewport-resize"] as const)("%s discards the old motion time and rejects its late frames", (exit) => {
    const f = fixture();
    f.setNow(100); f.core.followOwnSend(f.core.captureOwnSend()); f.core.notify("commit");
    f.step(140);
    const stale = [...f.frames.values()];
    if (exit === "input") f.core.input();
    else if (exit === "user") f.core.userRead();
    else if (exit === "details") f.core.details(true);
    else if (exit === "reset") f.core.reset();
    else if (exit === "replace" || exit === "unmount") f.core.bind(exit === "replace" ? { ...f.layout } : null);
    else { if (exit === "reduce") f.reduce(); f.core.settle(exit); }
    f.core.bind(f.layout); f.allowMotion();
    f.setNow(500); f.core.followOwnSend(f.core.captureOwnSend()); f.core.notify("commit");
    expect(f.samples.at(-1)).toBe(500);
    const count = f.samples.length;
    stale.forEach(callback => callback(999));
    expect(f.samples).toHaveLength(count);
    f.setNow(516); f.core.notify("geometry");
    expect(f.samples.at(-1)).toBe(500);
    f.step(660);
    expect(f.core.state.mode).toBe("idle");
    f.step(676);
    f.setBottom(150); f.setNow(800); f.core.notify("activity");
    expect(f.samples.at(-1)).toBe(800);
    expect(f.core.state.mode).toBe("activity");
  });

  test.each([false, true])("anchor receipt keeps paused follow through asynchronous scroll (sync=%s)", (sync) => {
    const f = fixture();
    f.core.notify("commit"); f.core.scroll(true);
    f.core.details(true);
    f.shiftAnchor(80); f.setBottom(300);
    if (sync) f.reenter(() => f.core.scroll(false));
    f.core.notify("geometry");
    expect(f.layout.top()).toBe(180);
    f.core.scroll(false);
    expect(f.core.state).toMatchObject({ following: true, paused: true });
    f.core.details(false);
    expect(f.frames.size).toBe(1);
    f.step();
    expect(f.layout.top()).toBe(300);
  });

  test("anchor receipt does not swallow a different user position or resume an existing reader", () => {
    const f = fixture();
    f.core.notify("commit"); f.core.scroll(true); f.core.details(true);
    f.shiftAnchor(80); f.setBottom(300); f.core.notify("geometry");
    f.setTop(150); f.core.scroll(false);
    expect(f.core.state.following).toBe(false);
    f.shiftAnchor(100); f.core.notify("geometry"); f.core.scroll(false);
    f.core.details(false);
    expect(f.core.state.following).toBe(false);
    expect(f.frames.size).toBe(0);
  });

  test("failed anchor restore never fabricates a receipt at an unchanged top", () => {
    const f = fixture();
    f.core.notify("commit"); f.core.scroll(true); f.core.details(true);
    // 先交付 details 进入时成功恢复的回执，再单独验证失败恢复没有伪造新回执。
    f.core.scroll(false);
    expect(f.core.state.following).toBe(true);
    f.setAnchorAvailable(false); f.setBottom(300); f.core.notify("geometry");
    f.core.scroll(false);
    expect(f.core.state.following).toBe(false);
  });

  test("anchor receipt uses the accepted clamped landing", () => {
    const f = fixture();
    f.core.notify("commit"); f.core.scroll(true); f.core.details(true);
    f.shiftAnchor(500); f.setBottom(300); f.core.notify("geometry");
    expect(f.layout.top()).toBe(300);
    f.core.scroll(false);
    expect(f.core.state).toMatchObject({ following: true, paused: true });
  });

  test("exit preserve records the accepted landing after motion cleanup", () => {
    const f = fixture();
    f.core.notify("commit"); f.core.scroll(true);
    f.core.followOwnSend(f.core.captureOwnSend()); f.core.notify("commit");
    const before = f.layout.top();
    f.setBottom(400); f.shiftOnFinish(80);
    f.core.details(true);
    expect(f.layout.top()).toBe(before + 80);
    f.core.scroll(false);
    expect(f.core.state).toMatchObject({ following: true, paused: true });
    f.core.details(false); f.step();
    expect(f.layout.top()).toBe(400);
  });

  test.each([false, true])("pending scope anchor receipt survives native landing (sync=%s)", (sync) => {
    const f = fixture();
    f.core.restorePosition({ following: false, anchor: 65 });
    if (sync) f.reenter(() => f.core.scroll(false));
    f.core.notify("commit"); f.core.scroll(false);
    expect(f.layout.top()).toBe(65);
    expect(f.core.state.following).toBe(false);
    expect(f.frames.size).toBe(0);
  });

  test("same-height next draft releases owner and guarantees follow without RO", () => {
    const f = fixture();
    f.core.followOwnSend(f.core.captureOwnSend());
    f.core.input();
    expect(f.finishes).toBe(1);
    f.step();
    expect(f.writes.at(-1)).toBe(150);
    expect(f.core.state.mode).toBe("follow");
  });

  test.each(["commit-first", "activity-first"])("activity/content %s uses final net geometry", (order) => {
    const f = fixture();
    f.core.notify("commit");
    // 同次 React 提交的所有 mutation 已完成：等高替换没有中间的 Working 高度。
    f.setBottom(100);
    if (order === "activity-first") f.core.notify("activity");
    f.core.notify("commit");
    if (order === "commit-first") f.core.notify("activity");
    f.step();
    expect(f.starts).toBe(0);
    expect(f.writes).toEqual([150]);
  });

  test("activity starts synchronously without a parent commit and keeps one clock", () => {
    const f = fixture();
    f.core.notify("commit");
    f.setBottom(150);
    f.core.notify("activity");
    expect(f.starts).toBe(1);
    expect(f.advances).toBe(1);
    expect(f.core.state.mode).toBe("activity");
    f.core.notify("commit");
    f.core.notify("geometry");
    expect(f.starts).toBe(1);
    expect(f.frames.size).toBe(1);
  });

  test.each([false, true])("activity removal retains the pre-clamp origin after Latest=%s", (latest) => {
    const f = fixture();
    f.core.notify("commit");
    if (latest) { f.core.latest(); f.core.scroll(true); f.step(); }
    f.setBottom(50);
    f.setTop(50);
    f.core.notify("activity");
    expect(f.activityOrigins).toEqual([100]);
    expect(f.advances).toBe(1);
    expect(f.frames.size).toBe(1);
  });

  test("reduced activity corrects its bottom synchronously", () => {
    const f = fixture();
    f.core.notify("commit");
    f.reduce();
    f.setBottom(150);
    f.core.notify("activity");
    expect(f.writes.at(-1)).toBe(200);
    expect(f.starts).toBe(0);
    expect(f.frames.size).toBe(0);
  });

  test("pending scope anchor survives empty and temporary bottom scrolls until history arrives", () => {
    const f = fixture();
    f.core.reset();
    f.setAnchorAvailable(false);
    f.core.restorePosition({ following: false, anchor: 65 });
    f.core.notify("commit", false);
    f.core.scroll(true);
    f.core.notify("commit");
    f.core.scroll(true);
    f.core.scroll(true);
    f.setAnchorAvailable(true);
    f.core.notify("commit");
    expect(f.restored).toContain(65);
    expect(f.layout.top()).toBe(65);
    expect(f.core.state.following).toBe(false);
  });

  test.each(["reset", "latest", "send", "user"])("%s discards a pending scope anchor", (event) => {
    const f = fixture();
    f.setAnchorAvailable(false);
    f.core.restorePosition({ following: false, anchor: 65 });
    if (event === "reset") f.core.reset();
    else if (event === "latest") f.core.latest();
    else if (event === "send") f.core.followOwnSend(f.core.captureOwnSend());
    else f.core.userRead();
    f.setAnchorAvailable(true);
    f.core.notify("commit");
    expect(f.restored).not.toContain(65);
  });

  test("send absorbs Working without restarting and cleans up before handoff", () => {
    const f = fixture();
    f.core.followOwnSend(f.core.captureOwnSend());
    f.setBottom(170);
    f.core.notify("activity");
    f.core.notify("commit");
    expect(f.starts).toBe(1);
    f.step(200);
    expect(f.finishes).toBe(1);
    f.step(201);
    expect(f.writes.at(-1)).toBe(220);
  });

  test("details closing never overrides a user reading intent; explicit Latest does", () => {
    const f = fixture();
    f.core.details(true);
    f.core.userRead();
    f.core.details(false);
    expect(f.core.state.following).toBe(false);
    f.core.details(true);
    f.core.latest();
    expect(f.core.state.paused).toBe(false);
    expect(f.core.state.following).toBe(true);
  });

  test("reset cancels Latest and late callbacks cannot write", () => {
    const f = fixture();
    f.core.latest();
    f.core.reset();
    const count = f.writes.length;
    f.late.forEach((callback) => callback(200));
    expect(f.writes).toHaveLength(count);
    expect(f.core.state.mode).toBe("idle");
  });

  test.each(["reset", "replace", "unmount"])("%s invalidates capture and old frames", (event) => {
    const f = fixture();
    const capture = f.core.captureOwnSend();
    f.core.output("x");
    if (event === "reset") f.core.reset();
    else f.core.bind(event === "replace" ? { ...f.layout } : null);
    f.core.followOwnSend(capture);
    const count = f.writes.length;
    f.late.forEach((callback) => callback(200));
    expect(f.starts).toBe(0);
    expect(f.writes).toHaveLength(count);
  });

  test("continuous sends release previous motion and invalidate first capture", () => {
    const f = fixture();
    const first = f.core.captureOwnSend();
    f.core.followOwnSend(first);
    f.core.followOwnSend(f.core.captureOwnSend());
    f.core.followOwnSend(first);
    expect(f.starts).toBe(2);
    expect(f.finishes).toBe(1);
    expect(f.frames.size).toBe(1);
  });

  test.each(["reduce", "hidden"])("%s settles and user cancellation rejects late frames", (event) => {
    const f = fixture();
    f.core.followOwnSend(f.core.captureOwnSend());
    if (event === "reduce") f.reduce();
    f.core.settle();
    expect(f.finishes).toBe(1);
    expect(f.writes.at(-1)).toBe(150);
    f.core.userRead();
    const count = f.writes.length;
    f.late.forEach((callback) => callback(200));
    expect(f.writes).toHaveLength(count);
  });

  test("synchronous reentry merges work, never recursively advances", () => {
    const f = fixture();
    f.reenter(() => f.core.notify("geometry"));
    f.core.followOwnSend(f.core.captureOwnSend());
    f.core.notify("commit");
    expect(f.advances).toBe(1);
    expect(f.frames.size).toBe(1);
    f.step(80);
    expect(f.advances).toBe(2);
    expect(f.frames.size).toBe(1);
  });

  test("diagnostic reading samples are enable-gated and retain lifecycle sources", () => {
    const entries: ViewportTrace[] = [];
    let enabled = false;
    const f = fixture((entry) => entries.push(entry), () => enabled);
    f.core.userRead();
    f.core.notify("geometry");
    expect(f.measures).toBe(0);
    expect(entries).toEqual([]);
    enabled = true;
    f.core.notify("geometry");
    expect(entries.at(-1)).toMatchObject({ reason: "geometry", following: false });
    expect(f.measures).toBe(1);
    for (const reason of ["hidden", "reduce", "viewport-resize"] as const) {
      f.core.settle(reason);
      expect(entries.at(-1)?.reason).toBe(reason);
    }
  });

  test("receipt uses accepted clamped top; ordinary body output never creates motion", () => {
    const f = fixture();
    f.core.notify("commit");
    f.core.scroll(true);
    expect(f.core.state.following).toBe(true);
    f.setBottom(220);
    f.core.notify("commit");
    expect(f.starts).toBe(0);
    expect(f.writes.at(-1)).toBe(270);
  });
});
