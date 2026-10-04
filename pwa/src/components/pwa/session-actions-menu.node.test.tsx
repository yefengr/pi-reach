import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionActionsMenu, type SessionActionsMenuProps } from "./session-actions-menu";
import { PwaUiProvider } from "./pwa-ui-provider";

const menuProps: SessionActionsMenuProps = {
  info: { name: "Release check", cwd: "/workspace/pi-reach", computer: "Studio Mac", status: "Idle" },
};

function renderMenu(overrides: Partial<SessionActionsMenuProps> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><div className="pwa-root"><SessionActionsMenu {...menuProps} {...overrides} /></div></PwaUiProvider>);
}

test("renders one borderless icon trigger with a stable accessible name", () => {
  const html = renderMenu();

  expect(html).toMatch(/aria-label="Session details"/);
  expect(html).toMatch(/aria-haspopup="dialog"/);
  expect(html).toMatch(/pwa-icon-button/);
  expect(html).not.toMatch(/>Actions</);
  expect(html).not.toMatch(/Refresh app/);
  expect(html).not.toMatch(/Retry connection/);
});

test("keeps only the read-only information contract without commands or separators", () => {
  const html = renderMenu();

  expect(html).not.toMatch(/role="menu"/);
  expect(html).not.toMatch(/role="menuitem"/);
  expect(html).not.toMatch(/role="separator"/);
  expect(html).not.toMatch(/New session/);
  expect(html).not.toMatch(/Compact context/);
});
