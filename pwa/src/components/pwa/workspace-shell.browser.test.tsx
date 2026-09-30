import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { MessageList } from "./message-list";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { WorkspaceNavigationProps } from "./workspace-view";

const navigation: WorkspaceNavigationProps = {
  devices: [{ id: "computer", deviceId: "computer-key", nickname: "MacBook Pro", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01" }],
  endpoints: [{ id: "pi", deviceId: "computer-key", endpointId: "pi", runtimeInstanceId: "runtime", name: "pi-reach", cwd: "/workspace/pi-reach", kind: "interactive", online: true, updatedAt: 1 }],
  history: [{ id: "saved", deviceId: "computer-key", endpointId: "old", sessionId: "saved", leafId: "saved", startedAt: 1, updatedAt: 2, eventCount: 8, preview: "**Saved** [conversation](https://example.test)" }],
  activeDeviceId: "computer", activeEndpointId: "pi", selectedHistoryId: null, snapshotReady: true,
  pairingPresence: { computer: { status: "online", onlineEndpoints: 1, totalEndpoints: 1 } },
  onPair() {}, onSettings() {}, onSelectDevice() {}, onSelectEndpoint() {}, onSelectHistory() {}, onRename() {}, onRemove() {},
};
const items: TimelineViewItem[] = Array.from({ length: 30 }, (_, index) => ({
  kind: "event", event: { event_id: `message-${index}`, session_id: "live", leaf_id: "live", group_id: `group-${index}`, timestamp: index, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Paragraph ${index}. ${"Keep the reading position stable while the workspace sidebar changes width. ".repeat(12)}` }] },
}));

function ShellHarness() {
  const [draft, setDraft] = useState("");
  const viewport = useTimelineViewport(items);
  return <PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout navigation={navigation} titleBar={{ title: "pi-reach", prefix: "pi-reach", showTitle: true }} historyMode={false} toast={null} settingsRoute={{ open: false, origin: null, animate: false, change: 0 }} onOpenSettings={() => {}} renderSettings={() => null} overlays={null} closeBackgroundOverlay={(close) => close()}>
    <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} isLive />
    <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
  </PwaWorkspaceLayout></PwaAppShell>;
}
const mount = () => render(<PwaUiProvider><ShellHarness /></PwaUiProvider>);

beforeEach(async () => {
  localStorage.removeItem("pi-reach-sidebar-collapsed");
  await page.viewport(1280, 900);
});

async function settleLayout() {
  await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

test("moves the toggle from the sidebar brand row to the title bar start, preserving draft, focus, and preference", async () => {
  let screen = await mount();
  const draft = screen.getByRole("textbox", { name: "Draft" });
  await draft.fill("Unsent draft");
  draft.element().focus();
  const draftNode = draft.element();
  const button = screen.getByRole("button", { name: "Collapse sidebar" });
  const buttonNode = button.element();
  const before = buttonNode.getBoundingClientRect();
  const mainBefore = screen.getByRole("main").element().getBoundingClientRect();
  expect(before.width).toBeGreaterThanOrEqual(44);
  await button.click();
  await settleLayout();
  const after = buttonNode.getBoundingClientRect();
  // 展开时位于侧栏品牌行右端，收起后停在会话标题区左端，与标题同一行。
  const brand = document.querySelector(".pwa-desktop-navigation .pwa-sidebar-brand")!.getBoundingClientRect();
  expect(before.right).toBe(252);
  expect(before.top).toBeGreaterThanOrEqual(brand.top);
  expect(before.bottom).toBeLessThanOrEqual(brand.bottom);
  expect(after.x).toBe(8);
  expect(after.y).toBe(before.y);
  const heading = document.querySelector(".pwa-title-bar-heading")!.getBoundingClientRect();
  expect(heading.left).toBeGreaterThanOrEqual(after.right);
  expect(screen.getByRole("button", { name: "Expand sidebar" }).element()).toBe(buttonNode);
  expect(screen.getByRole("main").element().getBoundingClientRect().width).toBeGreaterThan(mainBefore.width + 250);
  expect(document.querySelector("#pwa-desktop-navigation")?.hasAttribute("inert")).toBe(true);
  expect(draft.element()).toBe(draftNode);
  await expect.element(draft).toHaveValue("Unsent draft");
  await expect.element(draft).toHaveFocus();
  await expect.poll(() => localStorage.getItem("pi-reach-sidebar-collapsed")).toBe("true");
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-desktop-collapsed.png" });
  await screen.unmount();

  screen = await mount();
  const expand = screen.getByRole("button", { name: "Expand sidebar" });
  await expect.element(expand).toBeVisible();
  expand.element().focus();
  await expect.element(expand).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await settleLayout();
  await expect.element(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus();
  expect(document.querySelector("#pwa-desktop-navigation")?.hasAttribute("inert")).toBe(false);
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-desktop-expanded.png" });
});

test("closes desktop computer portals and returns nested menu focus to the sidebar toggle", async () => {
  const screen = await mount();
  const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
  await screen.getByRole("button", { name: "Choose computer, current MacBook Pro" }).click();
  await expect.poll(() => document.querySelector<HTMLElement>(".pwa-device-popover")?.getClientRects().length ?? 0).toBeGreaterThan(0);
  await screen.getByRole("button", { name: "Computer actions for MacBook Pro" }).click();
  const rename = screen.getByRole("menuitem", { name: "Rename MacBook Pro" });
  await expect.element(rename).toBeVisible();
  rename.element().focus();
  await expect.element(rename).toHaveFocus();

  await collapse.click();
  await settleLayout();
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  expect(document.querySelector(".pwa-device-popover")).toBeNull();
  expect(document.querySelector(".pwa-peer-menu-panel")).toBeNull();
  const expand = screen.getByRole("button", { name: "Expand sidebar" });
  await expect.element(expand).toHaveFocus();

  await expand.click();
  await settleLayout();
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  expect(document.querySelector(".pwa-device-popover")).toBeNull();
  expect(document.querySelector(".pwa-peer-menu-panel")).toBeNull();
  await expect.element(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus();
});

test("preserves the visible message anchor through both sidebar transitions", async () => {
  const screen = await mount();
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  await expect.poll(() => list.scrollHeight > list.clientHeight).toBe(true);
  await settleLayout();
  const paragraph = screen.getByText(/^Paragraph 12\./).element();
  list.scrollTop += paragraph.getBoundingClientRect().top - list.getBoundingClientRect().top + 10;
  list.dispatchEvent(new Event("scroll"));
  await settleLayout();
  const listTop = list.getBoundingClientRect().top;
  const visibleParagraph = Array.from(list.querySelectorAll("p")).find((element) => element.getBoundingClientRect().bottom > listTop)!;
  expect(visibleParagraph).toBeDefined();
  const offset = () => visibleParagraph.getBoundingClientRect().top - list.getBoundingClientRect().top;
  const initialOffset = offset();
  await screen.getByRole("button", { name: "Collapse sidebar" }).click();
  await settleLayout();
  expect(Math.abs(offset() - initialOffset)).toBeLessThanOrEqual(2);
  await screen.getByRole("button", { name: "Expand sidebar" }).click();
  await settleLayout();
  expect(Math.abs(offset() - initialOffset)).toBeLessThanOrEqual(2);
});

test("keeps mobile navigation independent from desktop preference and shows both lists", async () => {
  localStorage.setItem("pi-reach-sidebar-collapsed", "true");
  await page.viewport(390, 844);
  const screen = await mount();
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  trigger.element().focus();
  await trigger.click();
  const dialog = screen.getByRole("dialog", { name: /Workspace/ });
  await expect.element(dialog).toBeVisible();
  await settleLayout();
  const rect = dialog.element().getBoundingClientRect();
  // 移动导航宽 min(320px, 85vw)，全高。
  expect(Math.round(rect.height)).toBe(844);
  expect(Math.round(rect.width)).toBe(320);
  await expect.element(dialog.getByText("Online Pi", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("Local history", { exact: true })).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: /Saved conversation/ })).toBeVisible();
  expect(dialog.element().querySelector('[role="tablist"]')).toBeNull();
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-mobile-navigation.png" });
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  await expect.element(screen.getByRole("textbox", { name: "Draft" })).toBeVisible();
  await page.viewport(1280, 900);
  await expect.element(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
});
