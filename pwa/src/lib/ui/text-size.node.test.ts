import { describe, expect, test } from "vitest";
import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STORAGE_KEY, isPwaTextSize, resolveTextSize, resolveTextSizePreference, shouldRestoreTextSize, textSizeForSystemBody } from "./text-size";

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

  test("follows the system unless a tier was chosen", () => {
    expect(resolveTextSizePreference(null)).toBe("system");
    expect(resolveTextSizePreference("small")).toBe("system");
    expect(resolveTextSizePreference("system")).toBe("system");
    expect(resolveTextSizePreference("standard")).toBe("standard");
    expect(resolveTextSizePreference("xlarge")).toBe("xlarge");
  });

  test("maps the system body size to a tier without shrinking", () => {
    // iOS 文字大小各级的正文字号：14、15、16、17（默认）、19、21、23，辅助功能档更大。
    expect([14, 15, 16, 17].map(textSizeForSystemBody)).toEqual(["standard", "standard", "standard", "standard"]);
    expect(textSizeForSystemBody(19)).toBe("large");
    expect([21, 23, 53].map(textSizeForSystemBody)).toEqual(["xlarge", "xlarge", "xlarge"]);
    expect(textSizeForSystemBody(null)).toBe("standard");
    expect(textSizeForSystemBody(Number.NaN)).toBe("standard");
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
