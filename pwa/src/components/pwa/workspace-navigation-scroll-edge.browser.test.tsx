import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { DesktopSidebar, type WorkspaceNavigationProps } from "./workspace-view";
import { useScrollIndicator } from "@/lib/ui/scroll-indicator";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";

/** 足够长的历史列表，让侧栏导航区在 520px 高度内可滚动。 */
const history: TimelineSessionSummary[] = Array.from({ length: 20 }, (_, index) => ({
  id: `history-${index}`,
  deviceId: "device-key",
  endpointId: `endpoint-${index}`,
  sessionId: `session-${index}`,
  leafId: `leaf-${index}`,
  startedAt: index,
  updatedAt: index + 1,
  eventCount: 4,
  preview: `Saved conversation ${index}`,
}));

const navigation: WorkspaceNavigationProps = {
  devices: [{ id: "device:main", deviceId: "device-key", nickname: "MacBook Pro", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01" }],
  endpoints: [{ id: "endpoint", deviceId: "device-key", endpointId: "pi", runtimeInstanceId: "runtime", name: "Pi Reach", cwd: "/workspace/pi-reach", kind: "interactive", online: true, updatedAt: 1 }],
  history,
  activeDeviceId: "device:main",
  activeEndpointId: "pi",
  selectedHistoryId: null,
  snapshotReady: true,
  onPair() {},
  onSettings() {},
  onSelectDevice() {},
  onSelectEndpoint() {},
  onSelectHistory() {},
  onRename() {},
  onRemove() {},
};

function SidebarScrollHarness() {
  useScrollIndicator();
  return <div className="pwa-root">
    <div className="pwa-desktop-navigation" style={{ height: 520 }}>
      <DesktopSidebar {...navigation} />
    </div>
  </div>;
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  await cleanup();
});

test("the desktop navigation edge line follows the scroll position and the footer owns the bottom fade", async () => {
  await render(<PwaUiProvider><SidebarScrollHarness /></PwaUiProvider>);
  const brand = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-sidebar-brand")!;
  const scroll = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-navigation-scroll")!;
  const footer = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-sidebar-foot")!;

  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(getComputedStyle(brand, "::after").opacity).toBe("0");
  // 底部渐隐挂在 footer 上沿，随 footer 高度自适应，不随列表滚动。
  const fade = getComputedStyle(footer, "::before");
  expect(fade.content).not.toBe("none");
  expect(fade.height).toBe("24px");
  expect(fade.pointerEvents).toBe("none");
  expect(fade.backgroundImage).toContain("linear-gradient");

  scroll.scrollTop = 160;
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => getComputedStyle(brand, "::after").opacity).toBe("1");
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-navigation-scroll-edge.png" });

  // 与消息列表一致：停在底部时最后一行落在 24px 渐隐带之上，不被淡化。
  scroll.scrollTop = scroll.scrollHeight;
  await expect.poll(() => Math.round(scroll.scrollTop + scroll.clientHeight)).toBeGreaterThanOrEqual(Math.round(scroll.scrollHeight) - 1);
  const lastRow = [...document.querySelectorAll<HTMLElement>(".pwa-desktop-navigation .pwa-history-row")].at(-1)!;
  expect(Math.round(scroll.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(23);

  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => getComputedStyle(brand, "::after").opacity).toBe("0");
});
