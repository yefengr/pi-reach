import { useRef, useState, type ReactNode } from "react";
import { ActionIcon, Badge, Button, Drawer, Menu, NavLink, Popover } from "@mantine/core";
import { usePwaMotionDuration, PWA_DRAWER_EASE, pwaDrawerTransitions, pwaFadeTransition, useMenuExitAction } from "@/components/pwa/use-pwa-motion";
import { ChevronDown, Computer, Link2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import type { PairingPresence } from "@/lib/pwa/pwa-view-model";
import { getMessages, useI18n } from "@/lib/i18n";

export type WorkspaceDeviceControlVariant = "desktop" | "sheet";

export type WorkspaceDeviceControlProps = {
  devices: PwaDeviceRecord[];
  activeDeviceId: string | null;
  pairingPresence?: Record<string, PairingPresence>;
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
  const menuDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
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
    opened={opened}
    withinPortal
    portalProps={{ target: ".pwa-root" }}
    position="bottom-end"
    zIndex={230}
    returnFocus
    onChange={setMenuOpened}
    onExitTransitionEnd={() => { onMenuChange?.(false); menuAction.finish(); }}
    transitionProps={{ transition: pwaFadeTransition, duration: menuDuration }}
  >
    <Menu.Target><ActionIcon className="pwa-peer-menu-trigger" type="button" aria-label={t.devices.actionsFor(label)} title={t.devices.actions}><MoreHorizontal size={20} /></ActionIcon></Menu.Target>
    <Menu.Dropdown inert={!opened} className="pwa-peer-menu-panel" data-mantine-stop-propagation="true" onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
    }}>
      <Menu.Item leftSection={<Pencil size={16} />} aria-label={t.devices.renameLabel(label)} onClick={() => closeThen(onRename)}>{t.devices.rename}</Menu.Item>
      <Menu.Item color="var(--pwa-error)" leftSection={<Trash2 size={16} />} aria-label={t.devices.removeLabel(label)} onClick={() => closeThen(onRemove)}>{t.devices.removePairing}</Menu.Item>
    </Menu.Dropdown>
  </Menu>;
}

export function ComputerRow({ device, active, presence, onSelect, onRename, onRemove, onMenuChange }: { device: PwaDeviceRecord; active: boolean; presence?: PairingPresence; onSelect: () => void; onRename: () => void; onRemove: () => void; onMenuChange?: (opened: boolean) => void }) {
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
      active={active}
      noWrap
      onClick={onSelect}
    />
    <ComputerActionsMenu device={device} onRename={onRename} onRemove={onRemove} onMenuChange={onMenuChange} />
  </div>;
}

function DevicePanel({ devices, activeDeviceId, pairingPresence = {}, onPair, onSelectDevice, onRename, onRemove, onMenuChange }: Omit<WorkspaceDeviceControlProps, "variant" | "purpose" | "onOverlayChange">) {
  const { t } = useI18n();
  return <div className="pwa-device-panel">
    <div className="pwa-device-panel-list">
      {devices.length === 0 ? <p className="pwa-device-panel-empty">{t.devices.noneYet}</p> : devices.map((device) => <ComputerRow
        key={device.id}
        device={device}
        active={device.id === activeDeviceId}
        presence={pairingPresence[device.id]}
        onSelect={() => onSelectDevice(device.id)}
        onRename={() => onRename(device)}
        onRemove={() => onRemove(device)}
        onMenuChange={onMenuChange}
      />)}
    </div>
    <Button className="pwa-device-panel-pair" variant="light" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>{t.navigation.pairComputer}</Button>
  </div>;
}

export function WorkspaceDeviceControl({ devices, activeDeviceId, pairingPresence = {}, onPair, onSelectDevice, onRename, onRemove, variant = "desktop", purpose = "choose", onOverlayChange }: WorkspaceDeviceControlProps) {
  const chooserDuration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const popoverDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const menuOwnsDismissRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const activeDevice = devices.find((device) => device.id === activeDeviceId) ?? null;
  const label = activeDevice ? displayDevice(activeDevice) : devices.length > 0 ? t.devices.chooseComputer : t.devices.noComputerPaired;
  // 只配对一台电脑时收成一行：在线圆点＋电脑名＋展开箭头，不显示图标框与副标题。
  const compact = devices.length === 1 && activeDevice !== null;
  const activeOnline = activeDevice !== null && (pairingPresence[activeDevice.id]?.onlineEndpoints ?? 0) > 0;
  const title = purpose === "manage" ? t.devices.computers : t.devices.chooseTitle;

  const setPanelOpened = (nextOpened: boolean) => {
    openedRef.current = nextOpened;
    setOpened(nextOpened);
    onOverlayChange?.(nextOpened);
  };
  const dismissPanel = () => {
    if (!menuOwnsDismissRef.current) setPanelOpened(false);
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
    triggerRef.current?.focus({ preventScroll: true });
    action?.();
  };
  const panel = <DevicePanel
    devices={devices}
    activeDeviceId={activeDeviceId}
    pairingPresence={pairingPresence}
    onMenuChange={handleMenuChange}
    onPair={() => runAfterClose(onPair)}
    onSelectDevice={(deviceId) => runAfterClose(() => onSelectDevice(deviceId))}
    onRename={(device) => runAfterClose(() => onRename(device))}
    onRemove={(device) => runAfterClose(() => onRemove(device))}
  />;
  const trigger: ReactNode = purpose === "manage" ? <Button
    ref={triggerRef}
    className="pwa-manage-computers"
    variant="transparent"
    color="piReach"
    type="button"
    onClick={() => setPanelOpened(true)}
    leftSection={<Computer size={16} />}
  >{t.devices.computers}</Button> : <Button
    ref={triggerRef}
    className={compact ? "pwa-device-trigger pwa-device-trigger-compact" : "pwa-device-trigger"}
    variant="default"
    type="button"
    onClick={() => setPanelOpened(true)}
    aria-label={t.devices.triggerLabel(label)}
    leftSection={compact
      ? <span className={`pwa-device-trigger-dot${activeOnline ? " online" : ""}`} aria-hidden="true" />
      : <span className={`pwa-peer-icon ${activeOnline ? "online" : ""}`}><Computer size={20} /></span>}
    rightSection={<ChevronDown size={16} />}
  ><span className="pwa-device-trigger-copy"><strong>{label}</strong>{compact ? null : <small>{activeDevice ? t.devices.currentComputer : t.devices.selectComputer}</small>}</span></Button>;

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
      zIndex={220}
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
      transitionProps={{ transition: pwaDrawerTransitions.bottom, duration: chooserDuration, timingFunction: PWA_DRAWER_EASE }}
    >{panel}</Drawer>
  </>;

  return <Popover
    opened={opened}
    onChange={(nextOpened) => { if (nextOpened) setPanelOpened(true); else dismissPanel(); }}
    onExitTransitionEnd={finishClose}
    width="target"
    position="bottom-start"
    offset={8}
    withinPortal
    portalProps={{ target: ".pwa-root" }}
    zIndex={220}
    transitionProps={{ transition: pwaFadeTransition, duration: popoverDuration }}
    returnFocus={false}
  >
    <Popover.Target>{trigger}</Popover.Target>
    <Popover.Dropdown className="pwa-device-popover" aria-label={title}>{panel}</Popover.Dropdown>
  </Popover>;
}
