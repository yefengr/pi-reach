import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";
import { PWA_MOTION_FALLBACK_MS, resolvePwaMotionDuration, type PwaMotionDurationToken } from "@/lib/ui/motion-duration";

/** 评审页专用颜色方案管理：只保存在内存，不写 localStorage。 */
export function createReviewColorSchemeManager(): MantineColorSchemeManager {
  let value: MantineColorScheme = "light";
  return {
    get: () => value,
    set: (next) => { value = next; },
    // 仅供评审页使用，没有需要向 Mantine 回传的外部变化。
    subscribe: () => {},
    unsubscribe: () => {},
    clear: () => { value = "light"; },
  };
}

/**
 * 慢放只缩放动画时长 token，不改曲线、位移距离与业务时序。
 * 历史对照的完成态停留与复制确认等业务时钟不参与缩放。
 */
const DURATION_TOKENS = Object.keys(PWA_MOTION_FALLBACK_MS) as PwaMotionDurationToken[];
const baseValues = new Map<string, string>();

/** scale 为 1 时移除内联覆盖，回到主题值。 */
export function applyReviewSlowMotion(scale: number) {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  for (const token of DURATION_TOKENS) {
    if (scale === 1) {
      root.style.removeProperty(token);
      baseValues.delete(token);
      continue;
    }
    if (!baseValues.has(token)) baseValues.set(token, resolvePwaMotionDuration(style, token));
    const base = Number.parseFloat(baseValues.get(token) ?? "");
    if (!Number.isFinite(base)) continue;
    root.style.setProperty(token, `${Math.round(base * scale)}ms`);
  }
}
