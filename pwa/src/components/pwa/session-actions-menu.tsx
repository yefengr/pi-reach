import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { MoreHorizontal } from "lucide-react";
import { pwaFadeTransition, usePwaMotionDuration } from "./use-pwa-motion";
import { useI18n } from "@/lib/i18n";

/** 「更多」菜单只提供只读会话信息。 */
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
  const { t } = useI18n();
  const menuDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);

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
    <Menu
      opened={opened}
      onChange={setMenuOpened}
      trapFocus={false}
      withInitialFocusPlaceholder={false}
      menuItemTabIndex={0}
      returnFocus={false}
      closeOnItemClick={false}
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
      <Menu.Target>
        <ActionIcon ref={triggerRef} className="pwa-session-actions-trigger" type="button" aria-label={t.actions.sessionActions} title={t.actions.sessionActions} onKeyDown={handleTriggerKeyDown}><MoreHorizontal size={20} /></ActionIcon>
      </Menu.Target>
      <Menu.Dropdown ref={dropdownRef} inert={!opened} className="pwa-command-menu-dropdown pwa-session-actions-dropdown" aria-label={t.actions.sessionActions}>
        <div className="pwa-session-info" role="group" aria-label={t.actions.sessionInfo}>
          <strong className="pwa-session-info-name">{info.name}</strong>
          {info.cwd ? <code className="pwa-session-info-cwd">{info.cwd}</code> : null}
          <span className="pwa-session-info-meta">{info.computer} · {info.status}</span>
        </div>
      </Menu.Dropdown>
    </Menu>
  </div>;
}
