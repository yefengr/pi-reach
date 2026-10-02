import { ActionIcon, Badge, Button, createTheme, Modal, type CSSVariablesResolver, type MantineTransition } from "@mantine/core";

/**
 * 居中 Modal 统一轻量进出：单层遮罩淡入，弹窗轻微位移并淡入；进入 180ms（进入曲线），退出 140ms（退出曲线）。
 * 退出期间不接收指针；焦点由 Mantine 在关闭开始时交还来源控件。减少动态效果时位移为 0，只保留淡化。
 */
export const pwaModalTransition = {
  in: { opacity: 1, transform: "translateY(0)", "--pwa-modal-ease": "var(--pwa-ease-enter)" },
  out: { opacity: 0, transform: "translateY(calc(8px * var(--pwa-motion-shift, 1)))", pointerEvents: "none", "--pwa-modal-ease": "var(--pwa-ease-exit)" },
  transitionProperty: "opacity, transform",
} as MantineTransition;

/**
 * Mantine 负责基础组件行为；颜色、字号、圆角、阴影与断点全部取自 pwa-theme.css 的设计 token，
 * 不另外维护与 token 平行的视觉取值。
 */
export function createPiReachTheme(modalInDuration: number, modalOutDuration: number) {
  return createTheme({
  primaryColor: "piReach",
  // 0–9 为雾蓝色阶；浅色主题主色 6 = accent #446396，深色主题主色 3 = accent #98B8E6。
  primaryShade: { light: 6, dark: 3 },
  colors: {
    piReach: [
      "#EFF4FC",
      "#DDE7F7",
      "#BED2F3",
      "#98B8E6",
      "#7C9CD0",
      "#5F7FB4",
      "#446396",
      "#395687",
      "#2E4A78",
      "#223A61",
    ],
  },
  white: "#FFFFFF",
  black: "#2A2A2A",
  fontFamily: "var(--pwa-font-ui)",
  fontFamilyMonospace: "var(--pwa-font-mono)",
  headings: {
    fontFamily: "var(--pwa-font-ui)",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "var(--pwa-text-page)", lineHeight: "var(--pwa-leading-ui)" },
      h2: { fontSize: "var(--pwa-text-title)", lineHeight: "var(--pwa-leading-ui)" },
      h3: { fontSize: "var(--pwa-text-body)", lineHeight: "var(--pwa-leading-ui)" },
      h4: { fontSize: "var(--pwa-text-body)", lineHeight: "var(--pwa-leading-ui)" },
      h5: { fontSize: "var(--pwa-text-body)", lineHeight: "var(--pwa-leading-ui)" },
      h6: { fontSize: "var(--pwa-text-body)", lineHeight: "var(--pwa-leading-ui)" },
    },
  },
  fontSizes: { xs: "var(--pwa-text-meta)", sm: "var(--pwa-text-list)", md: "var(--pwa-text-body)", lg: "var(--pwa-text-title)", xl: "var(--pwa-text-page)" },
  lineHeights: { xs: "var(--pwa-leading-ui)", sm: "var(--pwa-leading-ui)", md: "var(--pwa-leading-body)", lg: "var(--pwa-leading-ui)", xl: "var(--pwa-leading-ui)" },
  spacing: { xs: "8px", sm: "12px", md: "16px", lg: "24px", xl: "32px" },
  defaultRadius: "sm",
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "12px" },
  shadows: {
    xs: "var(--pwa-shadow-float)",
    sm: "var(--pwa-shadow-float)",
    md: "var(--pwa-shadow-float)",
    lg: "var(--pwa-shadow-modal)",
    xl: "var(--pwa-shadow-modal)",
  },
  // 单一断点 768px：sm 及以上为桌面布局。
  breakpoints: { xs: "36em", sm: "48em", md: "62em", lg: "75em", xl: "88em" },
  focusRing: "never",
  // 减少动态效果由 pwa-theme.css 的全局规则统一处理：位移改为淡化，加载等状态动画照常运行。
  respectReducedMotion: false,
  cursorType: "pointer",
  components: {
    Button: Button.extend({ classNames: { root: "pwa-button" }, defaultProps: { size: "md", variant: "filled" } }),
    ActionIcon: ActionIcon.extend({ classNames: { root: "pwa-icon-button" }, defaultProps: { size: 44, variant: "subtle" } }),
    // 标签在上、说明与错误在输入框下方。
    TextInput: { defaultProps: { size: "md", inputWrapperOrder: ["label", "input", "description", "error"] } },
    Textarea: { defaultProps: { size: "md", inputWrapperOrder: ["label", "input", "description", "error"] } },
    Select: { defaultProps: { size: "md" } },
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        overlayProps: { className: "pwa-scrim" },
        transitionProps: { transition: pwaModalTransition, duration: modalInDuration, exitDuration: modalOutDuration, timingFunction: "var(--pwa-modal-ease, var(--pwa-ease-enter))" },
      },
    }),
    Badge: Badge.extend({ defaultProps: { size: "xs", variant: "light", radius: "xs" } }),
  },
  });
}

// 保留已有主题入口供非浏览器消费者使用；运行时 Provider 按 CSS token 注入时长。
export const piReachTheme = createPiReachTheme(180, 140);

const sharedVariables = {
  "--mantine-color-body": "var(--pwa-bg)",
  "--mantine-color-text": "var(--pwa-ink)",
  "--mantine-color-dimmed": "var(--pwa-secondary)",
  "--mantine-color-default": "var(--pwa-surface)",
  "--mantine-color-default-hover": "var(--pwa-hover)",
  "--mantine-color-default-color": "var(--pwa-ink)",
  "--mantine-color-default-border": "var(--pwa-line)",
  "--mantine-color-placeholder": "var(--pwa-secondary)",
  "--mantine-color-anchor": "var(--pwa-accent)",
  "--mantine-color-error": "var(--pwa-error)",
  "--mantine-color-primary-filled": "var(--pwa-accent)",
  "--mantine-color-primary-filled-hover": "var(--pwa-accent-hover)",
  "--mantine-color-primary-contrast": "var(--pwa-on-accent)",
  // 浅色变体（选中、轻提示）只用中性底与正文色，主色留给操作。
  "--mantine-color-primary-light": "var(--pwa-selected)",
  "--mantine-color-primary-light-hover": "var(--pwa-hover)",
  "--mantine-color-primary-light-color": "var(--pwa-ink)",
  "--mantine-color-piReach-filled": "var(--pwa-accent)",
  "--mantine-color-piReach-filled-hover": "var(--pwa-accent-hover)",
  "--mantine-color-piReach-light": "var(--pwa-selected)",
  "--mantine-color-piReach-light-hover": "var(--pwa-hover)",
  "--mantine-color-piReach-light-color": "var(--pwa-ink)",
  "--mantine-color-piReach-text": "var(--pwa-accent)",
  "--mantine-color-disabled": "var(--pwa-disabled-bg)",
  "--mantine-color-disabled-color": "var(--pwa-secondary)",
  "--mantine-color-disabled-border": "var(--pwa-line)",
  "--mantine-color-scheme-overlay": "var(--pwa-scrim)",
};

/** 明暗两套 Mantine 语义变量都指向同一组 token，token 自身按主题切换。 */
export const piReachCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: sharedVariables,
  dark: sharedVariables,
});
