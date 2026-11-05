import { useRef, useState, type ReactNode } from "react";
import { ActionIcon, Badge, Button, Drawer, Menu, NavLink, Popover } from "@mantine/core";
import { usePwaMotionDuration, PWA_DRAWER_EASE, pwaDrawerTransitions, useMenuExitAction, usePwaMenuTransition } from "@/components/pwa/use-pwa-motion";
import { ChevronDown, Computer, Ellipsis, Link2, Pencil, Trash2 } from "lucide-react";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import type { DeviceActivity, PairingPresence } from "@/lib/pwa/pwa-view-model";
import { RunningIndicator } from "@/components/pwa/running-indicator";
import { getMessages, useI18n } from "@/lib/i18n";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";

export type WorkspaceDeviceControlVariant = "desktop" | "sheet";

export type WorkspaceDeviceControlProps = {
  devices: PwaDeviceRecord[];
  activeDeviceId: string | null;
  pairingPresence?: Record<string, PairingPresence>;
  /** 电脑行状态：完成未查看优先于运行中；按本地 device.id 索引。 */
  deviceActivity?: Readonly<Record<string, DeviceActivity>>;
  onPair: () => void;
  onSelectDevice: (deviceId: string) => void;
  onRename: (device: PwaDeviceRecord) => void;
  onRemove: (device: PwaDeviceRecord) => void;
  variant?: WorkspaceDeviceControlVariant;
  purpose?: "choose" | "manage";
  onOverlayChange?: (opened: boolean) => void;
  onMenuChange?: (opened: boolean) => void;
};

const computerNavLinkClassNames = {
  body: "pwa-peer-copy",
  label: "pwa-peer-label",
  description: "pwa-peer-description",
  section: "pwa-peer-section",
} as const;

export function displayDevice(device: PwaDeviceRecord): string {
  const nickname = device.nickname?.trim();
  if (nickname) return nickname;
  const hostname = device.hostname?.trim();
  if (hostname) return hostname;
  return getMessages().devices.fallbackName(device.deviceId.slice(0, 8));
}

function ComputerActionsMenu({ device, onRename, onRemove, onMenuChange }: { device: PwaDeviceRecord; onRename: () => void; onRemove: () => void; onMenuChange?: (opened: boolean) => void }) {
  const { t } = useI18n();
  const menuTransition = usePwaMenuTransition();
  const floatingMiddlewares = useFloatingSafeMiddlewares();
  const menuAction = useMenuExitAction();
  const [opened, setOpened] = useState(false);
  const label = displayDevice(device);
  const setMenuOpened = (nextOpened: boolean) => {
    if (nextOpened && menuAction.hasPending()) return;
    setOpened(nextOpened);
    onMenuChange?.(nextOpened || menuAction.hasPending());
  };
  const closeThen = (action: () => void) => {
    if (menuAction.hasPending()) return;
    menuAction.queue(action);
    setMenuOpened(false);
  };
  return <Menu
    middlewares={floatingMiddlewares}
    opened={opened}
    withinPortal
    portalProps={{ target: ".pwa-root" }}
    position="bottom-end"
    preventPositionChangeWhenVisible={false}
    zIndex="var(--pwa-z-device-menu)"
    returnFocus
    onChange={setMenuOpened}
    onExitTransitionEnd={() => { onMenuChange?.(false); menuAction.finish(); }}
    transitionProps={menuTransition}
  >
    <Menu.Target><ActionIcon className="pwa-peer-menu-trigger" type="button" aria-label={t.devices.actionsFor(label)} title={t.devices.actions}><Ellipsis size={20} /></ActionIcon></Menu.Target>
    <Menu.Dropdown inert={!opened} className="pwa-peer-menu-panel pwa-menu-motion" data-mantine-stop-propagation="true" onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
    }}>
      <Menu.Item leftSection={<Pencil size={16} />} aria-label={t.devices.renameLabel(label)} onClick={() => closeThen(onRename)}>{t.devices.rename}</Menu.Item>
      <Menu.Item color="var(--pwa-error)" leftSection={<Trash2 size={16} />} aria-label={t.devices.removeLabel(label)} onClick={() => closeThen(onRemove)}>{t.devices.removePairing}</Menu.Item>
    </Menu.Dropdown>
  </Menu>;
}

export function ComputerRow({ device, active, presence, activity = null, onSelect, onRename, onRemove, onMenuChange }: { device: PwaDeviceRecord; active: boolean; presence?: PairingPresence; activity?: DeviceActivity; onSelect: () => void; onRename: () => void; onRemove: () => void; onMenuChange?: (opened: boolean) => void }) {
  const { t } = useI18n();
  const status = presence?.status ?? "checking";
  const onlinePis = presence?.onlineEndpoints ?? 0;
  const summary = status === "checking" ? t.devices.checking : t.devices.piRunning(onlinePis);
  return <div className={`pwa-peer-card ${active ? "active" : ""}`}>
    <NavLink
      className="pwa-peer-select pwa-computer-select"
      classNames={computerNavLinkClassNames}
      component="button"
      type="button"
      label={displayDevice(device)}
      description={<span className="pwa-peer-presence"><Badge className={`pwa-presence-label ${status}`}>{t.devices.status[status]}</Badge>{active ? <Badge className="pwa-current-label">{t.common.current}</Badge> : null}<span className="pwa-peer-summary">{summary}</span></span>}
      leftSection={<span className={`pwa-peer-icon ${onlinePis > 0 ? "online" : ""}`}><Computer size={20} /></span>}
      // 固定 16px 状态槽始终占位；完成点优先于运行中，且不参与 Pi 行的 running 优先规则。
      rightSection={<span className="pwa-peer-status-slot">{activity === "completed"
        ? <span className="pwa-notice-dot" role="img" aria-label={t.navigation.newReply} title={t.navigation.newReply} />
        : activity === "running"
          ? <RunningIndicator size="compact" label={t.actions.running} />
          : null}</span>}
      active={active}
      noWrap
      onClick={onSelect}
    />
    <ComputerActionsMenu device={device} onRename={onRename} onRemove={onRemove} onMenuChange={onMenuChange} />
  </div>;
}

function DevicePanel({ devices, activeDeviceId, pairingPresence = {}, deviceActivity = {}, onPair, onSelectDevice, onRename, onRemove, onMenuChange }: Omit<WorkspaceDeviceControlProps, "variant" | "purpose" | "onOverlayChange">) {
  const { t } = useI18n();
  return <div className="pwa-device-panel">
    <div className="pwa-device-panel-list">
      {devices.length === 0 ? <p className="pwa-device-panel-empty">{t.devices.noneYet}</p> : devices.map((device) => <ComputerRow
        key={device.id}
        device={device}
        active={device.id === activeDeviceId}
        presence={pairingPresence[device.id]}
        activity={deviceActivity[device.id] ?? null}
        onSelect={() => onSelectDevice(device.id)}
        onRename={() => onRename(device)}
        onRemove={() => onRemove(device)}
        onMenuChange={onMenuChange}
      />)}
    </div>
    <Button className="pwa-device-panel-pair" variant="default" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>{t.navigation.pairComputer}</Button>
  </div>;
}

export function WorkspaceDeviceControl({ devices, activeDeviceId, pairingPresence = {}, deviceActivity = {}, onPair, onSelectDevice, onRename, onRemove, variant = "desktop", purpose = "choose", onOverlayChange }: WorkspaceDeviceControlProps) {
  const chooserDuration = usePwaMotionDuration("--pwa-duration-drawer");
  const chooserExitDuration = usePwaMotionDuration("--pwa-duration-drawer-out");
  const floatingMiddlewares = useFloatingSafeMiddlewares();
  const menuTransition = usePwaMenuTransition();
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const menuOwnsDismissRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const activeDevice = devices.find((device) => device.id === activeDeviceId) ?? null;
  const label = activeDevice ? displayDevice(activeDevice) : devices.length > 0 ? t.devices.chooseComputer : t.devices.noComputerPaired;
  const title = purpose === "manage" ? t.devices.computers : t.devices.chooseTitle;

  const setPanelOpened = (nextOpened: boolean) => {
    openedRef.current = nextOpened;
    setOpened(nextOpened);
    onOverlayChange?.(nextOpened);
  };
  const dismissPanel = () => {
    if (!menuOwnsDismissRef.current) setPanelOpened(false);
  };
  // 底部入口与展开面板共用同一个开关状态：重复点击或快速连点可反向，不另建状态机。
  const togglePanel = () => {
    if (openedRef.current) dismissPanel();
    // 面板正在退出且已排队业务动作时不再重开，避免动作挂在被取消的退场里。
    else if (!pendingActionRef.current) setPanelOpened(true);
  };
  const handleMenuChange = (nextOpened: boolean) => {
    menuOwnsDismissRef.current = nextOpened;
  };
  const runAfterClose = (action: () => void) => {
    pendingActionRef.current = action;
    setPanelOpened(false);
  };
  const finishClose = () => {
    if (openedRef.current) return;
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    // 关闭结束后只在焦点落空或仍停在旧面板内时回焦入口；用户已移到其他有效控件时不抢占。
    const active = document.activeElement;
    const validPageFocus = active instanceof HTMLElement && active !== document.body && active.isConnected
      && !active.closest(".pwa-device-popover, .pwa-device-drawer")
      && !active.matches(":disabled") && active.getClientRects().length > 0
      && !active.closest('[aria-hidden="true"], [inert]');
    if (!validPageFocus) triggerRef.current?.focus({ preventScroll: true });
    action?.();
  };
  const panel = <DevicePanel
    devices={devices}
    activeDeviceId={activeDeviceId}
    pairingPresence={pairingPresence}
    deviceActivity={deviceActivity}
    onMenuChange={handleMenuChange}
    onPair={() => runAfterClose(onPair)}
    onSelectDevice={(deviceId) => runAfterClose(() => onSelectDevice(deviceId))}
    onRename={(device) => runAfterClose(() => onRename(device))}
    onRemove={(device) => runAfterClose(() => onRemove(device))}
  />;
  if (purpose === "choose" && devices.length === 0) return <Button className="pwa-nav-pair" variant="transparent" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>{t.navigation.pairComputer}</Button>;

  const trigger: ReactNode = purpose === "manage" ? <Button
    ref={triggerRef}
    className="pwa-manage-computers"
    variant="transparent"
    type="button"
    aria-expanded={opened}
    onClick={togglePanel}
    leftSection={<Computer size={16} />}
  >{t.devices.computers}</Button> : <Button
    ref={triggerRef}
    className="pwa-device-trigger pwa-device-trigger-compact"
    variant="default"
    type="button"
    aria-expanded={opened}
    onClick={togglePanel}
    aria-label={t.devices.triggerLabel(label)}
    rightSection={<ChevronDown className="pwa-device-trigger-chevron" size={16} />}
  ><span className="pwa-device-trigger-copy"><strong>{label}</strong></span></Button>;

  if (variant === "sheet") return <>
    {trigger}
    <Drawer
      opened={opened}
      onClose={dismissPanel}
      onExitTransitionEnd={finishClose}
      position="bottom"
      size="auto"
      withinPortal
      portalProps={{ target: ".pwa-root" }}
      zIndex="var(--pwa-z-device-panel)"
      padding={0}
      title={title}
      closeButtonProps={{ "aria-label": t.devices.closeChooser, title: t.devices.closeChooser }}
      classNames={{ content: "pwa-device-drawer", header: "pwa-device-drawer-head", body: "pwa-device-drawer-body", close: "pwa-icon-button" }}
      styles={{ inner: { justifyContent: "flex-end" }, content: { maxHeight: "min(72dvh, 560px)" } }}
      returnFocus={false}
      closeOnEscape={false}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || !openedRef.current || menuOwnsDismissRef.current) return;
        event.stopPropagation();
        dismissPanel();
      }}
      transitionProps={{ transition: pwaDrawerTransitions.bottom, duration: chooserDuration, exitDuration: chooserExitDuration, timingFunction: PWA_DRAWER_EASE }}
    >{panel}</Drawer>
  </>;

  return <Popover
    middlewares={floatingMiddlewares}
    opened={opened}
    onChange={(nextOpened) => { if (nextOpened) setPanelOpened(true); else dismissPanel(); }}
    onExitTransitionEnd={finishClose}
    width="min(calc(var(--pwa-sidebar-width) - var(--pwa-space-md)), calc(100vw - var(--pwa-space-2xl)))"
    position="top-start"
    offset={8}
    withinPortal
    portalProps={{ target: ".pwa-root" }}
    zIndex="var(--pwa-z-device-panel)"
    transitionProps={menuTransition}
    returnFocus={false}
  >
    <Popover.Target>{trigger}</Popover.Target>
    <Popover.Dropdown className="pwa-device-popover pwa-menu-motion" aria-label={title}>{panel}</Popover.Dropdown>
  </Popover>;
}
