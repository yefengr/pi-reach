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

/** 临界阻尼弹簧按终点归一化的 linear() 曲线；initial 为初速度（每毫秒完成的比例），可为负（先背离终点）。 */
function springEasing(initial: number, duration: number): string {
  const omega = (2 * Math.PI) / duration;
  const position = (time: number) => 1 - (1 + (omega - initial) * time) * Math.exp(-omega * time);
  const end = position(duration);
  const points = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => {
    if (index === SPRING_SAMPLES) return "1";
    return String(Number((position((index / SPRING_SAMPLES) * duration) / end).toFixed(3)));
  });
  return `linear(${points.join(", ")})`;
}

/**
 * 同一族弹簧在 fraction（已用时长 ÷ 体感时长）处完成的比例，按终点归一化，fraction ≥ 1 时为 1。
 * 供无法用 WAAPI 表达的逐帧运动（如滚动位置）取值，与内容曲线一致。
 */
export function pwaSpringProgress(fraction: number): number {
  if (!(fraction > 0)) return 0;
  if (fraction >= 1) return 1;
  const position = (value: number) => 1 - (1 + 2 * Math.PI * value) * Math.exp(-2 * Math.PI * value);
  return position(fraction) / position(1);
}

const supportedOr = (easing: string, fallback: string) => typeof CSS === "undefined" || CSS.supports("transition-timing-function", easing) ? easing : fallback;

/**
 * 松手收尾的弹簧曲线：临界阻尼、体感时长等于 duration，带入手指的初速度，按终点归一化后以 linear() 采样。
 * velocity 为朝向终点的进度速度（每毫秒完成的比例，即像素速度除以剩余距离）；上限取角频率，使曲线单调、不越过终点。
 * 没有初速度时与主题内容曲线相同；浏览器不支持 linear() 时回退到标准曲线。
 */
export function pwaReleaseEasing(element: Element, velocity: number, duration: number): string {
  if (!(velocity > 0) || !(duration > 0)) return pwaContentEasing(element);
  return supportedOr(springEasing(Math.min(velocity, (2 * Math.PI) / duration), duration), EASE_STANDARD_FALLBACK);
}

/**
 * 运动途中改换终点（如设置页滑入途中返回）：沿用当前速度接续，同一族弹簧。velocity 含义同 pwaReleaseEasing，
 * 但可为负：正背离新终点时先减速、越过起点一小段再折返，不在折返处停顿。room 为起点之后允许越过的距离
 * （占全程的比例），据此限制背离速度，使越过的部分不露出表面背后的空隙。
 */
export function pwaRedirectEasing(element: Element, velocity: number, duration: number, room: number): string {
  if (!(duration > 0) || !Number.isFinite(velocity) || velocity === 0) return pwaContentEasing(element);
  const omega = (2 * Math.PI) / duration;
  // 背离速度为 a·ω 时最远越过全程的 a² / (2(1 + a))；反解出 room 允许的 a。
  const bound = Number.isFinite(room) ? Math.max(0, room) + Math.sqrt(Math.max(0, room) ** 2 + 2 * Math.max(0, room)) : Infinity;
  const initial = Math.min(omega, Math.max(velocity, -bound * omega));
  return supportedOr(springEasing(initial, duration), EASE_STANDARD_FALLBACK);
}
