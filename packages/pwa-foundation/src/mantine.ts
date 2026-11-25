import { useEffect, useMemo, useState } from "react";
import { createPwaTheme } from "./mantine-theme.js";
export { createPwaTheme, pwaCssVariablesResolver, PWA_DIALOG_SIZE, PWA_CONFIRM_DIALOG_SIZE, pwaModalTransition } from "./mantine-theme.js";

const FALLBACK = [400, 200] as const;
const REDUCED_FALLBACK = 120;
const QUERY = "(prefers-reduced-motion: reduce)";
const TOKENS = ["--pwa-duration-modal-in", "--pwa-duration-modal-out"] as const;

/** 仅解析本批 Modal 时长及其档位引用，不建立通用动效框架。 */
function readDuration(style: CSSStyleDeclaration, token: string, fallback: number): number {
  let value = style.getPropertyValue(token).trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const reference = /^var\((--pwa-(?:duration|tier)-[\w-]+)\)$/.exec(value);
    if (!reference) break;
    value = style.getPropertyValue(reference[1]).trim();
  }
  if (!/^\d+(?:\.\d+)?(?:ms|s)$/.test(value)) return fallback;
  const duration = Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return Number.isFinite(duration) ? duration : fallback;
}

/** 首次 SSR/水合使用一致回退；挂载后读取 CSS，并监听系统偏好。 */
export function usePwaTheme() {
  const [durations, setDurations] = useState<readonly number[]>(FALLBACK);
  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    const update = () => {
      const style = getComputedStyle(document.documentElement);
      const next = TOKENS.map((token, index) => readDuration(style, token, media?.matches ? REDUCED_FALLBACK : FALLBACK[index]));
      setDurations((previous) => previous.every((value, index) => value === next[index]) ? previous : next);
    };
    update();
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);
  return useMemo(() => createPwaTheme(durations[0], durations[1]), [durations]);
}
