import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { useReaderHistory } from "./use-reader-history";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { useSwipe } from "./use-swipe";
import { swipeBlocked } from "./swipe-guards";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, usePwaMotionDuration } from "./use-pwa-motion";
import type { NavigationGesture } from "./use-navigation-drag";
import { SessionStatusContent, type SessionStatusProps } from "./session-status";

export function SessionStatusDrawer({ opened, gesture, onClose, onExitTransitionEnd, ...status }: SessionStatusProps & { opened: boolean; gesture: NavigationGesture | null; onClose: () => void; onExitTransitionEnd: () => void }) {
  const { t } = useI18n();
  const duration = usePwaMotionDuration("--pwa-duration-drawer");
  const exitDuration = usePwaMotionDuration("--pwa-duration-drawer-out");
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const openedRef = useRef(opened);
  const historyReleasedRef = useRef(true);
  const exitFinishedRef = useRef(false);
  const exitCallbackRef = useRef(onExitTransitionEnd);
  useLayoutEffect(() => {
    openedRef.current = opened;
    exitCallbackRef.current = onExitTransitionEnd;
    if (opened) {
      exitFinishedRef.current = false;
      if (gesture === null) historyReleasedRef.current = false;
    }
  }, [opened, gesture, onExitTransitionEnd]);
  const blocked = useCallback(() => Boolean(surface && swipeBlocked(surface)), [surface]);
  const close = useCallback(() => { if (!blocked()) onClose(); }, [blocked, onClose]);
  const history = useReaderHistory({ opened: opened && gesture === null, stateKey: "piReachSessionStatus", marker: true, onClose: close, ignorePop: blocked, onReleased: () => {
    historyReleasedRef.current = true;
    if (exitFinishedRef.current && !openedRef.current) exitCallbackRef.current();
  } });
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened, direction: "right", requestClose: close, skipExit: history.skipExit, resetSkipExit: history.resetSkipExit });
  useSwipe(surface, { direction: "right", enabled: opened && gesture === null, onSwipe: close, canSwipe, drag });
  useLayoutEffect(() => {
    if (!opened) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || blocked()) return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [opened, blocked, close]);
  const restoreFocus = () => {
    if (openedRef.current) return;
    const active = document.activeElement;
    const hasExternalFocus = active instanceof HTMLElement && active !== document.body && active.isConnected && !surface?.contains(active) && !active.closest('[inert], [aria-hidden="true"]') && active.getClientRects().length;
    if (!hasExternalFocus && gesture !== "rollback") {
      const root = surface?.closest(".pwa-root");
      const target = [root?.querySelector<HTMLElement>(".pwa-session-status-trigger"), root?.querySelector<HTMLElement>(".pwa-title-bar-name")].find((element) => element?.isConnected && !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length);
      target?.focus({ preventScroll: true });
    }
    exitFinishedRef.current = true;
    if (historyReleasedRef.current) onExitTransitionEnd();
  };
  return <Drawer.Root opened={opened} onClose={close} onExitTransitionEnd={restoreFocus} position="right" size="min(320px, 85vw)" portalProps={{ target: ".pwa-root" }} zIndex="var(--pwa-z-navigation)" padding={0} returnFocus={false} trapFocus={gesture === null} lockScroll={gesture === null} closeOnEscape={false}
    transitionProps={{ transition: pwaDrawerTransitions.right, duration: gesture ? 0 : duration, exitDuration: history.instant || gesture === "rollback" ? 0 : exitDuration, timingFunction: PWA_DRAWER_EASE }}
    classNames={{ content: "pwa-session-status-drawer", header: "pwa-topbar pwa-session-status-head", body: "pwa-session-status-body" }}
    styles={{ content: { width: "min(320px, 85vw)", height: "var(--pwa-app-height)", maxHeight: "var(--pwa-app-height)", display: "flex", flexDirection: "column" } }}>
    <Drawer.Overlay className="pwa-scrim" />
    <Drawer.Content ref={setSurface} role="dialog" aria-modal={gesture ? undefined : true} data-swipe-drag={gesture === "dragging" ? "" : undefined}>
      <Drawer.Header><Drawer.Title>{t.sessionStatus.title}</Drawer.Title><Drawer.CloseButton className="pwa-icon-button" aria-label={t.common.close} /></Drawer.Header>
      <Drawer.Body><SessionStatusContent {...status} mobile /></Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
