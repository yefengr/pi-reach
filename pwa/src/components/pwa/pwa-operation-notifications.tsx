import { createContext, useContext, useEffect } from "react";
import { Notifications } from "@mantine/notifications";
import { usePwaMotionDuration } from "./use-pwa-motion";
import type { OperationNotificationController } from "@/lib/pwa/operation-notifications";

type PwaOperationNotificationsProps = {
  controller: OperationNotificationController;
  target?: HTMLElement | null;
};

const ToastContext = createContext<OperationNotificationController | null>(null);

export const PwaToastProvider = ToastContext.Provider;

/** 取得当前 PWA 实例的 Toast 控制器；组件单独渲染（如测试）时为 null。 */
export function useToast(): OperationNotificationController | null {
  return useContext(ToastContext);
}

function withinToast(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".pwa-operation-notification") !== null;
}

/**
 * Toast：顶部居中、位于会话标题区下方的最顶层浮层，不拦截其他操作，不抢焦点，以 aria-live 播报。
 * 悬停或聚焦时暂停自动关闭计时。
 */
export function PwaOperationNotifications({ controller, target }: PwaOperationNotificationsProps) {
  const transitionDuration = usePwaMotionDuration("--pwa-duration-toast", 180);
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const onMouseOver = (event: MouseEvent) => { if (withinToast(event.target)) controller.pauseAutoClose("hover"); };
    const onMouseOut = (event: MouseEvent) => { if (withinToast(event.target) && !withinToast(event.relatedTarget)) controller.resumeAutoClose("hover"); };
    const onFocusIn = (event: FocusEvent) => { if (withinToast(event.target)) controller.pauseAutoClose("focus"); };
    const onFocusOut = (event: FocusEvent) => { if (withinToast(event.target) && !withinToast(event.relatedTarget)) controller.resumeAutoClose("focus"); };
    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [controller]);

  // Mantine Portal 切换 target 时需要重建；DOM 元素作为 React key 会统一字符串化成 [object HTMLDivElement]。
  return <Notifications
    key={target?.classList.contains("pwa-root") ? "workspace" : target ? "startup" : "standalone"}
    className="pwa-operation-notifications"
    classNames={{ notification: "pwa-operation-notification" }}
    store={controller.store}
    position="top-center"
    autoClose={false}
    allowDragDismiss={false}
    allowScrollDismiss={false}
    transitionDuration={transitionDuration}
    limit={1}
    zIndex={400}
    containerWidth={400}
    portalProps={{ target: target ?? ".pwa-root" }}
  />;
}
