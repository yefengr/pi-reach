import { Badge, type MantineThemeOverride } from "@mantine/core";
import { createPwaTheme } from "@yefengr/pwa-foundation/mantine";
import { PWA_MOTION_FALLBACK_MS } from "./motion-duration";

export { PWA_DIALOG_SIZE, PWA_CONFIRM_DIALOG_SIZE, pwaModalTransition, pwaCssVariablesResolver as piReachCssVariablesResolver } from "@yefengr/pwa-foundation/mantine";

/** 保留宿主旧入口；公共基础由 npm 包提供，Badge 是 Reach 的应用默认值。 */
export function createPiReachTheme(modalInDuration: number, modalOutDuration: number): MantineThemeOverride {
  const theme = createPwaTheme(modalInDuration, modalOutDuration);
  return {
    ...theme,
    components: {
      ...theme.components,
      Badge: Badge.extend({ defaultProps: { size: "xs", variant: "light", radius: "xs" } }),
    },
  };
}

// 非浏览器消费者保留回退入口；Provider 仍由应用 motion helper 读取动态时长。
export const piReachTheme = createPiReachTheme(PWA_MOTION_FALLBACK_MS["--pwa-duration-modal-in"], PWA_MOTION_FALLBACK_MS["--pwa-duration-modal-out"]);
