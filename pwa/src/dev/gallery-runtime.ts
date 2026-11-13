import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";
import { PWA_MOTION_FALLBACK_MS, resolvePwaMotionDuration, type PwaMotionDurationToken } from "@/lib/ui/motion-duration";

/** 展厅专用颜色方案管理：只保存在内存，不写 localStorage。 */
export function createGalleryColorSchemeManager(): MantineColorSchemeManager {
  let value: MantineColorScheme = "light";
  return {
    get: () => value,
    set: (next) => { value = next; },
    // 仅供展厅使用，没有需要向 Mantine 回传的外部变化。
    subscribe: () => {},
    unsubscribe: () => {},
    clear: () => { value = "light"; },
  };
}

const DURATION_TOKENS = Object.keys(PWA_MOTION_FALLBACK_MS) as PwaMotionDurationToken[];

/**
 * 展厅慢放写在根元素上，脚本与 Mantine 读到同一组时长。
 * 只缩放时长，不改曲线、位移距离与业务时序；复制确认等业务时钟不参与缩放。
 * 每次先清除全部覆盖再按主题计算值重算；scale 为 1 时回到主题值。调用方在减少动态效果时传 1。
 */
export function applyGallerySlowMotion(scale: number) {
  const root = document.documentElement;
  for (const token of DURATION_TOKENS) root.style.removeProperty(token);
  if (scale === 1) return;
  const style = getComputedStyle(root);
  for (const token of DURATION_TOKENS) {
    const base = Number.parseFloat(resolvePwaMotionDuration(style, token));
    if (Number.isFinite(base)) root.style.setProperty(token, `${Math.round(base * scale)}ms`);
  }
}
