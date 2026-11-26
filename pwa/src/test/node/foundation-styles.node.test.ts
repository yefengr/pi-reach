import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createPwaTheme } from "@yefengr/pwa-foundation/mantine";
import { piReachTheme } from "@/lib/ui/pi-reach-theme";
import { cssRules, foundationCssPath, pwaRoot, readStyles, themeDeclarations } from "./foundation-styles";

const source = (path: string) => readFileSync(resolve(pwaRoot, path), "utf8");
describe("registry foundation consumption", () => {
  test("精确消费 registry 0.0.4 而非维护源码链接", () => {
    expect(JSON.parse(source("package.json")).dependencies["@yefengr/pwa-foundation"]).toBe("0.0.4");
    const installed = realpathSync(resolve(pwaRoot, "node_modules/@yefengr/pwa-foundation"));
    expect(installed).toContain("node_modules/.pnpm/@yefengr+pwa-foundation@0.0.4");
    expect(JSON.parse(readFileSync(resolve(installed, "package.json"), "utf8")).version).toBe("0.0.4");
    expect(foundationCssPath("theme")).toContain(installed);
    expect(source("../pnpm-lock.yaml")).toContain("'@yefengr/pwa-foundation@0.0.4':");
  });
  test("旧主题入口仅合并应用 Badge，公共控件原样复用", () => {
    const base = createPwaTheme(400, 200);
    expect(piReachTheme.primaryColor).toBe(base.primaryColor);
    for (const component of ["Button", "ActionIcon", "TextInput", "Textarea", "Select", "Modal"]) {
      expect(piReachTheme.components?.[component]).toEqual(base.components?.[component]);
    }
    expect(piReachTheme.components?.Badge?.defaultProps).toMatchObject({ size: "xs", variant: "light", radius: "xs" });
    expect(source("src/lib/ui/pi-reach-theme.ts")).not.toMatch(/#[0-9a-f]{6}|sharedVariables|piReach:\s*\[/i);
  });
  test("公共 token 不留应用副本，应用增量仍保留", () => {
    const publicRules = cssRules(readFileSync(foundationCssPath("theme"), "utf8"));
    for (const appRule of cssRules(source("src/app/pwa-theme.css"))) {
      for (const publicRule of publicRules.filter(rule => rule.media === appRule.media && rule.selector === appRule.selector)) {
        const names = [...publicRule.body.matchAll(/(--pwa-[\w-]+)\s*:/g)].map(match => match[1]);
        for (const name of names) expect(appRule.body, name).not.toContain(`${name}:`);
      }
    }
    const theme = readStyles(resolve(pwaRoot, "src/app/pwa-theme.css"));
    expect(themeDeclarations(theme, ":root")).toHaveProperty("--pwa-z-modal", "300");
    expect(themeDeclarations(theme, ':root[data-mantine-color-scheme="dark"]')).toHaveProperty("--pwa-syntax-keyword", "#98B8E6");
    const app = source("src/app/globals.css");
    for (const selector of [".pwa-ui-scope .pwa-button {", ".pwa-ui-scope .pwa-icon-button {", ".pwa-confirm-actions {", ".pwa-confirm-dialog {"]) expect(app).not.toContain(selector);
    expect(app).toContain(".pwa-composer-input:focus-within");
    expect(source("src/app/pwa-controls.css")).toContain("data-pwa-press-release");
  });
  test("合并同选择器扩展时保持媒体分支隔离", () => {
    const css = ':root { --pwa-text-body: 16px; } @media (pointer: coarse) { :root { --pwa-text-body: 17px; } } :root { --pwa-z-modal: 300; }';
    expect(themeDeclarations(css, ":root")).toEqual({ "--pwa-text-body": "16px", "--pwa-z-modal": "300" });
    expect(cssRules(css).filter(rule => rule.media)).toHaveLength(1);
  });
  test("包回归只依赖包内历史夹具且不随 npm 发布", () => {
    const root = resolve(pwaRoot, "../packages/pwa-foundation");
    const regression = readFileSync(resolve(root, "src/source-equivalence.test.ts"), "utf8");
    expect(regression).not.toContain("../../../pwa/");
    expect(regression).toContain("fixtures/pre-extraction");
    expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).files).not.toContain("src");
  });
});
