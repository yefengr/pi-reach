import { afterEach, beforeEach, expect, test } from "vitest";
import { createSwipeDrag, settleDuration, type SwipeDrag } from "./swipe-drag";

const EASE = "cubic-bezier(0.1, 0.2, 0.3, 1)";
let host: HTMLElement;
let panel: HTMLElement;
let scrim: HTMLElement;
let drag: SwipeDrag | undefined;

const frame = (progress: number): Keyframe => ({ transform: `translateX(${progress * 200}px)` });
const create = (full = 120) => {
  drag = createSwipeDrag({
    targets: [{ element: panel, frame }, { element: scrim, frame: (progress) => ({ opacity: 1 - progress }) }],
    extent: () => 200,
    duration: () => full,
  });
  return drag;
};

beforeEach(() => {
  document.documentElement.style.setProperty("--pwa-ease-standard", EASE);
  host = document.body.appendChild(document.createElement("div"));
  panel = host.appendChild(document.createElement("div"));
  scrim = host.appendChild(document.createElement("div"));
});
afterEach(() => {
  drag?.dispose();
  drag = undefined;
  host.remove();
  document.documentElement.style.removeProperty("--pwa-ease-standard");
});

test("settleDuration scales with remaining distance and clamps to 80ms and the full duration", () => {
  expect(settleDuration(100, 1, 200)).toBe(100);
  expect(settleDuration(10, 2, 200)).toBe(80);
  expect(settleDuration(300, 0.1, 200)).toBe(200);
  expect(settleDuration(60, 0, 200)).toBe(200);
  expect(settleDuration(20, 0, 200)).toBe(80);
  // 全程 token 比下限更短时以全程为准，减少动态效果的 0ms 不被撑长。
  expect(settleDuration(100, 1, 0)).toBe(0);
});

test("setDistance drives paused linear animations by progress and clamps to the extent", () => {
  const swipe = create();
  const animation = panel.getAnimations()[0];
  expect(animation.playState).toBe("paused");
  expect(animation.effect?.getTiming().easing).toBe("linear");
  swipe.setDistance(50);
  expect(Math.round(panel.getBoundingClientRect().left - host.getBoundingClientRect().left)).toBe(50);
  expect(Number(getComputedStyle(scrim).opacity)).toBeCloseTo(0.75, 2);
  swipe.setDistance(900);
  expect(swipe.progress()).toBe(1);
  swipe.setDistance(-20);
  expect(swipe.progress()).toBe(0);
});

test("settle uses the computed standard easing instead of var() and keeps the final frame", async () => {
  const swipe = create();
  swipe.setDistance(80);
  const finished = swipe.settle(true, 1);
  const settling = panel.getAnimations()[0];
  expect(settling.effect?.getTiming().easing).toBe(EASE);
  expect(swipe.settling()).toBe(true);
  expect(await finished).toBe(true);
  expect(swipe.progress()).toBe(1);
  expect(getComputedStyle(panel).transform).toBe("matrix(1, 0, 0, 1, 200, 0)");
  expect(Number(getComputedStyle(scrim).opacity)).toBe(0);
  swipe.dispose();
  expect(getComputedStyle(panel).transform).toBe("none");
});

test("settle back returns to the start and a new settle aborts the previous one from the current position", async () => {
  const swipe = create(400);
  swipe.setDistance(100);
  const first = swipe.settle(false, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const midway = swipe.progress();
  expect(midway).toBeLessThan(0.5);
  const second = swipe.settle(true, 1);
  expect(await first).toBe(false);
  // 续播不得跳回起点或终点：新一轮从被中止时的位置起步。
  expect(Math.abs(swipe.progress() - midway)).toBeLessThan(0.15);
  expect(await second).toBe(true);
  expect(swipe.progress()).toBe(1);
});

test("dispose aborts a running settle with false and removes every animation", async () => {
  const swipe = create(400);
  swipe.setDistance(20);
  const pending = swipe.settle(true, 0);
  swipe.dispose();
  expect(await pending).toBe(false);
  expect(panel.getAnimations()).toHaveLength(0);
  expect(scrim.getAnimations()).toHaveLength(0);
  expect(await swipe.settle(true)).toBe(false);
});

test("setDistance after settling started is ignored", async () => {
  const swipe = create();
  swipe.setDistance(40);
  const done = swipe.settle(true, 1);
  swipe.setDistance(0);
  expect(await done).toBe(true);
  expect(swipe.progress()).toBe(1);
});
