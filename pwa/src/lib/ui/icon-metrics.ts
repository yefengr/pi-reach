/**
 * Lucide 图标的实际线宽（px），经 LucideProvider 以 absoluteStrokeWidth 注入：各尺寸画出同样粗细，
 * 不随图标缩小而变细（DESIGN「基础层」图标）。pwa-theme.css 的 --pwa-icon-*-stroke 按它换算，由守卫校验。
 */
export const ICON_STROKE_WIDTH = 1.5;

/**
 * 按钮内与 600 字重文字并排的行内图标的实际线宽（px）：图标与相邻文字的轻重一致。
 * 只由 pwa-theme.css 的 --pwa-icon-inline-stroke-strong 换算使用，由守卫校验。
 */
export const ICON_STROKE_WIDTH_STRONG = 2;

/** 与元数据字号的状态文字同行的运行中旋转图标。 */
export const SMALL_SPINNER_SIZE = 12;
