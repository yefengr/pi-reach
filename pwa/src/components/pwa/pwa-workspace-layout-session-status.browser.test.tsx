import { useState, type ReactNode } from "react";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { SessionStatusDrawer } from "./session-status-drawer";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touch, touchReleaseAtRest } from "@/test/browser/swipe";
import { SessionStatusContent, formatStatusTokens } from "./session-status";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { PwaMessageActions, PwaStatusError } from "./pwa-app-actions";
import { PwaOperationNotifications } from "./pwa-operation-notifications";
import { createOperationNotificationController, type OperationNotificationController } from "@/lib/pwa/operation-notifications";
import type { SessionStatusView } from "@/lib/pwa/session-status";
import { DESKTOP_LAYOUT_QUERY, MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

const view: SessionStatusView = { kind: "ready", status: {
  context: { tokens: 84_000, window: 200_000, auto_compact: true, level: "normal" },
  usage: { input: 1_200_000, output: 48_000, cache_read: 840_000, cache_write: 120_000, cost: 0, cache_hit_rate_session: 87.5, cache_hit_rate_latest: 92.4 },
  branch: "feature/session-status", extensions: [{ key: "ci", label: "CI", text: "<b>plain text</b>" }],
} };
const status = { view, title: "Status example", deviceName: "Office", cwd: "/work/pi-reach" };

function Layout({ overlays = null, realSettings = false, statusAvailable = true, offline = false, notifications }: { overlays?: ReactNode; realSettings?: boolean; statusAvailable?: boolean; offline?: boolean; notifications?: OperationNotificationController }) {
  const settings = useSettingsRoute();
  return <PwaWorkspaceLayout sessionStatus={statusAvailable ? { ...status, view: offline ? { kind: "offline" } : view } : undefined} navigation={{ devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {}, onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {} }} titleBar={{ title: status.title, showTitle: true }} toast={<PwaStatusError message="Conversation could not be updated" onDismiss={() => {}} />} operationNotifications={notifications ? <PwaOperationNotifications controller={notifications} /> : null} settingsRoute={realSettings ? settings.route : { open: false, change: 0, animate: false, origin: null }} onOpenSettings={settings.openSettings} onSettingsBack={settings.closeSettings} renderSettings={() => <h2>Settings content</h2>} overlays={overlays} closeBackgroundOverlay={close => close()}>
    {/* 与正式会话共用消息内边距、浮动 footer、Composer 卡片和 Latest，不给夹具另造居中规则。 */}
    <div className="pwa-message-list"><div data-reading-content>Conversation</div></div>
    <div className="pwa-chat-footer">
      <PwaMessageActions show showLatest showRetry={false} unreadOutput={0} onRetry={() => {}} onLatest={() => {}} />
      <div className="pwa-composer"><div className="pwa-composer-card">Composer</div></div>
    </div>
  </PwaWorkspaceLayout>;
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

beforeEach(() => {
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  window.localStorage.removeItem("pi-reach-sidebar-width");
});

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

function layoutElement(selector: string) {
  return document.querySelector<HTMLElement>(selector)!;
}

function center(selector: string) {
  const box = layoutElement(selector).getBoundingClientRect();
  return box.left + box.width / 2;
}

function pixels(value: number) {
  return Math.round(value) || 0;
}

async function expectLane(visible: boolean) {
  const reserve = visible ? 260 : 0;
  await expect.poll(() => {
    const main = layoutElement(".pwa-main");
    const mainStyle = getComputedStyle(main);
    const safeLeft = parseFloat(mainStyle.getPropertyValue("--pwa-main-safe-left"));
    const safeRight = parseFloat(mainStyle.getPropertyValue("--pwa-main-safe-right"));
    const body = getComputedStyle(layoutElement(".pwa-workspace-body"));
    const notices = getComputedStyle(layoutElement(".pwa-main-notices"));
    const mainBox = main.getBoundingClientRect();
    const laneCenter = (mainBox.left + safeLeft + mainBox.right - safeRight - reserve) / 2;
    const reading = layoutElement("[data-reading-content]").getBoundingClientRect();
    // 消息列表固定预留滚动条位置：经典滚动条（如 Linux CI）在右侧占宽，覆盖式滚动条为 0。按实测宽度还原阅读列。
    const list = layoutElement(".pwa-message-list");
    const gutter = list.offsetWidth - list.clientWidth;
    return {
      visible: main.hasAttribute("data-session-status-card"),
      reserve: main.style.getPropertyValue("--pwa-status-reserve"),
      padding: Math.round(parseFloat(body.paddingRight)),
      noticeRight: Math.round(parseFloat(notices.right)),
      readingWidth: Math.round(reading.width + gutter),
      readingCenter: pixels(reading.left + (reading.width + gutter) / 2 - laneCenter),
      composerWidth: Math.round(layoutElement(".pwa-composer-card").getBoundingClientRect().width),
      centers: [".pwa-composer-card", ".pwa-latest-button", ".pwa-status-error"].map(selector => pixels(center(selector) - laneCenter)),
      gapDifference: pixels(reading.left - mainBox.left - safeLeft - (mainBox.right - safeRight - reserve - reading.right - gutter)),
      safeRight: Math.round(parseFloat(body.paddingRight) - safeRight),
    };
  }, { timeout: 5000 }).toEqual({
    visible, reserve: `${reserve}px`,
    padding: Math.round(parseFloat(getComputedStyle(layoutElement(".pwa-main")).getPropertyValue("--pwa-main-safe-right"))) + reserve,
    noticeRight: reserve, readingWidth: 680, readingCenter: 0, composerWidth: 680, centers: [0, 0, 0],
    gapDifference: 0, safeRight: reserve,
  });
}

test("desktop reading, composer, Latest, error and Toast share the fixed status lane", async () => {
  await page.viewport(1600, 900);
  const notifications = createOperationNotificationController();
  await renderLayout({ notifications });
  expect(layoutElement(".pwa-root").hasAttribute("data-sidebar-collapsed")).toBe(false);
  await expectLane(true);
  const main = layoutElement(".pwa-main");
  expect(Math.round(center(".pwa-composer-card") - (main.getBoundingClientRect().left + main.clientWidth / 2))).toBe(-130);
  const card = layoutElement(".pwa-session-status-card").getBoundingClientRect();
  expect(Math.round(card.width)).toBe(248);
  expect(Math.round(main.getBoundingClientRect().right - card.right)).toBe(12);
  notifications.show("model_set-error");
  await expect.poll(() => document.querySelector(".pwa-operation-notification")).not.toBeNull();
  await expect.poll(() => Math.round(center(".pwa-operation-notification") - center(".pwa-composer-card"))).toBe(0);
});

test("desktop threshold includes 1272 expanded and 980 collapsed, with one-pixel lower widths hidden", async () => {
  await page.viewport(1272, 900);
  const screen = await renderLayout();
  await expectLane(true);
  await page.viewport(1271, 900);
  await expectLane(false);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(true);
  await page.viewport(980, 900);
  await expectLane(true);
  await page.viewport(979, 900);
  await expectLane(false);
});

test("safe areas are deducted once and a taller title keeps the card below it", async () => {
  await page.viewport(1600, 900);
  const screen = await renderLayout();
  const root = layoutElement(".pwa-root");
  root.style.setProperty("--pwa-safe-left", "30px");
  root.style.setProperty("--pwa-safe-right", "47px");
  await expectLane(true);
  expect(Math.round(layoutElement(".pwa-main").getBoundingClientRect().right - layoutElement(".pwa-session-status-card").getBoundingClientRect().right)).toBe(12 + 47);
  const title = layoutElement(".pwa-title-bar");
  title.style.minHeight = "120px";
  await expect.poll(() => Math.round(layoutElement(".pwa-session-status-card").getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(8);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(true);
  await page.viewport(1057, 900);
  await expectLane(true);
  await page.viewport(1056, 900);
  await expectLane(false);
});

test("status availability and real sidebar toggles animate the shared lane, while window resize and dragging do not", async () => {
  await page.viewport(1200, 900);
  const fixture = (offline: boolean) => <PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout offline={offline} /></PwaAppShell></PwaUiProvider>;
  const screen = await render(fixture(false));
  await expectLane(false);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(true);
  const main = layoutElement(".pwa-main");
  const body = layoutElement(".pwa-workspace-body");
  const notices = layoutElement(".pwa-main-notices");
  const grid = getComputedStyle(layoutElement(".pwa-layout"));
  expect(main.hasAttribute("data-session-status-instant")).toBe(false);
  expect(getComputedStyle(body).transitionProperty).toBe("padding-right");
  expect(getComputedStyle(notices).transitionProperty).toBe("right");
  for (const element of [body, notices]) {
    expect(getComputedStyle(element).transitionDuration).toBe(grid.transitionDuration);
    expect(getComputedStyle(element).transitionTimingFunction).toBe(grid.transitionTimingFunction);
  }
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(main, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  await screen.rerender(fixture(true));
  mutations.push(...observer.takeRecords());
  observer.disconnect();
  expect(mutations.length).toBeGreaterThan(0);
  expect(mutations.every(record => record.oldValue?.includes("--pwa-status-reserve:"))).toBe(true);
  await expectLane(false);
  expect(document.querySelector(".pwa-session-status-card")).toBeNull();
  expect(main.hasAttribute("data-session-status-instant")).toBe(false);
  await screen.rerender(fixture(false));
  await expectLane(true);
  // 同步切换 enabled 后立即拖窗，正在进行的让位过渡也必须一次到位。
  await screen.rerender(fixture(true));
  await page.viewport(1199, 900);
  await expectLane(false);
  expect(main.hasAttribute("data-session-status-instant")).toBe(true);
  expect(getComputedStyle(body).transitionProperty).toBe("none");
  expect(getComputedStyle(notices).transitionProperty).toBe("none");
  await screen.rerender(fixture(false));
  await expectLane(true);
  await screen.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expectLane(false);
  // 拖动门禁来自既有侧栏控制器；只核对选择器，不用逐帧采样猜测动效。
  const root = layoutElement(".pwa-root");
  root.setAttribute("data-sidebar-resizing", "");
  try {
    expect(getComputedStyle(body).transitionProperty).toBe("none");
    expect(getComputedStyle(notices).transitionProperty).toBe("none");
  } finally { root.removeAttribute("data-sidebar-resizing"); }
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
