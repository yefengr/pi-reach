import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { KeyboardClosingMotion } from "./keyboard-closing-motion";

let now = 0;
let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  now = nextFrame = 0;
  frames = new Map();
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("getComputedStyle", () => ({ height: "470px", getPropertyValue: () => "250ms" }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function frame(time: number) {
  now = time;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(now));
}

function fixture() {
  const values = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const shell = { dataset, toggleAttribute: vi.fn(), querySelector: () => null,
    style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) },
  } as unknown as HTMLElement;
  const ended = vi.fn();
  const density = vi.fn();
  const motion = new KeyboardClosingMotion(shell, density, ended, vi.fn());
  return { motion, values, ended, density, dataset };
}

test("freezes intent credit at growth, excluding the blocked task before first paint", () => {
  const f = fixture();
  f.motion.intend();
  frame(20);
  now = 80;
  expect(f.motion.active).toBe(false);
  expect(f.values.size).toBe(0);
  f.motion.move(812, false);
  expect(f.values.size).toBe(0);
  frame(300);
  expect(f.values.get("--pwa-keyboard-motion-duration")).toBe("190ms");
  expect(f.values.get("--pwa-viewport-height")).toBe("812px");
  f.motion.stop();
});

test("caps a live intention credit at half the base duration", () => {
  const f = fixture();
  f.motion.intend(); frame(20);
  now = 200;
  f.motion.move(812, false); frame(216);
  expect(f.values.get("--pwa-keyboard-motion-duration")).toBe("125ms");
  f.motion.stop();
});

test("discards expired intent and keeps a visible segment for late redirection", () => {
  const f = fixture();
  f.motion.intend(); frame(20);
  now = 400;
  f.motion.move(812, false); frame(416);
  expect(f.values.get("--pwa-keyboard-motion-duration")).toBe("250ms");
  now = 516;
  f.motion.move(850, false);
  expect(f.values.get("--pwa-keyboard-motion-duration")).toBe("150ms");
  now = 660;
  f.motion.move(874, true);
  expect(f.values.get("--pwa-keyboard-motion-duration")).toBe("125ms");
  now = 680;
  f.motion.move(874, true);
  expect(f.values.get("--pwa-keyboard-motion-duration")).toBe("125ms");
  vi.advanceTimersByTime(157);
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.motion.active).toBe(false);
  expect(frames.size).toBe(0);
});

test("cancels intention, pending and active work without stale completion", () => {
  const f = fixture();
  f.motion.intend();
  f.motion.stop();
  expect(frames.size).toBe(0);
  f.motion.move(812, false);
  f.motion.stop();
  frame(16);
  expect(f.values.size).toBe(0);
  f.motion.move(874, true); frame(32);
  expect(f.dataset.keyboardClosing).toBe("");
  f.motion.stop();
  frame(500); vi.runAllTimers();
  expect(f.ended).not.toHaveBeenCalled();
  expect(f.dataset.keyboardClosing).toBeUndefined();
  expect(f.values.has("--pwa-keyboard-motion-duration")).toBe(false);
  expect(f.values.has("--pwa-keyboard-layout-duration")).toBe(false);
});
