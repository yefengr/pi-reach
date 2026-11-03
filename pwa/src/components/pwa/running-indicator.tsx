import "./running-indicator.css";

type RunningIndicatorSize = "compact" | "default";

/**
 * 最小运行点：16px 固定占位，只有内点呼吸透明度。
 * 传入 label 时作为带说明的状态图标（侧栏行）；不传时保持装饰角色，沿用父级 role="status"（Working）。
 */
export function RunningIndicator({ size = "default", label }: { size?: RunningIndicatorSize; label?: string }) {
  return <span
    className={`pwa-running-indicator pwa-running-indicator-${size}`}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : "true"}
    title={label}
  ><span className="pwa-running-indicator-dot" aria-hidden="true" /></span>;
}
