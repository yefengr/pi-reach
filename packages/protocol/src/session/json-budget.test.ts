import { describe, expect, it } from "vitest";
import { boundedJsonByteLength } from "./json-budget.js";

describe("bounded JSON byte accounting", () => {
  it.each([
    null, true, false, 0, -0, 1e30,
    "中文与 emoji 😀", "\"\\\b\t\n\f\r\u0000\u001f", "\ud800单独\udfff",
    [], {}, ["中文", 12, null], { "带引号\"的键": [false, { value: "😀" }] },
  ])("matches encoded JSON without allocating it for the count: %j", (value) => {
    const expected = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(boundedJsonByteLength(value, expected)).toBe(expected);
    expect(boundedJsonByteLength(value, expected - 1)).toBeNull();
  });

  it("stops at the budget before visiting the remaining properties", () => {
    const value = { text: "x".repeat(100), get later() { throw new Error("must not visit"); } };
    expect(boundedJsonByteLength(value, 20)).toBeNull();
  });

  it("counts repeated references separately and rejects non-JSON values", () => {
    const shared = { value: "x" };
    const value = [shared, shared];
    expect(boundedJsonByteLength(value, 100)).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
    expect(boundedJsonByteLength({ value: undefined }, 100)).toBeNull();
    expect(boundedJsonByteLength(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });
});
