import { useMemo } from "react";
import { usePwaMotionDuration } from "./motion-react.js";
export { usePwaMotionDuration } from "./motion-react.js";
export { pwaFadeTransition, pwaMenuTransition, pwaDrawerTransitions, PWA_DRAWER_EASE, usePwaMenuTransition, usePwaDrawerTransition } from "./mantine-transitions.js";
import { createPwaTheme } from "./mantine-theme.js";
export { createPwaTheme, pwaCssVariablesResolver, PWA_DIALOG_SIZE, PWA_CONFIRM_DIALOG_SIZE, pwaModalTransition } from "./mantine-theme.js";

/** 首次 SSR/水合使用一致回退；挂载后读取 CSS，并监听系统偏好。 */
export function usePwaTheme() {
  const duration = usePwaMotionDuration("--pwa-duration-modal-in");
  const exitDuration = usePwaMotionDuration("--pwa-duration-modal-out");
  return useMemo(() => createPwaTheme(duration, exitDuration), [duration, exitDuration]);
}
