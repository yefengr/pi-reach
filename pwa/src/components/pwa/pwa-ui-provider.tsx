import { useMemo } from "react";
import { localStorageColorSchemeManager, MantineProvider, type MantineColorSchemeManager } from "@mantine/core";
import { LucideProvider } from "lucide-react";
import { PwaAppearanceProvider } from "@/components/pwa/pwa-appearance";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";
import { usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { usePwaPressFeedback } from "@/components/pwa/use-pwa-press-feedback";
import { usePwaAnimationVisibility } from "@/components/pwa/use-pwa-animation-visibility";
import { createPiReachTheme, piReachCssVariablesResolver } from "@/lib/ui/pi-reach-theme";

const appearanceManager = localStorageColorSchemeManager({ key: APPEARANCE_STORAGE_KEY });

export function PwaUiProvider({ children, colorSchemeManager = appearanceManager }: { children: React.ReactNode; colorSchemeManager?: MantineColorSchemeManager }) {
  const pressScopeRef = usePwaPressFeedback();
  usePwaAnimationVisibility(pressScopeRef);
  const modalIn = usePwaMotionDuration("--pwa-duration-modal-in", 180);
  const modalOut = usePwaMotionDuration("--pwa-duration-modal-out", 140);
  const theme = useMemo(() => createPiReachTheme(modalIn, modalOut), [modalIn, modalOut]);
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={piReachCssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      <PwaAppearanceProvider>
        {/* Lucide 线宽 1.8（相对 24 画布），全应用一致。 */}
        <LucideProvider strokeWidth={1.8}>
          <div ref={pressScopeRef} className="pwa-ui-scope">{children}</div>
        </LucideProvider>
      </PwaAppearanceProvider>
    </MantineProvider>
  );
}
