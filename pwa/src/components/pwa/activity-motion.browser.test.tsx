import { afterEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { LoaderCircle } from "lucide-react";
import { renderPwa } from "@/test/browser/render";
import "./tool-reader.css";

const marker = "data-pwa-animation";
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const state = (element: Element) => getComputedStyle(element).animationPlayState;

afterEach(async () => {
  vi.restoreAllMocks();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

async function harness() {
  const screen = await renderPwa(<div data-motion-fixture style={{ position: "fixed", top: 20, left: 20, width: 200 }}>
    <LoaderCircle className="pwa-spin" aria-label="Working" />
    <span className="pwa-tool-status pwa-tool-status-running"><LoaderCircle aria-label="Tool running" /></span>
    <div className="pwa-skeleton" />
  </div>);
  const fixture = document.querySelector<HTMLElement>("[data-motion-fixture]")!;
  const spin = fixture.querySelector<SVGSVGElement>(".pwa-spin")!;
  const tool = fixture.querySelector<SVGSVGElement>(".pwa-tool-status > svg")!;
  const skeleton = fixture.querySelector<HTMLElement>(".pwa-skeleton")!;
  await expect.poll(() => [spin, tool, skeleton].every(element => state(element) === "running")).toBe(true);
  return { screen, fixture, spin, tool, skeleton };
}

test("Provider pauses all real loops offscreen and resumes the same animations on reentry", async () => {
  const view = await harness();
  const elements = [view.spin, view.tool, view.skeleton];
  const animations = elements.map(element => element.getAnimations()[0]);
  expect(animations.every(Boolean)).toBe(true);
  view.fixture.style.top = "-1000px";
  await expect.poll(() => elements.every(element => state(element) === "paused")).toBe(true);
  const positions = animations.map(animation => animation.currentTime);
  await frames();
  expect(animations.map(animation => animation.currentTime)).toEqual(positions);
  view.fixture.style.top = "20px";
  await expect.poll(() => elements.every(element => state(element) === "running")).toBe(true);
  elements.forEach((element, index) => expect(element.getAnimations()[0]).toBe(animations[index]));
  expect(view.tool.parentElement?.classList.contains("pwa-tool-status-running")).toBe(true);
  expect(view.spin.getAttribute("aria-label")).toBe("Working");
});

test("page hidden pauses loops and foreground resumes only still-needed activity", async () => {
  const view = await harness();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(state(view.spin)).toBe("paused");
  expect(state(view.tool)).toBe("paused");
  expect(state(view.skeleton)).toBe("paused");
  view.tool.parentElement!.className = "pwa-tool-status pwa-tool-status-complete";
  view.spin.classList.remove("pwa-spin");
  await expect.poll(() => view.tool.hasAttribute(marker) || view.spin.hasAttribute(marker)).toBe(false);
  vi.restoreAllMocks();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(state(view.skeleton)).toBe("running");
  expect(getComputedStyle(view.tool).animationName).toBe("none");
  expect(getComputedStyle(view.spin).animationName).toBe("none");
});

test("reentry stays paused while hidden or reduced, and new offscreen nodes wait for visibility", async () => {
  const view = await harness();
  view.fixture.style.top = "-1000px";
  await expect.poll(() => state(view.spin)).toBe("paused");
  const added = view.spin.cloneNode(true) as SVGSVGElement;
  added.removeAttribute(marker);
  view.fixture.append(added);
  await expect.poll(() => added.getAttribute(marker)).toBe("paused");
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  view.fixture.style.top = "20px";
  await frames();
  expect(state(view.spin)).toBe("paused");
  expect(state(added)).toBe("paused");
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  vi.restoreAllMocks();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(state(view.spin)).toBe("paused");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await expect.poll(() => state(view.spin) === "running" && state(added) === "running").toBe(true);
  view.fixture.style.top = "-1000px";
  await expect.poll(() => state(view.spin)).toBe("paused");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(state(view.spin)).toBe("paused");
});

test("runtime reduced motion stops spinner, tool svg and skeleton without hiding status", async () => {
  const view = await harness();
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await expect.poll(() => [view.spin, view.tool, view.skeleton].every(element => state(element) === "paused")).toBe(true);
  expect(view.spin.checkVisibility({ visibilityProperty: true, opacityProperty: true })).toBe(true);
  expect(view.tool.checkVisibility({ visibilityProperty: true, opacityProperty: true })).toBe(true);
  expect(view.spin.getAttribute("aria-label")).toBe("Working");
  expect(view.tool.getAttribute("aria-label")).toBe("Tool running");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await expect.poll(() => [view.spin, view.tool, view.skeleton].every(element => state(element) === "running")).toBe(true);
});

test("incremental nodes, parent class changes, moves and removals leave no stale markers", async () => {
  const view = await harness();
  const parent = document.createElement("span");
  parent.className = "pwa-tool-status";
  const dynamic = view.tool.cloneNode(true) as SVGSVGElement;
  dynamic.removeAttribute(marker);
  parent.append(dynamic);
  view.fixture.append(parent);
  await frames();
  expect(dynamic.hasAttribute(marker)).toBe(false);
  parent.classList.add("pwa-tool-status-running");
  await expect.poll(() => dynamic.getAttribute(marker)).toBe("running");
  const replacement = dynamic.cloneNode(true) as SVGSVGElement;
  replacement.removeAttribute(marker);
  dynamic.replaceWith(replacement);
  await expect.poll(() => replacement.getAttribute(marker)).toBe("running");
  expect(dynamic.hasAttribute(marker)).toBe(false);
  replacement.replaceWith(dynamic);
  await expect.poll(() => dynamic.getAttribute(marker)).toBe("running");
  expect(replacement.hasAttribute(marker)).toBe(false);
  parent.classList.remove("pwa-tool-status-running");
  await expect.poll(() => dynamic.hasAttribute(marker)).toBe(false);
  dynamic.classList.add("pwa-spin");
  await expect.poll(() => dynamic.getAttribute(marker)).toBe("running");
  const holder = document.createElement("div");
  view.fixture.append(holder);
  holder.append(dynamic);
  await frames();
  expect(dynamic.getAttribute(marker)).toBe("running");
  holder.remove();
  await expect.poll(() => dynamic.hasAttribute(marker)).toBe(false);
  view.skeleton.remove();
  await expect.poll(() => view.skeleton.hasAttribute(marker)).toBe(false);
});

test("pseudo-element loops pause and ordinary streaming updates never rescan the scope", async () => {
  const view = await harness();
  const style = document.createElement("style");
  style.textContent = ".motion-test::before, .motion-test::after { content: ''; animation: pwa-rotate 1s linear infinite; }";
  view.fixture.append(style);
  view.skeleton.classList.add("motion-test");
  const scope = view.fixture.closest(".pwa-ui-scope")!;
  const scan = vi.spyOn(scope, "querySelectorAll");
  const stream = document.createElement("p");
  view.fixture.append(stream);
  for (let index = 0; index < 5; index += 1) {
    stream.textContent = `stream ${index}`;
    await Promise.resolve();
  }
  await frames();
  expect(scan).not.toHaveBeenCalled();
  view.fixture.style.top = "-1000px";
  await expect.poll(() => getComputedStyle(view.skeleton, "::before").animationPlayState).toBe("paused");
  expect(getComputedStyle(view.skeleton, "::after").animationPlayState).toBe("paused");
});

test("DEV review is untouched and unmount disconnects observers and listeners", async () => {
  const view = await harness();
  const review = document.createElement("div");
  review.className = "pwa-ui-review";
  const historical = view.spin.cloneNode(true) as SVGSVGElement;
  historical.removeAttribute(marker);
  review.append(historical);
  view.fixture.append(review);
  await frames();
  expect(historical.hasAttribute(marker)).toBe(false);
  review.classList.remove("pwa-ui-review");
  await expect.poll(() => historical.getAttribute(marker)).toBe("running");
  review.classList.add("pwa-ui-review");
  await expect.poll(() => historical.hasAttribute(marker)).toBe(false);
  const intersection = vi.spyOn(IntersectionObserver.prototype, "disconnect");
  const mutation = vi.spyOn(MutationObserver.prototype, "disconnect");
  const listener = vi.spyOn(document, "removeEventListener");
  const mediaListener = vi.spyOn(MediaQueryList.prototype, "removeEventListener");
  await view.screen.unmount();
  expect(intersection).toHaveBeenCalled();
  expect(mutation).toHaveBeenCalled();
  expect(listener.mock.calls.some(([name]) => name === "visibilitychange")).toBe(true);
  expect(mediaListener.mock.calls.some(([name]) => name === "change")).toBe(true);
  expect(view.spin.hasAttribute(marker)).toBe(false);
  expect(view.tool.hasAttribute(marker)).toBe(false);
  expect(view.skeleton.hasAttribute(marker)).toBe(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(view.spin.hasAttribute(marker)).toBe(false);
});
