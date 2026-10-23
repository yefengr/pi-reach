import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, Portal } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { clearViewportDiagnostics, disableViewportDiagnostics, enableViewportDiagnostics, readViewportDiagnostics,
  viewportDiagnosticsEnabled } from "@/lib/pwa/timeline-viewport-diagnostics";
import { collectViewportDebugEnvironment, formatViewportDebugLines, formatViewportDebugReport, measureViewportFrame,
  ViewportFrameRecorder, type ViewportMarkKind } from "@/lib/pwa/viewport-debug";
import { version as pwaVersion } from "../../../package.json";
import "./viewport-debug-overlay.css";

type DebugStatus = "idle" | "copied" | "copyFailed" | "shareFailed";

function useFrameSampler(shellRef: RefObject<HTMLElement | null>, recorder: ViewportFrameRecorder, overlayRef: RefObject<HTMLElement | null>,
  textRef: RefObject<HTMLPreElement | null>) {
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      // 离开工作区会关闭并清空时间线诊断；浮层开启期间回到工作区后重新启用。
      if (!viewportDiagnosticsEnabled()) enableViewportDiagnostics();
      const shell = shellRef.current;
      if (!shell) return;
      const sample = recorder.record(measureViewportFrame(shell));
      // 直接写文本节点，不触发 React 渲染，尽量不干扰被观测的帧。
      if (textRef.current) textRef.current.textContent = formatViewportDebugLines(sample).join("\n");
      // fixed 盒相对布局视口定位；键盘展开时 iOS 把布局视口推到屏幕上方，按 vvTop 平移才能留在可见区域。
      overlayRef.current?.style.setProperty("translate", `0 ${Math.max(0, sample.vvTop ?? 0)}px`);
    };
    frame = window.requestAnimationFrame(tick);
    const viewport = window.visualViewport;
    const listeners: [EventTarget | null, string, ViewportMarkKind][] = [
      [document, "focusin", "focusin"], [document, "focusout", "focusout"],
      [viewport, "resize", "vv-resize"], [viewport, "scroll", "vv-scroll"],
      [window, "scroll", "scroll"], [window, "resize", "resize"],
    ];
    const handlers = listeners.map(([target, type, kind]) => {
      const handler = () => recorder.mark(kind);
      target?.addEventListener(type, handler, { passive: true });
      return () => target?.removeEventListener(type, handler);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      for (const remove of handlers) remove();
      disableViewportDiagnostics();
    };
  }, [overlayRef, recorder, shellRef, textRef]);
}

/** 设置页开启后显示的真机调试浮层；不拦截页面点击，只有按钮可操作。 */
export function ViewportDebugOverlay({ shellRef }: { shellRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const [recorder] = useState(() => new ViewportFrameRecorder(() => performance.now()));
  const [status, setStatus] = useState<DebugStatus>("idle");
  useFrameSampler(shellRef, recorder, overlayRef, textRef);

  const report = () => formatViewportDebugReport({ ...recorder.snapshot(), timeline: readViewportDiagnostics(),
    environment: collectViewportDebugEnvironment(pwaVersion) });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setStatus("copied");
    } catch {
      setStatus("copyFailed");
    }
  };
  const file = () => new File([report()], `pi-reach-viewport-${Date.now()}.json`, { type: "application/json" });
  const canShareFiles = typeof navigator.canShare === "function";
  const share = async () => {
    const data = { files: [file()] };
    try {
      if (!navigator.canShare(data)) throw new Error("unsupported");
      await navigator.share(data);
      setStatus("idle");
    } catch (error) {
      // 用户关闭分享面板不算失败。
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "idle" : "shareFailed");
    }
  };
  const clear = () => {
    recorder.clear();
    clearViewportDiagnostics();
    setStatus("idle");
  };

  const d = t.viewportDebug;
  return <Portal>
    <section ref={overlayRef} className="pwa-viewport-debug" aria-label={d.label}>
      <pre ref={textRef} className="pwa-viewport-debug-text" />
      <div className="pwa-viewport-debug-actions">
        <Button size="compact-xs" variant="default" type="button" onClick={() => void copy()}>{d.copy}</Button>
        {canShareFiles ? <Button size="compact-xs" variant="default" type="button" onClick={() => void share()}>{d.share}</Button> : null}
        <Button size="compact-xs" variant="default" type="button" onClick={clear}>{d.clear}</Button>
      </div>
      <p className="pwa-viewport-debug-status" role="status">{status === "idle" ? "" : d[status]}</p>
    </section>
  </Portal>;
}
