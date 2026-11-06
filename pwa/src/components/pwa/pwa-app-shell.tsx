import { Portal } from "@mantine/core";
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PwaOperationNotifications, PwaToastProvider } from "@/components/pwa/pwa-operation-notifications";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { useViewportDensity } from "@/lib/pwa/use-viewport-density";
import { useSoftKeyboard } from "@/lib/pwa/use-soft-keyboard";
import "@/app/workspace-viewport.css";

type PwaRuntimeNoticeContextValue = {
  target: HTMLElement | null;
  /** 登记一个工作区展示位置，返回撤销函数；多个位置同时存在时取最后登记的一个。 */
  registerWorkspaceTarget: (target: HTMLElement) => () => void;
};

const PwaRuntimeNoticeContext = createContext<PwaRuntimeNoticeContextValue | null>(null);

/**
 * 浏览器能力提示的工作区展示位置，位于导航底部（ADR-20261105）。桌面侧栏与移动导航各有一个：
 * 移动导航打开时后登记，提示移入其中；关闭后回到侧栏位置（移动布局不显示侧栏，提示随之不可见）。
 */
export function PwaRuntimeNoticeSlot({ className }: { className?: string }) {
  const id = useId();
  const register = useContext(PwaRuntimeNoticeContext)?.registerWorkspaceTarget;
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => (slot && register ? register(slot) : undefined), [register, slot]);

  return <div id={id} ref={setSlot} className={className ?? "pwa-runtime-notice-slot"} />;
}

export function PwaRuntimeNoticePortal({ children }: { children: ReactNode }) {
  const target = useContext(PwaRuntimeNoticeContext)?.target;
  // Mantine 的 target 变化只更新 ref，切换展示目标时需重建 Portal。
  return target ? <Portal key={target.id} target={target}>{children}</Portal> : children;
}

/** 通知占用独立布局空间，不能覆盖会话输入区。 */
export function PwaAppShell({ children, runtimeNotice }: { children: ReactNode; runtimeNotice: ReactNode }) {
  const shellRef = useRef<HTMLDivElement>(null);
  useViewportDensity(shellRef);
  useSoftKeyboard();
  const fallbackId = useId();
  const [fallbackTarget, setFallbackTarget] = useState<HTMLDivElement | null>(null);
  const [toastFallbackTarget, setToastFallbackTarget] = useState<HTMLDivElement | null>(null);
  const [workspaceTargets, setWorkspaceTargets] = useState<readonly HTMLElement[]>([]);
  const workspaceTarget = workspaceTargets.at(-1) ?? null;
  const [notifications] = useState(createOperationNotificationController);
  const registerWorkspaceTarget = useCallback((target: HTMLElement) => {
    setWorkspaceTargets((current) => [...current.filter((item) => item !== target), target]);
    return () => setWorkspaceTargets((current) => current.filter((item) => item !== target));
  }, []);
  const context = useMemo(() => ({
    target: workspaceTarget ?? fallbackTarget,
    registerWorkspaceTarget,
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
