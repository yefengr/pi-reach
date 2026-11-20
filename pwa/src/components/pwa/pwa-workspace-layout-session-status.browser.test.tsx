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
import { SESSION_STATUS_CARD_STORAGE_KEY, useSessionStatusCardPreference } from "@/lib/pwa/session-status-card-preference";

const view: SessionStatusView = { kind: "ready", status: {
  context: { tokens: 84_000, window: 200_000, auto_compact: true, level: "normal" },
  usage: { input: 1_200_000, output: 48_000, cache_read: 840_000, cache_write: 120_000, cost: 0, cache_hit_rate_session: 87.5, cache_hit_rate_latest: 92.4 },
  branch: "feature/session-status", extensions: [{ key: "ci", label: "CI", text: "<b>plain text</b>" }],
} };
const status = { view, title: "Status example", deviceName: "Office", cwd: "/work/pi-reach" };

function StatusPreferenceToggle() {
  const [, setShow] = useSessionStatusCardPreference();
  return <button type="button" onClick={() => setShow((value) => !value)}>Toggle session status card</button>;
}

function Layout({ overlays = null, realSettings = false, statusAvailable = true, statusView = view, notifications, togglePreference = false }: { overlays?: ReactNode; realSettings?: boolean; statusAvailable?: boolean; statusView?: SessionStatusView; notifications?: OperationNotificationController; togglePreference?: boolean }) {
  const settings = useSettingsRoute();
  return <PwaWorkspaceLayout sessionStatus={statusAvailable ? { ...status, view: statusView } : undefined} navigation={{ devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {}, onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {} }} titleBar={{ title: status.title, showTitle: true }} toast={<PwaStatusError message="Conversation could not be updated" onDismiss={() => {}} />} operationNotifications={notifications ? <PwaOperationNotifications controller={notifications} /> : null} settingsRoute={realSettings ? settings.route : { open: false, change: 0, animate: false, origin: null }} onOpenSettings={settings.openSettings} onSettingsBack={settings.closeSettings} renderSettings={() => <h2>Settings content</h2>} overlays={overlays} closeBackgroundOverlay={close => close()}>
    {/* 与正式会话共用消息内边距、浮动 footer、Composer 卡片和 Latest，不给夹具另造居中规则。 */}
    <div className="pwa-message-list"><div data-reading-content>Conversation{togglePreference ? <StatusPreferenceToggle /> : null}</div></div>
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
  window.localStorage.removeItem(SESSION_STATUS_CARD_STORAGE_KEY);
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
  // 让位可能先于侧栏网格结束；下一次改窗口宽度前需等真实网格收尾，避免人为制造中途反向。
  await expect.poll(() => layoutElement(".pwa-layout").getAnimations().length).toBe(0);
  const reserve = visible ? 272 : 0;
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
  expect(Math.round(center(".pwa-composer-card") - (main.getBoundingClientRect().left + main.clientWidth / 2))).toBe(-136);
  const card = layoutElement(".pwa-session-status-card").getBoundingClientRect();
  expect(Math.round(card.width)).toBe(248);
  expect(Math.round(main.getBoundingClientRect().right - card.right)).toBe(12);
  expect(Math.round(card.top - layoutElement(".pwa-title-bar").getBoundingClientRect().bottom)).toBe(12);
  expect(Math.round(card.left - layoutElement(".pwa-message-list").getBoundingClientRect().right)).toBe(12);
  notifications.show("model_set-error");
  await expect.poll(() => document.querySelector(".pwa-operation-notification")).not.toBeNull();
  await expect.poll(() => Math.round(center(".pwa-operation-notification") - center(".pwa-composer-card"))).toBe(0);
});

test("desktop hysteresis retains both directions at 1002 and crosses only 992 / 1012", async () => {
  await page.viewport(1284, 900);
  const screen = await renderLayout();
  await expectLane(true);
  // 默认侧栏占 292px；第一次测量主区恰为 992 即显示。
  await page.viewport(1294, 900);
  await expectLane(true);
  await page.viewport(1283, 900);
  await expectLane(false);
  await page.viewport(1294, 900);
  await expectLane(false);
  await page.viewport(1303, 900);
  await expectLane(false);
  await page.viewport(1304, 900);
  await expectLane(true);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(true);
  await page.viewport(992, 900);
  await expectLane(true);
  await page.viewport(991, 900);
  await expectLane(false);
  await page.viewport(1002, 900);
  await expectLane(false);
  await page.viewport(1012, 900);
  await expectLane(true);
  await page.viewport(1200, 900);
  await expectLane(true);
  await screen.getByRole("button", { name: "Expand sidebar", exact: true }).click();
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
  await expect.poll(() => Math.round(layoutElement(".pwa-session-status-card").getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(12);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(true);
  await page.viewport(1069, 900);
  await expectLane(true);
  await page.viewport(1068, 900);
  await expectLane(false);
});

test("window resize and sidebar width changes run real lane and card opacity transitions", async () => {
  await page.viewport(1200, 900);
  const screen = await renderLayout();
  await expectLane(false);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(true);
  const main = layoutElement(".pwa-main");
  const body = layoutElement(".pwa-workspace-body");
  const notices = layoutElement(".pwa-main-notices");
  const card = layoutElement(".pwa-session-status-card");
  const grid = getComputedStyle(layoutElement(".pwa-layout"));
  for (const element of [body, notices]) {
    expect(getComputedStyle(element).transitionDuration).toBe(grid.transitionDuration);
    expect(getComputedStyle(element).transitionTimingFunction).toBe(grid.transitionTimingFunction);
  }
  const transitions: string[] = [];
  const record = (event: Event) => {
    const transition = event as TransitionEvent;
    if (event.target === body) transitions.push(`body:${transition.propertyName}`);
    if (event.target === notices) transitions.push(`notices:${transition.propertyName}`);
    if (event.target === card) transitions.push(`card:${transition.propertyName}`);
  };
  main.addEventListener("transitionrun", record);
  try {
    await page.viewport(991, 900);
    await expectLane(false);
    expect(main.hasAttribute("data-session-status-instant")).toBe(false);
    expect(transitions).toEqual(expect.arrayContaining(["body:padding-right", "notices:right", "card:opacity"]));
    transitions.length = 0;
    await page.viewport(1012, 900);
    await expectLane(true);
    expect(transitions).toEqual(expect.arrayContaining(["body:padding-right", "notices:right", "card:opacity"]));
    await page.viewport(1200, 900);
    await expectLane(true);
    transitions.length = 0;
    // 拖动门禁不应禁用状态列过渡；直接改变同一个宽度输入，避免鼠标时钟影响断言。
    const root = layoutElement(".pwa-root");
    root.setAttribute("data-sidebar-resizing", "");
    try {
      await screen.getByRole("button", { name: "Expand sidebar", exact: true }).click();
      await expectLane(false);
      expect(transitions).toEqual(expect.arrayContaining(["body:padding-right", "notices:right", "card:opacity"]));
    } finally { root.removeAttribute("data-sidebar-resizing"); }
  } finally { main.removeEventListener("transitionrun", record); }
});

test("desktop card follows the persisted switch in the same tab with lane transitions", async () => {
  await page.viewport(1600, 900);
  const screen = await renderLayout({ togglePreference: true });
  await expectLane(true);
  const main = layoutElement(".pwa-main");
  const transitions: string[] = [];
  const record = (event: Event) => {
    const transition = event as TransitionEvent;
    if (event.target === layoutElement(".pwa-workspace-body")) transitions.push(`body:${transition.propertyName}`);
    if (event.target === layoutElement(".pwa-main-notices")) transitions.push(`notices:${transition.propertyName}`);
    if (event.target instanceof HTMLElement && event.target.classList.contains("pwa-session-status-card")) transitions.push(`card:${transition.propertyName}`);
  };
  main.addEventListener("transitionrun", record);
  try {
    await screen.getByRole("button", { name: "Toggle session status card", exact: true }).click();
    await expectLane(false);
    expect(window.localStorage.getItem(SESSION_STATUS_CARD_STORAGE_KEY)).toBe("false");
    expect(transitions).toEqual(expect.arrayContaining(["body:padding-right", "notices:right", "card:opacity"]));
    await expect.poll(() => document.querySelector(".pwa-session-status-card"), { timeout: 5000 }).toBeNull();
    transitions.length = 0;
    await screen.getByRole("button", { name: "Toggle session status card", exact: true }).click();
    await expectLane(true);
    expect(window.localStorage.getItem(SESSION_STATUS_CARD_STORAGE_KEY)).toBe("true");
    expect(transitions).toEqual(expect.arrayContaining(["body:padding-right", "notices:right", "card:opacity"]));
  } finally { main.removeEventListener("transitionrun", record); }
});

test("mobile status keeps its top-bar trigger and drawer with the desktop card switched off", async () => {
  window.localStorage.setItem(SESSION_STATUS_CARD_STORAGE_KEY, "false");
  await page.viewport(390, 700);
  const screen = await renderLayout();
  const main = layoutElement(".pwa-main");
  await expect.poll(() => main.style.getPropertyValue("--pwa-status-reserve")).toBe("0px");
  expect(main.hasAttribute("data-session-status-card")).toBe(false);
  expect(document.querySelector(".pwa-session-status-card")).toBeNull();
  await screen.getByRole("button", { name: "Session status", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "Session status", exact: true })).toBeVisible();
});

test("empty state keeps measuring the width latch and leaving a session fades before unmount", async () => {
  await page.viewport(1284, 900);
  const fixture = (available: boolean) => <PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout statusAvailable={available} /></PwaAppShell></PwaUiProvider>;
  const screen = await render(fixture(false));
  await expectLane(false);
  expect(document.querySelector(".pwa-session-status-card")).toBeNull();
  // 没有会话时初次主区 992 仍使 latch 进入 fit，主区 1002 打开会话即可让位。
  await page.viewport(1294, 900);
  await screen.rerender(fixture(true));
  await expectLane(true);
  const root = layoutElement(".pwa-root");
  root.style.setProperty("--pwa-duration-fade", "1s");
  await screen.rerender(fixture(false));
  const leaving = layoutElement(".pwa-session-status-card");
  expect(leaving.dataset.presence).toBe("leaving");
  expect(leaving.inert).toBe(true);
  expect(leaving.getAttribute("aria-hidden")).toBe("true");
  expect(leaving.querySelector(".pwa-session-status-content")).toBeNull();
  expect(getComputedStyle(leaving).visibility).toBe("visible");
  await expect.poll(() => leaving.getAnimations().length).toBeGreaterThan(0);
  await expect.poll(() => document.querySelector(".pwa-session-status-card"), { timeout: 5000 }).toBeNull();
  await expectLane(false);
  await screen.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expectLane(false);
  await page.viewport(991, 900);
  await expectLane(false);
  await page.viewport(1002, 900);
  await screen.rerender(fixture(true));
  await expectLane(false);
  await page.viewport(1012, 900);
  await expectLane(true);
});

test("all view kinds keep the same card shell and lane while stale live values disappear immediately", async () => {
  await page.viewport(1600, 900);
  const fixture = (statusView: SessionStatusView) => <PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout statusView={statusView} /></PwaAppShell></PwaUiProvider>;
  const screen = await render(fixture(view));
  await expectLane(true);
  const card = layoutElement(".pwa-session-status-card");
  const title = card.querySelector("h2");
  const shellBox = card.getBoundingClientRect();
  const reserveWrites: MutationRecord[] = [];
  const main = layoutElement(".pwa-main");
  const observer = new MutationObserver(records => reserveWrites.push(...records));
  observer.observe(main, { attributes: true, attributeFilter: ["style", "data-session-status-card"] });
  try {
    for (const kind of ["offline", "loading", "unsupported", "unavailable"] as const) {
      await screen.rerender(fixture(view));
      expect(card.textContent).toContain("42.0%");
      await screen.rerender(fixture({ kind }));
      expect(layoutElement(".pwa-session-status-card")).toBe(card);
      expect(card.querySelector("h2")).toBe(title);
      expect(card.textContent).not.toContain("42.0%");
      expect(card.textContent).not.toContain("1.2M");
      expect(card.textContent).not.toContain("$0.000");
      expect(card.querySelector('[role="status"]')?.textContent?.length).toBeGreaterThan(0);
      const box = card.getBoundingClientRect();
      expect([box.left, box.top, box.width].map(Math.round)).toEqual([shellBox.left, shellBox.top, shellBox.width].map(Math.round));
      await expectLane(true);
    }
    reserveWrites.push(...observer.takeRecords());
    expect(reserveWrites).toHaveLength(0);
  } finally { observer.disconnect(); }
});

test("placeholder kind changes use fade timing and clip only safe outgoing text to the new content", async () => {
  await page.viewport(1600, 900);
  const fixture = (statusView: SessionStatusView) => <PwaUiProvider><PwaAppShell runtimeNotice={null}><Layout statusView={statusView} /></PwaAppShell></PwaUiProvider>;
  const screen = await render(fixture(view));
  await expectLane(true);
  const root = layoutElement(".pwa-root");
  root.style.setProperty("--pwa-duration-fade", "1s");
  root.style.setProperty("--pwa-duration-toast", "2s");
  await screen.rerender(fixture({ kind: "loading" }));
  const loading = layoutElement('.pwa-session-status-kind[data-kind="loading"]');
  expect(getComputedStyle(loading).transitionDuration).toBe("1s");
  expect(layoutElement(".pwa-session-status-card").textContent).not.toContain("42.0%");
  await expect.poll(() => loading.getAnimations().length).toBeGreaterThan(0);
  await expect.poll(() => getComputedStyle(loading).opacity).toBe("1");
  await screen.rerender(fixture({ kind: "offline" }));
  expect(loading.dataset.presence).toBe("leaving");
  expect(loading.inert).toBe(true);
  expect(loading.getAttribute("aria-hidden")).toBe("true");
  expect(getComputedStyle(loading).position).toBe("absolute");
  expect(getComputedStyle(loading.parentElement!).overflow).toBe("hidden");
  expect(Math.round(loading.getBoundingClientRect().height)).toBe(Math.round(loading.parentElement!.getBoundingClientRect().height));
  const offline = layoutElement('.pwa-session-status-kind[data-kind="offline"]');
  expect(offline.hasAttribute("data-presence")).toBe(false);
  expect(offline.querySelector('[role="status"]')?.textContent?.length).toBeGreaterThan(0);
  expect(getComputedStyle(offline).transitionDuration).toBe("1s");
  await expect.poll(() => offline.getAnimations().length).toBeGreaterThan(0);
  await expect.poll(() => document.querySelector('.pwa-session-status-kind[data-kind="loading"]'), { timeout: 5000 }).toBeNull();
  await expectLane(true);
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
