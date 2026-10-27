/** WAAPI 的 easing 不接受 var()，读取标准曲线的计算值；读取失败回退到同值常量。 */
const EASE_STANDARD_FALLBACK = "cubic-bezier(0.2, 0, 0, 1)";
export function pwaStandardEasing(element: Element): string {
  return getComputedStyle(element).getPropertyValue("--pwa-ease-standard").trim() || EASE_STANDARD_FALLBACK;
}

/** 减少动态效果时 --pwa-motion-shift 为 0：面板位移消失，只剩淡化，跟手拖动没有意义。 */
export function pwaMotionShiftDisabled(element: Element): boolean {
  return getComputedStyle(element).getPropertyValue("--pwa-motion-shift").trim() === "0";
}
