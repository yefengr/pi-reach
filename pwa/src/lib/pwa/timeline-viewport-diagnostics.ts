import { ViewportDiagnosticCapture } from "./timeline-viewport-diagnostic-capture";
import { VIEWPORT_MODES, VIEWPORT_REASONS, type ViewportTrace } from "./timeline-viewport-coordinator";

const CAPACITY = 256;
const GEOMETRY_FIELDS = ["listClientHeight", "listClientWidth", "listScrollHeight", "listScrollWidth", "listTop", "listHeight",
  "inputTop", "inputHeight", "footerTop", "footerHeight", "visualViewportHeight", "visualViewportWidth",
  "visualViewportOffsetTop", "visualViewportOffsetLeft", "visualViewportScale"] as const;
export type ViewportDiagnosticGeometry = { [K in typeof GEOMETRY_FIELDS[number]]: number | null };
export type ViewportDiagnosticEntry = Readonly<ViewportTrace & ViewportDiagnosticGeometry & { time: number }>;
export interface ViewportDiagnosticControl {
  enable(): void;
  disable(): void;
  read(): readonly ViewportDiagnosticEntry[];
  clear(): void;
}

declare global {
  interface Window { __PI_REACH_VIEWPORT__?: ViewportDiagnosticControl }
}

/** 固定枚举与有限数字白名单；额外字段和运行态对象不能进入内存记录。 */
export class ViewportDiagnostics implements ViewportDiagnosticControl {
  private enabled = false;
  private start = 0;
  private entries: ViewportDiagnosticEntry[] = [];
  constructor(private readonly now: () => number) {}
  isEnabled() { return this.enabled; }
  enable() { this.enabled = true; this.clear(); }
  disable() { this.enabled = false; this.clear(); }
  clear() { this.entries = []; this.start = this.now(); }
  read() { return Object.freeze(this.entries.map((entry) => Object.freeze({ ...entry }))); }
  record(entry: ViewportTrace, sample?: () => ViewportDiagnosticGeometry | null) {
    if (!this.enabled) return;
    const { reason, following, paused, unread, mode, generation, top, bottom, requested, actual } = entry;
    if (!VIEWPORT_REASONS.includes(reason) || !VIEWPORT_MODES.includes(mode) ||
        typeof following !== "boolean" || typeof paused !== "boolean" ||
        ![unread, generation, top, bottom, actual].every((value) => typeof value === "number" && Number.isFinite(value)) ||
        (requested !== null && (typeof requested !== "number" || !Number.isFinite(requested)))) return;
    // 测量回调只在显式启用时执行；平铺数字保证 read() 没有可变引用泄漏。
    const measured = sample?.();
    const geometry = {} as ViewportDiagnosticGeometry;
    for (const key of GEOMETRY_FIELDS) {
      const value = measured?.[key];
      geometry[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    const passive = {} as Record<"effectiveTarget" | "callbackTime" | "motionTime", number | null>;
    for (const key of ["effectiveTarget", "callbackTime", "motionTime"] as const) {
      const value = entry[key];
      passive[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    const elapsed = this.now() - this.start;
    this.entries.push(Object.freeze({ ...passive, time: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0, reason, following, paused, unread,
      mode, generation, top, bottom, requested, actual, ...geometry }));
    if (this.entries.length > CAPACITY) this.entries.splice(0, this.entries.length - CAPACITY);
  }
}

const diagnostics = new ViewportDiagnostics(() => performance.now());
export const viewportDiagnosticCapture = new ViewportDiagnosticCapture(diagnostics, {
  set: (run, ms) => window.setTimeout(run, ms), clear: (id) => window.clearTimeout(id),
});
const control = Object.freeze({
  enable: () => { viewportDiagnosticCapture.terminate(); diagnostics.enable(); },
  disable: () => { viewportDiagnosticCapture.terminate(); diagnostics.disable(); },
  read: () => diagnostics.read(),
  clear: () => { viewportDiagnosticCapture.terminate(); diagnostics.clear(); },
});

export function installViewportDiagnostics(): () => void {
  window.__PI_REACH_VIEWPORT__ = control;
  return () => { viewportDiagnosticCapture.terminate(); diagnostics.disable(); };
}
export function viewportDiagnosticsEnabled(): boolean { return diagnostics.isEnabled() || viewportDiagnosticCapture.pending(); }
/** armed 只接收发送信号，不能因此为回看分支增加布局读取。 */
export function viewportDiagnosticSamplingEnabled(): boolean { return diagnostics.isEnabled(); }
export function recordViewportDiagnostic(entry: ViewportTrace, sample?: () => ViewportDiagnosticGeometry | null): void {
  if (entry.reason === "reset" || entry.reason === "bind" || entry.reason === "hidden") viewportDiagnosticCapture.terminate();
  if (viewportDiagnosticCapture.pending()) viewportDiagnosticCapture.record(entry, sample);
  else diagnostics.record(entry, sample);
}
export function clearViewportDiagnostics(): void { viewportDiagnosticCapture.terminate(); diagnostics.clear(); }
