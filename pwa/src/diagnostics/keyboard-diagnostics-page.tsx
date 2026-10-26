import { useState } from "react";
import type { MantineColorSchemeManager } from "@mantine/core";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { KeyboardDiagnosticsReports } from "@/lib/pwa/keyboard-diagnostics";
import { KeyboardDiagnosticsStage, type DiagnosticsExperiment, type InitialDiagnosticsDensity } from "./keyboard-diagnostics-stage";
import "@/app/workspace-viewport.css";
import "./keyboard-diagnostics.css";

// 明确受控，不访问或保存用户外观偏好。
const memoryColorScheme: MantineColorSchemeManager = { get: () => "light", set() {}, subscribe() {}, unsubscribe() {}, clear() {} };

export function KeyboardDiagnosticsPage() {
  const [experiment, setExperiment] = useState<DiagnosticsExperiment & { density: InitialDiagnosticsDensity | null }>(
    { mode: "current", documentLockBypass: false, density: null });
  const { mode, documentLockBypass, density } = experiment;
  const [reports] = useState(() => new KeyboardDiagnosticsReports());
  // 旁路组与默认组各自重挂载一轮，控制器、门控和采集器都不跨组复用。
  return <PwaUiProvider colorSchemeManager={memoryColorScheme}>
    <KeyboardDiagnosticsStage key={`${mode}:${documentLockBypass}`} mode={mode} documentLockBypass={documentLockBypass}
      initialDensity={density} onExperiment={(next, nextDensity) => setExperiment({ ...next, density: nextDensity })} reports={reports} />
  </PwaUiProvider>;
}
