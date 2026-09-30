import { useMemo } from "react";
import { localStorageColorSchemeManager, MantineProvider } from "@mantine/core";
import { LucideProvider } from "lucide-react";
import { PwaAppearanceProvider } from "@/components/pwa/pwa-appearance";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";
import { usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { createPiReachTheme, piReachCssVariablesResolver } from "@/lib/ui/pi-reach-theme";

const appearanceManager = localStorageColorSchemeManager({ key: APPEARANCE_STORAGE_KEY });

export function PwaUiProvider({ children }: { children: React.ReactNode }) {
  const modalIn = usePwaMotionDuration("--pwa-duration-modal-in", 180);
  const modalOut = usePwaMotionDuration("--pwa-duration-modal-out", 140);
  const theme = useMemo(() => createPiReachTheme(modalIn, modalOut), [modalIn, modalOut]);
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={piReachCssVariablesResolver}
      colorSchemeManager={appearanceManager}
      defaultColorScheme="auto"
    >
      <PwaAppearanceProvider>
        {/* Lucide 线宽 1.8（相对 24 画布），全应用一致。 */}
        <LucideProvider strokeWidth={1.8}>
          <div className="pwa-ui-scope">{children}</div>
        </LucideProvider>
      </PwaAppearanceProvider>
    </MantineProvider>
  );
}
