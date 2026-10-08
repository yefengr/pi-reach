import { expect, test } from "vitest";
import { beginSwipe, cancelSwipe, finishSwipe, IDLE_SWIPE, moveSwipe, trackedDistance, type SwipeDirection, type SwipeState } from "./swipe-gesture";

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

test("finish reports the tracked release distance", () => {
  expect(release([[14, 10], [90, 200]]).distance).toBe(76);
  expect(release([[14, 10], [4, 200]]).distance).toBe(0);
});

test("reversed is set only when the release velocity flicks back past the threshold", () => {
  // 已越过提交阈值后迅速甩回：触发式判定不变，跟手模式靠 reversed 回弹。
  const back = release([[90, 20], [60, 160], [20, 200]]);
  expect(back.reversed).toBe(true);
  expect(release([[90, 20], [88, 60], [86, 140]]).reversed).toBe(false);
  expect(release([[90, 20], [100, 60]]).reversed).toBe(false);
  expect(release([[90, 20], [90, 140]]).reversed).toBe(false);
});
