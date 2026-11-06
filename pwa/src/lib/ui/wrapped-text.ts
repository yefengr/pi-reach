/** 正文内容高度超过行高的这一倍数即视为换行，容纳取整与字体度量误差。 */
const WRAP_LINE_RATIO = 1.5;

/** 正文是否超过一行；按内容高度判断，不含正文自身的上下内边距。 */
export function textWraps(text: HTMLElement): boolean {
  const style = getComputedStyle(text);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return false;
  const content = text.clientHeight - Number.parseFloat(style.paddingTop || "0") - Number.parseFloat(style.paddingBottom || "0");
  return content > lineHeight * WRAP_LINE_RATIO;
}

/**
 * 观察浮动卡片（Toast、局部错误）的正文：换行时在所属卡片上设置 data-multiline，圆角由 CSS 从 Toast 圆角改为 16（ADR-20261105）。
 * 卡片整体高度受关闭按钮与内边距影响，单行与两行可能只差 1px，因此只看正文。返回值可直接作为 React ref 回调的清理函数。
 */
export function observeWrappedText(text: HTMLElement, cardSelector: string): () => void {
  const card = text.closest<HTMLElement>(cardSelector);
  if (!card || typeof ResizeObserver === "undefined") return () => {};
  const update = () => card.toggleAttribute("data-multiline", textWraps(text));
  const observer = new ResizeObserver(update);
  observer.observe(text);
  return () => {
    observer.disconnect();
    card.removeAttribute("data-multiline");
  };
}
