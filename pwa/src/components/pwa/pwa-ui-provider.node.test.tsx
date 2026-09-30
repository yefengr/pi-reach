import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, Button, Drawer, Menu, Modal, Select, TextInput } from "@mantine/core";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderPilot(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <div className="pwa-ui-scope">
        <div className="pwa-root">
          <Button>Save</Button>
        <TextInput className="pwa-input" label="Pairing name" defaultValue="Office" />
        <Select className="pwa-select" id="endpoint-id" label="Endpoint" value="endpoint-main" disabled data={[{ value: "endpoint-main", label: "endpoint-main" }, { value: "endpoint-old", label: "Old endpoint" }]} onChange={() => {}} defaultDropdownOpened comboboxProps={{ withinPortal: false }} />
        <Badge>ONLINE</Badge>
        <Drawer opened title="Endpoints" withinPortal={false} onClose={() => {}}>
          Session content
        </Drawer>
        <Modal opened title="Rename pairing" withinPortal={false} onClose={() => {}}>
          Rename content
        </Modal>
        <Menu opened withinPortal={false}>
          <Menu.Target><Button>More</Button></Menu.Target>
          <Menu.Dropdown><Menu.Item>Settings</Menu.Item></Menu.Dropdown>
        </Menu>
        </div>
      </div>
    </PwaUiProvider>,
  );
}

test("Mantine PWA pilot renders core controls with the Pi Reach provider", () => {
  const html = renderPilot();

  expect(html).toMatch(/Save/);
  expect(html).toMatch(/Pairing name/);
  expect(html).toMatch(/Endpoints/);
  expect(html).toMatch(/Rename pairing/);
  expect(html).toMatch(/Settings/);
  expect(html).toMatch(/pwa-button/);
  expect(html).toMatch(/pwa-input/);
  expect(html).toMatch(/pwa-select/);
  expect(html).toMatch(/id="endpoint-id"/);
  expect(html).toMatch(/value="endpoint-main"/);
  expect(html).toMatch(/disabled=""/);
  expect(html).toMatch(/Old endpoint/);
  expect(html).toMatch(/mantine-Badge-root/);
  expect(html).toMatch(/data-variant="filled"/);
  expect(html).toMatch(/:root\[data-mantine-color-scheme="dark"\]/);
  expect(html).toMatch(/--mantine-color-piReach-filled/);
});
