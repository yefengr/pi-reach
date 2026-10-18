import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { Collapse } from "./collapse";
import "./timeline-row.css";

afterEach(async () => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--pwa-duration-collapse-out");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

async function harness(initialOpen = true) {
  let update!: (open: boolean, text?: string) => void;
  const changed = vi.fn();
  function Harness() {
    const [state, setState] = useState({ open: initialOpen, text: "initial output" });
    update = (open, text = state.text) => flushSync(() => setState({ open, text }));
    return <Collapse open={state.open} onPresentationChange={changed}><button>{state.text}</button></Collapse>;
  }
  const screen = await renderPwa(<Harness />);
  const node = () => document.querySelector<HTMLElement>(".pwa-collapse");
  return { screen, update, node, changed };
}

async function finish(element: Element) {
  await Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished));
}

test("initial expansion is immediate and streaming growth does not replay presentation", async () => {
  const view = await harness();
  const node = view.node()!;
  expect(node.hasAttribute("data-open")).toBe(true);
  expect(getComputedStyle(node).opacity).toBe("1");
  expect(node.getAnimations({ subtree: true })).toHaveLength(0);
  const notifications = view.changed.mock.calls.length;
  view.update(true, "streaming output grows");
  expect(view.node()).toBe(node);
  expect(node.textContent).toBe("streaming output grows");
  expect(node.getAnimations({ subtree: true })).toHaveLength(0);
  expect(view.changed).toHaveBeenCalledTimes(notifications);
});

test("manual entry uses collapse tokens and closing freezes inert output until unmounted", async () => {
  const view = await harness(false);
  expect(view.node()).toBeNull();
  view.update(true);
  expect(getComputedStyle(view.node()!).opacity).toBe("0");
  await expect.poll(() => view.node()?.hasAttribute("data-open")).toBe(true);
  const node = view.node()!;
  expect(node.getAnimations().some(animation => (animation as CSSTransition).transitionProperty === "opacity")).toBe(true);
  expect(getComputedStyle(node).transitionDuration).toBe("0.18s");
  await finish(node);
  view.update(false);
  expect(node.inert).toBe(true);
  expect(getComputedStyle(node).transitionDuration).toBe("0.14s, 0.14s");
  view.update(false, "new output after closing");
  expect(node.textContent).toBe("initial output");
  await expect.poll(view.node).toBeNull();
  expect(view.changed.mock.calls.length).toBeGreaterThanOrEqual(4);
});

test("reopening reverses from the current presentation and cancels stale exit fallback", async () => {
  const timeout = vi.spyOn(window, "setTimeout");
  const clear = vi.spyOn(window, "clearTimeout");
  const view = await harness();
  const node = view.node()!;
  expect(getComputedStyle(node).opacity).toBe("1");
  view.update(false);
  const fallbackIndex = timeout.mock.calls.findIndex(([, duration]) => duration === 190);
  expect(fallbackIndex).toBeGreaterThanOrEqual(0);
  const fallback = timeout.mock.results[fallbackIndex].value;
  const exit = node.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === "opacity")!;
  expect(exit).toBeDefined();
  exit.pause();
  exit.currentTime = 70;
  const halfway = Number(getComputedStyle(node).opacity);
  expect(halfway).toBeGreaterThan(0);
  expect(halfway).toBeLessThan(1);
  view.update(true, "latest output");
  expect(clear).toHaveBeenCalledWith(fallback);
  expect(node.hasAttribute("data-open")).toBe(true);
  expect(node.inert).toBe(false);
  expect(Math.abs(Number(getComputedStyle(node).opacity) - halfway)).toBeLessThan(0.03);
  expect(node.textContent).toBe("latest output");
  await finish(node);
  expect(view.node()).toBe(node);
  expect(getComputedStyle(node).opacity).toBe("1");
});

test("missing transitionend uses the actual exit token plus 50ms", async () => {
  document.documentElement.style.setProperty("--pwa-duration-collapse-out", "450ms");
  const timeout = vi.spyOn(window, "setTimeout");
  const view = await harness();
  expect(getComputedStyle(view.node()!).opacity).toBe("1");
  view.update(false);
  expect(timeout.mock.calls.some(([, duration]) => duration === 500)).toBe(true);
  await new Promise(resolve => window.setTimeout(resolve, 210));
  expect(view.node()).not.toBeNull();
  await expect.poll(view.node).toBeNull();
});

test("changing reduced motion during exit replaces the fallback and removes geometric transitions", async () => {
  const timeout = vi.spyOn(window, "setTimeout");
  const view = await harness();
  expect(getComputedStyle(view.node()!).opacity).toBe("1");
  view.update(false);
  const node = view.node()!;
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await expect.poll(() => timeout.mock.calls.some(([, duration]) => duration === 170)).toBe(true);
  expect(getComputedStyle(node).transitionProperty).not.toContain("grid-template-rows");
  expect(getComputedStyle(node).transitionDuration).toBe("0.12s, 0.12s");
  node.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
  await expect.poll(view.node).toBeNull();
});

test("unmount cancels the exit fallback", async () => {
  const clear = vi.spyOn(window, "clearTimeout");
  const view = await harness();
  view.update(false);
  const before = clear.mock.calls.length;
  await view.screen.unmount();
  expect(clear.mock.calls.length).toBeGreaterThan(before);
  expect(view.node()).toBeNull();
});
