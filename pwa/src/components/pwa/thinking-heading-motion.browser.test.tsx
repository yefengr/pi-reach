import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ThinkingContent } from "./timeline-content";
import { setLanguagePreference } from "@/lib/i18n";
import { getLanguageState } from "@/lib/i18n/locale";

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

async function harness(streaming = false, pauseEntry = false) {
  let update!: (streaming: boolean, text?: string) => void;
  let entry: Animation | undefined;
  function Harness() {
    const [state, setState] = useState({ streaming, text: "**Stable title**\nReasoning." });
    update = (next, text = state.text) => flushSync(() => setState({ streaming: next, text }));
    useLayoutEffect(() => {
      if (!pauseEntry) return;
      const slot = document.querySelector(".pwa-thinking-icon-slot")!;
      entry = slot.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === "width");
      entry?.pause();
    }, []);
    return <ThinkingContent text={state.text} streaming={state.streaming} expanded />;
  }
  await renderPwa(<Harness />);
  const heading = document.querySelector<HTMLElement>(".pwa-thinking-heading")!;
  const slot = heading.querySelector<HTMLElement>(".pwa-thinking-icon-slot")!;
  const text = heading.querySelector<HTMLElement>(":scope > span")!;
  const arrow = document.querySelector<HTMLElement>(".pwa-thinking-head > .pwa-timeline-chevron")!;
  const body = document.querySelector<HTMLElement>(".pwa-thinking-content")!;
  const offset = () => Math.round(text.getBoundingClientRect().left - heading.getBoundingClientRect().left);
  return { update, heading, slot, text, arrow, body, offset, entry };
}

/** 只等待有限的呈现动画，旋转自身的无限动画不参与。 */
async function finishMotion(element: Element) {
  const motions = element.getAnimations({ subtree: true }).filter(animation =>
    Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity));
  await Promise.allSettled(motions.map(animation => animation.finished));
}

const cases = [1280, 390].flatMap(width => ["no-preference", "reduce"].map(motion => ({ width, motion })));
test.each(cases)("thinking title slides only on state changes at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const view = await harness();
  const arrowLeft = Math.round(view.arrow.getBoundingClientRect().left);
  const bodyLeft = Math.round(view.body.getBoundingClientRect().left);
  expect(view.offset()).toBe(0);
  view.update(true);
  const spinner = view.slot.querySelector(".pwa-spin")!;
  expect(spinner).not.toBeNull();
  const entering = view.slot.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === "width");
  if (motion === "no-preference") {
    expect(entering).toBeDefined();
    entering!.pause();
    entering!.currentTime = 80;
    expect(view.offset()).toBeGreaterThan(0);
    expect(view.offset()).toBeLessThan(24);
    entering!.play();
  } else expect(entering).toBeUndefined();
  await finishMotion(view.heading);
  expect(view.offset()).toBe(24);
  view.update(true, "**Stable title**\nReasoning continues.\n**New title**");
  expect(view.slot.querySelector(".pwa-spin")).toBe(spinner);
  expect(view.offset()).toBe(24);
  expect(view.slot.getAnimations().some(animation => (animation as CSSTransition).transitionProperty === "width")).toBe(false);
  view.update(false);
  expect(view.slot.querySelector(".pwa-spin")).toBeNull();
  const fading = view.slot.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === "opacity");
  expect(fading).toBeDefined();
  fading!.pause();
  fading!.currentTime = 80;
  expect(Number(getComputedStyle(view.slot).opacity)).toBeGreaterThan(0);
  expect(Number(getComputedStyle(view.slot).opacity)).toBeLessThan(1);
  fading!.play();
  await finishMotion(view.heading);
  expect(view.offset()).toBe(0);
  expect(getComputedStyle(view.slot).opacity).toBe("0");
  expect(Math.round(view.slot.getBoundingClientRect().width)).toBe(0);
  expect(Math.round(view.arrow.getBoundingClientRect().left)).toBe(arrowLeft);
  expect(Math.round(view.body.getBoundingClientRect().left)).toBe(bodyLeft);
});

test("long thinking controls stay English in a Chinese interface without translating the body", async () => {
  const previous = getLanguageState().preference;
  setLanguagePreference("zh");
  const text = Array.from({ length: 25 }, (_, index) => `模型原始思考第 ${index + 1} 行`).join("\n");
  try {
    const screen = await renderPwa(<ThinkingContent text={text} expanded />);
    await expect.element(screen.getByRole("button", { name: "Collapse thinking" })).toBeVisible();
    await screen.getByRole("button", { name: "Show full thinking", exact: true }).click();
    expect(document.querySelector(".pwa-text-plain")?.textContent).toBe(text);
    await screen.getByRole("button", { name: "Show less thinking", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Show full thinking", exact: true })).toBeVisible();
  } finally { setLanguagePreference(previous); }
});

test("a newly mounted live title enters once and reverses from its current position", async () => {
  const view = await harness(true, true);
  expect(view.entry).toBeDefined();
  view.entry!.currentTime = 0;
  expect(view.offset()).toBe(0);
  expect(view.slot.querySelector(".pwa-spin")?.checkVisibility({ opacityProperty: true, visibilityProperty: true })).toBe(true);
  view.entry!.play();
  await finishMotion(view.heading);
  expect(view.offset()).toBe(24);
  view.update(false);
  const exit = view.slot.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === "width")!;
  expect(exit).toBeDefined();
  exit.pause();
  exit.currentTime = 80;
  const halfway = view.offset();
  expect(halfway).toBeGreaterThan(0);
  expect(halfway).toBeLessThan(24);
  view.update(true);
  // 反向不能先跳回完整 24px 占位，再重新播放。
  expect(Math.abs(view.offset() - halfway)).toBeLessThanOrEqual(1);
  await finishMotion(view.heading);
  expect(view.offset()).toBe(24);
  view.update(false);
  await finishMotion(view.heading);
  expect(view.offset()).toBe(0);
});
