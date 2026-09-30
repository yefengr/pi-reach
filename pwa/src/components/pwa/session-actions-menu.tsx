import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import {
  ComposerCommandMenuPanel,
  type ComposerCommandAction,
  type ComposerCommandMenuView,
} from "./composer-command-menu";
import { pwaFadeTransition, useMenuExitAction, usePwaMotionDuration } from "./use-pwa-motion";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { useI18n } from "@/lib/i18n";

export type SessionActionsMenuVariant = "desktop" | "mobile";

/** 「更多」菜单顶部的只读信息区。 */
export type SessionMenuInfo = {
  name: string;
  cwd?: string | null;
  computer: string;
  status: string;
};

export type SessionActionsMenuProps = {
  variant?: SessionActionsMenuVariant;
  info: SessionMenuInfo;
  /** 本地历史只提供信息区，不提供操作。 */
  readOnly?: boolean;
  isOnline: boolean;
  isWorking: boolean;
  pendingAction: ComposerCommandAction | null;
  models: WireModel[];
  currentModel: WireModel | null;
  currentModelFallback: string | null;
  thinking: ThinkingLevel;
  onNewSession: () => void;
  onCompactSession: () => void;
  onSetModel: (model: WireModel) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onCommandsOpen: () => void;
  onRetry?: () => void;
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

export function SessionActionsMenu({
  info,
  readOnly = false,
  isOnline,
  isWorking,
  pendingAction,
  models,
  currentModel,
  currentModelFallback,
  thinking,
  onNewSession,
  onCompactSession,
  onSetModel,
  onSetThinking,
  onCommandsOpen,
  onRetry,
}: SessionActionsMenuProps) {
  const { t } = useI18n();
  const menuDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const menuAction = useMenuExitAction();
  const [opened, setOpened] = useState(false);
  const [view, setView] = useState<ComposerCommandMenuView>("root");
  const openedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const menuFocusIntentRef = useRef<"first" | "last" | null>(null);

  const setMenuOpened = useCallback((nextOpened: boolean) => {
    if (nextOpened && menuAction.hasPending()) return;
    const wasOpened = openedRef.current;
    if (nextOpened === wasOpened) return;

    openedRef.current = nextOpened;
    setOpened(nextOpened);
    if (nextOpened) {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
      onCommandsOpen();
      return;
    }

    menuFocusIntentRef.current = null;
    setView("root");
    scheduleFocusReturn(focusFrameRef, triggerRef, () => !openedRef.current);
  }, [menuAction, onCommandsOpen]);

  useEffect(() => {
    if (!opened) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openedRef.current && !dropdownRef.current?.contains(event.target as Node)) setMenuOpened(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [opened, setMenuOpened]);

  const consumeMenuFocusIntent = () => {
    const intent = menuFocusIntentRef.current;
    if (!intent || !openedRef.current || dropdownRef.current?.inert) return;
    const items = dropdownRef.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)");
    if (!items?.length) return;
    menuFocusIntentRef.current = null;
    items[intent === "first" ? 0 : items.length - 1].focus({ preventScroll: true });
  };

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  const closeThen = (callback: () => void) => {
    if (menuAction.hasPending()) return;
    menuAction.queue(callback);
    triggerRef.current?.focus({ preventScroll: true });
    setMenuOpened(false);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!openedRef.current) setMenuOpened(true);
    menuFocusIntentRef.current = event.key === "ArrowDown" ? "first" : "last";
    consumeMenuFocusIntent();
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
      transitionProps={{ transition: pwaFadeTransition, duration: menuDuration, onEnter: consumeMenuFocusIntent }}
      onExitTransitionEnd={() => {
        if (!openedRef.current && !hasValidPageFocus()) triggerRef.current?.focus({ preventScroll: true });
        menuAction.finish();
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
        {view === "root" ? <div className="pwa-session-info" role="group" aria-label={t.actions.sessionInfo}>
          <strong className="pwa-session-info-name">{info.name}</strong>
          {info.cwd ? <code className="pwa-session-info-cwd">{info.cwd}</code> : null}
          <span className="pwa-session-info-meta">{info.computer} · {info.status}</span>
        </div> : null}
        {readOnly ? null : <>{view === "root" ? <Menu.Divider className="pwa-session-actions-divider" role="separator" /> : null}<ComposerCommandMenuPanel
          presentation="action"
          showModelControls={false}
          view={view}
          isOnline={isOnline}
          isWorking={isWorking}
          pendingAction={pendingAction}
          models={models}
          currentModel={currentModel}
          currentModelFallback={currentModelFallback}
          thinking={thinking}
          onNewSession={() => closeThen(onNewSession)}
          onCompactSession={() => closeThen(onCompactSession)}
          onSetModel={(model) => closeThen(() => onSetModel(model))}
          onSetThinking={(level) => closeThen(() => onSetThinking(level))}
          onBack={() => setView("root")}
          onOpenModels={() => setView("models")}
          onOpenThinking={() => setView("thinking")}
        /></>}
        {!readOnly && view === "root" && onRetry ? <>
          <Menu.Divider className="pwa-session-actions-divider" role="separator" />
          <div className="pwa-session-actions-secondary" role="group" aria-label={t.actions.sessionUtilities}>
            <Menu.Item className="pwa-command-row pwa-session-actions-secondary-item" leftSection={<RefreshCw size={16} />} onClick={() => closeThen(onRetry)}>
              <span className="pwa-command-copy"><span>{t.actions.retryConnection}</span></span>
            </Menu.Item>
          </div>
        </> : null}
      </Menu.Dropdown>
    </Menu>
  </div>;
}
