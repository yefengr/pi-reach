import { createElement, type ReactNode } from "react";
import { createNotificationsStore, type NotificationData, type NotificationsStore } from "@mantine/notifications";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { getMessages } from "@/lib/i18n";

export const OPERATION_NOTIFICATION_ID = "pwa-operation-feedback";
/** 不带操作的成功／普通提示显示时长；悬停或聚焦时暂停计时。 */
export const TOAST_AUTO_CLOSE_MS = 4_000;

export type ToastKind = "success" | "info";
export type ToastOptions = { kind?: ToastKind; action?: { label: string; onClick: () => void; disabled?: boolean }; onDismiss?: () => void };
type PauseReason = "hover" | "focus";

export type OperationAction = "session_new" | "session_compact" | "model_set" | "thinking_set";
export type OperationFeedback =
  | "registry-save"
  | "preference-save"
  | `${OperationAction}-error`
  | `${Exclude<OperationAction, "session_new">}-send-failed`
  | "stop-send-failed";

export type OperationNotificationController = {
  readonly store: NotificationsStore;
  activate: () => void;
  dispose: () => void;
  /** 需处理的失败反馈：不自动消失，替换当前提示。 */
  show: (operation: OperationFeedback) => void;
  /** 一次性成功／普通提示：替换当前普通提示；当前为错误时排在其后。 */
  notify: (message: string, options?: ToastOptions) => void;
  /** PWA 更新为需处理的高优先级提示；普通成功提示排队，错误结束后恢复。 */
  showUpdate: (message: string, action: NonNullable<ToastOptions["action"]>, onDismiss: () => void) => void;
  pauseAutoClose: (reason: PauseReason) => void;
  resumeAutoClose: (reason: PauseReason) => void;
  clearAction: (action: OperationAction) => void;
  clearStop: () => void;
  clearSession: () => void;
};

function operationAction(operation: OperationFeedback): OperationAction | "stop" | "preference" | null {
  if (operation === "registry-save") return null;
  if (operation === "preference-save") return "preference";
  if (operation === "stop-send-failed") return "stop";
  return operation.split("-")[0] as OperationAction;
}

function notificationHasFocus(): boolean {
  return typeof document !== "undefined" && !!document.activeElement?.closest(".pwa-operation-notification");
}

function restoreNotificationFocus(origin: HTMLElement | null): void {
  if (!notificationHasFocus()) return;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  const canFocus = (element: HTMLElement | null): element is HTMLElement => !!element?.isConnected
    && !element.matches(":disabled") && !element.closest('[aria-hidden="true"], [inert]') && element.getClientRects().length > 0;
  const candidates = [origin, ...document.querySelectorAll<HTMLElement>('.pwa-composer-input, .pwa-session-actions-trigger, .pwa-session-trigger, .pwa-title-bar button, .pwa-settings-back, .pwa-startup-actions button')];
  // 在关闭按钮卸载前转移焦点，避免零时长退出过渡仍晚于 requestAnimationFrame。
  candidates.find(canFocus)?.focus({ preventScroll: true });
}

export function actionErrorFeedback(action: OperationAction): Extract<OperationFeedback, `${OperationAction}-error`> {
  return `${action}-error`;
}

export function actionSendFailureFeedback(action: Exclude<OperationAction, "session_new">): Extract<OperationFeedback, `${OperationAction}-send-failed`> {
  return `${action}-send-failed`;
}

function toastIcon(kind: ToastKind | "error"): ReactNode {
  const icon = kind === "error" ? CircleAlert : kind === "success" ? CircleCheck : Info;
  return createElement(icon, { size: 16, "aria-hidden": true });
}

type NormalToast = { message: string; options: ToastOptions };

/**
 * 每个 PWA 实例持有自己的单槽；旧实例回调不能向新实例写入。
 * 同一时间只显示一条：失败反馈与普通提示共用一个槽位，普通提示遇到当前错误时排队等待。
 */
export function createOperationNotificationController(): OperationNotificationController {
  const store = createNotificationsStore();
  let active = false;
  let currentOperation: OperationFeedback | null = null;
  let currentNormal: NormalToast | null = null;
  let currentUpdate: NormalToast | null = null;
  let pendingNormal: NormalToast | null = null;
  let focusOrigin: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = 0;
  let startedAt = 0;
  const pauses = new Set<PauseReason>();
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const setNotification = (notification: NotificationData | null) => {
    store.setState((state) => ({ ...state, notifications: notification ? [{ ...notification, id: OPERATION_NOTIFICATION_ID }] : [], queue: [] }));
  };
  const runTimer = () => {
    stopTimer();
    if (!currentNormal || currentNormal.options.action || pauses.size > 0 || remaining <= 0) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      restoreNotificationFocus(focusOrigin);
      currentNormal = null;
      setNotification(null);
    }, remaining);
  };
  const rememberFocusOrigin = () => {
    if (typeof document !== "undefined" && !notificationHasFocus()) {
      focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  };
  const renderNormal = (toast: NormalToast) => {
    rememberFocusOrigin();
    currentOperation = null;
    currentNormal = toast;
    const kind = toast.options.kind ?? "success";
    const action = toast.options.action;
    setNotification({
      message: action
        ? createElement("span", { className: "pwa-toast-content" }, createElement("span", { className: "pwa-toast-text" }, toast.message), createElement("button", { type: "button", className: "pwa-toast-action", onClick: action.onClick, disabled: action.disabled }, action.label))
        : toast.message,
      position: "top-center",
      autoClose: false,
      withCloseButton: true,
      role: "status",
      "aria-live": "polite",
      "aria-atomic": true,
      icon: toastIcon(kind),
      className: `pwa-operation-notification pwa-toast-${kind}`,
      classNames: { description: "pwa-operation-notification-message", closeButton: "pwa-operation-notification-close", icon: "pwa-toast-icon" },
      closeButtonProps: { "aria-label": getMessages().operations.dismiss },
      onClose: () => {
        if (currentNormal !== toast) return;
        stopTimer();
        restoreNotificationFocus(focusOrigin);
        currentNormal = null;
        if (currentUpdate === toast) currentUpdate = null;
        toast.options.onDismiss?.();
        // Mantine 在 onClose 之后才清空 store；等待它完成移除再展示下一条。
        queueMicrotask(showPending);
      },
    });
    remaining = TOAST_AUTO_CLOSE_MS;
    runTimer();
  };
  const showPending = () => {
    if (!active || currentOperation || currentNormal) return;
    if (currentUpdate) {
      renderNormal(currentUpdate);
      return;
    }
    const next = pendingNormal;
    pendingNormal = null;
    if (next) renderNormal(next);
  };
  const clearAll = () => {
    restoreNotificationFocus(focusOrigin);
    stopTimer();
    currentOperation = null;
    currentNormal = null;
    setNotification(null);
    showPending();
  };
  return {
    store,
    activate: () => { active = true; showPending(); },
    dispose: () => {
      active = false;
      stopTimer();
      currentOperation = null;
      currentNormal = null;
      currentUpdate = null;
      pendingNormal = null;
      focusOrigin = null;
      pauses.clear();
      setNotification(null);
    },
    show: (operation) => {
      if (!active) return;
      rememberFocusOrigin();
      stopTimer();
      currentNormal = null;
      currentOperation = operation;
      setNotification({
        message: getMessages().operations[operation],
        position: "top-center",
        autoClose: false,
        withCloseButton: true,
        role: "status",
        "aria-live": "polite",
        "aria-atomic": true,
        icon: toastIcon("error"),
        className: "pwa-operation-notification pwa-toast-error",
        classNames: { description: "pwa-operation-notification-message", closeButton: "pwa-operation-notification-close", icon: "pwa-toast-icon" },
        closeButtonProps: { "aria-label": getMessages().operations.dismiss },
        // Mantine 在移除通知的同一次状态更新里调用 onClose，排队的提示须在其后显示。
        onClose: () => { restoreNotificationFocus(focusOrigin); currentOperation = null; queueMicrotask(showPending); },
      });
    },
    notify: (message, options = {}) => {
      if (!active) return;
      const toast = { message, options };
      if (currentOperation || currentUpdate) {
        pendingNormal = toast;
        return;
      }
      renderNormal(toast);
    },
    showUpdate: (message, action, onDismiss) => {
      const toast: NormalToast = { message, options: { kind: "info", action, onDismiss } };
      currentUpdate = toast;
      // SW 在启动期间可能比展示组件先收到 waiting 状态；activate 会补显。
      if (active && !currentOperation && currentNormal !== toast) renderNormal(toast);
    },
    pauseAutoClose: (reason) => {
      if (pauses.has(reason)) return;
      pauses.add(reason);
      if (timer !== null) {
        stopTimer();
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      }
    },
    resumeAutoClose: (reason) => {
      if (!pauses.delete(reason)) return;
      runTimer();
    },
    clearAction: (action) => {
      if (active && currentOperation && operationAction(currentOperation) === action) clearAll();
    },
    clearStop: () => {
      if (active && currentOperation === "stop-send-failed") clearAll();
    },
    clearSession: () => {
      if (active && currentOperation && operationAction(currentOperation) !== null) clearAll();
    },
  };
}

export function operationFeedbackMessage(operation: OperationFeedback): string {
  return getMessages().operations[operation];
}
