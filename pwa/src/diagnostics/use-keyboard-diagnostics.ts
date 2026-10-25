import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { hasTextFocus, observeKeyboardViewport } from "@/lib/pwa/use-keyboard-viewport";
import { collectViewportDebugEnvironment, formatViewportDebugLines, measureViewportEvent, measureViewportFrame, ViewportFrameRecorder, type ViewportMarkKind } from "@/lib/pwa/viewport-debug";
import { disableViewportDiagnostics, enableViewportDiagnostics, readViewportDiagnostics } from "@/lib/pwa/timeline-viewport-diagnostics";
import { KeyboardDiagnosticsGate, type DiagnosticsGateInput, type DiagnosticsGateReason, type KeyboardDiagnosticsMode, type KeyboardDiagnosticsReports } from "@/lib/pwa/keyboard-diagnostics";
import { version } from "../../package.json";

function geometry(): DiagnosticsGateInput {
  const viewport = window.visualViewport;
  return { width: window.innerWidth, height: window.innerHeight, viewportHeight: viewport?.height ?? null,
    viewportTop: viewport?.offsetTop ?? null, scale: viewport?.scale ?? null, orientation: window.screen.orientation?.angle ?? 0,
    focused: hasTextFocus(), compensated: false, closing: false };
}

export function useKeyboardDiagnostics(mode: KeyboardDiagnosticsMode, shellRef: RefObject<HTMLDivElement | null>,
  textRef: RefObject<HTMLPreElement | null>, reports: KeyboardDiagnosticsReports) {
  const gateRef = useRef<KeyboardDiagnosticsGate | null>(null);
  const closingRef = useRef(false);
  const [reason, setReason] = useState<DiagnosticsGateReason>("viewport");
  const check = useCallback((): DiagnosticsGateReason => {
    const shell = shellRef.current;
    const gate = gateRef.current;
    return gate?.check({ ...geometry(), compensated: Boolean(shell?.hasAttribute("data-keyboard-viewport")),
      closing: closingRef.current || Boolean(shell?.hasAttribute("data-keyboard-closing")) },
    gate.baseline ? undefined : shell?.getBoundingClientRect().height) ?? "viewport";
  }, [shellRef]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    closingRef.current = false;
    // 初始压缩只进入等待；由现有 refresh 在完整安全恢复后首次标定，不重学已建立基准。
    gateRef.current = new KeyboardDiagnosticsGate({ ...geometry(), compensated: shell.hasAttribute("data-keyboard-viewport"),
      closing: shell.hasAttribute("data-keyboard-closing") }, shell.getBoundingClientRect().height);
    const recorder = new ViewportFrameRecorder(() => performance.now());
    let timeline = readViewportDiagnostics();
    enableViewportDiagnostics();
    const finish = reports.start(mode, () => ({ ...recorder.snapshot(), timeline,
      environment: { ...collectViewportDebugEnvironment(version), mode } }));
    let previousReason: DiagnosticsGateReason | null = null;
    const refresh = () => {
      const next = check();
      if (previousReason === next) return;
      previousReason = next;
      setReason(next);
    };
    const mark = (kind: ViewportMarkKind) => { recorder.mark(kind, measureViewportEvent(shell)); refresh(); };
    const stop = mode === "native" ? () => {} : observeKeyboardViewport(shell, state => {
      closingRef.current = state.closing;
      recorder.mark("keyboard-update", measureViewportEvent(shell), state);
      refresh();
    });
    const listeners: [EventTarget | null, string, ViewportMarkKind][] = [
      [document, "focusin", "focusin"], [document, "focusout", "focusout"],
      [window.visualViewport, "resize", "vv-resize"], [window.visualViewport, "scroll", "vv-scroll"],
      [window, "resize", "resize"], [window, "scroll", "scroll"],
    ];
    const removers = listeners.map(([target, name, kind]) => {
      const listener = () => mark(kind);
      target?.addEventListener(name, listener, { passive: true });
      return () => target?.removeEventListener(name, listener);
    });
    let frame = 0;
    const tick = () => {
      const sample = recorder.record(measureViewportFrame(shell));
      timeline = readViewportDiagnostics();
      if (textRef.current) textRef.current.textContent = `${mode} ${formatViewportDebugLines(sample).join(" | ")}`;
      refresh();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      for (const remove of removers) remove();
      stop();
      finish();
      disableViewportDiagnostics();
      gateRef.current = null;
    };
  }, [check, mode, reports, shellRef, textRef]);
  return { reason, check };
}
