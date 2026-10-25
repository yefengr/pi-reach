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
  controllerRef: RefObject<HTMLDivElement | null>, textRef: RefObject<HTMLPreElement | null>, reports: KeyboardDiagnosticsReports) {
  const gateRef = useRef<KeyboardDiagnosticsGate | null>(null);
  const closingRef = useRef(false);
  const [reason, setReason] = useState<DiagnosticsGateReason>("viewport");
  const check = useCallback((): DiagnosticsGateReason => {
    const controller = controllerRef.current;
    const gate = gateRef.current;
    return gate?.check({ ...geometry(), compensated: Boolean(controller?.hasAttribute("data-keyboard-viewport")),
      closing: closingRef.current || Boolean(controller?.hasAttribute("data-keyboard-closing")) },
    gate.baseline ? undefined : shellRef.current?.getBoundingClientRect().height) ?? "viewport";
  }, [controllerRef, shellRef]);

  useEffect(() => {
    const shell = shellRef.current;
    const controller = controllerRef.current;
    if (!shell || !controller) return;
    // 几何按真实所有权组合；不改变 report/1 的列或共享测量器。
    const pixels = (value: number) => Math.round(value * 10) / 10;
    const eventSnapshot = () => {
      const sample = measureViewportEvent(controller);
      return shell === controller ? sample : { ...sample, shellHeight: pixels(shell.getBoundingClientRect().height) };
    };
    const frameSnapshot = () => {
      const sample = measureViewportFrame(controller);
      if (shell === controller) return sample;
      const outer = shell.getBoundingClientRect();
      const title = shell.querySelector(".pwa-title-bar");
      return { ...sample, shellTop: pixels(outer.top), shellHeight: pixels(outer.height),
        titleTop: title ? pixels(title.getBoundingClientRect().top) : null };
    };
    closingRef.current = false;
    // 初始压缩只进入等待；由现有 refresh 在完整安全恢复后首次标定，不重学已建立基准。
    gateRef.current = new KeyboardDiagnosticsGate({ ...geometry(), compensated: controller.hasAttribute("data-keyboard-viewport"),
      closing: controller.hasAttribute("data-keyboard-closing") }, shell.getBoundingClientRect().height);
    const recorder = new ViewportFrameRecorder(() => performance.now());
    let timeline = readViewportDiagnostics();
    enableViewportDiagnostics();
    const finish = reports.start(mode, () => ({ ...recorder.snapshot(), timeline,
      environment: { ...collectViewportDebugEnvironment(version), mode,
        shellScope: "outer-shell", controllerScope: mode === "content" ? "content-viewport" : "outer-shell", titleScope: "outer-shell" } }));
    let previousReason: DiagnosticsGateReason | null = null;
    const refresh = () => {
      const next = check();
      if (previousReason === next) return;
      previousReason = next;
      setReason(next);
    };
    const mark = (kind: ViewportMarkKind) => { recorder.mark(kind, eventSnapshot()); refresh(); };
    const stop = mode === "native" ? () => {} : observeKeyboardViewport(controller, state => {
      closingRef.current = state.closing;
      recorder.mark("keyboard-update", eventSnapshot(), state);
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
      const sample = recorder.record(frameSnapshot());
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
  }, [check, controllerRef, mode, reports, shellRef, textRef]);
  return { reason, check };
}
