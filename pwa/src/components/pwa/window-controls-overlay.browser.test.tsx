import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { ConnectionStatus, type WorkspaceNavigationProps } from "./workspace-view";
import { SessionActionsMenu } from "./session-actions-menu";
import { ToolReader } from "./tool-reader";
import { PublishedFileReader } from "./published-file-reader";
import { PublishedFilesProvider, type PublishedFilesView } from "./published-files-context";
import { SettingsPage } from "./settings-page";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { isAppleKeyboard } from "@/lib/pwa/keyboard-shortcuts";

class OverlayFixture extends EventTarget {
  visible = true;
  rect = new DOMRect(84, 0, 1196, 32);
  getTitlebarAreaRect = vi.fn(() => this.rect);
  change(rect = this.rect, visible = this.visible) {
    this.rect = rect;
    this.visible = visible;
    this.dispatchEvent(new Event("geometrychange"));
  }
}

const navigation: WorkspaceNavigationProps = {
  devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true,
  onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {},
};

const fileView: PublishedFilesView = {
  scopeToken: {}, canFetch: false, active: false,
  getState: () => ({ phase: "ready", receivedBytes: 6, text: "Sample", preview: { kind: "text" }, url: "data:text/plain,Sample" }),
  open: async () => {}, cancel() {}, pin() {}, unpin() {},
};

function Harness() {
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const [reader, setReader] = useState<"tool" | "file" | null>(null);
  return <PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout navigation={navigation}
    titleBar={{ title: `会话 Session ${"很长名称 long title ".repeat(12)}`, prefix: `项目-${"directory-".repeat(20)}`, showTitle: true,
      status: <ConnectionStatus state="online" />, onRefresh: () => {},
      moreMenu: <SessionActionsMenu info={{ name: "Session", computer: "Computer", status: "Idle", cwd: "/workspace" }} /> }}
    historyMode={false} toast={null} settingsRoute={route} onOpenSettings={openSettings} onSettingsBack={closeSettings}
    renderSettings={({ backLabel, titleRef, onShowShortcuts }) => <SettingsPage onShowShortcuts={onShowShortcuts} relayUrl="https://relay.example.test" defaultRelayUrl="https://relay.example.test" relayVersion={null} relayStatus="offline" extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={async () => {}} onBack={closeSettings} backLabel={backLabel} titleRef={titleRef} onClearData={() => {}} onResetLayout={() => {}} />}
    overlays={<><ToolReader value={null} opened={reader === "tool"} onClose={() => setReader(null)} />{reader === "file" ? <PublishedFilesProvider value={fileView}><PublishedFileReader file={{ attachment_id: "sample", file_name: "sample.txt", mime_type: "text/plain", byte_length: 6, sha256: "0".repeat(64) }} opened onClose={() => setReader(null)} onExitTransitionEnd={() => {}} /></PublishedFilesProvider> : null}</>}
    closeBackgroundOverlay={close => close()}>
    <button onClick={() => setReader("tool")}>Open tool</button><button onClick={() => setReader("file")}>Open file</button>
    <textarea aria-label="Draft" defaultValue="Unsent" />
  </PwaWorkspaceLayout></PwaAppShell>;
}

const mount = () => render(<PwaUiProvider><Harness /></PwaUiProvider>);
const root = () => document.querySelector<HTMLElement>(".pwa-root")!;
const box = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
const settle = () => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
let overlay: OverlayFixture;
let originalOverlay: PropertyDescriptor | undefined;

beforeEach(async () => {
  await page.viewport(1280, 900);
  localStorage.removeItem("pi-reach-sidebar-collapsed");
  originalOverlay = Object.getOwnPropertyDescriptor(navigator, "windowControlsOverlay");
  overlay = new OverlayFixture();
  Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: overlay });
});
afterEach(async () => {
  await cleanup();
  if (originalOverlay) Object.defineProperty(navigator, "windowControlsOverlay", originalOverlay);
  else Reflect.deleteProperty(navigator, "windowControlsOverlay");
  Reflect.deleteProperty(document, "fullscreenElement");
  for (const name of ["top", "left", "right"]) document.documentElement.style.removeProperty(`--pwa-safe-${name}`);
  delete document.documentElement.dataset.pwaTextSize;
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

function expectClear(element = root()) {
  expect(element.hasAttribute("data-wco")).toBe(false);
  expect(element.hasAttribute("data-wco-sidebar-below")).toBe(false);
  expect(element.hasAttribute("data-wco-main-below")).toBe(false);
  for (const property of ["x", "y", "width", "height", "right"]) expect(element.style.getPropertyValue(`--pwa-wco-${property}`)).toBe("");
}

function expectControlsSafe(selector: string, rect = overlay.rect) {
  const element = document.querySelector<HTMLElement>(selector)!;
  const bounds = element.getBoundingClientRect();
  if (bounds.top < rect.y + rect.height) {
    expect(Math.round(bounds.left), selector).toBeGreaterThanOrEqual(Math.round(rect.x));
    expect(Math.round(bounds.right), selector).toBeLessThanOrEqual(Math.round(rect.x + rect.width));
  }
  expect(Math.round(bounds.bottom)).toBeLessThanOrEqual(window.innerHeight);
}

test.each(["missing", "hidden", "empty", "negative", "outside", "nonfinite", "throw"])("leaves ordinary flat windows untouched for %s API geometry", async mode => {
  if (mode === "missing") Reflect.deleteProperty(navigator, "windowControlsOverlay");
  if (mode === "hidden") overlay.visible = false;
  if (mode === "empty") overlay.rect = new DOMRect();
  if (mode === "negative") overlay.rect = new DOMRect(-1, 0, 1200, 32);
  if (mode === "outside") overlay.rect = new DOMRect(84, 0, 1280, 32);
  if (mode === "nonfinite") overlay.rect = new DOMRect(Number.NaN, 0, 1000, 32);
  if (mode === "throw") overlay.getTitlebarAreaRect.mockImplementation(() => { throw new Error("Unavailable"); });
  await mount();
  expectClear();
  expect(Math.round(box(".pwa-main").top)).toBe(0);
  expect(getComputedStyle(document.querySelector(".pwa-main")!).borderRadius).toBe("0px");
  expect(getComputedStyle(document.querySelector(".pwa-title-bar")!).getPropertyValue("-webkit-app-region")).not.toBe("drag");
});

test.each([768, 1280].flatMap(width => [
  { width, left: 84, right: 0 }, { width, left: 0, right: 156 }, { width, left: 84, right: 156 },
]))("avoids left $left and right $right controls at $width with both sidebar states and three text sizes", async ({ width, left, right }) => {
  await page.viewport(width, 900);
  overlay.rect = new DOMRect(left, 0, width - left - right, 32);
  const screen = await mount();
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(true);
  for (const size of ["standard", "large", "xlarge"]) {
    document.documentElement.dataset.pwaTextSize = size;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    for (const name of ["Collapse sidebar", "Expand sidebar"]) {
      await settle();
      expectControlsSafe(".pwa-sidebar-toggle");
      expectControlsSafe(".pwa-title-bar-refresh");
      expectControlsSafe(".pwa-title-bar-name");
      if (name === "Collapse sidebar") {
        for (const selector of [".pwa-sidebar-brand > svg", ".pwa-sidebar-brand > span"]) expectControlsSafe(selector);
        expect(Math.round(box(".pwa-sidebar-brand > span").right)).toBeLessThanOrEqual(Math.round(box(".pwa-sidebar-toggle").left));
      } else {
        expect(Math.round(box(".pwa-title-bar-name").left)).toBeGreaterThanOrEqual(Math.round(box(".pwa-sidebar-toggle").right));
      }
      for (const selector of [".pwa-title-bar-name", ".pwa-title-bar-project"]) {
        const line = document.querySelector<HTMLElement>(selector)!;
        expect(getComputedStyle(line).textOverflow).toBe("ellipsis");
        expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
      }
      expect(Math.round(box(".pwa-title-bar-project").bottom)).toBeLessThanOrEqual(Math.round(box(".pwa-title-bar").bottom - 6));
      const toggle = document.querySelector<HTMLElement>(".pwa-sidebar-toggle")!;
      const bounds = toggle.getBoundingClientRect();
      expect([Math.round(bounds.width), Math.round(bounds.height)]).toEqual([44, 44]);
      expect(toggle.contains(document.elementFromPoint(bounds.left + 22, bounds.top + 22))).toBe(true);
      await screen.getByRole("button", { name }).click();
    }
  }
  const bar = document.querySelector<HTMLElement>(".pwa-title-bar")!;
  expect(getComputedStyle(bar).getPropertyValue("-webkit-app-region")).toBe("drag");
  for (const selector of [".pwa-title-bar-refresh", ".pwa-sidebar-toggle", ".pwa-title-bar-name", ".pwa-title-bar-project"]) {
    expect(getComputedStyle(document.querySelector(selector)!).getPropertyValue("-webkit-app-region"), selector).toBe("no-drag");
  }
});

test("does not mistake the sidebar's exit transform for a narrower system titlebar lane", async () => {
  const screen = await mount();
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(true);
  expect(root().hasAttribute("data-wco-sidebar-below")).toBe(false);
  const top = Math.round(box(".pwa-sidebar-toggle").top);
  await screen.getByRole("button", { name: "Collapse sidebar" }).click();
  await settle();
  expect(root().hasAttribute("data-wco-sidebar-below")).toBe(false);
  await screen.getByRole("button", { name: "Expand sidebar" }).click();
  expect(Math.round(box(".pwa-sidebar-toggle").top)).toBe(top);
  await settle();
  expect(Math.round(box(".pwa-sidebar-toggle").top)).toBe(top);
});

test("updates geometry and resize, clears fullscreen/mobile/hidden state, and removes listeners on unmount", async () => {
  const remove = vi.spyOn(overlay, "removeEventListener");
  const screen = await mount();
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(true);
  overlay.change(new DOMRect(0, 4, 1124, 40));
  expect(root().style.getPropertyValue("--pwa-wco-right")).toBe("156px");
  expectControlsSafe(".pwa-title-bar-refresh");
  overlay.rect = new DOMRect(96, 0, 1028, 32);
  window.dispatchEvent(new Event("resize"));
  expect(root().style.getPropertyValue("--pwa-wco-x")).toBe("96px");
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
  document.dispatchEvent(new Event("fullscreenchange"));
  expectClear();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  document.dispatchEvent(new Event("fullscreenchange"));
  expect(root().hasAttribute("data-wco")).toBe(true);
  await page.viewport(390, 844);
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(false);
  expectClear();
  expect(Math.round(box(".pwa-title-bar").height)).toBe(48);
  expect(getComputedStyle(document.querySelector(".pwa-title-bar")!).getPropertyValue("-webkit-app-region")).not.toBe("drag");
  await page.viewport(1280, 900);
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(true);
  overlay.change(overlay.rect, false);
  expectClear();
  overlay.change(new DOMRect(0, 0, 1280, 0), true);
  expectClear();
  overlay.change(new DOMRect(84, 0, 1040, 32));
  const element = root();
  await screen.unmount();
  expectClear(element);
  expect(remove).toHaveBeenCalledWith("geometrychange", expect.any(Function));
  const calls = overlay.getTitlebarAreaRect.mock.calls.length;
  overlay.change(); window.dispatchEvent(new Event("resize")); document.dispatchEvent(new Event("fullscreenchange"));
  expect(overlay.getTitlebarAreaRect.mock.calls.length).toBe(calls);
});

test("moves only insufficient header lanes below the real system band and never leaves old padding", async () => {
  overlay.rect = new DOMRect(232, 0, 1048, 36);
  const screen = await mount();
  await expect.poll(() => root().hasAttribute("data-wco-sidebar-below")).toBe(true);
  expect(Math.round(box(".pwa-sidebar-brand").top)).toBeGreaterThanOrEqual(36);
  expectControlsSafe(".pwa-sidebar-toggle");
  await screen.getByRole("button", { name: "Collapse sidebar" }).click();
  overlay.change(new DOMRect(1200, 0, 80, 36));
  await expect.poll(() => root().hasAttribute("data-wco-main-below")).toBe(true);
  expect(Math.round(box(".pwa-sidebar-toggle").top)).toBeGreaterThanOrEqual(36);
  expect(Math.round(box(".pwa-title-bar-refresh").top)).toBeGreaterThanOrEqual(36);
  overlay.change(new DOMRect(0, 0, 1124, 32));
  await expect.poll(() => root().hasAttribute("data-wco-main-below")).toBe(false);
  expect(Math.round(box(".pwa-sidebar-toggle").left)).toBe(8);
  expect(Math.round(box(".pwa-sidebar-toggle").top)).toBe(2);
});

test("keeps safe areas, settings return and both reader close/save bands below system controls", async () => {
  document.documentElement.style.setProperty("--pwa-safe-left", "24px");
  document.documentElement.style.setProperty("--pwa-safe-right", "24px");
  document.documentElement.style.setProperty("--pwa-safe-top", "16px");
  overlay.rect = new DOMRect(84, 4, 1040, 40);
  const screen = await mount();
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(true);
  expectControlsSafe(".pwa-sidebar-toggle");
  expectControlsSafe(".pwa-title-bar-refresh");
  await screen.getByRole("button", { name: "Open settings" }).click();
  await expect.element(screen.getByRole("button", { name: "Back to workspace" })).toBeVisible();
  await settle();
  expect(Math.round(screen.getByRole("button", { name: "Back to workspace" }).element().getBoundingClientRect().top)).toBeGreaterThanOrEqual(44);
  await screen.getByRole("button", { name: "Back to workspace" }).click();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  for (const kind of ["tool", "file"]) {
    await screen.getByRole("button", { name: `Open ${kind}` }).click();
    await expect.poll(() => document.querySelector(".pwa-tool-reader-header, .pwa-file-reader-header")).not.toBeNull();
    await settle();
    if (kind === "file") await expect.element(screen.getByRole("link", { name: "Save" })).toBeVisible();
    for (const button of document.querySelectorAll<HTMLElement>(".pwa-tool-reader-header button, .pwa-tool-reader-header a, .pwa-file-reader-header button, .pwa-file-reader-header a")) {
      const bounds = button.getBoundingClientRect();
      expect(Math.round(bounds.top)).toBeGreaterThanOrEqual(44);
      expect(button.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => window.history.state?.piReachToolReader ?? window.history.state?.piReachFileReader).toBeUndefined();
    await expect.poll(() => document.querySelector(".pwa-tool-reader-header, .pwa-file-reader-header")).toBeNull();
  }
});

test("keeps centered keyboard help inside a short WCO window without moving its close target under system controls", async () => {
  await page.viewport(768, 440);
  overlay.rect = new DOMRect(84, 4, 528, 40);
  document.documentElement.dataset.pwaTextSize = "xlarge";
  const screen = await mount();
  await expect.poll(() => root().hasAttribute("data-wco")).toBe(true);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true, metaKey: isAppleKeyboard(), ctrlKey: !isAppleKeyboard() }));
  const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect.element(help).toBeVisible();
  await settle();
  const bounds = help.element().getBoundingClientRect();
  expect(Math.round(bounds.top)).toBeGreaterThanOrEqual(44);
  expect(Math.round(bounds.bottom)).toBeLessThanOrEqual(440);
  expect(help.element().closest(".pwa-root")).toBe(root());
  await userEvent.keyboard("{Escape}");
  await expect.element(help).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus();
});

test("unmounts only the title's mobile info entry and open Portal on desktop resize", async () => {
  await page.viewport(390, 844);
  const screen = await mount();
  await screen.getByRole("button", { name: "Session details" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Session details" })).toBeVisible();
  await page.viewport(1280, 900);
  await expect.poll(() => document.querySelector(".pwa-session-actions-dropdown")).toBeNull();
  expect(document.querySelector(".pwa-title-bar .pwa-session-actions-trigger")).toBeNull();
  await page.viewport(390, 844);
  await expect.element(screen.getByRole("button", { name: "Session details" })).toBeVisible();
  expect(document.querySelector(".pwa-session-actions-dropdown")).toBeNull();
});
