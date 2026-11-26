import type { MantineTransition } from "@mantine/core";
import { usePwaMotionDuration } from "./motion-react.js";

export const pwaFadeTransition = {
  in: { opacity: 1, transitionTimingFunction: "var(--pwa-ease-enter)" },
  out: { opacity: 0, pointerEvents: "none", transitionTimingFunction: "var(--pwa-ease-exit)" },
  transitionProperty: "opacity",
} as MantineTransition;

export const pwaMenuTransition = {
  in: { opacity: 1, transform: "scale(1)", transitionTimingFunction: "var(--pwa-ease-content)" },
  out: {
    opacity: 0,
    transform: "scale(calc(1 - (1 - var(--pwa-menu-scale)) * var(--pwa-motion-shift, 1)))",
    pointerEvents: "none",
    transitionTimingFunction: "var(--pwa-ease-exit)",
  },
  transitionProperty: "opacity, transform",
} as MantineTransition;

const drawerSlide = (axis: "X" | "Y", sign: "" | "-"): MantineTransition => ({
  in: { opacity: 1, transform: `translate${axis}(0)` },
  out: { opacity: "var(--pwa-motion-shift, 1)", transform: `translate${axis}(calc(${sign}100% * var(--pwa-motion-shift, 1)))` },
  transitionProperty: "transform, opacity",
} as MantineTransition);

export const pwaDrawerTransitions = {
  left: drawerSlide("X", "-"),
  right: drawerSlide("X", ""),
  top: drawerSlide("Y", "-"),
  bottom: drawerSlide("Y", ""),
} satisfies Record<"left" | "right" | "top" | "bottom", MantineTransition>;
export const PWA_DRAWER_EASE = "var(--pwa-ease-content)";

export function usePwaMenuTransition() {
  const duration = usePwaMotionDuration("--pwa-duration-menu-in");
  const exitDuration = usePwaMotionDuration("--pwa-duration-menu-out");
  return { transition: pwaMenuTransition, duration, exitDuration };
}

export function usePwaDrawerTransition(position: keyof typeof pwaDrawerTransitions) {
  const duration = usePwaMotionDuration("--pwa-duration-drawer");
  const exitDuration = usePwaMotionDuration("--pwa-duration-drawer-out");
  return { transition: pwaDrawerTransitions[position], duration, exitDuration, timingFunction: PWA_DRAWER_EASE };
}
