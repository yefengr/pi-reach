/**
 * 毫秒时长 token 的回退值，与 pwa-theme.css 常规动效下的取值一致（pwa-script-token-guard 校验）。
 * 只在读不到计算样式（无 DOM、样式未加载）时使用；调用点不另写数值。循环动画的秒级 token 不经脚本读取。
 */
export const PWA_MOTION_FALLBACK_MS = {
  "--pwa-duration-sidebar": 220,
  "--pwa-duration-page": 200,
  "--pwa-duration-drawer": 200,
  "--pwa-duration-modal-in": 180,
  "--pwa-duration-modal-out": 140,
  "--pwa-duration-status-slot": 160,
  "--pwa-duration-collapse-in": 180,
  "--pwa-duration-collapse-out": 140,
  "--pwa-duration-image-in": 260,
  "--pwa-duration-image-out": 220,
  "--pwa-duration-toast": 180,
  "--pwa-duration-fade": 120,
  "--pwa-duration-message-in": 160,
  "--pwa-duration-press-in": 90,
  "--pwa-duration-press-out": 120,
  "--pwa-duration-menu-in": 160,
  "--pwa-duration-menu-out": 120,
  "--pwa-duration-feedback": 120,
  "--pwa-duration-content": 240,
  "--pwa-duration-reduced": 120,
} as const;

export type PwaMotionDurationToken = keyof typeof PWA_MOTION_FALLBACK_MS;

/**
 * 时长 token 的原始计算值。getPropertyValue 对自定义属性返回原始 var(...)，须沿 token 引用解析；
 * 减少动态效果时由全局媒体查询改写的 token 同样生效。
 */
export function resolvePwaMotionDuration(style: CSSStyleDeclaration, variable: PwaMotionDurationToken): string {
  let value = style.getPropertyValue(variable).trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const reference = /^var\((--pwa-duration-[\w-]+)\)$/.exec(value);
    if (!reference) break;
    value = style.getPropertyValue(reference[1]).trim();
  }
  return value;
}

/** 读取 `--pwa-duration-*` 的计算值（毫秒）；读取失败返回同名回退值。 */
export function readPwaMotionDuration(variable: PwaMotionDurationToken): number {
  const fallback = PWA_MOTION_FALLBACK_MS[variable];
  if (typeof document === "undefined") return fallback;
  const value = resolvePwaMotionDuration(getComputedStyle(document.documentElement), variable);
  const duration = Number.parseFloat(value);
  return value.endsWith("ms") && Number.isFinite(duration) ? duration : fallback;
}
