import { expect, test } from "vitest";
import { isPairingCameraDevice, type PairingDeviceNavigator } from "./pairing-device";

const cases: Array<[string, PairingDeviceNavigator | undefined, boolean]> = [
  ["Windows desktop", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36", maxTouchPoints: 0 }, false],
  ["touch-enabled Windows desktop", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36", maxTouchPoints: 10 }, false],
  ["Mac desktop", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.3 Safari/605.1.15", maxTouchPoints: 0 }, false],
  ["touch-enabled Linux desktop", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36", maxTouchPoints: 10 }, false],
  ["iPhone", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Version/18.3 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 }, true],
  ["Android phone", { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/134.0.0.0 Mobile Safari/537.36", maxTouchPoints: 5 }, true],
  ["iPad", { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Version/18.3 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 }, true],
  ["iPadOS desktop user agent", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.3 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 }, true],
  ["unknown server environment", undefined, false],
];

test.each(cases)("uses pairing camera on %s: %s", (_name, device, expected) => {
  expect(isPairingCameraDevice(device)).toBe(expected);
});
