import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const theme = read("../theme.css");
const surfaces = read("../surfaces.css");
function block(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  return Object.fromEntries(body.split(";").filter((line) => line.trim()).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
}
const light = block(theme, ':root[data-mantine-color-scheme="light"]');
const dark = block(theme, ':root[data-mantine-color-scheme="dark"]');
const fallback = block(theme, ":root:not([data-mantine-color-scheme])");

test("候选表面与颜色在明暗及无主题属性的系统回退下完整定义", () => {
  const expectedLight = {
    "--pwa-card": "var(--pwa-panel)", "--pwa-shadow-panel": "0 1px 2px #00000014, 0 2px 8px #0000000A",
    "--pwa-green": "#347953", "--pwa-green-wash": "#EAF3EC", "--pwa-amber": "#90611F", "--pwa-amber-wash": "#F9F2E6",
    "--pwa-separator-regular": "#00000014", "--pwa-separator-hairline": "#0000001F", "--pwa-edge-regular": "#0000001F", "--pwa-edge-hairline": "#00000033",
  };
  const expectedDark = {
    "--pwa-card": "var(--pwa-surface)", "--pwa-shadow-panel": "none",
    "--pwa-green": "#95CBA8", "--pwa-green-wash": "#26392E", "--pwa-amber": "#DFBA77", "--pwa-amber-wash": "#3D3528",
    "--pwa-separator-regular": "#FFFFFF1F", "--pwa-separator-hairline": "#FFFFFF29", "--pwa-edge-regular": "#FFFFFF29", "--pwa-edge-hairline": "#FFFFFF3D",
  };
  expect(light).toMatchObject(expectedLight);
  expect(dark).toMatchObject(expectedDark);
  expect(fallback).toEqual(dark);
  expect(theme).toContain('@media (prefers-color-scheme: dark) {\n:root:not([data-mantine-color-scheme])');
  const defaults = block(theme, ":root");
  expect(defaults).toMatchObject({ "--pwa-hairline": "1px", "--pwa-separator": "var(--pwa-separator-regular)", "--pwa-edge": "var(--pwa-edge-regular)" });
  expect(block(theme, ":root[data-pwa-hairline]")).toEqual({ "--pwa-hairline": "0.5px", "--pwa-separator": "var(--pwa-separator-hairline)", "--pwa-edge": "var(--pwa-edge-hairline)" });
});

test("三个可选角色均限制在 scope 后代，不影响 Modal/Drawer 或控件", () => {
  const expected = {
    card: { border: "0", background: "var(--pwa-card)", "box-shadow": "none", "border-radius": "var(--pwa-radius-xl)" },
    float: { border: "var(--pwa-hairline) solid var(--pwa-edge)", background: "var(--pwa-surface)", "box-shadow": "var(--pwa-shadow-float)", "border-radius": "var(--pwa-radius-lg)" },
    panel: { border: "var(--pwa-hairline) solid var(--pwa-edge)", background: "var(--pwa-panel)", "box-shadow": "var(--pwa-shadow-panel)", "border-radius": "var(--pwa-radius-xl)" },
  };
  for (const [role, declarations] of Object.entries(expected)) {
    expect(block(surfaces, `.pwa-ui-scope .pwa-surface-${role}`)).toEqual(declarations);
  }
  expect(surfaces.match(/\{/g)).toHaveLength(3);
  const controls = read("../controls.css");
  expect(controls).not.toMatch(/pwa-surface-|pwa-hairline|pwa-edge/);
  expect(controls).toContain("1px solid var(--pwa-control-line)");
  expect(controls).toContain("2px solid var(--pwa-accent)");
});

test("保留旧入口，仅增加可选 CSS 和根检测 API", () => {
  const pkg = JSON.parse(read("../package.json"));
  for (const file of ["foundation.css", "theme.css", "controls.css", "surfaces.css"]) {
    expect(pkg.exports[`./${file}`]).toBe(`./${file}`);
    expect(pkg.files).toContain(file);
  }
  expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
  expect(pkg.exports["./mantine"]).toEqual({ types: "./dist/mantine.d.ts", default: "./dist/mantine.js" });
  expect(read("./index.ts")).toContain('export { HAIRLINE_ATTRIBUTE, detectHairline, installHairlineDetection } from "./hairline.js"');
});
