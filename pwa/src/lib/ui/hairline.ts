/** 根元素标记：浏览器实际画得出 0.5px 边框时存在，主题据此切换发丝线宽度与较深的分隔色（DESIGN「边框与分隔」）。 */
export const HAIRLINE_ATTRIBUTE = "data-pwa-hairline";
/** 跨过 2 倍密度的屏幕切换会改变检测结果；1 倍屏画不出半个物理像素。 */
const HIGH_DENSITY_QUERY = "(min-resolution: 2dppx)";

/**
 * 只能实测，不能按设备像素比推断：WebKit 在高分屏把 0.5px 边框画成 1 个物理像素，
 * Chromium 则仍画成 1 个 CSS 像素。探针只有上边框，排版高度就是实际线宽。
 */
export function detectHairline(root: HTMLElement = document.documentElement): boolean {
  const probe = document.createElement("div");
  probe.style.cssText = "position: absolute; visibility: hidden; box-sizing: content-box; height: 0; border-top: 0.5px solid transparent";
  (document.body ?? root).append(probe);
  const supported = probe.getBoundingClientRect().height < 1;
  probe.remove();
  root.toggleAttribute(HAIRLINE_ATTRIBUTE, supported);
  return supported;
}

/** 首屏渲染前检测一次，避免先按 1px 绘制再变细；窗口移到不同密度的屏幕时重新检测。 */
export function installHairlineDetection(): void {
  detectHairline();
  window.matchMedia?.(HIGH_DENSITY_QUERY).addEventListener("change", () => detectHairline());
}
