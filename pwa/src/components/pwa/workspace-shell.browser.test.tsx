import { useState } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { MessageList } from "./message-list";
import { ReadOnlyComposer } from "./message-composer";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { WorkspaceNavigationProps } from "./workspace-view";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";

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

function ShellHarness({ composer = false }: { composer?: boolean }) {
  const [draft, setDraft] = useState("");
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const viewport = useTimelineViewport(items);
  return <PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout navigation={navigation} titleBar={{ title: "pi-reach", prefix: "pi-reach", showTitle: true }} toast={null} settingsRoute={route} onOpenSettings={openSettings} onSettingsBack={closeSettings} renderSettings={() => <button onClick={closeSettings}>Return to workspace</button>} overlays={null} closeBackgroundOverlay={(close) => close()}>
    <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} isLive />
    <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
    {composer ? <ReadOnlyComposer notice="Read-only history" modelName="test-model" thinking="medium" /> : null}
  </PwaWorkspaceLayout></PwaAppShell>;
}
const mount = (options: { composer?: boolean } = {}) => render(<PwaUiProvider><ShellHarness {...options} /></PwaUiProvider>);

beforeEach(async () => {
  localStorage.removeItem("pi-reach-sidebar-collapsed");
  localStorage.removeItem("pi-reach-sidebar-width");
  await page.viewport(1280, 900);
});

afterEach(async () => {
  await cleanup();
  localStorage.removeItem("pi-reach-sidebar-width");
  localStorage.removeItem(APPEARANCE_STORAGE_KEY);
  for (const name of ["top", "bottom", "left", "right"]) document.documentElement.style.removeProperty(`--pwa-safe-${name}`);
  delete document.documentElement.dataset.pwaTextSize;
});

test.each([
  [1280, "light"], [1280, "dark"], [768, "light"], [768, "dark"],
] as const)("sidebar owns its radius and elevation without changing the computer popover at %spx in %s mode", async (width, appearance) => {
  await page.viewport(width, 900);
  localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  const screen = await mount();
  await expect.poll(() => document.documentElement.getAttribute("data-mantine-color-scheme")).toBe(appearance);
  const sidebar = document.querySelector<HTMLElement>(".pwa-desktop-navigation")!;
  const style = getComputedStyle(sidebar);
  expect(style.borderRadius).toBe("16px");
  expect(style.boxShadow).toBe(appearance === "dark" ? "none"
    : "rgba(0, 0, 0, 0.08) 0px 1px 2px 0px, rgba(0, 0, 0, 0.04) 0px 2px 8px 0px");
  expect(style.backgroundColor).toBe(appearance === "dark" ? "rgb(40, 40, 40)" : "rgb(247, 247, 247)");
  expect(style.borderTopWidth).toBe(getComputedStyle(document.documentElement).getPropertyValue("--pwa-hairline").trim());
  expect(style.borderTopColor).toBe(appearance === "dark" ? "rgba(255, 255, 255, 0.16)" : "rgba(0, 0, 0, 0.12)");
  expect(getComputedStyle(sidebar.querySelector(".pwa-nav-session")!).borderRadius).toBe("8px");

  await screen.getByRole("button", { name: "Choose computer, current MacBook Pro" }).click();
  await expect.poll(() => document.querySelector(".pwa-device-popover")).not.toBeNull();
  const popover = getComputedStyle(document.querySelector(".pwa-device-popover")!);
  expect(popover.borderRadius).toBe("12px");
  expect(popover.boxShadow).toBe(appearance === "dark"
    ? "rgba(0, 0, 0, 0.32) 0px 1px 2px 0px, rgba(0, 0, 0, 0.28) 0px 4px 16px 0px"
    : "rgba(0, 0, 0, 0.12) 0px 1px 2px 0px, rgba(0, 0, 0, 0.08) 0px 4px 16px 0px");
});

test("ordinary safe areas protect the floating frame and settings covers both brand and title", async () => {
  for (const [name, value] of [["left", 24], ["right", 32], ["top", 16], ["bottom", 20]] as const) document.documentElement.style.setProperty(`--pwa-safe-${name}`, `${value}px`);
  const screen = await mount();
  const nav = document.querySelector<HTMLElement>(".pwa-desktop-navigation")!;
  const brand = nav.querySelector<HTMLElement>(".pwa-sidebar-brand")!;
  const logo = brand.querySelector("svg")!;
  const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
  const settings = screen.getByRole("button", { name: "Open settings" });
  const frame = nav.getBoundingClientRect();
  expect([frame.left, frame.top, window.innerHeight - frame.bottom].map(Math.round)).toEqual([36, 16, 20]);
  for (const [size, pixels] of [["standard", 14], ["large", 16], ["xlarge", 18]] as const) {
    document.documentElement.dataset.pwaTextSize = size;
    await expect.poll(() => getComputedStyle(brand).fontSize).toBe(`${pixels}px`);
    expect(getComputedStyle(brand).fontWeight).toBe("400");
    expect(Math.round(logo.getBoundingClientRect().width)).toBe(20);
    for (const button of [toggle.element(), settings.element()]) {
      const box = button.getBoundingClientRect();
      expect([box.width, box.height].map(Math.round)).toEqual([44, 44]);
      expect(button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true);
    }
  }
  const separator = screen.getByRole("separator").element();
  const splitter = separator.getBoundingClientRect();
  expect(Math.round(splitter.left)).toBe(Math.round(frame.right));
  expect(Math.round(splitter.top)).toBeGreaterThanOrEqual(Math.round(brand.getBoundingClientRect().bottom) - 1);
  // 视觉线压住侧栏右边框，不再跟着 8px 透明命中区整体外移。
  const resizerEdge = getComputedStyle(separator, "::before");
  expect(resizerEdge.left).toBe("-1px");
  expect(resizerEdge.width).toBe("2px");
  const main = screen.getByRole("main").element();
  expect(Math.round(main.getBoundingClientRect().top)).toBe(0);
  expect(getComputedStyle(main).borderRadius).toBe("0px");
  await settings.click();
  const surface = document.querySelector<HTMLElement>(".pwa-settings-view")!;
  await settleLayout();
  expect(surface.getBoundingClientRect().top).toBe(0);
  for (const x of [60, 600]) expect(surface.contains(document.elementFromPoint(x, 40))).toBe(true);
  expect(document.querySelector(".pwa-workspace-view")!.hasAttribute("inert")).toBe(true);
  await screen.getByRole("button", { name: "Return to workspace" }).click();
  await expect.poll(() => document.querySelector(".pwa-settings-view")).toBeNull();
  await expect.element(toggle).toBeVisible();
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
  // 展开时位于侧栏品牌行右端，收起后停在贴边主区标题区左端（距窗口 8），与品牌行同高、与标题同一行。
  const brand = document.querySelector(".pwa-desktop-navigation .pwa-sidebar-brand")!.getBoundingClientRect();
  expect(Math.round(before.right)).toBe(284);
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
  // 面板宽度按侧栏内容宽计算，不再等于底部入口宽度。
  const sidebarFrame = document.querySelector<HTMLElement>(".pwa-desktop-navigation")!.getBoundingClientRect();
  const popover = document.querySelector<HTMLElement>(".pwa-device-popover")!.getBoundingClientRect();
  expect(Math.round(popover.width)).toBe(Math.round(sidebarFrame.width - 16));
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

test("moves the session title in one direction while the sidebar collapses and expands", async () => {
  const screen = await mount();
  const titleBar = document.querySelector<HTMLElement>(".pwa-title-bar")!;
  const layout = document.querySelector<HTMLElement>(".pwa-layout")!;
  const name = titleBar.querySelector<HTMLElement>(".pwa-title-bar-name")!;
  await settleLayout();
  const sample = async (label: string) => {
    const samples = [name.getBoundingClientRect().left];
    // 同步派发点击，从切换前一帧开始采样，避免异步点击晚到掩盖第一帧的跳动。
    (screen.getByRole("button", { name: label }).element() as HTMLElement).click();
    for (let frame = 0; frame < 120 && (frame === 0 || [titleBar, layout].some((element) => element.getAnimations().length > 0)); frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(name.getBoundingClientRect().left);
    }
    return samples.map(Math.round);
  };
  const collapse = await sample("Collapse sidebar");
  expect(collapse.length).toBeGreaterThan(3);
  expect(collapse.every((left, index) => index === 0 || left <= collapse[index - 1])).toBe(true);
  expect(collapse.at(-1)).toBeLessThan(collapse[0]);
  const expand = await sample("Expand sidebar");
  expect(expand.every((left, index) => index === 0 || left >= expand[index - 1])).toBe(true);
  expect(expand.at(-1)).toBe(collapse[0]);
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
  expect(getComputedStyle(dialog.element()).borderRadius).toBe("0px");
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

test("aligns the sidebar bottom with the real composer card across safe areas and compact errors", async () => {
  const readGap = (selector: string) => {
    const box = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    return Math.round(window.innerHeight - box.bottom);
  };
  for (const safeBottom of [0, 20]) {
    if (safeBottom > 0) document.documentElement.style.setProperty("--pwa-safe-bottom", `${safeBottom}px`);
    const screen = await mount({ composer: true });
    try {
      const expected = Math.max(16, safeBottom);
      await expect.poll(() => readGap(".pwa-desktop-navigation")).toBe(expected);
      await expect.poll(() => readGap(".pwa-composer-card")).toBe(expected);
      expect(readGap(".pwa-desktop-navigation")).toBe(readGap(".pwa-composer-card"));
      // 键盘可聚焦的分隔条保留轮廓；悬停与拖动都不额外画竖线。
      const separator = screen.getByRole("separator").element();
      screen.getByRole("button", { name: "Open settings" }).element().focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(separator);
      await expect.poll(() => getComputedStyle(separator, "::before").boxShadow).toContain("rgb");
      await userEvent.hover(separator);
      await expect.poll(() => getComputedStyle(separator, "::before").backgroundColor).toBe("rgba(0, 0, 0, 0)");
      document.querySelector(".pwa-root")!.setAttribute("data-sidebar-resizing", "");
      expect(getComputedStyle(separator, "::before").backgroundColor).toBe("rgba(0, 0, 0, 0)");
      document.querySelector(".pwa-root")!.removeAttribute("data-sidebar-resizing");
      // 局部错误浮在标题区下方、不占布局（ADR-20261105）：极矮窗口出现错误时，输入区与侧栏的底部留白都不变。
      document.querySelector<HTMLElement>(".pwa-app-shell")!.dataset.compactHeight = "very-short";
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const gaps = [readGap(".pwa-desktop-navigation"), readGap(".pwa-composer-card")];
      const error = document.createElement("div");
      error.className = "pwa-status-error";
      document.querySelector<HTMLElement>(".pwa-main-notices")!.append(error);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect([readGap(".pwa-desktop-navigation"), readGap(".pwa-composer-card")]).toEqual(gaps);
      expect(gaps[0]).toBe(gaps[1]);
    } finally {
      await screen.unmount();
      document.documentElement.style.removeProperty("--pwa-safe-bottom");
    }
  }
});
