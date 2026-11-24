import { useEffect, useMemo, useState } from "react";

/** 浮层 shift 中间件的默认视口留白；安全区更大时以安全区为准，不相加。 */
const FLOATING_EDGE_GAP = 5;

export type SafeAreaInsets = { top: number; right: number; bottom: number; left: number };

const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function parsePx(value: string): number {
  return Number.parseFloat(value) || 0;
}

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
    top: parsePx(style.paddingTop),
    right: parsePx(style.paddingRight),
    bottom: parsePx(style.paddingBottom),
    left: parsePx(style.paddingLeft),
  };
  probe.remove();
  return insets;
}

/** 四边与边缘的距离各取默认留白与安全区中的较大值，不相加。 */
export function floatingShiftPadding(insets: SafeAreaInsets): SafeAreaInsets {
  return {
    top: Math.max(FLOATING_EDGE_GAP, insets.top),
    right: Math.max(FLOATING_EDGE_GAP, insets.right),
    bottom: Math.max(FLOATING_EDGE_GAP, insets.bottom),
    left: Math.max(FLOATING_EDGE_GAP, insets.left),
  };
}

export function insetsEqual(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * Popover、Menu 与 Combobox 不贴屏幕边缘：与边缘的距离取默认留白与安全区中的较大值。
 * 旋转屏幕或窗口尺寸变化时重新读取；值未变化时保留原对象，避免重复渲染。
 */
export function useFloatingSafeMiddlewares() {
  const [insets, setInsets] = useState<SafeAreaInsets>(readSafeAreaInsets);
  useEffect(() => {
    const update = () => setInsets((current) => {
      const next = readSafeAreaInsets();
      return insetsEqual(next, current) ? current : next;
    });
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return useMemo(() => ({ shift: { padding: floatingShiftPadding(insets) } }), [insets]);
}
