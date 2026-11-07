import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { observeSoftKeyboard, SOFT_KEYBOARD_ATTRIBUTE, SOFT_KEYBOARD_BASELINE_KEY } from "./use-soft-keyboard";

/** 布局视口高度（根元素 clientHeight）；默认保持不变，即浏览器平移页面（iOS）。 */
let layoutHeight = 812;

class ViewportMock extends EventTarget {
  width = 402;
  height = 812;
  scale = 1;
  change(values: Partial<Pick<ViewportMock, "width" | "height" | "scale">>) {
    Object.assign(this, values);
    this.dispatchEvent(new Event("resize"));
  }
}

function setup() {
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const root = document.createElement("div");
  const input = document.createElement("textarea");
  document.body.append(input);
  const stop = observeSoftKeyboard(root);
  return { viewport, root, input, stop, state: () => root.getAttribute(SOFT_KEYBOARD_ATTRIBUTE) };
}

beforeEach(() => {
  layoutHeight = 812;
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, get: () => layoutHeight });
  window.localStorage.removeItem(SOFT_KEYBOARD_BASELINE_KEY);
});

afterEach(() => {
  Reflect.deleteProperty(document.documentElement, "clientHeight");
  vi.unstubAllGlobals();
  window.localStorage.removeItem(SOFT_KEYBOARD_BASELINE_KEY);
  document.body.replaceChildren();
});

test("marks open as soon as a focused input's viewport shrinks past the threshold", () => {
  const { viewport, input, state, stop } = setup();
  input.focus();
  expect(state()).toBeNull();
  // 停靠并入系统上推：检测到键盘即标记，不等待上推结束。
  viewport.change({ height: 600 });
  expect(state()).toBe("open");
  viewport.change({ height: 415 });
  expect(state()).toBe("open");
  // 到位后键盘高度再变（切换表情键盘）不重新停靠。
  viewport.change({ height: 380 });
  expect(state()).toBe("open");
  viewport.change({ height: 812 });
  expect(state()).toBeNull();
  stop();
});

test("closes at once when the input loses focus while the keyboard is still on screen", () => {
  const { viewport, input, state, stop } = setup();
  input.focus();
  viewport.change({ height: 415 });
  expect(state()).toBe("open");
  input.blur();
  expect(state()).toBeNull();
  // 失焦那一刻键盘尚未收起，不能把这时的高度记成基准。
  expect(JSON.parse(window.localStorage.getItem(SOFT_KEYBOARD_BASELINE_KEY)!)).toEqual({ "browser:402": 812 });
  viewport.change({ height: 812 });
  expect(state()).toBeNull();
  stop();
});

test("does not open for a focus that leaves the viewport height unchanged or only shifts it slightly", () => {
  const { viewport, input, state, stop } = setup();
  input.focus();
  expect(state()).toBeNull();
  // 外接键盘的快捷栏、浏览器工具栏伸缩只差几十 px。
  viewport.change({ height: 757 });
  expect(state()).toBeNull();
  stop();
});

test("overwrites the baseline with every unfocused reading so stale values recover", () => {
  window.localStorage.setItem(SOFT_KEYBOARD_BASELINE_KEY, JSON.stringify({ "browser:402": 1000 }));
  const { viewport, input, state, stop } = setup();
  // 初始化时没有聚焦，812 覆盖存下的 1000。
  expect(JSON.parse(window.localStorage.getItem(SOFT_KEYBOARD_BASELINE_KEY)!)).toEqual({ "browser:402": 812 });
  viewport.change({ height: 700 });
  input.focus();
  viewport.change({ height: 690 });
  expect(state()).toBeNull();
  stop();
});

test("keeps a separate baseline per viewport width and restores it from storage after a restart", () => {
  const first = setup();
  first.viewport.change({ width: 874, height: 370 });
  first.stop();
  document.body.replaceChildren();
  expect(JSON.parse(window.localStorage.getItem(SOFT_KEYBOARD_BASELINE_KEY)!)).toEqual({ "browser:402": 812, "browser:874": 370 });
  // 重启后聚焦状态下旋转到横屏：已有存下的横屏基准，可直接判断。
  const second = setup();
  second.input.focus();
  second.viewport.change({ width: 874, height: 200 });
  expect(second.state()).toBe("open");
  second.stop();
});

test("ignores changes while the page is zoomed and cleans up on stop", () => {
  const { viewport, input, root, state, stop } = setup();
  input.focus();
  viewport.change({ height: 400, scale: 2 });
  expect(state()).toBeNull();
  viewport.change({ height: 415, scale: 1 });
  expect(state()).toBe("open");
  stop();
  expect(root.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(false);
});

test("does not mark the keyboard when the browser shrinks the layout viewport with it", () => {
  // 安卓 Chrome 执行 resizes-content：布局视口随键盘变矮，外壳已贴住键盘，输入区无需停靠。
  const { viewport, input, state, stop } = setup();
  input.focus();
  layoutHeight = 415;
  viewport.change({ height: 415 });
  expect(state()).toBeNull();
  // 同一设备改为平移页面时照常判断。
  layoutHeight = 812;
  viewport.change({ height: 414 });
  expect(state()).toBe("open");
  stop();
});
