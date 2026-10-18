import { useState, type ReactNode } from "react";
import { ActionIcon, Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft, MessageSquare, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, useDrawerMoving, usePwaMotionDuration } from "./use-pwa-motion";
import { useReaderHistory } from "./use-reader-history";
import { readerFocusable, readerHasOverlay, useWorkPanelReader } from "./use-work-panel-reader";
import "./tool-reader.css";

type ReaderShellProps = {
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
  onEnterTransitionEnd?: () => void;
  title: string;
  closeLabel: string;
  historyKey: string;
  className?: string;
  describedBy?: string;
  actions?: ReactNode;
  workPanel?: boolean;
  children: ReactNode;
};

/** 工具与文本可进入非模态面板，摘要沿用 Drawer；正文 Portal 在两种宿主间保持同一身份。 */
export function ReaderShell({ opened, onClose, onExitTransitionEnd, onEnterTransitionEnd, title, closeLabel, historyKey, className = "", describedBy, actions, workPanel = false, children }: ReaderShellProps) {
  const { t } = useI18n();
  const duration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const mobile = useMediaQuery("(max-width: 767.98px)") ?? false;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const requestClose = () => { if (!readerHasOverlay(surface)) onClose(); };
  const { docked, modalOpened, setModalHost, portal, onExit } = useWorkPanelReader({ enabled: workPanel, opened, onClose: requestClose, onExitTransitionEnd, onEntered: onEnterTransitionEnd });
  const motion = useDrawerMoving(modalOpened);
  const { instant, skipExit, resetSkipExit } = useReaderHistory({ opened: modalOpened, stateKey: historyKey, marker: true, onClose: requestClose, ignorePop: () => readerHasOverlay(surface) });
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened: modalOpened, direction: 1, requestClose, skipExit, resetSkipExit });
  useSwipe(surface, { direction: "right", enabled: modalOpened && mobile, onSwipe: requestClose, canSwipe, drag });
  const enter = () => { motion.onEnterTransitionEnd(); onEnterTransitionEnd?.(); };
  const returnToChat = () => {
    const root = document.querySelector(".pwa-work-panel-conversation");
    const composer = root?.querySelector<HTMLElement>(".pwa-composer textarea");
    const list = root?.querySelector<HTMLElement>(".pwa-message-list");
    if (readerFocusable(composer)) composer.focus({ preventScroll: true });
    else if (readerFocusable(list)) list.focus({ preventScroll: true });
  };
  const controls = <>{actions}
    {docked ? <ActionIcon className="pwa-icon-button" aria-label={t.workPanel.returnToChat} title={t.workPanel.returnToChat} onClick={returnToChat}><MessageSquare size={20} /></ActionIcon> : null}
    {docked || !mobile ? <ActionIcon className="pwa-icon-button pwa-tool-reader-close" aria-label={closeLabel} title={closeLabel} onClick={requestClose}><X size={20} /></ActionIcon> : null}
  </>;
  return <Drawer.Root opened={modalOpened} onClose={requestClose} onEnterTransitionEnd={enter} onExitTransitionEnd={onExit}
      position="right" size={mobile ? "100%" : "var(--pwa-reader-drawer-width)"}
      withinPortal portalProps={{ target: ".pwa-root" }} zIndex={30} trapFocus returnFocus={false}
      transitionProps={{ transition: pwaDrawerTransitions.right, duration, exitDuration: instant ? 0 : duration, timingFunction: PWA_DRAWER_EASE }}>
      <Drawer.Overlay className="pwa-scrim" />
      <Drawer.Content ref={setSurface} classNames={{ content: `pwa-tool-reader ${className}`.trim() }} data-pwa-moving={motion.moving || undefined} aria-describedby={describedBy}>
        <div ref={setModalHost} className="pwa-reader-modal-host" />
      </Drawer.Content>
    {portal(<>
      <header className={`pwa-topbar pwa-tool-reader-header${className === "pwa-file-reader" ? " pwa-file-reader-header" : ""}`}>
        {!docked && mobile ? <ActionIcon className="pwa-icon-button pwa-topbar-back pwa-tool-reader-close" aria-label={closeLabel} title={closeLabel} onClick={requestClose}><ArrowLeft size={20} /></ActionIcon> : null}
        <Drawer.Title className="pwa-tool-reader-title" tabIndex={-1} data-autofocus title={title}>{title}</Drawer.Title>
        {className === "pwa-file-reader" ? controls : <div className="pwa-tool-reader-actions">{controls}</div>}
      </header>
      <div className={`pwa-tool-reader-body${className === "pwa-file-reader" ? " pwa-file-reader-body" : ""}`}>{children}</div>
    </>)}
  </Drawer.Root>;
}
