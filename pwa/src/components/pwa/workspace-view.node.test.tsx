import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerRow, displayDevice } from "./workspace-device-control";
import { DesktopSidebar } from "./workspace-view";
import { NoPiWorkspace, UnpairedWorkspace } from "./workspace-content";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";

function device(overrides: Partial<PwaDeviceRecord> = {}): PwaDeviceRecord {
  return {
    id: "device:main",
    deviceId: "e5FRoCabBqVX",
    relayUrl: "https://relay.example.test",
    pairedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function navLinkMarkup(html: string, label: string): string {
  const navLinks = html.match(/<button\b(?=[^>]*class="[^"]*mantine-NavLink-root[^"]*")[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return navLinks.find((navLink) => navLink.includes(`>${label}</span>`)) ?? "";
}

function buttonMarkup(html: string, label: string): string {
  const buttons = html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  return buttons.find((button) => button.includes(`>${label}<`)) ?? "";
}

function navigationProps() {
  const endpoints: PwaEndpointRecord[] = [
    { id: "endpoint-current", deviceId: "e5FRoCabBqVX", endpointId: "current", runtimeInstanceId: "runtime-current", kind: "interactive", name: "Current Pi", cwd: "/workspace/current", online: true, updatedAt: 1 },
    { id: "endpoint-next", deviceId: "e5FRoCabBqVX", endpointId: "next", runtimeInstanceId: "runtime-next", kind: "interactive", name: "Next Pi", cwd: "/workspace/next", working: true, online: true, updatedAt: 2 },
  ];
  const history: TimelineSessionSummary[] = [
    { id: "history-current", deviceId: "e5FRoCabBqVX", endpointId: "past", sessionId: "saved-current", leafId: "generation-current", startedAt: 1, updatedAt: 2, eventCount: 3, preview: "Current saved session", name: "  **Pinned history**  " },
    { id: "history-next", deviceId: "e5FRoCabBqVX", endpointId: "older", sessionId: "saved-next", leafId: "generation-next", startedAt: 3, updatedAt: 4, eventCount: 1, preview: "Earlier saved session" },
  ];
  return {
    devices: [device({ nickname: "Office Mac" })],
    endpoints,
    history,
    activeDeviceId: "device:main",
    activeEndpointId: "current",
    selectedHistoryId: null,
    snapshotReady: true,
    pairingPresence: { "device:main": { status: "offline" as const, onlineEndpoints: 0, totalEndpoints: 1 } },
    onPair: () => {},
    onSettings: () => {},
    onSelectDevice: () => {},
    onSelectEndpoint: () => {},
    onSelectHistory: () => {},
    onRename: () => {},
    onRemove: () => {},
  };
}

test("pairing display name prefers local nickname, then host, then stable key", () => {
  expect(displayDevice(device({ nickname: "Office Mac", hostname: "office" }))).toBe("Office Mac");
  expect(displayDevice(device({ hostname: "office" }))).toBe("office");
  expect(displayDevice(device())).toBe("Computer e5FRoCab");
});

test("computer row keeps current selection separate from actual presence", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <ComputerRow
        device={device({ nickname: "Office Mac" })}
        active
        presence={{ status: "offline", onlineEndpoints: 0, totalEndpoints: 1 }}
        onSelect={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />
    </PwaUiProvider>,
  );
  const computerSelect = navLinkMarkup(html, "Office Mac");
  const computerActions = html.match(/<button[^>]*aria-label="Computer actions for Office Mac"[^>]*>/)?.[0] ?? "";

  expect(html).toContain("OFFLINE");
  expect(html).toContain("Current");
  expect(html).not.toContain("OPEN");
  expect(computerSelect).toMatch(/^<button\b/);
  expect(computerSelect).toContain("pwa-peer-select");
  expect(computerSelect).toContain("pwa-computer-select");
  expect(computerSelect).toContain("data-active");
  expect(computerSelect).not.toContain("data-disabled");
  expect(computerSelect).not.toMatch(/<button\b[^>]*>[\s\S]*<button\b/);
  expect(computerSelect).not.toContain("Computer actions for Office Mac");
  expect(computerActions).toMatch(/pwa-icon-button/);
  expect(computerActions).toMatch(/aria-haspopup="menu"/);
});

test("keeps the brand and computer selection at the top and pairing plus settings in the footer", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><DesktopSidebar {...navigationProps()} /></PwaUiProvider>);
  const chooser = html.match(/<button[^>]*aria-label="Choose computer, current Office Mac"[^>]*>/)?.[0] ?? "";
  const pair = buttonMarkup(html, "Pair a computer");
  const settings = html.match(/<button[^>]*aria-label="Open settings"[^>]*>/)?.[0] ?? "";

  expect(html).toContain("pwa-navigation-content");
  expect(html).toMatch(/class="pwa-sidebar-brand"[\s\S]*Pi Reach/);
  expect(html).toContain("pwa-sidebar-head");
  expect(chooser).toMatch(/pwa-device-trigger/);
  expect(pair).toMatch(/pwa-nav-pair/);
  expect(settings).toMatch(/pwa-nav-settings/);
  expect(html).toContain("pwa-sidebar-foot");
  expect(html).not.toContain("pwa-manage-computers");
});

test("renders online Pi rows with directory and run state, and history rows with time only", () => {
  const props = navigationProps();
  const liveHtml = renderToStaticMarkup(<PwaUiProvider><DesktopSidebar {...props} completedEndpointIds={new Set(["next"])} /></PwaUiProvider>);
  const historyHtml = renderToStaticMarkup(<PwaUiProvider><DesktopSidebar {...props} activeEndpointId="current" selectedHistoryId="history-current" /></PwaUiProvider>);
  const waitingHtml = renderToStaticMarkup(<PwaUiProvider><DesktopSidebar {...props} snapshotReady={false} /></PwaUiProvider>);
  const currentLive = navLinkMarkup(liveHtml, "Current Pi");
  const nextLive = navLinkMarkup(liveHtml, "Next Pi");
  const currentHistory = navLinkMarkup(historyHtml, "**Pinned history**");
  const nextHistory = navLinkMarkup(historyHtml, "Earlier saved session");

  expect(liveHtml).toContain("Online Pi");
  expect(liveHtml).toContain("Local history");
  expect(liveHtml).toContain("Saved in this browser only");
  expect(liveHtml).not.toMatch(/role="tab"|>Live<|>History</);
  expect(currentLive).toMatch(/current<span aria-hidden="true"> · <\/span><\/span><span class="pwa-pi-status">Idle</);
  expect(nextLive).toContain("pwa-pi-status-running");
  expect(nextLive).toContain("Running");
  expect(currentLive).not.toContain("/workspace/current");
  // 当前项保持可聚焦：aria-current 标记，不禁用。
  expect(currentLive).toContain("data-active");
  expect(currentLive).toContain('aria-current="true"');
  expect(currentLive).not.toContain("data-disabled");
  expect(nextLive).toContain("pwa-notice-dot");
  expect(nextLive).toContain('aria-label="New reply"');
  expect(currentLive).not.toContain("pwa-notice-dot");
  expect(currentHistory).toContain("data-active");
  expect(currentHistory).toContain("<time");
  expect(currentHistory).not.toMatch(/items?</);
  expect(nextHistory).toContain("<time");
  expect(historyHtml).not.toContain("Current saved session");
  expect(waitingHtml).toContain("Checking for running Pi...");
  expect(waitingHtml).toContain("pwa-nav-skeleton");
  expect(waitingHtml).not.toContain(">Current Pi<");
  expect(waitingHtml).toContain("**Pinned history**");
});

test("shows only the computer entry in an unpaired sidebar and uses structured main empty states", () => {
  const sidebarHtml = renderToStaticMarkup(
    <PwaUiProvider>
      <DesktopSidebar devices={[]} endpoints={[]} history={[]} activeDeviceId={null} activeEndpointId={null} selectedHistoryId={null} snapshotReady onPair={() => {}} onSettings={() => {}} onSelectDevice={() => {}} onSelectEndpoint={() => {}} onSelectHistory={() => {}} onRename={() => {}} onRemove={() => {}} />
    </PwaUiProvider>,
  );
  const unpairedHtml = renderToStaticMarkup(<PwaUiProvider><UnpairedWorkspace onPair={() => {}} /></PwaUiProvider>);
  const noPiHtml = renderToStaticMarkup(<PwaUiProvider><NoPiWorkspace onViewHistory={() => {}} /></PwaUiProvider>);
  const noPiWithoutHistoryHtml = renderToStaticMarkup(<PwaUiProvider><NoPiWorkspace /></PwaUiProvider>);

  expect(sidebarHtml).toContain("No computer paired");
  expect(sidebarHtml).not.toContain("pwa-empty");
  expect(sidebarHtml).not.toContain("Online Pi");
  expect(sidebarHtml).toContain("Settings");
  expect(unpairedHtml).toContain("No computers paired yet");
  expect(unpairedHtml).toContain("<code>/pi-reach pair</code>");
  expect(unpairedHtml).toMatch(/aria-label="Copy command"/);
  expect(unpairedHtml).toMatch(/data-variant="filled"[^>]*>[\s\S]*Start pairing/);
  expect(noPiHtml).toContain("No Pi online");
  expect(noPiHtml).toContain("View local history");
  expect(noPiWithoutHistoryHtml).not.toContain("View local history");
  expect(noPiWithoutHistoryHtml).not.toContain("<button");
});
