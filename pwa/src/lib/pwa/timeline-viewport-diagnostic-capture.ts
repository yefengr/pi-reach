import type { ViewportTrace } from "./timeline-viewport-coordinator";
import type { ViewportDiagnosticControl, ViewportDiagnosticEntry, ViewportDiagnosticGeometry } from "./timeline-viewport-diagnostics";

export const CAPTURE_CAPACITY = 256;
export const CAPTURE_DURATION_MS = 1500;
export const CAPTURE_WAIT_MS = 60_000;
export type CapturePhase = "off" | "armed" | "recording" | "complete" | "cancelled" | "timeout";
export type CaptureStop = "duration" | "capacity";
export type CaptureMetadata = Readonly<{
  appVersion: string; entryResource: string | null; standalone: boolean;
  displayMode: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  dpr: number | null; reducedMotion: boolean;
}>;
export type CaptureReport = Readonly<{
  formatVersion: 1; stopReason: CaptureStop; metadata: CaptureMetadata;
  clock: "entry-ms-since-send; callback-and-motion-ms-performance-origin-not-paint";
  entries: readonly ViewportDiagnosticEntry[];
}>;
export type CaptureState = Readonly<{ phase: CapturePhase; report: CaptureReport | null }>;
interface CaptureCollector extends ViewportDiagnosticControl {
  record(entry: ViewportTrace, sample?: () => ViewportDiagnosticGeometry | null): void;
}
export interface CaptureTimer {
  set(run: () => void, ms: number): number;
  clear(id: number): void;
}

/** 只在阶段交接通知；armed 仅等待有效 send，不测量、不积累旧记录。 */
export class ViewportDiagnosticCapture {
  private state: CaptureState = Object.freeze({ phase: "off", report: null });
  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private epoch = 0;
  private count = 0;
  private metadata: CaptureMetadata | null = null;
  constructor(private readonly collector: CaptureCollector, private readonly timers: CaptureTimer) {}
  getSnapshot = (): CaptureState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  pending() { return this.state.phase === "armed" || this.state.phase === "recording"; }
  arm(metadata: CaptureMetadata) {
    this.release();
    this.collector.disable();
    // 按白名单重建，调用方附带的对象/字符串不能进入报告。
    this.metadata = Object.freeze({
      appVersion: typeof metadata.appVersion === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.appVersion) ? metadata.appVersion : "unknown",
      entryResource: typeof metadata.entryResource === "string" && /^index-[a-zA-Z0-9_-]+\.js$/.test(metadata.entryResource) ? metadata.entryResource : null,
      standalone: metadata.standalone === true,
      displayMode: (["standalone", "fullscreen", "minimal-ui", "browser"] as const).includes(metadata.displayMode) ? metadata.displayMode : "browser",
      dpr: typeof metadata.dpr === "number" && Number.isFinite(metadata.dpr) ? metadata.dpr : null,
      reducedMotion: metadata.reducedMotion === true,
    });
    this.count = 0;
    this.change("armed");
    this.wait(CAPTURE_WAIT_MS, () => this.stop("timeout"));
  }
  record(entry: ViewportTrace, sample?: () => ViewportDiagnosticGeometry | null) {
    if (this.state.phase === "armed") {
      if (entry.reason !== "send") return;
      this.release();
      this.collector.enable();
      this.change("recording");
      this.wait(CAPTURE_DURATION_MS, () => this.finish("duration"));
    }
    if (this.state.phase !== "recording") return;
    this.collector.record(entry, sample);
    this.count += 1;
    if (this.count >= CAPTURE_CAPACITY) this.finish("capacity");
  }
  cancel = () => this.stop("cancelled");
  clear = () => this.stop("off");
  /** 生命周期退出不销毁已冻结报告，也不在已关闭后再次启用 sampler。 */
  terminate() { if (this.pending()) this.stop("cancelled"); }
  private finish(stopReason: CaptureStop) {
    if (this.state.phase !== "recording" || !this.metadata) return;
    const report: CaptureReport = Object.freeze({ formatVersion: 1, stopReason, metadata: this.metadata,
      clock: "entry-ms-since-send; callback-and-motion-ms-performance-origin-not-paint", entries: this.collector.read() });
    this.release();
    this.collector.disable();
    this.change("complete", report);
  }
  private stop(phase: "off" | "cancelled" | "timeout") {
    this.release();
    this.collector.disable();
    this.metadata = null;
    this.change(phase);
  }
  private change(phase: CapturePhase, report: CaptureReport | null = null) {
    this.state = Object.freeze({ phase, report });
    this.listeners.forEach((listener) => listener());
  }
  private release() {
    this.epoch += 1;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
  private wait(ms: number, run: () => void) {
    const epoch = this.epoch;
    this.timer = this.timers.set(() => { if (epoch === this.epoch) run(); }, ms);
  }
}

/** 只返回主入口 basename；不导出路径、域名、query 或其他资源。 */
export function readCaptureMetadata(appVersion: string): CaptureMetadata {
  const modes = ["standalone", "fullscreen", "minimal-ui"] as const;
  const displayMode = modes.find((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) ?? "browser";
  const standalone = displayMode === "standalone" || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const candidates = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    .map((script) => script.getAttribute("src")?.match(/(?:^|\/)index-([a-zA-Z0-9_-]+)\.js$/)?.[1]).filter(Boolean);
  return { appVersion, entryResource: candidates.length === 1 ? `index-${candidates[0]}.js` : null,
    standalone, displayMode, dpr: Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : null,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches };
}
