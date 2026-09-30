import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { WorkspaceTitleBar } from "./workspace-title-bar";
import { PwaUiProvider } from "./pwa-ui-provider";
import { WorkspaceHistorySection } from "./workspace-view";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import { historySessionTitle } from "@/lib/pwa/history-preview";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";

const activeDevice: PwaDeviceRecord = {
  id: "device:main",
  deviceId: "device-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
};

function history(overrides: Partial<TimelineSessionSummary> = {}): TimelineSessionSummary {
  return {
    id: "history",
    deviceId: activeDevice.deviceId,
    endpointId: "endpoint",
    sessionId: "session",
    leafId: "generation",
    startedAt: 1,
    updatedAt: 2,
    eventCount: 1,
    preview: "**Saved** [conversation](https://example.test)",
    ...overrides,
  };
}

test("prefers a non-empty local title and preserves its Markdown", () => {
  expect(historySessionTitle({ name: "  **Named history**  ", preview: "fallback" })).toBe("**Named history**");
  expect(historySessionTitle({ name: "   ", preview: "**Saved** [conversation](https://example.test)" })).toBe("Saved conversation");
});

test("uses the same title policy in saved-history navigation and detail views", async () => {
  const named = history({ id: "named", name: "  **Named history**  " });
  const legacy = history({ id: "legacy" });
  const screen = await render(
    <PwaUiProvider>
      <WorkspaceHistorySection activeDevice={activeDevice} history={[named, legacy]} selectedHistoryId={null} onSelectHistory={() => {}} headingId="history-heading" />
      <WorkspaceTitleBar title={historySessionTitle(named)} showTitle kicker="Local history · Read only" navigationExpanded={false} onOpenNavigation={() => {}} />
      <WorkspaceTitleBar title={historySessionTitle(legacy)} showTitle kicker="Local history · Read only" navigationExpanded={false} onOpenNavigation={() => {}} />
    </PwaUiProvider>,
  );

  await expect.element(screen.getByRole("button", { name: /\*\*Named history\*\*/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Saved conversation/ })).toBeVisible();
  await expect.element(screen.getByRole("heading", { level: 1, name: "**Named history**" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { level: 1, name: "Saved conversation" })).toBeVisible();
});
