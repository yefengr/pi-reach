import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const foundationCssPath = (name: "theme" | "controls") => require.resolve(`@yefengr/pwa-foundation/${name}.css`);

/** 测试读取真实安装入口，按 @import 顺序展开；不读取仓库维护包。 */
export function readStyles(path: string | URL): string {
  const text = readFileSync(path, "utf8");
  return text.replace(/@import\s+"([^"]+)";/g, (statement, specifier: string) => {
    if (/^@yefengr\/pwa-foundation\/(?:theme|controls)\.css$/.test(specifier)) return readStyles(require.resolve(specifier));
    // 这里只展开基础样式；其他应用文件仍由原守卫逐文件扫描，避免重复扫描。
    return statement;
  });
}

export type CssRule = { selector: string; media: string; body: string };
/** 只解析当前普通声明与媒体块，保留选择器组，避免 first-block 丢掉应用扩展。 */
export function cssRules(css: string, media = ""): CssRule[] {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\s+[^;]+;/g, "");
  const result: CssRule[] = [];
  let start = 0;
  while (start < css.length) {
    const open = css.indexOf("{", start);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth; end++) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
    }
    if (depth) throw new Error("测试 CSS 块未闭合");
    const selector = css.slice(start, open).trim().replace(/\s+/g, " ");
    const body = css.slice(open + 1, end - 1);
    if (selector.startsWith("@media")) result.push(...cssRules(body, selector));
    else if (!selector.startsWith("@")) result.push({ selector, media, body });
    start = end;
  }
  return result;
}

export function themeDeclarations(css: string, selector: string): Record<string, string> {
  const target = selector.trim().replace(/\s*\{$/, "");
  const media = target.includes(":not(") ? "@media (prefers-color-scheme: dark)" : "";
  const matched = cssRules(css).filter(rule => rule.media === media && rule.selector.split(/,\s*/).includes(target));
  if (!matched.length) throw new Error(`missing ${selector}`);
  return Object.fromEntries(matched.flatMap(rule => [...rule.body.matchAll(/(--pwa-[a-z0-9-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()])));
}

// 供消费守卫定位应用目录；不能回退到 packages/pwa-foundation 源码。
export const pwaRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
