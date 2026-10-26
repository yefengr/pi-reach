import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PairingDialog } from "./pairing-dialog";

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
  expect(html).toMatch(/placeholder="K7MP4Q2D"/);
  expect(html).toMatch(/\/pi-reach pair/);
  expect(html).not.toMatch(/<video/);
  expect(html).not.toMatch(/type="file"/);
  // 没有摄像头时只剩输入码，不渲染空的方式切换区。
  expect(html).not.toMatch(/pwa-pairing-methods/);
});
