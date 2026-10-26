// CSS 静态守卫：防止样式字面量回退，不替代盒模型、点击区域与行为测试。
// 只扫描 pwa/src 下的 CSS；TSX 中的 Mantine props、内联样式与 theme 字面量不在范围内。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THEME_FILE = "app/pwa-theme.css";
/** 通用间距档位（DESIGN「间距」）。gutter 20 不是档位。 */
const SPACING_SCALE = new Set([0, 4, 8, 12, 16, 24, 32, 48]);
/** 领域细档 2／6／10（DESIGN「间距」）。 */
const SPACING_DENSITY = new Set([2, 6, 10]);
/** 间距 token 的固定取值；只允许在主题文件定义，且不得漂移。 */
const SPACING_TOKENS = new Map([
  ["--pwa-space-2xs", 4],
  ["--pwa-space-xs", 8],
  ["--pwa-space-sm", 12],
  ["--pwa-space-md", 16],
  ["--pwa-space-lg", 24],
  ["--pwa-space-xl", 32],
  ["--pwa-space-2xl", 48],
  ["--pwa-space-pair", 2],
  ["--pwa-space-status", 6],
  ["--pwa-space-menu-pad", 10],
  ["--pwa-space-composer", 10],
]);
/** 通用圆角三档；主要输入表面独立使用 16px。 */
const RADIUS_TOKENS = new Map([
  ["--pwa-radius-xs", "4px"],
  ["--pwa-radius-md", "8px"],
  ["--pwa-radius-lg", "12px"],
  ["--pwa-radius-composer", "16px"],
]);
const RADIUS_VALUE = /^(?:0|50%|inherit|var\(--pwa-radius-(?:xs|md|lg)\))$/;
/** 边框与轮廓宽度只用细线。 */
const BORDER_WIDTHS = new Set([0, 1, 2, 3]);
const SPACING_PROPERTY = /^(?:(?:scroll-)?(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|(?:row-|column-)?gap)$/;
/** 名称含间距语义的自定义属性，例如 --pwa-timeline-pad-bottom。 */
const SPACING_CUSTOM_PROPERTY = /^--pwa-(?!space-)[a-z0-9-]*(?:pad|gap|margin|inset)[a-z0-9-]*$/;
const BORDER_WIDTH_PROPERTY = /^(?:border|outline)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-width)?$/;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;

type Declaration = { file: string; selector: string; property: string; value: string };
type Exception = { file: string; selector: string; property: string; values: number[]; reason: string };

const OPTICAL = "1px 光学校正或读屏隐藏（.pwa-sr-only 同款）";
const ALIGN = "负外边距让文字或图标与内容左缘对齐，或抵消点击区／gutter 超出视觉的部分";

/** 已登记的非档位、非细档间距；数值不在 values 中或登记失效都会失败。新增时同步 DESIGN。 */
const EXCEPTIONS: Exception[] = [
  { file: "app/globals.css", selector: ".pwa-sr-only", property: "margin", values: [-1], reason: OPTICAL },
  { file: "app/globals.css", selector: ".pwa-message-list", property: "--pwa-timeline-pad-bottom", values: [88], reason: "消息区底部为浮动「最新」入口预留" },
  { file: "app/globals.css", selector: ".pwa-message-list", property: "scroll-padding-bottom", values: [88], reason: "与消息区底部留白同值，确保滚动定位避开「最新」入口" },
  { file: "app/globals.css", selector: ".pwa-ui-scope .pwa-root .pwa-button.pwa-settings-back", property: "margin-left", values: [-8], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-pairing-head", property: "margin", values: [-10], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-field-error svg", property: "margin-top", values: [1], reason: OPTICAL },
  { file: "app/globals.css", selector: ".pwa-pairing-methods", property: "margin", values: [-8], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-runtime-notice .pwa-runtime-notice-dismiss", property: "margin", values: [-4], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-ui-scope .pwa-toast-dismiss", property: "margin", values: [-6, -8], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-app-shell[data-compact-height] .pwa-runtime-notice-description", property: "margin", values: [-1], reason: OPTICAL },
  { file: "app/workspace-shell.css", selector: ".pwa-root[data-sidebar-collapsed] .pwa-title-bar", property: "padding-left", values: [56], reason: "收起侧栏后标题区避让展开入口（8＋44＋4），另加左安全区" },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-workspace-state", property: "padding", values: [260], reason: "主区空状态顶部 clamp(48px, 24dvh, 260px) 的上限" },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-title-bar .pwa-connection.online .pwa-connection-label", property: "margin", values: [-1], reason: OPTICAL },
  { file: "components/pwa/attachment-cards.css", selector: ".pwa-attachment-meta", property: "gap", values: [3], reason: "附件卡片 58 高的领域密度" },
  { file: "components/pwa/published-files.css", selector: ".pwa-root .pwa-published-placeholder", property: "padding", values: [20], reason: "媒体占位区留白" },
  { file: "components/pwa/published-files.css", selector: ".pwa-root .pwa-file-image-stage", property: "padding", values: [20], reason: "图片舞台留白，避免图片贴边" },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-markdown ul, .pwa-markdown ol", property: "padding-left", values: [20], reason: "Markdown 列表缩进" },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-markdown code", property: "padding", values: [1], reason: OPTICAL },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-ui-scope .pwa-icon-button.pwa-code-copy", property: "margin-block", values: [-4], reason: ALIGN },
  { file: "components/pwa/tool-reader.css", selector: ".pwa-ui-scope .pwa-button.pwa-tool-details-button", property: "margin-left", values: [-8], reason: ALIGN },
];

type HoverRule = { file: string; selector: string };
/** 不在 @media (hover: hover) 内的 :hover 规则只允许取消 Mantine 默认悬停或保持选中态；登记失效会失败。 */
const HOVER_OVERRIDES: (HoverRule & { reason: string })[] = [
  { file: "app/globals.css", selector: ".pwa-ui-scope .pwa-composer .pwa-composer-input, .pwa-ui-scope .pwa-composer .pwa-composer-input:hover, .pwa-ui-scope .pwa-composer .pwa-composer-input:focus, .pwa-ui-scope .pwa-composer .pwa-composer-input:focus-within", reason: "取消 Mantine 输入框的悬停与聚焦样式" },
  { file: "app/globals.css", selector: ".pwa-command-choice[data-selected]:hover:not(:disabled), .pwa-command-choice[data-selected]:focus-visible:not(:disabled)", reason: "当前项悬停时保持 selected 底色" },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-computer-select:hover, .pwa-root .pwa-computer-select:active, .pwa-root .pwa-computer-select[data-active], .pwa-root .pwa-computer-select[data-active]:hover, .pwa-root .pwa-computer-select[data-active]:active", reason: "取消 Mantine NavLink 悬停底色，由外层卡片负责" },
];

function cssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

/** 逐条提取声明：去掉注释后按最内层花括号分块，选择器取 `;` 之后的部分（排除 @import 等语句）。 */
function declarations(): Declaration[] {
  return cssFiles(SOURCE_ROOT).sort().flatMap((path) => {
    const file = relative(SOURCE_ROOT, path);
    const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((block) => {
      const selector = block[1].split(";").at(-1)!.trim().replace(/\s+/g, " ");
      return block[2].split(";").flatMap((raw) => {
        const colon = raw.indexOf(":");
        if (colon < 0) return [];
        return [{ file, selector, property: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() }];
      });
    });
  });
}

/** 逐字符跟踪花括号栈，找出外层没有 @media (hover: hover) 的 :hover 规则。 */
function hoverRulesOutsideHoverMedia(): HoverRule[] {
  return cssFiles(SOURCE_ROOT).sort().flatMap((path) => {
    const file = relative(SOURCE_ROOT, path);
    const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stack: string[] = [];
    const found: HoverRule[] = [];
    let head = "";
    for (const char of text) {
      if (char === "{") {
        const selector = head.trim().replace(/\s+/g, " ");
        if (!selector.startsWith("@") && selector.includes(":hover") && !stack.some((outer) => /\(hover:\s*hover\)/.test(outer))) found.push({ file, selector });
        stack.push(selector);
        head = "";
      } else if (char === "}") {
        stack.pop();
        head = "";
      } else if (char === ";") {
        head = "";
      } else {
        head += char;
      }
    }
    return found;
  });
}

const pxValues = (value: string) => [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((match) => Number(match[1]));
const keyOf = (entry: { file: string; selector: string; property: string }) => `${entry.file} | ${entry.selector} | ${entry.property}`;
const isApprovedSpacing = (value: number) => value >= 0 && (SPACING_SCALE.has(value) || SPACING_DENSITY.has(value));
const isSpacingDeclaration = (property: string) => SPACING_PROPERTY.test(property) || SPACING_CUSTOM_PROPERTY.test(property);

describe("CSS static guard", () => {
  const all = declarations();

  test("finds declarations in every stylesheet", () => {
    expect(new Set(all.map((entry) => entry.file)).size).toBe(cssFiles(SOURCE_ROOT).length);
  });

  test("hex colors appear only in the theme tokens", () => {
    const offenders = all.filter((entry) => entry.file !== THEME_FILE && HEX_COLOR.test(entry.value)).map(keyOf);
    expect(offenders).toEqual([]);
  });

  test("spacing uses the scale, a density value, or a registered selector and property exception", () => {
    const exceptions = new Map(EXCEPTIONS.map((exception) => [keyOf(exception), exception]));
    const offenders = all.filter((entry) => isSpacingDeclaration(entry.property)).flatMap((entry) => {
      const allowed = exceptions.get(keyOf(entry))?.values ?? [];
      const outside = pxValues(entry.value).filter((value) => !isApprovedSpacing(value) && !allowed.includes(value));
      return outside.length ? [`${keyOf(entry)}: ${outside.join(", ")}px`] : [];
    });
    expect(offenders).toEqual([]);
  });

  test("every registered exception still matches a declaration and an unapproved value", () => {
    const stale = EXCEPTIONS.filter((exception) => !all.some((entry) => keyOf(entry) === keyOf(exception)
      && exception.values.every((value) => pxValues(entry.value).includes(value)))).map(keyOf);
    expect(stale).toEqual([]);
    expect(EXCEPTIONS.every((exception) => exception.reason.length > 0)).toBe(true);

    const unnecessary = EXCEPTIONS.filter((exception) => exception.values.every(isApprovedSpacing)).map(keyOf);
    expect(unnecessary).toEqual([]);
  });

  test("spacing tokens are defined once with their documented values", () => {
    const definitions = all.filter((entry) => entry.property.startsWith("--pwa-space-"));
    const offenders = definitions.flatMap((entry) => {
      const expected = SPACING_TOKENS.get(entry.property);
      const actual = pxValues(entry.value);
      if (entry.file !== THEME_FILE) return [`${keyOf(entry)}: defined outside theme`];
      if (expected === undefined) return [`${keyOf(entry)}: unknown token`];
      return actual.length === 1 && actual[0] === expected ? [] : [`${keyOf(entry)}: ${entry.value}`];
    });
    const duplicates = definitions.filter((entry, index) => definitions.findIndex((other) => keyOf(other) === keyOf(entry)) !== index).map(keyOf);
    expect(offenders).toEqual([]);
    expect(duplicates).toEqual([]);
    expect(new Set(definitions.map((entry) => entry.property)).size).toBe(SPACING_TOKENS.size);
  });

  test("radius tokens are defined once with the three shared sizes and the Composer size", () => {
    const definitions = all.filter((entry) => entry.property.startsWith("--pwa-radius-"));
    const offenders = definitions.filter((entry) => entry.file !== THEME_FILE
      || RADIUS_TOKENS.get(entry.property) !== entry.value).map(keyOf);
    expect(offenders).toEqual([]);
    for (const token of RADIUS_TOKENS.keys()) {
      expect(definitions.filter((entry) => entry.property === token), token).toHaveLength(1);
    }
  });

  test("production radii use shared tokens, edge or circle geometry, with Composer isolated", () => {
    const offenders = all.filter((entry) => !entry.file.startsWith("dev/")
      && entry.property.includes("radius") && !entry.property.startsWith("--pwa-radius-")).filter((entry) => {
      const value = entry.value.replace(/\s*!important$/, "");
      if (value === "var(--pwa-radius-composer)") {
        return entry.file !== "app/globals.css" || entry.selector !== ".pwa-composer-card" || entry.property !== "border-radius";
      }
      return !value.split(/\s+/).every((part) => RADIUS_VALUE.test(part));
    }).map(keyOf);
    expect(offenders).toEqual([]);
  });

  test("image radii follow display roles rather than their content source", () => {
    const roles = [
      ["components/pwa/attachment-cards.css", ".pwa-attachment-thumb", "xs"],
      ["app/queued-messages.css", ".pwa-queued-message-images img", "xs"],
      ["components/pwa/timeline-content.css", ".pwa-message-image", "md"],
      ["components/pwa/timeline-content.css", ".pwa-markdown img", "md"],
      ["components/pwa/tool-reader.css", ".pwa-root .pwa-tool-output-image", "md"],
      ["components/pwa/published-files.css", ".pwa-root .pwa-published-image", "md"],
      ["components/pwa/published-files.css", ".pwa-root .pwa-published-image img", "md"],
      ["components/pwa/published-files.css", ".pwa-root .pwa-file-image-stage img", "md"],
      ["components/pwa/published-files.css", ".pwa-root .pwa-published-image-transition", "md"],
    ] as const;
    for (const [file, selector, size] of roles) {
      const matches = all.filter((entry) => entry.file === file && entry.selector === selector && entry.property === "border-radius");
      expect(matches, `${file}: ${selector}`).toHaveLength(1);
      expect(matches[0].value).toBe(`var(--pwa-radius-${size})`);
    }
  });

  test("hover feedback stays inside @media (hover: hover) except registered overrides", () => {
    const key = (rule: HoverRule) => `${rule.file} | ${rule.selector}`;
    const allowed = new Set(HOVER_OVERRIDES.map(key));
    const found = hoverRulesOutsideHoverMedia();
    expect(found.map(key).filter((rule) => !allowed.has(rule))).toEqual([]);
    const present = new Set(found.map(key));
    expect(HOVER_OVERRIDES.map(key).filter((rule) => !present.has(rule))).toEqual([]);
  });

  test("border and outline widths stay hairline", () => {
    const offenders = all.filter((entry) => BORDER_WIDTH_PROPERTY.test(entry.property))
      .filter((entry) => pxValues(entry.value).some((value) => !BORDER_WIDTHS.has(value))).map(keyOf);
    expect(offenders).toEqual([]);
  });
});
