import { useEffect, useRef, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SessionSheet } from "./session-sheet";
import { renderPwa } from "@/test/browser/render";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";
import type { PairingPresence } from "./workspace-view";

const alphaDevice: PwaDeviceRecord = {
  id: "device:alpha",
  deviceId: "alpha-public-key-1234",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  nickname: "Alpha Pi",
};
const betaDevice: PwaDeviceRecord = {
  id: "device:beta",
  deviceId: "beta-public-key-5678",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-03T00:00:00.000Z",
  nickname: "Beta Pi with a name long enough to truncate safely",
};
const devices = [alphaDevice, betaDevice];
const endpoints: PwaEndpointRecord[] = [
  { id: "alpha-live-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-live", runtimeInstanceId: "alpha-runtime-live", kind: "interactive", name: "A live Pi", cwd: "/workspace/live", online: true, updatedAt: 1 },
  { id: "alpha-working-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-working", runtimeInstanceId: "alpha-runtime-working", kind: "interactive", name: "B working Pi", cwd: "/workspace/working", working: true, online: true, updatedAt: 2 },
  { id: "alpha-offline-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-offline", runtimeInstanceId: "alpha-runtime-offline", kind: "interactive", name: "Old cached Pi", online: false, updatedAt: 3 },
  { id: "beta-live-record", deviceId: betaDevice.deviceId, endpointId: "beta-live", runtimeInstanceId: "beta-runtime-live", kind: "interactive", name: "Beta live Pi", online: true, updatedAt: 4 },
];
const history: TimelineSessionSummary = {
  id: "alpha-history",
  deviceId: alphaDevice.deviceId,
  endpointId: "old-process",
  sessionId: "saved-session",
  leafId: "saved-generation",
  startedAt: 1,
  updatedAt: 2,
  eventCount: 3,
  preview: "Sprint recap",
};
const pairingPresence: Record<string, PairingPresence> = {
  [alphaDevice.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 },
  [betaDevice.id]: { status: "online", onlineEndpoints: 1, totalEndpoints: 1 },
};

function histories(count = 1): TimelineSessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...history,
    id: `alpha-history-${index}`,
    sessionId: `saved-session-${index}`,
    leafId: `saved-generation-${index}`,
    updatedAt: index + 2,
    preview: index === count - 1 ? `Final saved conversation ${index + 1}` : `Saved conversation ${index + 1}`,
  }));
}

type HarnessProps = {
  events: string[];
  renamed?: PwaDeviceRecord[];
  removed?: PwaDeviceRecord[];
  rejectClose?: boolean;
  activeEndpointId?: string | null;
  selectedHistoryId?: string | null;
  historyItems?: TimelineSessionSummary[];
  conditionallyUnmount?: boolean;
};

function SessionSheetHarness({ events, renamed = [], removed = [], rejectClose = false, activeEndpointId = "alpha-live", selectedHistoryId = null, historyItems = [history], conditionallyUnmount = false }: HarnessProps) {
  const [mounted, setMounted] = useState(false);
  const [opened, setOpened] = useState(false);
  const [focusOrigin, setFocusOrigin] = useState<HTMLElement | null>(null);
  const [actionTarget, setActionTarget] = useState<string | null>(null);
  const actionTargetRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { actionTargetRef.current?.focus(); }, [actionTarget]);
  const finish = (event: string) => { events.push(event); setActionTarget(event); };
  const close = () => {
    events.push("close");
    if (rejectClose) return;
    setOpened(false);
    if (conditionallyUnmount) setMounted(false);
  };
  const open = () => {
    setFocusOrigin(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setMounted(true);
    setOpened(true);
  };
  return <>
    <button type="button" onClick={open}>Open navigation</button>
    {actionTarget ? <button ref={actionTargetRef} type="button" data-testid="action-target">{actionTarget}</button> : null}
    {mounted ? <SessionSheet
      devices={devices}
      endpoints={endpoints}
      history={historyItems}
      activeDeviceId={alphaDevice.id}
      activeEndpointId={activeEndpointId}
      selectedHistoryId={selectedHistoryId}
      snapshotReady
      pairingPresence={pairingPresence}
      onSelectDevice={(deviceId) => finish(`device:${deviceId}`)}
      onSelectEndpoint={(endpointId) => finish(`pi:${endpointId}`)}
      onSelectHistory={(entry) => finish(`history:${entry.id}`)}
      onPair={() => finish("pair")}
      onSettings={() => finish("settings")}
      onRename={(device) => { renamed.push(device); finish(`rename:${device.id}`); }}
      onRemove={(device) => { removed.push(device); finish(`remove:${device.id}`); }}
      onClose={close}
      focusOrigin={focusOrigin}
      opened={opened}
    /> : null}
  </>;
}

beforeEach(async () => { await page.viewport(1280, 900); });

async function openSheet(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  trigger.element().focus();
  await trigger.click();
  const dialog = screen.getByRole("dialog", { name: "Workspace" });
  await expect.element(dialog).toBeVisible();
  await expect.poll(() => Math.round(dialog.element().getBoundingClientRect().left)).toBe(0);
  return { trigger, dialog };
}

async function waitForClosed(screen: Awaited<ReturnType<typeof renderPwa>>) {
  await expect.element(screen.getByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument();
}

test("portals the full-height Drawer and restores focus for each plain close path", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} />);
  const { trigger, dialog } = await openSheet(screen);
  const root = document.querySelector<HTMLElement>(".mantine-Drawer-root");
  expect(root?.closest(".pwa-root")).not.toBeNull();
  await expect.element(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true);
  expect(Math.round(dialog.element().getBoundingClientRect().height)).toBe(window.innerHeight);

  await screen.getByRole("button", { name: "Close navigation" }).click();
  await waitForClosed(screen);
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  await userEvent.keyboard("{Escape}");
  await waitForClosed(screen);
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForClosed(screen);
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual(["close", "close", "close"]);
});

test("keeps focus trapped when the parent rejects a close request", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} rejectClose />);
  const { trigger, dialog } = await openSheet(screen);
  await screen.getByRole("button", { name: "Close navigation" }).click();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await expect.element(dialog).toBeVisible();
  await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true);
  await expect.element(trigger).not.toHaveFocus();
  expect(events).toEqual(["close"]);

  await screen.getByRole("button", { name: "Pair a computer" }).click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect.element(dialog).toBeVisible();
  expect(events).toEqual(["close", "close"]);
});

test("shows online Pi and local history together and routes choices after exit", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} />);
  const { trigger } = await openSheet(screen);

  await expect.element(screen.getByText("Online Pi", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Local history", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Saved in this browser only", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Sprint recap", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Old cached Pi", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Beta live Pi", { exact: true })).not.toBeInTheDocument();
  expect(document.querySelector('[role="tab"]')).toBeNull();
  const currentLive = screen.getByRole("button", { name: /A live Pi/ });
  const selectableLive = screen.getByRole("button", { name: /B working Pi/ });
  // 当前项保持可聚焦，以 aria-current 标记；第二行为目录与运行状态。
  await expect.element(currentLive).toHaveAttribute("aria-current", "true");
  await expect.element(currentLive).toBeEnabled();
  await expect.element(selectableLive).toBeEnabled();
  expect(selectableLive.element().textContent).toContain("Running");

  await selectableLive.click();
  await waitForClosed(screen);
  await expect.poll(() => events).toEqual(["close", "pi:alpha-working"]);
  await expect.element(screen.getByTestId("action-target")).toHaveFocus();

  await trigger.click();
  await screen.getByRole("button", { name: /Sprint recap/ }).click();
  await waitForClosed(screen);
  await expect.poll(() => events.slice(-2)).toEqual(["close", "history:alpha-history"]);
  await expect.element(screen.getByTestId("action-target")).toHaveFocus();

  // 进入设置页不先关闭导航：导航随设置页推入转场直接卸载，由工作区布局负责。
  await trigger.click();
  await screen.getByRole("button", { name: "Open settings" }).click();
  await expect.poll(() => events.slice(-1)).toEqual(["settings"]);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await screen.getByRole("button", { name: "Close navigation" }).click();
  await waitForClosed(screen);

  await trigger.click();
  await screen.getByRole("button", { name: "Pair a computer" }).click();
  await expect.poll(() => events.slice(-2)).toEqual(["close", "pair"]);
  await expect.element(screen.getByTestId("action-target")).toHaveFocus();
});

test("computer chooser owns Escape, closes before actions, and keeps navigation behind remove", async () => {
  const events: string[] = [];
  const renamed: PwaDeviceRecord[] = [];
  const removed: PwaDeviceRecord[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={renamed} removed={removed} />);
  const { trigger } = await openSheet(screen);
  const chooseComputer = screen.getByRole("button", { name: /Choose computer, current Alpha Pi/ });

  await chooseComputer.click();
  const chooser = screen.getByRole("dialog", { name: "Choose computer" });
  await expect.element(chooser).toBeVisible();
  expect(getComputedStyle(chooser.element().closest(".mantine-Drawer-root")!).getPropertyValue("--mb-z-index")).toBe("220");
  await userEvent.keyboard("{Escape}");
  await expect.element(chooser).not.toBeInTheDocument();
  await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
  expect(events).toEqual([]);

  await chooseComputer.click();
  await screen.getByRole("button", { name: /^Beta Pi with a name long enough/ }).click();
  await expect.poll(() => events).toEqual(["close", "device:device:beta"]);
  await expect.element(screen.getByTestId("action-target")).toHaveFocus();

  await trigger.click();
  await chooseComputer.click();
  await screen.getByRole("button", { name: /Computer actions for Beta Pi/ }).click();
  await screen.getByRole("menuitem", { name: /Rename Beta Pi/ }).click();
  await expect.poll(() => renamed).toEqual([betaDevice]);
  expect(events.slice(-2)).toEqual(["close", "rename:device:beta"]);
  await expect.element(screen.getByTestId("action-target")).toHaveFocus();

  await trigger.click();
  await chooseComputer.click();
  await screen.getByRole("button", { name: /Computer actions for Beta Pi/ }).click();
  await screen.getByRole("menuitem", { name: /Remove Beta Pi/ }).click();
  await expect.poll(() => removed).toEqual([betaDevice]);
  expect(events.at(-1)).toBe("remove:device:beta");
  await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
});

test("consecutive Escape presses close chooser then navigation without waiting for the exit animation", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} />);
  const { trigger } = await openSheet(screen);
  await screen.getByRole("button", { name: /Choose computer, current Alpha Pi/ }).click();
  await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).toBeVisible();
  await userEvent.keyboard("{Escape}{Escape}");
  await waitForClosed(screen);
  await expect.poll(() => events).toEqual(["close"]);
  await expect.element(trigger).toHaveFocus();
});

test("exits saved history through an online Pi row and keeps the current history row focusable", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} activeEndpointId={null} selectedHistoryId={history.id} conditionallyUnmount />);
  await openSheet(screen);

  const currentHistory = screen.getByRole("button", { name: /Sprint recap/ });
  await expect.element(currentHistory).toHaveAttribute("aria-current", "true");
  await expect.element(currentHistory).toBeEnabled();
  expect(screen.getByRole("button", { name: "Back to live" }).query()).toBeNull();
  await screen.getByRole("button", { name: /B working Pi/ }).click();
  await waitForClosed(screen);
  await expect.poll(() => events).toEqual(["close", "pi:alpha-working"]);
});

const navigationViewports = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 740, height: 360 },
];

test("finishes a conditional-unmount action even when a frame runs before React commits", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} conditionallyUnmount />);
  await openSheet(screen);
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return 0;
  });
  try {
    (screen.getByRole("button", { name: "Pair a computer" }).element() as HTMLButtonElement).click();
  } finally {
    frame.mockRestore();
  }
  await waitForClosed(screen);
  await expect.poll(() => events).toEqual(["close", "pair"]);
  await expect.element(screen.getByTestId("action-target")).toHaveFocus();
});

test.each(navigationViewports)("keeps header and footer fixed while the only body scroller reaches the final history row at $width x $height", async ({ width, height }) => {
  await page.viewport(width, height);
  const screen = await renderPwa(<SessionSheetHarness events={[]} historyItems={histories(28)} />);
  const { dialog } = await openSheet(screen);
  const header = dialog.element().querySelector<HTMLElement>(".pwa-session-sheet-head")!;
  const scroll = dialog.element().querySelector<HTMLElement>(".pwa-navigation-scroll")!;
  const footer = dialog.element().querySelector<HTMLElement>(".pwa-session-sheet-foot")!;
  // 本地历史先显示 20 条，「显示更早的记录」每次追加 20 条。
  expect(dialog.element().querySelectorAll(".pwa-history-row")).toHaveLength(20);
  await screen.getByRole("button", { name: "Show earlier records" }).click();
  expect(dialog.element().querySelectorAll(".pwa-history-row")).toHaveLength(28);
  const last = screen.getByRole("button", { name: /Final saved conversation 28/ });
  const beforeHeader = header.getBoundingClientRect();
  const beforeFooter = footer.getBoundingClientRect();

  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(getComputedStyle(scroll).overflowY).toMatch(/auto|scroll/);
  expect(getComputedStyle(dialog.element()).display).toBe("flex");
  expect(getComputedStyle(header).flexShrink).toBe("0");
  expect(getComputedStyle(footer).flexShrink).toBe("0");
  scroll.scrollTop = scroll.scrollHeight;
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => Math.round(scroll.scrollTop + scroll.clientHeight)).toBeGreaterThanOrEqual(Math.round(scroll.scrollHeight) - 1);
  await expect.element(last).toBeVisible();
  const lastRect = last.element().getBoundingClientRect();
  expect(lastRect.bottom).toBeLessThanOrEqual(scroll.getBoundingClientRect().bottom + 1);
  expect(header.getBoundingClientRect().top).toBeCloseTo(beforeHeader.top, 0);
  expect(footer.getBoundingClientRect().bottom).toBeCloseTo(beforeFooter.bottom, 0);
  expect(dialog.element().getBoundingClientRect().width).toBe(Math.min(320, width * 0.85));
  expect(dialog.element().getBoundingClientRect().height).toBe(height);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
  await page.screenshot({ path: `../../../.vitest/screenshots/workspace-navigation-${width}x${height}.png` });
});
