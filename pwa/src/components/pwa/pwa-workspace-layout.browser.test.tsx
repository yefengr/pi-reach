import { useState } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaConnectionBanner } from "./pwa-app-actions";
import { useToast } from "./pwa-operation-notifications";
import { ServiceWorkerNotice } from "./service-worker-register";
import { SettingsPage } from "./settings-page";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { ConnectionStatus, type WorkspaceNavigationProps } from "./workspace-view";
import { UnpairedWorkspace } from "./workspace-content";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";

const device: PwaDeviceRecord = {
  id: "device:office",
  deviceId: "office-device-id",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  nickname: "Office Pi",
};
const endpoints: PwaEndpointRecord[] = [
  { id: "endpoint:main", deviceId: device.deviceId, endpointId: "main", runtimeInstanceId: "main-runtime", kind: "interactive", name: "Main Pi", online: true, updatedAt: 1 },
  { id: "endpoint:other", deviceId: device.deviceId, endpointId: "other", runtimeInstanceId: "other-runtime", kind: "interactive", name: "Other Pi", online: true, updatedAt: 2 },
];
const history: TimelineSessionSummary[] = [];
const longHistory: TimelineSessionSummary[] = Array.from({ length: 20 }, (_, index) => ({
  id: `history:${index}`, deviceId: device.deviceId, endpointId: "main", runtimeInstanceId: "main-runtime", sessionId: `session-${index}`, leafId: null, selfSenderRef: "self", channelId: "channel",
  startedAt: index, updatedAt: Date.now() - index * 60_000, eventCount: 2, preview: `Saved conversation ${index}`,
}));

type LayoutHarnessProps = {
  events: string[];
  rejectClose?: boolean;
  historyMode?: boolean;
  runtimeNotice?: boolean;
  connectionBanner?: "relay" | "network";
  title?: string;
  unpaired?: boolean;
  computers?: Pick<WorkspaceNavigationProps, "devices" | "activeDeviceId" | "pairingPresence">;
  savedHistory?: TimelineSessionSummary[];
};

function LayoutHarness({ events, rejectClose = false, historyMode = false, runtimeNotice = false, connectionBanner, title = "Main Pi", unpaired = false, computers, savedHistory = history }: LayoutHarnessProps) {
  const [count, setCount] = useState(0);
  const [noticeVisible, setNoticeVisible] = useState(runtimeNotice);
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const navigation: WorkspaceNavigationProps = {
    devices: unpaired ? [] : [device],
    endpoints: unpaired ? [] : endpoints,
    history: savedHistory,
    activeDeviceId: unpaired ? null : device.id,
    activeEndpointId: unpaired ? null : "main",
    selectedHistoryId: null,
    snapshotReady: true,
    pairingPresence: { [device.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 } },
    ...computers,
    onPair: () => events.push("pair"),
    onSettings: () => events.push("settings"),
    onSelectDevice: (deviceId) => events.push(`device:${deviceId}`),
    onSelectEndpoint: (endpointId) => events.push(`endpoint:${endpointId}`),
    onSelectHistory: (entry) => events.push(`history:${entry.id}`),
    onRename: (target) => events.push(`rename:${target.id}`),
    onRemove: (target) => events.push(`remove:${target.id}`),
  };

  return <PwaAppShell runtimeNotice={noticeVisible && <ServiceWorkerNotice installPrompt unsupported={false} onInstall={() => {}} onDismiss={() => setNoticeVisible(false)} />}><PwaWorkspaceLayout
    navigation={navigation}
    titleBar={unpaired ? { title: "Navigation", showTitle: false } : historyMode ? { title: "Saved Pi", showTitle: true, kicker: "Local history · Read only" } : { title, showTitle: true, status: <ConnectionStatus state="online" /> }}
    historyMode={historyMode}
    connectionBanner={connectionBanner ? <PwaConnectionBanner kind={connectionBanner} connection="retrying" onRetry={() => events.push("retry")} /> : null}
    toast={unpaired ? null : <div data-testid="toast">Toast</div>}
    settingsRoute={route}
    onSettingsBack={closeSettings}
    onOpenSettings={(origin) => { events.push(`settings:${origin.kind}`); openSettings(origin); }}
    renderSettings={({ backLabel, titleRef }) => <SettingsPage relayUrl="https://relay.example.test" defaultRelayUrl="https://relay.example.test" relayVersion={null} relayStatus="offline" extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={async () => {}} onBack={closeSettings} backLabel={backLabel} titleRef={titleRef} onClearData={() => setConfirmOpen(true)} onResetLayout={() => {}} />}
    overlays={<ConfirmActionDialog action={confirmOpen ? { kind: "clear-local-data" } : null} pending={false} error={null} onConfirm={() => {}} onClose={() => setConfirmOpen(false)} />}
    closeBackgroundOverlay={(close) => { events.push("close-request"); if (!rejectClose) close(); }}
  >
    {connectionBanner ? <ToastTrigger events={events} /> : null}{unpaired ? <UnpairedWorkspace onPair={navigation.onPair} /> : <button type="button" data-testid="stateful-child" onClick={() => setCount((value) => value + 1)}>Child count {count}</button>}
  </PwaWorkspaceLayout></PwaAppShell>;
}

const LONG_TOAST = "The model change could not be confirmed because the connection dropped while Pi was replying; check the computer and try again.";

function ToastTrigger({ events }: { events: string[] }) {
  const toast = useToast();
  return <>
    <button type="button" onClick={() => toast?.show("model_set-error")}>Show toast</button>
    <button type="button" onClick={() => toast?.notify(LONG_TOAST, { kind: "info", action: { label: "Undo", onClick: () => events.push("toast-action") } })}>Show long toast</button>
  </>;
}

function overlaps(a: DOMRect, b: DOMRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// 按坐标命中后派发完整点击序列；Playwright 的 click 遇到遮挡会滚动重试，会掩盖浮层拦截。
function clickAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y)!;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerType: "mouse", isPrimary: true };
  target.dispatchEvent(new PointerEvent("pointerdown", init));
  target.dispatchEvent(new MouseEvent("mousedown", init));
  target.dispatchEvent(new PointerEvent("pointerup", init));
  target.dispatchEvent(new MouseEvent("mouseup", init));
  target.dispatchEvent(new MouseEvent("click", init));
}

function renderLayout(props: LayoutHarnessProps) {
  return render(<PwaUiProvider><LayoutHarness {...props} /></PwaUiProvider>);
}

test.each([[1280, 844], [844, 390]])("keeps the sidebar toggle clear of brand and navigation rows at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const screen = await renderLayout({ events: [], savedHistory: longHistory });
  const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
  await expect.element(toggle).toBeVisible();
  const box = toggle.element().getBoundingClientRect();
  const brandCopy = [...document.querySelectorAll<HTMLElement>(".pwa-desktop-navigation .pwa-sidebar-brand > *")];
  const rows = [...document.querySelectorAll<HTMLElement>(".pwa-desktop-navigation .pwa-navigation-scroll a, .pwa-desktop-navigation .pwa-navigation-scroll button")];
  expect(rows.length).toBeGreaterThan(20);
  for (const element of [...brandCopy, ...rows]) {
    const rect = element.getBoundingClientRect();
    const overlaps = rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
    expect(overlaps, element.textContent ?? "").toBe(false);
  }
  const scroll = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-navigation-scroll")!.getBoundingClientRect();
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    if (y < scroll.top || y > scroll.bottom) continue;
    expect(row.contains(document.elementFromPoint(rect.right - 4, y)), row.textContent ?? "").toBe(true);
  }
});

test.each([[1280, 844], [844, 390]])("real clicks on the right edge of every visible history row select it without collapsing the sidebar at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const events: string[] = [];
  const screen = await renderLayout({ events, savedHistory: longHistory });
  await expect.element(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  const scroll = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-navigation-scroll")!;
  let clicked = 0;
  for (const offset of [0, scroll.scrollHeight / 3, scroll.scrollHeight]) {
    scroll.scrollTop = offset;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const area = scroll.getBoundingClientRect();
    const rows = longHistory.map((entry) => ({ entry, row: screen.getByRole("button", { name: new RegExp(`^${entry.preview}(?!\\d)`) }).element() as HTMLElement }))
      .filter(({ row }) => { const rect = row.getBoundingClientRect(); return rect.bottom > area.top + 8 && rect.top < area.bottom - 8; });
    for (const { entry, row } of rows) {
      clicked += 1;
      const rect = row.getBoundingClientRect();
      const visibleMiddle = (Math.max(rect.top, area.top) + Math.min(rect.bottom, area.bottom)) / 2;
      for (const inset of [6, 24, 44]) {
        events.length = 0;
        clickAt(rect.right - inset, visibleMiddle);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(events, `${entry.id} at right - ${inset}px`).toEqual([`history:${entry.id}`]);
        expect(document.querySelector(".pwa-root")!.hasAttribute("data-sidebar-collapsed")).toBe(false);
      }
    }
  }
  expect(clicked).toBeGreaterThanOrEqual(width === 1280 ? 12 : 4);
});

test.each([
  { width: 1280, height: 844, title: "Main Pi" },
  { width: 1280, height: 844, title: `Main Pi ${"with a very long conversation title ".repeat(8)}` },
  { width: 844, height: 390, title: `Main Pi ${"with a very long conversation title ".repeat(8)}` },
  { width: 768, height: 900, title: `主会话${"很长的会话名称".repeat(12)}` },
])("keeps the collapsed toggle clear of the title and its actions at $width×$height for a $title.length-character title", async ({ width, height, title }) => {
  await page.viewport(width, height);
  const screen = await renderLayout({ events: [], title });
  await screen.getByRole("button", { name: "Collapse sidebar" }).click();
  const toggle = screen.getByRole("button", { name: "Expand sidebar" }).element();
  await expect.poll(() => Math.round(toggle.getBoundingClientRect().left)).toBe(8);
  await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  const box = toggle.getBoundingClientRect();
  const name = document.querySelector<HTMLElement>(".pwa-title-bar-name")!;
  const actions = document.querySelector<HTMLElement>(".pwa-title-bar-actions")!;
  expect(overlaps(box, document.querySelector(".pwa-title-bar-heading")!.getBoundingClientRect())).toBe(false);
  expect(overlaps(box, actions.getBoundingClientRect())).toBe(false);
  expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(actions.getBoundingClientRect().left);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const heading = name.getBoundingClientRect();
  expect(name.contains(document.elementFromPoint(heading.left + 4, heading.top + heading.height / 2))).toBe(true);
  expect(toggle.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true);
});

test("keeps the toggle in the header band and on top throughout both sidebar transitions", async () => {
  await page.viewport(1280, 844);
  const screen = await renderLayout({ events: [], savedHistory: longHistory });
  const toggle = screen.getByRole("button", { name: "Collapse sidebar" }).element() as HTMLElement;
  await expect.element(page.elementLocator(toggle)).toBeVisible();
  const start = toggle.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>(".pwa-desktop-navigation .pwa-navigation-scroll a, .pwa-desktop-navigation .pwa-navigation-scroll button")];
  const brandCopy = [...document.querySelectorAll<HTMLElement>(".pwa-desktop-navigation .pwa-sidebar-brand > *")];
  for (const name of ["Collapse sidebar", "Expand sidebar"]) {
    await screen.getByRole("button", { name }).click();
    let frames = 0;
    const until = performance.now() + 400;
    while (performance.now() < until) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames += 1;
      const box = toggle.getBoundingClientRect();
      expect(box.top).toBe(start.top);
      expect(box.bottom).toBeLessThanOrEqual(56);
      expect(toggle.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true);
      for (const element of [...brandCopy, ...rows]) {
        if (getComputedStyle(element).visibility === "hidden") continue;
        expect(overlaps(box, element.getBoundingClientRect()), element.textContent ?? "").toBe(false);
      }
    }
    expect(frames).toBeGreaterThan(5);
  }
});

const toastCases = [
  { width: 1280, height: 844, banner: "relay", long: false, safeTop: 0 },
  { width: 1280, height: 844, banner: "network", long: true, safeTop: 0 },
  { width: 844, height: 390, banner: "relay", long: true, safeTop: 0 },
  { width: 390, height: 844, banner: "relay", long: false, safeTop: 0 },
  { width: 390, height: 844, banner: "network", long: true, safeTop: 0 },
  { width: 390, height: 844, banner: "relay", long: true, safeTop: 47 },
  { width: 390, height: 600, banner: "relay", long: true, safeTop: 47 },
] as const;

test.each(toastCases)("keeps the $width×$height toast (long: $long, safe top: $safeTop) clear of the $banner banner and runtime notice", async ({ width, height, banner, long, safeTop }) => {
  await page.viewport(width, height);
  try {
    const events: string[] = [];
    const screen = await renderLayout({ events, connectionBanner: banner, runtimeNotice: true });
    if (safeTop) {
      // 渲染后才出现的安全区只让标题区变高，用来验证提示区位移时 Toast 仍会重新避让。
      document.documentElement.style.setProperty("--pwa-safe-top", `${safeTop}px`);
      await expect.poll(() => Math.round(document.querySelector(".pwa-title-bar")!.getBoundingClientRect().height)).toBe(56 + safeTop);
    }
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeVisible();
    await expect.element(screen.getByRole("status", { name: "Install Pi Reach" })).toBeVisible();
    await screen.getByRole("button", { name: long ? "Show long toast" : "Show toast" }).click();
    await expect.poll(() => document.querySelector(".pwa-operation-notification")?.isConnected).toBe(true);
    const toast = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    await expect.element(page.elementLocator(toast)).toBeVisible();
    await expect.poll(() => toast.getBoundingClientRect().top).toBeGreaterThanOrEqual(document.querySelector(".pwa-main-notices")!.getBoundingClientRect().bottom);
    await expect.poll(() => getComputedStyle(toast).opacity).toBe("1");

    const box = toast.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(box.bottom).toBeLessThanOrEqual(height);
    const message = document.querySelector<HTMLElement>(".pwa-connection-banner-content > span")!;
    const covered = [message, retry.element(), document.querySelector<HTMLElement>(".pwa-runtime-notice")!, document.querySelector<HTMLElement>(".pwa-title-bar")!];
    for (const element of covered) expect(overlaps(box, element.getBoundingClientRect()), element.className).toBe(false);
    const main = document.querySelector(".pwa-main")!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(main.left + 15.5);
    expect(box.right).toBeLessThanOrEqual(main.right - 15.5);
    expect(Math.abs((box.left + box.right) / 2 - (main.left + main.right) / 2)).toBeLessThanOrEqual(1);
    if (width >= 768) expect(overlaps(box, document.querySelector(".pwa-desktop-navigation")!.getBoundingClientRect())).toBe(false);
    const text = message.getBoundingClientRect();
    expect(message.contains(document.elementFromPoint(text.left + 4, text.top + text.height / 2))).toBe(true);

    const button = retry.element().getBoundingClientRect();
    for (const y of [button.top + 2, button.top + button.height / 2, button.bottom - 2]) {
      expect(retry.element().contains(document.elementFromPoint(button.left + button.width / 2, y))).toBe(true);
    }
    await page.screenshot({ path: `../../../.vitest/screenshots/toast-banner-${width}x${height}-${banner}-${long ? "long" : "short"}-top${safeTop}.png` });
    await retry.click();
    expect(events).toContain("retry");
    if (long) {
      const action = screen.getByRole("button", { name: "Undo" });
      const actionBox = action.element().getBoundingClientRect();
      expect(action.element().scrollWidth).toBeLessThanOrEqual(action.element().clientWidth);
      expect(actionBox.height).toBeLessThanOrEqual(44);
      expect(actionBox.width).toBeGreaterThan(actionBox.height);
      expect(action.element().contains(document.elementFromPoint(actionBox.left + actionBox.width / 2, actionBox.top + actionBox.height / 2))).toBe(true);
      await action.click();
      expect(events).toContain("toast-action");
    }
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
  }
});

test.each([1280, 390])("keeps the notice below navigation/settings and confirmation overlays at $0px", async (width) => {
  await page.viewport(width, 844);
  const screen = await renderLayout({ events: [], runtimeNotice: true });
  const notice = screen.getByRole("status", { name: "Install Pi Reach" });
  await expect.element(notice).toBeVisible();
  const root = document.querySelector(".pwa-root")!;
  if (width === 390) {
    const navigation = screen.getByRole("button", { name: "Open navigation" });
    navigation.element().focus();
    await navigation.click();
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    expect(root.contains(dialog.element())).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(navigation).toHaveFocus();
    await navigation.click();
    // 点击打开先挂载收起态、下一帧才打开，等导航可见再操作其中的入口。
    await expect.element(screen.getByRole("dialog")).toBeVisible();
  }
  const settingsButton = screen.getByRole("button", { name: "Open settings" });
  settingsButton.element().focus();
  await settingsButton.click();
  const settings = screen.getByRole("main", { name: "Settings" });
  await expect.element(settings).toBeVisible();
  expect(root.contains(settings.element())).toBe(true);
  const clear = screen.getByRole("button", { name: "Clear local data", exact: true });
  clear.element().focus();
  await clear.click();
  const confirm = screen.getByRole("dialog", { name: /Clear this browser/ });
  await expect.element(confirm).toBeVisible();
  expect(root.contains(confirm.element())).toBe(true);
  // 设置页覆盖工作区时，工作区内的运行提示随工作区隐藏。
  await expect.poll(() => document.querySelector(".pwa-runtime-notice")!.checkVisibility({ visibilityProperty: true })).toBe(false);
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  await expect.element(clear).toHaveFocus();
  await expect.element(settings).toBeVisible();
  await screen.getByRole("button", { name: width === 390 ? "Back to navigation" : "Back to workspace" }).click();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  await expect.element(notice).toBeVisible();
  await screen.unmount();
});

beforeEach(async () => {
  window.history.replaceState(null, "");
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  await page.viewport(1280, 900);
});
afterEach(async () => {
  window.history.replaceState(null, "");
  await page.viewport(1280, 900);
});

test("preserves one main and the stateful workspace child through boundary and desktop/mobile viewport changes", async () => {
  const screen = await renderLayout({ events: [], runtimeNotice: true });
  const child = screen.getByTestId("stateful-child");
  const childElement = child.element();
  const sidebar = document.querySelector<HTMLElement>(".pwa-desktop-navigation");
  const trigger = document.querySelector<HTMLElement>(".pwa-session-trigger");
  expect(sidebar).not.toBeNull();
  expect(trigger).not.toBeNull();
  expect(document.querySelectorAll("main")).toHaveLength(1);
  expect(document.querySelectorAll(".pwa-root")).toHaveLength(1);
  await expect.element(screen.getByRole("status", { name: "Install Pi Reach" })).toBeVisible();
  expect(document.querySelector(".pwa-runtime-notice")!.parentElement).toBe(document.querySelector(".pwa-runtime-notice-slot"));

  for (const width of [766, 767]) {
    await page.viewport(width, 844);
    expect(getComputedStyle(sidebar!).display).toBe("none");
    expect(getComputedStyle(trigger!).display).not.toBe("none");
    // 移动布局主区占满视口宽度，不随内容收缩。
    expect(document.querySelector("main")!.getBoundingClientRect().width).toBe(width);
  }

  await page.viewport(768, 844);
  expect(getComputedStyle(sidebar!).display).not.toBe("none");
  expect(getComputedStyle(trigger!).display).toBe("none");

  await child.click();
  await expect.element(child).toHaveTextContent("Child count 1");
  for (const width of [1280, 390]) {
    await page.viewport(width, 844);
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.querySelector("[data-testid='stateful-child']")).toBe(childElement);
    await expect.element(child).toHaveTextContent("Child count 1");
  }
});

test("labels saved history as read-only in the title area instead of showing realtime status", async () => {
  const screen = await renderLayout({ events: [], historyMode: true, runtimeNotice: true });

  await expect.element(screen.getByText("Local history · Read only", { exact: true }).last()).toBeVisible();
  await expect.element(screen.getByRole("heading", { level: 1, name: "Saved Pi" })).toBeVisible();
  await expect.element(screen.getByLabelText("Connected")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("status", { name: "Install Pi Reach" })).toBeVisible();
  const slot = document.querySelector(".pwa-runtime-notice-slot")!;
  const close = screen.getByRole("button", { name: "Dismiss PWA notice" });
  close.element().focus();
  await close.click();
  await expect.element(screen.getByRole("button", { name: "Refresh app" })).toHaveFocus();
  expect(slot.getBoundingClientRect().height).toBe(0);
});

test("routes mobile navigation choices and closes the chooser before rename", async () => {
  const events: string[] = [];
  await page.viewport(390, 844);
  const screen = await renderLayout({ events, runtimeNotice: true });
  const trigger = screen.getByRole("button", { name: "Open navigation" });

  await trigger.click();
  await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
  await screen.getByRole("button", { name: /Other Pi/ }).click();
  await expect.poll(() => events).toEqual(["close-request", "endpoint:other"]);

  await trigger.click();
  await screen.getByRole("button", { name: "Choose computer, current Office Pi" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
  await screen.getByRole("button", { name: "Computer actions for Office Pi" }).click();
  await screen.getByRole("menuitem", { name: "Rename Office Pi" }).click();
  await expect.poll(() => events).toEqual(["close-request", "endpoint:other", "close-request", "rename:device:office"]);
});

const computerDevices = [
  { ...device, nickname: "Office Pi" },
  { ...device, id: "device:offline", deviceId: "offline-device", nickname: "Offline workstation with a very long computer name that must stay truncated even across the wide landscape navigation drawer" },
  { ...device, id: "device:partial", deviceId: "partial-device", nickname: "Partial Pi" },
  { ...device, id: "device:checking", deviceId: "checking-device", nickname: "Checking Pi" },
];
const computerFixtures: NonNullable<LayoutHarnessProps["computers"]> = {
  devices: computerDevices,
  activeDeviceId: device.id,
  pairingPresence: {
    [device.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 },
    "device:offline": { status: "offline", onlineEndpoints: 0, totalEndpoints: 1 },
    "device:partial": { status: "partial", onlineEndpoints: 1, totalEndpoints: 2 },
  },
};

const emptyViewports = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
  { width: 390, height: 500 },
  { width: 756, height: 413 },
];

test.each(emptyViewports.flatMap((viewport) => ["light", "dark"].map((scheme) => ({ ...viewport, scheme }))))(
  "keeps unpaired empty states aligned and actionable at $width x $height in $scheme",
  async ({ width, height, scheme }) => {
    await page.viewport(width, height);
    const events: string[] = [];
    const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
    const screen = await renderLayout({ events, unpaired: true });
    try {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      const main = screen.getByRole("main");
      const pair = main.getByRole("button", { name: "Start pairing", exact: true });
      await expect.element(main.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
      await expect.element(main.getByText("/pi-reach pair", { exact: true })).toBeVisible();
      await expect.element(main.getByRole("button", { name: "Copy command" })).toBeVisible();
      const empty = document.querySelector<HTMLElement>(".pwa-workspace-state")!;
      const icon = empty.querySelector<SVGElement>(".pwa-workspace-state-icon svg")!;
      const heading = empty.querySelector<HTMLElement>("h2")!;
      const body = empty.querySelector<HTMLElement>("p")!;
      const command = empty.querySelector<HTMLElement>(".pwa-command-block")!;
      // 命令单独成行：说明句完整，不夹复制按钮，也不在按钮后留下孤立标点。
      expect(body.contains(command)).toBe(false);
      expect(body.textContent).toBe("Run this command in Pi on your computer.");
      expect(command.getBoundingClientRect().top).toBeGreaterThanOrEqual(body.getBoundingClientRect().bottom);
      expect(command.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      const mainRect = main.element().getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const buttonRect = pair.element().getBoundingClientRect();
      // 空状态位于阅读列中部偏上：水平居中，标题在主区上半部分；24px 图标，不用插画。
      expect(headingRect.x + headingRect.width / 2).toBeCloseTo(mainRect.x + mainRect.width / 2, 0);
      expect(headingRect.top).toBeLessThan(mainRect.top + mainRect.height * 0.6);
      expect(icon.getBoundingClientRect().width).toBe(24);
      expect(empty.querySelector(".pwa-zero-mark")).toBeNull();
      expect(buttonRect.height).toBeGreaterThanOrEqual(44);
      expect(pair.element().getAttribute("data-variant")).toBe("filled");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `../../../.vitest/screenshots/empty-main-${width}x${height}-${scheme}.png` });
      pair.element().focus();
      await expect.element(pair).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(events).toEqual(["pair"]);

      const mobile = width < 768;
      const trigger = screen.getByRole("button", { name: "Open navigation" });
      if (mobile) {
        trigger.element().focus();
        await trigger.click();
        await expect.poll(() => Math.round(screen.getByRole("dialog", { name: /Workspace/ }).element().getBoundingClientRect().bottom)).toBe(height);
      }
      const container = mobile ? screen.getByRole("dialog", { name: /Workspace/ }) : screen.getByRole("complementary", { name: "Workspace navigation" });
      // 未配对时导航只显示电脑选择入口与底部入口，不显示在线 Pi 与本地历史分组。
      await expect.element(container.getByText("No computer paired", { exact: true })).toBeVisible();
      expect(container.element().querySelector(".pwa-nav-section")).toBeNull();
      const navigationPair = container.getByRole("button", { name: "Pair a computer", exact: true });
      const navigationPairRect = navigationPair.element().getBoundingClientRect();
      expect(navigationPairRect.height).toBeGreaterThanOrEqual(44);
      expect(container.element().scrollWidth).toBeLessThanOrEqual(container.element().clientWidth);
      await page.screenshot({ path: `../../../.vitest/screenshots/empty-navigation-${width}x${height}-${scheme}.png` });
      navigationPair.element().focus();
      await expect.element(navigationPair).toHaveFocus();
      await userEvent.keyboard(" ");
      if (mobile) {
        await expect.poll(() => events).toEqual(["pair", "close-request", "pair"]);
        await expect.element(trigger).toHaveFocus();
      } else {
        expect(events).toEqual(["pair", "pair"]);
      }
    } finally {
      await screen.unmount();
      if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
      else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    }
  },
);

test.each(emptyViewports.flatMap((viewport) => ["light", "dark"].map((scheme) => ({ ...viewport, scheme }))))(
  "preserves selectable computers and independent actions at $width x $height in $scheme",
  async ({ width, height, scheme }) => {
    await page.viewport(width, height);
    const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
    const events: string[] = [];
    const screen = await renderLayout({ events, computers: computerFixtures });
    const mobile = width < 768;
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    const navigation = () => mobile
      ? screen.getByRole("dialog", { name: /Workspace/ })
      : screen.getByRole("complementary", { name: "Workspace navigation" });
    const chooser = () => {
      const element = document.querySelector<HTMLElement>(mobile ? ".pwa-device-drawer" : ".pwa-device-popover");
      if (!element) throw new Error("Expected computer chooser.");
      return element;
    };
    const openNavigation = async () => {
      if (!mobile || document.querySelector('.pwa-session-sheet')) return;
      trigger.element().focus();
      await trigger.click();
      await expect.poll(() => Math.round(navigation().element().getBoundingClientRect().bottom)).toBe(height);
    };
    const openChooser = async () => {
      await openNavigation();
      await navigation().getByRole("button", { name: "Choose computer, current Office Pi" }).click();
      if (mobile) {
        const panel = screen.getByRole("dialog", { name: "Choose computer" });
        await expect.element(panel).toBeVisible();
        await expect.poll(() => Math.round(panel.element().getBoundingClientRect().bottom)).toBe(height);
      } else {
        await expect.poll(() => document.querySelector<HTMLElement>(".pwa-device-popover")?.getClientRects().length ?? 0).toBeGreaterThan(0);
      }
    };
    const select = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name} (?:ONLINE|OFFLINE|PARTIAL|CHECKING)`) });
    const expectSelection = async (id: string) => {
      await expect.poll(() => events).toEqual(mobile ? ["close-request", `device:${id}`] : [`device:${id}`]);
      if (mobile) await expect.poll(() => document.querySelector('.pwa-session-sheet')).toBeNull();
      events.length = 0;
    };
    try {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      await openChooser();
      const rows = chooser().querySelectorAll<HTMLElement>(".pwa-peer-card");
      expect(rows).toHaveLength(4);
      for (const [index, row] of Array.from(rows).entries()) {
        const button = row.querySelector<HTMLButtonElement>(".pwa-peer-select")!;
        const menu = row.querySelector<HTMLButtonElement>(".pwa-peer-menu-trigger")!;
        expect(button.tagName).toBe("BUTTON");
        expect(button.type).toBe("button");
        expect(button.disabled).toBe(false);
        expect(button.classList.contains("mantine-NavLink-root")).toBe(true);
        expect(button.hasAttribute("data-active")).toBe(index === 0);
        expect(button.hasAttribute("data-disabled")).toBe(false);
        expect(button.querySelector("button")).toBeNull();
        expect(button.contains(menu)).toBe(false);
        expect(button.parentElement).toBe(menu.parentElement);
        expect(row.classList.contains("active")).toBe(index === 0);
        expect(button.querySelector(".pwa-current-label")?.textContent ?? "").toBe(index === 0 ? "Current" : "");
        expect(button.querySelector(".pwa-presence-label")?.textContent).toBe(["ONLINE", "OFFLINE", "PARTIAL", "CHECKING"][index]);
        const presenceBox = button.querySelector<HTMLElement>(".pwa-peer-presence")!.getBoundingClientRect();
        for (const text of button.querySelectorAll<HTMLElement>(".pwa-presence-label, .pwa-current-label, .pwa-peer-summary")) {
          expect(text.scrollWidth, text.textContent ?? "").toBeLessThanOrEqual(text.clientWidth);
          expect(text.getBoundingClientRect().right, text.textContent ?? "").toBeLessThanOrEqual(presenceBox.right + 0.5);
        }
        expect(button.querySelector(".pwa-peer-presence")?.textContent).toContain(["2 Pis running", "0 Pis running", "1 Pi running", "Checking"][index]);
        expect(button.querySelector(".pwa-peer-icon")?.classList.contains("online")).toBe(index === 0 || index === 2);
        if (index === 0 || index === 2) {
          // 在线电脑的图标与标签只用正文色，不铺主色底。
          const probe = document.createElement("span");
          probe.style.color = "var(--pwa-ink)";
          row.append(probe);
          expect(getComputedStyle(button.querySelector(".pwa-peer-icon")!).color).toBe(getComputedStyle(probe).color);
          if (index === 0) {
            expect(getComputedStyle(button.querySelector(".pwa-presence-label")!).color).toBe(getComputedStyle(probe).color);
            expect(getComputedStyle(button.querySelector(".pwa-presence-label")!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
          }
          probe.remove();
        }
        expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(getComputedStyle(button).color).toBe(getComputedStyle(row).color);
        expect(getComputedStyle(button.querySelector(".pwa-peer-copy")!).overflow).toBe("hidden");
        expect(getComputedStyle(button.querySelector(".pwa-peer-description")!).overflow).toBe("hidden");
        expect(Math.round(button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(62);
        expect(Math.round(menu.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
        expect(Math.round(menu.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        const label = button.querySelector<HTMLElement>(".pwa-peer-label")!;
        expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
        expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
        if (index === 1) expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
      }
      expect(chooser().scrollWidth).toBeLessThanOrEqual(chooser().clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished));
      await page.screenshot({ path: `../../../.vitest/screenshots/computers-${width}x${height}-${scheme}.png` });
      const current = select("Office Pi");
      current.element().focus();
      await userEvent.keyboard("{Enter}");
      await expectSelection(device.id);
      await openChooser();
      const offline = select(computerDevices[1].nickname!);
      offline.element().scrollIntoView({ block: "nearest" });
      offline.element().focus();
      await userEvent.keyboard(" ");
      await expectSelection("device:offline");
      for (const target of computerDevices.slice(2)) {
        await openChooser();
        const choice = select(target.nickname!);
        choice.element().scrollIntoView({ block: "nearest" });
        choice.element().focus();
        await userEvent.keyboard("{Enter}");
        await expectSelection(target.id);
      }
      await openChooser();
      const menu = screen.getByRole("button", { name: "Computer actions for Office Pi" });
      menu.element().focus();
      await menu.click();
      const rename = screen.getByRole("menuitem", { name: "Rename Office Pi" });
      await expect.element(rename).toBeVisible();
      expect(rename.element().closest(".pwa-root")).not.toBeNull();
      expect(events).toEqual([]);
      await userEvent.keyboard("{Escape}");
      await expect.element(rename).not.toBeInTheDocument();
      await expect.element(menu).toHaveFocus();
      await menu.click();
      await screen.getByRole("menuitem", { name: "Remove Office Pi" }).click();
      await expect.poll(() => events).toEqual([`remove:${device.id}`]);
      events.length = 0;
      await openChooser();
      const renameMenu = screen.getByRole("button", { name: "Computer actions for Office Pi" });
      await renameMenu.click();
      await screen.getByRole("menuitem", { name: "Rename Office Pi" }).click();
      await expect.poll(() => events).toEqual([...(mobile ? ["close-request"] : []), `rename:${device.id}`]);
    } finally {
      await screen.unmount();
      if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
      else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    }
  },
);

test("keeps the mobile drawer open when the background close is rejected", async () => {
  const events: string[] = [];
  await page.viewport(390, 844);
  const screen = await renderLayout({ events, rejectClose: true });
  await screen.getByRole("button", { name: "Open navigation" }).click();
  const dialog = screen.getByRole("dialog");
  await screen.getByRole("button", { name: "Close navigation" }).click();
  await expect.element(dialog).toBeVisible();
  expect(events).toEqual(["close-request"]);
});

test("fades navigation and settings without movement under reduced motion and preserves return focus", async () => {
  await page.viewport(390, 700);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const events: string[] = [];
  const screen = await renderLayout({ events, savedHistory: longHistory });
  try {
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    trigger.element().focus();
    await trigger.click();
    const sheet = screen.getByRole("dialog", { name: /Workspace/ });
    await expect.element(sheet).toBeVisible();
    const drawer = sheet.element();
    await expect.poll(() => getComputedStyle(drawer).transitionDuration).toBe("0.12s");
    expect(getComputedStyle(drawer).transitionProperty.split(",").map((name) => name.trim())).toContain("opacity");
    // Drawer 的静止态是 translate(0)：计算值为单位矩阵而非 none，只要求没有位移。
    expect(new DOMMatrix(getComputedStyle(drawer).transform).m41).toBe(0);
    expect(drawer.closest(".pwa-root")).not.toBeNull();
    const overlay = document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!;
    await expect.poll(() => getComputedStyle(overlay).transitionDuration).toBe("0.12s");

    await screen.getByRole("button", { name: "Open settings" }).click();
    const root = document.querySelector<HTMLElement>(".pwa-root")!;
    expect(root.dataset.viewTransition).toBeDefined();
    const settings = document.querySelector<HTMLElement>(".pwa-settings-view")!;
    const workspace = document.querySelector<HTMLElement>(".pwa-workspace-view")!;
    expect(getComputedStyle(settings).transform).toBe("none");
    expect(getComputedStyle(workspace).transform).toBe("none");
    const animations = settings.getAnimations();
    expect(animations).toHaveLength(1);
    expect(animations[0].effect?.getComputedTiming().duration).toBe(120);
    await settleAnimations();
    await expect.poll(() => root.dataset.viewTransition).toBeUndefined();
    expect(document.querySelector(".pwa-session-sheet")).toBeNull();
    await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toHaveFocus();

    await screen.getByRole("button", { name: "Back to navigation" }).click();
    const returned = screen.getByRole("dialog", { name: /Workspace/ });
    await expect.element(returned).toBeVisible();
    expect(getComputedStyle(returned.element()).transform).toBe("none");
    await settleAnimations();
    await expect.element(returned.getByRole("button", { name: "Open settings" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(returned).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  } finally {
    await screen.unmount();
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

// 注入 UA 信号但仍使用真实 React、Portal 与动画；不模拟 Safari 的原生转场。
function nativePageAnimations(root: HTMLElement) {
  return root.getAnimations({ subtree: true }).filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element && target.matches(".pwa-workspace-view, .pwa-settings-view, .pwa-page-scrim, .pwa-session-sheet, .mantine-Drawer-overlay");
  });
}

function nativePopstate(state: unknown) {
  window.history.replaceState(state, "");
  const event = new PopStateEvent("popstate", { state });
  Object.defineProperty(event, "hasUAVisualTransition", { value: true });
  window.dispatchEvent(event);
}

test.each([false, true])("restores native navigation back without page animations or lost Portal hints (reduced=%s)", async (reduced) => {
  await page.viewport(390, 700);
  if (reduced) await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const screen = await renderLayout({ events: [], savedHistory: longHistory });
  try {
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    trigger.element().focus();
    await trigger.click();
    await settleAnimations();
    const scroll = document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")!;
    scroll.scrollTop = 120;
    const scrollTop = scroll.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    await screen.getByRole("button", { name: "Open settings" }).click();
    const settingsState = window.history.state;
    await settleAnimations();
    await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();

    nativePopstate(null);
    const root = document.querySelector<HTMLElement>(".pwa-root")!;
    expect(root.dataset.view).toBe("workspace");
    expect(root.dataset.viewTransition).toBeUndefined();
    expect(document.querySelector(".pwa-settings-view")).toBeNull();
    expect(document.querySelector(".pwa-workspace-view")!.getAnimations()).toHaveLength(0);
    await expect.poll(() => document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")?.scrollTop).toBe(scrollTop);
    const sheet = screen.getByRole("dialog", { name: /Workspace/ });
    const entry = sheet.getByRole("button", { name: "Open settings" });
    await expect.element(entry).toHaveFocus();
    expect(Math.round(sheet.element().getBoundingClientRect().left)).toBe(0);
    expect(nativePageAnimations(root)).toHaveLength(0);

    // 恢复提示只消费一次；用户滚动与后续 rerender 不应回滚或抢焦点。
    const restoredScroll = document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")!;
    restoredScroll.scrollTop = 240;
    const userScrollTop = restoredScroll.scrollTop;
    const close = sheet.getByRole("button", { name: "Close navigation" });
    close.element().focus();
    await screen.rerender(<PwaUiProvider><LayoutHarness events={[]} savedHistory={longHistory} title="Updated Pi" /></PwaUiProvider>);
    expect(restoredScroll.scrollTop).toBe(userScrollTop);
    expect(entry.element().hasAttribute("data-autofocus")).toBe(false);
    await settleAnimations();
    await expect.element(close).toHaveFocus();

    // 原生 forward 同步进入、无页面动画；随后原生 back 再次恢复。
    nativePopstate(settingsState);
    expect(root.dataset.view).toBe("settings");
    expect(root.dataset.viewTransition).toBeUndefined();
    expect(document.querySelector(".pwa-session-sheet")).toBeNull();
    expect(nativePageAnimations(root)).toHaveLength(0);
    await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toHaveFocus();
    nativePopstate(null);
    await expect.element(sheet.getByRole("button", { name: "Open settings" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => getComputedStyle(sheet.element()).transitionDuration).toBe(reduced ? "0.12s" : "0.2s");
    await expect.element(sheet).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await trigger.click();
    await expect.poll(() => getComputedStyle(sheet.element()).transitionDuration).toBe(reduced ? "0.12s" : "0.2s");
    await settleAnimations();
    await sheet.getByRole("button", { name: "Open settings" }).click();
    const animations = document.querySelector(".pwa-settings-view")!.getAnimations();
    expect(animations).toHaveLength(1);
    expect(animations[0].effect!.getTiming().duration).toBe(reduced ? 120 : 200);
    await settleAnimations();
  } finally {
    await screen.unmount();
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test.each([
  { reduced: false, settled: true },
  { reduced: true, settled: true },
  { reduced: false, settled: false },
  { reduced: true, settled: false },
])("restores a mounted mobile navigation on native back during ordinary forward (reduced=$reduced, firstReturnSettled=$settled)", async ({ reduced, settled }) => {
  await page.viewport(390, 700);
  if (reduced) await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const screen = await renderLayout({ events: [], savedHistory: longHistory });
  try {
    await screen.getByRole("button", { name: "Open navigation" }).click();
    await settleAnimations();
    document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")!.scrollTop = 120;
    await screen.getByRole("button", { name: "Open settings" }).click();
    await settleAnimations();
    await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
    await screen.getByRole("button", { name: "Back to navigation" }).click();
    if (settled) {
      await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
      await settleAnimations();
    } else {
      // 首次返回还未收尾，相同滚动值/焦点提示不能吞掉下一次返回请求。
      const root = document.querySelector<HTMLElement>(".pwa-root")!;
      await expect.poll(() => {
        const animations = nativePageAnimations(root);
        animations.forEach((animation) => { animation.pause(); animation.currentTime = 60; });
        return animations.length;
      }).toBe(2);
    }
    const sheet = screen.getByRole("dialog", { name: /Workspace/ });
    const drawer = sheet.element();
    const entry = sheet.getByRole("button", { name: "Open settings" });
    const close = sheet.getByRole("button", { name: "Close navigation" });
    const scroll = drawer.querySelector<HTMLElement>(".pwa-navigation-scroll")!;
    expect(scroll.scrollTop).toBe(120);
    await expect.element(entry).toHaveFocus();
    scroll.scrollTop = 240;
    close.element().focus();
    await expect.element(close).toHaveFocus();

    window.history.forward();
    const root = document.querySelector<HTMLElement>(".pwa-root")!;
    await expect.poll(() => root.dataset.view).toBe("settings");
    await expect.poll(() => {
      const animations = nativePageAnimations(root);
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 60; });
      return animations.length;
    }).toBe(2);
    expect(document.querySelector(".pwa-session-sheet")).toBe(drawer);
    expect(scroll.scrollTop).toBe(240);
    nativePopstate(null);
    expect(document.querySelector(".pwa-session-sheet")).toBe(drawer);
    expect(root.dataset.view).toBe("workspace");
    expect(document.querySelector(".pwa-settings-view")).toBeNull();
    expect.soft(scroll.scrollTop).toBe(120);
    await expect.element(entry).toHaveFocus();
    expect(nativePageAnimations(root)).toHaveLength(0);

    // 同一 DOM 上的新请求只消费一次，之后用户操作及 rerender 不应被恢复提示覆盖。
    scroll.scrollTop = 240;
    close.element().focus();
    await screen.rerender(<PwaUiProvider><LayoutHarness events={[]} savedHistory={longHistory} title="Updated Pi" /></PwaUiProvider>);
    await settleAnimations();
    expect(scroll.scrollTop).toBe(240);
    expect(entry.element().hasAttribute("data-autofocus")).toBe(false);
    await expect.element(close).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    // 静止的 entered 状态可为 0s；验证真正退出阶段仍使用正常导航时长。
    await expect.poll(() => getComputedStyle(sheet.element()).transitionDuration).toBe(reduced ? "0.12s" : "0.2s");
    await expect.element(sheet).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test.each(["running", "queued"] as const)("settles a native back synchronously during a $0 enter without stale animation cleanup", async (phase) => {
  const screen = await renderLayout({ events: [] });
  try {
    const entry = screen.getByRole("button", { name: "Open settings" });
    await entry.click();
    const settingsState = window.history.state;
    const root = document.querySelector<HTMLElement>(".pwa-root")!;
    const animations = nativePageAnimations(root);
    expect(animations).toHaveLength(2);
    animations.forEach((animation) => {
      if (phase === "queued") animation.finish();
      else { animation.pause(); animation.currentTime = 80; }
    });
    nativePopstate(null);
    expect(root.dataset.view).toBe("workspace");
    expect(root.dataset.viewTransition).toBeUndefined();
    expect(document.querySelector(".pwa-settings-view")).toBeNull();
    expect(animations.every((animation) => animation.playState === "idle")).toBe(true);
    expect(document.activeElement).toBe(entry.element());
    // 在旧 finished Promise 执行前立即反向；旧完成通知不能卸载新设置页。
    nativePopstate(settingsState);
    expect(root.dataset.view).toBe("settings");
    expect(root.dataset.viewTransition).toBeUndefined();
    expect(nativePageAnimations(root)).toHaveLength(0);
    await settleAnimations();
    await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toHaveFocus();
    expect(root.dataset.view).toBe("settings");
    expect(nativePageAnimations(root)).toHaveLength(0);
  } finally { await screen.unmount(); }
});

async function settleAnimations() {
  await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

test("pushes the desktop settings page over the workspace and restores it through in-page and browser back", async () => {
  const events: string[] = [];
  const screen = await renderLayout({ events });
  const child = screen.getByTestId("stateful-child");
  await child.click();
  const childElement = child.element();
  const previousTitle = document.title;
  const entry = screen.getByRole("button", { name: "Open settings" });
  entry.element().focus();
  await entry.click();
  expect(events).toEqual(["settings:workspace"]);
  const title = screen.getByRole("heading", { level: 1, name: "Settings" });
  // 进入即聚焦页面标题；转场期间两层都可见，设置页从右侧推入。
  await expect.element(title).toHaveFocus();
  const root = document.querySelector<HTMLElement>(".pwa-root")!;
  expect(root.dataset.viewTransition).toBeDefined();
  expect(document.querySelector(".pwa-settings-view")!.getBoundingClientRect().left).toBeGreaterThan(0);
  expect(window.history.state?.piReachSettings?.origin).toEqual({ kind: "workspace" });
  expect(document.title).toBe("Settings · Pi Reach");
  await settleAnimations();
  await expect.poll(() => root.dataset.viewTransition).toBeUndefined();
  expect(document.querySelector(".pwa-settings-view")!.getBoundingClientRect().left).toBe(0);
  expect(getComputedStyle(document.querySelector(".pwa-workspace-view")!).visibility).toBe("hidden");
  expect(document.querySelector(".pwa-workspace-view")!.hasAttribute("inert")).toBe(true);
  expect(document.querySelector(".pwa-settings-view .pwa-desktop-navigation")).toBeNull();

  await screen.getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(entry).toHaveFocus();
  await settleAnimations();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  expect(document.title).toBe(previousTitle);
  expect(document.querySelector("[data-testid='stateful-child']")).toBe(childElement);
  await expect.element(child).toHaveTextContent("Child count 1");

  // 浏览器前进重新进入设置页（正常进入转场），后退回到工作区。
  window.history.forward();
  await expect.element(title).toHaveFocus();
  await settleAnimations();
  window.history.back();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  await expect.element(entry).toHaveFocus();
});

test("returns from settings to the expanded mobile navigation with its scroll position and settings entry focus", async () => {
  const events: string[] = [];
  await page.viewport(390, 700);
  const screen = await renderLayout({ events, savedHistory: longHistory });
  await screen.getByRole("button", { name: "Open navigation" }).click();
  const sheet = screen.getByRole("dialog", { name: /Workspace/ });
  await expect.element(sheet).toBeVisible();
  await settleAnimations();
  const scroll = document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")!;
  scroll.scrollTop = 120;
  expect(scroll.scrollTop).toBeGreaterThan(0);
  const scrollTop = scroll.scrollTop;
  await screen.getByRole("button", { name: "Open settings" }).click();
  // 导航不先播放关闭动画，也不经过背景关闭请求；推入完成后直接卸载。
  expect(events).toEqual(["settings:navigation"]);
  expect(document.querySelector(".pwa-session-sheet")).not.toBeNull();
  await settleAnimations();
  await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toHaveFocus();

  await screen.getByRole("button", { name: "Back to navigation" }).click();
  await expect.poll(() => document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")?.scrollTop).toBe(scrollTop);
  const restoredEntry = screen.getByRole("dialog", { name: /Workspace/ }).getByRole("button", { name: "Open settings" });
  await expect.element(restoredEntry).toHaveFocus();
  await settleAnimations();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
  expect(events).toEqual(["settings:navigation"]);
});

test("the navigation icon slides the drawer in on every open, including after returning from settings", async () => {
  await page.viewport(390, 700);
  const screen = await renderLayout({ events: [] });
  // 逐帧记录导航左缘：随 opened=true 一起挂载时 Mantine 跳过进入过渡，导航会直接停在 0。
  const openAndSample = async () => {
    const lefts: number[] = [];
    let stop = false;
    const tick = () => {
      const sheet = document.querySelector<HTMLElement>(".pwa-session-sheet");
      if (sheet) lefts.push(Math.round(sheet.getBoundingClientRect().left));
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await screen.getByRole("button", { name: "Open navigation" }).click();
    await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
    // 过渡在打开后的下一帧才开始，不能用当时的动画列表判断结束；等导航真正到达终点。
    await expect.poll(() => Math.round(document.querySelector<HTMLElement>(".pwa-session-sheet")!.getBoundingClientRect().left)).toBe(0);
    await settleAnimations();
    stop = true;
    return lefts;
  };
  const closeNavigation = async () => {
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  };
  try {
    for (let round = 0; round < 2; round += 1) {
      const lefts = await openAndSample();
      expect(Math.min(...lefts)).toBeLessThan(0);
      await closeNavigation();
    }
    // 从导航进入设置后导航实例被卸载，返回工作区再点图标仍须滑入。
    await screen.getByRole("button", { name: "Open navigation" }).click();
    await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
    await screen.getByRole("button", { name: "Open settings" }).click();
    await settleAnimations();
    await screen.getByRole("button", { name: "Back to navigation" }).click();
    await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
    await settleAnimations();
    await closeNavigation();
    const lefts = await openAndSample();
    expect(Math.min(...lefts)).toBeLessThan(0);
  } finally {
    await screen.unmount();
  }
});
