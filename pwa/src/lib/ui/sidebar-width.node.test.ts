import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { clampSidebarWidth, parseSidebarWidth, sidebarWidthCap, sidebarWidthPreference } from "./sidebar-width";

test("installed desktop mode stays standalone without requesting window controls overlay", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../public/manifest.webmanifest", import.meta.url), "utf8"));
  expect(manifest.display).toBe("standalone");
  expect(manifest.display_override).toBeUndefined();
});

describe("sidebar width preference", () => {
  test.each([null, undefined, "300", NaN, Infinity, -Infinity, 239, 361, {}, true])("rejects invalid value %s", (value) => {
    expect(sidebarWidthPreference(value)).toBe(280);
  });
  test.each([240, 280, 317.5, 360])("accepts finite in-range preference %s", (value) => {
    expect(parseSidebarWidth(JSON.stringify(value))).toBe(value);
  });
  test.each([null, "null", '"320"', "NaN", "Infinity", "{", "361", "false"]) ("rejects corrupt storage %s", (value) => {
    expect(parseSidebarWidth(value)).toBe(280);
  });
  test("caps only effective width, restoring preference when viewport grows", () => {
    const preference = 360;
    expect(sidebarWidthCap(768)).toBe(276);
    expect(sidebarWidthCap(768, 20, 24)).toBe(240);
    expect(clampSidebarWidth(preference, sidebarWidthCap(768))).toBe(276);
    expect(clampSidebarWidth(preference, sidebarWidthCap(1280))).toBe(360);
    expect(preference).toBe(360);
  });
  test("reserves named main budget and clamps both drag extremes", () => {
    expect(sidebarWidthCap(820, 12, 16)).toBe(300);
    expect(clampSidebarWidth(1000, 300)).toBe(300);
    expect(clampSidebarWidth(-100, 300)).toBe(240);
    expect(sidebarWidthCap(600)).toBe(240);
  });
});
