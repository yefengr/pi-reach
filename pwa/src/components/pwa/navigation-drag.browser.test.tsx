import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { enableTouch, resetTouch, touch, type TouchPoint } from "@/test/browser/swipe";
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

let mounted: Awaited<ReturnType<typeof render>> | undefined;
let showConfirmation: () => void;

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
const offset = () => Math.round(sheet()!.getBoundingClientRect().left);
const trigger = () => document.querySelector<HTMLElement>(".pwa-session-trigger")!;
const navigationOpen = () => trigger().getAttribute("aria-expanded") === "true";

async function openNavigation(): Promise<TouchPoint> {
  mounted = await render(<Harness />);
  trigger().focus();
  trigger().click();
  await expect.poll(() => Math.round(sheet()?.getBoundingClientRect().left ?? -1)).toBe(0);
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  const rect = sheet()!.getBoundingClientRect();
  return { x: rect.right - 40, y: rect.top + 500, id: 1 };
}
/** CDP 触摸事件与渲染帧异步对齐；等两帧后再断言位置，避免读到上一步。 */
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function moveTouch(origin: TouchPoint, dx: number) {
  await touch("touchMove", [{ ...origin, x: origin.x + dx }]);
  await frames();
}
/** dx 为向左的正位移；先走过方向锁定帧再分步到位，不松手。 */
async function dragLeft(origin: TouchPoint, dx: number) {
  await touch("touchStart", [origin]);
  await moveTouch(origin, -LOCK_STEP);
  for (let step = 1; step <= 4; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await moveTouch(origin, -(LOCK_STEP + (dx - LOCK_STEP) * step / 4));
  }
}
const release = () => touch("touchEnd", []);
async function closed() {
  await expect.poll(navigationOpen).toBe(false);
  await expect.poll(() => sheet()).toBeNull();
}

beforeEach(async () => {
  window.history.replaceState(null, "", "/app");
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  await page.viewport(390, 700);
  await enableTouch();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await resetTouch();
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

test("D3 navigation follows the finger leftwards and dims the scrim", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 112);
  expect(offset()).toBe(-100);
  const scrim = document.querySelector<HTMLElement>(".pwa-scrim")!;
  expect(Number(getComputedStyle(scrim).opacity)).toBeCloseTo(1 - 100 / sheet()!.offsetWidth, 1);
  expect(navigationOpen()).toBe(true);
  await release();
  await closed();
  expect(document.activeElement).toBe(trigger());
}, 15000);

test("D3 navigation never moves right of its start when the finger reverses", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 60);
  await moveTouch(origin, 30);
  expect(offset()).toBe(0);
  await release();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(offset()).toBe(0);
  expect(navigationOpen()).toBe(true);
}, 15000);

test("D3 navigation springs back below the threshold with no animation residue", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 50);
  await release();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(offset()).toBe(0);
  expect(document.querySelector(".pwa-scrim")!.getAnimations()).toHaveLength(0);
  expect(navigationOpen()).toBe(true);
}, 15000);

test("D3 navigation closes from the dragged position without flashing back", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 140);
  const positions: number[] = [];
  const sample = setInterval(() => { if (sheet()) positions.push(Math.round(sheet()!.getBoundingClientRect().left)); }, 8);
  await release();
  await closed();
  clearInterval(sample);
  expect(Math.max(...positions)).toBeLessThan(-100);
  expect(positions).toEqual([...positions].sort((a, b) => b - a));
}, 15000);

test("D3 a confirmation raised before the close request rolls the navigation back and keeps the normal exit", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 140);
  await release();
  showConfirmation();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")?.getClientRects().length ?? 0).toBeGreaterThan(0);
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(offset()).toBe(0);
  expect(navigationOpen()).toBe(true);
  await mounted!.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  document.querySelector<HTMLElement>(".pwa-navigation-close")!.click();
  // 被拒绝的手势不得留下即时退出：按钮关闭仍有完整退出动画。
  expect(sheet()).not.toBeNull();
  await closed();
}, 15000);

test("D3 Escape during the drag continues closing from the current position", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 90);
  const before = offset();
  expect(before).toBeLessThan(-50);
  const positions: number[] = [];
  const sample = setInterval(() => { if (sheet()) positions.push(offset()); }, 8);
  await userEvent.keyboard("{Escape}");
  await closed();
  clearInterval(sample);
  // Mantine 的退出过渡不得盖过收尾动画：位置从拖动处单调走向关闭终点，不回到 0。
  expect(Math.max(...positions)).toBeLessThanOrEqual(before);
  expect(positions).toEqual([...positions].sort((a, b) => b - a));
  await release();
  expect(navigationOpen()).toBe(false);
}, 15000);

test("D3 reopening before the same Drawer exits clears the old drag and permits another gesture", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 112);
  const original = sheet()!;
  expect(original.hasAttribute("data-swipe-drag-active")).toBe(true);
  // 只冻结 Mantine 的退出卸载定时器；真实 RAF、WAAPI 与键盘事件继续执行。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await userEvent.keyboard("{Escape}");
  const oldAnimations = original.getAnimations();
  expect(oldAnimations.length).toBeGreaterThan(0);
  expect(navigationOpen()).toBe(false);
  expect(sheet()).toBe(original);
  flushSync(() => trigger().click());
  expect(navigationOpen()).toBe(true);
  expect(sheet()).toBe(original);
  await expect.poll(offset).toBe(0);
  expect(original.hasAttribute("data-swipe-drag-active")).toBe(false);
  expect(oldAnimations.every((animation) => animation.playState === "idle")).toBe(true);
  // 同 DOM 与旧动画取消已确认，再让重开的 Mantine 进入定时器完成并恢复真实计时。
  await frames();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await expect.poll(() => original.getAnimations().length).toBe(0);
  await expect.poll(() => document.querySelector(".pwa-scrim")!.getAnimations().length).toBe(0);
  await release();
  await dragLeft(origin, 50);
  expect(offset()).toBe(-38);
  await release();
  await expect.poll(() => original.getAnimations().length).toBe(0);
  expect(offset()).toBe(0);
  expect(navigationOpen()).toBe(true);
}, 15000);

test("D3 a second press while settling does not start a new drag", async () => {
  const origin = await openNavigation();
  await dragLeft(origin, 50);
  await release();
  await touch("touchStart", [origin]);
  await moveTouch(origin, -LOCK_STEP);
  await moveTouch(origin, -140);
  await release();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(offset()).toBe(0);
  expect(navigationOpen()).toBe(true);
}, 15000);
