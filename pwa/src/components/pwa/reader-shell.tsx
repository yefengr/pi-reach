import { useState, type ReactNode } from "react";
import { ActionIcon, Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft, X } from "lucide-react";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, useDrawerMoving, usePwaMotionDuration } from "./use-pwa-motion";
import { useReaderHistory } from "./use-reader-history";
import { readerHasOverlay } from "./reader-shared";
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
  children: ReactNode;
};

/**
 * 工具与文本阅读器共用的右侧 Drawer：桌面 720px，移动全屏。
 * 打开时压入一条不改变 URL 的历史记录，系统返回或浏览器后退只关闭阅读器。
 */
export function ReaderShell({ opened, onClose, onExitTransitionEnd, onEnterTransitionEnd, title, closeLabel, historyKey, className = "", describedBy, actions, children }: ReaderShellProps) {
  const duration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const mobile = useMediaQuery("(max-width: 767.98px)") ?? false;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const requestClose = () => { if (!readerHasOverlay(surface)) onClose(); };
  const motion = useDrawerMoving(opened);
  const { instant, skipExit, resetSkipExit } = useReaderHistory({ opened, stateKey: historyKey, marker: true, onClose: requestClose, ignorePop: () => readerHasOverlay(surface) });
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened, direction: 1, requestClose, skipExit, resetSkipExit });
  useSwipe(surface, { direction: "right", enabled: opened && mobile, onSwipe: requestClose, canSwipe, drag });
  const enter = () => { motion.onEnterTransitionEnd(); onEnterTransitionEnd?.(); };
  const controls = <>{actions}
    {mobile ? null : <ActionIcon className="pwa-icon-button pwa-tool-reader-close" aria-label={closeLabel} title={closeLabel} onClick={requestClose}><X size={20} /></ActionIcon>}
  </>;
  return <Drawer.Root opened={opened} onClose={requestClose} onEnterTransitionEnd={enter} onExitTransitionEnd={onExitTransitionEnd}
      position="right" size={mobile ? "100%" : "var(--pwa-reader-drawer-width)"}
      withinPortal portalProps={{ target: ".pwa-root" }} zIndex={30} trapFocus returnFocus={false}
      transitionProps={{ transition: pwaDrawerTransitions.right, duration, exitDuration: instant ? 0 : duration, timingFunction: PWA_DRAWER_EASE }}>
      <Drawer.Overlay className="pwa-scrim" />
      <Drawer.Content ref={setSurface} classNames={{ content: `pwa-tool-reader ${className}`.trim() }} data-pwa-moving={motion.moving || undefined} aria-describedby={describedBy}>
        <header className={`pwa-topbar pwa-tool-reader-header${className === "pwa-file-reader" ? " pwa-file-reader-header" : ""}`}>
          {mobile ? <ActionIcon className="pwa-icon-button pwa-topbar-back pwa-tool-reader-close" aria-label={closeLabel} title={closeLabel} onClick={requestClose}><ArrowLeft size={20} /></ActionIcon> : null}
          <Drawer.Title className="pwa-tool-reader-title" tabIndex={-1} data-autofocus title={title}>{title}</Drawer.Title>
          {className === "pwa-file-reader" ? controls : <div className="pwa-tool-reader-actions">{controls}</div>}
        </header>
        <div className={`pwa-tool-reader-body${className === "pwa-file-reader" ? " pwa-file-reader-body" : ""}`}>{children}</div>
      </Drawer.Content>
  </Drawer.Root>;
}
