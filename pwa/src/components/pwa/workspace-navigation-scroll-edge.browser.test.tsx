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

test("the desktop navigation edge line follows the scroll position", async () => {
  await render(<PwaUiProvider><SidebarScrollHarness /></PwaUiProvider>);
  const brand = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-sidebar-brand")!;
  const scroll = document.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-navigation-scroll")!;

  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(getComputedStyle(brand, "::after").opacity).toBe("0");

  scroll.scrollTop = 160;
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => getComputedStyle(brand, "::after").opacity).toBe("1");
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-navigation-scroll-edge.png" });

  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => getComputedStyle(brand, "::after").opacity).toBe("0");
});
