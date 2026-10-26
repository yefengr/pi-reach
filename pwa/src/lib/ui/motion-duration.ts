/**
 * 读取 `--pwa-duration-*` 的计算值（毫秒）。getPropertyValue 对自定义属性返回原始 var(...)，
 * 须沿 token 引用解析；减少动态效果时由全局媒体查询改写的 token 同样生效。读取失败返回回退值。
 */
export function readPwaMotionDuration(variable: `--pwa-duration-${string}`, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const style = getComputedStyle(document.documentElement);
  let value = style.getPropertyValue(variable).trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const reference = /^var\((--pwa-duration-[\w-]+)\)$/.exec(value);
    if (!reference) break;
    value = style.getPropertyValue(reference[1]).trim();
  }
  const duration = Number.parseFloat(value);
  return value.endsWith("ms") && Number.isFinite(duration) ? duration : fallback;
}
