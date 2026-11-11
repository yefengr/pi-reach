import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useMantineColorScheme, type MantineColorScheme } from "@mantine/core";
import { DARK_SCHEME_QUERY, DARK_THEME_COLOR, LIGHT_THEME_COLOR } from "@/lib/ui/appearance";

export type PwaAppearance = "system" | "light" | "dark";

type PwaAppearanceContextValue = {
  appearance: PwaAppearance;
  setAppearance: (appearance: PwaAppearance) => void;
};

const PwaAppearanceContext = createContext<PwaAppearanceContextValue | null>(null);

function toAppearance(colorScheme: MantineColorScheme): PwaAppearance {
  return colorScheme === "auto" ? "system" : colorScheme;
}

function themeColorFor(appearance: PwaAppearance): string {
  if (appearance === "light") return LIGHT_THEME_COLOR;
  if (appearance === "dark") return DARK_THEME_COLOR;
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

function syncDocumentAppearance(appearance: PwaAppearance) {
  document.documentElement.dataset.pwaAppearance = appearance;
  const color = themeColorFor(appearance);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = color;
  });
}

export function PwaAppearanceProvider({ children }: { children: ReactNode }) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [manualAppearance, setManualAppearance] = useState<PwaAppearance | null>(null);
  const appearance = manualAppearance ?? toAppearance(colorScheme);

  useEffect(() => {
    syncDocumentAppearance(appearance);
    if (appearance !== "system") return;

    const media = window.matchMedia(DARK_SCHEME_QUERY);
    const onChange = () => syncDocumentAppearance("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [appearance]);

  const setAppearance = useCallback((nextAppearance: PwaAppearance) => {
    const apply = () => {
      setManualAppearance(nextAppearance);
      setColorScheme(nextAppearance === "system" ? "auto" : nextAppearance);
    };
    // 手动切换外观时整屏交叉淡化（时长 appearance）：快照新旧两帧，期间页面不响应交互，只用于这类低频整屏切换。
    // 浏览器不支持或页面不可见时直接切换；回调内同步提交，让新快照取到切换后的样式。
    if (typeof document.startViewTransition !== "function" || document.visibilityState !== "visible") { apply(); return; }
    document.startViewTransition(() => flushSync(apply));
  }, [setColorScheme]);

  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
  return <PwaAppearanceContext.Provider value={value}>{children}</PwaAppearanceContext.Provider>;
}

export function usePwaAppearance(): PwaAppearanceContextValue {
  const value = useContext(PwaAppearanceContext);
  if (!value) throw new Error("usePwaAppearance must be used within PwaAppearanceProvider");
  return value;
}
