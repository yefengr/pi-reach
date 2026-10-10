import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { enableTouch, resetTouch, touch, type TouchPoint } from "@/test/browser/swipe";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { SettingsPage } from "./settings-page";
import type { WorkspaceNavigationProps } from "./workspace-view";

const device = { id: "computer", deviceId: "computer-key", nickname: "Swipe computer", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01" };
const navigation: WorkspaceNavigationProps = {
  devices: [device], endpoints: [],
  history: Array.from({ length: 12 }, (_, index) => ({ id: `saved-${index}`, deviceId: device.deviceId, endpointId: "old", sessionId: `saved-${index}`, leafId: null, startedAt: index, updatedAt: index, eventCount: 2, preview: `Saved conversation ${index}` })),
  activeDeviceId: device.id, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {},
  onPair: () => {}, onSettings: () => {}, onSelectDevice: () => {}, onSelectEndpoint: () => {}, onSelectHistory: () => {}, onRename: () => {}, onRemove: () => {},
};
const LOCK_STEP = 12;
const DOWN_X = 100;
const marker = "settings-drag-base";

let enterSettings: () => void;
let mounted: Awaited<ReturnType<typeof render>> | undefined;

function Harness() {
  const { route, openSettings, closeSettings } = useSettingsRoute();
  useLayoutEffect(() => { enterSettings = () => flushSync(() => openSettings({ kind: "workspace" })); }, [openSettings]);
  return <PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout
    navigation={navigation} titleBar={{ title: "Swipe Pi", showTitle: true }} historyMode={false} toast={null}
    settingsRoute={route} onOpenSettings={openSettings} onSettingsBack={closeSettings}
    renderSettings={({ backLabel, titleRef }) => <SettingsPage relayUrl={device.relayUrl} defaultRelayUrl={device.relayUrl} relayVersion={null} relayStatus="offline" extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={async () => {}} onBack={closeSettings} backLabel={backLabel} titleRef={titleRef} onClearData={() => {}} onResetLayout={() => {}} />}
    overlays={null}
    closeBackgroundOverlay={(close) => close()}
  ><p>Workspace reading content</p></PwaWorkspaceLayout></PwaAppShell></PwaUiProvider>;
}
const root = () => document.querySelector<HTMLElement>(".pwa-root")!;
const settings = () => document.querySelector<HTMLElement>(".pwa-settings-view");
const workspace = () => document.querySelector<HTMLElement>(".pwa-workspace-view")!;
const settingsOpen = () => root().dataset.view === "settings";
const settingsLeft = () => Math.round(settings()!.getBoundingClientRect().left);
const workspaceLeft = () => Math.round(workspace().getBoundingClientRect().left);
const scrim = () => document.querySelector<HTMLElement>(".pwa-page-scrim");
const scrimOpacity = () => Number(getComputedStyle(scrim()!).opacity);
const trigger = () => document.querySelector<HTMLElement>(".pwa-session-trigger")!;
const sheet = () => document.querySelector<HTMLElement>(".pwa-session-sheet");
const inTransition = () => root().hasAttribute("data-view-transition");

async function openFromWorkspace(): Promise<TouchPoint> {
  mounted = await render(<Harness />);
  trigger().focus();
  enterSettings();
  await expect.poll(inTransition).toBe(false);
  return settingsOrigin();
}
async function openFromNavigation(): Promise<TouchPoint> {
  mounted = await render(<Harness />);
  trigger().focus();
  trigger().click();
  await expect.poll(() => Math.round(sheet()?.getBoundingClientRect().left ?? -1)).toBe(0);
  await mounted.getByRole("button", { name: "Open settings" }).click();
  await expect.poll(inTransition).toBe(false);
  await expect.poll(() => window.history.state?.piReachSettings?.origin?.kind).toBe("navigation");
  return settingsOrigin();
}
function settingsOrigin(): TouchPoint {
  const rect = settings()!.getBoundingClientRect();
  return { x: DOWN_X, y: rect.top + 500, id: 1 };
}
/** CDP 触摸事件与渲染帧异步对齐；等两帧后再断言位置，避免读到上一步。 */
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function moveTouch(origin: TouchPoint, dx: number) {
  await touch("touchMove", [{ ...origin, x: origin.x + dx }]);
  await frames();
}
async function dragTo(origin: TouchPoint, dx: number) {
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  for (let step = 1; step <= 4; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await moveTouch(origin, LOCK_STEP + (dx - LOCK_STEP) * step / 4);
  }
}
const release = () => touch("touchEnd", []);
async function returned() {
  await expect.poll(settingsOpen).toBe(false);
  await expect.poll(() => settings()).toBeNull();
  expect(window.location.pathname).toBe("/app");
  expect(window.history.state).toEqual({ swipeBase: marker });
}
const layerAnimations = () => [...(settings()?.getAnimations() ?? []), ...(scrim()?.getAnimations() ?? []), ...workspace().getAnimations()];

beforeEach(async () => {
  window.history.replaceState({ swipeBase: marker }, "", "/app");
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  await page.viewport(390, 700);
  await enableTouch();
});
afterEach(async () => {
  await resetTouch();
  vi.restoreAllMocks();
  if (window.history.state?.piReachSettings) {
    window.history.back();
    await expect.poll(() => window.history.state?.piReachSettings).toBeUndefined();
  }
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

test("D4 settings follow the finger over the stationary workspace while the scrim fades", async () => {
  const origin = await openFromWorkspace();
  // 静止铺满时为直角，跟手拖动时朝向工作区的左侧两角为 12。
  expect(getComputedStyle(settings()!).borderRadius).toBe("0px");
  await dragTo(origin, 112);
  expect(settingsLeft()).toBe(100);
  expect(getComputedStyle(settings()!).borderRadius).toBe("12px 0px 0px 12px");
  expect(workspaceLeft()).toBe(0);
  expect(workspace().getAnimations()).toHaveLength(0);
  expect(scrimOpacity()).toBeCloseTo(1 - 100 / window.innerWidth, 2);
  expect(getComputedStyle(scrim()!).pointerEvents).toBe("none");
  expect(getComputedStyle(settings()!).boxShadow).not.toBe("none");
  expect(inTransition()).toBe(true);
  expect(getComputedStyle(workspace()).visibility).toBe("visible");
  expect(settingsOpen()).toBe(true);
  expect(window.history.state.piReachSettings).toBeDefined();
  await release();
  await returned();
  await expect.element(mounted!.getByRole("button", { name: "Open navigation" })).toHaveFocus();
}, 15000);

test("D4 return plays from the dragged position without flashing back", async () => {
  const origin = await openFromWorkspace();
  await dragTo(origin, 140);
  const positions: number[] = [];
  const sample = setInterval(() => { const node = settings(); if (node) positions.push(Math.round(node.getBoundingClientRect().left)); }, 8);
  await release();
  await returned();
  clearInterval(sample);
  expect(Math.min(...positions)).toBeGreaterThan(100);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}, 15000);

test("D4 springs back below the threshold and leaves the settings page as the only visible view", async () => {
  const origin = await openFromWorkspace();
  await dragTo(origin, 50);
  await release();
  await expect.poll(inTransition).toBe(false);
  await expect.poll(() => layerAnimations().length).toBe(0);
  expect(settingsLeft()).toBe(0);
  expect(getComputedStyle(workspace()).visibility).toBe("hidden");
  expect(settingsOpen()).toBe(true);
  expect(window.history.state.piReachSettings).toBeDefined();
}, 15000);

test("D4 reversing the finger clamps at the start", async () => {
  const origin = await openFromWorkspace();
  await dragTo(origin, 60);
  await moveTouch(origin, -30);
  expect(settingsLeft()).toBe(0);
  await release();
  await expect.poll(inTransition).toBe(false);
  expect(settingsOpen()).toBe(true);
}, 15000);

test("D4 a touchcancel mid-drag springs back instead of staying halfway", async () => {
  const origin = await openFromWorkspace();
  await dragTo(origin, 80);
  await touch("touchCancel", []);
  await expect.poll(inTransition).toBe(false);
  expect(settingsLeft()).toBe(0);
  expect(layerAnimations()).toHaveLength(0);
  expect(settingsOpen()).toBe(true);
}, 15000);

test("D4 popstate mid-drag hands the layers to the route transition from the current position", async () => {
  const origin = await openFromWorkspace();
  await dragTo(origin, 90);
  const before = settingsLeft();
  const back = vi.spyOn(window.history, "back");
  window.history.back();
  await returned();
  expect(before).toBeGreaterThan(50);
  expect(back).toHaveBeenCalledOnce();
  // 松手时设置页早已返回：不得再次触发返回，也不留下动画。
  await release();
  expect(window.history.state).toEqual({ swipeBase: marker });
  expect(layerAnimations()).toHaveLength(0);
}, 15000);

test("D4 restores the settings page when the route never changes after the commit", async () => {
  const origin = await openFromWorkspace();
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  await dragTo(origin, 140);
  await release();
  await expect.poll(() => layerAnimations().length === 0 && !inTransition(), { timeout: 4000 }).toBe(true);
  expect(settingsLeft()).toBe(0);
  expect(settingsOpen()).toBe(true);
  expect(getComputedStyle(workspace()).visibility).toBe("hidden");
}, 15000);

test("D4 a second press while committed does not start another drag", async () => {
  const origin = await openFromWorkspace();
  await dragTo(origin, 140);
  await release();
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  await moveTouch(origin, 120);
  await release();
  await returned();
}, 15000);

test("D4 a drag that starts inside the left edge band keeps the trigger behaviour", async () => {
  const origin = await openFromWorkspace();
  const edge = { ...origin, x: 8 };
  await touch("touchStart", [edge]);
  await moveTouch(edge, LOCK_STEP);
  await moveTouch(edge, 60);
  expect(settingsLeft()).toBe(0);
  await moveTouch(edge, 130);
  await release();
  await returned();
}, 15000);

test("D4 from navigation previews the expanded navigation, keeps focus until commit, then focuses its settings entry", async () => {
  const origin = await openFromNavigation();
  const focusBefore = document.activeElement;
  await dragTo(origin, 112);
  expect(sheet()).not.toBeNull();
  expect(sheet()!.closest(".pwa-workspace-view")).toBe(workspace());
  // 预览只是视觉：焦点仍在设置页，滚动锁与焦点陷阱都没有启用。
  expect(document.activeElement).toBe(focusBefore);
  expect(settings()!.contains(document.activeElement)).toBe(true);
  expect(document.body.style.overflow).not.toBe("hidden");
  await release();
  await returned();
  await expect.poll(() => document.activeElement?.matches(".pwa-nav-settings")).toBe(true);
  expect(sheet()!.contains(document.activeElement)).toBe(true);
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
}, 15000);

test("D4 from navigation rolls back by removing the preview and any pending focus request", async () => {
  const origin = await openFromNavigation();
  const focusBefore = document.activeElement;
  await dragTo(origin, 50);
  expect(sheet()).not.toBeNull();
  await release();
  await expect.poll(inTransition).toBe(false);
  await expect.poll(() => sheet()).toBeNull();
  expect(settingsOpen()).toBe(true);
  expect(document.activeElement).toBe(focusBefore);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  // 回弹后即便再次渲染，也不会有遗留的聚焦请求抢走焦点。
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(document.activeElement).toBe(focusBefore);
}, 15000);
