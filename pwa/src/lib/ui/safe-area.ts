import { useEffect, useMemo, useState } from "react";

/** Mantine 浮层 shift 中间件的默认视口留白；安全区更大时以安全区为准，不相加。 */
const FLOATING_EDGE_GAP = 5;

export type SafeAreaInsets = { top: number; right: number; bottom: number; left: number };

const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * 读取 `--pwa-safe-*` 的实际像素值。自定义属性的计算值不会展开 `env()`，
 * 因此借一个不可见探针元素的内边距解析。
 */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === "undefined" || !document.body) return NO_INSETS;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;"
    + "padding:var(--pwa-safe-top) var(--pwa-safe-right) var(--pwa-safe-bottom) var(--pwa-safe-left)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

/**
 * Popover 与 Menu 不贴屏幕边缘：与边缘的距离取 Mantine 默认留白与安全区中的较大值。
 * 旋转屏幕或窗口尺寸变化时重新读取。
 */
export function useFloatingSafeMiddlewares() {
  const [insets, setInsets] = useState(readSafeAreaInsets);
  useEffect(() => {
    const update = () => setInsets((current) => {
      const next = readSafeAreaInsets();
      return next.top === current.top && next.right === current.right && next.bottom === current.bottom && next.left === current.left ? current : next;
    });
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return useMemo(() => ({
    shift: {
      padding: {
        top: Math.max(FLOATING_EDGE_GAP, insets.top),
        right: Math.max(FLOATING_EDGE_GAP, insets.right),
        bottom: Math.max(FLOATING_EDGE_GAP, insets.bottom),
        left: Math.max(FLOATING_EDGE_GAP, insets.left),
      },
    },
  }), [insets]);
}
