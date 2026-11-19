import { useState, type ReactNode } from "react";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { SessionStatusDrawer } from "./session-status-drawer";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touch, touchReleaseAtRest } from "@/test/browser/swipe";
import { SessionStatusContent, formatStatusTokens } from "./session-status";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import type { SessionStatusView } from "@/lib/pwa/session-status";
import { DESKTOP_LAYOUT_QUERY, MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

const view: SessionStatusView = { kind: "ready", status: {
  context: { tokens: 84_000, window: 200_000, auto_compact: true, level: "normal" },
  usage: { input: 1_200_000, output: 48_000, cache_read: 840_000, cache_write: 120_000, cost: 0, cache_hit_rate_session: 87.5, cache_hit_rate_latest: 92.4 },
  branch: "feature/session-status", extensions: [{ key: "ci", label: "CI", text: "<b>plain text</b>" }],
} };
const status = { view, title: "Status example", deviceName: "Office", cwd: "/work/pi-reach" };

function Layout({ overlays = null, realSettings = false, statusAvailable = true }: { overlays?: ReactNode; realSettings?: boolean; statusAvailable?: boolean }) {
  const settings = useSettingsRoute();
  return <PwaWorkspaceLayout sessionStatus={statusAvailable ? status : undefined} navigation={{ devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {}, onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {} }} titleBar={{ title: status.title, showTitle: true }} toast={null} settingsRoute={realSettings ? settings.route : { open: false, change: 0, animate: false, origin: null }} onOpenSettings={settings.openSettings} onSettingsBack={settings.closeSettings} renderSettings={() => <h2>Settings content</h2>} overlays={overlays} closeBackgroundOverlay={close => close()}><div className="pwa-message-list">Conversation</div><div className="pwa-composer">Composer</div></PwaWorkspaceLayout>;
}

async function renderLayout(props: Parameters<typeof Layout>[0] = {}) {
  return render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout {...props} /></PwaAppShell></PwaUiProvider>);
}

function holdAnimationFrames() {
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  const requestSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    const id = request(() => {});
    pending.set(id, callback);
    return id;
  });
  const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => {
    pending.delete(id);
    cancel(id);
  });
  return () => {
    requestSpy.mockRestore();
    cancelSpy.mockRestore();
    for (const callback of pending.values()) callback(performance.now());
    pending.clear();
  };
}

function observeStatusSideEffects() {
  const push = vi.spyOn(window.history, "pushState");
  const locks: MutationRecord[] = [];
  const observer = new MutationObserver(records => locks.push(...records));
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-scroll-locked"], attributeOldValue: true });
  return {
    assertUnused() {
      locks.push(...observer.takeRecords());
      expect(push.mock.calls.some(([state]) => state?.piReachSessionStatus)).toBe(false);
      expect(push.mock.calls.filter(([state]) => state?.piReachSettings)).toHaveLength(1);
      expect(locks).toHaveLength(0);
      expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
    },
    restore() { observer.disconnect(); push.mockRestore(); },
  };
}

afterEach(async () => {
  await resetTouch();
  await cleanup();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBeUndefined();
  if (window.history.state?.piReachSettings) window.history.back();
  await expect.poll(() => window.history.state?.piReachSettings).toBeUndefined();
  await page.viewport(1280, 900);
});

test("formats the terminal token bands and renders extension status as plain text", async () => {
  expect([999, 1200, 48_000, 1_200_000, 12_000_000].map(formatStatusTokens)).toEqual(["999", "1.2k", "48k", "1.2M", "12M"]);
  const screen = await renderPwa(<SessionStatusContent {...status} mobile />);
  await expect.element(screen.getByText("42.0%")).toBeVisible();
  await expect.element(screen.getByText("$0.000")).toBeVisible();
  await expect.element(screen.getByText("87.5%")).toBeVisible();
  await expect.element(screen.getByText("92.4%")).toBeVisible();
  expect(document.querySelector(".pwa-session-status-content b")).toBeNull();
  await expect.element(screen.getByText("<b>plain text</b>")).toBeVisible();
});

test("desktop card reserves one shared conversation and notice lane and hides when too narrow", async () => {
  await page.viewport(1600, 900);
  await renderLayout();
  await expect.poll(() => document.querySelector(".pwa-main")?.hasAttribute("data-session-status-card")).toBe(true);
  const body = document.querySelector<HTMLElement>(".pwa-workspace-body")!;
  const notices = document.querySelector<HTMLElement>(".pwa-main-notices")!;
  expect(Math.round(body.getBoundingClientRect().right)).toBe(Math.round(notices.getBoundingClientRect().right));
  await page.viewport(1000, 500);
  await expect.poll(() => document.querySelector(".pwa-main")?.hasAttribute("data-session-status-card")).toBe(false);
});

test("mobile left-swipe preview rolls back without history, then commits and closes by system Back", async () => {
  await page.viewport(390, 700);
  await enableTouch();
  await renderLayout();
  const point = { x: 300, y: 350, id: 1 };
  const move = async (x: number) => {
    await touch("touchMove", [{ ...point, x }]);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  await touch("touchStart", [point]);
  await move(285);
  await move(245);
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")?.hasAttribute("data-swipe-drag")).toBe(true);
  expect(window.history.state?.piReachSessionStatus).toBeUndefined();
  expect(document.querySelector(".pwa-session-status-drawer")?.contains(document.activeElement)).toBe(false);
  await touchReleaseAtRest();
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")).toBeNull();
  await touch("touchStart", [point]);
  await move(285);
  await move(70);
  await touchReleaseAtRest();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBe(true);
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")?.hasAttribute("data-swipe-drag")).toBe(false);
  window.history.back();
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")).toBeNull();
});

test("crossing to desktop before the opening frame leaves settings and mobile drawers usable", async () => {
  await page.viewport(390, 700);
  const screen = await renderLayout({ realSettings: true });
  const resumeFrames = holdAnimationFrames();
  const effects = observeStatusSideEffects();
  try {
    try {
      // 原生点击同步进入真实布局入口，冻结挂载收起态和正式打开之间的那一帧。
      (screen.getByRole("button", { name: "Session status", exact: true }).element() as HTMLButtonElement).click();
      expect(window.history.state?.piReachSessionStatus).toBeUndefined();
      await page.viewport(1280, 700);
      await expect.poll(() => window.matchMedia(DESKTOP_LAYOUT_QUERY).matches).toBe(true);
    } finally {
      resumeFrames();
    }
    await screen.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect.poll(() => Boolean(window.history.state?.piReachSettings)).toBe(true);
    effects.assertUnused();
  } finally {
    effects.restore();
  }
  window.history.back();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  await page.viewport(390, 700);
  await screen.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  document.querySelector<HTMLButtonElement>(".pwa-session-sheet .mantine-Drawer-close")!.click();
  await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  const trigger = screen.getByRole("button", { name: "Session status", exact: true });
  (trigger.element() as HTMLButtonElement).focus();
  await trigger.click();
  await expect.element(page.getByRole("dialog", { name: "Session status", exact: true })).toBeVisible();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBe(true);
  document.querySelector<HTMLButtonElement>(".pwa-session-status-drawer .mantine-Drawer-close")!.click();
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")).toBeNull();
  expect(window.history.state?.piReachSessionStatus).toBeUndefined();
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  expect(document.activeElement).toBe(trigger.element());
});

test("the opening frame discards a no-longer-mobile instance before a media change notification", async () => {
  await page.viewport(390, 700);
  const screen = await renderLayout({ realSettings: true });
  const resumeFrames = holdAnimationFrames();
  const effects = observeStatusSideEffects();
  const matchMedia = window.matchMedia.bind(window);
  let mobile = true;
  const mediaSpy = vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = matchMedia(query);
    if (!mobile && query === MOBILE_LAYOUT_QUERY) Object.defineProperty(media, "matches", { value: false });
    return media;
  });
  try {
    (screen.getByRole("button", { name: "Session status", exact: true }).element() as HTMLButtonElement).click();
    // 只改变回调读取到的实时结果，不给已登记的 MediaQueryList 派发 change。
    mobile = false;
    resumeFrames();
    mediaSpy.mockRestore();
    await page.viewport(1280, 700);
    await screen.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect.poll(() => Boolean(window.history.state?.piReachSettings)).toBe(true);
    effects.assertUnused();
  } finally {
    mediaSpy.mockRestore();
    resumeFrames();
    effects.restore();
  }
  window.history.back();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
});

test("a settings request during the unopened status frame is handed off once without status side effects", async () => {
  await page.viewport(390, 700);
  const screen = await renderLayout({ realSettings: true });
  const resumeFrames = holdAnimationFrames();
  const effects = observeStatusSideEffects();
  try {
    (screen.getByRole("button", { name: "Session status", exact: true }).element() as HTMLButtonElement).click();
    // 工作区入口与桌面快捷键共用 requestSettings；在一帧窗口内同步登记请求。
    document.querySelector<HTMLButtonElement>(".pwa-desktop-navigation .pwa-nav-settings")!.click();
    await expect.poll(() => Boolean(window.history.state?.piReachSettings)).toBe(true);
    effects.assertUnused();
  } finally {
    resumeFrames();
    effects.restore();
  }
  await expect.poll(() => document.querySelector(".pwa-settings-view")).not.toBeNull();
  expect(window.history.state?.piReachSessionStatus).toBeUndefined();
  window.history.back();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
});

test("crossing to desktop releases status history and the next settings route survives", async () => {
  await page.viewport(390, 700);
  const screen = await renderLayout({ realSettings: true });
  await screen.getByRole("button", { name: "Session status", exact: true }).click();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBe(true);
  await page.viewport(1280, 700);
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")).toBeNull();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBeUndefined();
  await screen.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect.poll(() => Boolean(window.history.state?.piReachSettings)).toBe(true);
  expect(window.history.state?.piReachSessionStatus).toBeUndefined();
  window.history.back();
  await expect.poll(() => window.history.state?.piReachSettings).toBeUndefined();
});

test("losing the active session while status is open releases history, scroll lock and navigation", async () => {
  await page.viewport(390, 700);
  const fixture = (available: boolean) => <PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout statusAvailable={available} /></PwaAppShell></PwaUiProvider>;
  const screen = await render(fixture(true));
  await screen.getByRole("button", { name: "Session status", exact: true }).click();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBe(true);
  await screen.rerender(fixture(false));
  expect(screen.getByText("<b>plain text</b>").query()).toBeNull();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBeUndefined();
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")).toBeNull();
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  await screen.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
});

test("an upper confirmation consumes Escape without closing status", async () => {
  function Harness() {
    const [opened, setOpened] = useState(true);
    const [confirm, setConfirm] = useState(false);
    return <><SessionStatusDrawer {...status} opened={opened} gesture={null} onClose={() => setOpened(false)} onExitTransitionEnd={() => {}} /><button onClick={() => setConfirm(true)}>Show confirmation</button><ConfirmActionDialog action={confirm ? { kind: "clear-local-data" } : null} pending={false} onConfirm={() => {}} onClose={() => setConfirm(false)} /></>;
  }
  const screen = await renderPwa(<Harness />);
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBe(true);
  (screen.getByRole("button", { name: "Show confirmation" }).element() as HTMLButtonElement).click();
  await expect.poll(() => document.querySelectorAll('[role="dialog"]').length).toBe(2);
  document.querySelector<HTMLElement>('.pwa-confirm-dialog button')?.focus();
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await expect.poll(() => document.querySelectorAll('[role="dialog"]').length).toBe(1);
  expect(window.history.state?.piReachSessionStatus).toBe(true);
  document.querySelector<HTMLElement>('.pwa-session-status-drawer button')?.click();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBeUndefined();
});

test("mobile status owns one history entry, closes on Escape, and restores its trigger", async () => {
  await page.viewport(390, 700);
  const screen = await renderLayout();
  const trigger = screen.getByRole("button", { name: "Session status", exact: true });
  (trigger.element() as HTMLElement).focus();
  await trigger.click();
  await expect.element(page.getByRole("dialog", { name: "Session status" })).toBeVisible();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBe(true);
  expect(document.querySelector(".pwa-session-status-drawer")?.closest(".pwa-root")).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await expect.poll(() => document.querySelector(".pwa-session-status-drawer")).toBeNull();
  await expect.poll(() => document.activeElement?.classList.contains("pwa-session-status-trigger")).toBe(true);
});
