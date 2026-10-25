import { useState } from "react";
import type { MantineColorSchemeManager } from "@mantine/core";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { KeyboardDiagnosticsReports, type KeyboardDiagnosticsMode } from "@/lib/pwa/keyboard-diagnostics";
import { KeyboardDiagnosticsStage, type InitialDiagnosticsDensity } from "./keyboard-diagnostics-stage";
import "@/app/workspace-viewport.css";
import "./keyboard-diagnostics.css";

// 明确受控，不访问或保存用户外观偏好。
const memoryColorScheme: MantineColorSchemeManager = { get: () => "light", set() {}, subscribe() {}, unsubscribe() {}, clear() {} };

export function KeyboardDiagnosticsPage() {
  const [experiment, setExperiment] = useState<{ mode: KeyboardDiagnosticsMode; density: InitialDiagnosticsDensity | null }>({ mode: "current", density: null });
  const { mode, density } = experiment;
  const [reports] = useState(() => new KeyboardDiagnosticsReports());
  return <PwaUiProvider colorSchemeManager={memoryColorScheme}>
    <KeyboardDiagnosticsStage key={mode} mode={mode} initialDensity={density}
      onMode={(next, nextDensity) => setExperiment({ mode: next, density: nextDensity })} reports={reports} />
  </PwaUiProvider>;
}
