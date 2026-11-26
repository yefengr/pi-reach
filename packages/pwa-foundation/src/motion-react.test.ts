import { afterEach, expect, test, vi } from "vitest";
const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], states: [] as number[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useState: (initial: () => number) => {
    const index = hooks.cursor++;
    hooks.states[index] ??= initial();
    return [hooks.states[index], (value: number) => { hooks.states[index] = value; }];
  },
}));
import { usePwaMotionDuration } from "./motion-react.js";
import { pwaDrawerTransitions, pwaMenuTransition, pwaFadeTransition, PWA_DRAWER_EASE, usePwaDrawerTransition, usePwaMenuTransition } from "./mantine-transitions.js";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
afterEach(() => { hooks.effects = []; hooks.states = []; hooks.cursor = 0; vi.unstubAllGlobals(); });

test("SSR/首次水合不读样式，effect读取root窗口并即时响应change，卸载清理", () => {
  let reduced = true;
  let change = () => {};
  const remove = vi.fn();
  const media = { addEventListener: (_name: string, fn: () => void) => { change = fn; }, removeEventListener: remove };
  const getComputedStyle = vi.fn(() => ({ getPropertyValue: () => reduced ? "120ms" : "360ms" }));
  const root = { ownerDocument: { defaultView: { getComputedStyle, matchMedia: () => media } } } as unknown as HTMLElement;
  expect(usePwaMotionDuration("--pwa-duration-drawer", undefined, root)).toBe(360);
  expect(getComputedStyle).not.toHaveBeenCalled();
  const cleanup = hooks.effects[0]();
  expect(hooks.states).toEqual([120]);
  reduced = false; change();
  expect(hooks.states).toEqual([360]);
  cleanup?.();
  expect(remove).toHaveBeenCalledWith("change", change);
});

test("SSR hook保持普通fallback，不读取浏览器reduced状态", () => {
  function Probe() { return createElement("span", null, usePwaMotionDuration("--pwa-duration-menu-in")); }
  expect(renderToString(createElement(Probe))).toBe("<span>240</span>");
});

test("菜单和四向drawer只提供transition配置，不接管opened或焦点", () => {
  expect(usePwaMenuTransition()).toEqual({ transition: pwaMenuTransition, duration: 240, exitDuration: 160 });
  expect(usePwaDrawerTransition("top")).toEqual({ transition: pwaDrawerTransitions.top, duration: 360, exitDuration: 280, timingFunction: PWA_DRAWER_EASE });
  expect(pwaFadeTransition).toHaveProperty("transitionProperty", "opacity");
  expect(pwaMenuTransition).toHaveProperty("out.pointerEvents", "none");
  for (const [position, transform] of Object.entries({ left: "translateX(calc(-100%", right: "translateX(calc(100%", top: "translateY(calc(-100%", bottom: "translateY(calc(100%" })) {
    expect(pwaDrawerTransitions[position as keyof typeof pwaDrawerTransitions]).toHaveProperty("out.transform", expect.stringContaining(transform));
  }
});
