/**
 * 发送跟随、折叠与时间线交接等机制测试按固定时钟断言中间帧：固定内容层时长与曲线，
 * 使规范取值调整不牵动机制断言。真实取值由主题守卫与各文件中使用主题值的专门用例覆盖。
 * 只在 no-preference 下生效，减少动态效果时仍取主题的统一短时长。
 */
const PINNED_MOTION: Record<string, string> = {
  "--pwa-duration-message-in": "160ms",
  "--pwa-duration-collapse-in": "180ms",
  "--pwa-duration-collapse-out": "140ms",
  "--pwa-duration-collapse-settle": "320ms",
  "--pwa-ease-content": "cubic-bezier(0.2, 0, 0, 1)",
  "--pwa-ease-settle": "cubic-bezier(0.4, 0, 0.2, 1)",
};
const STYLE_ID = "pwa-test-mechanism-motion";

export function pinMechanismMotion(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  const declarations = Object.entries(PINNED_MOTION).map(([token, value]) => `${token}: ${value};`).join(" ");
  // 追加在主题之后，同等特异性下覆盖 :root 的取值。
  style.textContent = `@media (prefers-reduced-motion: no-preference) { :root { ${declarations} } }`;
  document.head.append(style);
}

export function unpinMechanismMotion(): void {
  document.getElementById(STYLE_ID)?.remove();
}
