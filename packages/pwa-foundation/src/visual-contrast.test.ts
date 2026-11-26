import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const palette = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--pwa-([a-z-]+):\s*(#[0-9A-Fa-f]{6});/g)].map(match => [match[1], match[2]]));
};
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((left, right) => left - right);
  return (high + 0.05) / (low + 0.05);
}

test.each(["light", "dark"])("%s 公共视觉颜色保持文字与控件轮廓对比度", scheme => {
  const colors = palette(`:root[data-mantine-color-scheme="${scheme}"]`);
  for (const background of ["bg", "surface", "panel", "hover", "selected", "tonal"]) {
    for (const text of ["ink", "secondary"]) {
      expect(contrast(colors[text], colors[background]), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const background of ["bg", "surface", "panel"]) {
    expect(contrast(colors["control-line"], colors[background]), background).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.accent, colors[background]), background).toBeGreaterThanOrEqual(4.5);
  }
  for (const hue of ["green", "amber", "error"]) {
    expect(contrast(colors[hue], colors[`${hue}-wash`]), hue).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors["on-status"], colors[hue]), hue).toBeGreaterThanOrEqual(4.5);
  }
});
