import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ActionIcon, Popover, Textarea } from "@mantine/core";
import { MoreHorizontal } from "lucide-react";
import { pwaFadeTransition, usePwaMotionDuration } from "./use-pwa-motion";
import { useI18n } from "@/lib/i18n";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";

/** 「更多」弹层只提供可访问的只读会话信息。 */
export type SessionMenuInfo = {
  name: string;
  cwd?: string | null;
  computer: string;
  status: string;
};

export type SessionActionsMenuProps = {
  info: SessionMenuInfo;
};

function hasValidPageFocus() {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement
    && activeElement !== document.body
    && activeElement !== document.documentElement
    && activeElement.isConnected
    && !activeElement.closest("[inert]");
}

function scheduleFocusReturn(
  frameRef: { current: number | null },
  triggerRef: { current: HTMLButtonElement | null },
  isStillClosed: () => boolean,
) {
  if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  frameRef.current = requestAnimationFrame(() => {
    frameRef.current = null;
    if (isStillClosed() && !hasValidPageFocus()) triggerRef.current?.focus({ preventScroll: true });
  });
}

export function SessionActionsMenu({ info }: SessionActionsMenuProps) {
  const floatingMiddlewares = useFloatingSafeMiddlewares();
  const { t } = useI18n();
  const menuDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const nameId = useId();
  const metadataId = useId();
  const setDropdownRef = useCallback((node: HTMLDivElement | null) => {
    dropdownRef.current = node;
    // 非模态信息弹层不困住 Tab；先让读屏读取会话信息，再由 Tab 进入原生只读路径字段。
    if (node && openedRef.current) node.focus({ preventScroll: true });
  }, []);

  const setMenuOpened = useCallback((nextOpened: boolean) => {
    const wasOpened = openedRef.current;
    if (nextOpened === wasOpened) return;

    openedRef.current = nextOpened;
    setOpened(nextOpened);
    if (nextOpened) {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
      return;
    }

    scheduleFocusReturn(focusFrameRef, triggerRef, () => !openedRef.current);
  }, []);

  useLayoutEffect(() => {
    // 退出淡化尚未结束时重开，Dropdown 不会重新挂载；也必须重新提供信息区焦点入口。
    if (opened) dropdownRef.current?.focus({ preventScroll: true });
  }, [opened]);

  useEffect(() => {
    if (!opened) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openedRef.current && !dropdownRef.current?.contains(event.target as Node)) setMenuOpened(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [opened, setMenuOpened]);

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!openedRef.current) setMenuOpened(true);
  };

  return <div className="pwa-session-actions">
    <Popover
      middlewares={floatingMiddlewares}
      opened={opened}
      onChange={setMenuOpened}
      trapFocus={false}
      returnFocus={false}
      clickOutsideEvents={["mousedown", "touchstart"]}
      closeOnClickOutside
      closeOnEscape
      position="bottom-end"
      width="var(--pwa-command-menu-width)"
      offset={8}
      transitionProps={{ transition: pwaFadeTransition, duration: menuDuration }}
      onExitTransitionEnd={() => {
        if (!openedRef.current && !hasValidPageFocus()) triggerRef.current?.focus({ preventScroll: true });
      }}
      floatingStrategy="fixed"
      withinPortal
      portalProps={{ target: ".pwa-root" }}
      zIndex={21}
    >
      <Popover.Target>
        <ActionIcon ref={triggerRef} className="pwa-session-actions-trigger" type="button" aria-label={t.actions.sessionInfo} title={t.actions.sessionInfo} onClick={() => setMenuOpened(!openedRef.current)} onKeyDown={handleTriggerKeyDown}><MoreHorizontal size={20} /></ActionIcon>
      </Popover.Target>
      <Popover.Dropdown ref={setDropdownRef} inert={!opened} className="pwa-command-menu-dropdown pwa-session-actions-dropdown" aria-label={t.actions.sessionInfo} aria-describedby={`${nameId} ${metadataId}`} aria-modal={false}>
        <div className="pwa-session-info" role="group" aria-label={t.actions.sessionInfo}>
          <strong id={nameId} className="pwa-session-info-name">{info.name}</strong>
          {info.cwd ? <Textarea autosize readOnly variant="unstyled" value={info.cwd} aria-label={t.actions.workingDirectory} classNames={{ input: "pwa-session-info-cwd" }} /> : null}
          <span id={metadataId} className="pwa-session-info-meta">{info.computer} · {info.status}</span>
        </div>
      </Popover.Dropdown>
    </Popover>
  </div>;
}
