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
    const elapsed = this.now() - this.start;
    this.entries.push(Object.freeze({ time: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0, reason, following, paused, unread,
      mode, generation, top, bottom, requested, actual, ...geometry }));
    if (this.entries.length > CAPACITY) this.entries.splice(0, this.entries.length - CAPACITY);
  }
}

const diagnostics = new ViewportDiagnostics(() => performance.now());
const control = Object.freeze({
  enable: () => diagnostics.enable(), disable: () => diagnostics.disable(),
  read: () => diagnostics.read(), clear: () => diagnostics.clear(),
});

export function installViewportDiagnostics(): () => void {
  window.__PI_REACH_VIEWPORT__ = control;
  return () => { diagnostics.disable(); };
}
export function viewportDiagnosticsEnabled(): boolean { return diagnostics.isEnabled(); }
/** 供设置页的视口调试浮层使用，与控制台入口共享同一份内存记录。 */
export function enableViewportDiagnostics(): void { diagnostics.enable(); }
export function disableViewportDiagnostics(): void { diagnostics.disable(); }
export function readViewportDiagnostics(): readonly ViewportDiagnosticEntry[] { return diagnostics.read(); }
export function recordViewportDiagnostic(entry: ViewportTrace, sample?: () => ViewportDiagnosticGeometry | null): void {
  diagnostics.record(entry, sample);
}
export function clearViewportDiagnostics(): void { diagnostics.clear(); }
