import { describe, expect, test } from "vitest";
import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STORAGE_KEY, isPwaTextSize, resolveTextSize, shouldRestoreTextSize } from "./text-size";

describe("text size preference", () => {
  test("accepts only the three supported tiers", () => {
    expect(TEXT_SIZE_STORAGE_KEY).toBe("pi-reach-text-size");
    expect(resolveTextSize("standard")).toBe("standard");
    expect(resolveTextSize("large")).toBe("large");
    expect(resolveTextSize("xlarge")).toBe("xlarge");
  });

  test("falls back to standard for missing or invalid values", () => {
    expect(resolveTextSize(null)).toBe(DEFAULT_TEXT_SIZE);
    expect(resolveTextSize(undefined)).toBe(DEFAULT_TEXT_SIZE);
    expect(resolveTextSize("")).toBe(DEFAULT_TEXT_SIZE);
    expect(resolveTextSize("Small")).toBe(DEFAULT_TEXT_SIZE);
    expect(resolveTextSize("999")).toBe(DEFAULT_TEXT_SIZE);
  });

  test("narrows unknown values", () => {
    expect(isPwaTextSize("large")).toBe(true);
    expect(isPwaTextSize("small")).toBe(false);
    expect(isPwaTextSize(null)).toBe(false);
  });

  test("keeps review-only pages on their controlled text size", () => {
    expect(shouldRestoreTextSize("")).toBe(true);
    expect(shouldRestoreTextSize("/app")).toBe(true);
    expect(shouldRestoreTextSize("/app/settings")).toBe(true);
    expect(shouldRestoreTextSize("/app/ui-review")).toBe(false);
    expect(shouldRestoreTextSize("/app/ui-review-stage-a")).toBe(false);
    expect(shouldRestoreTextSize("/app/ui-states")).toBe(false);
  });
});
