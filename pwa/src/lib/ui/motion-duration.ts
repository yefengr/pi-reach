import { PWA_MOTION_FALLBACK_MS as COMMON_FALLBACK_MS, readPwaMotionDuration as readDuration } from "@yefengr/pwa-foundation";
export { resolvePwaMotionDuration } from "@yefengr/pwa-foundation";

/** 公共回退由包维护；这里只补充路由、消息、阅读和输入停靠的应用时长。 */
export const PWA_MOTION_FALLBACK_MS = {
  ...COMMON_FALLBACK_MS,
  "--pwa-duration-sidebar": 360,
  "--pwa-duration-page": 360,
  "--pwa-duration-page-out": 280,
  "--pwa-duration-switch-out": 200,
  "--pwa-duration-keyboard-dock": 200,
  "--pwa-duration-image-in": 400,
  "--pwa-duration-image-out": 280,
  "--pwa-duration-image-zoom": 320,
  "--pwa-duration-overscroll": 280,
  "--pwa-duration-toast": 400,
  "--pwa-duration-toast-out": 200,
  "--pwa-duration-message-in": 400,
  "--pwa-duration-scroll-latest": 400,
  "--pwa-duration-reorder": 280,
} as const;

export type PwaMotionDurationToken = keyof typeof PWA_MOTION_FALLBACK_MS;

/** 保留应用旧入口与完整 token 集；解析和系统偏好回退统一由包实现。 */
export function readPwaMotionDuration(variable: PwaMotionDurationToken): number {
  return readDuration(variable, PWA_MOTION_FALLBACK_MS[variable]);
}
