import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMantineColorScheme, type MantineColorScheme } from "@mantine/core";

export type PwaAppearance = "system" | "light" | "dark";

type PwaAppearanceContextValue = {
  appearance: PwaAppearance;
  setAppearance: (appearance: PwaAppearance) => void;
};

const PwaAppearanceContext = createContext<PwaAppearanceContextValue | null>(null);

function toAppearance(colorScheme: MantineColorScheme): PwaAppearance {
  return colorScheme === "auto" ? "system" : colorScheme;
}

// 浏览器主题色跟随 bg token（浅色 #F8F9F8、深色 #202325）。
const LIGHT_THEME_COLOR = "#F8F9F8";
const DARK_THEME_COLOR = "#202325";

function themeColorFor(appearance: PwaAppearance): string {
  if (appearance === "light") return LIGHT_THEME_COLOR;
  if (appearance === "dark") return DARK_THEME_COLOR;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

function syncDocumentAppearance(appearance: PwaAppearance) {
  document.documentElement.dataset.pwaAppearance = appearance;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = themeColorFor(appearance);
}

export function PwaAppearanceProvider({ children }: { children: ReactNode }) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [manualAppearance, setManualAppearance] = useState<PwaAppearance | null>(null);
  const appearance = manualAppearance ?? toAppearance(colorScheme);

  useEffect(() => {
    syncDocumentAppearance(appearance);
    if (appearance !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncDocumentAppearance("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [appearance]);

  const setAppearance = useCallback((nextAppearance: PwaAppearance) => {
    setManualAppearance(nextAppearance);
    setColorScheme(nextAppearance === "system" ? "auto" : nextAppearance);
  }, [setColorScheme]);

  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
  return <PwaAppearanceContext.Provider value={value}>{children}</PwaAppearanceContext.Provider>;
}

export function usePwaAppearance(): PwaAppearanceContextValue {
  const value = useContext(PwaAppearanceContext);
  if (!value) throw new Error("usePwaAppearance must be used within PwaAppearanceProvider");
  return value;
}
