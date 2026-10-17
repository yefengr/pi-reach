import { useState, type ReactNode } from "react";
import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft, X } from "lucide-react";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, useDrawerMoving, usePwaMotionDuration } from "./use-pwa-motion";
import { useReaderHistory } from "./use-reader-history";
import "./tool-reader.css";

type ReaderShellProps = {
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
  title: string;
  closeLabel: string;
  historyKey: string;
  className?: string;
  describedBy?: string;
  actions?: ReactNode;
  children: ReactNode;
};

/** 工具与摘要共用关闭、history、Portal 和移动跟手生命周期，正文各自持有滚动状态。 */
export function ReaderShell({ opened, onClose, onExitTransitionEnd, title, closeLabel, historyKey, className = "", describedBy, actions, children }: ReaderShellProps) {
  const duration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const mobile = useMediaQuery("(max-width: 767.98px)") ?? false;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const motion = useDrawerMoving(opened);
  const { instant, skipExit, resetSkipExit } = useReaderHistory({ opened, stateKey: historyKey, marker: true, onClose });
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened, direction: 1, requestClose: onClose, skipExit, resetSkipExit });
  useSwipe(surface, { direction: "right", enabled: opened && mobile, onSwipe: onClose, canSwipe, drag });

  return <Drawer.Root opened={opened} onClose={onClose} onEnterTransitionEnd={motion.onEnterTransitionEnd} onExitTransitionEnd={onExitTransitionEnd}
    position="right" size={mobile ? "100%" : "var(--pwa-reader-drawer-width)"}
    withinPortal portalProps={{ target: ".pwa-root" }} zIndex={30} trapFocus returnFocus={false}
    transitionProps={{ transition: pwaDrawerTransitions.right, duration, exitDuration: instant ? 0 : duration, timingFunction: PWA_DRAWER_EASE }}>
    <Drawer.Overlay className="pwa-scrim" />
    <Drawer.Content ref={setSurface} classNames={{ content: `pwa-tool-reader ${className}`.trim() }} data-pwa-moving={motion.moving || undefined} aria-describedby={describedBy}>
      <Drawer.Header className="pwa-topbar pwa-tool-reader-header">
        {mobile ? <Drawer.CloseButton className="pwa-icon-button pwa-topbar-back pwa-tool-reader-close" aria-label={closeLabel} title={closeLabel} icon={<ArrowLeft size={20} />} /> : null}
        <Drawer.Title className="pwa-tool-reader-title" tabIndex={-1} data-autofocus title={title}>{title}</Drawer.Title>
        <div className="pwa-tool-reader-actions">{actions}{mobile ? null : <Drawer.CloseButton className="pwa-icon-button pwa-tool-reader-close" aria-label={closeLabel} title={closeLabel} icon={<X size={20} />} />}</div>
      </Drawer.Header>
      <Drawer.Body className="pwa-tool-reader-body">{children}</Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
