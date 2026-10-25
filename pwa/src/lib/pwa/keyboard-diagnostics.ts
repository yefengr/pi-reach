import { formatViewportDebugReport } from "./viewport-debug";

export const KEYBOARD_DIAGNOSTICS_MODES = ["current", "prefixed", "native"] as const;
export type KeyboardDiagnosticsMode = typeof KEYBOARD_DIAGNOSTICS_MODES[number];
export type DiagnosticsGeometry = { width: number; height: number; viewportHeight: number | null; viewportTop: number | null; scale: number | null; orientation: number };
export type DiagnosticsGateInput = DiagnosticsGeometry & { focused: boolean; compensated: boolean; closing: boolean };
export type DiagnosticsGateReason = "ready" | "focus" | "controller" | "viewport" | "restart";
export class KeyboardDiagnosticsGate {
  private invalidated = false;
  private readonly initial: DiagnosticsGeometry | null;
  private closedGeometry: Readonly<DiagnosticsGeometry> | null = null;
  private naturalHeight = 0;
  get baseline(): Readonly<DiagnosticsGeometry> | null { return this.closedGeometry; }
  constructor(initial: DiagnosticsGateInput | null, naturalHeight = initial?.height ?? 0) {
    this.initial = initial ? { ...initial } : null;
    if (initial) this.check(initial, naturalHeight);
  }
  check(input: DiagnosticsGateInput, naturalHeight = input.height): DiagnosticsGateReason {
    if (!this.initial) return "viewport";
    // 无效尺寸不是旋转证据；能力恢复后绑定首个可观测值，仍不允许更换已知宽度/方向。
    if (!Number.isFinite(this.initial.width) || this.initial.width <= 0) this.initial.width = input.width;
    if (!Number.isFinite(this.initial.orientation)) this.initial.orientation = input.orientation;
    // 标定前也绑定首次可观测的宽度/方向；高度变化可能只是键盘，不永久失效。
    if ((Number.isFinite(input.width) && input.width > 0 && Math.abs(input.width - this.initial.width) > 1)
      || (Number.isFinite(input.orientation) && input.orientation !== this.initial.orientation)) this.invalidated = true;
    if (this.invalidated) return "restart";
    const baseline = this.closedGeometry;
    if (!baseline) {
      // 保留观测到的自然高度下限，补偿或键盘压短 shell 时不能向下重学。
      for (const height of [input.height, naturalHeight]) {
        if (Number.isFinite(height) && height > this.naturalHeight) this.naturalHeight = height;
      }
    }
    if (!validGeometry(input)) return "viewport";
    if (input.focused) return "focus";
    if (input.compensated || input.closing) return "controller";
    if (!baseline) {
      if (input.height < this.naturalHeight - 1 || input.viewportHeight! < this.naturalHeight - 1) return "viewport";
      // 仅 pending 可首次建立；一旦建立，本实例始终以这一份闭合几何复核。
      this.closedGeometry = Object.freeze({ ...input });
      return "ready";
    }
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
