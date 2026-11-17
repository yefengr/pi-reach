import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { DesktopSidebar, type WorkspaceNavigationProps } from "./workspace-view";
import { ChoosePiWorkspace } from "./workspace-content";
import { SessionSheet } from "./session-sheet";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";
import { useBackgroundCompletionNotices } from "@/lib/pwa/use-background-completion-notices";
import { renderPwa } from "@/test/browser/render";

type Variant = "desktop" | "sheet" | "choose";
const device: PwaDeviceRecord = {
  id: "sort-device", deviceId: "sort-device-key", nickname: "Sorting computer",
  relayUrl: "https://relay.example.test", pairedAt: "2026-01-01T00:00:00Z",
};
const devices = [device];
const snapshotDeviceIds = [device.deviceId];
const histories: TimelineSessionSummary[] = [
  { id: "latest", deviceId: device.deviceId, endpointId: "saved", sessionId: "latest-session", leafId: "latest-leaf", name: "Latest saved", preview: "", startedAt: 1, updatedAt: 20, eventCount: 1 },
  { id: "older", deviceId: device.deviceId, endpointId: "saved", sessionId: "older-session", leafId: "older-leaf", name: "Older saved", preview: "", startedAt: 1, updatedAt: 10, eventCount: 1 },
];
function endpoint(endpointId: string, name: string, working: boolean): PwaEndpointRecord {
  return { id: `${endpointId}-record`, deviceId: device.deviceId, endpointId, runtimeInstanceId: `${endpointId}-runtime`, kind: "interactive", name, cwd: "/workspace/sorting", working, online: true, updatedAt: 1 };
}
const initialEndpoints = [
  endpoint("idle", "A idle", false),
  endpoint("running", "B running", true),
  endpoint("finished", "C finished", true),
  endpoint("restarted", "D restarted", true),
];
const finishedEndpoints = initialEndpoints.map(item => item.endpointId === "finished" || item.endpointId === "restarted" ? { ...item, working: false } : item);
const restartedEndpoints = finishedEndpoints.map(item => item.endpointId === "restarted" ? { ...item, working: true } : item);
const noop = () => {};

/** 通过正式完成提醒 hook 驱动三种真实入口，避免测试夹具另造一套提醒语义。 */
function SortHarness({ variant, endpoints }: { variant: Variant; endpoints: PwaEndpointRecord[] }) {
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(variant === "choose" ? null : "idle");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [origin, setOrigin] = useState<HTMLButtonElement | null>(null);
  const viewingEndpoint = selectedHistoryId === null ? endpoints.find(item => item.endpointId === activeEndpointId) ?? null : null;
  const { completedEndpointIds } = useBackgroundCompletionNotices({ devices, endpoints, snapshotDeviceIds, viewingEndpoint });
  const selectEndpoint = (id: string) => { setActiveEndpointId(id); setSelectedHistoryId(null); };
  const navigation: WorkspaceNavigationProps = {
    devices, endpoints, history: histories, activeDeviceId: device.id,
    activeEndpointId, selectedHistoryId, snapshotReady: true, completedEndpointIds,
    onSelectEndpoint: selectEndpoint, onSelectHistory: entry => setSelectedHistoryId(entry.id),
    onPair: noop, onSettings: noop, onSelectDevice: noop, onRename: noop, onRemove: noop,
  };
  if (variant === "desktop") return <DesktopSidebar {...navigation} />;
  if (variant === "choose") return <ChoosePiWorkspace endpoints={endpoints} completedEndpointIds={completedEndpointIds} onSelect={selectEndpoint} />;
  return <>
    <button type="button" onClick={event => { setOrigin(event.currentTarget); setOpened(true); }}>Open navigation</button>
    <SessionSheet {...navigation} opened={opened} focusOrigin={origin} onClose={() => setOpened(false)} />
  </>;
}

function root(variant: Variant): HTMLElement {
  const selector = variant === "desktop" ? ".pwa-sidebar" : variant === "choose" ? ".pwa-choose-pi" : '[role="dialog"].pwa-session-sheet';
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${variant} list`);
  return element;
}
function order(variant: Variant): (string | null)[] {
  return [...root(variant).querySelectorAll(".pwa-nav-session")].map(item => item.getAttribute("title"));
}
function row(variant: Variant, id: string): HTMLButtonElement {
  const element = root(variant).querySelector<HTMLButtonElement>(`[data-flip-key="${id}-record"]`);
  if (!element) throw new Error(`Missing Pi row ${id}`);
  return element;
}
function historyOrder(variant: Variant): (string | null)[] {
  return [...root(variant).querySelectorAll(".pwa-history-row")].map(item => item.getAttribute("title"));
}

afterEach(async () => { await page.viewport(1280, 900); });

test.each(["desktop", "sheet", "choose"] as const)("%s keeps priority, marks and selection consistent through completion and restart", async (variant) => {
  await page.viewport(variant === "sheet" ? 390 : 1280, 900);
  const screen = await renderPwa(<SortHarness variant={variant} endpoints={initialEndpoints} />);
  // renderPwa 的初始包装树也要用于 rerender，保持真实 Provider 和 Portal 根常驻。
  const rerender = (endpoints: PwaEndpointRecord[]) => screen.rerender(
    <PwaUiProvider><div className="pwa-root"><SortHarness variant={variant} endpoints={endpoints} /></div></PwaUiProvider>,
  );
  const openSheet = async () => {
    const trigger = screen.getByRole("button", { name: "Open navigation", exact: true });
    await expect.element(trigger).toBeVisible();
    trigger.element().focus();
    await trigger.click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.poll(() => Math.round(root(variant).getBoundingClientRect().left)).toBe(0);
    return trigger;
  };
  try {
    if (variant === "sheet") await openSheet();
    await expect.poll(() => order(variant)).toEqual(["B running", "C finished", "D restarted", "A idle"]);
    await rerender(finishedEndpoints);
    await expect.poll(() => order(variant)).toEqual(["C finished", "D restarted", "B running", "A idle"]);
    expect(row(variant, "finished").querySelector(".pwa-notice-dot")).not.toBeNull();
    if (variant !== "choose") expect(historyOrder(variant)).toEqual(["Latest saved", "Older saved"]);

    const runningRow = row(variant, "running");
    runningRow.focus();
    await rerender(restartedEndpoints);
    await expect.poll(() => order(variant)).toEqual(["C finished", "B running", "D restarted", "A idle"]);
    expect(row(variant, "running")).toBe(runningRow);
    expect(document.activeElement).toBe(runningRow);
    expect(row(variant, "restarted").querySelector(".pwa-running-indicator")).not.toBeNull();
    expect(row(variant, "restarted").querySelector(".pwa-notice-dot")).toBeNull();

    await rerender(finishedEndpoints);
    await expect.poll(() => order(variant)).toEqual(["C finished", "D restarted", "B running", "A idle"]);
    expect(row(variant, "restarted").querySelector(".pwa-notice-dot")).not.toBeNull();
    await userEvent.click(row(variant, "finished"));
    if (variant === "sheet") {
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      await expect.element(screen.getByRole("button", { name: "Open navigation", exact: true })).toHaveFocus();
      await openSheet();
    }
    await expect.poll(() => order(variant)).toEqual(["D restarted", "B running", "A idle", "C finished"]);
    expect(row(variant, "finished").querySelector(".pwa-notice-dot")).toBeNull();
    if (variant !== "choose") {
      expect(row(variant, "finished").getAttribute("aria-current")).toBe("true");
      expect(historyOrder(variant)).toEqual(["Latest saved", "Older saved"]);
      await userEvent.click(root(variant).querySelector<HTMLButtonElement>('.pwa-history-row[title="Latest saved"]')!);
      if (variant === "sheet") {
        await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
        await openSheet();
      }
      // 阅读历史时，即使 activeEndpointId 仍指向该 Pi，后台结束也应重新产生提醒。
      const nextRun = finishedEndpoints.map(item => item.endpointId === "finished" ? { ...item, working: true } : item);
      await rerender(nextRun);
      await expect.poll(() => order(variant)).toEqual(["D restarted", "B running", "C finished", "A idle"]);
      await rerender(finishedEndpoints);
      await expect.poll(() => order(variant)).toEqual(["C finished", "D restarted", "B running", "A idle"]);
      expect(row(variant, "finished").hasAttribute("aria-current")).toBe(false);
      expect(row(variant, "finished").querySelector(".pwa-notice-dot")).not.toBeNull();
      expect(historyOrder(variant)).toEqual(["Latest saved", "Older saved"]);
    }
    if (variant === "sheet") {
      await userEvent.keyboard("{Escape}");
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      await expect.element(screen.getByRole("button", { name: "Open navigation", exact: true })).toHaveFocus();
    }
  } finally {
    await screen.unmount();
  }
});
