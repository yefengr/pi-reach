import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "@mantine/core";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { WorkspaceDeviceControl } from "@/components/pwa/workspace-device-control";
import { useI18n } from "@/lib/i18n";
import { getActiveDevice, WorkspaceHistorySection, WorkspaceNavigationFooter, WorkspaceRunningPiSection, type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";
import { BrandMark } from "@/components/pwa/brand-mark";
import { useSwipe } from "@/components/pwa/use-swipe";
import { useDrawerSwipeClose } from "@/components/pwa/use-drawer-swipe-close";
import type { NavigationGesture } from "@/components/pwa/use-navigation-drag";
import { swipeBlocked } from "@/components/pwa/swipe-guards";

type SessionSheetProps = WorkspaceNavigationProps & {
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  withinPortal?: boolean;
  opened?: boolean;
  onExitTransitionEnd?: () => void;
  instant?: boolean;
  restoreScrollTop?: number;
  focusSettings?: boolean;
  /** 返回预览：工作区仍 inert，暂不启用焦点陷阱与滚动锁，也不主动聚焦设置入口。 */
  preview?: boolean;
  /** 导航打开的跟手拖动：dragging 为预览态，rollback 为回弹后的即时关闭（不回焦）。 */
  gesture?: NavigationGesture | null;
  portalTarget?: string;
};

const NAVIGATION_SETTINGS_SELECTOR = ".pwa-nav-settings";

function useNavigationSettingsFocus(opened: boolean, requested: boolean, content: HTMLDivElement | null, previewing: boolean) {
  // 初始焦点标记是渲染状态，不能在 render 中读写 ref；父级提前收尾时仍保留给晚挂载的 Portal。
  const [autoFocusSettings, setAutoFocusSettings] = useState(opened && requested);
  const [seenRequest, setSeenRequest] = useState({ opened, requested });
  if (seenRequest.opened !== opened || seenRequest.requested !== requested) {
    setSeenRequest({ opened, requested });
    if (!opened) setAutoFocusSettings(false);
    else if (requested) setAutoFocusSettings(true);
  }
  const pendingRef = useRef(opened && requested);
  const previousRef = useRef({ opened, requested, previewing });
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { opened, requested, previewing };
    if (!opened) {
      pendingRef.current = false;
      return;
    }
    if (!requested) return;
    const fresh = !(previous.opened && previous.requested);
    // 返回预览期间只保留请求；预览结束（工作区解除 inert）后明确消费一次，不依赖 Drawer 再次初始化。
    if (previewing) {
      if (fresh) pendingRef.current = true;
      return;
    }
    if (!fresh && !(previous.previewing && pendingRef.current)) return;
    pendingRef.current = true;
    // 新请求到达已有内容时直接消费；首次挂载继续交给 FocusTrap 的初始化链。
    const settings = content?.querySelector<HTMLElement>(NAVIGATION_SETTINGS_SELECTOR);
    if (!settings) return;
    settings.focus({ preventScroll: true });
    if (document.activeElement === settings) pendingRef.current = false;
  }, [content, opened, requested, previewing]);
  const onFocusedElement = (element: HTMLElement) => {
    if (element.matches(NAVIGATION_SETTINGS_SELECTOR)) {
      pendingRef.current = false;
      return;
    }
    // 不在首次 autofocus 后立即移除标记，以免 FocusTrap 的第二次初始化转而聚焦关闭按钮。
    // 用户主动移开焦点后移除；普通重渲染不再改变用户的选择。
    if (!pendingRef.current) setAutoFocusSettings(false);
  };
  return { autoFocusSettings, onFocusedElement };
}

export function SessionSheet({ onClose, focusOrigin = null, withinPortal = true, opened = true, onExitTransitionEnd, instant = false, restoreScrollTop, focusSettings = false, preview = false, gesture = null, portalTarget = ".pwa-root", ...navigation }: SessionSheetProps) {
  const navigationDuration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const { autoFocusSettings, onFocusedElement } = useNavigationSettingsFocus(opened, focusSettings, contentElement, preview);
  const dragPreview = gesture === "dragging";
  // 拖动打开的预览、回弹与外部关闭收尾期间都不启用焦点陷阱与滚动锁；进入时长同时置 0，
  // 否则 Mantine 会在关闭后按进入时长延迟释放内部的锁状态，手势状态一清除锁就短暂亮起。
  const gestureActive = gesture !== null;
  const setContentRef = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element;
    setContentElement(element);
  }, []);
  const chooserOpenRef = useRef(false);
  const focusOriginRef = useRef(focusOrigin);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const [closeRequest, setCloseRequest] = useState(0);
  const [seenOpened, setSeenOpened] = useState({ opened, epoch: 0 });
  const [exitInstant, setExitInstant] = useState(false);
  if (seenOpened.opened !== opened) {
    setSeenOpened({ opened, epoch: seenOpened.epoch + 1 });
    if (opened) setExitInstant(false);
  }
  const exitEpoch = seenOpened.epoch;
  const lifecycleRef = useRef({ active: true, opened, epoch: exitEpoch, completedEpoch: -1 });
  useLayoutEffect(() => {
    lifecycleRef.current.opened = opened;
    lifecycleRef.current.epoch = exitEpoch;
  }, [opened, exitEpoch]);
  useLayoutEffect(() => {
    focusOriginRef.current = focusOrigin;
    // 与父组件的关闭更新一起提交后再判断拒绝，避免 rAF 先于 React 提交而丢失动作。
    if (closeRequest > 0 && opened) pendingActionRef.current = null;
  }, [closeRequest, opened, focusOrigin]);
  useLayoutEffect(() => {
    const lifecycle = lifecycleRef.current;
    lifecycle.active = true;
    return () => {
      lifecycle.active = false;
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
    };
  }, []);
  const activeDevice = getActiveDevice(navigation.devices, navigation.activeDeviceId);
  const duration = instant ? 0 : navigationDuration;
  // 跟手关闭收尾到终点后只让本次退出即时；现有 instant 同时作用于进入和退出，不能复用。重新打开时复位。
  const skipExit = useCallback(() => setExitInstant(true), [setExitInstant]);
  const resetSkipExit = useCallback(() => setExitInstant(false), [setExitInstant]);
  // Drawer 内容可能晚于本组件挂载，在滚动区挂载时恢复位置。
  const restoreScrollRef = useRef(restoreScrollTop);
  const seenRestoreScrollRef = useRef(restoreScrollTop);
  useLayoutEffect(() => {
    if (seenRestoreScrollRef.current !== restoreScrollTop) {
      seenRestoreScrollRef.current = restoreScrollTop;
      if (restoreScrollTop !== undefined) restoreScrollRef.current = restoreScrollTop;
    }
    // 快速反向时滚动区没有重新挂载，新恢复请求也必须在现存 DOM 上消费。
    const scroll = contentElement?.querySelector<HTMLElement>(".pwa-navigation-scroll");
    if (!scroll || restoreScrollRef.current === undefined) return;
    scroll.scrollTop = restoreScrollRef.current;
    restoreScrollRef.current = undefined;
  }, [contentElement, restoreScrollTop]);
  const scrollRef = useCallback((element: HTMLDivElement | null) => {
    if (!element || restoreScrollRef.current === undefined) return;
    element.scrollTop = restoreScrollRef.current;
    restoreScrollRef.current = undefined;
  }, []);

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
  const isCurrentExit = () => {
    const lifecycle = lifecycleRef.current;
    return lifecycle.active && !lifecycle.opened && lifecycle.epoch === exitEpoch;
  };
  const finishPendingAction = () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) {
      action();
      requestAnimationFrame(() => { if (isCurrentExit()) restoreFocus(); });
    } else restoreFocus();
  };
  const handleExitTransitionEnd = () => {
    // 每次打开边界变化都会使旧退出失效，包括重开后再次关闭；卸载及重复通知也不能产生副作用。
    if (!isCurrentExit() || lifecycleRef.current.completedEpoch === exitEpoch) return;
    lifecycleRef.current.completedEpoch = exitEpoch;
    // 未提交的打开手势保留原焦点：回弹后的关闭不执行回焦，也不交接待执行动作。
    if (gesture !== "rollback") finishPendingAction();
    if (isCurrentExit()) onExitTransitionEnd?.();
  };
  const requestClose = useCallback(() => {
    if (chooserOpenRef.current) return;
    setCloseRequest((request) => request + 1);
    onClose();
  }, [onClose, setCloseRequest]);
  useLayoutEffect(() => {
    // 打开跟手与打开收尾都保留外部焦点；只补这段窗口，普通导航仍由局部键盘路由处理。
    if (gesture !== "dragging" || preview || !opened || !contentElement) return;
    const escapeFromOutside = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || event.cancelBubble
        || event.composedPath().includes(contentElement) || chooserOpenRef.current
        || !contentElement.isConnected || !contentElement.closest(".pwa-root")
        || contentElement.closest('[inert], [aria-hidden="true"]') || contentElement.getClientRects().length === 0
        || swipeBlocked(contentElement)) return;
      event.stopPropagation();
      requestClose();
    };
    document.addEventListener("keydown", escapeFromOutside);
    return () => document.removeEventListener("keydown", escapeFromOutside);
  }, [contentElement, gesture, opened, preview, requestClose]);
  const { drag, canSwipe: dragCanSwipe } = useDrawerSwipeClose({ surface: contentElement, opened, direction: -1, requestClose, skipExit, resetSkipExit });
  useSwipe(contentElement, {
    direction: "left",
    enabled: opened,
    onSwipe: requestClose,
    canSwipe: () => !chooserOpenRef.current && dragCanSwipe(),
    drag,
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
    trapFocus={!preview && !gestureActive}
    lockScroll={!preview && !gestureActive}
    closeOnEscape={false}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing || !opened || chooserOpenRef.current) return;
      event.stopPropagation();
      requestClose();
    }}
    transitionProps={{ transition: pwaDrawerTransitions.left, duration: gestureActive ? 0 : duration, exitDuration: exitInstant || gesture === "rollback" ? 0 : duration, timingFunction: PWA_DRAWER_EASE }}
    classNames={{ content: "pwa-session-sheet pwa-navigation-drawer", header: "pwa-session-sheet-head", body: "pwa-session-sheet-body", close: "pwa-icon-button" }}
    styles={{ content: { width: "min(320px, 85vw)", height: "100dvh", maxWidth: "85vw", maxHeight: "100dvh", display: "flex", flexDirection: "column" } }}
  >
    <Drawer.Overlay className="pwa-scrim" />
    <Drawer.Content ref={setContentRef} role="dialog" aria-modal="true" data-swipe-drag={dragPreview ? "" : undefined} onFocusCapture={(event) => {
      if (event.target instanceof HTMLElement) onFocusedElement(event.target);
    }}>
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
          <WorkspaceNavigationFooter className="pwa-session-sheet-foot" onPair={wrappedPair} onSettings={wrappedSettings} autoFocusSettings={autoFocusSettings} />
        </div>
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
