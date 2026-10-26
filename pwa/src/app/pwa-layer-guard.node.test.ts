// 叠层静态守卫：层级只用 pwa-theme.css 的 --pwa-z-*（DESIGN「叠层」），CSS 与 Mantine zIndex prop 都不写数字。
// 只检查直接写出的声明与 JSX 开标签属性；展开对象需在评审中核对。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THEME = readFileSync(new URL("./pwa-theme.css", import.meta.url), "utf8");
const DESIGN = readFileSync(new URL("../../../docs/DESIGN.md", import.meta.url), "utf8");
/** 开发展厅与测试夹具不属于产品界面。 */
const EXCLUDED_DIRECTORIES = new Set(["dev", "test"]);
/** 组件内部的局部堆叠：伪元素垫底、已建立层叠上下文的容器内的吸顶条。 */
const LOCAL_Z_INDEX = new Set(["-1", "0", "1", "2"]);
/** 会 Portal 并参与全局叠层的 Mantine 组件；子组件（如 Menu.Dropdown）随根组件取层。 */
const OVERLAY_COMPONENTS = new Set(["Modal", "Modal.Root", "Drawer", "Drawer.Root", "Popover", "Menu", "Tooltip", "Notifications"]);
const MANTINE_PACKAGES = /^@mantine\/(core|notifications)$/;

function sourceFiles(directory: string, extension: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return EXCLUDED_DIRECTORIES.has(name) ? [] : sourceFiles(path, extension);
    return path.endsWith(extension) && !path.includes(".test.") ? [path] : [];
  });
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** 主题中按定义顺序列出的层级 token。 */
function themeLayers(): { name: string; value: number }[] {
  return [...THEME.matchAll(/--pwa-z-([a-z-]+):\s*(-?\d+);/g)].map((match) => ({ name: match[1], value: Number(match[2]) }));
}

/** DESIGN「叠层」表中的 token 与取值。 */
function designLayers(): { name: string; value: number }[] {
  const section = DESIGN.split(/^### 叠层$/m)[1]?.split(/^### /m)[0] ?? "";
  return [...section.matchAll(/^\| `([a-z-]+)` \| (\d+) \|/gm)].map((match) => ({ name: match[1], value: Number(match[2]) }));
}

/** 本文件从 Mantine 包导入的叠层组件本地名（处理 `as` 别名，排除同名的 Lucide 图标）。 */
function mantineOverlayNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (!MANTINE_PACKAGES.test(match[2])) continue;
    for (const specifier of match[1].split(",")) {
      const [imported, local = imported] = specifier.trim().split(/\s+as\s+/).map((part) => part.trim());
      if (imported && ["Modal", "Drawer", "Popover", "Menu", "Tooltip", "Notifications"].includes(imported)) names.set(local, imported);
    }
  }
  return names;
}

/** 截取叠层组件开标签的属性文本；跟踪花括号，跳过表达式里的 `>`。 */
function overlayTags(text: string): { tag: string; attributes: string; index: number }[] {
  const names = mantineOverlayNames(text);
  return [...text.matchAll(/<([A-Z][\w]*(?:\.Root)?)(?![\w.])/g)].flatMap((match) => {
    const [local, member] = match[1].split(".");
    const imported = names.get(local);
    if (!imported) return [];
    const tag = member ? `${imported}.${member}` : imported;
    if (!OVERLAY_COMPONENTS.has(tag)) return [];
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    return [{ tag, attributes: text.slice(match.index + match[0].length, end), index: match.index }];
  });
}

describe("layer guard", () => {
  test("layer tokens strictly increase and match the DESIGN layer table", () => {
    const layers = themeLayers();
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.map(({ value }) => value)).toEqual([...layers.map(({ value }) => value)].sort((a, b) => a - b));
    expect(new Set(layers.map(({ value }) => value)).size).toBe(layers.length);
    expect(designLayers()).toEqual(layers);
  });

  test("production CSS z-index references layer tokens or a local stacking value", () => {
    const known = new Set(themeLayers().map(({ name }) => name));
    const offenders = sourceFiles(SOURCE_ROOT, ".css").sort().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return [...text.matchAll(/(?:^|[;{\s])z-index:\s*([^;}]+)/g)].flatMap((match) => {
        const value = match[1].trim().replace(/\s*!important$/, "");
        const token = /^var\(--pwa-z-([a-z-]+)\)$/.exec(value)?.[1];
        if (LOCAL_Z_INDEX.has(value) || (token && known.has(token))) return [];
        return [`${relative(SOURCE_ROOT, path)}:${lineOf(text, match.index)} z-index: ${value}`];
      });
    });
    expect(offenders).toEqual([]);
  });

  test("Mantine overlays declare zIndex with a layer token", () => {
    const known = new Set(themeLayers().map(({ name }) => name));
    const offenders = sourceFiles(SOURCE_ROOT, ".tsx").sort().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return overlayTags(text).flatMap(({ tag, attributes, index }) => {
        const token = /(?:^|\s)zIndex="var\(--pwa-z-([a-z-]+)\)"/.exec(attributes)?.[1];
        if (token && known.has(token)) return [];
        return [`${relative(SOURCE_ROOT, path)}:${lineOf(text, index)} <${tag}>`];
      });
    });
    expect(offenders).toEqual([]);
  });

  test("overlay scanner ignores icons that share a Mantine component name", () => {
    const tags = overlayTags('import { Menu } from "lucide-react";\nimport { Menu as MantineMenu, Popover } from "@mantine/core";\n<Menu size={20} /><MantineMenu zIndex="var(--pwa-z-feedback)"><Menu.Dropdown /></MantineMenu><Popover opened={a > b}>');
    expect(tags.map(({ tag, attributes }) => [tag, attributes.trim()])).toEqual([["Menu", 'zIndex="var(--pwa-z-feedback)"'], ["Popover", "opened={a > b}"]]);
  });
});
