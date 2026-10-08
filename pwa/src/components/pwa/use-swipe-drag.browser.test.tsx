import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { pointer, syntheticCapture } from "@/test/browser/swipe";
import { useSwipe, type SwipeDragHandlers } from "./use-swipe";

let setEnabled: (value: boolean) => void;
let showOverlay: (value: boolean) => void;
let calls: string[];
let startResult: boolean | void;
let canSwipe: boolean;
const drag: SwipeDragHandlers = {
  start: vi.fn(() => { calls.push("start"); return startResult; }),
  move: vi.fn((distance: number) => { calls.push(`move:${distance}`); }),
  end: vi.fn((result) => { calls.push(`end:${result.committed}`); }),
  cancel: vi.fn((reason) => { calls.push(`cancel:${reason}`); }),
};
const onSwipe = vi.fn(() => { calls.push("swipe"); });

function Harness() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [enabled, setEnabledState] = useState(true);
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    setEnabled = (value) => flushSync(() => setEnabledState(value));
    showOverlay = (value) => flushSync(() => setOverlay(value));
  }, []);
  useSwipe(element, { direction: "right", enabled, onSwipe, canSwipe: () => canSwipe, drag });
  return <div className="pwa-root">
    <div ref={setElement} data-testid="surface"><span data-testid="child">Body</span></div>
    {overlay ? <div role="dialog" style={{ width: 20, height: 20 }}>Blocker</div> : null}
  </div>;
}

async function setup() {
  const screen = await render(<Harness />);
  const surface = screen.getByTestId("surface").element() as HTMLElement;
  const child = screen.getByTestId("child").element();
  const capture = syntheticCapture(surface);
  return { child, surface, capture };
}
/** 起点避开左缘排除区；lock 帧位移 14px，之后每步以绝对坐标给出。 */
const down = (target: Element) => pointer(target, "pointerdown", 100, 0);
const moveTo = (target: Element, x: number) => pointer(target, "pointermove", 100 + x, 0);

beforeEach(async () => {
  await page.viewport(390, 844);
  calls = [];
  startResult = undefined;
  canSwipe = true;
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 900);
});

test("start runs after capture, move reports tracked distance from the lock frame, end replaces onSwipe", async () => {
  const { child, surface, capture } = await setup();
  down(child);
  expect(drag.start).not.toHaveBeenCalled();
  moveTo(child, 14);
  expect(capture.set).toHaveBeenCalledWith(1);
  expect(capture.set.mock.invocationCallOrder[0]).toBeLessThan((drag.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  moveTo(child, 64);
  moveTo(child, 4);
  pointer(surface, "pointerup", 164, 0);
  expect(calls).toEqual(["start", "move:0", "move:50", "move:0", "end:true"]);
  expect(onSwipe).not.toHaveBeenCalled();
  expect(drag.cancel).not.toHaveBeenCalled();
  expect(capture.held.size).toBe(0);
});

test("a release below the threshold ends uncommitted and never calls onSwipe", async () => {
  const { child, surface } = await setup();
  down(child);
  moveTo(child, 30);
  pointer(surface, "pointerup", 130, 0);
  expect(calls.at(-1)).toBe("end:false");
  expect(onSwipe).not.toHaveBeenCalled();
});

test("a fast flick back after crossing the threshold ends uncommitted", async () => {
  const { child, surface } = await setup();
  // 合成事件的时间戳由浏览器生成，几乎同时到达：回退段的速度必为强负值，具体数值边界由纯函数单测覆盖。
  down(child);
  moveTo(child, 90);
  moveTo(child, 60);
  pointer(surface, "pointerup", 120, 0);
  expect(calls.at(-1)).toBe("end:false");
  expect(onSwipe).not.toHaveBeenCalled();
});

test("start returning false falls back to the trigger path without move or end", async () => {
  startResult = false;
  const { child, surface } = await setup();
  down(child);
  moveTo(child, 14);
  moveTo(child, 100);
  pointer(surface, "pointerup", 200, 0);
  expect(calls).toEqual(["start", "swipe"]);
});

test("a start inside the left edge band is refused for browser tabs and falls back to the trigger path", async () => {
  const { child, surface } = await setup();
  pointer(child, "pointerdown", 10, 0);
  pointer(child, "pointermove", 24, 0);
  pointer(child, "pointermove", 110, 0);
  pointer(surface, "pointerup", 110, 0);
  expect(calls).toEqual(["swipe"]);
});

test.each([
  ["pointercancel", (surface: HTMLElement) => pointer(surface, "pointercancel")],
  ["lostpointercapture", (surface: HTMLElement) => pointer(surface, "lostpointercapture")],
  ["second touch", (surface: HTMLElement) => pointer(surface, "pointerdown", 0, 0, { pointerId: 2 })],
])("%s during a drag reports interrupted and ends the gesture", async (_name, interrupt) => {
  const { child, surface } = await setup();
  down(child);
  moveTo(child, 40);
  interrupt(surface);
  expect(calls.at(-1)).toBe("cancel:interrupted");
  pointer(surface, "pointerup", 200, 0);
  expect(calls.filter((call) => call.startsWith("end"))).toEqual([]);
  expect(onSwipe).not.toHaveBeenCalled();
});

test("a desktop-width media change during a drag reports interrupted", async () => {
  const { child } = await setup();
  down(child);
  moveTo(child, 40);
  await page.viewport(1280, 900);
  await vi.waitFor(() => expect(calls.at(-1)).toBe("cancel:interrupted"));
});

test("canSwipe turning false mid-drag reports blocked", async () => {
  const { child } = await setup();
  down(child);
  moveTo(child, 40);
  canSwipe = false;
  moveTo(child, 60);
  expect(calls.at(-1)).toBe("cancel:blocked");
});

test("a blocking overlay appearing mid-drag reports blocked", async () => {
  const { child } = await setup();
  down(child);
  moveTo(child, 40);
  showOverlay(true);
  moveTo(child, 60);
  expect(calls.at(-1)).toBe("cancel:blocked");
});

test("a blocking overlay marked as the drag's own preview does not block", async () => {
  const { child, surface } = await setup();
  down(child);
  moveTo(child, 40);
  showOverlay(true);
  document.querySelector('[role="dialog"]')!.setAttribute("data-swipe-drag", "");
  moveTo(child, 90);
  pointer(surface, "pointerup", 190, 0);
  expect(calls.at(-1)).toBe("end:true");
});

test("enabled turning false mid-drag reports disabled", async () => {
  const { child } = await setup();
  down(child);
  moveTo(child, 40);
  setEnabled(false);
  expect(calls.at(-1)).toBe("cancel:disabled");
});
