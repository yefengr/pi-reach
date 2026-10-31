/** WAAPI 的 easing 不接受 var()，读取标准曲线的计算值；读取失败回退到同值常量。 */
const EASE_STANDARD_FALLBACK = "cubic-bezier(0.2, 0, 0, 1)";
export function pwaStandardEasing(element: Element): string {
  return getComputedStyle(element).getPropertyValue("--pwa-ease-standard").trim() || EASE_STANDARD_FALLBACK;
}

/**
 * 内容与空间变化的曲线（发送跟随、图片几何、流式与会话内容淡入）。
 * 弹簧以 linear() 表达；不支持的浏览器在 WAAPI 中会直接抛错，因此读取失败或不支持时回退到减速曲线。
 */
const EASE_CONTENT_FALLBACK = "cubic-bezier(0.2, 0, 0, 1)";
export function pwaContentEasing(element: Element): string {
  const value = getComputedStyle(element).getPropertyValue("--pwa-ease-content").trim();
  if (!value) return EASE_CONTENT_FALLBACK;
  return typeof CSS === "undefined" || CSS.supports("transition-timing-function", value) ? value : EASE_CONTENT_FALLBACK;
}

/** 减少动态效果时 --pwa-motion-shift 为 0：面板位移消失，只剩淡化，跟手拖动没有意义。 */
export function pwaMotionShiftDisabled(element: Element): boolean {
  return getComputedStyle(element).getPropertyValue("--pwa-motion-shift").trim() === "0";
}
