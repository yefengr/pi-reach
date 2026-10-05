import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "@mantine/core";
import { pwaDrawerTransitions, pwaOverlayEase, usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { WorkspaceDeviceControl } from "@/components/pwa/workspace-device-control";
import { useI18n } from "@/lib/i18n";
import { getActiveDevice, WorkspaceHistorySection, WorkspaceNavigationFooter, WorkspaceRunningPiSection, type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";
import { BrandMark } from "@/components/pwa/brand-mark";
import { useSwipe } from "@/components/pwa/use-swipe";

type SessionSheetProps = WorkspaceNavigationProps & {
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  withinPortal?: boolean;
  opened?: boolean;
  onExitTransitionEnd?: () => void;
  instant?: boolean;
  restoreScrollTop?: number;
  focusSettings?: boolean;
  portalTarget?: string;
};

export function SessionSheet({ onClose, focusOrigin = null, withinPortal = true, opened = true, onExitTransitionEnd, instant = false, restoreScrollTop, focusSettings = false, portalTarget = ".pwa-root", ...navigation }: SessionSheetProps) {
  const navigationDuration = usePwaMotionDuration("--pwa-duration-nav", 240);
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const setContentRef = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element;
    setContentElement(element);
  }, []);
  const chooserOpenRef = useRef(false);
  const focusOriginRef = useRef(focusOrigin);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const [closeRequest, setCloseRequest] = useState(0);
  useLayoutEffect(() => {
    focusOriginRef.current = focusOrigin;
    // 与父组件的关闭更新一起提交后再判断拒绝，避免 rAF 先于 React 提交而丢失动作。
    if (closeRequest > 0 && opened) pendingActionRef.current = null;
  }, [closeRequest, opened, focusOrigin]);
  useLayoutEffect(() => () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    const origin = focusOriginRef.current;
    // 条件卸载不会完成 Drawer 退出动画，动作改在卸载提交完成后交接。
    queueMicrotask(() => {
      action?.();
      if (document.activeElement === document.body && origin?.isConnected
        && !origin.matches(':disabled') && !origin.closest('[aria-hidden="true"], [inert]')
        && origin.getClientRects().length > 0) origin.focus({ preventScroll: true });
    });
  }, []);
  const activeDevice = getActiveDevice(navigation.devices, navigation.activeDeviceId);
  const duration = instant ? 0 : navigationDuration;
  // Drawer 内容可能晚于本组件挂载，在滚动区挂载时恢复位置。
  const restoreScrollRef = useRef(restoreScrollTop);
  useLayoutEffect(() => { restoreScrollRef.current = restoreScrollTop; }, [restoreScrollTop]);
  const scrollRef = (element: HTMLDivElement | null) => {
    if (element && restoreScrollRef.current !== undefined) element.scrollTop = restoreScrollRef.current;
  };

  const canFocus = (element: HTMLElement | null): element is HTMLElement => Boolean(
    element?.isConnected
    && !element.matches(":disabled")
    && element.getClientRects().length > 0
    && !element.closest('[aria-hidden="true"]'),
  );
  const restoreFocus = () => {
    const activeElement = document.activeElement;
    const content = contentRef.current;
    const hasExternalFocus = activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
      && !content?.contains(activeElement);
    if (hasExternalFocus) return;
    if (canFocus(focusOrigin)) focusOrigin.focus({ preventScroll: true });
  };
  const finishPendingAction = () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) {
      action();
      requestAnimationFrame(restoreFocus);
    } else restoreFocus();
  };
  const handleExitTransitionEnd = () => {
    finishPendingAction();
    onExitTransitionEnd?.();
  };
  const requestClose = () => {
    if (chooserOpenRef.current) return;
    setCloseRequest((request) => request + 1);
    onClose();
  };
  useSwipe(contentElement, {
    direction: "left",
    enabled: opened,
    onSwipe: requestClose,
    canSwipe: () => !chooserOpenRef.current,
  });
  const closeAfter = (action: () => void) => {
    pendingActionRef.current = action;
    requestClose();
  };
  const handleDeviceOverlayChange = (nextOpened: boolean) => {
    chooserOpenRef.current = nextOpened;
  };

  const wrappedPair = () => closeAfter(navigation.onPair);
  // 进入设置页时导航不先播放关闭动画：设置页推入完成后由工作区布局直接卸载导航。
  const wrappedSettings = navigation.onSettings;
  const wrappedDevice = (deviceId: string) => closeAfter(() => navigation.onSelectDevice(deviceId));
  const wrappedEndpoint = (endpointId: string) => closeAfter(() => navigation.onSelectEndpoint(endpointId));
  const wrappedHistory = (history: Parameters<WorkspaceNavigationProps["onSelectHistory"]>[0]) => closeAfter(() => navigation.onSelectHistory(history));
  const wrappedRename = (device: Parameters<WorkspaceNavigationProps["onRename"]>[0]) => closeAfter(() => navigation.onRename(device));
  const wrappedRemove = (device: Parameters<WorkspaceNavigationProps["onRemove"]>[0]) => navigation.onRemove(device);

  return <Drawer.Root
    opened={opened}
    onClose={requestClose}
    onExitTransitionEnd={handleExitTransitionEnd}
    position="left"
    size="min(320px, 85vw)"
    withinPortal={withinPortal}
    portalProps={{ target: portalTarget }}
    zIndex={200}
    padding={0}
    returnFocus={false}
    closeOnEscape={false}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing || !opened || chooserOpenRef.current) return;
      event.stopPropagation();
      requestClose();
    }}
    transitionProps={{ transition: pwaDrawerTransitions.left, duration, timingFunction: "var(--pwa-overlay-ease)" }}
    style={pwaOverlayEase(opened)}
    classNames={{ content: "pwa-session-sheet pwa-navigation-drawer", header: "pwa-session-sheet-head", body: "pwa-session-sheet-body", close: "pwa-icon-button" }}
    styles={{ content: { width: "min(320px, 85vw)", height: "100dvh", maxWidth: "85vw", maxHeight: "100dvh", display: "flex", flexDirection: "column" } }}
  >
    <Drawer.Overlay className="pwa-scrim" />
    <Drawer.Content ref={setContentRef} role="dialog" aria-modal="true">
      <Drawer.Header><Drawer.Title className="pwa-sidebar-brand"><BrandMark className="pwa-brand-mark" size={24} /><span>Pi Reach</span><span className="pwa-sr-only"> · {t.navigation.workspace}</span></Drawer.Title><Drawer.CloseButton className="pwa-navigation-close" aria-label={t.navigation.close} title={t.navigation.close} /></Drawer.Header>
      <Drawer.Body>
        <div className="pwa-navigation-content">
          <div className="pwa-sidebar-head">
            <WorkspaceDeviceControl devices={navigation.devices} activeDeviceId={navigation.activeDeviceId} pairingPresence={navigation.pairingPresence} onPair={wrappedPair} onSelectDevice={wrappedDevice} onRename={wrappedRename} onRemove={wrappedRemove} variant="sheet" onOverlayChange={handleDeviceOverlayChange} />
          </div>
          <div className="pwa-navigation-scroll" ref={scrollRef}>
            <WorkspaceRunningPiSection activeDevice={activeDevice} endpoints={navigation.endpoints} activeEndpointId={navigation.activeEndpointId} selectedHistoryId={navigation.selectedHistoryId} snapshotReady={navigation.snapshotReady} completedEndpointIds={navigation.completedEndpointIds} onSelectEndpoint={wrappedEndpoint} headingId="pwa-sheet-running-heading" variant="sheet" />
            <WorkspaceHistorySection activeDevice={activeDevice} history={navigation.history} selectedHistoryId={navigation.selectedHistoryId} onSelectHistory={wrappedHistory} headingId="pwa-sheet-history-heading" variant="sheet" />
          </div>
          <WorkspaceNavigationFooter className="pwa-session-sheet-foot" onPair={wrappedPair} onSettings={wrappedSettings} autoFocusSettings={focusSettings} />
        </div>
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
