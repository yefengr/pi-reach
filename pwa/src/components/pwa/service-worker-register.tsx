import { Alert } from "@mantine/core";
import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { PwaOperationNotifications, PwaToastProvider, useToast } from "@/components/pwa/pwa-operation-notifications";
import { createOperationNotificationController, type OperationNotificationController } from "@/lib/pwa/operation-notifications";
import { PwaRuntimeNoticePortal } from "@/components/pwa/pwa-app-shell";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import { useI18n } from "@/lib/i18n";
import { presenceProps, usePresence } from "./use-presence";

const DEV_SW_CLEANUP_KEY = "pi-reach-dev-sw-cleanup-v1";
const NOTICE_FOCUS_FALLBACK_SELECTORS = [
  ".pwa-composer textarea:not(:disabled)",
  ".pwa-session-trigger:not(:disabled)",
  ".pwa-title-bar button:not(:disabled)",
  ".pwa-startup-actions button:not(:disabled)",
] as const;

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element
    && element !== document.body
    && element !== document.documentElement
    && element.isConnected
    && !element.matches(":disabled, [aria-disabled='true']")
    && element.getClientRects().length > 0
    && !element.closest("[aria-hidden='true'], [inert]"),
  );
}

function hasOpenDialog(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']")).some((dialog) => (
    dialog.getAttribute("aria-hidden") !== "true" && dialog.getClientRects().length > 0
  ));
}

type ServiceWorkerNoticeProps = {
  onDismiss: () => void;
  /** 关闭后的淡出阶段：保留最后的内容，不可交互。 */
  leaving?: boolean;
};

/** 浏览器不支持离线应用模式的持久提示；安装引导在首次打开与设置页（ADR-20261106「安装引导」）。 */
export function ServiceWorkerNotice({ onDismiss, leaving = false }: ServiceWorkerNoticeProps) {
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const focusWithinNoticeRef = useRef(false);
  const { t } = useI18n();
  const n = t.pwaNotice;

  const restoreFocus = useCallback(() => {
    const notice = noticeRef.current;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (canReceiveFocus(activeElement) && (!notice || !notice.contains(activeElement))) {
      focusWithinNoticeRef.current = false;
      return;
    }
    if (!focusWithinNoticeRef.current && (!notice || !notice.contains(activeElement))) return;
    if (hasOpenDialog()) {
      focusWithinNoticeRef.current = false;
      return;
    }

    const candidates = [
      priorFocusRef.current,
      ...NOTICE_FOCUS_FALLBACK_SELECTORS.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]),
    ];
    const target = candidates.find(canReceiveFocus);
    if (target) target.focus({ preventScroll: true });
    focusWithinNoticeRef.current = false;
  }, []);

  const capturePriorFocus = (event: FocusEvent<HTMLDivElement>) => {
    const previous = event.relatedTarget;
    if (previous instanceof HTMLElement && !event.currentTarget.contains(previous)) priorFocusRef.current = previous;
    focusWithinNoticeRef.current = true;
  };
  const clearNoticeFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusWithinNoticeRef.current = false;
  };
  const dismiss = () => {
    restoreFocus();
    onDismiss();
  };

  return <PwaRuntimeNoticePortal><Alert
    ref={noticeRef}
    {...presenceProps({ rendered: true, leaving })}
    className="pwa-runtime-notice pwa-presence"
    classNames={{
      wrapper: "pwa-runtime-notice-wrapper",
      body: "pwa-runtime-notice-body",
      title: "pwa-runtime-notice-title",
      message: "pwa-runtime-notice-message",
      closeButton: "pwa-runtime-notice-dismiss",
    }}
    variant="light"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    title={n.unsupportedTitle}
    withCloseButton
    closeButtonLabel={n.dismiss}
    onClose={dismiss}
    onFocusCapture={capturePriorFocus}
    onBlurCapture={clearNoticeFocus}
  >
    <div className="pwa-runtime-notice-content">
      <span className="pwa-runtime-notice-description">{n.unsupportedBody}</span>
    </div>
  </Alert></PwaRuntimeNoticePortal>;
}

export function ServiceWorkerRegister() {
  const sharedNotifications = useToast();
  if (sharedNotifications) return <ServiceWorkerRegisterContent notifications={sharedNotifications} />;
  return <StandaloneServiceWorkerRegister />;
}

/** 单独挂载注册组件的生命周期测试继续使用自己的唯一 Toast 控制器。 */
function StandaloneServiceWorkerRegister() {
  const [notifications] = useState(createOperationNotificationController);
  return <PwaToastProvider value={notifications}>
    <ServiceWorkerRegisterContent notifications={notifications} />
    <PwaOperationNotifications controller={notifications} />
  </PwaToastProvider>;
}

function ServiceWorkerRegisterContent({ notifications }: { notifications: OperationNotificationController }) {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateVersion, setUpdateVersion] = useState(0);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState(0);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updateRequested, setUpdateRequested] = useState(false);
  const updateRequestedRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      if (!sessionStorage.getItem(DEV_SW_CLEANUP_KEY) && "serviceWorker" in navigator) {
        sessionStorage.setItem(DEV_SW_CLEANUP_KEY, "1");
        void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((current) => current.unregister())))
          .then(() => typeof caches === "undefined" ? [] : caches.keys())
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith("pi-reach-")).map((key) => caches.delete(key))));
      }
      return;
    }

    if (!("serviceWorker" in navigator)) {
      queueMicrotask(() => setUnsupported(true));
      return;
    }

    let disposed = false;
    let currentRegistration: ServiceWorkerRegistration | null = null;
    const inspectWaitingWorker = () => {
      const waiting = currentRegistration?.waiting;
      if (disposed || !waiting || !navigator.serviceWorker.controller || waitingWorkerRef.current === waiting) return;
      waitingWorkerRef.current = waiting;
      updateRequestedRef.current = false;
      setUpdateRequested(false);
      setUpdateVersion((version) => version + 1);
    };
    const onUpdateFound = () => {
      const worker = currentRegistration?.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") inspectWaitingWorker();
      });
    };

    void navigator.serviceWorker.register("/sw.js", { scope: "/app" }).then((nextRegistration) => {
      if (disposed) return;
      currentRegistration = nextRegistration;
      setRegistration(nextRegistration);
      inspectWaitingWorker();
      nextRegistration.addEventListener("updatefound", onUpdateFound);
    }).catch(() => {
      if (!disposed) setUnsupported(true);
    });

    return () => {
      disposed = true;
      currentRegistration?.removeEventListener("updatefound", onUpdateFound);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (updateRequestedRef.current) return;
    updateRequestedRef.current = true;
    setUpdateRequested(true);
    void refreshPwaApp(registration);
  }, [registration]);
  const { t } = useI18n();
  const updateNotice = t.pwaNotice;
  useEffect(() => {
    if (updateVersion === 0 || dismissedUpdateVersion === updateVersion) return;
    notifications.showUpdate(updateNotice.updateTitle, {
      label: updateRequested ? updateNotice.updating : updateNotice.refresh,
      onClick: applyUpdate,
      disabled: updateRequested,
    }, () => setDismissedUpdateVersion(updateVersion));
  }, [applyUpdate, dismissedUpdateVersion, notifications, updateNotice, updateRequested, updateVersion]);

  // 更新提示使用独立的操作 Toast；浏览器能力提示仍在文档流 Alert 中，关闭后淡出。
  const notice = usePresence(!dismissed && unsupported ? true : null);
  if (process.env.NODE_ENV !== "production") return null;
  if (!notice.rendered) return null;

  return <ServiceWorkerNotice leaving={notice.leaving} onDismiss={() => setDismissed(true)} />;
}
