import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MOBILE_LAYOUT_QUERY, TOUCH_INPUT_QUERY } from "@/lib/ui/viewport-queries";
import { LOOK_BACK_DISMISS_PX, observeKeyboardDismissOnLookBack } from "./dismiss-keyboard-on-look-back";

/** 只替换布局与触屏两条查询；无头 Chromium 关闭触控模拟后无法恢复指针媒体特性，这里不用真实模拟。 */
function stubDevice({ mobile, touch }: { mobile: boolean; touch: boolean }) {
  const original = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query === MOBILE_LAYOUT_QUERY) return { ...original(query), matches: mobile };
    if (query === TOUCH_INPUT_QUERY) return { ...original(query), matches: touch };
    return original(query);
  });
}

let list: HTMLElement;
let input: HTMLTextAreaElement;
let stop: () => void;

function touchEvent(type: string, points: { x: number; y: number; id?: number }[]) {
  const touches = points.map(({ x, y, id = 1 }) => new Touch({ identifier: id, target: list, clientX: x, clientY: y }));
  list.dispatchEvent(new TouchEvent(type, { bubbles: true, touches, changedTouches: touches }));
}
function drag(dx: number, dy: number) {
  touchEvent("touchstart", [{ x: 100, y: 100 }]);
  touchEvent("touchmove", [{ x: 100 + dx / 2, y: 100 + dy / 2 }]);
  touchEvent("touchmove", [{ x: 100 + dx, y: 100 + dy }]);
}

beforeEach(() => {
  list = document.createElement("div");
  list.className = "pwa-message-list";
  const footer = document.createElement("div");
  footer.className = "pwa-chat-footer";
  input = document.createElement("textarea");
  input.value = "draft in progress";
  footer.append(input);
  document.body.append(list, footer);
  stop = observeKeyboardDismissOnLookBack(list);
  input.focus();
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test("dragging the list towards earlier content blurs the focused composer and keeps the draft", () => {
  stubDevice({ mobile: true, touch: true });
  drag(0, LOOK_BACK_DISMISS_PX + 10);
  expect(document.activeElement).not.toBe(input);
  expect(input.value).toBe("draft in progress");
});

test("the keyboard stays until the finger has travelled the look-back distance", () => {
  stubDevice({ mobile: true, touch: true });
  touchEvent("touchstart", [{ x: 100, y: 100 }]);
  touchEvent("touchmove", [{ x: 100, y: 100 + LOOK_BACK_DISMISS_PX - 1 }]);
  expect(document.activeElement).toBe(input);
  touchEvent("touchmove", [{ x: 100, y: 100 + LOOK_BACK_DISMISS_PX }]);
  expect(document.activeElement).not.toBe(input);
});

test.each([["towards the latest content", 0, -80], ["sideways", 80, 30]] as const)("dragging %s keeps the keyboard", (_name, dx, dy) => {
  stubDevice({ mobile: true, touch: true });
  drag(dx, dy);
  touchEvent("touchend", []);
  expect(document.activeElement).toBe(input);
});

test("a second finger abandons the gesture", () => {
  stubDevice({ mobile: true, touch: true });
  touchEvent("touchstart", [{ x: 100, y: 100 }]);
  touchEvent("touchmove", [{ x: 100, y: 110 }, { x: 200, y: 110, id: 2 }]);
  touchEvent("touchmove", [{ x: 100, y: 200 }]);
  expect(document.activeElement).toBe(input);
});

test.each([[{ mobile: false, touch: true }], [{ mobile: true, touch: false }]])("does nothing outside the touch mobile layout (%o)", (device) => {
  stubDevice(device);
  drag(0, 80);
  expect(document.activeElement).toBe(input);
});

test("focus elsewhere is left alone, and a gesture that started unfocused never dismisses", () => {
  stubDevice({ mobile: true, touch: true });
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  drag(0, 80);
  expect(document.activeElement).toBe(other);
  touchEvent("touchend", []);
  input.blur();
  touchEvent("touchstart", [{ x: 100, y: 100 }]);
  input.focus();
  touchEvent("touchmove", [{ x: 100, y: 200 }]);
  expect(document.activeElement).toBe(input);
});

test("stops listening after cleanup", () => {
  stubDevice({ mobile: true, touch: true });
  stop();
  drag(0, 80);
  expect(document.activeElement).toBe(input);
});
