import { Portal } from "@mantine/core";
import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { PwaOperationNotifications, PwaToastProvider } from "@/components/pwa/pwa-operation-notifications";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { useKeyboardViewport } from "@/lib/pwa/use-keyboard-viewport";
import "@/app/workspace-viewport.css";

type PwaRuntimeNoticeContextValue = {
  target: HTMLElement | null;
  setWorkspaceTarget: (target: HTMLElement | null) => void;
};

const PwaRuntimeNoticeContext = createContext<PwaRuntimeNoticeContextValue | null>(null);

export function PwaRuntimeNoticeSlot() {
  const id = useId();
  const context = useContext(PwaRuntimeNoticeContext);
  const setWorkspaceTarget = context?.setWorkspaceTarget;
  const setSlot = useCallback((target: HTMLDivElement | null) => {
    setWorkspaceTarget?.(target);
  }, [setWorkspaceTarget]);

  return <div id={id} ref={setSlot} className="pwa-runtime-notice-slot" />;
}

export function PwaRuntimeNoticePortal({ children }: { children: ReactNode }) {
  const target = useContext(PwaRuntimeNoticeContext)?.target;
  // Mantine 的 target 变化只更新 ref，切换展示目标时需重建 Portal。
  return target ? <Portal key={target.id} target={target}>{children}</Portal> : children;
}

/** 通知占用独立布局空间，不能覆盖会话输入区。 */
export function PwaAppShell({ children, runtimeNotice }: { children: ReactNode; runtimeNotice: ReactNode }) {
  const shellRef = useRef<HTMLDivElement>(null);
  useKeyboardViewport(shellRef);
  const fallbackId = useId();
  const [fallbackTarget, setFallbackTarget] = useState<HTMLDivElement | null>(null);
  const [toastFallbackTarget, setToastFallbackTarget] = useState<HTMLDivElement | null>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState<HTMLElement | null>(null);
  const [notifications] = useState(createOperationNotificationController);
  const registerWorkspaceTarget = useCallback((target: HTMLElement | null) => {
    setWorkspaceTarget((current) => current === target ? current : target);
  }, []);
  const context = useMemo(() => ({
    target: workspaceTarget ?? fallbackTarget,
    setWorkspaceTarget: registerWorkspaceTarget,
  }), [fallbackTarget, registerWorkspaceTarget, workspaceTarget]);

  const toastTarget = workspaceTarget?.closest<HTMLElement>(".pwa-root")
    ?? fallbackTarget?.parentElement?.querySelector<HTMLElement>(".pwa-root")
    ?? toastFallbackTarget;
  return <PwaToastProvider value={notifications}><PwaRuntimeNoticeContext.Provider value={context}>
    <div ref={shellRef} className="pwa-app-shell">
      <div id={fallbackId} ref={setFallbackTarget} className="pwa-runtime-notice-fallback">
        {/* 启动及故障态没有工作区根节点，单槽 Toast 仍须有可定位的展示目标。 */}
        <div ref={setToastFallbackTarget} className="pwa-toast-fallback-root" style={{ width: "100%", height: 0, minHeight: 0, position: "relative", overflow: "visible" }} />
      </div>
      {children}{runtimeNotice}
      <PwaOperationNotifications controller={notifications} target={toastTarget} />
    </div>
  </PwaRuntimeNoticeContext.Provider></PwaToastProvider>;
}
