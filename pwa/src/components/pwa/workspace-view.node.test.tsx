import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerRow, displayDevice } from "./workspace-device-control";
import { DesktopSidebar, OnlinePiRow } from "./workspace-view";
import { ChoosePiWorkspace, ConnectionIssueWorkspace, NoPiWorkspace, UnpairedWorkspace } from "./workspace-content";
import { ComposerHint } from "./composer-hint";
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
  const computerActions = html.match(/<button[^>]*aria-label="Computer actions for Office Mac"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

  expect(html).toContain("Offline");
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
  // 操作菜单用 Ellipsis，与只读信息入口的 Info 区分。
  expect(computerActions).toContain("lucide-ellipsis");
});

test("computer row marks unread completion on the current computer and keeps an empty status slot", () => {
  const renderRow = (activity?: "completed" | "running") => renderToStaticMarkup(
    <PwaUiProvider>
      <ComputerRow
        device={device({ nickname: "Office Mac" })}
        active
        presence={{ status: "online", onlineEndpoints: 2, totalEndpoints: 2 }}
        activity={activity}
        onSelect={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />
    </PwaUiProvider>,
  );
  const completedRow = navLinkMarkup(renderRow("completed"), "Office Mac");
  expect(completedRow).toContain('class="pwa-peer-status-slot"');
  expect(completedRow).toContain("pwa-notice-dot");
  expect(completedRow).toContain('aria-label="Run finished, not yet viewed"');
  expect(completedRow).not.toContain("pwa-running-indicator");
  // 当前电脑也显示其他会话的完成点；运行状态与完成点互斥。
  const runningRow = navLinkMarkup(renderRow("running"), "Office Mac");
  expect(runningRow).toContain("pwa-running-indicator");
  expect(runningRow).not.toContain("pwa-notice-dot");
  const idle = renderRow();
  const idleRow = navLinkMarkup(idle, "Office Mac");
  expect(idleRow).toContain('class="pwa-peer-status-slot"></span>');
  expect(idleRow).not.toContain("pwa-notice-dot");
  expect(idleRow).not.toContain("pwa-running-indicator");
  // 状态槽不挤掉行外的更多菜单。
  expect(idle).toMatch(/aria-label="Computer actions for Office Mac"/);
});

test("keeps brand above scrolling navigation and computer selection plus settings in the footer", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><DesktopSidebar {...navigationProps()} /></PwaUiProvider>);
  const chooser = html.match(/<button[^>]*aria-label="Choose computer, current Office Mac"[^>]*>/)?.[0] ?? "";
  const pair = buttonMarkup(html, "Pair a computer");
  const settings = html.match(/<button[^>]*aria-label="Open settings"[^>]*>/)?.[0] ?? "";

  expect(html).toContain("pwa-navigation-content");
  expect(html).toMatch(/class="pwa-sidebar-brand"[\s\S]*Pi Reach/);
  expect(html).not.toContain("pwa-sidebar-head");
  expect(chooser).toMatch(/pwa-device-trigger/);
  expect(pair).toBe("");
  expect(html.indexOf("pwa-sidebar-foot")).toBeLessThan(html.indexOf("Choose computer, current Office Mac"));
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
  expect(liveHtml).toMatch(/lucide-bot"[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><span>Online Pi<\/span>/);
  expect(liveHtml).toContain("Local history");
  expect(liveHtml).not.toContain("This browser only");
  expect(liveHtml).not.toMatch(/role="tab"|>Live<|>History</);
  expect(currentLive).toContain('class="pwa-pi-directory">current</span>');
  expect(currentLive).toContain('class="pwa-pi-status-slot"></span>');
  expect(currentLive).not.toContain(">Idle<");
  expect(nextLive).toContain("pwa-running-indicator");
  expect(nextLive).toContain('aria-label="Running"');
  expect(nextLive).toContain('title="Running"');
  expect(nextLive).not.toContain(">Running<");
  expect(nextLive).toContain('class="pwa-pi-row-end"');
  expect(nextLive.indexOf('class="pwa-pi-status-slot"')).toBeGreaterThan(nextLive.indexOf('class="pwa-pi-directory"'));
  expect(currentLive).not.toContain("/workspace/current");
  // 当前项保持可聚焦：aria-current 标记，不禁用。
  expect(currentLive).toContain("data-active");
  expect(currentLive).toContain('aria-current="true"');
  expect(currentLive).not.toContain("data-disabled");
  expect(nextLive).not.toContain("pwa-notice-dot");
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

test("12px connection spinners override the global stroke to match 16px icons", () => {
  const spinner = (html: string) => html.match(/<svg\b[^>]*\bpwa-spin\b[^>]*>/)?.[0] ?? "";
  // 连接问题的进行中状态在输入框提示行与主区空态里以 12px 动态图标表达（ADR-20261105）。
  const statuses = [
    renderToStaticMarkup(<PwaUiProvider><ComposerHint hint={{ text: "Reconnecting…", tone: "neutral", busy: true }} /></PwaUiProvider>),
    renderToStaticMarkup(<PwaUiProvider><ConnectionIssueWorkspace kind="relay" stage="retry" busy onRetry={() => {}} retryDisabled={false} /></PwaUiProvider>),
  ];

  for (const html of statuses) {
    expect(spinner(html)).toContain('width="12"');
    expect(spinner(html)).toContain('stroke-width="3"');
  }
});

function renderOnlineRow(overrides: Partial<PwaEndpointRecord> = {}, current = false, completed = false): string {
  const endpoint: PwaEndpointRecord = { id: "endpoint-alpha", deviceId: "e5FRoCabBqVX", endpointId: "alpha", runtimeInstanceId: "runtime-alpha", kind: "interactive", name: "Alpha Pi", cwd: "/workspace/alpha", online: true, updatedAt: 1, ...overrides };
  return renderToStaticMarkup(<PwaUiProvider><OnlinePiRow endpoint={endpoint} current={current} completed={completed} onSelect={() => {}} /></PwaUiProvider>);
}

test("online Pi row shows one status mark with running priority and restores the completed hint", () => {
  // 运行（包括当前项）优先，只遮住旧提醒，不清除 completed 数据。
  expect(renderOnlineRow({ working: true }, false, true)).toContain("pwa-running-indicator");
  expect(renderOnlineRow({ working: true }, false, true)).not.toContain("pwa-notice-dot");
  expect(renderOnlineRow({ working: true }, true, true)).toContain('aria-label="Running"');
  // 运行结束后完成提醒重新显示，并提供静态可访问说明。
  const finished = renderOnlineRow({ working: false }, false, true);
  expect(finished).toContain("pwa-notice-dot");
  expect(finished).toContain('aria-label="Run finished, not yet viewed"');
  expect(finished).toContain('title="Run finished, not yet viewed"');
  expect(finished).not.toContain("pwa-running-indicator");
  // 当前查看的会话不显示后台完成提醒。
  expect(renderOnlineRow({}, true, true)).not.toContain("pwa-notice-dot");
  // 空闲行没有状态标记，但状态槽始终保留固定宽度。
  const idle = renderOnlineRow();
  expect(idle).not.toContain("pwa-running-indicator");
  expect(idle).not.toContain("pwa-notice-dot");
  expect(idle).toContain('class="pwa-pi-status-slot"></span>');
  expect(idle).not.toContain(">Idle<");
  expect(idle).not.toContain(">Running<");
});

test("online Pi row omits the directory line when cwd is missing", () => {
  const html = renderOnlineRow({ cwd: undefined });
  expect(html).toContain("Alpha Pi");
  expect(html).not.toContain("pwa-pi-directory");
});

test("choose Pi list keeps the action chevron beside the new status slot", () => {
  const endpoints: PwaEndpointRecord[] = [
    { id: "endpoint-working", deviceId: "e5FRoCabBqVX", endpointId: "working", runtimeInstanceId: "runtime-working", kind: "interactive", name: "Working Pi", cwd: "/workspace/working", working: true, online: true, updatedAt: 2 },
    { id: "endpoint-finished", deviceId: "e5FRoCabBqVX", endpointId: "finished", runtimeInstanceId: "runtime-finished", kind: "interactive", name: "Finished Pi", cwd: "/workspace/finished", online: true, updatedAt: 1 },
  ];
  const html = renderToStaticMarkup(<PwaUiProvider><ChoosePiWorkspace endpoints={endpoints} completedEndpointIds={new Set(["finished"])} onSelect={() => {}} /></PwaUiProvider>);
  const working = navLinkMarkup(html, "Working Pi");
  const finished = navLinkMarkup(html, "Finished Pi");
  // 运行状态点与行动箭头并存，箭头不因新状态点被隐藏。
  for (const row of [working, finished]) {
    expect(row).toContain("pwa-pi-status-slot");
    expect(row).toContain("pwa-nav-link-section");
    expect(row.match(/lucide-chevron-right/g)).toHaveLength(1);
  }
  expect(working).toContain("pwa-running-indicator");
  expect(working).not.toContain("pwa-notice-dot");
  expect(finished).toContain("pwa-notice-dot");
});

test("shows direct pairing in an unpaired sidebar and uses structured main empty states", () => {
  const sidebarHtml = renderToStaticMarkup(
    <PwaUiProvider>
      <DesktopSidebar devices={[]} endpoints={[]} history={[]} activeDeviceId={null} activeEndpointId={null} selectedHistoryId={null} snapshotReady onPair={() => {}} onSettings={() => {}} onSelectDevice={() => {}} onSelectEndpoint={() => {}} onSelectHistory={() => {}} onRename={() => {}} onRemove={() => {}} />
    </PwaUiProvider>,
  );
  const unpairedHtml = renderToStaticMarkup(<PwaUiProvider><UnpairedWorkspace onPair={() => {}} /></PwaUiProvider>);
  const noPiHtml = renderToStaticMarkup(<PwaUiProvider><NoPiWorkspace onViewHistory={() => {}} /></PwaUiProvider>);
  const noPiWithoutHistoryHtml = renderToStaticMarkup(<PwaUiProvider><NoPiWorkspace /></PwaUiProvider>);

  expect(sidebarHtml).not.toContain("No computer paired");
  expect(buttonMarkup(sidebarHtml, "Pair a computer")).toMatch(/pwa-nav-pair/);
  expect(sidebarHtml).not.toContain("pwa-empty");
  expect(sidebarHtml).not.toContain("Online Pi");
  expect(sidebarHtml).toContain('aria-label="Open settings"');
  expect(unpairedHtml).toContain("No computers paired yet");
  expect(unpairedHtml).toContain("<code>/pi-reach pair</code>");
  expect(unpairedHtml).toMatch(/aria-label="Copy command"/);
  expect(unpairedHtml).toMatch(/data-variant="filled"[^>]*>[\s\S]*Start pairing/);
  expect(noPiHtml).toContain("No Pi online");
  expect(noPiHtml).toContain("View local history");
  expect(noPiWithoutHistoryHtml).not.toContain("View local history");
  expect(noPiWithoutHistoryHtml).not.toContain("<button");
});
