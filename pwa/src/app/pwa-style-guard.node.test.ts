// CSS 静态守卫：防止样式字面量回退，不替代盒模型、点击区域与行为测试。
// 只扫描 pwa/src 下的 CSS；TSX 中的 Mantine props、内联样式与 theme 字面量不在范围内。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THEME_FILE = "app/pwa-theme.css";
/** 通用间距档位与页面 gutter（DESIGN「间距」）。 */
const SPACING_SCALE = new Set([0, 4, 8, 12, 16, 20, 24, 32, 48]);
/** 边框与轮廓宽度只用细线。 */
const BORDER_WIDTHS = new Set([0, 1, 2, 3]);
const SPACING_PROPERTY = /^(?:(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|(?:row-|column-)?gap)$/;
const BORDER_WIDTH_PROPERTY = /^(?:border|outline)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-width)?$/;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;

type Declaration = { file: string; selector: string; property: string; value: string };
type Exception = { file: string; selector: string; property: string; values: number[]; reason: string };

const OPTICAL = "1px 光学校正或读屏隐藏（.pwa-sr-only 同款）";
const ALIGN = "负外边距让文字或图标与内容左缘对齐，或抵消 44 点击区超出视觉的部分";
const TEXT_PAIR = "强关联的双行文字间隔 2";
const NAV = "导航与列表的紧凑密度：行内边距 6、行间 2";
const MENU = "菜单与浮层内部：容器 6、菜单项 6/10";
const COMPOSER = "Composer 领域密度：内边距 10/12、操作区间隔 6";
const COMPACT = "矮窗口密度压缩纵向空间";
const TEXT_BUTTON = "文字按钮左右内边距 10";
const STATUS = "图标与状态文字同行间隔 6";
const NOTICE = "提示条与通知的紧凑内边距 10/6 与上下间隔 6";

/** 已登记的非档位间距；数值不在 values 中或例外失效都会失败。新增时同步 DESIGN。 */
const EXCEPTIONS: Exception[] = [
  { file: "app/globals.css", selector: ".pwa-sr-only", property: "margin", values: [-1], reason: OPTICAL },
  { file: "app/globals.css", selector: ".pwa-root .pwa-session-actions-divider", property: "margin", values: [6], reason: MENU },
  { file: "app/globals.css", selector: '.pwa-ui-scope .pwa-button[data-variant="transparent"]', property: "padding", values: [10], reason: TEXT_BUTTON },
  { file: "app/globals.css", selector: ".pwa-composer", property: "padding", values: [10], reason: COMPOSER },
  { file: "app/globals.css", selector: ".pwa-composer-card", property: "padding", values: [10], reason: COMPOSER },
  { file: "app/globals.css", selector: ".pwa-composer-preview", property: "margin", values: [2], reason: COMPOSER },
  { file: "app/globals.css", selector: ".pwa-ui-scope .pwa-composer .pwa-composer-input, .pwa-ui-scope .pwa-composer .pwa-composer-input:hover, .pwa-ui-scope .pwa-composer .pwa-composer-input:focus, .pwa-ui-scope .pwa-composer .pwa-composer-input:focus-within", property: "padding", values: [10], reason: COMPOSER },
  { file: "app/globals.css", selector: ".pwa-composer-tools, .pwa-composer-actions", property: "gap", values: [6], reason: COMPOSER },
  { file: "app/globals.css", selector: ".pwa-root .pwa-composer-menu-panel", property: "padding", values: [6], reason: MENU },
  { file: "app/globals.css", selector: ".pwa-composer-menu-panel button", property: "padding", values: [10], reason: MENU },
  { file: "app/globals.css", selector: ".pwa-root .pwa-command-menu-dropdown", property: "padding", values: [6], reason: MENU },
  { file: "app/globals.css", selector: ".pwa-command-row, .pwa-command-back", property: "padding", values: [6, 10], reason: MENU },
  { file: "app/globals.css", selector: ".pwa-command-copy", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/globals.css", selector: ".pwa-command-menu-heading", property: "padding", values: [10, 6], reason: MENU },
  { file: "app/globals.css", selector: ".pwa-command-empty", property: "padding", values: [10], reason: MENU },
  { file: "app/globals.css", selector: ".pwa-ui-scope .pwa-root .pwa-button.pwa-settings-back", property: "margin-left", values: [-8], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-appearance-option .mantine-Radio-label", property: "padding-left", values: [10], reason: "单选圆点与选项内容间隔 10，与图标和文字的 10 同宽" },
  { file: "app/globals.css", selector: ".pwa-appearance-copy", property: "gap", values: [10], reason: "单选选项内图标与双行文字间隔 10" },
  { file: "app/globals.css", selector: ".pwa-appearance-copy > span", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/globals.css", selector: ".pwa-layout-reset-note", property: "margin", values: [6], reason: "按钮下方的补充说明间隔 6" },
  { file: "app/globals.css", selector: ".pwa-pairing-head", property: "margin", values: [-10], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-field-error", property: "gap", values: [6], reason: STATUS },
  { file: "app/globals.css", selector: ".pwa-field-error svg", property: "margin-top", values: [1], reason: OPTICAL },
  { file: "app/globals.css", selector: ".pwa-pairing-methods", property: "margin", values: [-8], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-runtime-notice", property: "padding", values: [10, 6], reason: NOTICE },
  { file: "app/globals.css", selector: ".pwa-runtime-notice .pwa-runtime-notice-body", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/globals.css", selector: ".pwa-runtime-notice .pwa-runtime-notice-dismiss", property: "margin", values: [-4], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-ui-scope .pwa-toast-dismiss", property: "margin", values: [-6, -8], reason: ALIGN },
  { file: "app/globals.css", selector: ".pwa-app-shell[data-compact-height] .pwa-runtime-notice", property: "padding-block", values: [6], reason: COMPACT },
  { file: "app/globals.css", selector: ".pwa-app-shell[data-compact-height] .pwa-runtime-notice-content", property: "gap", values: [6], reason: COMPACT },
  { file: "app/globals.css", selector: ".pwa-app-shell[data-compact-height] .pwa-runtime-notice-description", property: "margin", values: [-1], reason: OPTICAL },
  { file: "app/globals.css", selector: ".pwa-app-shell[data-compact-height] .pwa-toast", property: "margin-block", values: [2], reason: COMPACT },
  { file: "app/globals.css", selector: ".pwa-root .pwa-settings-header", property: "margin", values: [-16], reason: "移动设置页顶栏左右铺满，抵消内容区 16 内边距" },
  { file: "app/globals.css", selector: ".pwa-connection-banner", property: "margin-top", values: [6], reason: NOTICE },
  { file: "app/globals.css", selector: ".pwa-runtime-notice", property: "margin-top", values: [6], reason: NOTICE },
  { file: "app/globals.css", selector: ".pwa-runtime-notice-content", property: "gap", values: [10], reason: NOTICE },
  { file: "app/queued-messages.css", selector: ".pwa-queued-messages-header", property: "margin-bottom", values: [6], reason: "排队消息区标题与列表的紧凑间隔" },
  { file: "app/queued-messages.css", selector: ".pwa-queued-messages-count", property: "padding", values: [6], reason: "计数徽标左右内边距" },
  { file: "app/queued-messages.css", selector: ".pwa-queued-message-list", property: "gap", values: [6], reason: "排队消息行间隔" },
  { file: "app/queued-messages.css", selector: ".pwa-queued-message-copy", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/queued-messages.css", selector: ".pwa-queued-message-copy", property: "padding-block", values: [6], reason: NAV },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-button.pwa-device-trigger", property: "padding", values: [6], reason: NAV },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-device-trigger-copy", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-device-popover", property: "padding", values: [6], reason: MENU },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-device-panel-pair", property: "margin-top", values: [6], reason: MENU },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-computer-select", property: "gap", values: [10], reason: "电脑行图标与双行文字间隔 10" },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-computer-select", property: "padding", values: [6], reason: NAV },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-peer-presence", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-presence-label, .pwa-root .pwa-current-label", property: "padding", values: [2, 6], reason: "状态徽标内边距" },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-peer-menu-panel", property: "padding", values: [6], reason: MENU },
  { file: "app/workspace-navigation.css", selector: ".pwa-root .pwa-device-drawer-body", property: "padding", values: [10], reason: MENU },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-nav-heading-copy", property: "gap", values: [6], reason: STATUS },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-nav-session, .pwa-root .pwa-history-row", property: "margin", values: [2], reason: NAV },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-nav-session, .pwa-root .pwa-history-row", property: "padding", values: [6], reason: NAV },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-nav-session .pwa-nav-link-body, .pwa-root .pwa-history-row .pwa-nav-link-body", property: "gap", values: [2], reason: TEXT_PAIR },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-history-more", property: "margin", values: [2], reason: NAV },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-sidebar-foot, .pwa-root .pwa-session-sheet-foot", property: "gap", values: [2], reason: NAV },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-sidebar-foot .pwa-button, .pwa-root .pwa-session-sheet-foot .pwa-button", property: "padding-inline", values: [10], reason: TEXT_BUTTON },
  { file: "app/workspace-shell.css", selector: ".pwa-session-info", property: "padding", values: [10], reason: "会话信息弹层是只读阅读区，保留 8/10 内边距" },
  { file: "app/workspace-shell.css", selector: ".pwa-ui-scope .pwa-root .pwa-topbar > .pwa-topbar-back", property: "margin-right", values: [-4], reason: "顶栏返回按钮与标题间隔 4" },
  { file: "app/workspace-shell.css", selector: ".pwa-root[data-sidebar-collapsed] .pwa-title-bar", property: "padding-left", values: [56], reason: "收起侧栏后标题区避让展开入口（8＋44＋4）" },
  { file: "app/workspace-shell.css", selector: ".pwa-connection", property: "gap", values: [6], reason: STATUS },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-workspace-state", property: "padding", values: [260], reason: "主区空状态顶部 clamp(48px, 24dvh, 260px) 的上限" },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-read-only-bar", property: "margin", values: [10], reason: COMPOSER },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-nav-skeleton", property: "gap", values: [10], reason: "导航骨架按导航行文字位置排列" },
  { file: "app/workspace-shell.css", selector: ".pwa-root .pwa-title-bar .pwa-connection.online .pwa-connection-label", property: "margin", values: [-1], reason: OPTICAL },
  { file: "components/pwa/attachment-cards.css", selector: ".pwa-attachment-card", property: "padding", values: [6], reason: "附件卡片 58 高的领域密度" },
  { file: "components/pwa/attachment-cards.css", selector: ".pwa-attachment-meta", property: "gap", values: [3], reason: "附件卡片 58 高的领域密度" },
  { file: "components/pwa/published-files.css", selector: ".pwa-root .pwa-published-actions", property: "gap", values: [2], reason: "相邻 44 图标按钮的点击区紧挨，视觉圆间隔已超过 8" },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-message-status", property: "gap", values: [6], reason: STATUS },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-markdown code", property: "padding", values: [1], reason: OPTICAL },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-markdown th, .pwa-markdown td", property: "padding", values: [6, 10], reason: "Markdown 表格单元格的阅读密度" },
  { file: "components/pwa/timeline-content.css", selector: ".pwa-ui-scope .pwa-icon-button.pwa-code-copy", property: "margin-block", values: [-4], reason: ALIGN },
  { file: "components/pwa/timeline-row.css", selector: ".pwa-timeline-row", property: "margin", values: [6], reason: "工具状态行间距 6（阅读密度）" },
  { file: "components/pwa/timeline-row.css", selector: ".pwa-timeline-toggle", property: "padding", values: [6], reason: "工具状态行折叠头的阅读密度" },
  { file: "components/pwa/tool-reader.css", selector: ".pwa-ui-scope .pwa-button.pwa-tool-details-button", property: "margin-left", values: [-8], reason: ALIGN },
  { file: "components/pwa/tool-reader.css", selector: ".pwa-root .pwa-reader-error", property: "padding", values: [10], reason: NOTICE },
  { file: "components/pwa/tool-reader.css", selector: ".pwa-root .pwa-reader-error > svg", property: "margin-top", values: [2], reason: OPTICAL },
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

const pxValues = (value: string) => [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((match) => Number(match[1]));
const keyOf = (entry: { file: string; selector: string; property: string }) => `${entry.file} | ${entry.selector} | ${entry.property}`;

describe("CSS static guard", () => {
  const all = declarations();

  test("finds declarations in every stylesheet", () => {
    expect(new Set(all.map((entry) => entry.file)).size).toBe(cssFiles(SOURCE_ROOT).length);
  });

  test("hex colors appear only in the theme tokens", () => {
    const offenders = all.filter((entry) => entry.file !== THEME_FILE && HEX_COLOR.test(entry.value)).map(keyOf);
    expect(offenders).toEqual([]);
  });

  test("spacing uses the scale or a registered selector and property exception", () => {
    const exceptions = new Map(EXCEPTIONS.map((exception) => [keyOf(exception), exception]));
    const offenders = all.filter((entry) => SPACING_PROPERTY.test(entry.property)).flatMap((entry) => {
      const allowed = exceptions.get(keyOf(entry))?.values ?? [];
      const outside = pxValues(entry.value).filter((value) => (value < 0 || !SPACING_SCALE.has(value)) && !allowed.includes(value));
      return outside.length ? [`${keyOf(entry)}: ${outside.join(", ")}px`] : [];
    });
    expect(offenders).toEqual([]);
  });

  test("every registered exception still matches a declaration and value", () => {
    const stale = EXCEPTIONS.filter((exception) => !all.some((entry) => keyOf(entry) === keyOf(exception)
      && exception.values.every((value) => pxValues(entry.value).includes(value)))).map(keyOf);
    expect(stale).toEqual([]);
    expect(EXCEPTIONS.every((exception) => exception.reason.length > 0)).toBe(true);
  });

  test("border and outline widths stay hairline", () => {
    const offenders = all.filter((entry) => BORDER_WIDTH_PROPERTY.test(entry.property))
      .filter((entry) => pxValues(entry.value).some((value) => !BORDER_WIDTHS.has(value))).map(keyOf);
    expect(offenders).toEqual([]);
  });
});
