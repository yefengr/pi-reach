import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "./settings-page";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderSettings(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <SettingsPage
        relayUrl="https://relay.example.test"
        defaultRelayUrl="https://relay.default.test"
        relayVersion={null}
        relayStatus="offline"
        extensionVersion={null}
        extensionStatus="offline"
        extensionTarget={null}
        onSave={async () => {}}
        onBack={() => {}}
        backLabel="Back to workspace"
        onClearData={() => {}}
        onResetLayout={() => {}}
      />
    </PwaUiProvider>,
  );
}

test("renders settings as a page with a focusable title, grouped sections and data actions", () => {
  const html = renderSettings();

  expect(html).not.toMatch(/mantine-Drawer/);
  expect(html).toMatch(/<h1 id="pwa-settings-title" class="pwa-settings-title" tabindex="-1">Settings<\/h1>/);
  expect(html).toMatch(/aria-label="Back to workspace"/);
  expect(html.match(/<h2 /g)).toHaveLength(5);
  expect(html).toMatch(/About/);
  expect(html).toMatch(/data-version="pwa"/);
  expect(html).toMatch(/Not connected/);
  expect(html).toMatch(/No online Pi selected/);
  expect(html).toMatch(/Copy version information/);
  expect(html).toMatch(/Relay URL/);
  expect(html).toMatch(/value="https:\/\/relay\.example\.test"/);
  expect(html).toMatch(/Save settings/);
  expect(html).toMatch(/Clear local data/);
  expect(html).toMatch(/Reset layout/);
  expect(html).not.toMatch(/Close settings/);
});
