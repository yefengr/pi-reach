import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./pwa-theme.css", import.meta.url), "utf8");

function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const tokens: Record<string, string> = {};
  for (const match of css.slice(open + 1, close).matchAll(/(--pwa-[a-z-]+):\s*([^;]+);/g)) tokens[match[1]!] = match[2]!.trim();
  return tokens;
}

const shared = declarations("\n:root {");
const light = { ...shared, ...declarations(':root[data-mantine-color-scheme="light"] {') };
const dark = { ...shared, ...declarations(':root[data-mantine-color-scheme="dark"] {') };
const systemDark = declarations(":root:not([data-mantine-color-scheme]) {");
type Theme = Record<string, string>;

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`expected opaque hex color, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(theme: Theme, foreground: string, background: string): number {
  const read = (name: string): string => {
    const value = theme[`--pwa-${name}`] ?? (() => { throw new Error(`missing --pwa-${name}`); })();
    const reference = /^var\(--pwa-([a-z-]+)\)$/.exec(value);
    return reference ? read(reference[1]!) : value;
  };
  const [high, low] = [luminance(read(foreground)), luminance(read(background))].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

const neutralSurfaces = ["bg", "surface", "panel", "message", "hover", "selected", "neutral-active", "disabled-bg"];
// 中性角色不带色相，颜色只出现在主色、状态色与语法色上。
const neutralRoles = [...neutralSurfaces, "ink", "secondary", "soft-ink", "line", "control-line", "code-bg", "code-muted", "code-ink"];

describe.each([["light", light], ["dark", dark]] as const)("%s theme tokens", (_name, theme) => {
  test("keeps every neutral role achromatic", () => {
    for (const role of neutralRoles) {
      const value = theme[`--pwa-${role}`] ?? "";
      expect(value, role).toMatch(/^#([0-9a-f]{2})\1\1$/i);
    }
  });

  test("keeps every text level readable on every neutral surface", () => {
    for (const surface of neutralSurfaces) {
      expect(ratio(theme, "ink", surface), `ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme, "secondary", surface), `secondary on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ["bg", "surface", "panel", "message"]) {
      expect(ratio(theme, "soft-ink", surface), `soft-ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("keeps neutral interaction layers distinguishable", () => {
    for (const surface of ["bg", "panel", "surface"]) {
      expect(ratio(theme, "hover", surface), `hover on ${surface}`).toBeGreaterThanOrEqual(1.1);
    }
    expect(ratio(theme, "neutral-active", "hover")).toBeGreaterThanOrEqual(1.08);
    expect(ratio(theme, "selected", "panel")).toBeGreaterThanOrEqual(1.14);
    expect(theme["--pwa-selected"]).not.toBe(theme["--pwa-hover"]);
    expect(theme["--pwa-disabled-bg"]).not.toBe(theme["--pwa-hover"]);
  });

  test("keeps accent, focus and control boundaries legible", () => {
    // 文字按钮悬停时以 accent 文字落在 hover 底上。
    for (const surface of ["bg", "surface", "panel", "hover"]) {
      expect(ratio(theme, "accent", surface), `accent on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const fill of ["accent", "accent-hover", "accent-active"]) {
      expect(ratio(theme, "on-accent", fill), `on-accent on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ["bg", "surface", "panel"]) {
      expect(ratio(theme, "control-line", surface), `control-line on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("keeps status colors readable on their washes and solid fills", () => {
    for (const status of ["complete", "running", "error"]) {
      expect(ratio(theme, status, `${status}-wash`), `${status} on its wash`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme, "on-status", status), `on-status on ${status}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const fill of ["error-hover", "error-active"]) {
      expect(ratio(theme, "on-status", fill), `on-status on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("keeps both syntax palettes readable on their code surface", () => {
    for (const foreground of ["code-text", "code-dim", "syntax-keyword", "syntax-string", "syntax-number", "syntax-error", "syntax-comment", "syntax-punctuation", "syntax-function", "syntax-type"]) {
      expect(ratio(theme, foreground, "code-surface"), `${foreground} on code-surface`).toBeGreaterThanOrEqual(4.5);
    }
    // diff 行内文字在对应轻底上仍须可读。
    for (const foreground of ["code-text", "syntax-keyword", "syntax-string", "syntax-number", "syntax-error"]) {
      expect(ratio(theme, foreground, "complete-wash"), `${foreground} on complete-wash`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme, foreground, "error-wash"), `${foreground} on error-wash`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("keeps tool reader text readable on the main background", () => {
    // 工具详情阅读器与主界面同用 bg，正文沿用代码文字色。
    for (const foreground of ["code-text", "code-dim", "syntax-error"]) {
      expect(ratio(theme, foreground, "bg"), `${foreground} on bg`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("uses dark-theme accents on the always-dark code background", () => {
    for (const foreground of ["code-ink", "code-muted", "code-accent"]) {
      expect(ratio(theme, foreground, "code-bg"), `${foreground} on code-bg`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

test("the pre-hydration system dark fallback matches the dark theme", () => {
  expect(systemDark).toEqual(declarations(':root[data-mantine-color-scheme="dark"] {'));
});

test("status edges mix each status color with line at one shared ratio", () => {
  expect(shared["--pwa-running-line"]).toBe("color-mix(in srgb, var(--pwa-running) 40%, var(--pwa-line))");
  expect(shared["--pwa-error-line"]).toBe("color-mix(in srgb, var(--pwa-error) 40%, var(--pwa-line))");
});

test("browser theme color literals match the bg token", () => {
  // 首屏 meta、安装清单与运行时切换都无法引用 CSS 变量，只能写同值字面量。
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const hex = (text: string, pattern: RegExp) => pattern.exec(text)?.[1]?.toUpperCase();
  const [lightBg, darkBg] = [light["--pwa-bg"]!.toUpperCase(), dark["--pwa-bg"]!.toUpperCase()];
  expect(hex(source("../../index.html"), /<meta name="theme-color" content="(#[0-9a-f]{6})"/i)).toBe(lightBg);
  const manifest = JSON.parse(source("../../public/manifest.webmanifest")) as { theme_color: string; background_color: string };
  expect([manifest.theme_color.toUpperCase(), manifest.background_color.toUpperCase()]).toEqual([lightBg, lightBg]);
  const appearance = source("../components/pwa/pwa-appearance.tsx");
  expect(hex(appearance, /LIGHT_THEME_COLOR = "(#[0-9a-f]{6})"/i)).toBe(lightBg);
  expect(hex(appearance, /DARK_THEME_COLOR = "(#[0-9a-f]{6})"/i)).toBe(darkBg);
});
