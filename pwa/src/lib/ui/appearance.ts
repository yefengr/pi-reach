// 保持为纯模块，供首屏脚本与客户端使用同一组外观配置。
export const APPEARANCE_STORAGE_KEY = "pi-reach-appearance";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

// 浏览器主题色无法引用 CSS 变量，由主题守卫校验与 bg token 一致。
export const LIGHT_THEME_COLOR = "#FFFFFF";
export const DARK_THEME_COLOR = "#1E1E1E";
