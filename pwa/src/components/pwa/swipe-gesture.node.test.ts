import { expect, test } from "vitest";
import { beginSwipe, cancelSwipe, finishSwipe, IDLE_SWIPE, moveSwipe, overscrollDistance, projectedCommit, rubberBand, trackedDistance, type SwipeDirection, type SwipeState } from "./swipe-gesture";

const point = (x: number, time: number, y = 0, pointerId = 1) => ({ x, y, time, pointerId });
const start = (direction: SwipeDirection = "right") => beginSwipe(IDLE_SWIPE, point(0, 0), direction, "touch", true);
const release = (points: [number, number][], direction: SwipeDirection = "right") => {
  let state = start(direction);
  for (const [x, time] of points.slice(0, -1)) state = moveSwipe(state, point(x, time));
  const [x, time] = points[points.length - 1];
  return finishSwipe(state, point(x, time));
};

test("only primary touch starts an idle gesture and other pointer IDs are isolated", () => {
  expect(beginSwipe(IDLE_SWIPE, point(0, 0), "right", "mouse", true)).toBe(IDLE_SWIPE);
  expect(beginSwipe(IDLE_SWIPE, point(0, 0), "right", "touch", false)).toBe(IDLE_SWIPE);
  const state = start();
  expect(beginSwipe(state, point(0, 0, 0, 2), "right", "touch", true)).toBe(state);
  expect(moveSwipe(state, point(100, 20, 0, 2))).toBe(state);
  expect(finishSwipe(state, point(100, 20, 0, 2)).state).toBe(state);
});

test.each([[10, 0, "pending"], [0, 20, "rejected"], [20, 15, "rejected"], [15, 10, "rejected"], [-20, 0, "rejected"], [20, 1, "tracking"]])("locks direction once at (%i,%i)", (x, y, phase) => {
  const state = moveSwipe(start(), point(Number(x), 10, Number(y)));
  expect(state.phase).toBe(phase);
  if (phase === "rejected") expect(moveSwipe(state, point(100, 20)).phase).toBe("rejected");
});

test.each(["right", "left"] as const)("distance and flick thresholds are exact for %s", (direction) => {
  const sign = direction === "right" ? 1 : -1;
  expect(release([[72 * sign, 500]], direction).committed).toBe(true);
  expect(release([[71 * sign, 500]], direction).committed).toBe(false);
  expect(release([[32 * sign, 80]], direction).committed).toBe(true);
  expect(release([[31 * sign, 20]], direction).committed).toBe(false);
  expect(release([[32 * sign, 81]], direction).committed).toBe(false);
});

test("release coordinates and time participate in velocity, including pauses", () => {
  expect(release([[15, 20], [32, 80]]).velocity).toBe(0.4);
  expect(release([[40, 40], [40, 250]]).committed).toBe(false);
  expect(release([[72, 40], [72, 250]]).committed).toBe(true);
  expect(release([[40, 40], [40, 250]]).velocity).toBe(0);
});

test("last-window signed velocity rejects reversal and returning to the start", () => {
  const reverse = release([[65, 30], [65, 150], [40, 180]]);
  expect(reverse.velocity).toBeLessThan(0);
  expect(reverse.committed).toBe(false);
  expect(release([[90, 20], [0, 60]]).committed).toBe(false);
  expect(release([[90, 20], [-20, 60]]).committed).toBe(false);
});

test("cancellation is idle and following events cannot commit", () => {
  const state: SwipeState = cancelSwipe();
  expect(state).toEqual(IDLE_SWIPE);
  expect(moveSwipe(state, point(100, 30))).toBe(state);
  expect(finishSwipe(state, point(100, 40)).committed).toBe(false);
});

test.each(["right", "left"] as const)("tracked distance starts at zero on the locking frame for %s", (direction) => {
  const sign = direction === "right" ? 1 : -1;
  let state = start(direction);
  expect(trackedDistance(state, point(8 * sign, 5))).toBe(0);
  state = moveSwipe(state, point(8 * sign, 5));
  expect(trackedDistance(state, point(8 * sign, 5))).toBe(0);
  // 越过 slop 的这一帧锁定方向，面板位移不得从约 10px 起跳。
  const locked = moveSwipe(state, point(14 * sign, 10));
  expect(locked.phase).toBe("tracking");
  expect(trackedDistance(locked, point(14 * sign, 10))).toBe(0);
  expect(trackedDistance(locked, point(64 * sign, 30))).toBe(50);
});

test("tracked distance is clamped at zero when reversing and ignores non-tracking states", () => {
  let state = start();
  state = moveSwipe(state, point(14, 10));
  expect(trackedDistance(state, point(-30, 20))).toBe(0);
  expect(trackedDistance(IDLE_SWIPE, point(50, 20))).toBe(0);
  expect(trackedDistance(moveSwipe(start(), point(0, 10, 20)), point(80, 20))).toBe(0);
});

test("overscroll distance keeps the reverse sign that tracked distance clamps", () => {
  let state = start();
  state = moveSwipe(state, point(14, 10));
  expect(overscrollDistance(state, point(-30, 20))).toBe(-44);
  expect(overscrollDistance(state, point(64, 20))).toBe(50);
  expect(overscrollDistance(IDLE_SWIPE, point(-30, 20))).toBe(0);
});

test("rubber band follows the iOS formula, approaches but never reaches the dimension", () => {
  expect(rubberBand(0, 100)).toBe(0);
  expect(rubberBand(-10, 100)).toBe(0);
  expect(rubberBand(10, 0)).toBe(0);
  expect(rubberBand(100, 100)).toBeCloseTo((1 - 1 / 1.55) * 100, 6);
  expect(rubberBand(20, 100)).toBeLessThan(20);
  expect(rubberBand(1e6, 100)).toBeLessThan(100);
  expect(rubberBand(200, 100)).toBeGreaterThan(rubberBand(100, 100));
});

test("finish reports the tracked release distance", () => {
  expect(release([[14, 10], [90, 200]]).distance).toBe(76);
  expect(release([[14, 10], [4, 200]]).distance).toBe(0);
});

test("down locks on the vertical axis and measures distance and velocity along it", () => {
  const down = () => beginSwipe(IDLE_SWIPE, point(0, 0), "down", "touch", true);
  expect(moveSwipe(down(), point(1, 10, 20)).phase).toBe("tracking");
  expect(moveSwipe(down(), point(20, 10, 1)).phase).toBe("rejected");
  expect(moveSwipe(down(), point(0, 10, -20)).phase).toBe("rejected");
  const locked = moveSwipe(down(), point(0, 10, 14));
  expect(trackedDistance(locked, point(0, 30, 64))).toBe(50);
  const result = finishSwipe(moveSwipe(down(), point(0, 20, 15)), point(0, 80, 32));
  expect(result.velocity).toBe(0.4);
  expect(result.committed).toBe(true);
});

test("projected commit needs the inertial stop to pass half the extent", () => {
  // 静止松手：只看位置是否过半。
  expect(projectedCommit(160, 0, 320)).toBe(true);
  expect(projectedCommit(159, 0, 320)).toBe(false);
  // 0.3px/ms 的松手速度按 0.998 减速率滑行约 150px。
  expect(projectedCommit(20, 0.3, 320)).toBe(true);
  expect(projectedCommit(5, 0.3, 320)).toBe(false);
  // 已过半后反向甩回，停点被拉回起点一侧。
  expect(projectedCommit(300, -0.4, 320)).toBe(false);
  expect(projectedCommit(300, -0.1, 320)).toBe(true);
});

test("projected commit never commits without travel or a measurable extent", () => {
  expect(projectedCommit(0, 5, 320)).toBe(false);
  expect(projectedCommit(200, 1, 0)).toBe(false);
});
