import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { usePageTransition } from "./use-page-transition";

type Controls = {
  switchView: (open: boolean, animate?: boolean) => void;
  commit: (change: number, removeSettings?: boolean) => void;
  rerender: () => void;
};

async function renderTransition(initialOpen: boolean) {
  const settled: number[] = [];
  let controls!: Controls;
  function Harness() {
    const [route, setRoute] = useState({ open: initialOpen, change: 0, animate: true });
    const [mounted, setMounted] = useState(initialOpen);
    const [transitioning, setTransitioning] = useState(false);
    const [, setRevision] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const settingsRef = useRef<HTMLDivElement>(null);
    const scrimRef = useRef<HTMLDivElement>(null);
    controls = {
      switchView(open, animate = true) {
        flushSync(() => {
          setRoute((current) => ({ open, animate, change: current.change + 1 }));
          if (open) setMounted(true);
          setTransitioning(animate);
        });
      },
      commit(change, removeSettings = true) {
        if (change !== route.change) return;
        flushSync(() => {
          setTransitioning(false);
          if (!route.open && removeSettings) setMounted(false);
        });
      },
      rerender() { flushSync(() => setRevision((value) => value + 1)); },
    };
    // 将完成通知和静止态提交分开，确定性模拟父组件尚未提交的窗口。
    usePageTransition({ ...route, rootRef, workspaceRef, settingsRef, scrimRef, onSettled: (change) => settled.push(change) });
    return <div ref={rootRef} className="pwa-root" data-testid="transition-root" data-view={route.open ? "settings" : "workspace"} data-view-transition={transitioning || undefined} style={{ width: 390, height: 300, overflow: "hidden", display: "flex", flex: "none" }}>
      <div ref={workspaceRef} className="pwa-workspace-view">Workspace</div>
      {mounted ? <div ref={scrimRef} className="pwa-page-scrim" /> : null}
      {mounted ? <div ref={settingsRef} className="pwa-settings-view">Settings</div> : null}
    </div>;
  }
  const screen = await renderPwa(<Harness />);
  const root = screen.getByTestId("transition-root").element() as HTMLElement;
  const workspace = root.querySelector<HTMLElement>(".pwa-workspace-view")!;
  return { screen, root, workspace, settled, controls: () => controls };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const left = (element: HTMLElement, root: HTMLElement) => Math.round(element.getBoundingClientRect().left - root.getBoundingClientRect().left);
const settingsOf = (root: HTMLElement) => root.querySelector<HTMLElement>(".pwa-settings-view")!;
const scrimOpacity = (root: HTMLElement) => Number(getComputedStyle(root.querySelector<HTMLElement>(".pwa-page-scrim")!).opacity);
/** 覆盖模型下只有设置层与遮罩在动：以两者的当前状态描述转场位置。 */
const overlayState = (root: HTMLElement) => [left(settingsOf(root), root), scrimOpacity(root)];

async function finish(animations: Animation[]) {
  expect(animations).toHaveLength(2);
  animations.forEach((animation) => animation.finish());
  await Promise.all(animations.map((animation) => animation.finished));
  await nextFrame();
}

async function expectHeldFrames(check: () => void) {
  // 原实现会在第一个 RAF 撤销 fill；检查后续绘制帧，不能只看 finished 或最终 DOM。
  for (let frame = 0; frame < 3; frame += 1) {
    await nextFrame();
    check();
  }
}

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

test("holds the return end frame until React commits the settings unmount", async () => {
  const harness = await renderTransition(true);
  try {
    harness.controls().switchView(false);
    const settings = settingsOf(harness.root);
    const animations = harness.root.getAnimations({ subtree: true });
    await finish(animations);
    expect(harness.settled).toEqual([1]);
    await expectHeldFrames(() => {
      expect(harness.root.hasAttribute("data-view-transition")).toBe(true);
      expect(settings.isConnected).toBe(true);
      expect(left(settings, harness.root)).toBe(390);
      expect(scrimOpacity(harness.root)).toBe(0);
      expect(left(harness.workspace, harness.root)).toBe(0);
    });
    harness.controls().commit(1);
    expect(settings.isConnected).toBe(false);
    expect(harness.root.querySelector(".pwa-page-scrim")).toBeNull();
    expect(harness.root.hasAttribute("data-view-transition")).toBe(false);
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
    expect(harness.root.getAnimations({ subtree: true })).toHaveLength(0);
    expect(left(harness.workspace, harness.root)).toBe(0);
  } finally { await harness.screen.unmount(); }
});

test("holds the enter end frame until React commits the CSS-hidden workspace", async () => {
  const harness = await renderTransition(false);
  try {
    harness.controls().switchView(true);
    const settings = settingsOf(harness.root);
    const animations = harness.root.getAnimations({ subtree: true });
    await finish(animations);
    expect(harness.settled).toEqual([1]);
    await expectHeldFrames(() => {
      expect(harness.root.hasAttribute("data-view-transition")).toBe(true);
      expect(getComputedStyle(harness.workspace).visibility).toBe("visible");
      expect(left(harness.workspace, harness.root)).toBe(0);
      expect(left(settings, harness.root)).toBe(0);
      expect(scrimOpacity(harness.root)).toBe(1);
    });
    harness.controls().commit(1);
    expect(getComputedStyle(harness.workspace).visibility).toBe("hidden");
    expect(left(settings, harness.root)).toBe(0);
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
    expect(harness.root.getAnimations({ subtree: true })).toHaveLength(0);
  } finally { await harness.screen.unmount(); }
});

test("does not release a returning settings layer that is still connected", async () => {
  const harness = await renderTransition(true);
  try {
    harness.controls().switchView(false);
    const settings = settingsOf(harness.root);
    const animations = harness.root.getAnimations({ subtree: true });
    await finish(animations);
    harness.controls().commit(1, false);
    harness.controls().rerender();
    await expectHeldFrames(() => {
      expect(harness.root.hasAttribute("data-view-transition")).toBe(false);
      expect(settings.isConnected).toBe(true);
      expect(left(settings, harness.root)).toBe(390);
    });
    harness.controls().commit(1);
    expect(settings.isConnected).toBe(false);
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
  } finally { await harness.screen.unmount(); }
});

test.each([false, true])("reverses from the current position without settling an interrupted animation (initialOpen=%s)", async (initialOpen) => {
  const harness = await renderTransition(initialOpen);
  try {
    harness.controls().switchView(!initialOpen);
    const settings = settingsOf(harness.root);
    const interrupted = harness.root.getAnimations({ subtree: true });
    expect(interrupted).toHaveLength(2);
    interrupted.forEach((animation) => { animation.pause(); animation.currentTime = 80; });
    const before = overlayState(harness.root);
    expect(before[0]).toBeGreaterThan(0);
    expect(before[0]).toBeLessThan(390);
    expect(before[1]).toBeGreaterThan(0);
    expect(before[1]).toBeLessThan(1);
    expect(left(harness.workspace, harness.root)).toBe(0);
    harness.controls().switchView(initialOpen);
    const reversed = harness.root.getAnimations({ subtree: true });
    reversed.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
    expect(overlayState(harness.root)).toEqual(before);
    expect(interrupted.every((animation) => animation.playState === "idle")).toBe(true);
    await nextFrame();
    expect(harness.settled).toEqual([]);
    await finish(reversed);
    expect(harness.settled).toEqual([2]);
    harness.controls().commit(2);
    expect(reversed.every((animation) => animation.playState === "idle")).toBe(true);
    expect(settings.isConnected).toBe(initialOpen);
  } finally { await harness.screen.unmount(); }
});

test("ignores an old finished callback already queued when a new transition starts", async () => {
  const harness = await renderTransition(false);
  try {
    harness.controls().switchView(true);
    const old = harness.root.getAnimations({ subtree: true });
    old.forEach((animation) => animation.finish());
    // 在 finished 的 Promise 回调执行前切换，旧一轮不得通知父级或撤销新动画。
    harness.controls().switchView(false);
    const current = harness.root.getAnimations({ subtree: true });
    current.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
    await nextFrame();
    expect(harness.settled).toEqual([]);
    expect(current.every((animation) => animation.playState === "paused")).toBe(true);
    expect(left(settingsOf(harness.root), harness.root)).toBe(0);
    await finish(current);
    expect(harness.settled).toEqual([2]);
    harness.controls().commit(2);
    expect(current.every((animation) => animation.playState === "idle")).toBe(true);
  } finally { await harness.screen.unmount(); }
});

test.each([false, true])("reverses a held end frame without replaying or stale cleanup (initialOpen=%s)", async (initialOpen) => {
  const harness = await renderTransition(initialOpen);
  try {
    harness.controls().switchView(!initialOpen);
    const settings = settingsOf(harness.root);
    const old = harness.root.getAnimations({ subtree: true });
    await finish(old);
    harness.controls().rerender();
    expect(harness.root.getAnimations({ subtree: true })).toEqual(old);
    const before = overlayState(harness.root);
    harness.controls().switchView(initialOpen);
    const current = harness.root.getAnimations({ subtree: true });
    current.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
    expect(overlayState(harness.root)).toEqual(before);
    harness.controls().commit(1);
    await expectHeldFrames(() => {
      expect(harness.root.hasAttribute("data-view-transition")).toBe(true);
      expect(current.every((animation) => animation.playState === "paused")).toBe(true);
      expect(overlayState(harness.root)).toEqual(before);
    });
    await finish(current);
    expect(harness.settled).toEqual([1, 2]);
    harness.controls().commit(2);
    expect(current.every((animation) => animation.playState === "idle")).toBe(true);
    expect(settings.isConnected).toBe(initialOpen);
  } finally { await harness.screen.unmount(); }
});

test.each([false, true])("retains reduced-motion crossfade until the static commit (initialOpen=%s)", async (initialOpen) => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const harness = await renderTransition(initialOpen);
  try {
    harness.controls().switchView(!initialOpen);
    const settings = settingsOf(harness.root);
    const animations = harness.root.getAnimations({ subtree: true });
    for (const animation of animations) {
      expect(animation.effect!.getTiming().duration).toBe(120);
      expect(animation.effect!.getTiming().easing).toBe("cubic-bezier(0.2, 0, 0, 1)");
    }
    await finish(animations);
    await expectHeldFrames(() => {
      expect(left(harness.workspace, harness.root)).toBe(0);
      expect(left(settings, harness.root)).toBe(0);
      expect(Number(getComputedStyle(harness.workspace).opacity)).toBe(initialOpen ? 1 : 0);
      expect(Number(getComputedStyle(settings).opacity)).toBe(initialOpen ? 0 : 1);
    });
    harness.controls().commit(1);
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
    expect(settings.isConnected).toBe(!initialOpen);
  } finally { await harness.screen.unmount(); }
});

test("cancels an interrupted transition when the next change is non-animated", async () => {
  const harness = await renderTransition(false);
  try {
    harness.controls().switchView(true);
    const animations = harness.root.getAnimations({ subtree: true });
    harness.controls().switchView(false, false);
    await nextFrame();
    expect(harness.settled).toEqual([2]);
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
    harness.controls().commit(2);
    expect(settingsOf(harness.root)).toBeNull();
    expect(left(harness.workspace, harness.root)).toBe(0);
  } finally { await harness.screen.unmount(); }
});

test.each(["running", "queued", "held"] as const)("cancels %s animations on unmount without a late completion", async (phase) => {
  const harness = await renderTransition(false);
  harness.controls().switchView(true);
  const animations = harness.root.getAnimations({ subtree: true });
  if (phase === "queued") animations.forEach((animation) => animation.finish());
  if (phase === "held") await finish(animations);
  await harness.screen.unmount();
  const before = [...harness.settled];
  await expectHeldFrames(() => {
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
    expect(harness.settled).toEqual(before);
  });
  expect(harness.settled).toEqual(phase === "held" ? [1] : []);
});

test("takes the page transition easing from the standard easing token", async () => {
  const harness = await renderTransition(false);
  // 只在本用例内改写 token，证明曲线来自 --pwa-ease-standard 而非写死的常量。
  const tokenEase = "cubic-bezier(0.1, 0.2, 0.3, 0.4)";
  document.documentElement.style.setProperty("--pwa-ease-standard", tokenEase);
  try {
    harness.controls().switchView(true);
    const animations = harness.root.getAnimations({ subtree: true });
    expect(animations).toHaveLength(2);
    animations.forEach((animation) => expect(animation.effect!.getTiming().easing).toBe(tokenEase));
  } finally {
    document.documentElement.style.removeProperty("--pwa-ease-standard");
    await harness.screen.unmount();
  }
});
