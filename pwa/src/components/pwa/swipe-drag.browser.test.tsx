import { afterEach, beforeEach, expect, test } from "vitest";
import { pwaRedirectEasing, pwaReleaseEasing, pwaSpringProgress } from "@/lib/ui/motion";
import { createSwipeDrag, type SwipeDrag } from "./swipe-drag";

const EASE = "cubic-bezier(0.1, 0.2, 0.3, 1)";
let host: HTMLElement;
let panel: HTMLElement;
let scrim: HTMLElement;
let drag: SwipeDrag | undefined;

const frame = (progress: number): Keyframe => ({ transform: `translateX(${progress * 200}px)` });
const create = (toEndDuration = 120, backDuration = toEndDuration) => {
  drag = createSwipeDrag({
    targets: [{ element: panel, frame }, { element: scrim, frame: (progress) => ({ opacity: 1 - progress }) }],
    extent: () => 200,
    duration: (toEnd) => toEnd ? toEndDuration : backDuration,
  });
  return drag;
};

beforeEach(() => {
  document.documentElement.style.setProperty("--pwa-ease-content", EASE);
  host = document.body.appendChild(document.createElement("div"));
  panel = host.appendChild(document.createElement("div"));
  scrim = host.appendChild(document.createElement("div"));
});
afterEach(() => {
  drag?.dispose();
  drag = undefined;
  host.remove();
  document.documentElement.style.removeProperty("--pwa-ease-content");
});

const samples = (easing: string) => easing.replace(/^linear\(|\)$/g, "").split(",").map(Number);

test("release easing carries the finger velocity without overshoot and matches the content curve at rest", () => {
  expect(pwaReleaseEasing(panel, 0, 350)).toBe(EASE);
  const slow = samples(pwaReleaseEasing(panel, 0.002, 350));
  const fast = samples(pwaReleaseEasing(panel, 0.01, 350));
  const capped = samples(pwaReleaseEasing(panel, 1, 350));
  for (const curve of [slow, fast, capped]) {
    expect(curve).toHaveLength(33);
    expect(curve[0]).toBe(0);
    expect(curve.at(-1)).toBe(1);
    // 单调且不越过终点：面板不会冲出边缘再弹回。
    curve.forEach((value, index) => { if (index > 0) expect(value).toBeGreaterThanOrEqual(curve[index - 1]); });
    expect(Math.max(...curve)).toBeLessThanOrEqual(1);
  }
  // 松手越快，前段走得越远。
  expect(fast[1]).toBeGreaterThan(slow[1]);
  expect(capped[1]).toBeGreaterThanOrEqual(fast[1]);
});

test("redirect easing keeps a reverse velocity: it first moves away, then turns without a stop, within the allowed room", () => {
  expect(pwaRedirectEasing(panel, 0, 280, 1)).toBe(EASE);
  const room = 0.05;
  const curve = samples(pwaRedirectEasing(panel, -0.01, 280, room));
  expect(curve).toHaveLength(33);
  expect(curve[0]).toBe(0);
  expect(curve.at(-1)).toBe(1);
  // 先背离终点（进度为负），越过起点的幅度不超过 room，之后单调走向终点。
  expect(curve[1]).toBeLessThan(0);
  expect(Math.min(...curve)).toBeGreaterThanOrEqual(-room - 0.001);
  const turn = curve.indexOf(Math.min(...curve));
  curve.slice(turn).forEach((value, index, rest) => { if (index > 0) expect(value).toBeGreaterThanOrEqual(rest[index - 1]); });
  // 没有余地时背离速度被压到零，曲线不越过起点。
  expect(Math.min(...samples(pwaRedirectEasing(panel, -0.01, 280, 0)))).toBeGreaterThanOrEqual(0);
  // 朝向终点的速度与松手曲线一致。
  expect(pwaRedirectEasing(panel, 0.004, 280, room)).toBe(pwaReleaseEasing(panel, 0.004, 280));
});

test("spring progress matches the normalized content spring and ends exactly at one", () => {
  expect(pwaSpringProgress(0)).toBe(0);
  expect(pwaSpringProgress(-1)).toBe(0);
  expect(pwaSpringProgress(1)).toBe(1);
  expect(pwaSpringProgress(2)).toBe(1);
  // 与内容曲线同族：约六成时长完成九成。
  expect(pwaSpringProgress(0.6)).toBeGreaterThan(0.88);
  expect(pwaSpringProgress(0.6)).toBeLessThan(0.93);
  expect(pwaSpringProgress(0.1)).toBeLessThan(pwaSpringProgress(0.2));
});

test("settle keeps the token duration for its direction instead of shortening it by distance or velocity", () => {
  const swipe = create(350, 450);
  swipe.setDistance(190);
  void swipe.settle(true, 3);
  const forward = panel.getAnimations()[0];
  expect(forward.effect?.getTiming().duration).toBe(350);
  expect(String(forward.effect?.getTiming().easing)).toMatch(/^linear\(/);
  void swipe.settle(false);
  const back = panel.getAnimations()[0];
  expect(back.effect?.getTiming().duration).toBe(450);
  expect(back.effect?.getTiming().easing).toBe(EASE);
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

test("settle uses the computed content easing instead of var() and keeps the final frame", async () => {
  const swipe = create();
  swipe.setDistance(80);
  const finished = swipe.settle(true);
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
