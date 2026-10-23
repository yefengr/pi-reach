import { afterEach, expect, test, vi } from "vitest";
import { assistKeyboardFocus, isIosTouchWebKit, readKeyboardTap, type FocusAssistNavigator } from "./keyboard-focus-assist";

const IPHONE: FocusAssistNavigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)", maxTouchPoints: 5 };
const DESKTOP: FocusAssistNavigator = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 };

function touch(x: number, y: number) {
  return { clientX: x, clientY: y } as Touch;
}
function touchEvent(touches: Touch[], changedTouches: Touch[]) {
  return { touches, changedTouches } as unknown as TouchEvent;
}

function bottomTextarea(value = "draft") {
  const input = document.createElement("textarea");
  input.value = value;
  Object.assign(input.style, { position: "fixed", left: "0", bottom: "0", height: "44px" });
  document.body.append(input);
  return input;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll("textarea").forEach((node) => node.remove());
});

test("detects iPhone and touch iPad WebKit only", () => {
  expect(isIosTouchWebKit(IPHONE)).toBe(true);
  expect(isIosTouchWebKit({ userAgent: DESKTOP.userAgent, maxTouchPoints: 5 })).toBe(true);
  expect(isIosTouchWebKit(DESKTOP)).toBe(false);
  expect(isIosTouchWebKit(undefined)).toBe(false);
});

test("focuses a tapped bottom textarea while it is moved into the visible top area, then restores it", () => {
  const input = bottomTextarea();
  const translations: string[] = [];
  const focus = vi.spyOn(input, "focus").mockImplementation(function (this: HTMLTextAreaElement) {
    translations.push(this.style.getPropertyValue("translate"));
    HTMLTextAreaElement.prototype.focus.call(this, { preventScroll: true });
  });
  const start = readKeyboardTap(touchEvent([touch(20, 880)], []), 1000);
  expect(start).toEqual({ x: 20, y: 880, time: 1000 });

  expect(assistKeyboardFocus(input, start, touchEvent([], [touch(24, 884)]), 1100, IPHONE)).toBe(true);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(translations[0]).toMatch(/^0px -\d+px$/);
  expect(input.style.getPropertyValue("translate")).toBe("");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
});

test("leaves drags, long presses, focused, read-only and non-iOS inputs to the browser", () => {
  const input = bottomTextarea();
  const start = readKeyboardTap(touchEvent([touch(20, 880)], []), 1000);
  expect(assistKeyboardFocus(input, start, touchEvent([], [touch(20, 840)]), 1100, IPHONE)).toBe(false);
  expect(assistKeyboardFocus(input, start, touchEvent([], [touch(20, 880)]), 1800, IPHONE)).toBe(false);
  expect(assistKeyboardFocus(input, start, touchEvent([], [touch(20, 880)]), 1100, DESKTOP)).toBe(false);
  expect(assistKeyboardFocus(input, null, touchEvent([], [touch(20, 880)]), 1100, IPHONE)).toBe(false);
  input.readOnly = true;
  expect(assistKeyboardFocus(input, start, touchEvent([], [touch(20, 880)]), 1100, IPHONE)).toBe(false);
  input.readOnly = false;
  input.focus();
  expect(assistKeyboardFocus(input, start, touchEvent([], [touch(20, 880)]), 1100, IPHONE)).toBe(false);
  expect(readKeyboardTap(touchEvent([touch(1, 1), touch(2, 2)], []))).toBeNull();
});
