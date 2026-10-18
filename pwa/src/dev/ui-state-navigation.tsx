import { useState, type ReactNode } from "react";
import { Button, NativeSelect } from "@mantine/core";
import { DesktopSidebar, ConnectionStatus, type ConnectionViewState, type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { WorkspaceTitleBar } from "@/components/pwa/workspace-title-bar";
import { SessionActionsMenu } from "@/components/pwa/session-actions-menu";
import { ConfirmActionDialog } from "@/components/pwa/confirm-action-dialog";
import { readerFocusable } from "@/components/pwa/reader-shared";
import { ChooseComputerWorkspace, NoPiWorkspace, UnpairedWorkspace } from "@/components/pwa/workspace-content";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import { GALLERY_DEVICES, GALLERY_ENDPOINTS, GALLERY_HISTORY } from "./ui-state-shell-fixtures";
import type { GallerySurface } from "./ui-state-surfaces";
import type { GalleryState } from "./ui-state-fixtures";

type NavigationScene = "paired" | "unpaired" | "choose-computer" | "loading" | "error";
type UiStateNavigationProps = {
  enabled: boolean;
  settingsOpen: boolean;
  children: ReactNode;
  onSceneChange: (state: GalleryState) => void;
  onOpenSurface: (surface: GallerySurface, device?: PwaDeviceRecord) => void;
};

/** 复用无存储的正式导航；固定主区子树，切换展示区域不会卸载 Composer。 */
export function UiStateNavigation({ enabled, settingsOpen, children, onSceneChange, onOpenSurface }: UiStateNavigationProps) {
  const [scene, setScene] = useState<NavigationScene>("paired");
  const [connection, setConnection] = useState<ConnectionViewState>("online");
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeDeviceId, setActiveDeviceId] = useState(GALLERY_DEVICES[0].id);
  const [activeEndpointId, setActiveEndpointId] = useState(GALLERY_ENDPOINTS[0].endpointId);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [removeDevice, setRemoveDevice] = useState<PwaDeviceRecord | null>(null);
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [origin, setOrigin] = useState<HTMLButtonElement | null>(null);
  const devices = scene === "unpaired" ? [] : GALLERY_DEVICES.filter(device => !removedIds.has(device.id));
  const selectedDevice = scene === "choose-computer" ? null : devices.find(device => device.id === activeDeviceId) ?? null;
  const endpoint = GALLERY_ENDPOINTS.find(item => item.endpointId === activeEndpointId && item.deviceId === selectedDevice?.deviceId);
  const title = selectedHistoryId ? GALLERY_HISTORY[0].name! : endpoint?.name ?? selectedDevice?.nickname ?? "Pi Reach";
  const emptyWorkspace = enabled && (!selectedDevice || !endpoint);
  const navigation: WorkspaceNavigationProps = {
    devices, endpoints: GALLERY_ENDPOINTS, history: scene === "loading" || scene === "error" ? [] : GALLERY_HISTORY,
    activeDeviceId: selectedDevice?.id ?? null, activeEndpointId, selectedHistoryId,
    snapshotReady: scene !== "loading", historyListStatus: scene === "loading" ? "loading" : scene === "error" ? "error" : "success",
    onRetryHistory: () => setScene("paired"), completedEndpointIds: new Set([GALLERY_ENDPOINTS[1].endpointId]),
    pairingPresence: {
      [GALLERY_DEVICES[0].id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 },
      [GALLERY_DEVICES[1].id]: { status: "offline", onlineEndpoints: 0, totalEndpoints: 0 },
    },
    onPair: () => onOpenSurface("pairing"), onSettings: () => { setSheetOpen(false); onOpenSurface("settings"); },
    onSelectDevice: id => { setScene("paired"); setActiveDeviceId(id); setSelectedHistoryId(null); setNotice("已选择演示电脑，未建立连接。"); },
    onSelectEndpoint: id => { setActiveEndpointId(id); setSelectedHistoryId(null); onSceneChange("tools"); },
    onSelectHistory: history => { setSelectedHistoryId(history.id); onSceneChange("history"); },
    onRename: device => onOpenSurface("rename", device), onRemove: setRemoveDevice,
  };
  return <div className="pwa-ui-states-frame" data-navigation={enabled || undefined} data-collapsed={collapsed || undefined}>
    {enabled ? <div className="pwa-ui-states-actions">
      <NativeSelect label="导航状态" value={scene} onChange={event => setScene(event.currentTarget.value as NavigationScene)} data={[
        { value: "paired", label: "已配对 · 在线与历史" }, { value: "unpaired", label: "未配对" }, { value: "choose-computer", label: "尚未选择电脑" },
        { value: "loading", label: "快照与历史加载中" }, { value: "error", label: "历史加载失败" },
      ]} />
      <NativeSelect label="导航连接状态" value={connection} onChange={event => setConnection(event.currentTarget.value as ConnectionViewState)} data={[
        { value: "online", label: "已连接" }, { value: "connecting", label: "连接中" }, { value: "retrying", label: "重连中" },
        { value: "offline", label: "离线" }, { value: "no_network", label: "无网络" },
      ]} />
      <Button className="pwa-ui-states-sidebar-control" variant="default" aria-pressed={collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "展开侧栏" : "收起侧栏"}</Button>
      <span>导航、会话选择和刷新只改变本页；路由与跟手手势请在测试环境验收。</span>
    </div> : null}
    <div className="pwa-layout">
      <div className="pwa-desktop-navigation" hidden={!enabled} inert={!enabled || collapsed} aria-hidden={!enabled || collapsed || undefined}>
        <DesktopSidebar {...navigation} collapsed={collapsed} />
      </div>
      <div className="pwa-main">
        {enabled ? <WorkspaceTitleBar title={title} prefix="pi-reach" showTitle={Boolean(endpoint || selectedHistoryId)} navigationExpanded={sheetOpen}
          onOpenNavigation={button => { setOrigin(button); setSheetOpen(true); }}
          status={<ConnectionStatus state={connection} retryAttempt={2} />}
          onRefresh={() => setNotice("已演示刷新，未重新加载页面或连接远程服务。")}
          moreMenu={<SessionActionsMenu info={{ name: title, cwd: endpoint?.cwd, computer: selectedDevice?.nickname ?? "未配对电脑", status: "仅本页演示" }} />} /> : null}
        {enabled && notice ? <p className="pwa-ui-states-local-result" role="status">{notice}</p> : null}
        <div className="pwa-ui-states-frame-content" hidden={emptyWorkspace} inert={emptyWorkspace}>{children}</div>
        {emptyWorkspace ? scene === "unpaired" ? <UnpairedWorkspace onPair={() => onOpenSurface("pairing")} />
          : selectedDevice ? <NoPiWorkspace /> : <ChooseComputerWorkspace /> : null}
      </div>
    </div>
    <SessionSheet {...navigation} opened={enabled && sheetOpen && !settingsOpen} onClose={() => setSheetOpen(false)} focusOrigin={origin}
      portalTarget=".pwa-ui-states-workspace" preview={settingsOpen} instant={settingsOpen} />
    <ConfirmActionDialog action={removeDevice ? { kind: "remove-pairing", label: removeDevice.nickname ?? removeDevice.hostname ?? "演示电脑" } : null} pending={false}
      onExitTransitionEnd={() => {
        if (readerFocusable(document.activeElement)) return;
        const fallback = [...document.querySelectorAll<HTMLElement>(".pwa-session-sheet button, .pwa-desktop-navigation .pwa-nav-pair, .pwa-session-trigger")].find(readerFocusable);
        fallback?.focus({ preventScroll: true });
      }}
      onClose={() => setRemoveDevice(null)} onConfirm={() => {
        if (!removeDevice) return;
        setRemovedIds(current => new Set([...current, removeDevice.id]));
        setRemoveDevice(null);
        onSceneChange("empty");
        setNotice("已在本页移除演示电脑；真实配对记录保持不变，刷新展厅可恢复。");
      }} />
  </div>;
}
