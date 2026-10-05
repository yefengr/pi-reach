import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { pointer, syntheticCapture, syntheticSwipe } from "@/test/browser/swipe";
import { useSwipe } from "./use-swipe";

let configure: (value: boolean) => void;
let latest: () => void;
let canSwipe: () => boolean;
function Harness({ callback }: { callback: () => void }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(true);
  useLayoutEffect(() => { configure = setEnabled; }, []);
  useSwipe(element, { direction: "right", enabled, onSwipe: () => (latest ?? callback)(), canSwipe: () => canSwipe() });
  return <div className="pwa-root"><div ref={setElement} data-testid="surface"><span data-testid="child">Body</span></div><span data-testid="outside">Outside</span></div>;
}
async function setup() {
  const callback = vi.fn();
  const screen = await render(<Harness callback={callback} />);
  const surface = screen.getByTestId("surface").element() as HTMLElement;
  const child = screen.getByTestId("child").element();
  return { screen, surface, child, capture: syntheticCapture(surface), callback };
}
beforeEach(async () => { await page.viewport(390, 844); latest = undefined as unknown as () => void; canSwipe = () => true; });
afterEach(async () => { vi.restoreAllMocks(); await page.viewport(1280, 900); });

test("does not capture down; locks then captures, ignores descendant lost, releases on commit", async () => {
  const { child, surface, callback, capture } = await setup();
  pointer(child, "pointerdown");
  expect(capture.set).not.toHaveBeenCalled();
  pointer(child, "pointermove", 50);
  expect(capture.set).toHaveBeenCalledWith(1);
  pointer(child, "lostpointercapture");
  pointer(surface, "pointerup", 100);
  expect(callback).toHaveBeenCalledOnce();
  expect(capture.release).toHaveBeenCalledWith(1);
  expect(capture.held.size).toBe(0);
});

test.each(["pointercancel", "lostpointercapture"])("cancels on surface %s and can start again", async (event) => {
  const { child, surface, callback, capture } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  pointer(surface, event); pointer(surface, "pointerup", 100);
  expect(callback).not.toHaveBeenCalled();
  expect(capture.held.size).toBe(0);
  syntheticSwipe(child);
  expect(callback).toHaveBeenCalledOnce();
});

test("other pointer move/up/cancel/lost are isolated; a second touch anywhere cancels pending or tracking", async () => {
  const { child, surface, screen, callback } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  for (const event of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) pointer(surface, event, 100, 0, { pointerId: 2 });
  pointer(surface, "pointerup", 100);
  expect(callback).toHaveBeenCalledOnce();
  for (const target of [child, screen.getByTestId("outside").element(), window]) {
    for (const tracking of [false, true]) {
      pointer(child, "pointerdown");
      if (tracking) pointer(child, "pointermove", 50);
      pointer(target, "pointerdown", 0, 0, { pointerId: 2, isPrimary: false });
      pointer(surface, "pointerup", 100);
    }
  }
  expect(callback).toHaveBeenCalledOnce();
});

test("disabling is immediate, reenabling cannot revive; latest callback and synchronous gate are read", async () => {
  const { child, surface, callback, capture } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  flushSync(() => configure(false));
  expect(capture.held.size).toBe(0);
  flushSync(() => configure(true));
  pointer(surface, "pointerup", 100);
  expect(callback).not.toHaveBeenCalled();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  canSwipe = () => false;
  pointer(surface, "pointerup", 100);
  expect(callback).not.toHaveBeenCalled();
  canSwipe = () => true;
  latest = vi.fn();
  syntheticSwipe(child);
  expect(latest).toHaveBeenCalledOnce();
});

test("media change cancels synchronously even when mobile returns before up", async () => {
  const { child, surface, callback, capture } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  await page.viewport(900, 844);
  await expect.poll(() => capture.held.size).toBe(0);
  await page.viewport(390, 844);
  pointer(surface, "pointerup", 100);
  expect(callback).not.toHaveBeenCalled();
  syntheticSwipe(child);
  expect(callback).toHaveBeenCalledOnce();
});

test("unmount releases held capture and removes temporary listeners", async () => {
  const { child, surface, callback, capture, screen } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  await screen.unmount();
  expect(capture.release).toHaveBeenCalledWith(1);
  pointer(window, "pointerdown", 0, 0, { pointerId: 2 });
  pointer(surface, "pointerup", 100);
  expect(callback).not.toHaveBeenCalled();
});

test("capture and release exceptions do not strand state or listeners", async () => {
  const { child, surface, callback, capture } = await setup();
  capture.set.mockImplementationOnce(() => { throw new DOMException("inactive pointer"); });
  syntheticSwipe(child);
  expect(callback).not.toHaveBeenCalled();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  capture.release.mockImplementationOnce(() => { throw new DOMException("inactive pointer"); });
  pointer(surface, "pointercancel");
  syntheticSwipe(child);
  expect(callback).toHaveBeenCalledOnce();
});

test("passive handlers never prevent defaults; rejected direction never captures", async () => {
  const { child, capture } = await setup();
  const prevent = vi.spyOn(PointerEvent.prototype, "preventDefault");
  syntheticSwipe(child, -100);
  syntheticSwipe(child, 10, 100);
  expect(capture.set).not.toHaveBeenCalled();
  expect(prevent).not.toHaveBeenCalled();
});
