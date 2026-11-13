import { createContext, useContext, useEffect } from "react";
import { Notifications } from "@mantine/notifications";
import { usePwaMotionDuration } from "./use-pwa-motion";
import { useToastSwipeDismiss } from "./use-toast-swipe-dismiss";
import { observeWrappedText } from "@/lib/ui/wrapped-text";
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
 * 悬停或聚焦时暂停自动关闭计时；触屏可上滑收走（useToastSwipeDismiss），不使用 Mantine 自带的横向拖动与滚动关闭。
 */
export function PwaOperationNotifications({ controller, target }: PwaOperationNotificationsProps) {
  const transitionDuration = usePwaMotionDuration("--pwa-duration-toast");
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

  useToastSwipeDismiss(controller);

  // 正文换行时圆角改为 16（ADR-20261105）。Toast 由 Mantine 渲染、取不到 ref：每次通知变化后的下一帧找到正文并观察尺寸。
  useEffect(() => {
    const observed = new Map<HTMLElement, () => void>();
    let frame = 0;
    const sync = () => {
      frame = 0;
      const root = target ?? document.querySelector(".pwa-root");
      const texts = new Set<HTMLElement>();
      for (const card of root?.querySelectorAll<HTMLElement>(".pwa-operation-notifications .pwa-operation-notification") ?? []) {
        // 带操作的 Toast 正文与操作同行，只看文字本身，44 高的操作按钮不算换行。
        const text = card.querySelector<HTMLElement>(".pwa-toast-text") ?? card.querySelector<HTMLElement>(".pwa-operation-notification-message");
        if (text) texts.add(text);
      }
      for (const [text, stop] of observed) if (!texts.has(text)) { stop(); observed.delete(text); }
      for (const text of texts) if (!observed.has(text)) observed.set(text, observeWrappedText(text, ".pwa-operation-notification"));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    schedule();
    const unsubscribe = controller.store.subscribe(schedule);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      for (const stop of observed.values()) stop();
    };
  }, [controller, target]);

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
    zIndex="var(--pwa-z-feedback)"
    containerWidth={400}
    portalProps={{ target: target ?? ".pwa-root" }}
  />;
}
