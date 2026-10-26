// 组件静态守卫：Button 与 ActionIcon 的颜色只由 CSS token 决定（DESIGN「按钮尺寸」），不传 color prop。
// 只检查 JSX 开标签中直接写出的属性；展开对象需在评审中核对。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 开发展厅与测试夹具不属于产品界面。 */
const EXCLUDED_DIRECTORIES = new Set(["dev", "test"]);

function componentFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return EXCLUDED_DIRECTORIES.has(name) ? [] : componentFiles(path);
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

/** 截取 `<Button` 或 `<ActionIcon` 到开标签结束的属性文本；跟踪花括号，跳过表达式里的 `>`。 */
function openingTags(text: string): { tag: string; attributes: string; index: number }[] {
  return [...text.matchAll(/<(Button|ActionIcon)\b/g)].map((match) => {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    return { tag: match[1], attributes: text.slice(match.index + match[0].length, end), index: match.index };
  });
}

describe("button component guard", () => {
  test("Button and ActionIcon take colors from CSS tokens instead of a color prop", () => {
    const offenders = componentFiles(SOURCE_ROOT).sort().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return openingTags(text).filter(({ attributes }) => /(?:^|\s)color=/.test(attributes))
        .map(({ tag, index }) => `${relative(SOURCE_ROOT, path)}:${text.slice(0, index).split("\n").length} <${tag}>`);
    });
    expect(offenders).toEqual([]);
  });
});
