import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { enableTouch, resetTouch, touch, touchDrag, touchOrigin, touchTap, type TouchPoint } from "@/test/browser/swipe";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { useConfirmationOverlay, type ConfirmActionRequest } from "./pwa-confirm-actions";
import type { WorkspaceNavigationProps } from "./workspace-view";

const device = { id: "computer", deviceId: "computer-key", nickname: "Swipe computer", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01" };
const navigation: WorkspaceNavigationProps = {
  devices: [device], endpoints: [],
  history: Array.from({ length: 12 }, (_, index) => ({ id: `saved-${index}`, deviceId: device.deviceId, endpointId: "old", sessionId: `saved-${index}`, leafId: null, startedAt: index, updatedAt: index, eventCount: 2, preview: `Saved conversation ${index}` })),
  activeDeviceId: device.id, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {},
  onPair: () => {}, onSettings: () => {}, onSelectDevice: () => {}, onSelectEndpoint: () => {}, onSelectHistory: () => {}, onRename: () => {}, onRemove: () => {},
};
const LOCK_STEP = 12;
// 本用例验证静止提交后的关闭；停稳采样避免 CDP 末段速度进入 Chromium 原生 fling。
const TOUCH_STOP_WINDOW_MS = 250;

// 记录组件库真正收到的退出入口，保留完整 Drawer 和 SessionSheet 副作用链。
const navigationLifecycle = vi.hoisted(() => ({ exit: undefined as (() => void) | undefined }));
vi.mock("@mantine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/core")>();
  const DrawerRoot = actual.Drawer.Root;
  return {
    ...actual,
    Drawer: Object.assign((props: Parameters<typeof actual.Drawer>[0]) => <actual.Drawer {...props} />, {
      ...actual.Drawer,
      Root: (props: Parameters<typeof actual.Drawer.Root>[0]) => {
        if (props.position === "left") navigationLifecycle.exit = props.onExitTransitionEnd;
        return <DrawerRoot {...props} />;
      },
    }),
  };
});

let mounted: Awaited<ReturnType<typeof render>> | undefined;
let showConfirmation: () => void;
let lastTouchPointerId: number | null = null;
const rememberTouchPointer = (event: PointerEvent) => {
  if (event.pointerType === "touch") lastTouchPointerId = event.pointerId;
};

function Harness() {
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const [confirmation, setConfirmation] = useState<ConfirmActionRequest | null>(null);
  const [, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const { requestConfirmation, closeBackgroundOverlay, finishConfirmationTransition } = useConfirmationOverlay(setConfirmation, setError, pendingRef);
  useLayoutEffect(() => { showConfirmation = () => flushSync(() => requestConfirmation({ kind: "clear-local-data" })); }, [requestConfirmation]);
  return <PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout
    navigation={navigation} titleBar={{ title: "Swipe Pi", showTitle: true }} historyMode={false} toast={null}
    settingsRoute={route} onOpenSettings={openSettings} onSettingsBack={closeSettings}
    renderSettings={() => <p>Settings</p>}
    overlays={<ConfirmActionDialog action={confirmation?.kind === "clear-local-data" ? { kind: "clear-local-data" } : null} pending={false} onConfirm={() => {}} onClose={() => setConfirmation(null)} onExitTransitionEnd={finishConfirmationTransition} />}
    closeBackgroundOverlay={closeBackgroundOverlay}
  ><p>Workspace reading content</p></PwaWorkspaceLayout></PwaAppShell></PwaUiProvider>;
}
const sheet = () => document.querySelector<HTMLElement>(".pwa-session-sheet");
const trigger = () => document.querySelector<HTMLElement>(".pwa-session-trigger")!;
const navigationOpen = () => trigger().getAttribute("aria-expanded") === "true";
const scrim = () => document.querySelector<HTMLElement>(".pwa-scrim");
const sheetWidth = () => sheet()!.offsetWidth;
const sheetLeft = () => Math.round(sheet()!.getBoundingClientRect().left);
const scrollLocked = () => document.body.style.overflow === "hidden" || document.body.hasAttribute("data-scroll-locked") || document.documentElement.hasAttribute("data-scroll-locked");
const DOWN_X = 100;
const DOWN_Y = 400;

/** CDP 触摸事件与渲染帧异步对齐；等两帧后再断言位置。 */
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function moveTouch(origin: TouchPoint, dx: number) {
  await touch("touchMove", [{ ...origin, x: origin.x + dx }]);
  await frames();
}
const origin: TouchPoint = { x: DOWN_X, y: DOWN_Y, id: 1 };
async function mount() {
  mounted = await render(<Harness />);
  await expect.poll(() => document.querySelector(".pwa-main")).not.toBeNull();
}
async function dragRight(dx: number) {
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  for (let step = 1; step <= 4; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await moveTouch(origin, LOCK_STEP + (dx - LOCK_STEP) * step / 4);
  }
}
const release = () => touch("touchEnd", []);
const escape = () => userEvent.keyboard("{Escape}");
/** 记录测试期间滚动锁是否曾经启用，用来证明被中止的打开收尾没有短暂启用过它。 */
function watchScrollLock() {
  const state = { everLocked: false };
  const observer = new MutationObserver(() => { if (scrollLocked()) state.everLocked = true; });
  for (const target of [document.body, document.documentElement]) observer.observe(target, { attributes: true });
  return Object.assign(state, { stop: () => observer.disconnect() });
}
function outsideButton() {
  const button = document.body.appendChild(document.createElement("button"));
  button.textContent = "outside focus";
  button.focus();
  return button;
}

beforeEach(async () => {
  window.history.replaceState(null, "", "/app");
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  await page.viewport(390, 700);
  await enableTouch();
  lastTouchPointerId = null;
  document.addEventListener("pointerdown", rememberTouchPointer, true);
});
afterEach(async () => {
  vi.useRealTimers();
  await resetTouch();
  document.removeEventListener("pointerdown", rememberTouchPointer, true);
  document.querySelectorAll("body > button").forEach((button) => button.remove());
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

async function committedNavigation() {
  await expect.poll(() => sheetLeft()).toBe(0);
  await expect.poll(() => sheet()?.hasAttribute("data-swipe-drag") ?? true).toBe(false);
  await expect.poll(() => sheet()?.contains(document.activeElement) ?? false).toBe(true);
  await expect.poll(scrollLocked).toBe(true);
}
async function closeNavigation(method: "button" | "scrim" | "swipe") {
  if (method === "button") {
    // fake timers 不推进原生 CSS/WAAPI；焦点进入及取整后的几何归零也不代表动画已结束。
    await expect.poll(() => [sheet()?.getAnimations().length, scrim()?.getAnimations().length]).toEqual([0, 0]);
    const button = document.querySelector<HTMLButtonElement>(".pwa-navigation-close")!;
    const point = touchOrigin(button);
    expect(button.disabled).toBe(false);
    expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(getComputedStyle(button).pointerEvents).not.toBe("none");
    expect(button.contains(document.elementFromPoint(point.x, point.y))).toBe(true);
    expect(sheet()!.hasAttribute("data-swipe-drag-active")).toBe(false);
    if (lastTouchPointerId !== null) {
      expect(sheet()!.hasPointerCapture(lastTouchPointerId)).toBe(false);
      expect(document.querySelector(".pwa-main")!.hasPointerCapture(lastTouchPointerId)).toBe(false);
    }
    await touchTap(point);
  } else if (method === "scrim") await touchTap({ x: 365, y: DOWN_Y, id: 1 });
  else await touchDrag(touchOrigin(sheet()!, sheetWidth() - 40, 500), -140, 0);
  await expect.poll(navigationOpen).toBe(false);
  await expect.poll(sheet).toBeNull();
  await expect.poll(() => document.activeElement).toBe(trigger());
  await expect.poll(scrollLocked).toBe(false);
}
const reopenCases = (["button", "swipe"] as const).flatMap((initialOpen) =>
  (["button", "scrim", "swipe"] as const).map((close) => ({ initialOpen, close })),
);
test.each(reopenCases)("D5 reopens through three real touch cycles (initial: $initialOpen, close: $close)", async ({ initialOpen, close }) => {
  await mount();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    trigger().focus();
    if (cycle === 0 && initialOpen === "button") await touchTap(touchOrigin(trigger()));
    else {
      await dragRight(140);
      expect(sheet()).not.toBeNull();
      expect(sheet()!.hasAttribute("data-swipe-drag")).toBe(true);
      expect(sheetLeft()).toBe(-sheetWidth() + 128);
      expect(document.activeElement).toBe(trigger());
      expect(scrollLocked()).toBe(false);
      await release();
    }
    await committedNavigation();
    await closeNavigation(close);
  }
}, 30000);

test("D5 fast reopen survives a stale exit callback without releasing the new gesture", async () => {
  await mount();
  trigger().focus();
  await touchTap(touchOrigin(trigger()));
  await committedNavigation();
  const original = sheet()!;
  // 只冻结 Mantine 退出定时器；CDP、RAF 与原生动画继续工作。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await touchTap(touchOrigin(document.querySelector(".pwa-navigation-close")!));
  expect(navigationOpen()).toBe(false);
  expect(sheet()).toBe(original);
  const oldExit = navigationLifecycle.exit!;
  trigger().focus();
  await userEvent.keyboard("{Enter}");
  expect(navigationOpen()).toBe(true);
  await frames();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await committedNavigation();
  flushSync(oldExit);
  expect(sheet()).toBe(original);
  expect(sheet()!.contains(document.activeElement)).toBe(true);
  expect(navigationOpen()).toBe(true);
  expect(scrollLocked()).toBe(true);
  await closeNavigation("button");
  trigger().focus();
  await dragRight(112);
  const preview = sheet()!;
  flushSync(oldExit);
  expect(sheet()).toBe(preview);
  expect(preview.hasAttribute("data-swipe-drag")).toBe(true);
  expect(sheetLeft()).toBe(-sheetWidth() + 100);
  expect(document.activeElement).toBe(trigger());
  expect(scrollLocked()).toBe(false);
  await moveTouch(origin, 140);
  expect(sheetLeft()).toBe(-sheetWidth() + 128);
  // 保持同一真实触点并发送静止采样，模拟停稳后松手；不把下一次 tap 用于停止原生 fling。
  const stopUntil = performance.now() + TOUCH_STOP_WINDOW_MS;
  while (performance.now() < stopUntil) {
    await moveTouch(origin, 140);
    expect(sheet()).toBe(preview);
    expect(preview.hasAttribute("data-swipe-drag")).toBe(true);
    expect(sheetLeft()).toBe(-sheetWidth() + 128);
  }
  await release();
  await committedNavigation();
  await closeNavigation("button");
}, 30000);

test("D5 navigation opens under the finger from off-screen with a preview that does not touch focus or scroll", async () => {
  await mount();
  const outside = outsideButton();
  await dragRight(112);
  expect(sheetLeft()).toBe(-sheetWidth() + 100);
  expect(Number(getComputedStyle(scrim()!).opacity)).toBeCloseTo(100 / sheetWidth(), 1);
  expect(sheet()!.hasAttribute("data-swipe-drag")).toBe(true);
  expect(document.activeElement).toBe(outside);
  expect(scrollLocked()).toBe(false);
  await release();
  await expect.poll(() => sheet()!.hasAttribute("data-swipe-drag")).toBe(false);
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(sheetLeft()).toBe(0);
  expect(navigationOpen()).toBe(true);
}, 15000);

test("D5 commit moves focus into the navigation, locks scrolling, and a normal close returns focus to the trigger", async () => {
  await mount();
  outsideButton();
  await dragRight(140);
  await release();
  await expect.poll(() => sheet()?.contains(document.activeElement) ?? false).toBe(true);
  await expect.poll(scrollLocked).toBe(true);
  expect(scrim()!.getAnimations()).toHaveLength(0);
  document.querySelector<HTMLElement>(".pwa-navigation-close")!.click();
  await expect.poll(() => sheet()).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(scrollLocked()).toBe(false);
}, 15000);

test.each(["other element", "body"] as const)("D5 springs back below the threshold without moving focus (start focus: %s)", async (focusAt) => {
  await mount();
  const outside = focusAt === "other element" ? outsideButton() : null;
  if (!outside) (document.activeElement as HTMLElement | null)?.blur();
  const expected = outside ?? document.body;
  await dragRight(50);
  expect(navigationOpen()).toBe(true);
  await release();
  await expect.poll(() => sheet()).toBeNull();
  await expect.poll(navigationOpen).toBe(false);
  expect(document.activeElement).toBe(expected);
  await expect.poll(scrollLocked).toBe(false);
  expect(document.querySelector("[data-swipe-drag]")).toBeNull();
  // 跳过回焦标记已消费：之后一次正常的拖动打开再关闭仍回到触发按钮。
  await dragRight(140);
  await release();
  await expect.poll(() => sheet()?.contains(document.activeElement) ?? false).toBe(true);
  document.querySelector<HTMLElement>(".pwa-navigation-close")!.click();
  await expect.poll(() => sheet()).toBeNull();
  expect(document.activeElement).toBe(trigger());
}, 30000);

test("D5 reversing the finger clamps at the closed start", async () => {
  await mount();
  await dragRight(60);
  await moveTouch(origin, -30);
  expect(sheetLeft()).toBe(-sheetWidth());
  await release();
  await expect.poll(() => sheet()).toBeNull();
  expect(navigationOpen()).toBe(false);
}, 15000);

test("D5 a touchcancel mid-drag removes the preview", async () => {
  await mount();
  const outside = outsideButton();
  await dragRight(80);
  await touch("touchCancel", []);
  await expect.poll(() => sheet()).toBeNull();
  expect(navigationOpen()).toBe(false);
  expect(document.activeElement).toBe(outside);
}, 15000);

test("D5 an external close during the drag keeps the content mounted while it slides back, and the release does not reopen it", async () => {
  await mount();
  const lock = watchScrollLock();
  trigger().focus();
  await dragRight(112);
  expect(document.activeElement).toBe(trigger());
  const width = sheetWidth();
  const positions: number[] = [];
  const sample = setInterval(() => { if (sheet()) positions.push(sheetLeft()); }, 8);
  await escape();
  await expect.poll(navigationOpen).toBe(false);
  // 收尾期间内容仍挂载，从当前位置朝关闭起点移动，不朝打开终点。
  expect(sheet()).not.toBeNull();
  await moveTouch(origin, 180);
  await release();
  await expect.poll(() => sheet()).toBeNull();
  clearInterval(sample);
  expect(navigationOpen()).toBe(false);
  expect(Math.max(...positions)).toBeLessThanOrEqual(-width + 100);
  expect(positions).toEqual([...positions].sort((a, b) => b - a));
  expect(document.querySelector("[data-swipe-drag]")).toBeNull();
  lock.stop();
  expect(lock.everLocked).toBe(false);
}, 15000);

test("D5 an external close while the opening settles never enables the focus trap or scroll lock", async () => {
  await mount();
  const outside = outsideButton();
  const lock = watchScrollLock();
  await dragRight(140);
  const surface = sheet()!;
  const animate = surface.animate.bind(surface);
  // 只暂停本次原生打开收尾，避免 CDP 松手／键盘往返耗尽竞态窗口；回弹仍用真实动画。
  const opening = vi.spyOn(surface, "animate").mockImplementation((keyframes, options) => {
    const animation = animate(keyframes, options);
    animation.pause();
    return animation;
  });
  await release();
  expect(opening).toHaveBeenCalledOnce();
  opening.mockRestore();
  expect(surface.hasAttribute("data-swipe-drag")).toBe(true);
  expect(surface.getAnimations().some((animation) => animation.playState === "paused")).toBe(true);
  expect(document.activeElement).toBe(outside);
  await escape();
  await expect.poll(() => sheet()).toBeNull();
  expect(navigationOpen()).toBe(false);
  // 旧打开收尾被中止：既没有把焦点拉进导航，也没有启用过滚动锁。
  lock.stop();
  expect(lock.everLocked).toBe(false);
  expect(document.activeElement).toBe(outside);
  // 手势状态已完全复位：可以再次拖动打开。
  await dragRight(140);
  await release();
  await expect.poll(() => sheet()?.contains(document.activeElement) ?? false).toBe(true);
}, 30000);

test("D5 a confirmation raised during the opening gesture owns the first real Escape", async () => {
  await mount();
  trigger().focus();
  await dragRight(112);
  showConfirmation();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")?.getClientRects().length ?? 0).toBeGreaterThan(0);
  await escape();
  expect(navigationOpen()).toBe(true);
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  await escape();
  await expect.poll(navigationOpen).toBe(false);
  await release();
  await expect.poll(() => sheet()).toBeNull();
}, 15000);

test("D5 opening gesture ignores consumed and composing Escape events from external focus", async () => {
  await mount();
  trigger().focus();
  await dragRight(112);
  const consume = (event: KeyboardEvent) => event.preventDefault();
  trigger().addEventListener("keydown", consume, { once: true });
  await escape();
  expect(navigationOpen()).toBe(true);
  trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
  expect(navigationOpen()).toBe(true);
  await escape();
  await expect.poll(navigationOpen).toBe(false);
  await release();
  await expect.poll(() => sheet()).toBeNull();
}, 15000);

test("D5 a drag starting inside the left edge band keeps the trigger behaviour", async () => {
  await mount();
  const edge = { ...origin, x: 8 };
  await touch("touchStart", [edge]);
  await moveTouch(edge, LOCK_STEP);
  await moveTouch(edge, 60);
  expect(sheet()).toBeNull();
  await moveTouch(edge, 130);
  await release();
  await expect.poll(navigationOpen).toBe(true);
  await expect.poll(() => Math.round(sheet()?.getBoundingClientRect().left ?? -1)).toBe(0);
}, 15000);

test("D5 a confirmation dialog blocks the drag from starting", async () => {
  await mount();
  showConfirmation();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")?.getClientRects().length ?? 0).toBeGreaterThan(0);
  await dragRight(140);
  await release();
  expect(sheet()).toBeNull();
  expect(navigationOpen()).toBe(false);
}, 15000);
