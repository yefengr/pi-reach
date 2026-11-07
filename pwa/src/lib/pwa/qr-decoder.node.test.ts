import { expect, test } from "vitest";
import { pairingQrFixtures } from "@/test/fixtures/pairing-qr";
import { pairingQrImage } from "@/test/qr-image";
import { decodeQrImage } from "./qr-decoder";

test.each(pairingQrFixtures)("decodes fixed terminal QR $code at multiple scales and backgrounds", ({ code, modules }) => {
  for (const scale of [4, 6, 8, 12]) {
    for (const background of [24, 255]) {
      expect(decodeQrImage(pairingQrImage(modules, { scale, background })), `scale=${scale}, background=${background}`).toBe(code);
    }
  }
});

test.each([0, 90, 180, 270, 7, -7])("decodes the former locator regression rotated by %i degrees", (rotation) => {
  const fixture = pairingQrFixtures[0];
  expect(decodeQrImage(pairingQrImage(fixture.modules, { rotation, shear: 0.08, background: 24 }))).toBe(fixture.code);
});

test("blank frames have no result", () => {
  for (const value of [0, 255]) {
    const data = new Uint8ClampedArray(160 * 120 * 4).fill(value);
    expect(decodeQrImage({ data, width: 160, height: 120 })).toBeNull();
  }
});
