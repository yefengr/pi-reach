import { useState, type ReactNode } from "react";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { SessionStatusDrawer } from "./session-status-drawer";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touch, touchReleaseAtRest } from "@/test/browser/swipe";
import { SessionStatusContent, formatStatusTokens } from "./session-status";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import type { SessionStatusView } from "@/lib/pwa/session-status";

const view: SessionStatusView = { kind: "ready", status: {
  context: { tokens: 84_000, window: 200_000, auto_compact: true, level: "normal" },
  usage: { input: 1_200_000, output: 48_000, cache_read: 840_000, cache_write: 120_000, cost: 0, cache_hit_rate_session: 87.5, cache_hit_rate_latest: 92.4 },
  branch: "feature/session-status", extensions: [{ key: "ci", label: "CI", text: "<b>plain text</b>" }],
} };
const status = { view, title: "Status example", deviceName: "Office", cwd: "/work/pi-reach" };

function Layout({ overlays = null, realSettings = false }: { overlays?: ReactNode; realSettings?: boolean }) {
  const settings = useSettingsRoute();
  return <PwaWorkspaceLayout sessionStatus={status} navigation={{ devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {}, onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {} }} titleBar={{ title: status.title, showTitle: true }} toast={null} settingsRoute={realSettings ? settings.route : { open: false, change: 0, animate: false, origin: null }} onOpenSettings={settings.openSettings} onSettingsBack={settings.closeSettings} renderSettings={() => <h2>Settings content</h2>} overlays={overlays} closeBackgroundOverlay={close => close()}><div className="pwa-message-list">Conversation</div><div className="pwa-composer">Composer</div></PwaWorkspaceLayout>;
}

async function renderLayout(props: Parameters<typeof Layout>[0] = {}) {
  return render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout {...props} /></PwaAppShell></PwaUiProvider>);
}

afterEach(async () => {
  await resetTouch();
  await cleanup();
  await expect.poll(() => window.history.state?.piReachSessionStatus).toBeUndefined();
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
