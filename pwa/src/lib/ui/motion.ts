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

/** 与主题内容曲线相同的采样密度：33 个等距采样点。 */
const SPRING_SAMPLES = 32;

/**
 * 松手收尾的弹簧曲线：临界阻尼、体感时长等于 duration，带入手指的初速度，按终点归一化后以 linear() 采样。
 * velocity 为朝向终点的进度速度（每毫秒完成的比例，即像素速度除以剩余距离）；上限取角频率，使曲线单调、不越过终点。
 * 没有初速度时与主题内容曲线相同；浏览器不支持 linear() 时回退到标准曲线。
 */
export function pwaReleaseEasing(element: Element, velocity: number, duration: number): string {
  if (!(velocity > 0) || !(duration > 0)) return pwaContentEasing(element);
  const omega = (2 * Math.PI) / duration;
  const initial = Math.min(velocity, omega);
  const position = (time: number) => 1 - (1 + (omega - initial) * time) * Math.exp(-omega * time);
  const end = position(duration);
  const points = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => {
    if (index === SPRING_SAMPLES) return "1";
    return String(Number((position((index / SPRING_SAMPLES) * duration) / end).toFixed(3)));
  });
  const easing = `linear(${points.join(", ")})`;
  return typeof CSS === "undefined" || CSS.supports("transition-timing-function", easing) ? easing : EASE_STANDARD_FALLBACK;
}
