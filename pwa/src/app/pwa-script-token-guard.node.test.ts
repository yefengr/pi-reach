// 脚本侧 token 守卫：TS 必须保留的数值副本（动效回退、Mantine 色值、断点）与 pwa-theme.css 同值，
// TSX 中的 Lucide 图标尺寸限定在 DESIGN「基础层」的取值。只检查直接写出的字面量，展开对象需在评审中核对。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PWA_MOTION_FALLBACK_MS } from "@/lib/ui/motion-duration";
import { piReachTheme } from "@/lib/ui/pi-reach-theme";
import { ICON_STROKE_WIDTH, SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";
import { DESKTOP_LAYOUT_QUERY, MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THEME = readFileSync(new URL("./pwa-theme.css", import.meta.url), "utf8");
/** 开发展厅与测试夹具不属于产品界面。 */
const EXCLUDED_DIRECTORIES = new Set(["dev", "test"]);
const VIEWPORT_QUERIES_FILE = "lib/ui/viewport-queries.ts";
/** 动效时长与曲线只经这两个文件的公共函数读取计算样式（DESIGN「动效」）。 */
const MOTION_READER_FILES = new Set(["lib/ui/motion-duration.ts", "lib/ui/motion.ts"]);
const MOTION_TOKEN_READ = /getPropertyValue\(\s*["'`]--pwa-(?:duration|ease)-/g;
const DESKTOP_MIN_WIDTH = 768;
/** 16 按钮内与状态行、20 图标按钮与导航、24 大尺寸；12 只经具名常量出现。 */
const ICON_SIZES = new Set(["16", "20", "24", "SMALL_SPINNER_SIZE"]);
const ICON_STROKES = new Set(["ICON_STROKE_WIDTH", "SMALL_SPINNER_STROKE"]);

function sourceFiles(directory: string, extensions: string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return EXCLUDED_DIRECTORIES.has(name) ? [] : sourceFiles(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) && !path.includes(".test.") ? [path] : [];
  });
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** 主题中某个选择器块内的 token（与 pwa-theme-contrast 相同的取法）。 */
function declarations(selector: string): Record<string, string> {
  const open = THEME.indexOf("{", THEME.indexOf(selector));
  const close = THEME.indexOf("}", open);
  return Object.fromEntries([...THEME.slice(open + 1, close).matchAll(/(--pwa-[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

/** 常规动效下的毫秒时长：取每个 token 的首次定义，减少动态效果的改写在其后。 */
function themeDurations(): Record<string, number> {
  const durations: Record<string, number> = {};
  for (const match of THEME.matchAll(/(--pwa-duration-[a-z-]+):\s*(\d+)ms;/g)) durations[match[1]] ??= Number(match[2]);
  return durations;
}

/** 本文件从 lucide-react 导入的图标本地名（处理 `as` 别名）。 */
function lucideNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) {
    for (const specifier of match[1].split(",")) {
      const local = specifier.trim().split(/\s+as\s+/).at(-1)?.trim();
      if (local && !local.startsWith("type ")) names.add(local);
    }
  }
  return names;
}

/** Lucide 图标开标签上的某个属性值（花括号或引号内的原文）；跟踪花括号，跳过表达式里的 `>`。 */
function iconAttributes(text: string, attribute: string): { value: string; index: number; tag: string }[] {
  const names = lucideNames(text);
  return [...text.matchAll(/<([A-Z]\w*)(?![\w.])/g)].flatMap((match) => {
    if (!names.has(match[1])) return [];
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    const value = new RegExp(`\\s${attribute}=(?:\\{([^}]+)\\}|"([^"]+)")`).exec(text.slice(match.index + match[0].length, end));
    return value ? [{ value: (value[1] ?? value[2]).trim(), index: match.index, tag: match[1] }] : [];
  });
}

describe("script token guard", () => {
  test("motion fallbacks match every millisecond duration token in the theme", () => {
    expect(PWA_MOTION_FALLBACK_MS).toEqual(themeDurations());
  });

  test("scripts read motion durations and easings only through the shared helpers", () => {
    const offenders = sourceFiles(SOURCE_ROOT, [".ts", ".tsx"]).sort().flatMap((path) => {
      const file = relative(SOURCE_ROOT, path);
      if (MOTION_READER_FILES.has(file)) return [];
      const text = readFileSync(path, "utf8");
      return [...text.matchAll(MOTION_TOKEN_READ)].map((match) => `${file}:${lineOf(text, match.index)} ${match[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  test("the single layout breakpoint agrees across CSS, scripts and Mantine", () => {
    expect(MOBILE_LAYOUT_QUERY).toBe(`(max-width: ${DESKTOP_MIN_WIDTH - 0.02}px)`);
    expect(DESKTOP_LAYOUT_QUERY).toBe(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    expect(piReachTheme.breakpoints?.sm).toBe(`${DESKTOP_MIN_WIDTH / 16}em`);
    const offenders = sourceFiles(SOURCE_ROOT, [".css", ".ts", ".tsx"]).sort().flatMap((path) => {
      const file = relative(SOURCE_ROOT, path);
      if (file === VIEWPORT_QUERIES_FILE) return [];
      const text = readFileSync(path, "utf8");
      const css = path.endsWith(".css");
      // CSS 只看 @media 条件（容器查询按组件自身宽度适配，不是布局断点），且不能引用变量，只允许写主布局断点；脚本一律引用 viewport-queries。
      const scopes = css ? [...text.matchAll(/@media[^{]*/g)] : [Object.assign([text], { index: 0 })];
      return scopes.flatMap((scope) => [...scope[0].matchAll(/\((?:min|max)-width:\s*[^)]+\)/g)].flatMap((match) => {
        if (css && match[0] === MOBILE_LAYOUT_QUERY) return [];
        return [`${file}:${lineOf(text, scope.index + match.index)} ${match[0]}`];
      }));
    });
    expect(offenders).toEqual([]);
  });

  test("Lucide icons use the documented sizes and named stroke widths", () => {
    expect([ICON_STROKE_WIDTH, SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE]).toEqual([1.8, 12, 2.4]);
    const offenders = sourceFiles(SOURCE_ROOT, [".tsx"]).sort().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const file = relative(SOURCE_ROOT, path);
      return [
        ...iconAttributes(text, "size").filter(({ value }) => !ICON_SIZES.has(value)),
        ...iconAttributes(text, "strokeWidth").filter(({ value }) => !ICON_STROKES.has(value)),
      ].map(({ value, index, tag }) => `${file}:${lineOf(text, index)} <${tag}> ${value}`);
    });
    expect(offenders).toEqual([]);
  });

  test("icon scanner reads aliased Lucide imports and ignores other components", () => {
    const text = 'import { Menu as MenuIcon, X } from "lucide-react";\nimport { Loader } from "@mantine/core";\n<MenuIcon size={18} /><X size={20} aria-hidden /><Loader size={18} />';
    expect(iconAttributes(text, "size").map(({ tag, value }) => [tag, value])).toEqual([["MenuIcon", "18"], ["X", "20"]]);
  });

  test("Mantine colors that must be literal match the theme tokens", () => {
    const light = { ...declarations("\n:root {"), ...declarations(':root[data-mantine-color-scheme="light"] {') };
    const dark = declarations(':root[data-mantine-color-scheme="dark"] {');
    const shades = piReachTheme.colors?.piReach ?? [];
    expect([piReachTheme.white, piReachTheme.black]).toEqual([light["--pwa-bg"], light["--pwa-ink"]]);
    expect(piReachTheme.primaryShade).toEqual({ light: 6, dark: 3 });
    expect([shades[6], shades[7], shades[8]]).toEqual([light["--pwa-accent"], light["--pwa-accent-hover"], light["--pwa-accent-active"]]);
    expect(shades[3]).toBe(dark["--pwa-accent"]);
    expect(piReachTheme.headings?.fontWeight).toBe("var(--pwa-weight-strong)");
  });
});
