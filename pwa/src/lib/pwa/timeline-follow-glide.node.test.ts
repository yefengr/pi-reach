import { expect, test } from "vitest";
import { FollowGlide, TRANSITION_GLIDE_OMEGA } from "./timeline-follow-glide";

function run(glide: FollowGlide, target: (time: number) => number, from: number, frames: number): number[] {
  const tops: number[] = [];
  for (let frame = 0; frame <= frames; frame += 1) tops.push(glide.advance(from + frame * 16, target(from + frame * 16)).top);
  return tops;
}

test("eases from rest to the target without overshoot and settles exactly", () => {
  const glide = new FollowGlide(0);
  const tops = run(glide, () => 100, 0, 40);
  tops.slice(1).forEach((top, index) => expect(top).toBeGreaterThanOrEqual(tops[index]!));
  expect(Math.max(...tops)).toBe(100);
  expect(tops.at(-1)).toBe(100);
  expect(glide.advance(40 * 16 + 16, 100).settled).toBe(true);
});

test("a target that keeps growing never drops the speed back to rest", () => {
  const glide = new FollowGlide(0);
  // 每 100ms 增加一行（26px），对应流式回复与发送中出现 Working 的情况。
  const tops = run(glide, (time) => 26 * (1 + Math.floor(time / 100)), 0, 60);
  const deltas = tops.slice(1).map((top, index) => top - tops[index]!);
  const moving = deltas.slice(10);
  expect(Math.min(...moving)).toBeGreaterThan(0.5);
  expect(Math.max(...moving)).toBeLessThan(12);
});

test("moves upward as smoothly as downward and applies layout shifts without changing speed", () => {
  const glide = new FollowGlide(200, TRANSITION_GLIDE_OMEGA);
  const tops = run(glide, () => 120, 0, 30);
  tops.slice(1).forEach((top, index) => expect(top).toBeLessThanOrEqual(tops[index]!));
  expect(tops[1]! - 120).toBeGreaterThan(40);
  expect(tops.at(-1)).toBe(120);
  const shifted = new FollowGlide(0);
  shifted.advance(0, 100);
  const before = shifted.advance(16, 100).top;
  shifted.shift(10);
  expect(shifted.advance(16, 100).top).toBe(before + 10);
});
