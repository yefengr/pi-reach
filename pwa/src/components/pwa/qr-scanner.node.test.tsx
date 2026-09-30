import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PairingDialog } from "./pairing-dialog";
import { QrImageButton } from "./qr-scanner";

test("renders the QR image upload as a text button with a hidden image-only file input", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><QrImageButton onScan={() => {}} onNotFound={() => {}} /></PwaUiProvider>);
  expect(html).toMatch(/Upload QR image/);
  expect(html).toMatch(/data-variant="transparent"/);
  expect(html).toMatch(/type="file"/);
  expect(html).toMatch(/hidden=""/);
  expect(html).toMatch(/accept="image\/\*"/);
  expect(html).not.toMatch(/capture=/);
  expect(html).not.toMatch(/<video/);
});

test("renders the pairing dialog with the code form by default on desktop", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <PairingDialog opened connecting={false} error={null} onSubmit={() => {}} onClearError={() => {}} onClose={() => {}} withinPortal={false} />
    </PwaUiProvider>,
  );
  expect(html.match(/role="dialog"/g)).toHaveLength(1);
  expect(html).toMatch(/>Pair a computer</);
  expect(html).toMatch(/Pairing code/);
  expect(html).toMatch(/autoCapitalize="characters"/);
  expect(html).toMatch(/placeholder="K7MP-4Q2D"/);
  expect(html).toMatch(/\/pi-reach pair/);
  expect(html).not.toMatch(/<video/);
});
