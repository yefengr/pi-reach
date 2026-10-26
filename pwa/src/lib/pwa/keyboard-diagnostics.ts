import { formatViewportDebugReport } from "./viewport-debug";

export const KEYBOARD_DIAGNOSTICS_MODES = ["current", "prefixed", "native", "content"] as const;
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
// 文档锁旁路是同模式下的配对变量；两组各自保留最近一轮，不互相覆盖。
export const KEYBOARD_DIAGNOSTICS_DOCUMENT_LOCKS = ["default", "bypassed"] as const;
export type KeyboardDiagnosticsDocumentLock = typeof KEYBOARD_DIAGNOSTICS_DOCUMENT_LOCKS[number];
/** 标题与数值行共用的旁路组短标记，窄屏不换行。 */
export const DOCUMENT_LOCK_BYPASS_SUFFIX = "+doc";
export const KEYBOARD_DIAGNOSTICS_REPORT_FORMAT = "pi-reach-keyboard-diagnostics/2";
type RoundKey = `${KeyboardDiagnosticsMode}:${KeyboardDiagnosticsDocumentLock}`;
/** 每个模式与文档锁组合只保留最近一轮；内部表格继续使用原格式和原容量。 */
export class KeyboardDiagnosticsReports {
  private rounds = new Map<RoundKey, string>();
  private active: { key: RoundKey; read: () => ReportInput } | null = null;
  start(mode: KeyboardDiagnosticsMode, read: () => ReportInput, documentLock: KeyboardDiagnosticsDocumentLock = "default"): () => void {
    const key: RoundKey = `${mode}:${documentLock}`;
    const active = { key, read };
    this.active = active;
    this.rounds.delete(key);
    return () => {
      this.rounds.set(key, formatViewportDebugReport(read()));
      if (this.active === active) this.active = null;
    };
  }
  report(): string {
    const rounds = new Map(this.rounds);
    if (this.active) rounds.set(this.active.key, formatViewportDebugReport(this.active.read()));
    const ordered = KEYBOARD_DIAGNOSTICS_MODES.flatMap(mode => KEYBOARD_DIAGNOSTICS_DOCUMENT_LOCKS
      .map(documentLock => ({ mode, documentLock, text: rounds.get(`${mode}:${documentLock}`) })));
    return JSON.stringify({ format: KEYBOARD_DIAGNOSTICS_REPORT_FORMAT, rounds: ordered.filter(round => round.text !== undefined)
      .map(({ mode, documentLock, text }) => ({ mode, documentLock, report: JSON.parse(text!) as unknown })) });
  }
}
