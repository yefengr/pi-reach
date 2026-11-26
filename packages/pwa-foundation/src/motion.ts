export const PWA_MOTION_FALLBACK_MS = {
  "--pwa-duration-modal-in": 400,
  "--pwa-duration-modal-out": 200,
  "--pwa-duration-drawer": 360,
  "--pwa-duration-drawer-out": 280,
  "--pwa-duration-collapse-in": 400,
  "--pwa-duration-collapse-out": 280,
  "--pwa-duration-collapse-settle": 280,
  "--pwa-duration-menu-in": 240,
  "--pwa-duration-menu-out": 160,
  "--pwa-duration-menu-resize": 280,
  "--pwa-duration-menu-view": 200,
  "--pwa-duration-press-in": 90,
  "--pwa-duration-press-out": 240,
  "--pwa-duration-fade": 120,
  "--pwa-duration-reduced": 120,
  "--pwa-duration-feedback": 160,
  "--pwa-duration-toggle": 280,
  "--pwa-duration-toggle-track": 200,
  "--pwa-duration-appearance": 320,
  "--pwa-duration-content": 320,
} as const;

export type PwaMotionDurationToken = keyof typeof PWA_MOTION_FALLBACK_MS;
export type PwaMotionVariable = `--pwa-duration-${string}`;
export const PWA_REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** 自定义属性在部分环境仍含 var()；限制深度，循环或缺失引用交给读取器回退。 */
export function resolvePwaMotionDuration(style: CSSStyleDeclaration, variable: string): string {
  let value = style.getPropertyValue(variable).trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const reference = /^var\((--pwa-(?:duration|tier)-[\w-]+)\)$/.exec(value);
    if (!reference) break;
    value = style.getPropertyValue(reference[1]).trim();
  }
  return value;
}

export function pwaMotionFallback(variable: PwaMotionVariable, fallback?: number): number {
  if (fallback !== undefined && Number.isFinite(fallback) && fallback >= 0) return fallback;
  return Object.hasOwn(PWA_MOTION_FALLBACK_MS, variable)
    ? PWA_MOTION_FALLBACK_MS[variable as PwaMotionDurationToken] : 0;
}

export function readPwaMotionDuration(variable: PwaMotionVariable, fallback?: number, root?: HTMLElement): number {
  const ordinary = pwaMotionFallback(variable, fallback);
  const target = root ?? (typeof document === "undefined" ? undefined : document.documentElement);
  if (!target) return ordinary;
  const view = target.ownerDocument?.defaultView;
  // 显式 root 不能误读宿主窗口的样式或媒体偏好。
  const browser = root ? view : view ?? (typeof window === "undefined" ? undefined : window);
  let reduced = false;
  try { reduced = browser?.matchMedia?.(PWA_REDUCED_MOTION_QUERY).matches ?? false; } catch { /* 媒体查询不可用时保留普通回退。 */ }
  const missing = reduced ? PWA_MOTION_FALLBACK_MS["--pwa-duration-reduced"] : ordinary;
  try {
    const style = browser?.getComputedStyle ? browser.getComputedStyle(target)
      : !root && typeof getComputedStyle === "function" ? getComputedStyle(target) : undefined;
    if (!style) return missing;
    const value = resolvePwaMotionDuration(style, variable);
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/.test(value)) return missing;
    const duration = Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
    return Number.isFinite(duration) ? duration : missing;
  } catch { return missing; }
}

const EASE_FALLBACK = "cubic-bezier(0.2, 0, 0, 1)";
function readProperty(element: Element, variable: string): string {
  try { return element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(variable).trim() ?? ""; }
  catch { return ""; }
}
export function pwaStandardEasing(element: Element): string {
  return readProperty(element, "--pwa-ease-standard") || EASE_FALLBACK;
}
export function pwaContentEasing(element: Element): string {
  const value = readProperty(element, "--pwa-ease-content");
  const css = element.ownerDocument.defaultView?.CSS;
  return value && (!css || css.supports("transition-timing-function", value)) ? value : EASE_FALLBACK;
}
export function pwaMotionShiftDisabled(element: Element): boolean {
  return readProperty(element, "--pwa-motion-shift") === "0";
}
