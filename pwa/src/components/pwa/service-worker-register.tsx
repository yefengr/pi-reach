import { Alert, Button } from "@mantine/core";
import { Download } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { PwaOperationNotifications, PwaToastProvider, useToast } from "@/components/pwa/pwa-operation-notifications";
import { createOperationNotificationController, type OperationNotificationController } from "@/lib/pwa/operation-notifications";
import { PwaRuntimeNoticePortal } from "@/components/pwa/pwa-app-shell";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import { useI18n } from "@/lib/i18n";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

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
  installPrompt: boolean;
  unsupported: boolean;
  onInstall: () => void;
  onDismiss: () => void;
  onFocusRecoveryReady?: (restore: (() => void) | null) => void;
};

export function ServiceWorkerNotice({
  installPrompt,
  unsupported,
  onInstall,
  onDismiss,
  onFocusRecoveryReady,
}: ServiceWorkerNoticeProps) {
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const focusWithinNoticeRef = useRef(false);
  const { t } = useI18n();
  const n = t.pwaNotice;
  const title = unsupported ? n.unsupportedTitle : n.installTitle;
  const description = unsupported ? n.unsupportedBody : n.installBody;

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

  useEffect(() => {
    onFocusRecoveryReady?.(() => {
      const removesNotice = !unsupported;
      const removesFocusedInstall = document.activeElement?.matches("[data-pwa-install]");
      if (installPrompt && (removesNotice || removesFocusedInstall)) restoreFocus();
    });
    return () => onFocusRecoveryReady?.(null);
  }, [installPrompt, unsupported, onFocusRecoveryReady, restoreFocus]);

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
    className="pwa-runtime-notice"
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
    title={title}
    withCloseButton
    closeButtonLabel={n.dismiss}
    onClose={dismiss}
    onFocusCapture={capturePriorFocus}
    onBlurCapture={clearNoticeFocus}
  >
    <div className="pwa-runtime-notice-content">
      <span className="pwa-runtime-notice-description">{description}</span>
      <div className="pwa-runtime-notice-actions">
        {installPrompt ? <Button data-pwa-install variant="default" type="button" onClick={onInstall} leftSection={<Download size={16} />}>{n.install}</Button> : null}
      </div>
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
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateVersion, setUpdateVersion] = useState(0);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState(0);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updateRequested, setUpdateRequested] = useState(false);
  const updateRequestedRef = useRef(false);
  const noticeFocusRecoveryRef = useRef<(() => void) | null>(null);
  const setNoticeFocusRecovery = useCallback((restore: (() => void) | null) => {
    noticeFocusRecoveryRef.current = restore;
  }, []);

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

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      noticeFocusRecoveryRef.current?.();
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    if (!("serviceWorker" in navigator)) {
      queueMicrotask(() => setUnsupported(true));
      return () => {
        window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
        window.removeEventListener("appinstalled", onAppInstalled);
      };
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
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
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

  if (process.env.NODE_ENV !== "production") return null;
  // 更新提示使用独立的操作 Toast；安装与浏览器能力提示仍在文档流 Alert 中。
  const showNotice = !dismissed && (unsupported || Boolean(installPrompt));
  if (!showNotice) return null;

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    noticeFocusRecoveryRef.current?.();
    setInstallPrompt(null);
  };

  return <ServiceWorkerNotice
    installPrompt={Boolean(installPrompt)}
    unsupported={unsupported}
    onInstall={() => void install()}
    onDismiss={() => setDismissed(true)}
    onFocusRecoveryReady={setNoticeFocusRecovery}
  />;
}
