import { readFileSync } from "node:fs";
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

// 触控基准用静态读取校验：浏览器测试中的触控模拟在 Linux 无头 Chromium 关闭后无法复位，会影响后续用例。
describe("type scale tokens", () => {
  const theme = readFileSync(new URL("../../app/pwa-theme.css", import.meta.url), "utf8");
  const TOKENS = ["meta", "list", "body", "code", "title", "page", "heading", "subheading"];
  const block = (source: string, selector: string) => {
    const open = source.indexOf("{", source.indexOf(`${selector} {`));
    return Object.fromEntries([...source.slice(open + 1, source.indexOf("}", open)).matchAll(/--pwa-text-([a-z]+):\s*(\d+)px;/g)].map(match => [match[1], Number(match[2])]));
  };
  const scale = (source: string, base: Record<string, number> = {}) => {
    const standard = { ...base, ...block(source, "\n:root") };
    return [standard, { ...standard, ...block(source, ':root[data-pwa-text-size="large"]') }, { ...standard, ...block(source, ':root[data-pwa-text-size="xlarge"]') }]
      .map(tier => TOKENS.map(name => tier[name]).join(" "));
  };
  const touchStart = theme.indexOf("@media (pointer: coarse) {");
  const desktop = theme.slice(0, touchStart);
  const touch = theme.slice(touchStart).replace(/^ {2}/gm, "");

  test("desktop keeps the 16px base at every tier", () => {
    expect(scale(desktop)).toEqual(["13 14 16 14 18 24 20 18", "14 16 18 16 20 28 22 20", "15 18 20 18 22 32 24 22"]);
  });

  test("touch-first devices read from a 17px base, layered over the desktop tiers", () => {
    expect(touchStart).toBeGreaterThan(0);
    const desktopTiers = [block(desktop, "\n:root"), block(desktop, ':root[data-pwa-text-size="large"]'), block(desktop, ':root[data-pwa-text-size="xlarge"]')];
    const touchTiers = [block(touch, "\n:root"), block(touch, ':root[data-pwa-text-size="large"]'), block(touch, ':root[data-pwa-text-size="xlarge"]')];
    // 层叠顺序：桌面标准 → 触控标准 → 桌面档位 → 触控档位（档位选择器的优先级高于 :root）。
    const resolved = [0, 1, 2].map(tier => ({ ...desktopTiers[0], ...touchTiers[0], ...(tier ? desktopTiers[tier] : {}), ...(tier ? touchTiers[tier] : {}) }));
    expect(resolved.map(tier => TOKENS.map(name => tier[name]).join(" "))).toEqual(["14 16 17 14 18 28 22 20", "15 18 19 16 20 30 24 22", "16 20 21 18 22 32 26 24"]);
  });
});
