import { formatViewportDebugReport } from "./viewport-debug";

export const KEYBOARD_DIAGNOSTICS_MODES = ["current", "prefixed", "native"] as const;
export type KeyboardDiagnosticsMode = typeof KEYBOARD_DIAGNOSTICS_MODES[number];
export type DiagnosticsGeometry = { width: number; height: number; viewportHeight: number | null; viewportTop: number | null; scale: number | null; orientation: number };
export type DiagnosticsGateInput = DiagnosticsGeometry & { focused: boolean; compensated: boolean; closing: boolean };
export type DiagnosticsGateReason = "ready" | "focus" | "controller" | "viewport" | "restart";
export class KeyboardDiagnosticsGate {
  private invalidated = false;
  readonly baseline: DiagnosticsGeometry | null;
  constructor(baseline: DiagnosticsGeometry | null) { this.baseline = baseline ? { ...baseline } : null; }
  check(input: DiagnosticsGateInput): DiagnosticsGateReason {
    const baseline = this.baseline;
    // 键盘也会改变布局视口高度；只有宽度或方向变化使本轮基准永久失效。
    if (baseline && (Math.abs(input.width - baseline.width) > 1 || input.orientation !== baseline.orientation)) this.invalidated = true;
    if (this.invalidated) return "restart";
    if (!baseline || !validGeometry(input) || !validGeometry(baseline)) return "viewport";
    if (input.focused) return "focus";
    if (input.compensated || input.closing) return "controller";
    if (Math.abs(input.height - baseline.height) > 1 || Math.abs(input.viewportHeight! - baseline.viewportHeight!) > 1
      || Math.abs(input.viewportTop! - baseline.viewportTop!) > 1) return "viewport";
    return "ready";
  }
}

export function validGeometry(value: DiagnosticsGeometry): boolean {
  return [value.width, value.height, value.viewportHeight, value.viewportTop, value.scale, value.orientation]
    .every(number => typeof number === "number" && Number.isFinite(number))
    && value.width > 0 && value.height > 0 && value.viewportHeight! > 0 && value.viewportTop! >= 0 && Math.abs(value.scale! - 1) <= 0.01;
}

type ReportInput = Parameters<typeof formatViewportDebugReport>[0];
/** 每个模式只保留最近一轮；内部表格继续使用原格式和原容量。 */
export class KeyboardDiagnosticsReports {
  private rounds = new Map<KeyboardDiagnosticsMode, string>();
  private active: { mode: KeyboardDiagnosticsMode; read: () => ReportInput } | null = null;
  start(mode: KeyboardDiagnosticsMode, read: () => ReportInput): () => void {
    const active = { mode, read };
    this.active = active;
    this.rounds.delete(mode);
    return () => {
      this.rounds.set(mode, formatViewportDebugReport(read()));
      if (this.active === active) this.active = null;
    };
  }
  report(): string {
    const rounds = new Map(this.rounds);
    if (this.active) rounds.set(this.active.mode, formatViewportDebugReport(this.active.read()));
    return JSON.stringify({ format: "pi-reach-keyboard-diagnostics/1", rounds: KEYBOARD_DIAGNOSTICS_MODES
      .filter(mode => rounds.has(mode)).map(mode => ({ mode, report: JSON.parse(rounds.get(mode)!) as unknown })) });
  }
}
