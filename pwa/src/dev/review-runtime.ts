import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";
import { PWA_MOTION_FALLBACK_MS, resolvePwaMotionDuration, type PwaMotionDurationToken } from "@/lib/ui/motion-duration";
import { REVIEW_EASE_VARIABLES, REVIEW_MOTION_PRESETS, REVIEW_SHIFT_TOKENS, type ReviewMotionPresetId } from "./review-motion-presets";

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

const DURATION_TOKENS = Object.keys(PWA_MOTION_FALLBACK_MS) as PwaMotionDurationToken[];
const MANAGED_PROPERTIES = [...DURATION_TOKENS, ...REVIEW_SHIFT_TOKENS, ...REVIEW_EASE_VARIABLES];

/**
 * 评审页的动效覆盖写在根元素上，脚本与 Mantine 读到同一组值。
 * 慢放只缩放时长，不改曲线、位移距离与业务时序；历史对照的完成态停留与复制确认等业务时钟不参与缩放。
 * 对比参数在主题时长之上替换「内容与空间变化」的时长、位移与范围内曲线。
 * 每次先清除全部覆盖再按主题计算值重算；默认参数且不慢放时回到主题值。调用方在减少动态效果时传默认值。
 */
export function applyReviewMotion({ scale = 1, preset = "current" }: { scale?: number; preset?: ReviewMotionPresetId }) {
  const root = document.documentElement;
  for (const property of MANAGED_PROPERTIES) root.style.removeProperty(property);
  delete root.dataset.reviewMotion;
  const values = preset === "current" ? null : REVIEW_MOTION_PRESETS[preset];
  if (scale === 1 && !values) return;
  const style = getComputedStyle(root);
  for (const token of DURATION_TOKENS) {
    const override = values?.durations[token];
    if (scale === 1 && override === undefined) continue;
    const base = override ?? Number.parseFloat(resolvePwaMotionDuration(style, token));
    if (!Number.isFinite(base)) continue;
    root.style.setProperty(token, `${Math.round(base * scale)}ms`);
  }
  if (!values) return;
  for (const token of REVIEW_SHIFT_TOKENS) root.style.setProperty(token, `${values.shifts[token]}px`);
  root.style.setProperty("--review-ease-enter", values.easeEnter);
  root.style.setProperty("--review-ease-standard", values.easeStandard);
  root.dataset.reviewMotion = preset;
}

/** scale 为 1 时移除内联覆盖，回到主题值。 */
export function applyReviewSlowMotion(scale: number) {
  applyReviewMotion({ scale });
}
