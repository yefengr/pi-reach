import type { ComponentProps } from "react";
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSheet } from "./session-sheet";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";

const device: PwaDeviceRecord = {
  id: "device:main",
  deviceId: "e5FRoCabBqVX",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};
const endpoints: PwaEndpointRecord[] = [
  { id: "endpoint-main", deviceId: device.deviceId, endpointId: "main", runtimeInstanceId: "runtime-main", kind: "interactive", name: "Office Pi", cwd: "/work/pi-reach", online: true, updatedAt: 1 },
];
const history: TimelineSessionSummary = {
  id: "saved-history",
  deviceId: device.deviceId,
  endpointId: "past-process",
  sessionId: "past-session",
  leafId: "past-generation",
  startedAt: 1,
  updatedAt: 2,
  eventCount: 4,
  preview: "Saved design review",
};

function renderSheet(overrides: Partial<ComponentProps<typeof SessionSheet>> = {}) {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <SessionSheet
        devices={[device]}
        endpoints={endpoints}
        history={[history]}
        activeDeviceId={device.id}
        activeEndpointId="main"
        selectedHistoryId={null}
        snapshotReady
        pairingPresence={{ [device.id]: { status: "online", onlineEndpoints: 1, totalEndpoints: 1 } }}
        onSelectDevice={() => {}}
        onSelectEndpoint={() => {}}
        onSelectHistory={() => {}}
        onPair={() => {}}
        onSettings={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        withinPortal={false}
        {...overrides}
      />
    </PwaUiProvider>,
  );
}

test("renders a full-height left navigation Drawer with one scrolling navigation body", () => {
  const html = renderSheet();

  expect(html).toContain("mantine-Drawer-root");
  expect(html).toContain('role="dialog"');
  expect(html).toContain("width:min(320px, 85vw);height:100dvh;max-width:85vw;max-height:100dvh;display:flex;flex-direction:column");
  const titleId = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  expect(titleId).toBeTruthy();
  expect(html).toContain(`id="${titleId}"`);
  expect(html).toContain("Pi Reach");
  expect(html).toContain(" · Workspace");
  expect(html).toContain("pwa-session-sheet-head");
  expect(html).toContain("pwa-session-sheet-body");
  expect(html).toContain("pwa-navigation-content");
  expect(html.match(/pwa-navigation-scroll/g)).toHaveLength(1);
  expect(html).toContain("pwa-session-sheet-foot");
  expect(html).not.toContain("pwa-session-sheet-grabber");
  expect(html).not.toMatch(/role="tab"|role="tablist"|>Live<|>History</);
});

test("shows current computer, online Pi, and local history in the same navigation view", () => {
  const html = renderSheet();

  expect(html).toContain('aria-label="Choose computer, current office"');
  // 只配对一台电脑时，选择入口收成一行，不显示「当前电脑」副标题。
  expect(html).toContain("pwa-device-trigger-compact");
  expect(html).not.toContain("Current computer");
  expect(html).toContain("Online Pi");
  expect(html).toContain("Office Pi");
  expect(html).toContain("Local history");
  expect(html).toContain("Saved in this browser only");
  expect(html).toContain("Saved design review");
  expect(html).toContain('aria-current="true"');
  expect(html).not.toContain("OPEN");
  expect(html).toContain("Pair a computer");
  expect(html).toContain("Open settings");
  expect(html).not.toContain("Back to live");
  expect(html).not.toMatch(/endpoint ID|runtime|generation|interactive|daemon/i);
});

test("keeps both sections while reading history and exits through the online Pi rows", () => {
  const html = renderSheet({ activeEndpointId: null, selectedHistoryId: history.id });

  expect(html).toContain("Online Pi");
  expect(html).toContain("Local history");
  expect(html).not.toContain("Back to live");
  // 当前项保持可聚焦，以 aria-current 标记。
  expect(html).toContain("data-active");
  expect(html).not.toContain("data-disabled");
});

test("does not keep the closed Drawer in the DOM by default", () => {
  const html = renderSheet({ opened: false });

  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain("pwa-session-sheet");
});
