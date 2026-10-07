import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { ToolReader } from "./tool-reader";
import { PwaOperationNotifications } from "./pwa-operation-notifications";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import type { ToolValue } from "./tool-presentation";

const tool: ToolValue = {
  event_id: "motion", session_id: "session", leaf_id: "generation", group_id: "group", timestamp: 0,
  kind: "tool", tool_call_id: "call", tool: "read", args: { path: "notes.txt" }, status: "complete", truncated: false,
  result: "First line\nSecond line",
};
const enterEase = "cubic-bezier(0, 0, 0, 1)";
const exitEase = "cubic-bezier(0.3, 0, 1, 1)";
const standardEase = "cubic-bezier(0.2, 0, 0, 1)";
const duration = (node: Element) => parseFloat(getComputedStyle(node).transitionDuration) * 1000;
const setMotion = (reduce: boolean) => cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });

function expectNoShift(node: Element) {
  const transform = getComputedStyle(node).transform;
  const matrix = new DOMMatrix(transform === "none" ? undefined : transform);
  expect(matrix.m41).toBe(0);
  expect(matrix.m42).toBe(0);
}

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

/** 在窗口内逐帧采样；透明度与位移取最差值，时长与曲线收集所有出现过的取值。 */
async function sampleMotion(selector: string, windowMs: number) {
  const result = { minOpacity: 1, maxShift: 0, durations: new Set<number>(), eases: new Set<string>() };
  const end = performance.now() + windowMs;
  await new Promise<void>(resolve => {
    const tick = () => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node) {
        const style = getComputedStyle(node);
        const transform = style.transform;
        result.minOpacity = Math.min(result.minOpacity, Number(style.opacity));
        result.maxShift = Math.max(result.maxShift, Math.abs(new DOMMatrix(transform === "none" ? undefined : transform).m41));
        result.durations.add(duration(node));
        result.eases.add(style.transitionTimingFunction);
      }
      if (performance.now() < end) requestAnimationFrame(tick); else resolve();
    };
    tick();
  });
  return result;
}

const SAMPLE_WINDOW_MS = 450;

test.each([390, 1440].flatMap(width => [false, true].map(reduce => ({ width, reduce }))))("Modal uses token timing, exit easing and stationary reduced motion at $width (reduce=$reduce)", async ({ width, reduce }) => {
  await page.viewport(width, 844);
  await setMotion(reduce);
  let setOpened!: (value: boolean) => void;
  function Harness() {
    const [opened, update] = useState(false);
    setOpened = update;
    return <ConfirmActionDialog action={opened ? { kind: "new-session" } : null} pending={false} error={null} onClose={() => update(false)} onConfirm={() => {}} />;
  }
  const screen = await renderPwa(<Harness />);
  try {
    const selector = ".pwa-confirm-dialog";
    flushSync(() => setOpened(true));
    await expect.poll(() => document.querySelector(selector)).not.toBeNull();
    const card = document.querySelector<HTMLElement>(selector)!;
    await expect.poll(() => getComputedStyle(card).opacity).toBe("1");
    expect(duration(card), card.outerHTML.slice(0, 800)).toBe(reduce ? 120 : 180);
    expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : enterEase);
    const overlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay")!;
    expect(duration(overlay)).toBe(reduce ? 120 : 180);
    flushSync(() => setOpened(false));
    await expect.poll(() => card.style.opacity).toBe("0");
    expect(duration(card)).toBe(reduce ? 120 : 140);
    expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : exitEase);
    expect(getComputedStyle(overlay).transitionTimingFunction).toBe(reduce ? standardEase : exitEase);
    if (reduce) expectNoShift(card);
    await expect.poll(() => document.querySelector(selector)).toBeNull();
  } finally { await screen.unmount(); }
});

test.each([390, 1440].flatMap(width => [false, true].map(reduce => ({ width, reduce }))))("Reader Drawer slides without fading and fades without shift under reduced motion at $width (reduce=$reduce)", async ({ width, reduce }) => {
  await page.viewport(width, 844);
  await setMotion(reduce);
  let setOpened!: (value: boolean) => void;
  function Harness() {
    const [opened, update] = useState(false);
    setOpened = update;
    return <ToolReader value={tool} opened={opened} onClose={() => update(false)} />;
  }
  const screen = await renderPwa(<Harness />);
  try {
    const selector = ".pwa-tool-reader[role='dialog']";
    const entering = sampleMotion(selector, SAMPLE_WINDOW_MS);
    flushSync(() => setOpened(true));
    await expect.poll(() => document.querySelector(selector)).not.toBeNull();
    const overlay = document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!;
    expect(duration(overlay)).toBe(reduce ? 120 : 200);
    expect(getComputedStyle(overlay).transitionTimingFunction).toBe(standardEase);
    const enter = await entering;
    const card = document.querySelector<HTMLElement>(selector)!;
    await expect.poll(() => getComputedStyle(card).opacity).toBe("1");
    const command = card.querySelector<HTMLElement>(".pwa-tool-reader-command")!;
    expect(getComputedStyle(command).fontSize).toBe("14px");
    expect(getComputedStyle(command).lineHeight).toBe("21.7px");

    const exiting = sampleMotion(selector, SAMPLE_WINDOW_MS);
    flushSync(() => setOpened(false));
    expect(getComputedStyle(overlay).transitionTimingFunction).toBe(standardEase);
    await expect.poll(() => document.querySelector(selector)).toBeNull();
    const exit = await exiting;

    for (const phase of [enter, exit]) {
      expect([...phase.durations]).toEqual([reduce ? 120 : 200]);
      expect([...phase.eases]).toEqual([standardEase]);
      if (reduce) {
        expect(phase.maxShift).toBe(0);
        expect(phase.minOpacity).toBeLessThan(1);
      } else {
        expect(phase.maxShift).toBeGreaterThan(0);
        expect(phase.minOpacity).toBe(1);
      }
    }
  } finally { await screen.unmount(); }
});

test.each([false, true])("uses token timing and distinct Toast exit easing (reduce=%s)", async reduce => {
  await setMotion(reduce);
  const controller = createOperationNotificationController();
  const screen = await renderPwa(<PwaOperationNotifications controller={controller} />);
  try {
    controller.show("model_set-error");
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).not.toBeNull();
    const card = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    await expect.poll(() => getComputedStyle(card).opacity).toBe("1");
    expect(duration(card)).toBe(reduce ? 120 : 180);
    expect(getComputedStyle(card).fontSize).toBe("16px");
    expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : enterEase);
    (screen.getByRole("button", { name: "Dismiss operation notification" }).element() as HTMLElement).click();
    await expect.poll(() => card.style.getPropertyValue("--notifications-state-opacity")).toBe("0");
    expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : exitEase);
    expect(duration(card)).toBe(reduce ? 120 : 180);
    if (reduce) expectNoShift(card);
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { await screen.unmount(); }
});

// 注入 UA 信号但仍使用真实 React 与 Drawer；不模拟 Safari 的原生转场。
function nativePopstate() {
  const event = new PopStateEvent("popstate", { state: window.history.state });
  Object.defineProperty(event, "hasUAVisualTransition", { value: true });
  window.dispatchEvent(event);
}

test("native Back closes the tool reader before popstate returns, then ordinary closes animate again", async () => {
  await page.viewport(390, 844);
  let setOpened!: (value: boolean) => void;
  function Harness() {
    const [opened, update] = useState(false);
    setOpened = update;
    return <ToolReader value={tool} opened={opened} onClose={() => update(false)} />;
  }
  const screen = await renderPwa(<Harness />);
  const selector = ".pwa-tool-reader[role='dialog']";
  try {
    flushSync(() => setOpened(true));
    await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
    await expect.poll(() => getComputedStyle(document.querySelector(selector)!).opacity).toBe("1");
    nativePopstate();
    // 不等待轮询：UA 转场结束时目标界面必须已经提交，阅读器与遮罩都不再播放退出动画。
    expect(document.querySelector(selector)).toBeNull();
    expect(document.querySelector(".mantine-Drawer-overlay")).toBeNull();

    flushSync(() => setOpened(true));
    await expect.poll(() => window.history.state?.piReachToolReader).toBe(true);
    await expect.poll(() => getComputedStyle(document.querySelector(selector)!).opacity).toBe("1");
    flushSync(() => setOpened(false));
    expect(document.querySelector(selector)).not.toBeNull();
    await expect.poll(() => document.querySelector(selector)).toBeNull();
  } finally {
    await screen.unmount();
    // 合成事件没有真正弹出已压入的记录，清掉标记以免影响后续用例。
    window.history.replaceState(null, "");
  }
});
