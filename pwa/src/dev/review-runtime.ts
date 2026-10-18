import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";

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
const DURATION_TOKENS = [
  "--pwa-duration-sidebar",
  "--pwa-duration-page",
  "--pwa-duration-drawer",
  "--pwa-duration-modal-in",
  "--pwa-duration-modal-out",
  "--pwa-duration-expand-in",
  "--pwa-duration-expand-out",
  "--pwa-duration-collapse-in",
  "--pwa-duration-collapse-out",
  "--pwa-duration-image-in",
  "--pwa-duration-image-out",
  "--pwa-duration-toast",
  "--pwa-duration-fade",
  "--pwa-duration-press-in",
  "--pwa-duration-press-out",
  "--pwa-duration-menu-in",
  "--pwa-duration-menu-out",
  "--pwa-duration-feedback",
  "--pwa-duration-content",
] as const;

const baseValues = new Map<string, string>();

/** 解析可能是指向另一个时长 token 的引用，与 usePwaMotionDuration 的取值方式一致。 */
function resolveDuration(style: CSSStyleDeclaration, token: string): string {
  let value = style.getPropertyValue(token).trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const reference = /^var\((--pwa-duration-[\w-]+)\)$/.exec(value);
    if (!reference) break;
    value = style.getPropertyValue(reference[1]).trim();
  }
  return value;
}

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
    if (!baseValues.has(token)) baseValues.set(token, resolveDuration(style, token));
    const base = Number.parseFloat(baseValues.get(token) ?? "");
    if (!Number.isFinite(base)) continue;
    root.style.setProperty(token, `${Math.round(base * scale)}ms`);
  }
}
