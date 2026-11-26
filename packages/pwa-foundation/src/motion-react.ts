import { useEffect, useState } from "react";
import { PWA_REDUCED_MOTION_QUERY, pwaMotionFallback, readPwaMotionDuration, type PwaMotionVariable } from "./motion.js";

/** 首屏与 SSR 一致；effect 后才读取 CSS，媒体偏好变化无需等待下一次交互。 */
export function usePwaMotionDuration(variable: PwaMotionVariable, fallback?: number, root?: HTMLElement): number {
  const [duration, setDuration] = useState(() => pwaMotionFallback(variable, fallback));
  useEffect(() => {
    const view = root ? root.ownerDocument.defaultView : typeof window === "undefined" ? undefined : window;
    const update = () => setDuration(readPwaMotionDuration(variable, fallback, root));
    let media: MediaQueryList | undefined;
    try { media = view?.matchMedia?.(PWA_REDUCED_MOTION_QUERY); } catch { /* 无媒体查询时仍读取样式。 */ }
    update();
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, [variable, fallback, root]);
  return duration;
}
