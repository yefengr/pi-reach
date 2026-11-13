import { useMemo } from "react";
import { localStorageColorSchemeManager, MantineProvider, type MantineColorSchemeManager } from "@mantine/core";
import { LucideProvider } from "lucide-react";
import { PwaAppearanceProvider } from "@/components/pwa/pwa-appearance";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";
import { ICON_STROKE_WIDTH } from "@/lib/ui/icon-metrics";
import { usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { usePwaPressFeedback } from "@/components/pwa/use-pwa-press-feedback";
import { usePwaAnimationVisibility } from "@/components/pwa/use-pwa-animation-visibility";
import { useOutsideTapGuard } from "@/components/pwa/use-outside-tap-guard";
import { createPiReachTheme, piReachCssVariablesResolver } from "@/lib/ui/pi-reach-theme";

const appearanceManager = localStorageColorSchemeManager({ key: APPEARANCE_STORAGE_KEY });

export function PwaUiProvider({ children, colorSchemeManager = appearanceManager }: { children: React.ReactNode; colorSchemeManager?: MantineColorSchemeManager }) {
  const pressScopeRef = usePwaPressFeedback();
  usePwaAnimationVisibility(pressScopeRef);
  useOutsideTapGuard();
  const modalIn = usePwaMotionDuration("--pwa-duration-modal-in");
  const modalOut = usePwaMotionDuration("--pwa-duration-modal-out");
  const theme = useMemo(() => createPiReachTheme(modalIn, modalOut), [modalIn, modalOut]);
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={piReachCssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      <PwaAppearanceProvider>
        <LucideProvider strokeWidth={ICON_STROKE_WIDTH} absoluteStrokeWidth>
          <div ref={pressScopeRef} className="pwa-ui-scope">{children}</div>
        </LucideProvider>
      </PwaAppearanceProvider>
    </MantineProvider>
  );
}
