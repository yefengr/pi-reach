import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button, Portal } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { clearViewportDiagnostics, disableViewportDiagnostics, enableViewportDiagnostics, readViewportDiagnostics,
  viewportDiagnosticsEnabled } from "@/lib/pwa/timeline-viewport-diagnostics";
import { collectViewportDebugEnvironment, formatViewportDebugLines, formatViewportDebugReport, measureViewportEvent, measureViewportFrame,
  DOCUMENT_LOCK_BYPASS_ATTRIBUTE, ViewportFrameRecorder, type ViewportMarkKind } from "@/lib/pwa/viewport-debug";
import { hasTextFocus, observeKeyboardViewport } from "@/lib/pwa/use-keyboard-viewport";
import { version as pwaVersion } from "../../../package.json";
import "./viewport-debug-overlay.css";

type DebugStatus = "idle" | "copied" | "copyFailed" | "shareFailed";

function useFrameSampler(shellRef: RefObject<HTMLElement | null>, recorder: ViewportFrameRecorder, overlayRef: RefObject<HTMLElement | null>,
  textRef: RefObject<HTMLPreElement | null>, experimentButtonRef: RefObject<HTMLButtonElement | null>, closingRef: RefObject<boolean>) {
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      // 离开工作区会关闭并清空时间线诊断；浮层开启期间回到工作区后重新启用。
      if (!viewportDiagnosticsEnabled()) enableViewportDiagnostics();
      const shell = shellRef.current;
      if (!shell) return;
      const sample = recorder.record(measureViewportFrame(shell));
      // 复用采样时钟更新门禁，不为实验新增调度器或逐帧React渲染。
      if (experimentButtonRef.current) experimentButtonRef.current.disabled = hasTextFocus() || closingRef.current || sample.motion === "closing";
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
    const observedShell = shellRef.current;
    const stopDiagnostics = observedShell ? observeKeyboardViewport(observedShell, state => {
      closingRef.current = state.closing;
      recorder.mark("keyboard-update", measureViewportEvent(observedShell), state);
    }) : () => {};
    const handlers = listeners.map(([target, type, kind]) => {
      const handler = () => {
        const shell = shellRef.current;
        recorder.mark(kind, shell ? measureViewportEvent(shell) : undefined);
      };
      target?.addEventListener(type, handler, { passive: true });
      return () => target?.removeEventListener(type, handler);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      stopDiagnostics();
      for (const remove of handlers) remove();
      disableViewportDiagnostics();
    };
  }, [overlayRef, recorder, shellRef, textRef, experimentButtonRef, closingRef]);
}

/** 设置页开启后显示的真机调试浮层；不拦截页面点击，只有按钮可操作。 */
export function ViewportDebugOverlay({ shellRef }: { shellRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const experimentButtonRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const experimentHintId = useId();
  const [bypassed, setBypassed] = useState(false);
  const [recorder] = useState(() => new ViewportFrameRecorder(() => performance.now()));
  const [status, setStatus] = useState<DebugStatus>("idle");
  useFrameSampler(shellRef, recorder, overlayRef, textRef, experimentButtonRef, closingRef);

  const markExperiment = (kind: ViewportMarkKind) => {
    const shell = shellRef.current;
    // 测量失败也不能把按钮状态和实际CSS门控留在不同状态。
    try { recorder.mark(kind, shell ? measureViewportEvent(shell) : undefined); }
    catch { recorder.mark(kind); }
  };
  const toggleDocumentLock = () => {
    const overlay = overlayRef.current;
    if (!overlay || hasTextFocus() || closingRef.current || shellRef.current?.hasAttribute("data-keyboard-closing")) return;
    markExperiment("document-lock-before");
    // 同步改变唯一实验变量，after不能采到尚未提交的React旧DOM。
    const next = !overlay.hasAttribute(DOCUMENT_LOCK_BYPASS_ATTRIBUTE);
    overlay.toggleAttribute(DOCUMENT_LOCK_BYPASS_ATTRIBUTE, next);
    setBypassed(next);
    markExperiment("document-lock-after");
  };
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
    markExperiment("document-lock-state");
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
      <div className="pwa-viewport-debug-actions">
        <Button component="a" href="/app/keyboard-diagnostics" className="pwa-viewport-debug-experiment" fullWidth size="compact-xs" variant="default">{t.keyboardDiagnostics.entry}</Button>
      </div>
      <div className="pwa-viewport-debug-actions">
        {/* 实验按钮不通过pointer焦点转移收键盘；Enter/Space仍走原生button激活。 */}
        <Button ref={experimentButtonRef} className="pwa-viewport-debug-experiment" size="compact-xs" variant="default" type="button" fullWidth
          aria-pressed={bypassed} aria-describedby={experimentHintId}
          onPointerDown={event => event.preventDefault()} onClick={toggleDocumentLock}>{d.documentLockExperiment}</Button>
      </div>
      <p id={experimentHintId} className="pwa-viewport-debug-status">{bypassed ? d.documentLockPaused : d.documentLockNormal}<br />{d.documentLockHint}</p>
      <p className="pwa-viewport-debug-status" role="status">{status === "idle" ? "" : d[status]}</p>
    </section>
  </Portal>;
}
