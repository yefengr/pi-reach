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

/** 取 token 的颜色值，沿 var(--pwa-*) 别名解析到字面量。 */
function color(theme: Theme, name: string): string {
  const value = theme[`--pwa-${name}`] ?? (() => { throw new Error(`missing --pwa-${name}`); })();
  const reference = /^var\(--pwa-([a-z-]+)\)$/.exec(value);
  return reference ? color(theme, reference[1]!) : value;
}

function hexRatio(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

function ratio(theme: Theme, foreground: string, background: string): number {
  return hexRatio(color(theme, foreground), color(theme, background));
}

/** 透明度刻度（DESIGN「透明度」）：32% 以内步长 4%，以上步长 8%，单位为百分比。 */
const OPACITY_SCALE = Array.from({ length: 99 }, (_, index) => index + 1).filter((percent) => percent % 4 === 0 && (percent <= 32 || percent % 8 === 0));

/** 半透明色按 alpha 叠在不透明底色上的结果。 */
function composite(color: string, background: string): string {
  const alpha = parseInt(color.slice(7, 9), 16) / 255;
  const channels = [1, 3, 5].map((offset) => Math.round(parseInt(color.slice(offset, offset + 2), 16) * alpha + parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const neutralSurfaces = ["bg", "surface", "panel", "message", "hover", "selected", "neutral-active", "disabled-bg", "tonal"];
// 色调底的悬停与按下只承载按钮的 ink 文字，状态标签不会进入这两档。
const tonalStates = ["tonal-hover", "tonal-active"];
// 中性角色不带色相，颜色只出现在主色、状态色与语法色上。
const neutralRoles = [...neutralSurfaces, ...tonalStates, "ink", "secondary", "soft-ink", "line", "control-line", "code-bg", "code-muted", "code-ink"];

describe.each([["light", light], ["dark", dark]] as const)("%s theme tokens", (_name, theme) => {
  test("keeps every neutral role achromatic", () => {
    for (const role of neutralRoles) {
      const value = theme[`--pwa-${role}`] ?? "";
      expect(value, role).toMatch(/^#([0-9a-f]{2})\1\1$/i);
    }
  });

  test("keeps separator and edge tiers translucent neutrals, with edges a step deeper than separators", () => {
    // 半透明才能在 bg、panel、message 等不同底色上保持同样轻重；只辅助分区，不设对比度下限。
    const alpha = (name: string) => {
      const value = theme[`--pwa-${name}`] ?? "";
      expect(value, name).toMatch(/^#(00|FF)\1\1[0-9a-f]{2}$/i);
      return parseInt(value.slice(7), 16) / 255;
    };
    for (const role of ["separator", "edge"]) {
      // 线宽减半时颜色加深补偿。
      expect(alpha(`${role}-hairline`), role).toBeGreaterThan(alpha(`${role}-regular`));
      expect(alpha(`${role}-hairline`), role).toBeLessThan(1);
    }
    // 行间分隔参照 iOS 27 调淡；浮层外框与表格格线在同一档位上更清楚。
    for (const tier of ["regular", "hairline"]) {
      expect(alpha(`edge-${tier}`), tier).toBeGreaterThan(alpha(`separator-${tier}`));
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
    for (const state of tonalStates) expect(ratio(theme, "ink", state), `ink on ${state}`).toBeGreaterThanOrEqual(4.5);
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

  test("keeps text readable on the translucent accent selection over every reading surface", () => {
    // 选区只着底色、不改文字色：正文级文字 ≥ 4.5:1；次级文字与链接只在选中期间落在选区上，≥ 3:1。
    const selection = color(theme, "selection");
    expect(selection.slice(0, 7).toUpperCase(), "selection hue").toBe(color(theme, "accent").toUpperCase());
    expect(selection, "selection alpha").toMatch(/^#[0-9a-f]{8}$/i);
    const surfaces = [["bg", ["ink", "soft-ink"], ["secondary", "accent"]], ["surface", ["ink", "soft-ink"], ["secondary", "accent"]],
      ["panel", ["ink", "soft-ink"], ["secondary", "accent"]], ["message", ["ink"], ["secondary", "accent"]],
      ["code-surface", ["code-text"], ["code-dim"]]] as const;
    for (const [surface, primary, minor] of surfaces) {
      const selected = composite(selection, color(theme, surface));
      for (const text of primary) expect(hexRatio(color(theme, text), selected), `${text} on selection over ${surface}`).toBeGreaterThanOrEqual(4.5);
      for (const text of minor) expect(hexRatio(color(theme, text), selected), `${text} on selection over ${surface}`).toBeGreaterThanOrEqual(3);
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

test("every translucent color, color-mix ratio and element opacity in the theme sits on the opacity scale", () => {
  const percents = [
    ...[...css.matchAll(/#[0-9a-f]{6}([0-9a-f]{2})\b/gi)].map((match) => [match[0], parseInt(match[1]!, 16) / 255 * 100] as const),
    ...[...css.matchAll(/color-mix\([^;]*?(\d+)%/g)].map((match) => [match[0], Number(match[1])] as const),
    ...[...css.matchAll(/(--pwa-opacity-[a-z-]+):\s*([\d.]+);/g)].map((match) => [match[1]!, Number(match[2]) * 100] as const),
  ];
  expect(percents.length).toBeGreaterThan(0);
  // 8 位 hex 的 alpha 字节按 round(百分比 × 255) 写出，读回取整后必须正好是刻度档位。
  expect(percents.filter(([, percent]) => !OPACITY_SCALE.includes(Math.round(percent))).map(([source]) => source)).toEqual([]);
  expect([...css.matchAll(/(--pwa-opacity-[a-z-]+):/g)].map((match) => match[1])).toEqual(["--pwa-opacity-disabled", "--pwa-opacity-breathe", "--pwa-opacity-enter"]);
});

test("the opacity scale steps by 4% up to 32% and by 8% above", () => {
  expect(OPACITY_SCALE).toEqual([4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 88, 96]);
});

test("the pre-hydration system dark fallback matches the dark theme", () => {
  expect(systemDark).toEqual(declarations(':root[data-mantine-color-scheme="dark"] {'));
});

test("components read separator and edge tokens that switch tier with the measured hairline flag", () => {
  expect(shared["--pwa-hairline"]).toBe("1px");
  expect(shared["--pwa-separator"]).toBe("var(--pwa-separator-regular)");
  expect(shared["--pwa-edge"]).toBe("var(--pwa-edge-regular)");
  expect(declarations(":root[data-pwa-hairline] {")).toEqual({
    "--pwa-hairline": "0.5px",
    "--pwa-separator": "var(--pwa-separator-hairline)",
    "--pwa-edge": "var(--pwa-edge-hairline)",
  });
});

test("the tonal danger hover mixes a little error into its wash and keeps error text readable", () => {
  const mix = /^color-mix\(in srgb, var\(--pwa-error\) (\d+)%, var\(--pwa-error-wash\)\)$/.exec(shared["--pwa-error-wash-hover"] ?? "");
  expect(mix, "error-wash-hover").not.toBeNull();
  const alpha = Math.round(Number(mix![1]) / 100 * 255).toString(16).padStart(2, "0");
  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    const hover = composite(`${color(theme, "error")}${alpha}`, color(theme, "error-wash"));
    expect(hexRatio(color(theme, "error"), hover), `${name} error on error-wash-hover`).toBeGreaterThanOrEqual(4.5);
  }
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
