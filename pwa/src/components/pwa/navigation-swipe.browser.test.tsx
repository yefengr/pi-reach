import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { enableTouch, resetTouch, syntheticCapture, syntheticSwipe, touchDrag, touchOrigin, touchTap } from "@/test/browser/swipe";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { SettingsPage } from "./settings-page";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "./confirm-action-dialog";
import type { WorkspaceNavigationProps } from "./workspace-view";

const device = { id: "computer", deviceId: "computer-key", nickname: "Swipe computer", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01" };
const navigation: WorkspaceNavigationProps = {
  devices: [device], endpoints: [],
  history: Array.from({ length: 35 }, (_, index) => ({ id: `saved-${index}`, deviceId: device.deviceId, endpointId: "old", sessionId: `saved-${index}`, leafId: null, startedAt: index, updatedAt: index, eventCount: 2, preview: `Saved conversation ${index}` })),
  activeDeviceId: device.id, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {},
  onPair: () => {}, onSettings: () => {}, onSelectDevice: () => {}, onSelectEndpoint: () => {}, onSelectHistory: () => {}, onRename: () => {}, onRemove: () => {},
};
let enterSettings: () => void;
let showConfirmation: (action: ConfirmActionDialogAction | null) => void;
let mounted: Awaited<ReturnType<typeof render>> | undefined;
const marker = "navigation-swipe-base";

function Harness({ select }: { select: () => void }) {
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const [confirmation, setConfirmation] = useState<ConfirmActionDialogAction | null>(null);
  useLayoutEffect(() => {
    enterSettings = () => openSettings({ kind: "workspace" });
    showConfirmation = setConfirmation;
  }, [openSettings]);
  return <PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout
    navigation={{ ...navigation, onSelectHistory: select, onRemove: (target) => setConfirmation({ kind: "remove-pairing", label: target.nickname! }) }}
    titleBar={{ title: "Swipe Pi", showTitle: true }} historyMode={false} toast={null}
    settingsRoute={route} onOpenSettings={openSettings} onSettingsBack={closeSettings}
    renderSettings={({ backLabel, titleRef }) => <SettingsPage relayUrl={device.relayUrl} defaultRelayUrl={device.relayUrl} relayVersion={null} relayStatus="offline" extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={async () => {}} onBack={closeSettings} backLabel={backLabel} titleRef={titleRef} onClearData={() => setConfirmation({ kind: "clear-local-data" })} onResetLayout={() => {}} />}
    overlays={<ConfirmActionDialog action={confirmation} pending={false} onConfirm={() => {}} onClose={() => setConfirmation(null)} />}
    closeBackgroundOverlay={(close) => close()}
  ><p>Workspace reading content</p></PwaWorkspaceLayout></PwaAppShell></PwaUiProvider>;
}
const root = () => document.querySelector<HTMLElement>(".pwa-root")!;
const navigationOpen = () => document.querySelector(".pwa-session-trigger")?.getAttribute("aria-expanded") === "true";
const settingsOpen = () => root().dataset.view === "settings";
const sheet = () => document.querySelector<HTMLElement>(".pwa-session-sheet")!;
const navigationScroll = () => sheet().querySelector<HTMLElement>(".pwa-navigation-scroll")!;
const settings = () => document.querySelector<HTMLElement>(".pwa-settings-view")!;
const settingsCopy = () => settings().querySelector<HTMLElement>(".pwa-settings-section-description")!;

async function setup() {
  const select = vi.fn();
  mounted = await render(<Harness select={select} />);
  return { screen: mounted, select };
}
async function openNavigation(screen: Awaited<ReturnType<typeof render>>, synthetic = true) {
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  trigger.element().focus();
  await trigger.click();
  await expect.poll(() => Math.round(sheet()?.getBoundingClientRect().left ?? -1)).toBe(0);
  if (synthetic) syntheticCapture(sheet());
  return trigger;
}
async function openSettings(synthetic = true) {
  flushSync(enterSettings);
  await expect.poll(() => root().hasAttribute("data-view-transition")).toBe(false);
  if (synthetic) syntheticCapture(settings());
}
async function returned() {
  await expect.poll(settingsOpen).toBe(false);
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  expect(window.location.pathname).toBe("/app");
  expect(window.history.state).toEqual({ swipeBase: marker });
}

beforeEach(async () => {
  window.history.replaceState({ swipeBase: marker }, "", "/app");
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  window.getSelection()?.removeAllRanges();
  await page.viewport(390, 700);
  await enableTouch();
});
afterEach(async () => {
  await resetTouch();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  if (window.history.state?.piReachSettings) {
    window.history.back();
    await expect.poll(() => window.history.state?.piReachSettings).toBeUndefined();
  }
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

test("G2 left swipe closes the real navigation Drawer and restores its trigger focus; right swipe does not", async () => {
  const { screen } = await setup();
  const trigger = await openNavigation(screen);
  const row = navigationScroll().querySelector(".pwa-history-row")!;
  syntheticSwipe(row, 100);
  expect(navigationOpen()).toBe(true);
  syntheticSwipe(row, -100);
  await expect.poll(navigationOpen).toBe(false);
  await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  await expect.element(trigger).toHaveFocus();
});

test("G2 chooser and remove-pairing confirmation keep the underlying navigation open", async () => {
  const { screen } = await setup();
  await openNavigation(screen);
  await screen.getByRole("button", { name: "Choose computer, current Swipe computer" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
  syntheticSwipe(navigationScroll().querySelector(".pwa-history-row")!, -100);
  expect(navigationOpen()).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-device-drawer")).toBeNull();
  flushSync(() => showConfirmation({ kind: "remove-pairing", label: device.nickname }));
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")?.getClientRects().length ?? 0).toBeGreaterThan(0);
  expect(document.querySelector(".pwa-confirm-dialog")?.closest(".pwa-root")).toBe(root());
  syntheticSwipe(navigationScroll().querySelector(".pwa-history-row")!, -100);
  expect(navigationOpen()).toBe(true);
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  syntheticSwipe(navigationScroll().querySelector(".pwa-history-row")!, -100);
  await expect.poll(navigationOpen).toBe(false);
});

test("G3 synthetic settings swipe reuses workspace history return and restores focus", async () => {
  const { screen } = await setup();
  await openSettings();
  expect(window.history.state.piReachSettings.origin).toEqual({ kind: "workspace" });
  syntheticSwipe(settingsCopy());
  await returned();
  await expect.element(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
});

test.each(["synthetic", "CDP"] as const)("G3 %s settings return restores expanded navigation, saved scroll and settings focus", async (mode) => {
  const { screen } = await setup();
  await openNavigation(screen, mode === "synthetic");
  navigationScroll().scrollTop = 240;
  const scrollTop = navigationScroll().scrollTop;
  await screen.getByRole("button", { name: "Open settings" }).click();
  await expect.poll(() => root().hasAttribute("data-view-transition")).toBe(false);
  expect(window.history.state.piReachSettings.origin).toEqual({ kind: "navigation", scrollTop });
  if (mode === "synthetic") {
    syntheticCapture(settings());
    syntheticSwipe(settingsCopy());
  } else await touchDrag(touchOrigin(settingsCopy(), 32), 130, 0);
  await returned();
  expect(navigationOpen()).toBe(true);
  expect(Math.round(navigationScroll().scrollTop)).toBe(Math.round(scrollTop));
  await expect.element(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
});

test("G3 stays disabled while page transition is paused, then works once state settles", async () => {
  await setup();
  flushSync(() => {
    enterSettings();
  });
  const animations = [...settings().getAnimations(), ...document.querySelector(".pwa-page-scrim")!.getAnimations()];
  expect(animations.length).toBeGreaterThan(0);
  animations.forEach((animation) => animation.pause());
  expect(root().hasAttribute("data-view-transition")).toBe(true);
  syntheticCapture(settings());
  syntheticSwipe(settingsCopy());
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(settingsOpen()).toBe(true);
  expect(window.history.state.piReachSettings).toBeDefined();
  animations.forEach((animation) => animation.finish());
  await expect.poll(() => root().hasAttribute("data-view-transition")).toBe(false);
  syntheticSwipe(settingsCopy());
  await returned();
});

test("G3 excludes the real Relay input and blocks the clear-data modal without changing button return", async () => {
  const { screen } = await setup();
  await openSettings();
  syntheticSwipe(settings().querySelector('input[inputmode="url"]')!);
  expect(settingsOpen()).toBe(true);
  await screen.getByRole("button", { name: "Clear local data", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: /Clear this browser/ })).toBeVisible();
  syntheticSwipe(settingsCopy());
  expect(settingsOpen()).toBe(true);
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  await screen.getByRole("button", { name: "Back to workspace" }).click();
  await returned();
});

test("G2 CDP navigation-row swipe closes without clicking the row, while ordinary touch tap still selects", async () => {
  const { screen, select } = await setup();
  const trigger = await openNavigation(screen, false);
  const row = navigationScroll().querySelector<HTMLElement>(".pwa-history-row .pwa-nav-link-label")!;
  await touchDrag(touchOrigin(row, 210), -130, 0);
  await expect.poll(navigationOpen).toBe(false);
  await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  expect(select).not.toHaveBeenCalled();
  await expect.element(trigger).toHaveFocus();
  await openNavigation(screen, false);
  await touchTap(touchOrigin(navigationScroll().querySelector(".pwa-history-row .pwa-nav-link-label")!, 100));
  await expect.poll(() => select.mock.calls.length).toBe(1);
});

test("G2 CDP vertical navigation drag scrolls the real list without closing or selecting", async () => {
  const { screen, select } = await setup();
  await openNavigation(screen, false);
  const scroll = navigationScroll();
  expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await touchDrag(touchOrigin(scroll, 170, scroll.clientHeight - 70), 0, -190);
  await expect.poll(() => scroll.scrollTop).toBeGreaterThan(20);
  expect(navigationOpen()).toBe(true);
  expect(select).not.toHaveBeenCalled();
});

test("G3 CDP settings vertical drag scrolls without returning, then description swipe returns", async () => {
  await setup();
  await openSettings(false);
  const scroll = settings();
  expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await touchDrag(touchOrigin(scroll, 360, 590), 0, -190);
  await expect.poll(() => scroll.scrollTop).toBeGreaterThan(20);
  expect(settingsOpen()).toBe(true);
  expect(window.history.state.piReachSettings).toBeDefined();
  scroll.scrollTop = 0;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await touchDrag(touchOrigin(settingsCopy(), 32), 130, 0);
  await returned();
});
