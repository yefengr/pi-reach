import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WireModel } from "@/lib/pi-reach/types";
import { SessionActionsMenu, type SessionActionsMenuProps } from "./session-actions-menu";
import { PwaUiProvider } from "./pwa-ui-provider";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200000,
  vision: true,
};

const menuProps: SessionActionsMenuProps = {
  info: { name: "Release check", cwd: "/workspace/pi-reach", computer: "Studio Mac", status: "Idle" },
  isOnline: true,
  isWorking: false,
  pendingAction: null,
  models: [model],
  currentModel: model,
  currentModelFallback: null,
  thinking: "medium",
  onNewSession: () => {},
  onCompactSession: () => {},
  onSetModel: () => {},
  onSetThinking: () => {},
  onCommandsOpen: () => {},
};

function renderMenu(overrides: Partial<SessionActionsMenuProps> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><div className="pwa-root"><SessionActionsMenu {...menuProps} {...overrides} /></div></PwaUiProvider>);
}

test("renders one borderless icon trigger with a stable accessible name", () => {
  const html = renderMenu();

  expect(html).toMatch(/aria-label="Session actions"/);
  expect(html).toMatch(/aria-haspopup="menu"/);
  expect(html).toMatch(/pwa-icon-button/);
  expect(html).not.toMatch(/>Actions</);
  expect(html).not.toMatch(/Refresh app/);
  expect(html).not.toMatch(/Retry connection/);
});
