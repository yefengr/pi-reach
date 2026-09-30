import { expect, test } from "vitest";
import { createPairRequest, normalizePairCode, normalizePairDeviceId } from "./pairing";

const deviceId = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

test("normalizes Crockford Base32 pairing codes", () => {
  expect(normalizePairCode("  k7mp-4q2d ")).toBe("K7MP4Q2D");
  expect(normalizePairCode("K7MP4Q2D")).toBe("K7MP4Q2D");
});

test("strictly rejects invalid pairing codes", () => {
  for (const value of ["K7MP4Q2", "K7MP4Q2D0", "K7MP-4Q2I", "K7MP-4Q2L", "K7MP-4Q2O", "K7MP-4Q2U", "K7MP-4Q2!"]) {
    expect(normalizePairCode(value)).toBeUndefined();
  }
});

test("creates a Protocol v2 pair request with the short code", () => {
  expect(createPairRequest("K7MP4Q2D", "Browser", "request")).toEqual({ protocol_version: 2, type: "pair_request", code: "K7MP4Q2D", device_name: "Browser", id: "request" });
  expect(normalizePairDeviceId(deviceId)).toBe(deviceId);
});
