/**
 * 主布局唯一断点（DESIGN「断点」）：宽度 ≥ 768px 为桌面。媒体查询不能引用 CSS 变量，
 * 正式 CSS 写作 `max-width: 767.98px`，Mantine `sm` 为 48em；三处由 pwa-script-token-guard 对齐。
 */
export const MOBILE_LAYOUT_QUERY = "(max-width: 767.98px)";
export const DESKTOP_LAYOUT_QUERY = "(min-width: 768px)";
